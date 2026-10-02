// One storage contract for both stores (#594 follow-up). server/db.mjs (SQLite) and server/db-postgres.mjs
// (PostgreSQL) each implement row mapping, documents and ETags, accounts, sessions, lockouts, the archive, the
// calibration archive, record extracts and exports, Jira idempotency rows, evidence, backup, the hash-chained audit
// and transactions. Every check below runs unchanged against each store, so the two cannot drift apart unseen.
//
//   node tests/test_store_conformance.mjs              SQLite always; PostgreSQL too when FLIGHT_DATABASE_URL is set
//   node tests/test_store_conformance.mjs --postgres   PostgreSQL only, and FLIGHT_DATABASE_URL is required
//                                                      (npm run test:postgres, where CI provides PostgreSQL 16)
//
// PostgreSQL runs in a schema of its own, created for the run and dropped afterwards, so it starts empty and
// leaves the shared database as it found it.
//
// A divergence the suite finds is filed as an issue and listed in KNOWN_DIVERGENCES with that issue number. A
// listed check that fails on its store is reported as known; one that passes fails the run, so the entry is
// removed in the change that fixes it.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { openPostgres } from '../server/db-postgres.mjs';

const KNOWN_DIVERGENCES = [
  { backend: 'sqlite', check: 'export jobs: a retry of a job that is not failed is refused and changes nothing', issue: 596 },
  { backend: 'postgres', check: 'evidence: the metadata of a recording the store does not hold reads as null', issue: 597 },
];

const postgresOnly = process.argv.includes('--postgres');
const connectionString = process.env.FLIGHT_DATABASE_URL || '';
if (postgresOnly && !connectionString) throw new Error('FLIGHT_DATABASE_URL is required with --postgres.');

