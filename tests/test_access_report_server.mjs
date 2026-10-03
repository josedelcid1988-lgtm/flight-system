// The access review report on the server: GET /api/auth/access-report is read only and opens only for an
// account whose active roles include QA Manager or Master Access. A Quality Supervisor, an ordinary account,
// an account holding QA Manager only as an extra role whose training is not current, and a caller without a
// session are refused with a plain message. The
// report carries every account and the lockouts in force, and reading it writes no audit row and changes no
// account.
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createServer, makeHash } from '../server/server.mjs';

const fails = [];
let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; console.log(`ok ${name}`); } catch (error) { fails.push(name); console.log(`FAIL ${name} -> ${error.message}`); }
};
const SETUP_CODE = 'access-report-setup-code';
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const handler = server.listeners('request')[0];
const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const incoming = Readable.from(body === undefined ? [] : [Buffer.from(String(body))]);
  incoming.method = method;
  incoming.url = url;
  incoming.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status) => { outgoing.statusCode = status; return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  handler(incoming, outgoing);
  await finished;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: outgoing.statusCode, json };
};
const api = (method, route, { token, body } = {}) => request(`/api${route}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const signIn = async (username, password) => { const r = await api('POST', '/auth/session', { body: { username, password } }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.token; };

try {
  const created = await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'ar-admin', displayName: 'Report Admin', role: 'admin', salt: '', hash: await makeHash('ar-admin-pass-1') }] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const adminToken = await signIn('ar-admin', 'ar-admin-pass-1');
  // Seeded straight into the store: a manager role through the API needs a training record first, which
  // is not what this suite is about.
  const add = async (username, role, password) => {
    await server.store.upsertAccount({ username, displayName: `User ${username}`, role, roles: [role], extraRoles: [], roleTraining: {}, grants: {}, grantHistory: [], supportAccess: false, salt: '', hash: await makeHash(password), createdBy: 'ar-admin' });
  };
  await add('ar-qm', 'qm', 'ar-qm-pass-123');
  await add('ar-qs', 'qs', 'ar-qs-pass-123');
  await add('ar-tech', 'technician', 'ar-tech-pass-1');
  await add('ar-locked', 'technician', 'ar-locked-pass');
  // QA Manager held only as an extra role whose qualifying training is not on record: paused, so not a manager.
  await server.store.upsertAccount({ username: 'ar-paused-qm', displayName: 'User ar-paused-qm', role: 'technician', roles: ['technician'], extraRoles: ['qm'], roleTraining: { qm: { code: 'ESD', at: new Date().toISOString(), by: 'ar-admin' } }, grants: {}, grantHistory: [], supportAccess: false, salt: '', hash: await makeHash('ar-paused-qm-pass'), createdBy: 'ar-admin' });
  for (let i = 0; i < 5; i += 1) await api('POST', '/auth/session', { body: { username: 'ar-locked', password: 'wrong-password' } });
  const qmToken = await signIn('ar-qm', 'ar-qm-pass-123');
  const qsToken = await signIn('ar-qs', 'ar-qs-pass-123');
  const techToken = await signIn('ar-tech', 'ar-tech-pass-1');
  const pausedQmToken = await signIn('ar-paused-qm', 'ar-paused-qm-pass');

  for (const [who, token] of [['a QA Manager', qmToken], ['a Master Access account', adminToken]]) {
    await check(`${who} reads the access review: every account, no password material, the lockouts in force`, async () => {
      const r = await api('GET', '/auth/access-report', { token });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.users.map(u => u.username).sort(), ['ar-admin', 'ar-locked', 'ar-paused-qm', 'ar-qm', 'ar-qs', 'ar-tech']);
      assert.ok(r.json.users.every(u => !('hash' in u) && !('salt' in u)), 'no password hash or salt is sent');
      assert.deepEqual(r.json.lockouts.map(l => l.username), ['ar-locked']);
      assert.ok(Number.isFinite(Date.parse(r.json.lockouts[0].until)), 'the lockout says until when');
      const at = Date.parse(r.json.generatedAt);
      assert.ok(Number.isFinite(at) && Math.abs(at - Date.now()) < 60000, 'the server stamps the generation time');
      assert.ok('workspaceEtag' in r.json, 'the server names the workspace version it read (none here: no workspace yet)');
    });
  }
  for (const [who, token, status] of [['a Quality Supervisor', qsToken, 403], ['a technician', techToken, 403], ['an account whose QA Manager role is a paused extra role (training not current)', pausedQmToken, 403], ['a caller without a session', null, 401]]) {
    await check(`${who} is refused the access review with a plain message`, async () => {
      const r = await api('GET', '/auth/access-report', { token });
      assert.equal(r.status, status, JSON.stringify(r.json));
      assert.ok(!r.json || !('users' in r.json), 'no account list is sent');
      if (status === 403) assert.equal(r.json.error, 'Only a QA Manager or Master Access account opens the access review report. Ask one of them for a copy.');
    });
  }
  await check('reading the access review writes no audit row and changes no account', async () => {
    const before = { audit: server.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, accounts: JSON.stringify((await api('GET', '/auth/accounts', { token: adminToken })).json.users) };
    for (let i = 0; i < 3; i += 1) assert.equal((await api('GET', '/auth/access-report', { token: qmToken })).status, 200);
    await api('GET', '/auth/access-report', { token: techToken });
    const after = { audit: server.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, accounts: JSON.stringify((await api('GET', '/auth/accounts', { token: adminToken })).json.users) };
    assert.deepEqual(after, before);
  });
  // One version: a workspace write that lands while the server reads the accounts makes it read everything again;
  // writes that keep landing are refused with a plain message instead of an account list that does not match.
  await check('a workspace change during the read is re-read once, and the report names the version it matches', async () => {
    const seed = JSON.stringify(server.host.MES.seed());
    server.store.putDoc('default', seed, undefined, 'ar-admin');
    const real = server.store.accounts.bind(server.store); let calls = 0;
    server.store.accounts = (...args) => { calls += 1; if (calls === 1) server.store.putDoc('default', seed, undefined, 'ar-other'); return real(...args); };
    try {
      const r = await api('GET', '/auth/access-report', { token: qmToken });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(calls, 2, 'the accounts were read again after the workspace changed');
      assert.equal(r.json.workspaceEtag, server.store.getDoc('default').etag, 'the report names the version it was read against');
    } finally { server.store.accounts = real; }
  });
  await check('a workspace that keeps changing during the read is refused with a plain message and no account list', async () => {
    const seed = JSON.stringify(server.host.MES.seed());
    const real = server.store.accounts.bind(server.store);
    server.store.accounts = (...args) => { server.store.putDoc('default', seed, undefined, 'ar-other'); return real(...args); };
    try {
      const r = await api('GET', '/auth/access-report', { token: qmToken });
      assert.equal(r.status, 409, JSON.stringify(r.json));
      assert.equal(r.json.error, 'The shared workspace changed while the access review was being built. Try again in a moment.');
      assert.ok(!('users' in r.json));
    } finally { server.store.accounts = real; }
  });
  await check('the refusal text carries no em dash', async () => {
    const r = await api('GET', '/auth/access-report', { token: techToken });
    assert.ok(!/—/.test(r.json.error));
  });
} catch (error) {
  fails.push(`setup: ${error.message}`);
  console.log(`FAIL setup -> ${error.stack}`);
} finally {
  try { server.close(); } catch {}
}
console.log(`${checks} checks`);
console.log('FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
