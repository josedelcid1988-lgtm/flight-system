// Codex security review on #307 (r4159760680): two QA Manager or Master Access requests that race to
// initialize an empty server. PUT /workspace looked for an existing workspace before it read the body,
// then committed with the ETag it found afterwards. A request that started while the server was empty
// and finished after another request had initialized it could present that new ETag and replace the
// freshly initialized workspace, which the action-only boundary forbids. Initialization now commits only
// while the server is still empty; the late request is refused with 409, audited, and the first
// workspace stays exactly as it was stored.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from '../server/server.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${name}`); };
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const SETUP_CODE = 'init-race-test-setup-code';
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const handler = server.listeners('request')[0];
const headerMap = headers => Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
// Starts a request whose body arrives when the caller ends the returned stream.
const open = (method, url, headers = {}) => {
  const incoming = new PassThrough();
  incoming.method = method;
  incoming.url = `/api${url}`;
  incoming.headers = headerMap(headers);
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status, values = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)])); return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  handler(incoming, outgoing);
  const response = finished.then(() => {
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: outgoing.statusCode, json, etag: outgoing.responseHeaders?.etag || null };
  });
  return { incoming, response };
};
const api = async (method, url, { token, body, headers = {} } = {}) => {
  const { incoming, response } = open(method, url, { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers });
  incoming.end(body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  return response;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

await server.ready;
const { MES, FlightPlan } = server.host;
assert.equal((await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [
  { username: 'one', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }
] } })).status, 200);
const signedIn = await api('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } });
assert.equal(signedIn.status, 200);
const token = signedIn.json.token;
const state = MES.ensureMasterWIs(MES.seed());
FlightPlan.ensure(state);

await check('a snapshot that started on an empty server cannot replace a workspace initialized meanwhile', async () => {
  assert.equal((await api('GET', '/workspace', { token })).status, 404, 'the server starts empty');
  // Request A starts while the server is empty and waits for its body.
  const late = open('PUT', '/workspace', { Authorization: `Bearer ${token}` });
  await tick();
  // Request B initializes the server.
  const first = await api('PUT', '/workspace', { token, body: state });
  assert.equal(first.status, 204, 'the first initialization succeeds');
  assert.ok(first.etag);
  const stored = await api('GET', '/workspace', { token });
  assert.equal(stored.etag, first.etag);
  // Request A finishes with a different document and presents the new ETag.
  const replacement = structuredClone(state);
  replacement.profile = { ...replacement.profile, name: 'Snapshot identity override' };
  late.incoming.headers['if-match'] = first.etag;
  late.incoming.end(Buffer.from(JSON.stringify(replacement)));
  const result = await late.response;
  assert.equal(result.status, 409, 'the late initialization is refused');
  const after = await api('GET', '/workspace', { token });
  assert.equal(after.etag, first.etag, 'the first workspace keeps its ETag');
  assert.deepEqual(after.json, stored.json, 'the first workspace is unchanged');
  const rows = await server.store.auditRows(200);
  assert.equal(rows.filter(row => row.action === 'workspace-initialize').length, 1, 'only one initialization is recorded');
  const refusal = rows.find(row => row.action === 'workspace-put-refused');
  assert.ok(refusal, 'the late initialization is audited as a refusal');
  assert.equal(JSON.parse(refusal.detail).status, 409);
});

await check('a snapshot to an initialized server is still refused as before', async () => {
  const loaded = await api('GET', '/workspace', { token });
  const changed = structuredClone(loaded.json);
  changed.profile = { ...changed.profile, name: 'Another override' };
  const refused = await api('PUT', '/workspace', { token, body: changed, headers: { 'If-Match': loaded.etag } });
  assert.equal(refused.status, 403);
  assert.equal((await api('GET', '/workspace', { token })).etag, loaded.etag);
});

// Codex review on #521 (r4160591729): a workspace initialized after this request's emptiness check but before its
// commit must be refused as the initialization conflict it is (409), not as a calibration log change against the
// winner's stored log (422).
await check('a workspace initialized just before the commit is refused with 409, not a calibration error', async () => {
  const other = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
  const otherHandler = other.listeners('request')[0];
  await other.ready;
  const call = async (method, url, { token: bearer, body, headers = {} } = {}) => {
    const incoming = new PassThrough();
    incoming.method = method; incoming.url = `/api${url}`; incoming.headers = headerMap({ ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers });
    const chunks = [];
    const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    outgoing.writeHead = (status, values = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)])); return outgoing; };
    const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
    otherHandler(incoming, outgoing);
    incoming.end(body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    await finished;
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: outgoing.statusCode, json, etag: outgoing.responseHeaders?.etag || null };
  };
  assert.equal((await call('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [
    { username: 'one', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }
  ] } })).status, 200);
  const session = await call('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } });
  const bearer = session.json.token;
  // The winning initialization holds a calibration entry; the losing candidate holds none.
  const winner = other.host.MES.ensureMasterWIs(other.host.MES.seed());
  other.host.FlightPlan.ensure(winner);
  const recorded = other.host.withAccount({ username: 'one', displayName: 'Flight Admin', role: 'qm' }, () => other.host.MES.recordCalibration(winner, { tag: 'RACE-001', description: 'DIGITAL CALIPER', torque: false, serial: 'SN-1', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: 'Production Floor', note: '' }), winner);
  assert.ok(recorded.ok, recorded.message);
  const first = await call('PUT', '/workspace', { token: bearer, body: winner });
  assert.equal(first.status, 204, JSON.stringify(first.json));
  const loser = other.host.MES.ensureMasterWIs(other.host.MES.seed());
  other.host.FlightPlan.ensure(loser);
  // The losing request saw an empty server at every check before its commit: only commitState reads the stored workspace.
  const getDoc = other.store.getDoc.bind(other.store);
  other.store.getDoc = async (...args) => (new Error().stack.includes('commitState') ? getDoc(...args) : null);
  let late;
  try { late = await call('PUT', '/workspace', { token: bearer, body: loser }); } finally { other.store.getDoc = getDoc; }
  assert.equal(late.status, 409, JSON.stringify(late.json));
  const after = await call('GET', '/workspace', { token: bearer });
  assert.equal(after.etag, first.etag, 'the first workspace keeps its ETag');
  const rows = await other.store.auditRows(200);
  assert.equal(rows.filter(row => row.action === 'workspace-initialize').length, 1);
  const refusal = rows.find(row => row.action === 'workspace-put-refused');
  assert.equal(JSON.parse(refusal.detail).status, 409);
});

console.log(`\n${checks} checks passed`);
process.exit(0);
