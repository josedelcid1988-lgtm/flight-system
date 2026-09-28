import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/server.mjs';
import { openPostgres } from '../../server/db-postgres.mjs';

const connectionString = process.env.FLIGHT_DATABASE_URL;
if (!connectionString) throw new Error('FLIGHT_DATABASE_URL is required for the PostgreSQL integration check.');
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const server = createServer({ databaseUrl: connectionString, quiet: true, setupCode: 'postgres-test-setup-code', exportCredentials: { FLIGHT_PG_TEST_SECRET_UNSET: ['https://example.invalid'] } });
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

  const jiraRequestId = `flight-ecr-pg-${randomUUID().toLowerCase()}`;
  const jiraClaim = await server.store.beginJiraIssueRequest({ idempotencyKey: jiraRequestId, requestSha256: 'a'.repeat(64), recordType: 'ECR', recordId: jiraRequestId, projectKey: 'ECR', createdBy: 'postgres-test' });
  assert.equal(jiraClaim.inserted, true);
  assert.equal(jiraClaim.request.status, 'pending');
  await server.store.completeJiraIssueRequest(jiraRequestId, { key: 'ECR-9001', url: 'https://example.atlassian.net/browse/ECR-9001' });
  const jiraReplay = await server.store.beginJiraIssueRequest({ idempotencyKey: jiraRequestId, requestSha256: 'a'.repeat(64), recordType: 'ECR', recordId: jiraRequestId, projectKey: 'ECR', createdBy: 'postgres-test' });
  assert.equal(jiraReplay.inserted, false);
  assert.equal(jiraReplay.request.status, 'created');
  assert.equal(jiraReplay.request.issue_key, 'ECR-9001');
  console.log('ok PostgreSQL Jira idempotency state persists and replays the created issue');

  const seed = await call('/auth/accounts', { method: 'PUT', body: { setupCode: 'postgres-test-setup-code', users: [{ username: 'pg-admin', displayName: 'PostgreSQL Admin', role: 'admin', salt: 'test-salt', hash: sha('test-salt', 'pg-test-password-123') }] } });
  assert.equal(seed.status, 200, JSON.stringify(seed.json));
  const login = await call('/auth/session', { method: 'POST', body: { username: 'pg-admin', password: 'pg-test-password-123' } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const token = login.json.token;
  const lockUntil = Date.now() + 300000;
  const failures = await Promise.all(Array.from({ length: 5 }, () => server.store.noteFailedSignin('pg-race-user', 5, lockUntil)));
  assert.equal(failures.filter(item => item.locked).length, 1, 'five concurrent failed sign-ins lock the account exactly once');
  assert.equal((await server.store.lockout('pg-race-user')).until, lockUntil, 'the PostgreSQL failed sign-in counter is not lost under concurrency');
  console.log('ok PostgreSQL account, scrypt upgrade, session persistence, and atomic failed sign-in counting');

  const pgProfile = { ...await server.store.account('pg-admin'), extraRoles: ['quality'], roleTraining: { quality: { code: 'QA-101' } }, grants: { 'push-software': { trainingCode: 'SW-101' } }, grantHistory: [{ authority: 'push-software', action: 'granted', reason: 'Current training is on file.', hash: 'b'.repeat(64) }], supportAccess: true };
  await server.store.upsertAccount(pgProfile);
  const persistedProfile = await server.store.account('pg-admin');
  assert.deepEqual(persistedProfile.grantHistory, pgProfile.grantHistory);
  assert.deepEqual(persistedProfile.roleTraining, pgProfile.roleTraining);
  assert.deepEqual(persistedProfile.grants, pgProfile.grants);
  assert.deepEqual(persistedProfile.extraRoles, pgProfile.extraRoles);
  assert.equal(persistedProfile.supportAccess, true);
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
  // Print and download extract history is append-only in PostgreSQL too.
  const extractId = (await server.store._query('SELECT export_id FROM record_extracts LIMIT 1')).rows[0]?.export_id;
  assert.ok(extractId, 'the export queue recorded an extract');
  await assert.rejects(server.store._query('UPDATE record_extracts SET exported_by=$1 WHERE export_id=$2', ['tampered', extractId]), /record extracts are append-only/);
  await assert.rejects(server.store._query('DELETE FROM record_extracts WHERE export_id=$1', [extractId]), /record extracts are append-only/);
  // One job per finalized version: a record reopened and finalized again with new content is exported again.
  const pgVersion = (sha, id) => ({ id, recordType: 'fair', recordId: 'FAIR-PG-REOPENED', exportId: `EXT-${id}`, sha256: sha, payload: '{}', destinationKind: 'folder', destination: exportDir, tokenSetting: null, namingPattern: '{recordType}-{recordId}-{exportId}.json', createdBy: 'postgres-test' });
  assert.ok(await server.store.queueExportJob(pgVersion('c'.repeat(64), 'JOB-PGREOPEN000000000001')));
  assert.equal(await server.store.queueExportJob(pgVersion('c'.repeat(64), 'JOB-PGREOPEN000000000002')), null, 'the same final content is not exported twice');
  assert.ok(await server.store.queueExportJob(pgVersion('d'.repeat(64), 'JOB-PGREOPEN000000000003')), 'a re-finalized version with new content is exported again');
  console.log('ok PostgreSQL final-record queue, post-commit folder delivery, and retry history');

  const evidenceId = `EV-${randomUUID()}`;
  const bytes = Buffer.from('Flight System PostgreSQL evidence receipt');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const upload = await fetch(base + `/evidence/${evidenceId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/webm', 'X-Evidence-Sha256': digest }, body: bytes });
  assert.equal(upload.status, 201);
  const download = await fetch(base + `/evidence/${evidenceId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  console.log('ok PostgreSQL evidence bytes round-trip with SHA-256');

  const backupPath = path.join(exportDir, 'flight-postgres.dump');
  const restoreDatabase = `flight_restore_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const restoreUrl = new URL(connectionString);
  restoreUrl.pathname = `/${restoreDatabase}`;
  const { Pool } = await import('pg');
  const adminPool = new Pool({ connectionString: adminUrl.href });
  let restoredStore;
  const runPgTool = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code}).`)));
  });
  try {
    assert.equal(await server.store.backup(backupPath), 0);
    assert.ok(fs.statSync(backupPath).size > 0, 'pg_dump produced a non-empty custom-format archive');
    await adminPool.query(`CREATE DATABASE "${restoreDatabase}"`);
    await runPgTool('pg_restore', ['--exit-on-error', '--no-owner', '--dbname', restoreUrl.href, backupPath]);
    restoredStore = await openPostgres(restoreUrl.href);
    const restoredProfile = await restoredStore.account('pg-admin');
    assert.deepEqual(restoredProfile.grants, pgProfile.grants);
    assert.deepEqual(restoredProfile.grantHistory, pgProfile.grantHistory);
    assert.equal(restoredProfile.supportAccess, true);
    console.log('ok PostgreSQL custom-format backup restores account authority profile');
  } finally {
    await restoredStore?.close();
    await adminPool.query(`DROP DATABASE IF EXISTS "${restoreDatabase}"`).catch(() => {});
    await adminPool.end();
  }
} finally {
  await server.closeAsync();
  fs.rmSync(exportDir,{recursive:true,force:true});
}
