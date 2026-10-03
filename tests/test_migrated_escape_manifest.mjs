// Issues #302 and #305: a pre-ticket-restructure workspace with closed escape records. Migration turns each into a
// Resolved stock NC whose resolution is the old unsigned closure, marked by a structured record only the migration
// writes (resolution.legacy). Every later server write must still commit, an NC migrated before the record existed gets
// it once from the stored copy, and nothing else can claim the exemption: not a history entry, and not the record itself.
// Reproduction from Jinx's review of #238; the refusal paths are added for the structured record.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createServer, legacyEscapeImportAudits, LEGACY_IMPORT_AUDIT_CHARS } from '../server/server.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${name}`); };
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const SETUP_CODE = 'migrated-escape-setup-code';
const makeServer = () => createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const caller = server => { const handler = server.listeners('request')[0]; return async (method, url, { token, body, headers = {} } = {}) => {
  const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  incoming.method = method; incoming.url = `/api${url}`;
  incoming.headers = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status, values = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)])); return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  handler(incoming, outgoing); await finished;
  const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: outgoing.statusCode, json, etag: outgoing.responseHeaders?.etag || null };
}; };
const signIn = async api => {
  const created = await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'admin', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'escape-pass-123') }] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const session = await api('POST', '/auth/session', { body: { username: 'admin', password: 'escape-pass-123' } });
  assert.equal(session.status, 200, JSON.stringify(session.json));
  return session.json.token;
};

// The curated fixture with its maneuver records put back into the pre-restructure form: no __ticketsV2 marker and
// two escape records closed before the ticket restructure, one with its closure record and one without.
const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(fixture, 'the curated fixture has a workspace');
const QE = { name: 'Demo User', role: 'Quality Manager', credentialId: 'ACCT-demo', account: 'demo' };
const escape = (id, closure) => ({ id, title: `Escape ${id}`, partNumber: 'SR-AV-140', serials: ['AV-140-00003'], escapedFrom: 'Final inspection', detectedAt: 'Customer', description: 'Defect passed the control point and was found downstream.', detectedOn: '2026-09-09', status: 'Closed', link: null, containment: null, carId: null, closure, raisedBy: QE, raisedAt: '2026-09-18T02:42:31.939Z', history: [{ at: '2026-09-18T02:42:31.939Z', action: 'Recorded: escaped Final inspection.', actor: 'Demo User · ACCT-demo' }] });
const escapeIds = ['ESC-110', 'ESC-111'];
const legacy = () => {
  const s = JSON.parse(fixture[1]);
  delete s.maneuver.__ticketsV2;
  s.maneuver.escapes = [escape('ESC-110', { note: 'Bench units re-flashed and retested; customer accepted.', by: QE, at: '2026-09-20T10:00:00.000Z' }), escape('ESC-111', null)];
  return s;
};
const migratedNcs = s => s.maneuver.ncs.filter(t => t.resolution && t.resolution.legacy && escapeIds.includes(t.resolution.legacy.escapeId));

const servers = [];
// A server initialized with the given workspace, signed in. Returns the caller, token and current ETag.
const started = async doc => {
  const server = makeServer(); servers.push(server); await server.ready;
  const api = caller(server); const token = await signIn(api);
  const init = await api('PUT', '/workspace', { token, body: structuredClone(doc) });
  assert.equal(init.status, 204, JSON.stringify(init.json));
  return { server, api, token, etag: init.etag };
};
// Runs an engine change as a server action (through MES.addSavedView, a reviewed command), so the write goes through
// the same validation, verification and stored-copy gates as any other action.
const viaAction = async ({ server, api, token, etag }, change) => {
  const original = server.host.MES.addSavedView;
  server.host.MES.addSavedView = ws => { change(ws); return { ok: true, message: 'test change' }; };
  try { return await api('POST', '/workspace/actions/MES.addSavedView', { token, body: { args: [] }, headers: { 'If-Match': etag } }); } finally { server.host.MES.addSavedView = original; }
};

