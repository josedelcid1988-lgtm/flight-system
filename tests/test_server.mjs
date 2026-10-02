import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createServer, makeHash, MAX_REQUEST_BYTES } from '../server/server.mjs';

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks += 1;
  console.log(`ok ${name}`);
};
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
let now = Date.now();
const SETUP_CODE = 'server-test-setup-code';
const server = createServer({ dbPath: ':memory:', quiet: true, clock: () => now, setupCode: SETUP_CODE, modelAdapterSettings: ['FLIGHT_TEST_MODEL_KEY'] });
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
  await check('fresh database health answers liveness only without a session', async () => {
    const result = await api('GET', '/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
  });
  await check('served page receives server context with no credential hashes', async () => {
    const html = await (await request('http://flight-system.test/')).text();
    assert.match(html, /window\.FLIGHT_SERVER=/);
    assert.match(html, /"workspace":null/);
    assert.doesNotMatch(html, /"serial":"SN-10009"/);
    assert.doesNotMatch(html, /"hash":/);
  });
  await check('the first account needs the setup code from the server console', async () => {
    const first = { username: 'intruder', displayName: 'Network Intruder', role: 'admin', salt: 'salt', hash: sha('salt', 'intruder-pass-123') };
    for (const setupCode of [undefined, '', 'wrong-code']) {
      const refused = await api('PUT', '/auth/accounts', { body: { users: [first], ...(setupCode === undefined ? {} : { setupCode }) } });
      assert.equal(refused.status, 403, JSON.stringify(refused.json));
      assert.match(refused.json.error, /setup code shown in the server console/);
    }
    assert.equal((await server.store.accounts()).length, 0, 'a refused first-run request creates no account');
    assert.equal((await api('POST', '/auth/session', { body: { username: 'intruder', password: 'intruder-pass-123' } })).status, 401);
    assert.ok((await server.store.auditRows(100)).some(row => row.action === 'first-account-refused'), 'the refused bootstrap is audited');
    assert.equal(await server.firstRunSetupCode(), SETUP_CODE, 'the console shows the code while no account exists');
  });
  await check('first account is created as Master Access', async () => {
    const result = await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [
      { username: 'one', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }
    ] } });
    assert.equal(result.status, 200);
    assert.equal(result.json.users[0].role, 'admin');
    assert.deepEqual(result.json.users[0].roles, ['admin']);
    assert.equal(result.json.users[0].hash, undefined);
    assert.equal(await server.firstRunSetupCode(), null, 'the setup code is not shown once the first account exists');
  });
  await check('Operations Manager and Quality Supervisor capabilities match their authority boundaries', async () => {
    const caps = server.host.roles.ROLE_CAPS;
    assert.ok(caps.ops.includes('create-wo'));
    assert.ok(caps.ops.includes('adjust-wo'));
    assert.ok(caps.ops.includes('edit-wi'));
    assert.ok(caps.ops.includes('configure-training'));
    assert.ok(caps.ops.includes('plan-order') && !caps.ops.includes('set-sensitivity'), 'Operations plans sprints but does not set project sensitivity');
    assert.ok(caps.qm.includes('plan-order') && caps.qm.includes('set-sensitivity'), 'QA Manager plans sprints and sets project sensitivity');
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
  await check('every refused workspace snapshot write is audited with its status', async () => {
    const refusals = async () => (await server.store.auditRows(1000)).filter(row => row.action === 'workspace-put-refused' && row.username === 'one').map(row => JSON.parse(row.detail));
    const statuses = (await refusals()).map(detail => detail.status);
    assert.ok(statuses.includes(422), 'the invalid initialization (422) is audited');
    assert.ok(statuses.includes(428), 'the snapshot without If-Match (428) is audited');
    assert.ok(statuses.includes(403), 'the changed snapshot (403) is audited with its status');
    const loaded = await api('GET', '/workspace', { token });
    const before = (await refusals()).length;
    const stale = await api('PUT', '/workspace', { token, body: loaded.json, headers: { 'If-Match': '"stale-etag"' } });
    assert.equal(stale.status, 409, 'a stale If-Match is refused');
    const after = await refusals();
    assert.equal(after.length, before + 1, 'the stale snapshot (409) adds exactly one refusal entry');
    assert.equal(after[0].status, 409);
    assert.equal(after[0].reason, 'stale If-Match');
    assert.equal(after[0].etag, loaded.etag, 'the entry names the current ETag the client missed');
    const noop = await api('PUT', '/workspace', { token, body: loaded.json, headers: { 'If-Match': loaded.etag } });
    assert.equal(noop.status, 204, 'an identical snapshot with the current ETag is a no-op');
    assert.equal((await refusals()).length, before + 1, 'the no-op is not recorded as a refusal');
    const notJson = await api('PUT', '/workspace', { token, raw: true, body: 'not json', headers: { 'Content-Type': 'application/json', 'If-Match': loaded.etag } });
    assert.equal(notJson.status, 400, 'a body that is not JSON is refused');
    assert.deepEqual([(await refusals())[0].status, (await refusals())[0].reason], [400, 'request body is not JSON'], 'the unreadable body (400) is audited');
    const tooLarge = await api('PUT', '/workspace', { token, headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1), 'If-Match': loaded.etag } });
    assert.equal(tooLarge.status, 413, 'an oversized body is refused');
    assert.deepEqual([(await refusals())[0].status, (await refusals())[0].reason], [413, 'request body over the size limit'], 'the oversized body (413) is audited');
    assert.equal((await refusals()).length, before + 3, 'each parse refusal adds exactly one entry');
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
  await check('a first initialization never replaces an existing workspace', async () => {
    assert.ok(server.store.putDoc('init-check', '{"n":1}', null, 'first'));
    assert.equal(server.store.putDoc('init-check', '{"n":2}', null, 'second'), null);
    assert.equal(JSON.parse(server.store.getDoc('init-check').json).n, 1);
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
    // #202: the list limit reaches the database only as 1 to 1,000. SQLite reads LIMIT -1 as unlimited and
    // PostgreSQL refuses it, so a missing, zero, negative or fractional limit reads the default 200.
    {
      const archiveSearch = server.store.archiveSearch, limits = [];
      server.store.archiveSearch = (q, limit) => { limits.push(limit); return archiveSearch.call(server.store, q, limit); };
      try {
        const asked = ['-1', '0', '1.5', 'abc', '', '5000', '1'];
        for (const limit of asked) assert.equal((await api('GET', `/archive?limit=${limit}`, { token })).status, 200, `limit=${limit}`);
        assert.deepEqual(limits, [200, 200, 200, 200, 200, 1000, 1], 'each list limit is clamped before the store call');
        assert.equal((await api('GET', '/archive?limit=1', { token })).json.orders.length, 1);
      } finally { server.store.archiveSearch = archiveSearch; }
    }
    const archived = await api('GET', `/archive/${expected[0]}`, { token });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.order.status, 'Closed');
    assert.equal(archived.json.readOnly, true);
    const exported = await api('GET', `/archive/${expected[0]}/export`, { token });
    assert.equal(exported.status, 200);
    assert.match(exported.json.exportId, /^EXT-[A-F0-9]{32}$/);
    assert.equal(exported.json.hashAlgorithm, 'SHA-256');
    const evidenceMeta = Object.fromEntries(Object.entries(exported.json.evidence).map(([key, { base64, ...meta }]) => {
      assert.equal(createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'), meta.sha256, `${key}: streamed bytes match the SHA-256 the extract hash covers`);
      return [key, meta];
    }));
    const extractContent = { order: exported.json.order, activity: exported.json.activity, evidence: evidenceMeta, archiveSha256: exported.json.archiveSha256, archivedAt: exported.json.archivedAt, archivedBy: exported.json.archivedBy, schema: exported.json.schema };
    assert.equal(exported.json.extractSha256, createHash('sha256').update(JSON.stringify(extractContent)).digest('hex'));
    // An archived order whose recordings span several stream chunks: every byte arrives and matches its SHA-256.
    {
      const big = [Buffer.alloc(7 * 1024 * 1024 + 5, 7), Buffer.from('small quarantined take')];
      const ids = ['EV-00000000-0000-4000-8000-00000000a001', 'EV-00000000-0000-4000-8000-00000000a002'];
      big.forEach((bytes, index) => server.store.putEvidence({ id: ids[index], sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime: 'video/webm', fileName: `take-${index}.webm`, uploadedBy: 'test', bytes }));
      const order = { id: 'WO-STREAM-1', partNumber: 'P-STREAM', status: 'Closed', operations: [{ id: 'op-010', evidence: [{ id: ids[0] }], quarantinedEvidence: [{ id: ids[1] }] }] };
      const json = JSON.stringify({ order, activity: [] });
      server.store.putArchived({ id: order.id, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: 'P-STREAM', serials: [], lots: [], parts: ['P-STREAM'], title: 'Stream test', closedAt: null }, by: 'test' });
      const streamed = await api('GET', `/archive/${order.id}/export`, { token });
      assert.equal(streamed.status, 200);
      assert.equal(JSON.stringify(ids.map(id => Buffer.from(streamed.json.evidence[id].base64, 'base64').equals(big[ids.indexOf(id)]))), '[true,true]', 'both recordings arrive byte for byte, including one larger than two chunks');
      const covered = Object.fromEntries(Object.entries(streamed.json.evidence).map(([key, { base64, ...meta }]) => [key, meta]));
      assert.equal(streamed.json.extractSha256, createHash('sha256').update(JSON.stringify({ order: streamed.json.order, activity: streamed.json.activity, evidence: covered, archiveSha256: streamed.json.archiveSha256, archivedAt: streamed.json.archivedAt, archivedBy: streamed.json.archivedBy, schema: streamed.json.schema })).digest('hex'), 'the stamped hash covers the recording metadata and SHA-256 values');
    }
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
  await check('a CAR raised from an MRB board is linked to the board by the server action', async () => {
    const before = server.store.getDoc('default'), stored = JSON.parse(before.json);
    const board = (stored.maneuver?.mrb || [])[0];
    assert.ok(board, 'the workspace has an MRB board');
    const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const input = { title: 'Board corrective action', description: 'Raised from the MRB board.', sourceType: 'NC', severity: 'Minor', dueDate: due, mrbId: board.id };
    const missing = await api('POST', '/workspace/actions/FlightManeuver.raiseCAR', { token, body: { args: [{ ...input, mrbId: 'MRB-9999' }] }, headers: { 'If-Match': before.etag } });
    assert.equal(missing.status, 403, JSON.stringify(missing.json));
    assert.match(missing.json.error, /MRB board this corrective action was raised from was not found/);
    const raised = await api('POST', '/workspace/actions/FlightManeuver.raiseCAR', { token, body: { args: [input] }, headers: { 'If-Match': before.etag } });
    assert.equal(raised.status, 200, JSON.stringify(raised.json));
    const after = JSON.parse(server.store.getDoc('default').json);
    assert.equal(after.maneuver.mrb.find(item => item.id === board.id).carId, raised.json.result.id, 'the shared workspace records the board-to-CAR link with the CAR');
  });
  await check('workspace action API refuses exported read and migration helpers', async () => {
    const before = server.store.getDoc('default');
    for (const name of ['MES.editOrderOperation','MES.reviseMasterWI','MES.pushATPSoftware','MES.acknowledgeNotice','MES.pingAssignment','MES.icalImport','MES.aqiSign8130_9','MES.checkConformity','MES.notifyCertification','MES.qaReviewMasterWI','MES.pruneExpiredNotices','FlightManeuver.containNC','FlightManeuver.effectivenessCheck','FlightManeuver.pfmeaSafetyBuyoff']) {
      assert.equal(typeof server.host.resolveAction(name), 'function', `${name} is an authorized engine command`);
    }
    // The page queues exactly the calls the server accepts: its three allowlist constants mirror the server's.
    const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), host = fs.readFileSync(new URL('../server/mes-host.mjs', import.meta.url), 'utf8');
    const setOf = (source, name) => { const found = new RegExp(`${name}\\s*=\\s*new Set\\((\\[[^\\]]*\\])\\)`).exec(source); assert.ok(found, `${name} is declared`); return JSON.stringify(Function(`return ${found[1]}`)().sort()); };
    assert.equal(setOf(page, 'serverMutatorExact'), setOf(host, 'actionExact'), 'page and server exact action lists match');
    assert.equal(setOf(page, 'serverMutatorExclude'), setOf(host, 'actionExclude'), 'page and server excluded action lists match');
    assert.equal(setOf(page, 'serverMutatorAllow'), setOf(host, 'actionAllow'), 'page and server reviewed command lists match');
    assert.equal(/const serverMutatorName=(\/\^\(\?:[^/]*\)\/i)/.exec(page)?.[1], /const actionName = (\/\^\(\?:[^/]*\)\/i)/.exec(host)?.[1], 'page and server command-name patterns match');
    assert.equal(server.host.resolveAction('MES.icalExport'), null, 'calendar export stays a read and is not exposed as a mutation command');
    assert.equal(server.host.resolveAction('MES.verifyAIActionLog'), null, 'AI action-log verification stays a read and is not exposed as a mutation command');
    for (const name of ['MES.upgrade', 'MES.validate', 'MES.verifyManifests', 'MES.verifyAIActionLog', 'MES.signManifest', 'FlightPlan.status', 'FlightManeuver.pfmeaFor', 'MES.recordAIAction', 'MES.logSupport', 'MES.noteDemoBypassRemoved', 'MES.releaseWIFromPfmea', 'MES.quarantineOrder', 'MES.rollWorkOrderRevision']) {
      const result = await api('POST', `/workspace/actions/${name}`, { token, body: { args: [] }, headers: { 'If-Match': before.etag } });
      assert.equal(result.status, 404, `${name} must not be remotely callable`);
    }
    assert.equal(server.store.getDoc('default').etag, before.etag, 'rejected requests leave the shared workspace unchanged');
  });
  await check('expired announcement cleanup preserves pinned, recent, and undated records', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const state = { notices: [
      { id: 'old', at: old, pinned: false },
      { id: 'pinned', at: old, pinned: true },
      { id: 'recent', at: new Date().toISOString(), pinned: false },
      { id: 'undated', at: 'unrecognized', pinned: false }
    ] };
    const result = server.host.withAccount(server.store.account('one'), () => server.host.MES.pruneExpiredNotices(state), state);
    assert.equal(result.ok, true);
    assert.equal(result.removed, 1);
    assert.deepEqual(state.notices.map(item => item.id), ['pinned', 'recent', 'undated']);
    const deniedState = structuredClone(state);
    const deniedResult = server.host.withAccount({ username: 'read-only', displayName: 'Read-only user', role: 'general' }, () => server.host.MES.pruneExpiredNotices(deniedState), deniedState);
    assert.equal(deniedResult.ok, false, 'the engine refuses cleanup without the post-notice capability');
    assert.equal(deniedState.notices.length, state.notices.length, 'a refused cleanup leaves every notice intact');
    server.store.upsertAccount({ username: 'read-only', displayName: 'Read-only user', role: 'general', roles: ['general'], salt: 'readonly-salt', hash: sha('readonly-salt', 'read-only-pass-123'), createdBy: 'one' });
    const readOnly = await api('POST', '/auth/session', { body: { username: 'read-only', password: 'read-only-pass-123' } });
    assert.equal(readOnly.status, 200);
    const current = server.store.getDoc('default');
    const routeDenied = await api('POST', '/workspace/actions/MES.pruneExpiredNotices', { token: readOnly.json.token, body: { args: [] }, headers: { 'If-Match': current.etag } });
    assert.equal(routeDenied.status, 403, 'a view-only account cannot trigger shared notice deletion');
    assert.equal(server.store.getDoc('default').etag, current.etag, 'a refused server cleanup leaves the workspace unchanged');
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

  await check('every refused action is audited with its name, status and reason, and never its arguments (#582)', async () => {
    const refused = async () => (await server.store.auditRows(1000)).filter(row => row.action === 'action-refused');
    const latest = async () => JSON.parse((await refused())[0].detail);
    const before = server.store.getDoc('default'), count = (await refused()).length;
    const secret = 'argument-text-that-must-not-be-recorded';
    const unknown = await api('POST', '/workspace/actions/MES.noSuchCommand', { token, body: { args: [secret] }, headers: { 'If-Match': before.etag } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'No action named MES.noSuchCommand.', 'the response text is unchanged');
    assert.deepEqual(await latest(), { action: 'MES.noSuchCommand', status: 404, reason: 'no such action' });
    const noMatch = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: ['WO-10001', 'High', secret] } });
    assert.equal(noMatch.status, 428);
    assert.deepEqual(await latest(), { action: 'MES.setPriority', status: 428, reason: 'missing If-Match', etag: before.etag });
    const stale = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: ['WO-10001', 'High', secret] }, headers: { 'If-Match': '"stale-etag"' } });
    assert.equal(stale.status, 409);
    assert.deepEqual(await latest(), { action: 'MES.setPriority', status: 409, reason: 'stale If-Match', etag: before.etag });
    const notJson = await api('POST', '/workspace/actions/MES.setPriority', { token, raw: true, body: `{"args":["${secret}"`, headers: { 'Content-Type': 'application/json', 'If-Match': before.etag } });
    assert.equal(notJson.status, 400);
    assert.deepEqual(await latest(), { action: 'MES.setPriority', status: 400, reason: 'request body is not JSON' });
    const tooLarge = await api('POST', '/workspace/actions/MES.setPriority', { token, headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1), 'If-Match': before.etag } });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await latest(), { action: 'MES.setPriority', status: 413, reason: 'request body over the size limit' });
    // A model adapter probe names the setting only when it looks like an environment variable name, never a value.
    const probe = { enabled: true, provider: 'approved-model', rationale: 'Probe of an unlisted setting.' };
    const unlisted = await api('POST', '/workspace/actions/MES.configureModelAdapter', { token, body: { args: [{ ...probe, settingName: 'PATH' }] }, headers: { 'If-Match': before.etag } });
    assert.equal(unlisted.status, 422);
    assert.deepEqual(await latest(), { action: 'MES.configureModelAdapter', status: 422, reason: 'model adapter setting not configured', settingName: 'PATH' });
    await api('POST', '/workspace/actions/MES.configureModelAdapter', { token, body: { args: [{ ...probe, settingName: `x ${secret}` }] }, headers: { 'If-Match': before.etag } });
    assert.equal((await latest()).settingName, '(not a setting name)');
    // An engine refusal keeps its message and now carries its status too.
    const s = '3333';
    server.store.upsertAccount({ username: 'refused-basic', displayName: 'Refused basic user', role: 'general', salt: s, hash: sha(s, 'refused-basic-pass'), createdBy: 'one' });
    const basic = await api('POST', '/auth/session', { body: { username: 'refused-basic', password: 'refused-basic-pass' } });
    const engine = await api('POST', '/workspace/actions/MES.setPriority', { token: basic.json.token, body: { args: ['WO-10001', 'High'] }, headers: { 'If-Match': before.etag } });
    assert.equal(engine.status, 403);
    const engineRow = await latest();
    assert.deepEqual([engineRow.action, engineRow.status, engineRow.reason], ['MES.setPriority', 403, 'refused by the engine']);
    assert.equal(engineRow.message, engine.json.error);
    // An action whose result would leave the workspace invalid (the post-action check) is refused and audited.
    const resolveAction = server.host.resolveAction;
    server.host.resolveAction = name => name === 'MES.setPriority' ? state => { state.orders = 'not a list'; return { ok: true, message: 'corrupted' }; } : resolveAction(name);
    let invalid;
    try { invalid = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: ['WO-10001', 'High', secret] }, headers: { 'If-Match': before.etag } }); }
    finally { server.host.resolveAction = resolveAction; }
    assert.equal(invalid.status, 422);
    assert.match(invalid.json.error, /^The action would leave the workspace invalid: /);
    const invalidRow = await latest();
    assert.deepEqual([invalidRow.action, invalidRow.status], ['MES.setPriority', 422]);
    assert.match(invalidRow.reason, /^would leave the workspace invalid: /);
    assert.equal((await refused()).length, count + 9, 'each refusal adds exactly one audit row');
    assert.equal(JSON.stringify((await refused()).slice(0, 9)).includes(secret), false, 'no refusal row records the request arguments');
    assert.equal(server.store.getDoc('default').etag, before.etag, 'the refused actions leave the shared workspace unchanged');
    assert.equal(server.store.verifyAudit().ok, true, 'the audit chain still verifies');
  });
  await check('bulk account writes reject client-supplied roles, grants, training and Support Access', async () => {
    const created = await api('PUT', '/auth/accounts', { token, body: { users: [
      { username: 'combined', displayName: 'Combined role account', role: 'technician', roles: ['technician'], salt: 'combined-salt', hash: sha('combined-salt', 'combined-pass-123') }
    ] } });
    assert.equal(created.status, 200);
    const forged = await api('PUT', '/auth/accounts', { token, body: { users: [{ ...created.json.users[0], extraRoles: ['qe'], roleTraining: { qe: { code: 'ESD' } }, grants: { 'aqi-sign': { trainingCode: 'ESD', hash: 'a'.repeat(64) } }, grantHistory: [{ authority: 'aqi-sign', action: 'granted', hash: 'a'.repeat(64) }], supportAccess: true }] } });
    assert.equal(forged.status, 403);
    assert.match(forged.json.error, /server-authorized access route/i);
    const forgedPrimaryList = await api('PUT', '/auth/accounts', { token, body: { users: [{ ...created.json.users[0], roles: ['technician', 'admin'] }] } });
    assert.equal(forgedPrimaryList.status, 403, 'bulk account writes cannot add an untrained second role');
    const forgedNewAccount = await api('PUT', '/auth/accounts', { token, body: { users: [{ username: 'forged-admin', displayName: 'Forged Admin', role: 'technician', roles: ['technician', 'admin'], salt: 'forged-salt', hash: sha('forged-salt', 'forged-pass-123') }] } });
    assert.equal(forgedNewAccount.status, 403, 'new accounts cannot carry multiple client-selected roles');
    assert.equal(server.store.account('forged-admin'), null);
    const untrainedInspector = await api('PUT', '/auth/accounts', { token, body: { users: [{ username: 'untrained-inspector', displayName: 'Untrained Inspector', role: 'qe', roles: ['qe'], salt: 'inspector-salt', hash: sha('inspector-salt', 'inspector-pass-123') }] } });
    assert.equal(untrainedInspector.status, 403, 'new inspection and MRB role accounts require a current workspace training record');
    assert.match(untrainedInspector.json.error, /requires a current training record/i);
    assert.equal(server.store.account('untrained-inspector'), null);
    assert.deepEqual(server.store.account('combined').extraRoles, []);
    assert.deepEqual(server.store.account('combined').grants, {});
    assert.equal(server.store.account('combined').supportAccess, false);
  });
  await check('server access grants require a named eligible account, current training and a hashed authority record', async () => {
    const row = server.store.getDoc('default'), state = server.host.MES.upgrade(JSON.parse(row.json));
    const training = server.host.withAccount(server.store.account('one'), () => server.host.MES.recordTraining(state, { account: 'combined', code: 'ESD', expires: '2099-12-31', note: 'Server authority route regression.' }), state);
    assert.equal(training.ok, true);
    assert.equal(server.host.MES.validate(state), true);
    assert.ok(server.store.putDoc('default', JSON.stringify(state), row.etag, 'one'));
    const qaPassword = 'qa-manager-pass-123';
    const accounts = await api('GET', '/auth/accounts', { token });
    const qaCreated = await api('PUT', '/auth/accounts', { token, body: { users: [...accounts.json.users, { username: 'qa-manager', displayName: 'QA Manager', role: 'general', roles: ['general'], salt: '', hash: await makeHash(qaPassword) }] } });
    assert.equal(qaCreated.status, 200, JSON.stringify(qaCreated.json));
    const qaTrainingState = server.host.MES.upgrade(JSON.parse(server.store.getDoc('default').json));
    const qaTraining = server.host.withAccount(server.store.account('one'), () => server.host.MES.recordTraining(qaTrainingState, { account: 'qa-manager', code: 'ESD', expires: '2099-12-31', note: 'QA Manager role assignment regression.' }), qaTrainingState);
    assert.equal(qaTraining.ok, true);
    const qaTrainingDoc = server.store.getDoc('default');
    assert.ok(server.store.putDoc('default', JSON.stringify(qaTrainingState), qaTrainingDoc.etag, 'one'));
    const qaRole = await api('POST', '/auth/access', { token, body: { action: 'roles', username: 'qa-manager', roles: ['qm'], reason: 'Assign trained QA Manager role.', trainingCode: 'ESD' } });
    assert.equal(qaRole.status, 200, JSON.stringify(qaRole.json));
    const qaSession = await api('POST', '/auth/session', { body: { username: 'qa-manager', password: qaPassword } });
    assert.equal(qaSession.status, 200);
    const qaToken = qaSession.json.token;
    const self = await api('POST', '/auth/access', { token: qaToken, body: { action: 'grant', username: 'qa-manager', cap: 'conformity', reason: 'Testing self-grant refusal.', trainingCode: 'ESD' } });
    assert.equal(self.status, 403);
    assert.match(self.json.error, /Nobody grants or revokes their own authority/);
    const expanded = await api('POST', '/auth/access', { token, body: { action: 'roles', username: 'combined', roles: ['technician', 'qe'], reason: 'Qualified role assignment.', trainingCode: 'ESD' } });
    assert.equal(expanded.status, 200, JSON.stringify(expanded.json));
    assert.deepEqual(server.store.account('combined').extraRoles, ['qe']);
    assert.ok(server.host.capsOf(server.store.account('combined'), state).includes('approve-wo'));
    assert.ok(!server.host.capsOf(server.store.account('combined'), state).includes('inspect-steps'), 'Quality role without a stamp cannot inspect');
    assert.ok(server.host.capsOf(server.store.account('combined'), state).includes('mrb-quality'), 'Quality role carries its MRB seat');
    const qualityStamp = server.host.withAccount(server.store.account('qa-manager'), () => server.host.MES.issueStamp(state, { name: 'Combined role account', buyoffType: 'Quality', account: 'combined', expires: '2099-12-31' }), state);
    assert.equal(qualityStamp.ok, true, JSON.stringify(qualityStamp));
    assert.ok(server.host.capsOf(server.store.account('combined'), state).includes('inspect-steps'), 'server activates inspection only after an assigned Quality stamp');
    const assignedStamp = state.stamps.find(stamp => stamp.account === 'combined');
    assignedStamp.status = 'Suspended';
    assert.ok(!server.host.capsOf(server.store.account('combined'), state).includes('inspect-steps'), 'server refuses a suspended inspection stamp');
    assignedStamp.status = 'Active';
    const individualInspection = await api('POST', '/auth/access', { token: qaToken, body: { action: 'grant', username: 'combined', cap: 'inspect-steps', reason: 'Current inspection qualification verified.', trainingCode: 'ESD' } });
    assert.equal(individualInspection.status, 400, 'inspection cannot be granted individually');
    const individualSeat = await api('POST', '/auth/access', { token: qaToken, body: { action: 'grant', username: 'combined', cap: 'mrb-quality', reason: 'Current Quality MRB seat qualification verified.', trainingCode: 'ESD' } });
    assert.equal(individualSeat.status, 400, 'MRB seats cannot be granted individually');

    const noTrainingAccount = await api('PUT', '/auth/accounts', { token, body: { users: [
      ...((await api('GET', '/auth/accounts', { token })).json.users),
      { username: 'primary-swap', displayName: 'Primary Swap', role: 'technician', roles: ['technician'], salt: 'primary-swap-salt', hash: sha('primary-swap-salt', 'primary-swap-pass-123') }
    ] } });
    assert.equal(noTrainingAccount.status, 200);
    const missingPrimaryTraining = await api('POST', '/auth/access', { token, body: { action: 'roles', username: 'primary-swap', roles: ['qe'], reason: 'Assign qualified primary role.' } });
    assert.equal(missingPrimaryTraining.status, 403);
    assert.match(missingPrimaryTraining.json.error, /no current selected training record/i);
    assert.equal(server.store.account('primary-swap').role, 'technician', 'primary-role refusal leaves account unchanged');
    const primaryTrainingState = server.host.MES.upgrade(JSON.parse(server.store.getDoc('default').json));
    const primaryTraining = server.host.withAccount(server.store.account('one'), () => server.host.MES.recordTraining(primaryTrainingState, { account: 'primary-swap', code: 'ESD', expires: '2099-12-31', note: 'Primary role change regression.' }), primaryTrainingState);
    assert.equal(primaryTraining.ok, true);
    const primaryTrainingDoc = server.store.getDoc('default');
    assert.ok(server.store.putDoc('default', JSON.stringify(primaryTrainingState), primaryTrainingDoc.etag, 'one'));
    const primaryChange = await api('POST', '/auth/access', { token, body: { action: 'roles', username: 'primary-swap', roles: ['qe'], reason: 'Assign qualified primary role.', trainingCode: 'ESD' } });
    assert.equal(primaryChange.status, 200, JSON.stringify(primaryChange.json));
    assert.equal(server.store.account('primary-swap').role, 'qe');

    assert.ok(server.host.capsOf(server.store.account('combined'), state).includes('inspect-steps'));
    assert.ok(server.host.capsOf(server.store.account('combined'), state).includes('mrb-quality'));
    await server.store.upsertAccount({ username: 'untrained', displayName: 'Untrained User', role: 'qe', roles: ['qe'], extraRoles: [], roleTraining: {}, grants: {}, grantHistory: [], supportAccess: false, salt: 'untrained-salt', hash: sha('untrained-salt', 'untrained-pass-123'), createdAt: new Date().toISOString(), createdBy: 'test' });
    const missing = await api('POST', '/auth/access', { token: qaToken, body: { action: 'grant', username: 'untrained', cap: 'conformity', reason: 'Testing missing training refusal.', trainingCode: 'ESD' } });
    assert.equal(missing.status, 403);
    assert.match(missing.json.error, /no current ESD training record/i);
    const grant = await api('POST', '/auth/access', { token: qaToken, body: { action: 'grant', username: 'combined', cap: 'conformity', reason: 'Current ESD qualification verified.', trainingCode: 'ESD' } });
    assert.equal(grant.status, 200, JSON.stringify(grant.json));
    const account = server.store.account('combined'), history = account.grantHistory.at(-1);
    assert.ok(server.host.capsOf(account, state).includes('conformity'));
    assert.equal(history.by.account, 'qa-manager');
    assert.equal(history.by.credentialId, 'ACCT-qa-manager');
    assert.equal(history.trainingCode, 'ESD');
    assert.match(history.hash, /^[0-9a-f]{64}$/);
    assert.equal(history.hash, createHash('sha256').update(server.host.MES.canonical(Object.fromEntries(Object.entries(history).filter(([key]) => key !== 'hash')))).digest('hex'));
  });
  await check('nobody grants themselves roles, training or a stamp through the server', async () => {
    // The access route and the MES action route both run under the caller's session authority. Each way to hold
    // inspection or MRB authority refuses the caller as its own target, and a refused action leaves the workspace unchanged.
    const qaToken = (await api('POST', '/auth/session', { body: { username: 'qa-manager', password: 'qa-manager-pass-123' } })).json.token;
    const rolesBefore = JSON.stringify(server.host.rolesOf(server.store.account('qa-manager')));
    const selfRoles = await api('POST', '/auth/access', { token: qaToken, body: { action: 'roles', username: 'qa-manager', roles: ['qm', 'qe'], reason: 'Testing self role refusal.', trainingCode: 'ESD' } });
    assert.equal(selfRoles.status, 403, JSON.stringify(selfRoles.json));
    assert.match(selfRoles.json.error, /Nobody changes their own roles/);
    assert.equal(JSON.stringify(server.host.rolesOf(server.store.account('qa-manager'))), rolesBefore, 'a refused self role change leaves the account unchanged');
    const adminSelfRoles = await api('POST', '/auth/access', { token, body: { action: 'roles', username: 'one', roles: ['admin', 'qe'], reason: 'Testing Master Access self role refusal.', trainingCode: 'ESD' } });
    assert.equal(adminSelfRoles.status, 403, JSON.stringify(adminSelfRoles.json));
    assert.match(adminSelfRoles.json.error, /Nobody changes their own roles/);
    const act = async (name, args) => api('POST', `/workspace/actions/${name}`, { token: qaToken, body: { args }, headers: { 'If-Match': server.store.getDoc('default').etag } });
    const docBefore = server.store.getDoc('default');
    const selfTraining = await act('MES.recordTraining', [{ account: 'qa-manager', code: 'ESD', expires: '2099-12-31', note: 'Testing self training refusal.' }]);
    assert.equal(selfTraining.status, 403, JSON.stringify(selfTraining.json));
    assert.match(selfTraining.json.error, /Nobody records their own training/);
    const selfStamp = await act('MES.issueStamp', [{ name: 'QA Manager', buyoffType: 'Quality', account: 'qa-manager', expires: '2099-12-31' }]);
    assert.equal(selfStamp.status, 403, JSON.stringify(selfStamp.json));
    assert.match(selfStamp.json.error, /Nobody issues a stamp to their own account/);
    const otherStamp = (server.host.MES.upgrade(JSON.parse(server.store.getDoc('default').json)).stamps || []).find(stamp => stamp.account !== 'qa-manager');
    assert.ok(otherStamp, 'the workspace has a stamp held by someone else');
    const selfAssign = await act('MES.updateStamp', [otherStamp.id, { account: 'qa-manager' }]);
    assert.equal(selfAssign.status, 403, JSON.stringify(selfAssign.json));
    assert.match(selfAssign.json.error, /Nobody assigns a stamp to their own account/);
    assert.equal(server.store.getDoc('default').etag, docBefore.etag, 'refused self-target actions do not change the shared workspace');
    assert.ok(!server.host.capsOf(server.store.account('qa-manager'), server.host.MES.upgrade(JSON.parse(server.store.getDoc('default').json))).includes('inspect-steps'), 'the QA Manager holds no inspection authority after the refusals');
    const refusals = (await server.store.auditRows(1000)).filter(row => row.action === 'action-refused').map(row => JSON.parse(row.detail).action);
    for (const name of ['MES.recordTraining', 'MES.issueStamp', 'MES.updateStamp']) assert.ok(refusals.includes(name), `${name} refusal is audited`);
    const otherTraining = await act('MES.recordTraining', [{ account: 'combined', code: 'ESD', expires: '2099-12-31', note: 'Training recorded for another person.' }]);
    assert.equal(otherTraining.status, 200, JSON.stringify(otherTraining.json));
  });
  await check('Quality Supervisor can manage ordinary accounts but cannot grant or alter elevated access', async () => {
    const current = await api('GET', '/auth/accounts', { token });
    const withSupervisor = await api('PUT', '/auth/accounts', { token, body: { users: [
      ...current.json.users,
      { username: 'supervisor', displayName: 'Quality Supervisor', role: 'general', roles: ['general'], salt: 'supervisor-salt', hash: sha('supervisor-salt', 'supervisor-pass-123') }
    ] } });
    assert.equal(withSupervisor.status, 200);
    const supervisorTrainingState = server.host.MES.upgrade(JSON.parse(server.store.getDoc('default').json));
    const supervisorTraining = server.host.withAccount(server.store.account('one'), () => server.host.MES.recordTraining(supervisorTrainingState, { account: 'supervisor', code: 'ESD', expires: '2099-12-31', note: 'Quality Supervisor role assignment regression.' }), supervisorTrainingState);
    assert.equal(supervisorTraining.ok, true);
    const supervisorTrainingDoc = server.store.getDoc('default');
    assert.ok(server.store.putDoc('default', JSON.stringify(supervisorTrainingState), supervisorTrainingDoc.etag, 'one'));
    const supervisorRole = await api('POST', '/auth/access', { token, body: { action: 'roles', username: 'supervisor', roles: ['qs'], reason: 'Assign trained Quality Supervisor role.', trainingCode: 'ESD' } });
    assert.equal(supervisorRole.status, 200, JSON.stringify(supervisorRole.json));
    const signedIn = await api('POST', '/auth/session', { body: { username: 'supervisor', password: 'supervisor-pass-123' } });
    assert.equal(signedIn.status, 200);
    const qsToken = signedIn.json.token;
    const supervisorAccounts = await api('GET', '/auth/accounts', { token: qsToken });
    const withRegular = await api('PUT', '/auth/accounts', { token: qsToken, body: { users: [
      ...supervisorAccounts.json.users,
      { username: 'floor-user', displayName: 'Floor User', role: 'general', roles: ['general'], salt: 'floor-salt', hash: sha('floor-salt', 'floor-user-pass-123') }
    ] } });
    assert.equal(withRegular.status, 200);
    const assignment = await api('POST', '/auth/access', { token: qsToken, body: { action: 'roles', username: 'floor-user', roles: ['qm'], reason: 'Testing elevated role refusal.' } });
    assert.equal(assignment.status, 403);
    assert.match(assignment.json.error, /cannot assign QA Manager/i);
    const adminName = await api('PUT', '/auth/accounts', { token: qsToken, body: { users: withRegular.json.users.map(user => user.username === 'one' ? { ...user, displayName: 'Changed Master' } : user) } });
    assert.equal(adminName.status, 403);
    assert.match(adminName.json.error, /cannot change a QA Manager or Master Access/i);
    const selfRole = await api('POST', '/auth/access', { token: qsToken, body: { action: 'roles', username: 'supervisor', roles: ['general'], reason: 'Testing self role refusal.' } });
    assert.equal(selfRole.status, 403);
    assert.match(selfRole.json.error, /Nobody changes their own roles/);
    assert.equal(server.host.roleOf(server.store.account('supervisor')), 'qs');
    assert.equal(server.store.account('floor-user').role, 'general');
  });
  await check('expanded roles and named authority grants require current training on the shared workspace', async () => {
    const at = '2026-09-26T12:00:00.000Z', by = { name: 'Quality Manager', credentialId: 'ACCT-one', account: 'one' };
    const record = { account: 'trained-user', authority: 'conformity', action: 'granted', by, at, reason: 'Current training verified.', trainingCode: 'ESD' };
    const account = { username: 'trained-user', displayName: 'Trained user', role: 'technician', roles: ['technician'], extraRoles: ['qe'], roleTraining: { qe: { code: 'ESD' } }, grants: { conformity: { by, at, reason: record.reason, trainingCode: 'ESD', hash: createHash('sha256').update(server.host.MES.canonical(record)).digest('hex') } } };
    const state = JSON.parse(server.store.getDoc('default').json);
    const definition = server.host.MES.trainingCatalog(state).find(item => item.code === 'ESD' && item.status === 'Active');
    assert.ok(definition, 'fixture training ESD should be active');
    state.trainingRecords = (state.trainingRecords || []).filter(record => record.account !== account.username);
    const fixtureRecord = { id: 'TRN-99999', account: account.username, code: definition.code, expires: '2099-12-31', recordedAt: '2026-09-26T12:00:00.000Z', recordedBy: 'QA', note: 'Server authorization fixture.', qmsRev: definition.qmsRev || '' };
    state.trainingRecords.push(fixtureRecord);
    assert.ok(server.host.capsOf(account).includes('operate-steps'));
    assert.ok(!server.host.capsOf(account).includes('approve-wo'), 'extra role is inactive without workspace training');
    assert.ok(!server.host.capsOf(account).includes('conformity'), 'the named grant is inactive without workspace training');
    const active = server.host.capsOf(account, state);
    assert.ok(active.includes('approve-wo'));
    assert.ok(active.includes('mrb-quality'));
    assert.ok(active.includes('conformity'));
    fixtureRecord.expires = '2000-01-01';
    const expired = server.host.capsOf(account, state);
    assert.ok(!expired.includes('approve-wo'));
    assert.ok(!expired.includes('conformity'));
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
    // Wrong passwords sent at the same time still count one each: the counter is a single atomic write.
    const guesses = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/auth/session', { body: { username: 'basic', password: 'wrong' } })));
    assert.ok(guesses.every(result => result.status === 401), JSON.stringify(guesses.map(result => result.status)));
    assert.equal((await server.store.auditRows(1000)).filter(row => row.action === 'lockout' && row.username === 'basic').length, 1, 'five concurrent failures lock the account exactly once');
    assert.equal((await api('POST', '/auth/session', { body: { username: 'basic', password: 'basic-pass-123' } })).status, 423);
    const result = await api('POST', '/auth/unlock', { token, body: { username: 'basic', reason: 'Verified with the person.' } });
    assert.equal(result.status, 200);
    assert.equal((await api('POST', '/auth/session', { body: { username: 'basic', password: 'basic-pass-123' } })).status, 200);
  });
  await check('evidence supersession that loses a concurrent update returns 409 and writes no audit', async () => {
    const ids = ['EV-00000000-0000-4000-8000-00000000b001', 'EV-00000000-0000-4000-8000-00000000b002', 'EV-00000000-0000-4000-8000-00000000b003'];
    ids.forEach((id, index) => { const bytes = Buffer.from(`supersede take ${index}`); server.store.putEvidence({ id, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mime: 'video/webm', fileName: 'take.webm', uploadedBy: 'test', bytes }); });
    assert.equal(server.store.supersedeEvidence(ids[0], ids[1], 'first replacement').supersededBy, ids[1]);
    assert.equal(server.store.supersedeEvidence(ids[0], ids[2], 'second replacement'), null, 'the conditional update reports that it changed nothing');
    assert.equal(server.store.evidenceMeta(ids[0]).supersededBy, ids[1], 'the first replacement stands');
    // The route read the row before the other request committed: simulate that interleaving.
    const realMeta = server.store.evidenceMeta.bind(server.store);
    let reads = 0;
    server.store.evidenceMeta = id => { const row = realMeta(id); return id === ids[0] && reads++ === 0 ? { ...row, supersededBy: null } : row; };
    const audits = server.store.auditRows(5000).filter(row => row.action === 'evidence-supersede').length;
    try {
      const lost = await api('POST', `/evidence/${ids[0]}/supersede`, { token, body: { by: ids[2], reason: 'Race with another manager.' } });
      assert.equal(lost.status, 409, JSON.stringify(lost.json));
      assert.match(lost.json.error, new RegExp(ids[1]));
    } finally { server.store.evidenceMeta = realMeta; }
    assert.equal(server.store.auditRows(5000).filter(row => row.action === 'evidence-supersede').length, audits, 'the losing request is not audited');
  });
  await check('the evidence report survives the largest orphan report and older truncated audit details', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => `EV-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const reported = await api('POST', '/evidence/orphans', { token, body: { ids, uploaded: 3 } });
    assert.equal(reported.status, 200);
    assert.equal(reported.json.recorded, 500);
    await server.store.audit('one', 'evidence-orphans', { ids }); // an entry written before the bounded format, cut at 4,000 characters
    const report = await api('GET', '/evidence/report', { token });
    assert.equal(report.status, 200, JSON.stringify(report.json));
    const [legacy, bounded] = report.json.orphansReported.slice(-2);
    assert.equal(JSON.stringify([bounded.detail.count, bounded.detail.ids.length, bounded.detail.more]), JSON.stringify([500, 80, 420]), 'the new entry keeps the count and the first IDs');
    assert.equal(legacy.detail.truncated, true, 'a truncated older entry is reported, not thrown');
  });
  await check('a bulk account save compares against rows read inside the authority lock', async () => {
    const hash = await makeHash('bulk-target-pass-1');
    server.store.upsertAccount({ username: 'bulk-target', displayName: 'Bulk Target', salt: '', hash, role: 'technician', roles: ['technician'], extraRoles: [], roleTraining: {} });
    // The bulk save reads the account list, then a concurrent role change adds a role before its transaction runs.
    const realAccounts = server.store.accounts.bind(server.store);
    let first = true;
    server.store.accounts = (...args) => {
      const rows = realAccounts(...args);
      if (first) { first = false; const target = server.store.account('bulk-target'); server.store.upsertAccount({ ...target, extraRoles: ['operator'], roleTraining: { operator: { code: 'ESD', at: new Date(now).toISOString(), by: 'one' } } }); }
      return rows;
    };
    try {
      const saved = await api('PUT', '/auth/accounts', { token, body: { users: [{ username: 'bulk-target', displayName: 'Bulk Target renamed', role: 'technician' }] } });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
    } finally { server.store.accounts = realAccounts; }
    const after = server.store.account('bulk-target');
    assert.equal(JSON.stringify([after.displayName, after.extraRoles]), JSON.stringify(['Bulk Target renamed', ['operator']]), 'the concurrent role change is kept, not overwritten with the stale profile');
  });
  await check('action commits converge derived state that never became a command', async () => {
    const before = server.store.getDoc('default');
    const doc = JSON.parse(before.json);
    // Plant stale derived state the browser only fixes on render/refresh, never as a queued command.
    doc.assignments = Array.isArray(doc.assignments) ? doc.assignments : [];
    const closedId = (doc.orders.find(order => order.status === 'Closed') || {}).id || 'WO-NONE';
    doc.assignments.push({ id: 'A-STALE', type: 'op', orderId: closedId, opId: 'op-010', status: 'Open', assignee: { username: 'tech', name: 'Tech' } });
    delete doc.maneuver;
    delete doc.plannedOrders;
    delete doc.blockers;
    delete doc.masterWIs;
    const plantedEtag = server.store.putDoc('default', JSON.stringify(doc), before.etag, 'server-test-fixture');
    assert.ok(plantedEtag, 'the stale derived state is planted');
    const acted = await api('POST', '/workspace/actions/MES.pruneExpiredNotices', { token, body: { args: [] }, headers: { 'If-Match': plantedEtag } });
    assert.equal(acted.status, 200, JSON.stringify(acted.json));
    const after = JSON.parse(server.store.getDoc('default').json);
    const stale = after.assignments.find(a => a.id === 'A-STALE');
    assert.ok(stale, 'the planted assignment survived the commit');
    assert.equal(stale.status, 'Done', 'assignment auto-close converges on the server commit');
    assert.equal(stale.autoClosed, true);
    assert.ok(after.maneuver && Array.isArray(after.maneuver.cars), 'maneuver defaults converge on the server commit');
    assert.ok(Array.isArray(after.plannedOrders), 'plan defaults converge on the server commit');
    assert.ok(Array.isArray(after.masterWIs) && after.masterWIs.length > 0, 'master WI defaults converge on the server commit');
    assert.ok(Array.isArray(after.blockers), 'planning blockers recompute on the server commit');
  });
  await check('an invalid converged workspace refuses the write and keeps the previous record', async () => {
    const before = server.store.getDoc('default');
    const doc = JSON.parse(before.json);
    const template = doc.orders.find(order => order.status !== 'Closed') || doc.orders[0];
    assert.ok(template, 'the workspace has a work order to clone');
    // The engine holds at most 100 work orders: past that, post-convergence validation must fail.
    for (let i = 0; doc.orders.length < 105; i += 1) doc.orders.push({ ...structuredClone(template), id: `${template.id}-bulk-${i}` });
    const plantedEtag = server.store.putDoc('default', JSON.stringify(doc), before.etag, 'server-test-fixture');
    assert.ok(plantedEtag);
    const refused = await api('POST', '/workspace/actions/MES.pruneExpiredNotices', { token, body: { args: [] }, headers: { 'If-Match': plantedEtag } });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.match(refused.json.error, /the workspace holds 100/);
    const kept = server.store.getDoc('default');
    assert.equal(kept.etag, plantedEtag, 'the refused write keeps the previous record');
    assert.equal(kept.json, JSON.stringify(doc), 'the refused write persists nothing');
  });
  await check('workspace initialization converges derived state before the first commit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-system-init-'));
    const second = createServer({ dbPath: path.join(dir, 'flight.sqlite'), quiet: true, setupCode: 'init-test-setup-code' });
    await second.ready;
    try {
      const handler = second.listeners('request')[0];
      const call = async (method, url, { token: tok, body } = {}) => {
        const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
        incoming.method = method;
        incoming.url = url;
        incoming.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(tok ? { authorization: `Bearer ${tok}` } : {}) };
        const chunks = [];
        const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
        outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
        const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
        handler(incoming, outgoing);
        await finished;
        const text = Buffer.concat(chunks).toString('utf8');
        return { status: outgoing.statusCode, json: text ? JSON.parse(text) : null };
      };
      const created = await call('PUT', '/api/auth/accounts', { body: { setupCode: 'init-test-setup-code', users: [{ username: 'init-admin', displayName: 'Init Admin', role: 'general', salt: 's', hash: sha('s', 'init-pass-123') }] } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const signedIn = await call('POST', '/api/auth/session', { body: { username: 'init-admin', password: 'init-pass-123' } });
      assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
      const tok = signedIn.json.token;
      const state = second.host.MES.seed();
      delete state.maneuver;
      delete state.plannedOrders;
      delete state.blockers;
      delete state.masterWIs;
      state.assignments = [{ id: 'A-INIT', type: 'op', orderId: 'WO-NONE', opId: 'op-010', status: 'Open', assignee: { username: 'tech', name: 'Tech' } }];
      const put = await call('PUT', '/api/workspace', { token: tok, body: state });
      assert.equal(put.status, 204, JSON.stringify(put.json));
      const loaded = await call('GET', '/api/workspace', { token: tok });
      assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
      assert.ok(loaded.json.maneuver && Array.isArray(loaded.json.maneuver.cars), 'init converges maneuver defaults');
      assert.ok(Array.isArray(loaded.json.plannedOrders), 'init converges plan defaults');
      assert.ok(Array.isArray(loaded.json.masterWIs) && loaded.json.masterWIs.length > 0, 'init converges master WIs');
      assert.ok(Array.isArray(loaded.json.blockers), 'init recomputes planning blockers');
      const initStale = loaded.json.assignments.find(a => a.id === 'A-INIT');
      assert.ok(initStale, 'the planted assignment survived initialization');
      assert.equal(initStale.status, 'Done', 'init auto-closes the stale assignment');
      assert.equal(initStale.autoClosed, true);
      assert.equal(second.host.MES.validate(loaded.json), true, 'the converged initial workspace validates');
    } finally {
      second.store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
