// #580: the server's manager route gate counts an extra role only while its role training is current, the same
// way the engine host (host.rolesOf) and /auth/access count it. An account that holds QA Manager only as an extra
// role whose training has lapsed is refused every manager-only route; the same account with current training is
// allowed; a primary QA Manager needs no role training.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createServer } from '../server/server.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${name}`); };
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const SETUP_CODE = 'manages-training-setup-code';
const handlerFor = server => {
  const handler = server.listeners('request')[0];
  return async (method, url, { token, body, raw = false, headers = {} } = {}) => {
    const incoming = Readable.from(body === undefined ? [] : [raw ? body : Buffer.from(JSON.stringify(body))]);
    incoming.method = method;
    incoming.url = `/api${url}`;
    incoming.headers = Object.fromEntries(Object.entries({ ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const chunks = [];
    const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
    const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
    handler(incoming, outgoing);
    await finished;
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: outgoing.statusCode, json };
  };
};
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const api = handlerFor(server);
const signIn = async (call, username, password) => {
  const r = await call('POST', '/auth/session', { body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
};
const accountRecord = (username, extra) => ({ username, displayName: username, salt: `${username}-salt`, hash: sha(`${username}-salt`, `${username}-pass-123`), role: 'qe', roles: ['qe'], extraRoles: [], roleTraining: {}, grants: {}, grantHistory: [], supportAccess: false, createdAt: new Date().toISOString(), createdBy: 'test', ...extra });
const uploadEvidence = async (id, token) => {
  const bytes = Buffer.from(`evidence ${id}`);
  const r = await api('POST', `/evidence/${id}`, { token, raw: true, body: bytes, headers: { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': createHash('sha256').update(bytes).digest('hex') } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
};

try {
  await server.ready;
  const { MES, FlightPlan } = server.host;
  assert.equal((await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'one', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }] } })).status, 200);
  const adminToken = await signIn(api, 'one', 'flight-pass-123');
  const state = MES.ensureMasterWIs(MES.seed());
  FlightPlan.ensure(state);
  // Both accounts hold QA Manager only as an extra role tied to ESD training; only current-qm has a current record.
  const extraQm = { extraRoles: ['qm'], roleTraining: { qm: { code: 'ESD', at: new Date().toISOString(), by: 'one' } } };
  server.store.upsertAccount(accountRecord('lapsed-qm', extraQm));
  server.store.upsertAccount(accountRecord('current-qm', extraQm));
  server.store.upsertAccount(accountRecord('primary-qm', { role: 'qm', roles: ['qm'] }));
  server.store.upsertAccount(accountRecord('plain-tech', { role: 'technician', roles: ['technician'] }));
  const trained = server.host.withAccount(server.store.account('one'), () => MES.recordTraining(state, { account: 'current-qm', code: 'ESD', expires: '2099-12-31', note: 'Extra QA Manager role training for #580.' }), state);
  assert.equal(trained.ok, true, JSON.stringify(trained));
  const initialized = await api('PUT', '/workspace', { token: adminToken, body: state });
  assert.equal(initialized.status, 204, JSON.stringify(initialized.json));

  const lapsed = await signIn(api, 'lapsed-qm', 'lapsed-qm-pass-123');
  const current = await signIn(api, 'current-qm', 'current-qm-pass-123');
  const primary = await signIn(api, 'primary-qm', 'primary-qm-pass-123');
  const tech = await signIn(api, 'plain-tech', 'plain-tech-pass-123');

  await check('the engine host counts the extra role only with current training', async () => {
    const stored = MES.upgrade(JSON.parse(server.store.getDoc('default').json));
    assert.deepEqual(server.host.rolesOf(server.store.account('lapsed-qm'), stored), ['qe']);
    assert.deepEqual(server.host.rolesOf(server.store.account('current-qm'), stored), ['qe', 'qm']);
  });

  const reads = [
    ['/audit', /read the audit log/],
    ['/auth/hash-report', /password hash report/],
    ['/auth/lockouts', /see lockouts/],
    ['/evidence/report', /evidence report/],
    ['/record-exports/settings', /configure record exports/],
    ['/record-exports/jobs', /record export delivery logs/]
  ];
  await check('a lapsed extra QA Manager role is refused every manager-only read', async () => {
    for (const [url, message] of reads) {
      const r = await api('GET', url, { token: lapsed });
      assert.equal(r.status, 403, `${url}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, message);
    }
  });
  await check('the same extra role with current training, and a primary QA Manager, are allowed every manager-only read', async () => {
    for (const token of [current, primary]) for (const [url] of reads) {
      const r = await api('GET', url, { token });
      assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.json)}`);
    }
  });

  await check('a lapsed extra QA Manager role cannot unlock an account; current training can', async () => {
    server.store.setLockout('plain-tech', 5, Date.now() + 60000);
    const body = { username: 'plain-tech', reason: 'Verified in person.' };
    const refused = await api('POST', '/auth/unlock', { token: lapsed, body });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.match(refused.json.error, /unlock an account/);
    assert.ok(server.store.lockout('plain-tech').until > Date.now(), 'the refused unlock leaves the lockout in place');
    const allowed = await api('POST', '/auth/unlock', { token: current, body });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
    assert.ok(!(server.store.lockout('plain-tech').until > Date.now()), 'the allowed unlock clears the lockout');
  });

  await check('a lapsed extra QA Manager role cannot manage accounts; current training can', async () => {
    const before = JSON.stringify(server.store.account('plain-tech'));
    const users = [{ username: 'plain-tech', displayName: 'Plain Tech renamed', role: 'technician', roles: ['technician'] }];
    const refused = await api('PUT', '/auth/accounts', { token: lapsed, body: { users } });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.match(refused.json.error, /can manage accounts/);
    assert.equal(JSON.stringify(server.store.account('plain-tech')), before, 'the refused change leaves the account unchanged');
    const allowed = await api('PUT', '/auth/accounts', { token: current, body: { users } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
    assert.equal(server.store.account('plain-tech').displayName, 'Plain Tech renamed');
  });

  await check('a lapsed extra QA Manager role cannot change record export settings; current training can', async () => {
    const setting = { recordType: 'fair', enabled: false, destinationKind: 'folder', destination: path.join(os.tmpdir(), 'flight-exports'), namingPattern: '{recordType}-{recordId}-{exportId}.json', rationale: 'Training gate regression.' };
    const refused = await api('PUT', '/record-exports/settings', { token: lapsed, body: setting });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    const allowed = await api('PUT', '/record-exports/settings', { token: current, body: setting });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
  });

  await check('a lapsed extra QA Manager role cannot open or supersede another account\'s recording; current training can', async () => {
    const loose = 'EV-00000000-0000-4000-8000-000000058001', replacement = 'EV-00000000-0000-4000-8000-000000058002';
    await uploadEvidence(loose, tech);
    await uploadEvidence(replacement, tech);
    for (const suffix of ['', '/meta']) {
      assert.equal((await api('GET', `/evidence/${loose}${suffix}`, { token: lapsed })).status, 403, `a lapsed role cannot open ${suffix || 'the bytes'}`);
      assert.equal((await api('GET', `/evidence/${loose}${suffix}`, { token: current })).status, 200, `current training opens ${suffix || 'the bytes'}`);
    }
    const body = { by: replacement, reason: 'Clearer recording.' };
    const refused = await api('POST', `/evidence/${loose}/supersede`, { token: lapsed, body });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.match(refused.json.error, /supersede evidence/);
    assert.equal(server.store.evidenceMeta(loose).supersededBy || null, null, 'the refused supersede changes nothing');
    const allowed = await api('POST', `/evidence/${loose}/supersede`, { token: current, body });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
  });

  await check('authority is decided again inside the account transaction: training that lapses before the commit refuses the change', async () => {
    // Codex review on #633: the account route checked authority against a workspace read before password hashing and
    // the transaction. Here the training record is removed from the stored workspace just before the transaction runs.
    const before = JSON.stringify(server.store.account('plain-tech'));
    const original = server.store.transaction.bind(server.store);
    server.store.transaction = async fn => {
      const row = server.store.getDoc('default');
      const lapsed = JSON.parse(row.json);
      for (const person of lapsed.people || []) if (person && person.account === 'current-qm') person.training = [];
      if (Array.isArray(lapsed.trainingRecords)) lapsed.trainingRecords = lapsed.trainingRecords.filter(r => r.account !== 'current-qm');
      assert.ok(server.store.putDoc('default', JSON.stringify(lapsed), row.etag, 'test'));
      server.store.transaction = original;
      return original(fn);
    };
    try {
      const stale = MES.upgrade(JSON.parse(server.store.getDoc('default').json));
      assert.deepEqual(server.host.rolesOf(server.store.account('current-qm'), stale), ['qe', 'qm'], 'before the request the role still counts');
      const refused = await api('PUT', '/auth/accounts', { token: current, body: { users: [{ username: 'plain-tech', displayName: 'Plain Tech changed late', role: 'technician', roles: ['technician'] }] } });
      assert.equal(refused.status, 403, JSON.stringify(refused.json));
      assert.match(refused.json.error, /can manage accounts/);
      assert.equal(JSON.stringify(server.store.account('plain-tech')), before, 'nothing is changed');
      const after = MES.upgrade(JSON.parse(server.store.getDoc('default').json));
      assert.deepEqual(server.host.rolesOf(server.store.account('current-qm'), after), ['qe'], 'the lapse took effect in the stored workspace');
    } finally { server.store.transaction = original; }
  });

  await check('without a stored workspace an extra role never counts', async () => {
    const empty = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
    try {
      await empty.ready;
      empty.store.upsertAccount(accountRecord('current-qm', extraQm));
      const call = handlerFor(empty);
      const token = await signIn(call, 'current-qm', 'current-qm-pass-123');
      const r = await call('GET', '/audit', { token });
      assert.equal(r.status, 403, 'no workspace holds the training record, so the extra role does not count');
    } finally { empty.store.close(); }
  });
} finally {
  server.store.close();
}

console.log(`server manages training: ${checks} checks, all passed`);
