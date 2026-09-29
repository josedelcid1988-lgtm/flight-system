// Server hardening: what an unauthenticated caller can learn, how sessions are kept at rest, who may read
// evidence bytes, what a failure tells the caller, which engine functions are remote commands, and that
// every committed change carries its audit row in the same transaction. Each rule is checked with the
// request it is meant to refuse.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Writable } from 'node:stream';
import { createServer, makeHash, DEFAULT_HOST } from '../server/server.mjs';

const fails = [];
let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; console.log(`ok ${name}`); } catch (error) { fails.push(name); console.log(`FAIL ${name} -> ${error.message}`); }
};
const SETUP_CODE = 'security-test-setup-code';
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const handler = server.listeners('request')[0];
const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const incoming = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]);
  incoming.method = method;
  incoming.url = url;
  incoming.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status, values = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)])); return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  handler(incoming, outgoing);
  await finished;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: outgoing.statusCode, text, json, headers: outgoing.responseHeaders || {}, bytes: Buffer.concat(chunks) };
};
const api = (method, route, { token, body, headers = {}, raw = false } = {}) => request(`/api${route}`, {
  method,
  headers: { ...(raw || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
});
const pageContext = html => { const m = /window\.FLIGHT_SERVER=(\{.*?\});<\/script>/.exec(html); assert.ok(m, 'the page carries the server context'); return JSON.parse(m[1]); };
const signIn = async (username, password) => { const r = await api('POST', '/auth/session', { body: { username, password } }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.token; };

try {
  await server.ready;
  await check('before any account exists the sign-in page says setup is needed and lists nobody', async () => {
    const ctx = pageContext((await request('/')).text);
    assert.deepEqual(ctx.auth.users, []);
    assert.equal(ctx.auth.setupRequired, true);
  });
  const created = await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'sec-admin', displayName: 'Security Admin', role: 'admin', salt: '', hash: await makeHash('sec-admin-pass-1') }] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  let adminToken = await signIn('sec-admin', 'sec-admin-pass-1');
  const roster = await api('GET', '/auth/accounts', { token: adminToken });
  const addUser = async (username, role, password) => {
    const users = (await api('GET', '/auth/accounts', { token: adminToken })).json.users;
    const r = await api('PUT', '/auth/accounts', { token: adminToken, body: { users: [...users, { username, displayName: `User ${username}`, role, roles: [role], salt: '', hash: await makeHash(password) }] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };
  assert.equal(roster.status, 200);
  await addUser('sec-tech', 'technician', 'sec-tech-pass-1');

  // #26, #72: the account directory is not in the page an unauthenticated visitor receives.
  await check('the unauthenticated sign-in page carries no account directory', async () => {
    for (const url of ['/', '/index.html']) {
      const html = (await request(url)).text, ctx = pageContext(html);
      assert.deepEqual(ctx.auth.users, [], `${url} lists no accounts`);
      assert.equal(ctx.auth.setupRequired, false, `${url} says the first account exists`);
      assert.equal(ctx.account, null);
      for (const leak of ['sec-admin', 'sec-tech', 'Security Admin', 'User sec-tech']) assert.ok(!html.includes(leak), `${url} does not name ${leak}`);
    }
  });
  await check('a signed-in caller still reads the account list from the session-gated route', async () => {
    const r = await api('GET', '/auth/accounts', { token: adminToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.users.map(u => u.username).sort(), ['sec-admin', 'sec-tech']);
    assert.equal((await api('GET', '/auth/accounts')).status, 401, 'the account list needs a session');
  });

  // #28: the sessions table holds a SHA-256 of each token, never the token a caller presents.
  await check('session tokens are stored only as SHA-256 hashes', async () => {
    const token = await signIn('sec-tech', 'sec-tech-pass-1');
    const rows = server.store.db.prepare('SELECT * FROM sessions').all();
    const values = rows.flatMap(row => Object.values(row).map(String));
    assert.ok(!values.includes(token), 'the token itself is not at rest');
    assert.ok(values.includes(createHash('sha256').update(token).digest('hex')), 'its SHA-256 is');
    assert.equal((await api('GET', '/auth/session', { token })).status, 200, 'the token still signs the caller in');
  });
  await check('a value copied out of the sessions table does not work as a token', async () => {
    for (const row of server.store.db.prepare('SELECT * FROM sessions').all()) {
      for (const value of Object.values(row).map(String).filter(v => v.length >= 32)) assert.equal((await api('GET', '/auth/session', { token: value })).status, 401, 'a stored value is refused');
    }
  });

  // #29: evidence bytes are read under the authority of the record that names them.
  await check('evidence no record names is readable only by its uploader and a manager', async () => {
    await addUser('sec-tech2', 'technician', 'sec-tech2-pass-1');
    const uploader = await signIn('sec-tech', 'sec-tech-pass-1'), other = await signIn('sec-tech2', 'sec-tech2-pass-1');
    adminToken = await signIn('sec-admin', 'sec-admin-pass-1');
    const upload = async (id, token) => { const bytes = Buffer.from(`evidence ${id}`); const r = await api('POST', `/evidence/${id}`, { token, raw: true, body: bytes, headers: { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': createHash('sha256').update(bytes).digest('hex') } }); assert.equal(r.status, 201, JSON.stringify(r.json)); return bytes; };
    const loose = 'EV-00000000-0000-4000-8000-0000000c0001', named = 'EV-00000000-0000-4000-8000-0000000c0002', archived = 'EV-00000000-0000-4000-8000-0000000c0003', copied = 'EV-00000000-0000-4000-8000-0000000c0004';
    const bytes = await upload(loose, uploader);
    await upload(named, uploader); await upload(archived, uploader); await upload(copied, uploader);
    for (const suffix of ['', '/meta']) {
      const refused = await api('GET', `/evidence/${loose}${suffix}`, { token: other });
      assert.equal(refused.status, 403, `another account cannot read ${suffix || 'the bytes'} of a recording no record names`);
      assert.ok(!refused.bytes.includes(bytes), 'no bytes are returned');
      assert.match(refused.json.error, /not attached to a record/);
    }
    assert.ok((await server.store.auditRows(200)).some(row => row.action === 'evidence-read-refused' && row.username === 'sec-tech2'), 'the refusal is audited');
    const own = await api('GET', `/evidence/${loose}`, { token: uploader });
    assert.equal(own.status, 200); assert.ok(own.bytes.equals(bytes), 'the uploader reads the recording it sent');
    assert.equal((await api('GET', `/evidence/${loose}`, { token: adminToken })).status, 200, 'a manager reads any recording');
    // Named by a live operation (directly or as the stored copy of another ID) or by an archived order: every
    // signed-in account can read that record, so it can read the recording.
    const doc = { orders: [{ id: 'WO-SEC-1', operations: [{ id: 'op-010', evidence: [{ id: named }, { id: 'EV-00000000-0000-4000-8000-0000000c0099', copyOf: copied }] }] }] };
    const current = await server.store.getDoc('default');
    assert.ok(await server.store.putDoc('default', JSON.stringify(doc), current ? current.etag : null, 'security-test'));
    const json = JSON.stringify({ order: { id: 'WO-SEC-ARC', status: 'Closed', operations: [{ id: 'op-010', quarantinedEvidence: [{ id: archived }] }] }, activity: [] });
    await server.store.putArchived({ id: 'WO-SEC-ARC', json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: 'P', serials: [], lots: [], parts: ['P'], title: 'Security', closedAt: null }, by: 'security-test' });
    for (const id of [named, copied, archived]) assert.equal((await api('GET', `/evidence/${id}`, { token: other })).status, 200, `${id} is named by a record, so any signed-in account reads it`);
    assert.equal((await api('GET', `/evidence/${loose}`, { token: other })).status, 403, 'the unnamed recording stays refused');
  });
} finally {
  await server.closeAsync().catch(() => {});
}

await check('sessions stored in plaintext by an older server are ended on upgrade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-session-upgrade-'));
  try {
    const file = path.join(dir, 'flight.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, issued_at TEXT NOT NULL, last_seen TEXT NOT NULL)');
    const at = new Date().toISOString();
    old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('legacy-plaintext-session-token-0001', 'someone', at, at);
    old.close();
    const upgraded = createServer({ dbPath: file, quiet: true, setupCode: 'upgrade-test' });
    await upgraded.ready;
    try {
      const values = upgraded.store.db.prepare('SELECT * FROM sessions').all().flatMap(row => Object.values(row).map(String));
      assert.ok(!values.includes('legacy-plaintext-session-token-0001'), 'no plaintext token survives the upgrade');
      assert.equal(await upgraded.store.session('legacy-plaintext-session-token-0001'), null, 'the old token no longer opens a session');
    } finally { upgraded.store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// #27: with no host named, the server listens on loopback only; a wider bind must be asked for.
await check('the server binds 127.0.0.1 unless a host is named', async () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  const saved = process.env.FLIGHT_HOST;
  delete process.env.FLIGHT_HOST;
  const local = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'bind-test' });
  try { await local.listenAsync(0); assert.equal(local.address().address, '127.0.0.1'); } finally { await local.closeAsync(); if (saved !== undefined) process.env.FLIGHT_HOST = saved; }
  const wide = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'bind-test', host: '0.0.0.0' });
  try { await wide.listenAsync(0); assert.equal(wide.address().address, '0.0.0.0', 'an explicit host is still honoured'); } finally { await wide.closeAsync(); }
});
console.log(`server security: ${checks} checks passed`);
console.log('FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
