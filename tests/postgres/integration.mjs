import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/server.mjs';

const connectionString = process.env.FLIGHT_DATABASE_URL;
if (!connectionString) throw new Error('FLIGHT_DATABASE_URL is required for the PostgreSQL integration check.');
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const server = createServer({ databaseUrl: connectionString, quiet: true });
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-postgres-export-'));
let address;
try {
  await server.ready;
  address = await server.listenAsync(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address}/api`;
  const call = async (route, { method = 'GET', token, body, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, headers: response.headers, json, text };
  };

  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.product, 'Flight System');
  console.log('ok PostgreSQL schema initializes and health is available');

  const seed = await call('/auth/accounts', { method: 'PUT', body: { users: [{ username: 'pg-admin', displayName: 'PostgreSQL Admin', role: 'admin', salt: 'test-salt', hash: sha('test-salt', 'pg-test-password-123') }] } });
  assert.equal(seed.status, 200, JSON.stringify(seed.json));
  const login = await call('/auth/session', { method: 'POST', body: { username: 'pg-admin', password: 'pg-test-password-123' } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const token = login.json.token;
  console.log('ok PostgreSQL account, scrypt upgrade, and session persistence');

  const pgProfile = { ...login.json.account, extraRoles: ['quality'], roleTraining: { quality: { code: 'QA-101' } }, grants: { 'push-software': { trainingCode: 'SW-101' } }, grantHistory: [{ authority: 'push-software', action: 'granted', reason: 'Current training is on file.', hash: 'b'.repeat(64) }], supportAccess: true };
  const profileWrite = await call('/auth/accounts', { method: 'PUT', token, body: { users: [pgProfile] } });
  assert.equal(profileWrite.status, 200, profileWrite.text);
  assert.deepEqual(server.store.account('pg-admin').grantHistory, pgProfile.grantHistory);
  assert.deepEqual(server.store.account('pg-admin').roleTraining, pgProfile.roleTraining);
  assert.equal(server.store.account('pg-admin').supportAccess, true);
  console.log('ok PostgreSQL authority, training, support, and grant history persistence');

  for (const setting of [
    { recordType:'work-order',enabled:true,destinationKind:'folder',destination:exportDir,namingPattern:'{recordType}-{recordId}-{exportId}.json',rationale:'Exercise the PostgreSQL post-commit export queue.' },
    { recordType:'fair',enabled:true,destinationKind:'https',destination:'https://example.invalid/records',tokenSetting:'FLIGHT_PG_TEST_SECRET_UNSET',namingPattern:'{recordType}-{recordId}-{exportId}.json',rationale:'Exercise durable retry logs in PostgreSQL.' }
  ]) {
    const configured=await call('/record-exports/settings',{method:'PUT',token,body:setting});
    assert.equal(configured.status,200,configured.text);
  }

  const fixture = fs.readFileSync(new URL('../fixtures/demo_publish.html', import.meta.url), 'utf8');
  const match = fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
  assert.ok(match, 'curated Flight fixture contains a workspace');
  const seeded=JSON.parse(match[1]);
  const closedCount=seeded.orders.filter(order=>order.status==='Closed').length;
  const fairCount=seeded.orders.filter(order=>order.fair?.status==='Approved').length;
  const workspace = await call('/workspace', { method: 'PUT', token, body: seeded });
  assert.equal(workspace.status, 204, workspace.text);
  const archives = await call('/archive', { token });
  assert.ok(archives.json.total > 0);
  const orderId = archives.json.orders[0].orderId;
  assert.equal((await call(`/archive/${orderId}`, { token })).json.readOnly, true);
  console.log('ok PostgreSQL workspace transaction, archive, and exact search');

  const printed = await call(`/archive/${orderId}/print`, { token });
  assert.equal(printed.status, 200);
  assert.match(printed.text, /flight-extract-stamp/);
  const exported = await call(`/archive/${orderId}/export`, { token });
  assert.equal(exported.status, 200);
  const history = (await call(`/archive/${orderId}`, { token })).json.extractHistory;
  assert.ok(history.some(row => row.kind === 'print'));
  assert.ok(history.some(row => row.kind === 'json-download'));
  assert.ok(history[1].sequence > history[0].sequence);
  assert.equal((await server.store.verifyAudit()).ok, true);
  console.log('ok PostgreSQL archive extracts and audit hash chain');

  for(let n=0;n<100;n+=1){const jobs=await server.store.exportJobs(100);if(jobs.length===closedCount+fairCount&&jobs.every(job=>['delivered','failed'].includes(job.status)))break;await new Promise(resolve=>setTimeout(resolve,50));}
  const exportJobs=await server.store.exportJobs(100);
  assert.equal(exportJobs.filter(job=>job.recordType==='work-order'&&job.status==='delivered').length,closedCount);
  assert.equal(exportJobs.filter(job=>job.recordType==='fair'&&job.status==='failed'&&job.attempts===3).length,fairCount);
  assert.equal(fs.readdirSync(exportDir).length,closedCount);
  const fairJob=exportJobs.find(job=>job.recordType==='fair');
  assert.equal((await server.store.exportLog(fairJob.id,10)).length,3);
  await assert.rejects(server.store._query('UPDATE record_export_log SET detail=$1 WHERE job_id=$2', ['tampered', fairJob.id]), /append-only/);
  await assert.rejects(server.store._query('DELETE FROM record_export_log WHERE job_id=$1', [fairJob.id]), /append-only/);
  console.log('ok PostgreSQL final-record queue, post-commit folder delivery, and retry history');

  const evidenceId = `EV-${randomUUID()}`;
  const bytes = Buffer.from('Flight System PostgreSQL evidence receipt');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const upload = await fetch(base + `/evidence/${evidenceId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/webm', 'X-Evidence-Sha256': digest }, body: bytes });
  assert.equal(upload.status, 201);
  const download = await fetch(base + `/evidence/${evidenceId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  console.log('ok PostgreSQL evidence bytes round-trip with SHA-256');
} finally {
  await server.closeAsync();
  fs.rmSync(exportDir,{recursive:true,force:true});
}