const results = [];
const etagFor = (json, revision) => `"${revision}-${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
const isoish = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// ---- the stores under test: each backend opens an empty store and offers raw SQL for the few checks that must
// plant a row the store API never writes (an order archived by an earlier release, a tampered audit row).
async function sqliteBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-conformance-sqlite-'));
  const store = openDb(path.join(dir, 'store.sqlite'));
  return {
    name: 'sqlite', store, dir,
    raw: async (sql, params = []) => { const stmt = store.db.prepare(sql.replace(/\$\d+/g, '?')); return /^\s*select/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []); },
    reopen: async () => openDb(path.join(dir, 'store.sqlite')),
    async close() { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

async function postgresBackend() {
  const { default: pg } = await import('pg');
  const schema = `flight_conformance_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Percent-encoded by hand: URLSearchParams writes the space as '+', which libpq (pg_dump) does not read as a space.
  const scoped = `${connectionString}${connectionString.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-conformance-pg-'));
  let store;
  try { store = await openPostgres(scoped, { maxConnections: 4 }); } catch (error) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error; }
  return {
    name: 'postgres', store, dir,
    raw: async (sql, params = []) => (await store._query(sql, params)).rows,
    reopen: async () => openPostgres(scoped, { maxConnections: 2 }),
    async close() {
      await store.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---- the contract ----
// Each entry is [name, store methods it exercises, async ({ store, raw, reopen, dir }) => assertions].
const CONTRACT = [
  ['documents: a missing workspace reads as null', ['getDoc'], async ({ store }) => {
    assert.equal(await store.getDoc('conformance-missing'), null);
  }],

  ['documents: putDoc writes revisions with content ETags and refuses a stale or second initialization', ['getDoc', 'putDoc'], async ({ store }) => {
    const t = 'conformance-doc';
    const first = await store.putDoc(t, '{"v":1}', null, 'alice');
    assert.equal(first, etagFor('{"v":1}', 1), 'the first write is revision 1 and its ETag is the revision and content hash');
    assert.equal(await store.putDoc(t, '{"v":9}', null, 'mallory'), null, 'a second initialization (expected ETag null) is refused');
    const doc = await store.getDoc(t);
    assert.deepEqual({ json: doc.json, etag: doc.etag, revision: doc.revision, updatedBy: doc.updatedBy }, { json: '{"v":1}', etag: first, revision: 1, updatedBy: 'alice' });
    assert.equal(typeof doc.revision, 'number', 'the revision is a number, not a string or bigint');
    assert.ok(isoish(doc.updatedAt));
    assert.equal(await store.putDoc(t, '{"v":2}', '"1-0000000000000000"', 'bob'), null, 'a stale ETag is refused');
    assert.equal((await store.getDoc(t)).json, '{"v":1}', 'a refused write changes nothing');
    const second = await store.putDoc(t, '{"v":2}', first, 'bob');
    assert.equal(second, etagFor('{"v":2}', 2));
    const third = await store.putDoc(t, '{"v":3}', undefined);
    assert.equal(third, etagFor('{"v":3}', 3), 'an undefined expected ETag writes unconditionally');
    const after = await store.getDoc(t);
    assert.equal(after.revision, 3);
    assert.equal(after.updatedBy, null, 'a write with no author stores null');
    assert.equal(await store.putDoc('conformance-doc-2', '{}', undefined, 'carol'), etagFor('{}', 1), 'a first write without an expected ETag creates revision 1');
  }],

  ['transactions: a result commits, false rolls back, a throw rolls back and rethrows', ['transaction', 'lockDoc', 'lockAuthority', 'putDoc', 'getDoc', 'audit', 'auditRows'], async ({ store }) => {
    const t = 'conformance-tx';
    const committed = await store.transaction(async tx => { await tx.lockDoc(t); await tx.lockAuthority(); await tx.putDoc(t, '{"tx":1}', null, 'alice'); await tx.audit('alice', 'conformance-commit', { t }); return 'done'; });
    assert.equal(committed, 'done', 'the callback result is returned');
    assert.equal((await store.getDoc(t)).json, '{"tx":1}');
    const auditBefore = (await store.auditRows(1000)).length;
    const declined = await store.transaction(async tx => { await tx.lockDoc(t); await tx.putDoc(t, '{"tx":2}', undefined, 'alice'); await tx.audit('alice', 'conformance-declined', {}); return false; });
    assert.equal(declined, false);
    assert.equal((await store.getDoc(t)).json, '{"tx":1}', 'returning false rolls the write back');
    assert.equal((await store.auditRows(1000)).length, auditBefore, 'returning false rolls the audit row back');
    await assert.rejects(store.transaction(async tx => { await tx.putDoc(t, '{"tx":3}', undefined, 'alice'); throw new Error('conformance boom'); }), /conformance boom/);
    assert.equal((await store.getDoc(t)).json, '{"tx":1}', 'a throw rolls the write back');
    assert.equal((await store.verifyAudit()).ok, true, 'the audit chain still verifies after rolled-back appends');
  }],

  ['accounts: upsert maps roles, the profile and sso the same way, and account() finds one or null', ['upsertAccount', 'accounts', 'account'], async ({ store }) => {
    await store.upsertAccount({ username: 'conf-a', displayName: 'Conf A', salt: 's1', hash: 'h1', role: 'quality', roles: ['quality', 'tech', 'quality'], createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'setup', sso: true, extraRoles: ['mrb'], roleTraining: { mrb: 'TR-1' }, grants: { aqi: { by: 'qa' } }, grantHistory: [{ at: 'x' }], supportAccess: true, ignored: 'not kept' });
    await store.upsertAccount({ username: 'conf-b', displayName: 'Conf B', salt: 's2', hash: 'h2', role: 'admin', roles: ['tech'], createdAt: '2026-01-02T00:00:00.000Z', grants: [], roleTraining: [], extraRoles: 'x' });
    const a = await store.account('conf-a');
    assert.deepEqual(a, { extraRoles: ['mrb'], roleTraining: { mrb: 'TR-1' }, grants: { aqi: { by: 'qa' } }, grantHistory: [{ at: 'x' }], supportAccess: true, username: 'conf-a', displayName: 'Conf A', salt: 's1', hash: 'h1', role: 'quality', roles: ['quality', 'tech'], createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'setup', sso: true });
    const b = await store.account('conf-b');
    assert.deepEqual({ role: b.role, roles: b.roles, sso: b.sso, createdBy: b.createdBy, grants: b.grants, roleTraining: b.roleTraining, extraRoles: b.extraRoles, grantHistory: b.grantHistory, supportAccess: b.supportAccess },
      { role: 'tech', roles: ['tech'], sso: false, createdBy: null, grants: {}, roleTraining: {}, extraRoles: [], grantHistory: [], supportAccess: false }, 'a role outside the list becomes the first listed role; malformed profile fields are reset');
    assert.equal(await store.account('conf-nobody'), null);
    await store.upsertAccount({ ...a, displayName: 'Conf A2', hash: 'h1b', roles: [], role: 'quality', createdAt: '2030-01-01T00:00:00.000Z' });
    const a2 = await store.account('conf-a');
    assert.deepEqual({ displayName: a2.displayName, hash: a2.hash, roles: a2.roles, createdAt: a2.createdAt }, { displayName: 'Conf A2', hash: 'h1b', roles: ['quality'], createdAt: '2026-01-01T00:00:00.000Z' }, 'an update keeps the creation time; an empty role list becomes the role');
    const names = (await store.accounts()).map(row => row.username).filter(name => name.startsWith('conf-'));
    assert.deepEqual(names, ['conf-a', 'conf-b'], 'accounts are listed in creation order');
  }],

  ['sessions: one per account, stored hashed, idle and absolute expiry, touch, close and close-others', ['openSession', 'session', 'closeSession', 'closeSessionsOf'], async ({ store, raw }) => {
    const t0 = Date.parse('2026-03-01T08:00:00.000Z');
    const first = await store.openSession('conf-sess', t0);
    assert.equal(first.issuedAt, new Date(t0).toISOString());
    assert.match(first.token, /^[A-Za-z0-9_-]{32}$/);
    const second = await store.openSession('conf-sess', t0 + 1000);
    assert.equal(await store.session(first.token, { at: t0 + 2000 }), null, 'opening a session ends the previous one');
    const stored = (await raw('SELECT token_sha256 FROM sessions WHERE username = $1', ['conf-sess'])).map(row => row.token_sha256);
    assert.deepEqual(stored, [tokenHash(second.token)], 'only the SHA-256 of the token is stored');
    const peek = await store.session(second.token, { touch: false, at: t0 + 5000 });
    assert.deepEqual(peek, { token: second.token, username: 'conf-sess', issuedAt: new Date(t0 + 1000).toISOString(), lastSeen: new Date(t0 + 1000).toISOString() });
    assert.equal((await store.session(second.token, { touch: false, at: t0 + 6000 })).lastSeen, new Date(t0 + 1000).toISOString(), 'touch: false is not activity');
    await store.session(second.token, { at: t0 + 7000 });
    assert.equal((await store.session(second.token, { touch: false, at: t0 + 7001 })).lastSeen, new Date(t0 + 7000).toISOString(), 'a touch moves last seen');
    assert.deepEqual(await store.session(second.token, { idleMs: 1000, at: t0 + 9000 }), { expired: 'idle', username: 'conf-sess' });
    assert.equal(await store.session(second.token, { at: t0 + 9001 }), null, 'an expired session is deleted');
    const third = await store.openSession('conf-sess', t0);
    assert.deepEqual(await store.session(third.token, { maxMs: 60000, idleMs: 1, at: t0 + 60000 }), { expired: 'absolute', username: 'conf-sess' }, 'absolute expiry is reported before idle');
    assert.equal(await store.session('', {}), null);
    assert.equal(await store.session(null), null);
    assert.equal(await store.session('not-a-token'), null);
    const keep = await store.openSession('conf-sess', t0);
    await raw('INSERT INTO sessions (token_sha256, username, issued_at, last_seen) VALUES ($1, $2, $3, $4)', [tokenHash('conf-other-device'), 'conf-sess', new Date(t0).toISOString(), new Date(t0).toISOString()]);
    assert.equal(Number(await store.closeSessionsOf('conf-sess', keep.token)), 1, 'closeSessionsOf reports how many it closed and keeps the excepted token');
    assert.equal((await store.session(keep.token, { touch: false, at: t0 })).username, 'conf-sess');
    assert.equal(Number(await store.closeSessionsOf('conf-sess')), 1, 'with no exception every session closes');
    const last = await store.openSession('conf-sess', t0);
    await store.closeSession(last.token);
    assert.equal(await store.session(last.token, { at: t0 }), null);
  }],

  ['lockouts: counting, the lock at the limit, listing active locks and clearing', ['lockout', 'noteFailedSignin', 'lockouts', 'clearLockout'], async ({ store }) => {
    assert.deepEqual(await store.lockout('conf-lock'), { username: 'conf-lock', fails: 0, until: 0, lastFailedAt: null });
    const until = Date.parse('2099-01-01T00:00:00.000Z');
    assert.deepEqual(await store.noteFailedSignin('conf-lock', 3, until), { fails: 1, until: 0, locked: false });
    assert.deepEqual(await store.noteFailedSignin('conf-lock', 3, until), { fails: 2, until: 0, locked: false });
    const row = await store.lockout('conf-lock');
    assert.equal(row.fails, 2); assert.equal(row.until, 0); assert.ok(isoish(row.lastFailedAt));
    assert.deepEqual(await store.noteFailedSignin('conf-lock', 3, until), { fails: 0, until, locked: true }, 'the limit locks and resets the count');
    assert.equal((await store.lockout('conf-lock')).until, until, 'the lock end is a number of milliseconds');
    assert.deepEqual(await store.noteFailedSignin('conf-lock-1', 1, until), { fails: 0, until, locked: true }, 'a limit of one locks on the first failure');
    const listed = (await store.lockouts(Date.parse('2098-01-01T00:00:00.000Z'))).filter(item => item.username.startsWith('conf-lock'));
    assert.deepEqual(listed.map(item => ({ username: item.username, until: item.until })).sort((x, y) => x.username.localeCompare(y.username)), [{ username: 'conf-lock', until: new Date(until).toISOString() }, { username: 'conf-lock-1', until: new Date(until).toISOString() }]);
    assert.ok(listed.every(item => isoish(item.lastFailedAt) && !('fails' in item)));
    assert.equal((await store.lockouts(until + 1)).filter(item => item.username.startsWith('conf-lock')).length, 0, 'an ended lock is not listed');
    assert.equal(await store.clearLockout('conf-lock'), true);
    assert.equal(await store.clearLockout('conf-lock'), false, 'clearing nothing reports false');
    assert.equal((await store.lockout('conf-lock')).fails, 0);
  }],

  ['archive: put, read, sha, count and exact search on order, serial, lot and part', ['putArchived', 'archived', 'archivedSha', 'archiveCount', 'archiveSearch'], async ({ store }) => {
    const before = Number(await store.archiveCount());
    const entry = { order: { id: 'WO-CONF-1', operations: [] }, schema: 3 };
    const json = JSON.stringify(entry);
    await store.putArchived({ id: 'WO-CONF-1', json, sha256: 'a'.repeat(64), schema: 3, keys: { partNumber: 'PN-CONF', serials: ['SN-Conf-1'], lots: ['LOT-C'], parts: ['PN-CONF', 'PN-SUB'], title: 'Conformance order', closedAt: '2026-02-01T00:00:00.000Z' }, by: 'qa' });
    await tick();
    await store.putArchived({ id: 'WO-CONF-2', json: '{"order":{"id":"WO-CONF-2"}}', sha256: 'b'.repeat(64), schema: 3, keys: { serials: [], lots: [], parts: [] } });
    assert.equal(Number(await store.archiveCount()), before + 2);
    const got = await store.archived('WO-CONF-1');
    assert.deepEqual({ ...got, archivedAt: undefined }, { id: 'WO-CONF-1', entry, sha256: 'a'.repeat(64), schema: 3, archivedAt: undefined, archivedBy: 'qa' });
    assert.equal(typeof got.schema, 'number'); assert.ok(isoish(got.archivedAt));
    assert.equal((await store.archived('WO-CONF-2')).archivedBy, null);
    assert.equal(await store.archived('WO-CONF-NONE'), null);
    assert.equal(await store.archivedSha('WO-CONF-1'), 'a'.repeat(64));
    assert.equal(await store.archivedSha('WO-CONF-NONE'), null);
    await assert.rejects(Promise.resolve().then(() => store.putArchived({ id: 'WO-CONF-1', json, sha256: 'c'.repeat(64), schema: 3, keys: { serials: [], lots: [], parts: [] } })), 'an archived order cannot be written twice');
    assert.equal(await store.archivedSha('WO-CONF-1'), 'a'.repeat(64), 'the refused second write changed nothing');
    const row = { orderId: 'WO-CONF-1', partNumber: 'PN-CONF', serials: ['SN-Conf-1'], lots: ['LOT-C'], parts: ['PN-CONF', 'PN-SUB'], title: 'Conformance order', closedAt: '2026-02-01T00:00:00.000Z', status: 'Closed', source: 'archive' };
    for (const term of ['wo-conf-1', ' SN-CONF-1 ', 'lot-c', 'pn-sub']) {
      const found = (await store.archiveSearch(term)).map(item => ({ ...item, archivedAt: undefined }));
      assert.deepEqual(found, [{ ...row, archivedAt: undefined }], `search for ${JSON.stringify(term)} finds the order`);
    }
    assert.deepEqual(await store.archiveSearch('SN-CONF'), [], 'search is exact, not a prefix');
    const empty = await store.archiveSearch('WO-CONF-2');
    assert.deepEqual({ ...empty[0], archivedAt: undefined }, { orderId: 'WO-CONF-2', partNumber: null, serials: [], lots: [], parts: [], title: null, closedAt: null, archivedAt: undefined, status: 'Closed', source: 'archive' });
    assert.deepEqual((await store.archiveSearch('', 1)).map(item => item.orderId), ['WO-CONF-2'], 'an empty query lists newest first, up to the limit');
  }],

  ['archive evidence: only evidence and quarantinedEvidence ids and copyOf name a recording; an older release row is indexed on a miss', ['putArchived', 'archiveNamesEvidence'], async ({ store, raw }) => {
    const order = { id: 'WO-CONF-EV', note: 'EV-CONF-NOTE', operations: [{ evidence: [{ id: 'EV-CONF-1' }, { id: 'EV-CONF-2', copyOf: 'EV-CONF-ORIG' }], quarantinedEvidence: [{ id: 'EV-CONF-Q' }], title: 'EV-CONF-TITLE' }] };
    await store.putArchived({ id: 'WO-CONF-EV', json: JSON.stringify({ order }), sha256: 'd'.repeat(64), schema: 3, keys: { serials: [], lots: [], parts: [] } });
    for (const id of ['EV-CONF-1', 'EV-CONF-2', 'EV-CONF-ORIG', 'EV-CONF-Q']) assert.equal(await store.archiveNamesEvidence(id), true, `${id} is named`);
    for (const id of ['EV-CONF-NOTE', 'EV-CONF-TITLE', 'EV-CONF-NONE', 'ev-conf-1']) assert.equal(await store.archiveNamesEvidence(id), false, `${id} is not named`);
    const legacy = { id: 'WO-CONF-OLD', operations: [{ evidence: [{ id: 'EV-CONF-OLD' }] }] };
    await raw('INSERT INTO archive (order_id, json, sha256, schema, serials, lots, parts, archived_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', ['WO-CONF-OLD', JSON.stringify({ order: legacy }), 'e'.repeat(64), 3, '[]', '[]', '[]', new Date().toISOString()]);
    assert.equal(await store.archiveNamesEvidence('EV-CONF-OLD'), true, 'an order archived without its references is indexed when a lookup misses');
    assert.equal((await raw('SELECT order_id FROM archive_evidence_indexed WHERE order_id = $1', ['WO-CONF-OLD'])).length, 1);
  }],

  ['calibration archive: put, read, paged rows and the per-tool list', ['putCalibrationArchived', 'calibrationArchived', 'calibrationArchiveRows', 'calibrationArchiveList'], async ({ store }) => {
    const entry = n => ({ id: `CAL-CONF-${n}`, status: 'In Calibration', calibratedAt: `2026-01-0${n}`, expires: `2027-01-0${n}`, recordedAt: `2026-01-0${n}T00:00:00Z`, recordedBy: 'qa', extra: { n } });
    for (const [n, tag] of [[1, 'TQ-CONF'], [2, 'TQ-CONF'], [3, 'TQ-OTHER']]) await store.putCalibrationArchived({ id: `CAL-CONF-${n}`, tag, recordId: `REC-${n}`, json: JSON.stringify(entry(n)), sha256: String(n).repeat(64), by: n === 3 ? undefined : 'qa' });
    const one = await store.calibrationArchived('CAL-CONF-1');
    assert.deepEqual({ ...one, archivedAt: undefined }, { id: 'CAL-CONF-1', tag: 'TQ-CONF', recordId: 'REC-1', entry: entry(1), sha256: '1'.repeat(64), archivedAt: undefined, archivedBy: 'qa' });
    assert.ok(isoish(one.archivedAt));
    assert.equal((await store.calibrationArchived('CAL-CONF-3')).archivedBy, null);
    assert.equal(await store.calibrationArchived('CAL-CONF-NONE'), null);
    assert.deepEqual(await store.calibrationArchiveRows('CAL-CONF-0', 2), [{ id: 'CAL-CONF-1', tag: 'TQ-CONF', recordId: 'REC-1', entry: entry(1), sha256: '1'.repeat(64) }, { id: 'CAL-CONF-2', tag: 'TQ-CONF', recordId: 'REC-2', entry: entry(2), sha256: '2'.repeat(64) }], 'rows page in entry id order after the cursor');
    assert.deepEqual((await store.calibrationArchiveRows('CAL-CONF-2', 10)).filter(row => row.id.startsWith('CAL-CONF')).map(row => row.id), ['CAL-CONF-3']);
    const listed = await store.calibrationArchiveList(' tq-conf ', 10);
    assert.deepEqual(listed.map(row => ({ ...row, archivedAt: undefined })), [1, 2].map(n => ({ id: `CAL-CONF-${n}`, tag: 'TQ-CONF', recordId: `REC-${n}`, status: 'In Calibration', calibratedAt: entry(n).calibratedAt, expires: entry(n).expires, recordedAt: entry(n).recordedAt, recordedBy: 'qa', archivedAt: undefined })), 'the tag is trimmed and upper-cased');
    assert.deepEqual((await store.calibrationArchiveList('TQ-CONF', 10, 'CAL-CONF-1')).map(row => row.id), ['CAL-CONF-2'], 'the list pages after a cursor');
    assert.equal((await store.calibrationArchiveList('', 2)).length, 2, 'no tag lists every tool up to the limit');
    await assert.rejects(Promise.resolve().then(() => store.putCalibrationArchived({ id: 'CAL-CONF-1', tag: 'TQ-CONF', recordId: 'REC-1', json: '{}', sha256: 'f'.repeat(64) })), 'an archived entry cannot be written twice');
  }],

  ['record extracts: append-only history in sequence order with the summary parsed', ['recordExtract', 'extractHistory'], async ({ store }) => {
    const base = { recordType: 'NC', recordId: 'NC-CONF-1', kind: 'print', exportedBy: 'qa', sha256: '9'.repeat(64) };
    const one = await store.recordExtract({ ...base, exportId: 'EXP-CONF-1', exportedAt: '2026-04-01T00:00:00.000Z', summary: { pages: 2 } });
    assert.deepEqual({ ...one, sequence: undefined }, { ...base, exportId: 'EXP-CONF-1', sequence: undefined, exportedAt: '2026-04-01T00:00:00.000Z', summary: { pages: 2 } });
    assert.equal(typeof one.sequence, 'number');
    const two = await store.recordExtract({ ...base, exportId: 'EXP-CONF-2', kind: 'download' });
    assert.ok(isoish(two.exportedAt)); assert.deepEqual(two.summary, {}, 'no summary stores an empty object');
    assert.ok(two.sequence > one.sequence, 'the sequence increases');
    await store.recordExtract({ ...base, recordId: 'NC-CONF-2', exportId: 'EXP-CONF-3' });
    assert.deepEqual((await store.extractHistory('NC', 'NC-CONF-1')).map(row => row.exportId), ['EXP-CONF-1', 'EXP-CONF-2']);
    assert.deepEqual(await store.extractHistory('NC', 'NC-CONF-NONE'), []);
    await assert.rejects(Promise.resolve().then(() => store.recordExtract({ ...base, exportId: 'EXP-CONF-1' })), 'an export id is recorded once');
  }],

  ['export settings: put returns the saved setting, enabled is a boolean, and the list is ordered', ['putExportSetting', 'exportSetting', 'exportSettings'], async ({ store }) => {
    const saved = await store.putExportSetting({ recordType: 'SCAR', enabled: true, destinationKind: 'folder', destination: '/exports/scar', tokenSetting: '', namingPattern: '{id}', updatedBy: 'qa', rationale: 'conformance' });
    assert.deepEqual({ ...saved, updatedAt: undefined }, { recordType: 'SCAR', enabled: true, destinationKind: 'folder', destination: '/exports/scar', tokenSetting: null, namingPattern: '{id}', updatedAt: undefined, updatedBy: 'qa', rationale: 'conformance' });
    assert.ok(isoish(saved.updatedAt));
    await store.putExportSetting({ recordType: 'CAR', enabled: false, destinationKind: 'https', destination: 'https://example.invalid', tokenSetting: 'FLIGHT_TOKEN', namingPattern: '{id}.json', updatedBy: 'qa', rationale: 'second' });
    const updated = await store.putExportSetting({ recordType: 'SCAR', enabled: false, destinationKind: 'folder', destination: '/exports/scar2', namingPattern: '{id}', updatedBy: 'qa2', rationale: 'change' });
    assert.deepEqual({ enabled: updated.enabled, destination: updated.destination, updatedBy: updated.updatedBy }, { enabled: false, destination: '/exports/scar2', updatedBy: 'qa2' });
    assert.deepEqual((await store.exportSettings()).map(row => [row.recordType, row.enabled, row.tokenSetting]), [['CAR', false, 'FLIGHT_TOKEN'], ['SCAR', false, null]]);
    assert.equal(await store.exportSetting('ECR'), null);
  }],

  ['export jobs: one job per record version, delivery attempts logged, pending count', ['queueExportJob', 'exportJob', 'pendingExportJobs', 'exportJobs', 'updateExportJob', 'exportLog', 'pendingExportCount'], async ({ store }) => {
    const job = n => ({ id: `JOB-C0${n}`, recordType: 'SCAR', recordId: `SCAR-CONF-${n}`, exportId: `EXP-JOB-${n}`, sha256: String(n).repeat(64), payload: `{"n":${n}}`, destinationKind: 'folder', destination: '/exports', tokenSetting: '', namingPattern: '{id}', createdBy: 'qa' });
    const queued = await store.queueExportJob(job(1));
    assert.deepEqual({ ...queued, createdAt: undefined, updatedAt: undefined }, { id: 'JOB-C01', recordType: 'SCAR', recordId: 'SCAR-CONF-1', exportId: 'EXP-JOB-1', sha256: '1'.repeat(64), payload: '{"n":1}', status: 'pending', attempts: 0, destinationKind: 'folder', destination: '/exports', tokenSetting: null, namingPattern: '{id}', createdAt: undefined, createdBy: 'qa', updatedAt: undefined, lastError: null });
    assert.equal(await store.queueExportJob({ ...job(1), id: 'JOB-C0D', exportId: 'EXP-JOB-D' }), null, 'the same record version is queued once');
    assert.equal(await store.exportJob('JOB-C0D'), null);
    await tick();
    assert.notEqual(await store.queueExportJob({ ...job(1), id: 'JOB-C0E', exportId: 'EXP-JOB-E', sha256: 'e'.repeat(64) }), null, 'a new version of the record is queued again');
    await tick();
    await store.queueExportJob(job(2));
    assert.equal(await store.exportJob('JOB-NONE'), null);
    assert.deepEqual((await store.pendingExportJobs(10)).map(row => row.id).filter(id => id.startsWith('JOB-C0')), ['JOB-C01', 'JOB-C0E', 'JOB-C02'], 'pending jobs list oldest first');
    assert.deepEqual((await store.exportJobs(10)).map(row => row.id).filter(id => id.startsWith('JOB-C0')), ['JOB-C02', 'JOB-C0E', 'JOB-C01'], 'all jobs list newest first');
    const failed = await store.updateExportJob('JOB-C01', { status: 'failed', detail: 'HTTP 503' });
    assert.deepEqual({ status: failed.status, attempts: failed.attempts, lastError: failed.lastError }, { status: 'failed', attempts: 1, lastError: 'HTTP 503' });
    const delivered = await store.updateExportJob('JOB-C02', { status: 'delivered' });
    assert.deepEqual({ status: delivered.status, attempts: delivered.attempts, lastError: delivered.lastError }, { status: 'delivered', attempts: 1, lastError: null });
    assert.equal(await store.updateExportJob('JOB-NONE', { status: 'failed' }), null);
    const log = await store.exportLog('JOB-C01', 10);
    assert.deepEqual(log.map(row => ({ job_id: row.job_id, attempt: row.attempt, status: row.status, detail: row.detail })), [{ job_id: 'JOB-C01', attempt: 1, status: 'failed', detail: 'HTTP 503' }]);
    assert.ok(isoish(log[0].at));
    assert.deepEqual(Object.keys(log[0]).sort(), ['at', 'attempt', 'detail', 'job_id', 'status'], 'a log row has the same columns in both stores');
    assert.equal(Number(await store.pendingExportCount()), 2, 'pending and failed jobs count; delivered do not');
  }],

  ['export jobs: a manual retry queues a failed job again and logs it', ['retryExportJob', 'exportLog'], async ({ store }) => {
    await store.queueExportJob({ id: 'JOB-C0R', recordType: 'SCAR', recordId: 'SCAR-CONF-R', exportId: 'EXP-JOB-R', sha256: 'f'.repeat(64), payload: '{}', destinationKind: 'folder', destination: '/x', namingPattern: '{id}', createdBy: 'qa' });
    await store.updateExportJob('JOB-C0R', { status: 'failed', detail: 'down' });
    const retried = await store.retryExportJob('JOB-C0R', 'qa-manager');
    assert.deepEqual({ status: retried.status, attempts: retried.attempts, lastError: retried.lastError }, { status: 'pending', attempts: 0, lastError: null });
    const latest = (await store.exportLog('JOB-C0R', 1))[0];
    assert.deepEqual({ attempt: latest.attempt, status: latest.status, detail: latest.detail }, { attempt: 0, status: 'queued', detail: 'Manual retry requested by qa-manager.' });
    assert.equal(await store.retryExportJob('JOB-NONE', 'qa-manager'), null);
  }],

  // The server reads the job, checks it failed, then awaits the retry; the store re-checks so a job delivered (or
  // already re-queued) in between is not sent again. The server answers a null with "This export changed before
  // the retry could be queued."
  ['export jobs: a retry of a job that is not failed is refused and changes nothing', ['retryExportJob', 'exportJob', 'exportLog'], async ({ store }) => {
    await store.queueExportJob({ id: 'JOB-C0S', recordType: 'SCAR', recordId: 'SCAR-CONF-S', exportId: 'EXP-JOB-S', sha256: 'a'.repeat(64), payload: '{}', destinationKind: 'folder', destination: '/x', namingPattern: '{id}', createdBy: 'qa' });
    const delivered = await store.updateExportJob('JOB-C0S', { status: 'delivered' });
    const logBefore = await store.exportLog('JOB-C0S', 10);
    assert.equal(await store.retryExportJob('JOB-C0S', 'qa-manager'), null, 'a delivered job is not queued again');
    assert.deepEqual(await store.exportJob('JOB-C0S'), delivered, 'the job is unchanged');
    assert.deepEqual(await store.exportLog('JOB-C0S', 10), logBefore, 'nothing is logged');
  }],

  ['jira requests: one claim per idempotency key, release only while pending, complete once', ['beginJiraIssueRequest', 'jiraIssueRequest', 'releaseJiraIssueRequest', 'completeJiraIssueRequest'], async ({ store }) => {
    const row = { idempotencyKey: 'conf-jira-1', requestSha256: '7'.repeat(64), recordType: 'ECR', recordId: 'ECR-CONF', projectKey: 'ECR', createdBy: 'eng' };
    assert.equal(await store.jiraIssueRequest('conf-jira-none'), null);
    const claim = await store.beginJiraIssueRequest(row);
    assert.equal(claim.inserted, true);
    const pick = r => ({ idempotency_key: r.idempotency_key, request_sha256: r.request_sha256, record_type: r.record_type, record_id: r.record_id, project_key: r.project_key, status: r.status, issue_key: r.issue_key, issue_url: r.issue_url, created_by: r.created_by });
    assert.deepEqual(pick(claim.request), { idempotency_key: 'conf-jira-1', request_sha256: '7'.repeat(64), record_type: 'ECR', record_id: 'ECR-CONF', project_key: 'ECR', status: 'pending', issue_key: null, issue_url: null, created_by: 'eng' });
    assert.deepEqual(Object.keys(claim.request).sort(), ['created_at', 'created_by', 'idempotency_key', 'issue_key', 'issue_url', 'project_key', 'record_id', 'record_type', 'request_sha256', 'status', 'updated_at'], 'the row has the same columns in both stores');
    const again = await store.beginJiraIssueRequest({ ...row, createdBy: 'other' });
    assert.equal(again.inserted, false); assert.equal(again.request.created_by, 'eng');
    assert.equal(await store.releaseJiraIssueRequest('conf-jira-1'), true, 'a pending claim can be released');
    assert.equal(await store.jiraIssueRequest('conf-jira-1'), null);
    assert.equal((await store.beginJiraIssueRequest(row)).inserted, true, 'a released key can be claimed again');
    const done = await store.completeJiraIssueRequest('conf-jira-1', { key: 'ECR-1', url: 'https://example.invalid/ECR-1' });
    assert.deepEqual({ status: done.status, issue_key: done.issue_key, issue_url: done.issue_url }, { status: 'created', issue_key: 'ECR-1', issue_url: 'https://example.invalid/ECR-1' });
    assert.equal(await store.completeJiraIssueRequest('conf-jira-1', { key: 'ECR-2', url: 'x' }), null, 'a created request is completed once');
    assert.equal(await store.releaseJiraIssueRequest('conf-jira-1'), false, 'a created request is never released');
    assert.equal((await store.jiraIssueRequest('conf-jira-1')).issue_key, 'ECR-1');
  }],

  ['evidence: bytes round-trip, metadata maps the same way, superseding happens once', ['putEvidence', 'evidenceMeta', 'evidenceBytes', 'evidenceList', 'supersedeEvidence'], async ({ store }) => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const meta = await store.putEvidence({ id: 'EV-CONF-B1', sha256: sha, size: bytes.length, mime: 'application/octet-stream', fileName: 'scan.bin', uploadedBy: 'tech', bytes });
    assert.deepEqual({ ...meta, uploadedAt: undefined }, { id: 'EV-CONF-B1', sha256: sha, size: 7, mime: 'application/octet-stream', fileName: 'scan.bin', uploadedBy: 'tech', uploadedAt: undefined, supersededBy: null, supersededAt: null, supersededReason: null });
    assert.equal(typeof meta.size, 'number'); assert.ok(isoish(meta.uploadedAt));
    const back = await store.evidenceBytes('EV-CONF-B1');
    assert.ok(Buffer.isBuffer(back)); assert.deepEqual([...back], [...bytes]);
    assert.equal(await store.evidenceBytes('EV-CONF-NONE'), null);
    await store.putEvidence({ id: 'EV-CONF-B2', sha256: '0'.repeat(64), size: 0, mime: 'text/plain', uploadedBy: 'tech', bytes: Buffer.alloc(0) });
    assert.equal((await store.evidenceMeta('EV-CONF-B2')).fileName, null);
    assert.deepEqual([...(await store.evidenceBytes('EV-CONF-B2'))], [], 'an empty recording reads back empty, not null');
    assert.deepEqual((await store.evidenceList()).map(row => row.id).filter(id => id.startsWith('EV-CONF-B')).sort(), ['EV-CONF-B1', 'EV-CONF-B2']);
    const sup = await store.supersedeEvidence('EV-CONF-B1', 'EV-CONF-B2', 'rescan');
    assert.deepEqual({ supersededBy: sup.supersededBy, supersededReason: sup.supersededReason }, { supersededBy: 'EV-CONF-B2', supersededReason: 'rescan' });
    assert.ok(isoish(sup.supersededAt));
    assert.equal(await store.supersedeEvidence('EV-CONF-B1', 'EV-CONF-X', 'again'), null, 'a superseded recording is superseded once');
    assert.equal(await store.supersedeEvidence('EV-CONF-NONE', 'EV-CONF-X', 'x'), null);
    await assert.rejects(Promise.resolve().then(() => store.putEvidence({ id: 'EV-CONF-B1', sha256: '1'.repeat(64), size: 1, mime: 'text/plain', uploadedBy: 'tech', bytes: Buffer.from('x') })), 'evidence is never rewritten');
    assert.equal((await store.evidenceMeta('EV-CONF-B1')).sha256, sha, 'the refused rewrite changed nothing');
  }],

  ['evidence: the metadata of a recording the store does not hold reads as null', ['evidenceMeta'], async ({ store }) => {
    assert.equal(await store.evidenceMeta('EV-CONF-NONE'), null);
  }],

  ['audit: an append-only hash chain, newest first, that verifies and refuses to reopen once tampered', ['audit', 'auditRows', 'verifyAudit', 'close'], async ({ store, raw, reopen }) => {
    const start = await store.verifyAudit();
    assert.equal(start.ok, true);
    const a = await store.audit('alice', 'conformance-one', { x: 1 });
    const b = await store.audit(null, 'conformance-two');
    const c = await store.audit('carol', 'conformance-three', { long: 'x'.repeat(5000) });
    assert.equal(b.id, a.id + 1); assert.equal(c.id, b.id + 1);
    assert.equal(typeof a.id, 'number');
    assert.equal(b.prevHash, a.hash); assert.equal(b.prev_hash, a.hash);
    assert.equal(b.username, null); assert.equal(b.detail, null);
    assert.equal(c.detail.length, 4000, 'the detail is cut at 4000 characters');
    const expected = createHash('sha256').update(JSON.stringify({ id: b.id, at: b.at, username: b.username, action: b.action, detail: b.detail, prevHash: b.prevHash })).digest('hex');
    assert.equal(b.hash, expected, 'both stores hash the same fields the same way');
    const rows = await store.auditRows(3);
    assert.deepEqual(rows.map(row => row.id), [c.id, b.id, a.id], 'rows list newest first');
    assert.deepEqual({ ...rows[1] }, { id: b.id, at: b.at, username: null, action: 'conformance-two', detail: null, prevHash: a.hash, hash: b.hash });
    assert.deepEqual(await store.verifyAudit(), { ok: true, checked: start.checked + 3, head: c.hash });
    await raw('UPDATE audit SET action = $1 WHERE id = $2', ['tampered', b.id]);
    assert.deepEqual(await store.verifyAudit(), { ok: false, checked: start.checked + 1, failedAt: b.id }, 'a changed row is named');
    await assert.rejects(Promise.resolve().then(() => reopen()), /audit chain is invalid at entry/, 'a store does not open on a tampered chain');
    await raw('UPDATE audit SET action = $1 WHERE id = $2', ['conformance-two', b.id]);
    const reopened = await reopen();
    await reopened.close();
    assert.equal((await store.verifyAudit()).ok, true);
  }],

  ['backup: writes a backup file of the whole store', ['backup'], async ({ store, dir }) => {
    const file = path.join(dir, 'backup.bin');
    await store.backup(file);
    assert.ok(fs.statSync(file).size > 0);
  }],
];

// Every store method the server calls must be in the contract. Methods the server never calls (deleteAccount,
// setLockout, skillRun) are left out on purpose.
const serverSource = fs.readFileSync(new URL('../server/server.mjs', import.meta.url), 'utf8');
const serverCalls = new Set([...serverSource.matchAll(/(?<![\w.])(?:store|tx)\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
const covered = new Set(CONTRACT.flatMap(([, methods]) => methods));

async function runBackend(open) {
  let backend;
  try { backend = await open(); } catch (error) { results.push({ backend: open.name, check: 'open the store', ok: false, error: error.message }); return; }
  try {
    for (const [name, methods, fn] of CONTRACT) {
      const missing = methods.filter(method => typeof backend.store[method] !== 'function');
      try {
        assert.deepEqual(missing, [], `the store has ${missing.join(', ')}`);
        await fn({ store: backend.store, raw: backend.raw, reopen: backend.reopen, dir: backend.dir });
        results.push({ backend: backend.name, check: name, ok: true });
      } catch (error) { results.push({ backend: backend.name, check: name, ok: false, error: error.message.split('\n')[0] }); }
    }
  } finally { await backend.close(); }
}

const backends = postgresOnly ? [postgresBackend] : connectionString ? [sqliteBackend, postgresBackend] : [sqliteBackend];
for (const open of backends) await runBackend(open);

const FAILS = [];
const uncovered = [...serverCalls].filter(name => !covered.has(name)).sort();
if (uncovered.length) FAILS.push(`store methods the server calls with no conformance check: ${uncovered.join(', ')}`);
const ran = new Set(results.map(r => r.backend));
for (const listed of KNOWN_DIVERGENCES) {
  if (!ran.has(listed.backend)) continue;
  if (!Number.isInteger(listed.issue) || listed.issue <= 0) FAILS.push(`known divergence "${listed.check}" on ${listed.backend} names no issue`);
  if (!results.some(r => r.backend === listed.backend && r.check === listed.check)) FAILS.push(`known divergence "${listed.check}" on ${listed.backend} names no check in the contract`);
}
let pass = 0, known = 0;
for (const r of results) {
  const listed = KNOWN_DIVERGENCES.find(k => k.backend === r.backend && k.check === r.check);
  if (listed && !r.ok) { known += 1; console.log(`  known  ${r.backend.padEnd(8)} ${r.check} (#${listed.issue}): ${r.error}`); continue; }
  if (listed && r.ok) { FAILS.push(`${r.backend}: "${r.check}" now passes; the divergence in #${listed.issue} is gone, so remove it from KNOWN_DIVERGENCES`); console.log(`  FAIL   ${r.backend.padEnd(8)} ${r.check}: passes but is listed as known (#${listed.issue})`); continue; }
  if (r.ok) { pass += 1; console.log(`  ok     ${r.backend.padEnd(8)} ${r.check}`); }
  else { FAILS.push(`${r.backend}: ${r.check}: ${r.error}`); console.log(`  FAIL   ${r.backend.padEnd(8)} ${r.check}: ${r.error}`); }
}
console.log(`\nstores: ${[...ran].join(', ')}${ran.has('postgres') ? '' : ' (PostgreSQL runs in npm run test:postgres, where FLIGHT_DATABASE_URL is set)'}`);
console.log(`server store methods covered: ${[...serverCalls].filter(name => covered.has(name)).length} of ${serverCalls.size}`);
console.log(`known divergences: ${known}`);
console.log(`checks ${results.length} pass ${pass + known} fail ${results.length - pass - known}`);
console.log(`FAILS ${JSON.stringify(FAILS)}`);
if (FAILS.length) process.exitCode = 1;