try {
  const raw = legacy();
  const probe = makeServer(); servers.push(probe); await probe.ready;
  const { MES, FlightManeuver } = probe.host;
  const migrated = () => { const s = MES.upgrade(structuredClone(raw)); assert.ok(s, 'the legacy workspace upgrades'); FlightManeuver.ensure(s); return s; };

  await check('#302 the migration turns both closed escapes into Resolved stock NCs that carry the migrated-escape record and pass validation and verification', async () => {
    const s = migrated(), ncs = migratedNcs(s);
    assert.equal(ncs.length, 2);
    assert.ok(ncs.every(t => t.status === 'Resolved' && !Object.hasOwn(t.resolution, 'manifest') && t.resolution.legacy.source === 'escape' && t.history.some(h => h.actor === 'system' && h.at === t.resolution.legacy.migratedAt)), JSON.stringify(ncs.map(t => t.resolution)));
    assert.equal(MES.validate(s), true, JSON.stringify(MES.diagnose(s)));
    const v = MES.verifyManifests(s);
    assert.equal(v.ok, true, JSON.stringify(v.failures.slice(0, 3)));
  });

  await check('#302 a server initialized from the legacy workspace accepts an ordinary write afterwards', async () => {
    const live = await started(raw);
    const stored = JSON.parse(live.server.store.getDoc('default').json);
    assert.equal(migratedNcs(stored).length, 2, 'the stored workspace holds the migrated NCs with their record');
    const order = stored.orders.find(o => o.status !== 'Closed');
    const result = await live.api('POST', '/workspace/actions/MES.setPriority', { token: live.token, body: { args: [order.id, 'AOG'] }, headers: { 'If-Match': live.etag } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
  });

  // A workspace migrated by an earlier build: the stored NCs with no migrated-escape record. The stored copy is the anchor.
  const premarker = stored => { const s = structuredClone(stored); migratedNcs(s).forEach(t => { delete t.resolution.legacy; }); return s; };

  await check('#302 an NC migrated before the record existed gets it once from the stored copy, and later writes commit', async () => {
    const live = await started(raw);
    const old = premarker(JSON.parse(live.server.store.getDoc('default').json));
    assert.equal(migratedNcs(old).length, 0);
    live.etag = live.server.store.putDoc('default', JSON.stringify(old), undefined, 'test');
    assert.ok(live.etag, 'the stored copy is replaced with the earlier migration');
    const order = old.orders.find(o => o.status !== 'Closed');
    const first = await live.api('POST', '/workspace/actions/MES.setPriority', { token: live.token, body: { args: [order.id, 'AOG'] }, headers: { 'If-Match': live.etag } });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const stored = JSON.parse(live.server.store.getDoc('default').json);
    assert.equal(migratedNcs(stored).length, 2, 'the backfilled record is stored');
    assert.ok(migratedNcs(stored).every(t => t.history.some(h => h.actor === 'system' && h.at === t.resolution.legacy.migratedAt && h.action === `Migrated from escape ${t.resolution.legacy.escapeId}.`)), 'the backfill names the escape and time of the migration entry');
    const second = await live.api('POST', '/workspace/actions/MES.setPriority', { token: live.token, body: { args: [order.id, 'Normal'] }, headers: { 'If-Match': first.json.etag } });
    assert.equal(second.status, 200, JSON.stringify(second.json));
  });

  await check('#302 MES.upgrade alone backfills an NC migrated before the record existed, so every load path validates it', async () => {
    const live = await started(raw);
    const old = premarker(JSON.parse(live.server.store.getDoc('default').json));
    const up = MES.upgrade(structuredClone(old));
    assert.ok(up, 'the earlier migration upgrades');
    assert.equal(migratedNcs(up).length, 2, 'upgrade wrote the migrated-escape record');
    assert.equal(MES.validate(up), true, JSON.stringify(MES.diagnose(up)));
    assert.equal(MES.verifyManifests(up).ok, true);
  });

  // A signed, resolved stock NC from the curated set: the target of each forgery below.
  const signedNc = s => s.maneuver.ncs.find(t => t.status === 'Resolved' && t.resolution && t.resolution.manifest);
  const asMigrated = t => { delete t.resolution.manifest; t.dispo = null; t.affected = null; t.mrbId = null; t.escape = { from: 'Final inspection', detectedAt: 'Customer' }; };

  await check('#305 a forged migration history entry does not exempt an unsigned closure from verification', async () => {
    const s = MES.upgrade(JSON.parse(fixture[1])); FlightManeuver.ensure(s);
    const t = signedNc(s); assert.ok(t, 'fixture: a signed stock NC');
    t.resolution = { note: 'Closed without approval.', by: t.raisedBy, at: '2026-09-30T00:00:00.000Z' };
    t.history.push({ at: '2026-09-30T00:00:00.000Z', action: 'Migrated from escape ESC-999.', actor: 'Somebody' });
    assert.equal(MES.verifyManifests(s).ok, false);
    assert.equal(typeof probe.validState(s), 'string');
  });

  await check('#305 the server refuses a write that strips a signed NC into the migration shape with a system history entry', async () => {
    const live = await started(JSON.parse(fixture[1]));
    const id = signedNc(JSON.parse(live.server.store.getDoc('default').json)).id;
    const r = await viaAction(live, ws => { const t = ws.maneuver.ncs.find(x => x.id === id); asMigrated(t); t.history.push({ at: new Date().toISOString(), action: 'Migrated from escape ESC-999.', actor: 'system' }); });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, /migrated-escape record that the shared workspace does not hold/);
    assert.ok(JSON.parse(live.server.store.getDoc('default').json).maneuver.ncs.find(x => x.id === id).resolution.manifest, 'the stored NC keeps its signed approval');
  });

  await check('#305 the server refuses a write that adds the migrated-escape record itself to an NC', async () => {
    const live = await started(JSON.parse(fixture[1]));
    const id = signedNc(JSON.parse(live.server.store.getDoc('default').json)).id;
    const r = await viaAction(live, ws => { const t = ws.maneuver.ncs.find(x => x.id === id); asMigrated(t); t.resolution.legacy = { source: 'escape', escapeId: 'ESC-999', migratedAt: new Date().toISOString() }; });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, /migrated-escape record that the shared workspace does not hold/);
  });

  await check('#305 the server refuses a change to the closure of a migrated NC that keeps its record', async () => {
    const live = await started(raw);
    const id = migratedNcs(JSON.parse(live.server.store.getDoc('default').json))[0].id;
    const r = await viaAction(live, ws => { ws.maneuver.ncs.find(x => x.id === id).resolution.note = 'Rewritten after migration.'; });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, /migrated-escape record that the shared workspace does not hold/);
  });

  // r4161912794: once the server holds a migrated-escape NC, the whole record stays as stored. Only a CAR or rework order
  // link, added files and added history may change.
  for (const [label, edit, field] of [
    ['description', t => { t.description = 'Rewritten after migration.'; }, 'description'],
    ['part identity', t => { t.partNumber = 'SR-9999'; }, 'partNumber'],
    ['raiser', t => { t.raisedBy = { ...(t.raisedBy || {}), name: 'Someone Else', credentialId: 'ACCT-other' }; }, 'raisedBy'],
    ['escape data', t => { t.escape = { ...t.escape, detectedAt: t.escape.detectedAt === 'Customer' ? 'Receiving inspection' : 'Customer' }; }, 'escape'],
    ['migration history entry', t => { t.history = t.history.map(e => /^Migrated from escape/.test(e.action) ? { ...e, at: '2020-01-01T00:00:00.000Z' } : e); }, 'history'],
    ['history (an entry dropped)', t => { t.history = t.history.slice(1); }, 'history'],
    ['a field it did not hold', t => { t.disposition = 'Use as is'; }, 'disposition'],
  ]) {
    await check(`r4161912794 the server refuses a change to the ${label} of a stored migrated-escape NC`, async () => {
      const live = await started(raw);
      const id = migratedNcs(JSON.parse(live.server.store.getDoc('default').json))[0].id;
      const before = live.server.store.getDoc('default').etag;
      const r = await viaAction(live, ws => edit(ws.maneuver.ncs.find(x => x.id === id)));
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.match(r.json.error, new RegExp(`${id} is a migrated escape closure the shared workspace holds; its ${field} cannot change`));
      assert.equal(live.server.store.getDoc('default').etag, before, 'nothing was stored');
    });
  }
  await check('r4161912794 a CAR link, an added file and added history on a stored migrated-escape NC still save', async () => {
    const live = await started(raw);
    const stored = JSON.parse(live.server.store.getDoc('default').json);
    const id = migratedNcs(stored)[0].id, car = (stored.maneuver.cars || [])[0];
    const r = await viaAction(live, ws => { const t = ws.maneuver.ncs.find(x => x.id === id); if (car) t.carId = car.id; t.attachments = [...(t.attachments || []), { id: `ATT-${id}-9`, name: 'photo.jpg', type: 'image/jpeg', size: 10, storage: 'reference', addedAt: new Date().toISOString(), addedBy: { name: 'Admin', role: 'System Administrator', credentialId: 'ACCT-admin' } }]; t.history = [...t.history, { at: new Date().toISOString(), action: 'photo.jpg attached (logged by name only).', actor: 'Admin · ACCT-admin' }]; });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  // r4160517069: an initial upload has no stored copy, so the record must match the NC's own migration entry, and every
  // accepted record is audited under the importing QA Manager or Master Access account in the same transaction.
  const legacyAudit = server => server.store.auditRows(1000).filter(r => r.action === 'legacy-escape-import').map(r => ({ username: r.username, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail }));

  await check('r4160517069 an initial upload of the migrated workspace records each migrated-escape closure under the importing account', async () => {
    const live = await started(raw);
    const rows = legacyAudit(live.server);
    assert.ok(rows.length >= 1, JSON.stringify(rows));
    assert.ok(rows.every(r => r.username === 'admin' && r.detail.batches === rows.length), JSON.stringify(rows));
    const ncs = rows.flatMap(r => r.detail.ncs);
    assert.equal(ncs.length, rows[0].detail.total);
    assert.equal(rows[0].detail.digest, createHash('sha256').update(JSON.stringify(ncs)).digest('hex'));
    const stored = migratedNcs(JSON.parse(live.server.store.getDoc('default').json));
    assert.deepEqual(ncs.map(n => [n.id, n.escapeId, n.migratedAt]).sort(), stored.map(t => [t.id, t.resolution.legacy.escapeId, t.resolution.legacy.migratedAt]).sort());
  });

  // Codex r4170271763: both stores cut an audit detail at 4,000 characters, so a large import is written as bounded
  // batches that together name every NC, each with the batch count, the total and the digest of the full list.
  await check('r4170271763 a large migrated-escape import audits every NC in batches under the 4,000-character detail limit', async () => {
    const list = Array.from({ length: 500 }, (_, i) => ({ id: `NC-${String(i + 1).padStart(4, '0')}`, escapeId: `ESC-${String(i + 1).padStart(3, '0')}`, migratedAt: '2026-09-30T00:00:00.000Z', closedBy: 'A long closing inspector name for sizing', closedAt: '2026-09-01T00:00:00.000Z' }));
    const rows = legacyEscapeImportAudits(list);
    assert.ok(rows.length > 1, String(rows.length));
    assert.ok(rows.every(r => r.action === 'legacy-escape-import' && JSON.stringify(r.detail).length < 4000), JSON.stringify(rows.map(r => JSON.stringify(r.detail).length)));
    assert.ok(rows.every((r, i) => r.detail.batch === i + 1 && r.detail.batches === rows.length && r.detail.total === 500), 'batch numbering');
    assert.deepEqual(rows.flatMap(r => r.detail.ncs), list);
    assert.ok(rows.every(r => r.detail.digest === createHash('sha256').update(JSON.stringify(list)).digest('hex')));
    assert.ok(LEGACY_IMPORT_AUDIT_CHARS < 4000);
  });

  await check('r4160517069 an initial upload with no migrated-escape record writes no legacy audit row', async () => {
    const live = await started(JSON.parse(fixture[1]));
    assert.deepEqual(legacyAudit(live.server), []);
  });

  // A first import of a workspace where a signed NC was stripped into the migration shape and given the record.
  const strippedImport = withHistory => {
    const s = MES.upgrade(JSON.parse(fixture[1])); FlightManeuver.ensure(s);
    const t = signedNc(s); asMigrated(t);
    const at = '2026-09-30T00:00:00.000Z';
    t.resolution = { note: t.resolution.note, by: t.resolution.by, at: t.resolution.at <= at ? t.resolution.at : at, legacy: { source: 'escape', escapeId: 'ESC-999', migratedAt: at } };
    if (withHistory === 'other') t.history.push({ at, action: 'Migrated from escape ESC-998.', actor: 'system' });
    if (withHistory === 'match') t.history.push({ at, action: 'Migrated from escape ESC-999.', actor: 'system' });
    return { s, id: t.id };
  };
  const firstPut = async doc => { const server = makeServer(); servers.push(server); await server.ready; const api = caller(server); const token = await signIn(api); return { server, r: await api('PUT', '/workspace', { token, body: doc }) }; };

  await check('r4160517069 the server refuses an initial upload whose migrated-escape record has no migration entry', async () => {
    const { s, id } = strippedImport(null);
    const { server, r } = await firstPut(s);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, new RegExp(`${id} carries a migrated-escape record that does not match its own migration entry`));
    assert.equal(server.store.getDoc('default'), null, 'nothing was stored');
    assert.deepEqual(legacyAudit(server), []);
  });

  await check('r4160517069 the server refuses an initial upload whose migration entry names another escape', async () => {
    const { s } = strippedImport('other');
    const { server, r } = await firstPut(s);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, /does not match its own migration entry/);
    assert.equal(server.store.getDoc('default'), null, 'nothing was stored');
  });

  await check('r4160517069 a matching record on an initial upload is accepted only with an audit row naming the importing account', async () => {
    const { s, id } = strippedImport('match');
    const { server, r } = await firstPut(s);
    assert.equal(r.status, 204, JSON.stringify(r.json));
    const rows = legacyAudit(server);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'admin');
    assert.deepEqual(rows[0].detail.ncs.map(n => [n.id, n.escapeId]), [[id, 'ESC-999']]);
  });

  await check('a stock NC newly closed without a signed approval, and without the record, is still refused', async () => {
    const live = await started(JSON.parse(fixture[1]));
    const id = signedNc(JSON.parse(live.server.store.getDoc('default').json)).id;
    const r = await viaAction(live, ws => { asMigrated(ws.maneuver.ncs.find(x => x.id === id)); });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, /disposition approval/);
  });

  await check('validation refuses a malformed migrated-escape record, and one beside a signature manifest', async () => {
    const s = migrated(), t = migratedNcs(s)[0];
    const bad = structuredClone(s); migratedNcs(bad)[0].resolution.legacy = { source: 'escape', escapeId: t.resolution.legacy.escapeId };
    assert.equal(MES.validate(bad), false);
    const both = structuredClone(s), u = signedNc(both); u.resolution.legacy = { source: 'escape', escapeId: 'ESC-1', migratedAt: '2026-09-30T00:00:00.000Z' };
    assert.equal(MES.validate(both), false);
  });

  console.log('FAILS []');
  console.log(`${checks} checks passed`);
} catch (e) {
  console.error(e);
  console.log(`FAILS ${JSON.stringify([String(e && e.message || e)])}`);
  process.exitCode = 1;
} finally { servers.forEach(s => s.close?.()); }
