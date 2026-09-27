import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';

const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-export-delivery-'));
const server = createServer({ dbPath: ':memory:', quiet: true });
let token;
try {
  await server.ready;
  const port = await server.listenAsync(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/api`;
  const api = async (method, route, body, auth = token, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, headers: response.headers };
  };
  const first = await api('PUT', '/auth/accounts', { users: [{ username: 'export-admin', displayName: 'Export Admin', role: 'admin', salt: 'test-salt', hash: sha('test-salt', 'export-password-123') }] }, null);
  assert.equal(first.status, 200);
  token = (await api('POST', '/auth/session', { username: 'export-admin', password: 'export-password-123' }, null)).json.token;

  const baseSetting = { enabled: true, destinationKind: 'folder', destination: outDir, namingPattern: '{recordType}-{recordId}-{exportId}.json', rationale: 'Enable controlled final record delivery.' };
  assert.equal((await api('PUT', '/record-exports/settings', { ...baseSetting, recordType: 'work-order' })).status, 200);
  assert.equal((await api('PUT', '/record-exports/settings', { ...baseSetting, recordType: 'training' })).status, 200);
  const httpsSetting = { recordType: 'fair', enabled: true, destinationKind: 'https', destination: 'https://example.invalid/records', tokenSetting: 'FLIGHT_EXPORT_TEST_SECRET_UNSET', namingPattern: '{recordType}-{recordId}-{exportId}.json', rationale: 'Exercise retry and failure audit.' };
  assert.equal((await api('PUT', '/record-exports/settings', httpsSetting)).status, 200);
  assert.equal((await api('PUT', '/record-exports/settings', { ...baseSetting, recordType: 'car', rationale: '' })).status, 400);
  assert.equal((await api('PUT', '/record-exports/settings', { ...baseSetting, recordType: '8130-9', destination: 'https://example.invalid/?token=secret', destinationKind: 'https', tokenSetting: 'FLIGHT_EXPORT_TOKEN' })).status, 400);

  const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
  const match = fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
  assert.ok(match);
  const state = JSON.parse(match[1]);
  state.trainingRecords = [{ id: 'TRN-99999', account: 'export-admin', code: 'ESD', expires: '2099-12-31', recordedAt: new Date().toISOString(), recordedBy: 'Export Admin · SKY-0000', note: 'Qualification expiry only, not a signed completion.', qmsRev: 'A' }];
  const closedCount = state.orders.filter(order => order.status === 'Closed').length;
  const fairCount = state.orders.filter(order => order.fair?.status === 'Approved').length;
  assert.ok(closedCount > 0 && fairCount > 0);
  assert.equal((await api('PUT', '/workspace', state, token)).status, 204);

  for (let n = 0; n < 100; n += 1) {
    const jobs = server.store.exportJobs(100);
    if (jobs.length === closedCount + fairCount && jobs.every(job => ['delivered', 'failed'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const jobs = server.store.exportJobs(100);
  assert.equal(jobs.filter(job => job.recordType === 'work-order').length, closedCount);
  assert.equal(jobs.filter(job => job.recordType === 'work-order' && job.status === 'delivered').length, closedCount);
  assert.equal(jobs.filter(job => job.recordType === 'fair' && job.status === 'failed' && job.attempts === 3).length, fairCount);
  assert.equal(jobs.some(job => job.recordType === 'training'), false, 'qualification rows are not exported as trainer-signed completions');
  for (const job of jobs.filter(row => row.recordType === 'work-order')) {
    const exportFile = fs.readdirSync(outDir).find(file => file.includes(job.exportId));
    assert.ok(exportFile);
    const payload = JSON.parse(fs.readFileSync(path.join(outDir, exportFile), 'utf8'));
    assert.equal(payload.exportId, job.exportId);
    assert.equal(payload.sha256, job.sha256);
    assert.equal(createHash('sha256').update(JSON.stringify({ recordType: payload.recordType, recordId: payload.recordId, record: payload.record })).digest('hex'), payload.sha256);
    assert.equal(server.store.extractHistory('work-order', job.recordId).some(row => row.exportId === job.exportId && row.kind === 'configured-record-export'), true);
  }
  const failedFair = jobs.find(job => job.recordType === 'fair' && job.status === 'failed');
  assert.ok(failedFair);
  const log = server.store.exportLog(failedFair.id, 10);
  assert.deepEqual(log.map(row => row.status), ['failed', 'pending', 'pending']);
  const managerJobs = await api('GET', '/record-exports/jobs');
  assert.equal(managerJobs.status, 200);
  assert.ok(managerJobs.json.jobs.find(job => job.id === failedFair.id).history.length >= 3);
  const status = await api('GET', '/record-exports/status');
  assert.equal(status.json.outstanding, fairCount);
  assert.equal(server.store.verifyAudit().ok, true);
  console.log('record export delivery: folder writes, content hashes, queue history, and three-attempt HTTPS failure passed');
} finally {
  await server.closeAsync().catch(() => server.store.close());
  fs.rmSync(outDir, { recursive: true, force: true });
}
