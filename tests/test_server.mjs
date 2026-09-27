import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createServer, MAX_REQUEST_BYTES } from '../server/server.mjs';

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks += 1;
  console.log(`ok ${name}`);
};
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
let now = Date.now();
const server = createServer({ dbPath: ':memory:', quiet: true, clock: () => now });
const requestHandler = server.listeners('request')[0];
const base = 'http://flight-system.test/api';
const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const target = new URL(url);
  const incoming = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]);
  incoming.method = method;
  incoming.url = target.pathname + target.search;
  incoming.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status, values = {}) => {
    outgoing.statusCode = status;
    outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return outgoing;
  };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  requestHandler(incoming, outgoing);
  await finished;
  const bytes = Buffer.concat(chunks);
  return {
    status: outgoing.statusCode,
    headers: { get: name => outgoing.responseHeaders?.[String(name).toLowerCase()] || null },
    text: async () => bytes.toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
};
const api = async (method, path, { token, body, raw = false, headers } = {}) => {
  const response = await request(base + path, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, etag: response.headers.get('etag') };
};

try {
  await check('fresh database health identifies Flight System', async () => {
    const result = await api('GET', '/health');
    assert.equal(result.status, 200);
    assert.equal(result.json.product, 'Flight System');
    assert.equal(result.json.accounts, 0);
    assert.equal(result.json.workspace, false);
  });
  await check('served page receives server context with no credential hashes', async () => {
    const html = await (await request('http://flight-system.test/')).text();
    assert.match(html, /window\.FLIGHT_SERVER=/);
    assert.match(html, /"workspace":null/);
    assert.doesNotMatch(html, /"serial":"SN-10009"/);
    assert.doesNotMatch(html, /"hash":/);
  });
  await check('first account is created as Master Access', async () => {
    const result = await api('PUT', '/auth/accounts', { body: { users: [
      { username: 'one', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }
    ] } });
    assert.equal(result.status, 200);
    assert.equal(result.json.users[0].role, 'admin');
    assert.deepEqual(result.json.users[0].roles, ['admin']);
    assert.equal(result.json.users[0].hash, undefined);
  });
  await check('Operations Manager and Quality Supervisor capabilities match their authority boundaries', async () => {
    const caps = server.host.roles.ROLE_CAPS;
    assert.ok(caps.ops.includes('create-wo'));
    assert.ok(caps.ops.includes('adjust-wo'));
    assert.ok(caps.ops.includes('edit-wi'));
    assert.ok(caps.ops.includes('configure-training'));
    assert.ok(caps.qs.includes('manage-access'));
    assert.ok(caps.qs.includes('mrb-quality'));
    assert.ok(caps.qs.includes('configure-training'));
    assert.ok(!caps.qs.includes('configure-qms'));
    assert.ok(caps.qm.includes('configure-qms'));
  });

  let token;
  await check('scrypt-backed sign-in rejects a wrong password and accepts the right one', async () => {
    assert.equal((await api('POST', '/auth/session', { body: { username: 'one', password: 'incorrect' } })).status, 401);
    const result = await api('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } });
    assert.equal(result.status, 200);
    token = result.json.token;
    assert.ok(token);
  });
  await check('one active session per account revokes the earlier token', async () => {
    const second = await api('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } });
    assert.equal(second.status, 200);
    assert.equal((await api('GET', '/auth/session', { token })).status, 401);
    token = second.json.token;
    assert.equal((await api('GET', '/auth/session', { token })).status, 200);
  });
  await check('session heartbeat does not extend the 30 minute idle deadline', async () => {
    now += 29 * 60 * 1000;
    assert.equal((await api('GET', '/auth/session', { token })).status, 200);
    now += 2 * 60 * 1000;
    assert.equal((await api('GET', '/auth/session', { token })).status, 401);
    token = (await api('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } })).json.token;
    assert.ok(token);
  });
  await check('session requests cannot extend the 12 hour absolute deadline', async () => {
    for (let i = 0; i < 24; i += 1) {
      now += 29 * 60 * 1000;
      assert.equal((await api('GET', '/auth/accounts', { token })).status, 200);
    }
    now += 23 * 60 * 1000;
    assert.equal((await api('GET', '/auth/session', { token })).status, 200);
    now += 2 * 60 * 1000;
    assert.equal((await api('GET', '/auth/session', { token })).status, 401);
    token = (await api('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } })).json.token;
    assert.ok(token);
  });
  await check('workspace routes require a live session', async () => {
    assert.equal((await api('GET', '/workspace')).status, 401);
    assert.equal((await api('GET', '/workspace', { token })).status, 404);
  });
  await check('request bodies over 100 MiB are rejected before parsing', async () => {
    const result = await api('POST', '/auth/session', { headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1) } });
    assert.equal(result.status, 413);
    assert.equal(result.json.limit, MAX_REQUEST_BYTES);
  });
  await check('evidence bytes are hash-verified, immutable, and retrievable', async () => {
    const id = 'EV-12345678-1234-4234-8234-123456789abc';
    const bytes = Buffer.from('Flight System evidence fixture');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const headers = { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': hash, 'X-Evidence-Name': 'test%20clip.webm' };
    const stored = await api('POST', `/evidence/${id}`, { token, raw: true, body: bytes, headers });
    assert.equal(stored.status, 201);
    assert.equal(stored.json.sha256, hash);
    assert.equal(stored.json.fileName, 'test clip.webm');
    const read = await request(`http://flight-system.test/api/evidence/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('x-evidence-sha256'), hash);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
    assert.equal((await api('POST', `/evidence/${id}`, { token, raw: true, body: bytes, headers })).status, 200);
    assert.equal((await api('POST', `/evidence/${id}`, { token, raw: true, body: Buffer.from('changed'), headers })).status, 422);
  });
  await check('server validates and stores the migrated workspace with an ETag', async () => {
    const state = server.host.MES.ensureMasterWIs(server.host.MES.seed());
    server.host.FlightPlan.ensure(state);
    const invalid = await api('PUT', '/workspace', { token, body: { version: -1, orders: 'invalid' } });
    assert.equal(invalid.status, 422);
    const result = await api('PUT', '/workspace', { token, body: state });
    assert.equal(result.status, 204);
    assert.ok(result.etag);
    const loaded = await api('GET', '/workspace', { token });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.etag, result.etag);
    assert.equal(server.host.MES.validate(loaded.json), true);
    const missingPrecondition = await api('PUT', '/workspace', { token, body: loaded.json });
    assert.equal(missingPrecondition.status, 428);
    const replacementState = structuredClone(loaded.json);
    replacementState.profile = { ...replacementState.profile, name: 'Snapshot identity override' };
    const replacement = await api('PUT', '/workspace', { token, body: replacementState, headers: { 'If-Match': loaded.etag } });
    assert.equal(replacement.status, 403, 'even a QA Manager cannot replace initialized records as a snapshot');
    assert.ok((await server.store.auditRows(1000)).some(row => row.action === 'workspace-put-refused' && row.username === 'one'));
  });
  await check('operator accounts cannot replace the shared workspace snapshot', async () => {
    const currentAccounts = await api('GET', '/auth/accounts', { token });
    assert.equal(currentAccounts.status, 200);
    const users = currentAccounts.json.users.map(u => ({ ...u }));
    users.push({ username: 'operator-one', displayName: 'Flight Operator', role: 'operator', salt: 'salt', hash: sha('salt', 'flight-pass-123') });
    assert.equal((await api('PUT', '/auth/accounts', { token, body: { users } })).status, 200);
    const signedIn = await api('POST', '/auth/session', { body: { username: 'operator-one', password: 'flight-pass-123' } });
    assert.equal(signedIn.status, 200);
    const loaded = await api('GET', '/workspace', { token: signedIn.json.token });
    assert.equal(loaded.status, 200);
    const refused = await api('PUT', '/workspace', { token: signedIn.json.token, body: loaded.json, headers: { 'If-Match': loaded.etag } });
    assert.equal(refused.status, 403);
    const event = (await server.store.auditRows(1000)).find(row => row.action === 'workspace-put-refused' && row.username === 'operator-one');
    assert.ok(event, 'the whole-workspace refusal is appended to the security audit');
  });
  await check('whole-workspace manifest verification detects tampering and identifies legacy manifests', async () => {
    const fixtureHtml = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
    const fixtureMatch = fixtureHtml.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
    assert.ok(fixtureMatch);
    const workspace = JSON.parse(fixtureMatch[1]);
    const legacyResult = server.host.MES.verifyManifests(workspace);
    assert.equal(legacyResult.ok, true);
    assert.equal(legacyResult.complete, false);
    assert.ok(legacyResult.legacy > 0);
    const signed = server.host.MES.signManifest(workspace, 'Test signature', { field: 'original' }, new Date().toISOString());
    const wrapped = { record: { manifest: signed } };
    assert.equal(server.host.MES.verifyManifests(wrapped).complete, true);
    wrapped.record.manifest.subject.field = 'changed';
    const tampered = server.host.MES.verifyManifests(wrapped);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.failures.length, 1);
  });
  await check('stale ETag writes are refused', async () => {
    const loaded = await api('GET', '/workspace', { token });
    const result = await api('PUT', '/workspace', { token, body: loaded.json, headers: { 'If-Match': '"stale"' } });
    assert.equal(result.status, 409);
  });
  await check('closed Flight work orders move to the searchable read-only archive', async () => {
    const fixtureHtml = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
    const fixtureMatch = fixtureHtml.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
    assert.ok(fixtureMatch, 'the curated Flight fixture has a workspace');
    const state = JSON.parse(fixtureMatch[1]);
    const expected = server.host.MES.archivable(state);
    assert.ok(expected.length > 0, 'fixture includes closed work orders');
    const current = server.store.getDoc('default');
    const seedEtag = server.store.putDoc('default', JSON.stringify(state), current.etag, 'server-test-fixture');
    assert.ok(seedEtag);
    const order = state.orders.find(item => item.status !== 'Closed');
    assert.ok(order);
    const saved = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: [order.id, 'AOG'] }, headers: { 'If-Match': seedEtag } });
    assert.equal(saved.status, 200);
    assert.equal(server.store.archiveCount(), expected.length);
    const search = await api('GET', `/archive?q=${encodeURIComponent(expected[0])}`, { token });
    assert.equal(search.status, 200);
    assert.ok(search.json.orders.some(order => order.orderId === expected[0] && order.source === 'archive'));
    const archived = await api('GET', `/archive/${expected[0]}`, { token });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.order.status, 'Closed');
    assert.equal(archived.json.readOnly, true);
    const exported = await api('GET', `/archive/${expected[0]}/export`, { token });
    assert.equal(exported.status, 200);
    assert.match(exported.json.exportId, /^EXT-[A-F0-9]{32}$/);
    assert.equal(exported.json.hashAlgorithm, 'SHA-256');
    const extractContent = { order: exported.json.order, activity: exported.json.activity, evidence: exported.json.evidence, archiveSha256: exported.json.archiveSha256, archivedAt: exported.json.archivedAt, archivedBy: exported.json.archivedBy, schema: exported.json.schema };
    assert.equal(exported.json.extractSha256, createHash('sha256').update(JSON.stringify(extractContent)).digest('hex'));
    const printed = await request(base + `/archive/${expected[0]}/print`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(printed.status, 200);
    assert.match(await printed.text(), /flight-extract-stamp/);
    const extracted = await api('GET', `/archive/${expected[0]}`, { token });
    assert.deepEqual(extracted.json.extractHistory.map(row => row.kind), ['json-download', 'print']);
    assert.equal(extracted.json.extractHistory[0].exportId, exported.json.exportId);
    assert.throws(() => server.store.db.prepare('DELETE FROM record_extracts').run(), /append-only/);
    assert.throws(() => server.store.db.prepare('UPDATE record_extracts SET kind = ?').run('changed'), /append-only/);
  });
  await check('role-gated actions run through the same MES engine', async () => {
    const admin = server.store.accounts().find(account => account.username === 'one');
    const s = '2222';
    server.store.upsertAccount({ username: 'basic', displayName: 'Basic user', role: 'general', salt: s, hash: sha(s, 'basic-pass-123'), createdBy: 'one' });
    const basic = await api('POST', '/auth/session', { body: { username: 'basic', password: 'basic-pass-123' } });
    assert.equal(basic.status, 200);
    const noPrecondition = await api('POST', '/workspace/actions/MES.setPriority', { token: basic.json.token, body: { args: ['WO-10001', 'High'] } });
    assert.equal(noPrecondition.status, 428);
    const action = await api('POST', '/workspace/actions/MES.setPriority', { token: basic.json.token, body: { args: ['WO-10001', 'High'] }, headers: { 'If-Match': server.store.getDoc('default').etag } });
    assert.equal(action.status, 403);
    assert.match(action.json.error, /role|permission|cannot/i);
    assert.equal(admin.role, 'admin');
  });
  await check('workspace action API refuses exported read and migration helpers', async () => {
    const before = server.store.getDoc('default');
    for (const name of ['MES.editOrderOperation','MES.reviseMasterWI','MES.pushATPSoftware','MES.acknowledgeNotice','MES.pingAssignment','MES.icalImport','MES.aqiSign8130_9']) {
      assert.equal(typeof server.host.resolveAction(name), 'function', `${name} is an authorized engine command`);
    }
    assert.equal(server.host.resolveAction('MES.icalExport'), null, 'calendar export stays a read and is not exposed as a mutation command');
    for (const name of ['MES.upgrade', 'MES.validate', 'MES.verifyManifests', 'MES.signManifest', 'FlightPlan.status']) {
      const result = await api('POST', `/workspace/actions/${name}`, { token, body: { args: [] }, headers: { 'If-Match': before.etag } });
      assert.equal(result.status, 404, `${name} must not be remotely callable`);
    }
    assert.equal(server.store.getDoc('default').etag, before.etag, 'rejected requests leave the shared workspace unchanged');
  });
  await check('model adapter secret is confirmed only on the server and governance export is QMS-gated', async () => {
    const doc = server.store.getDoc('default');
    const args = [{ enabled: true, provider: 'approved-model', settingName: 'FLIGHT_TEST_MODEL_KEY', rationale: 'Approved model configuration for governance test.' }];
    const missing = await api('POST', '/workspace/actions/MES.configureModelAdapter', { token, body: { args: [args[0]] }, headers: { 'If-Match': doc.etag } });
    assert.equal(missing.status, 422);
    assert.match(missing.json.error, /environment setting is not configured/i);
    process.env.FLIGHT_TEST_MODEL_KEY = 'test-secret-value';
    try {
      const enabled = await api('POST', '/workspace/actions/MES.configureModelAdapter', { token, body: { args: [args[0]] }, headers: { 'If-Match': server.store.getDoc('default').etag } });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.json.result.ok, true);
      assert.equal(server.store.getDoc('default').json.includes('test-secret-value'), false);
      assert.equal(JSON.parse(server.store.getDoc('default').json).modelAdapter.serverConfigured, true);
      const evidence = await api('GET', '/governance', { token });
      assert.equal(evidence.status, 200);
      assert.equal(evidence.json.standard, 'ISO/IEC 42001:2023');
      assert.equal(JSON.stringify(evidence.json).includes('test-secret-value'), false);
    } finally { delete process.env.FLIGHT_TEST_MODEL_KEY; }
  });

  await check('multi-role accounts and authority history survive server account writes', async () => {
    const grantHistory = [{ authority: 'push-software', action: 'granted', at: '2026-09-26T12:00:00.000Z', reason: 'Current training is on file.', hash: 'a'.repeat(64) }];
    const result = await api('PUT', '/auth/accounts', { token, body: { users: [
      { username: 'combined', displayName: 'Combined role account', role: 'technician', roles: ['technician', 'operator'], extraRoles: ['quality'], roleTraining: { quality: { code: 'QA-101' } }, grants: { 'push-software': { trainingCode: 'SW-101' } }, grantHistory, supportAccess: true, salt: 'combined-salt', hash: sha('combined-salt', 'combined-pass-123') }
    ] } });
    assert.equal(result.status, 200);
    const account = server.store.account('combined');
    assert.deepEqual(account.roles, ['technician', 'operator']);
    assert.deepEqual(result.json.users.find(user => user.username === 'combined').roles, ['technician', 'operator']);
    const capabilities = server.host.capsOf(account);
    assert.ok(capabilities.includes('operate-steps'));
    assert.ok(capabilities.includes('operate'));
    assert.ok(!capabilities.includes('create-wo'));
    assert.deepEqual(account.extraRoles, ['quality']);
    assert.deepEqual(account.roleTraining, { quality: { code: 'QA-101' } });
    assert.deepEqual(account.grants, { 'push-software': { trainingCode: 'SW-101' } });
    assert.deepEqual(account.grantHistory, grantHistory);
    assert.equal(account.supportAccess, true);
    assert.deepEqual(result.json.users.find(user => user.username === 'combined').grantHistory, grantHistory);
  });
  await check('Quality Supervisor can manage ordinary accounts but cannot grant or alter elevated access', async () => {
    const current = await api('GET', '/auth/accounts', { token });
    const withSupervisor = await api('PUT', '/auth/accounts', { token, body: { users: [
      ...current.json.users,
      { username: 'supervisor', displayName: 'Quality Supervisor', role: 'qs', roles: ['qs'], salt: 'supervisor-salt', hash: sha('supervisor-salt', 'supervisor-pass-123') }
    ] } });
    assert.equal(withSupervisor.status, 200);
    const signedIn = await api('POST', '/auth/session', { body: { username: 'supervisor', password: 'supervisor-pass-123' } });
    assert.equal(signedIn.status, 200);
    const qsToken = signedIn.json.token;
    const withRegular = await api('PUT', '/auth/accounts', { token: qsToken, body: { users: [
      ...withSupervisor.json.users,
      { username: 'floor-user', displayName: 'Floor User', role: 'general', roles: ['general'], salt: 'floor-salt', hash: sha('floor-salt', 'floor-user-pass-123') }
    ] } });
    assert.equal(withRegular.status, 200);
    const assignment = await api('PUT', '/auth/accounts', { token: qsToken, body: { users: withRegular.json.users.map(user => user.username === 'floor-user' ? { ...user, role: 'qm', roles: ['qm'] } : user) } });
    assert.equal(assignment.status, 403);
    assert.match(assignment.json.error, /cannot assign QA Manager/i);
    const adminName = await api('PUT', '/auth/accounts', { token: qsToken, body: { users: withRegular.json.users.map(user => user.username === 'one' ? { ...user, displayName: 'Changed Master' } : user) } });
    assert.equal(adminName.status, 403);
    assert.match(adminName.json.error, /cannot change a QA Manager or Master Access/i);
    const selfRole = await api('PUT', '/auth/accounts', { token: qsToken, body: { users: withRegular.json.users.map(user => user.username === 'supervisor' ? { ...user, role: 'general', roles: ['general'] } : user) } });
    assert.equal(selfRole.status, 403);
    assert.match(selfRole.json.error, /cannot change their own roles/i);
    assert.equal(server.host.roleOf(server.store.account('supervisor')), 'qs');
    assert.equal(server.store.account('floor-user').role, 'general');
  });
  await check('expanded roles and individually granted authority require current training on the shared workspace', async () => {
    const account = { username: 'trained-user', displayName: 'Trained user', role: 'technician', roles: ['technician'], extraRoles: ['qe'], roleTraining: { qe: { code: 'ESD' } }, grants: { 'mrb-quality': { trainingCode: 'ESD' } } };
    const state = JSON.parse(server.store.getDoc('default').json);
    const definition = server.host.MES.trainingCatalog(state).find(item => item.code === 'ESD' && item.status === 'Active');
    assert.ok(definition, 'fixture training ESD should be active');
    state.trainingRecords = (state.trainingRecords || []).filter(record => record.account !== account.username);
    const fixtureRecord = { id: 'TRN-99999', account: account.username, code: definition.code, expires: '2099-12-31', recordedAt: '2026-09-26T12:00:00.000Z', recordedBy: 'QA', note: 'Server authorization fixture.', qmsRev: definition.qmsRev || '' };
    state.trainingRecords.push(fixtureRecord);
    assert.ok(server.host.capsOf(account).includes('operate-steps'));
    assert.ok(!server.host.capsOf(account).includes('approve-wo'), 'extra role is inactive without workspace training');
    const active = server.host.capsOf(account, state);
    assert.ok(active.includes('approve-wo'));
    assert.ok(active.includes('mrb-quality'));
    fixtureRecord.expires = '2000-01-01';
    const expired = server.host.capsOf(account, state);
    assert.ok(!expired.includes('approve-wo'));
    assert.ok(!expired.includes('mrb-quality'));
  });
  await check('audit includes sign-in and refused action records', async () => {
    const result = await api('GET', '/audit', { token });
    assert.equal(result.status, 200);
    assert.ok(result.json.rows.some(row => row.action === 'signin'));
    assert.ok(result.json.rows.some(row => row.action === 'action-refused'));
    const chain = server.store.verifyAudit();
    assert.equal(chain.ok, true);
    assert.ok(chain.checked >= result.json.rows.length);
    assert.equal(result.json.rows[0].hash.length, 64);
  });
  await check('the manager can unlock an account with a reason and audit record', async () => {
    for (let i = 0; i < 5; i += 1) await api('POST', '/auth/session', { body: { username: 'basic', password: 'wrong' } });
    assert.equal((await api('POST', '/auth/session', { body: { username: 'basic', password: 'basic-pass-123' } })).status, 423);
    const result = await api('POST', '/auth/unlock', { token, body: { username: 'basic', reason: 'Verified with the person.' } });
    assert.equal(result.status, 200);
    assert.equal((await api('POST', '/auth/session', { body: { username: 'basic', password: 'basic-pass-123' } })).status, 200);
  });
  await check('sign-out closes the session', async () => {
    assert.equal((await api('DELETE', '/auth/session', { token })).status, 204);
    assert.equal((await api('GET', '/auth/session', { token })).status, 401);
  });
} finally {
  server.store.close();
}

const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-system-restart-'));
  const restartDb = path.join(restartDir, 'flight.sqlite');
try {
  const first = createServer({ dbPath: restartDb, quiet: true });
  await first.ready;
  first.store.setLockout('locked-user', 0, Date.now() + 60000);
  first.store.audit('locked-user', 'lockout', { minutes: 1 });
  const firstChain = first.store.verifyAudit();
  first.store.close();
  const restarted = createServer({ dbPath: restartDb, quiet: true });
  await restarted.ready;
  assert.ok(restarted.store.lockout('locked-user').until > Date.now());
  assert.equal(restarted.store.verifyAudit().ok, true);
  assert.equal(restarted.store.verifyAudit().head, firstChain.head);
  restarted.store.close();
  checks += 1;
  console.log('ok lockouts and the audit chain survive a server restart');
} finally {
  fs.rmSync(restartDir, { recursive: true, force: true });
}
console.log(`server: ${checks} checks, all passed`);
