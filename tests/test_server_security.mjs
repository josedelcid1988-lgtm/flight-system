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
import { openDb } from '../server/db.mjs';

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

  // #30: a remote command must be named on the reviewed list; matching a command-like prefix is not enough.
  await check('only reviewed engine commands are remotely callable', async () => {
    const host = server.host, allow = host.actionAllow;
    assert.ok(allow instanceof Set && allow.size > 100, 'the server carries an explicit list of commands');
    for (const name of allow) assert.equal(typeof host.resolveAction(name), 'function', `${name} on the list resolves`);
    // Review gate: every exported engine function the prefix rule would take is either listed or excluded, so a
    // new one fails here until someone decides which it is.
    const unreviewed = [];
    for (const ns of ['MES', 'FlightPlan', 'FlightManeuver']) for (const key of Object.keys(host[ns])) {
      if (typeof host[ns][key] !== 'function' || key.startsWith('_')) continue;
      if ((host.actionPattern.test(key) || host.actionExact.has(key)) && !host.actionExclude.has(key) && !allow.has(`${ns}.${key}`)) unreviewed.push(`${ns}.${key}`);
    }
    assert.deepEqual(unreviewed, [], 'every command-like engine function has been reviewed');
    assert.equal(host.resolveAction('MES.openMaintenanceFor'), null, 'a read that only looks like a command is not callable');
    assert.equal(typeof host.resolveAction('setPriority'), 'function', 'an unqualified name means MES');
    for (const name of ['MES.constructor', 'MES.hasOwnProperty', 'FlightPlan.setPriority', 'Object.assign']) assert.equal(host.resolveAction(name), null, `${name} is not a command`);
    host.MES.setUnreviewedThing = state => { state.touched = true; return { ok: true }; };
    try {
      assert.equal(host.resolveAction('MES.setUnreviewedThing'), null, 'a new exported function is not callable until it is added to the list');
      const before = await server.store.getDoc('default');
      const r = await api('POST', '/workspace/actions/MES.setUnreviewedThing', { token: adminToken, body: { args: [] }, headers: { 'If-Match': before ? before.etag : '"none"' } });
      assert.equal(r.status, 404, JSON.stringify(r.json));
      assert.deepEqual(await server.store.getDoc('default'), before, 'nothing changed');
    } finally { delete host.MES.setUnreviewedThing; }
  });

  // #32: the demo build, with its gates relaxed, is not a public page of the production server.
  await check('the production server does not serve demo.html unless asked to', async () => {
    const r = await request('/demo.html');
    assert.equal(r.status, 404, 'demo.html is not served by default');
    assert.ok(!r.text.includes('NOT FOR ACCEPTANCE'));
    const saved = process.env.FLIGHT_SERVE_DEMO;
    delete process.env.FLIGHT_SERVE_DEMO;
    const demo = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'demo-test', serveDemo: true });
    try {
      await demo.ready;
      const out = await new Promise((resolve, reject) => {
        const incoming = Readable.from([]); incoming.method = 'GET'; incoming.url = '/demo.html'; incoming.headers = {};
        const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
        outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
        outgoing.once('finish', () => resolve({ status: outgoing.statusCode, text: Buffer.concat(chunks).toString('utf8') })); outgoing.once('error', reject);
        demo.listeners('request')[0](incoming, outgoing);
      });
      assert.equal(out.status, 200, 'an operator who asks for the demo gets it');
      assert.match(out.text, /NOT FOR ACCEPTANCE/);
    } finally { demo.store.close(); if (saved !== undefined) process.env.FLIGHT_SERVE_DEMO = saved; }
  });

  // #31, #79: health tells an unauthenticated caller only that the server is up.
  await check('unauthenticated health reports liveness only', async () => {
    const r = await api('GET', '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true }, 'no product, account count, workspace, ETag or schema');
    assert.deepEqual((await api('GET', '/health', { token: 'not-a-session' })).json, { ok: true }, 'an invalid token is treated as unauthenticated');
    const signedIn = await api('GET', '/health', { token: adminToken });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.json.product, 'Flight System');
    assert.equal(signedIn.json.accounts, 2, 'a signed-in caller still gets the operating detail');
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

  // Codex review of #96: an archived order authorizes a recording only through an operation's evidence or
  // quarantinedEvidence entry (id or copyOf, exact). An ID planted in any other archived string names nothing.
  await check('an evidence ID planted in an unrelated archived string does not authorize reading it', async () => {
    const uploader = await signIn('sec-tech', 'sec-tech-pass-1'), other = await signIn('sec-tech2', 'sec-tech2-pass-1');
    const planted = 'EV-00000000-0000-4000-8000-0000000c0201', viaCopy = 'EV-00000000-0000-4000-8000-0000000c0202';
    for (const id of [planted, viaCopy]) { const bytes = Buffer.from(`evidence ${id}`); assert.equal((await api('POST', `/evidence/${id}`, { token: uploader, raw: true, body: bytes, headers: { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': createHash('sha256').update(bytes).digest('hex') } })).status, 201); }
    const archive = async (orderId, entry) => { const json = JSON.stringify(entry); await server.store.putArchived({ id: orderId, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: 'P', serials: [], lots: [], parts: ['P'], title: 'Planted', closedAt: null }, by: 'security-test' }); };
    // The ID as a whole quoted JSON string in every place that is not an evidence reference.
    await archive('WO-SEC-PLANT', { order: { id: 'WO-SEC-PLANT', status: 'Closed', title: planted, notes: [{ text: planted, evidence: [{ id: planted }] }],
      operations: [{ id: 'op-010', title: planted, evidence: { id: planted }, attachments: [{ id: planted }], buyoff: { evidenceId: planted, evidence: [{ id: planted }] }, quarantinedEvidence: [planted, { name: planted, ref: { id: planted } }] }, planted] },
      activity: [{ orderId: 'WO-SEC-PLANT', action: planted, evidence: [{ id: planted }] }], [planted]: { id: planted } });
    assert.equal(await server.store.archiveNamesEvidence(planted), false, 'the store finds no evidence reference to the planted ID');
    for (const suffix of ['', '/meta']) {
      const refused = await api('GET', `/evidence/${planted}${suffix}`, { token: other });
      assert.equal(refused.status, 403, `a planted ID does not open ${suffix || 'the bytes'}`);
      assert.match(refused.json.error, new RegExp(`^${planted} is not attached to a record yet\\. Until it is saved on an operation, only the account that uploaded it, a QA Manager, or a Master Access account can open it\\.`));
    }
    // The legitimate reference still authorizes: the stored copy behind another ID on an archived operation.
    await archive('WO-SEC-COPY', { order: { id: 'WO-SEC-COPY', status: 'Closed', operations: [{ id: 'op-010', evidence: [{ id: 'EV-00000000-0000-4000-8000-0000000c0299', copyOf: viaCopy }] }] }, activity: [] });
    assert.equal(await server.store.archiveNamesEvidence(viaCopy), true);
    assert.equal((await api('GET', `/evidence/${viaCopy}`, { token: other })).status, 200, 'an archived copyOf reference still authorizes');
    assert.equal((await api('GET', `/evidence/${planted}`, { token: other })).status, 403, 'the planted ID stays refused');
  });

  // Codex review of #242: archived evidence references are recorded when an order is archived and looked up by index,
  // so an ID planted in many archived strings costs one lookup, not a parse of every matching row. A database from
  // before the reference table gets it once, filled from every archived order.
  await check('archived evidence references are indexed at archive time and backfilled once for an older database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-archive-refs-'));
    try {
      const file = path.join(dir, 'flight.db');
      const legit = 'EV-00000000-0000-4000-8000-0000000c0401', copied = 'EV-00000000-0000-4000-8000-0000000c0402', planted = 'EV-00000000-0000-4000-8000-0000000c0403';
      const put = (store, id, entry) => { const json = JSON.stringify(entry); store.putArchived({ id, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: 'P', serials: [], lots: [], parts: ['P'], title: 'Refs', closedAt: null }, by: 'security-test' }); };
      const first = openDb(file);
      put(first, 'WO-REF-1', { order: { id: 'WO-REF-1', status: 'Closed', operations: [{ id: 'op-010', evidence: [{ id: legit }], quarantinedEvidence: [{ id: 'EV-00000000-0000-4000-8000-0000000c04ff', copyOf: copied }] }] }, activity: [] });
      for (let i = 0; i < 50; i++) put(first, `WO-REF-P${i}`, { order: { id: `WO-REF-P${i}`, status: 'Closed', title: planted, operations: [{ id: 'op-010', title: planted, evidence: { id: planted } }] }, activity: [{ action: planted }] });
      const rows = db => db.prepare('SELECT evidence_id, order_id FROM archive_evidence ORDER BY evidence_id').all().map(r => `${r.evidence_id}@${r.order_id}`);
      const raw = new DatabaseSync(file);
      const expected = [`EV-00000000-0000-4000-8000-0000000c0401@WO-REF-1`, `EV-00000000-0000-4000-8000-0000000c0402@WO-REF-1`, `EV-00000000-0000-4000-8000-0000000c04ff@WO-REF-1`];
      assert.deepEqual(rows(raw), expected, 'only structural references are recorded, at archive time');
      assert.equal(first.archiveNamesEvidence(legit), true); assert.equal(first.archiveNamesEvidence(copied), true); assert.equal(first.archiveNamesEvidence(planted), false);
      first.close?.();
      // An older database: the archive rows are there, the reference tables are not.
      raw.exec('DROP TABLE archive_evidence; DROP TABLE archive_evidence_indexed'); raw.close();
      const reopened = openDb(file);
      const check2 = new DatabaseSync(file);
      assert.deepEqual(rows(check2), expected, 'the reference table is rebuilt from every archived order');
      assert.equal(reopened.archiveNamesEvidence(legit), true); assert.equal(reopened.archiveNamesEvidence(planted), false);
      // A server still on the previous release, sharing the database, archives an order without recording its
      // references. The next lookup that misses records it first, so the recording is never left unreadable.
      const late = 'EV-00000000-0000-4000-8000-0000000c0404', lateJson = JSON.stringify({ order: { id: 'WO-REF-OLD', status: 'Closed', operations: [{ id: 'op-010', evidence: [{ id: late }] }] }, activity: [] });
      check2.prepare("INSERT INTO archive (order_id, json, sha256, schema, part_number, serials, lots, parts, title, closed_at, archived_at, archived_by) VALUES ('WO-REF-OLD', ?, ?, 1, 'P', '[]', '[]', '[\"P\"]', 'Old writer', NULL, '2026-10-01T00:00:00.000Z', 'old-release')").run(lateJson, createHash('sha256').update(lateJson).digest('hex'));
      assert.equal(reopened.archiveNamesEvidence(late), true, 'an order archived by a previous-release server is indexed on the next lookup');
      assert.equal(reopened.archiveNamesEvidence(planted), false);
      assert.ok(rows(check2).includes(`${late}@WO-REF-OLD`));
      check2.close();
      reopened.close?.();
      // The same order, archived by an old writer after this server stopped, is indexed at the next startup too.
      const raw2 = new DatabaseSync(file); const late2 = 'EV-00000000-0000-4000-8000-0000000c0405', late2Json = JSON.stringify({ order: { id: 'WO-REF-OLD2', status: 'Closed', operations: [{ id: 'op-010', quarantinedEvidence: [{ id: late2 }] }] }, activity: [] });
      raw2.prepare("INSERT INTO archive (order_id, json, sha256, schema, part_number, serials, lots, parts, title, closed_at, archived_at, archived_by) VALUES ('WO-REF-OLD2', ?, ?, 1, 'P', '[]', '[]', '[\"P\"]', 'Old writer', NULL, '2026-10-01T00:00:00.000Z', 'old-release')").run(late2Json, createHash('sha256').update(late2Json).digest('hex'));
      raw2.close();
      const third = openDb(file); const raw3 = new DatabaseSync(file);
      assert.ok(rows(raw3).includes(`${late2}@WO-REF-OLD2`), 'startup records references for every archived order it has not indexed');
      raw3.close(); assert.equal(third.archiveNamesEvidence(late2), true); third.close?.();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // Codex review of #242: a reference to a recording on the server is trusted only when the account that adds it to
  // the workspace uploaded that recording (or manages access). Otherwise anyone who learned an unattached evidence ID
  // could attach it to an operation and then read it as a record-named recording.
  await check('only the uploader can add a reference to a stored recording; a forged attach is refused', async () => {
    const uploader = await signIn('sec-tech', 'sec-tech-pass-1'), other = await signIn('sec-tech2', 'sec-tech2-pass-1');
    const victim = 'EV-00000000-0000-4000-8000-0000000c0301';
    const bytes = Buffer.from(`evidence ${victim}`);
    assert.equal((await api('POST', `/evidence/${victim}`, { token: uploader, raw: true, body: bytes, headers: { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': createHash('sha256').update(bytes).digest('hex') } })).status, 201);
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
    const input = id => ({ id, fileName: 'capture.webm', mimeType: 'video/webm', size: bytes.length, source: 'upload', description: 'Operation capture' });
    const probe = server.host.MES.upgrade(structuredClone(fixture));
    const order = probe.orders.find(o => o.status === 'Building' && o.operations.some(op => !op.done) && server.host.MES.attachEvidence(structuredClone(probe), o.id, o.operations.find(op => !op.done).id, input('EV-00000000-0000-4000-8000-0000000c03ff')).ok);
    assert.ok(order, 'the fixture has a Building operation that takes video evidence');
    const opId = order.operations.find(op => !op.done).id;
    const current = await server.store.getDoc('default');
    assert.ok(await server.store.putDoc('default', JSON.stringify(fixture), current ? current.etag : null, 'security-test'));
    const before = await server.store.getDoc('default');
    const forged = await api('POST', '/workspace/actions/MES.attachEvidence', { token: other, body: { args: [order.id, opId, input(victim)] }, headers: { 'If-Match': before.etag } });
    assert.equal(forged.status, 422, JSON.stringify(forged.json));
    assert.match(forged.json.error, new RegExp(`^${victim} was uploaded by another account\\. Only the account that uploaded a recording, a QA Manager, or a Master Access account can attach it to a record\\.`));
    assert.equal((await server.store.getDoc('default')).etag, before.etag, 'the forged attach stores nothing');
    assert.ok((await server.store.auditRows(500)).some(row => row.action === 'evidence-refused' && row.username === 'sec-tech2'), 'the refusal is audited');
    assert.equal((await api('GET', `/evidence/${victim}`, { token: other })).status, 403, 'the recording stays unreadable to the other account');
    const own = await api('POST', '/workspace/actions/MES.attachEvidence', { token: uploader, body: { args: [order.id, opId, input(victim)] }, headers: { 'If-Match': before.etag } });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal((await api('GET', `/evidence/${victim}`, { token: other })).status, 200, 'once its uploader attaches it, the record names it for everyone');
  });

  // #103, #104: the read decision is the same for every role before and after the workspace changes, the refusal
  // names everyone who can open the recording, and repeated reads of an unchanged workspace do not parse it again.
  await check('evidence read decisions match every role across workspace writes, without reparsing an unchanged workspace', async () => {
    const roles = ['admin', 'general', 'technician', 'operator', 'ops', 'me', 'swe', 'qe', 'safety', 'cert', 'qs', 'qm'];
    const tokens = {};
    // Each account is created as a technician and then given its role in the store, so the inspection and MRB
    // roles do not need the training records account creation asks for; this check is about the read decision.
    for (const role of roles) {
      const name = `sec-role-${role}`;
      await addUser(name, 'technician', `${name}-pass-1`);
      await server.store.upsertAccount({ ...await server.store.account(name), role, roles: [role] });
    }
    for (const role of roles) tokens[role] = await signIn(`sec-role-${role}`, `sec-role-${role}-pass-1`);
    const uploader = await signIn('sec-tech', 'sec-tech-pass-1');
    const id = 'EV-00000000-0000-4000-8000-0000000c0105';
    const bytes = Buffer.from(`evidence ${id}`);
    assert.equal((await api('POST', `/evidence/${id}`, { token: uploader, raw: true, body: bytes, headers: { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': createHash('sha256').update(bytes).digest('hex') } })).status, 201);
    const managers = new Set(['admin', 'qm']);
    const expectDecisions = async (named, stage) => {
      for (const role of roles) for (const suffix of ['', '/meta']) {
        const r = await api('GET', `/evidence/${id}${suffix}`, { token: tokens[role] });
        const allowed = named || managers.has(role);
        assert.equal(r.status, allowed ? 200 : 403, `${stage}: ${role} ${allowed ? 'reads' : 'is refused'} ${suffix || 'the bytes'}`);
        if (!allowed) {
          assert.ok(!r.bytes.includes(bytes), `${stage}: no bytes reach ${role}`);
          assert.match(r.json.error, /the account that uploaded it, a QA Manager, or a Master Access account can open it/, 'the refusal names every account that can open it');
          assert.match(r.json.error, /Ask the uploader to save it on its operation/, 'the refusal says what to do next');
          assert.ok(!/\u2014/.test(r.json.error), 'no em dash in product text');
        }
      }
      assert.equal((await api('GET', `/evidence/${id}`, { token: uploader })).status, 200, `${stage}: the uploader reads its own recording`);
    };
    const write = async doc => { const cur = await server.store.getDoc('default'); assert.ok(await server.store.putDoc('default', JSON.stringify(doc), cur ? cur.etag : null, 'security-test')); };
    const unnamed = { orders: [{ id: 'WO-SEC-105', operations: [{ id: 'op-010', evidence: [{ id: 'EV-00000000-0000-4000-8000-0000000c0199' }] }] }] };
    await write(unnamed);
    await expectDecisions(false, 'before any record names it');
    // Repeated reads of an unchanged workspace reuse the parsed result: the stored workspace JSON is parsed at most
    // once across these reads, where before this change every read parsed it.
    const stored = (await server.store.getDoc('default')).json;
    const parse = JSON.parse; let parses = 0;
    JSON.parse = function (text, ...rest) { if (text === stored) parses++; return parse.call(this, text, ...rest); };
    try { for (let i = 0; i < 5; i++) assert.equal((await api('GET', `/evidence/${id}`, { token: tokens.technician })).status, 403); }
    finally { JSON.parse = parse; }
    assert.ok(parses <= 1, `the unchanged workspace was parsed ${parses} times over five reads`);
    await write({ orders: [{ id: 'WO-SEC-105', operations: [{ id: 'op-010', evidence: [{ id }] }] }] });
    await expectDecisions(true, 'after a write names it on an operation');
    await write(unnamed);
    await expectDecisions(false, 'after a write removes it again');
    await write({ orders: [{ id: 'WO-SEC-105', operations: [{ id: 'op-010', quarantinedEvidence: [{ id: 'EV-00000000-0000-4000-8000-0000000c0198', copyOf: id }] }] }] });
    await expectDecisions(true, 'after a write names it as the stored copy behind quarantined evidence');
    await write(unnamed);
    await expectDecisions(false, 'after the copy is removed');
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

// #33: a failure is logged on the server with a reference; the caller gets the reference, never the error text.
await check('an unexpected failure returns a generic message and a reference, and logs the detail', async () => {
  const noisy = createServer({ dbPath: ':memory:', setupCode: 'error-test' });
  await noisy.ready;
  const lines = [], realLog = console.log;
  console.log = (...parts) => { lines.push(parts.map(String).join(' ')); };
  try {
    const seeded = noisy.host.MES.ensureMasterWIs(noisy.host.MES.seed());
    await noisy.store.putDoc('default', JSON.stringify(seeded), null, 'error-test');
    await noisy.store.upsertAccount({ username: 'err-admin', displayName: 'Error Admin', salt: '', hash: await makeHash('err-admin-pass-1'), role: 'admin', roles: ['admin'] });
    const call = async (method, url, token, body) => {
      const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); incoming.method = method; incoming.url = url;
      incoming.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'POST' && url.includes('/actions/') ? { 'if-match': (await noisy.store.getDoc('default')).etag } : {}) };
      const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
      outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
      const done = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
      noisy.listeners('request')[0](incoming, outgoing); await done;
      const text = Buffer.concat(chunks).toString('utf8'); return { status: outgoing.statusCode, text, json: text ? JSON.parse(text) : null };
    };
    const token = (await call('POST', '/api/auth/session', null, { username: 'err-admin', password: 'err-admin-pass-1' })).json.token;
    const secret = 'SQLITE_CORRUPT reading flight-internal-store.sqlite page 7';
    const realSearch = noisy.store.archiveSearch;
    noisy.store.archiveSearch = () => { throw new Error(secret); };
    const failed = await call('GET', '/api/archive', token);
    noisy.store.archiveSearch = realSearch;
    assert.equal(failed.status, 500);
    assert.ok(!failed.text.includes('SQLITE') && !failed.text.includes('flight-internal-store'), `the error text stays on the server: ${failed.text}`);
    assert.match(failed.json.error, /reference [0-9A-F]{12}/);
    assert.ok(lines.some(line => line.includes(failed.json.reference) && line.includes(secret)), 'the server log carries the reference and the detail');
    const realPriority = noisy.host.MES.setPriority;
    noisy.host.MES.setPriority = () => { throw new Error('engine internals: state.orders[3].operations is undefined'); };
    const thrown = await call('POST', '/api/workspace/actions/MES.setPriority', token, { args: ['WO-10001', 'High'] });
    noisy.host.MES.setPriority = realPriority;
    assert.equal(thrown.status, 500);
    assert.ok(!thrown.text.includes('engine internals'), `an engine exception is not echoed: ${thrown.text}`);
    assert.match(thrown.json.error, /Nothing was saved/);
    assert.ok(lines.some(line => line.includes(thrown.json.reference) && line.includes('engine internals')));
  } finally { console.log = realLog; noisy.store.close(); }
});

// #34: the model adapter confirms only a setting the operator listed, so a caller cannot probe which server
// environment variables exist.
await check('the model adapter setting check is not an environment-name oracle', async () => {
  const probe = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'probe-test', modelAdapterSettings: ['FLIGHT_SECURITY_MODEL_KEY'] });
  await probe.ready;
  const saved = process.env.FLIGHT_SECURITY_MODEL_KEY;
  try {
    const seeded = probe.host.MES.ensureMasterWIs(probe.host.MES.seed());
    await probe.store.putDoc('default', JSON.stringify(seeded), null, 'probe-test');
    await probe.store.upsertAccount({ username: 'probe-admin', displayName: 'Probe Admin', salt: '', hash: await makeHash('probe-admin-pass-1'), role: 'admin', roles: ['admin'] });
    const call = async (url, token, body) => {
      const incoming = Readable.from([Buffer.from(JSON.stringify(body))]); incoming.method = 'POST'; incoming.url = url;
      incoming.headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}`, 'if-match': (await probe.store.getDoc('default')).etag } : {}) };
      const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
      outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
      const done = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
      probe.listeners('request')[0](incoming, outgoing); await done;
      const text = Buffer.concat(chunks).toString('utf8'); return { status: outgoing.statusCode, json: text ? JSON.parse(text) : null };
    };
    const token = (await call('/api/auth/session', null, { username: 'probe-admin', password: 'probe-admin-pass-1' })).json.token;
    const configure = settingName => call('/api/workspace/actions/MES.configureModelAdapter', token, { args: [{ enabled: true, provider: 'approved-model', settingName, rationale: 'Probe of the server environment check.' }] });
    assert.ok(process.env.PATH, 'PATH is set on this machine');
    delete process.env.FLIGHT_SECURITY_MODEL_KEY;
    const unlistedButSet = await configure('PATH'), listedUnset = await configure('FLIGHT_SECURITY_MODEL_KEY'), unlistedUnset = await configure('FLIGHT_NO_SUCH_SETTING_4711');
    for (const r of [unlistedButSet, listedUnset, unlistedUnset]) assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(unlistedButSet.json.error, unlistedUnset.json.error, 'a set variable the operator did not list answers exactly as an unset one');
    assert.equal(listedUnset.json.error, unlistedUnset.json.error);
    process.env.FLIGHT_SECURITY_MODEL_KEY = 'probe-secret-value';
    const listedSet = await configure('FLIGHT_SECURITY_MODEL_KEY');
    assert.equal(listedSet.status, 200, JSON.stringify(listedSet.json));
    assert.ok(!(await probe.store.getDoc('default')).json.includes('probe-secret-value'), 'the value is never written to the workspace');
  } finally { if (saved === undefined) delete process.env.FLIGHT_SECURITY_MODEL_KEY; else process.env.FLIGHT_SECURITY_MODEL_KEY = saved; probe.store.close(); }
});

// #77: a committed change and its audit row are one transaction. If the audit row cannot be written, the change
// is not kept either.
await check('a change whose audit row fails is not committed', async () => {
  const atomic = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'atomic-test' });
  await atomic.ready;
  const realAudit = atomic.store.audit;
  const failOn = action => { atomic.store.audit = function (username, name, detail) { if (name === action) throw new Error(`audit store unavailable for ${name}`); return realAudit.call(this, username, name, detail); }; };
  const restore = () => { atomic.store.audit = realAudit; };
  const call = async (method, url, token, body, headers = {}) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]); incoming.method = method; incoming.url = url;
    incoming.headers = { ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
    const done = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
    atomic.listeners('request')[0](incoming, outgoing); await done;
    const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; } return { status: outgoing.statusCode, json };
  };
  try {
    await atomic.store.upsertAccount({ username: 'atomic-admin', displayName: 'Atomic Admin', salt: '', hash: await makeHash('atomic-admin-pass-1'), role: 'admin', roles: ['admin'] });
    const token = (await call('POST', '/api/auth/session', null, { username: 'atomic-admin', password: 'atomic-admin-pass-1' })).json.token;
    // Workspace initialization.
    const seeded = atomic.host.MES.ensureMasterWIs(atomic.host.MES.seed());
    atomic.host.FlightPlan.ensure(seeded);
    failOn('workspace-initialize');
    const init = await call('PUT', '/api/workspace', token, seeded);
    restore();
    assert.equal(init.status, 500, JSON.stringify(init.json));
    assert.equal(await atomic.store.getDoc('default'), null, 'the workspace was not initialized without its audit row');
    assert.equal((await call('PUT', '/api/workspace', token, seeded)).status, 204, 'with the audit working the same initialization commits');
    // An engine action, on the curated workspace, whose closed orders also move to the archive on this commit.
    const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
    const state = JSON.parse(fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
    assert.ok(atomic.host.MES.archivable(state).length > 0, 'the fixture has closed orders to archive');
    const planted = await atomic.store.putDoc('default', JSON.stringify(state), (await atomic.store.getDoc('default')).etag, 'atomic-test');
    const open = state.orders.find(item => item.status !== 'Closed');
    failOn('action');
    const acted = await call('POST', '/api/workspace/actions/MES.setPriority', token, { args: [open.id, 'AOG'] }, { 'If-Match': planted });
    restore();
    assert.equal(acted.status, 500, JSON.stringify(acted.json));
    assert.equal((await atomic.store.getDoc('default')).etag, planted, 'the action was not committed without its audit row');
    assert.equal(await atomic.store.archiveCount(), 0, 'nor the archiving that came with it');
    // An evidence upload.
    const id = 'EV-00000000-0000-4000-8000-0000000d0001', bytes = Buffer.from('atomic evidence');
    failOn('evidence-upload');
    const uploaded = await call('POST', `/api/evidence/${id}`, token, bytes, { 'Content-Type': 'video/webm', 'X-Evidence-Sha256': createHash('sha256').update(bytes).digest('hex') });
    restore();
    assert.equal(uploaded.status, 500, JSON.stringify(uploaded.json));
    assert.equal(await atomic.store.evidenceMeta(id), null, 'the recording was not stored without its audit row');
    // Archiving on close: the archive rows and their audit rows go together with the document write.
    failOn('archive');
    const archiving = await call('POST', '/api/workspace/actions/MES.setPriority', token, { args: [open.id, 'AOG'] }, { 'If-Match': planted });
    restore();
    assert.equal(archiving.status, 500, JSON.stringify(archiving.json));
    assert.equal(await atomic.store.archiveCount(), 0, 'no order was archived without its audit row');
    assert.equal((await atomic.store.getDoc('default')).etag, planted, 'and the document write went with it');
    const retried = await call('POST', '/api/workspace/actions/MES.setPriority', token, { args: [open.id, 'AOG'] }, { 'If-Match': planted });
    assert.equal(retried.status, 200, JSON.stringify(retried.json));
    const rows = await atomic.store.auditRows(1000);
    assert.equal(rows.filter(row => row.action === 'archive').length, await atomic.store.archiveCount(), 'each archived order has its audit row');
    assert.ok(rows.some(row => row.action === 'action' && JSON.parse(row.detail).action === 'MES.setPriority'));
    assert.equal(atomic.store.verifyAudit().ok, true);
  } finally { restore(); atomic.store.close(); }
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
