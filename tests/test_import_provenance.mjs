// Issues #481 and #512: an export edited so that a signed record looks like the legacy format, then used to initialize
// an empty server. Before the v82 port (merged 2026-09-28 22:38:38 UTC) manifests did not store the signed subject;
// verifyManifests counts such a manifest as legacy and only checks its shape. Main also never compared a FAIR
// verification, CAR closure, MRB decision or stock NC approval with the live record it covers, so editing the record,
// with or without removing the subject, verified. MES.provenanceProblem now runs where an export becomes the
// authoritative record (empty-server initialization and tools/migrate-browser.mjs): each of those signatures is
// recomputed from the live record with its one subject shape, a subjectless signature dated after the port is refused,
// and a FAIR verification whose subject cannot be rebuilt (a record from before the handover) is accepted as legacy only
// when the order's own build history agrees. Every refusal is audited. Genuine legacy and current exports still load.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from '../server/server.mjs';
import { inspectMigration } from '../tools/migrate-browser.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${name}`); };
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const SETUP_CODE = 'import-provenance-test-setup-code';
// Each call drives the server's request handler directly, as tests/test_server_init_race.mjs does.
const caller = srv => (method, url, { token, body } = {}) => new Promise((resolve, reject) => {
  const incoming = new PassThrough();
  incoming.method = method; incoming.url = `/api${url}`;
  incoming.headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
  outgoing.once('error', reject);
  outgoing.once('finish', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; } resolve({ status: outgoing.statusCode, json }); });
  srv.listeners('request')[0](incoming, outgoing);
  incoming.end(body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
});
const signIn = async api => {
  assert.equal((await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [
    { username: 'qa-lead', displayName: 'QA Lead', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }
  ] } })).status, 200);
  const token = (await api('POST', '/auth/session', { body: { username: 'qa-lead', password: 'flight-pass-123' } })).json.token;
  assert.ok(token); return token;
};
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
await server.ready;
const api = caller(server), token = await signIn(api);
const host = server.host, { MES, FlightManeuver } = host;

const H = value => MES.sha256(MES.canonical(value));
const RECENT = new Date(Date.now() - 3600000).toISOString();
const BACKDATED = '2026-09-20T15:00:00.000Z';
const BUILD = { version: 'v82', sha256: 'unstamped' };
// The curated sample workspace is a genuine legacy export: its FAIR (WO-10002), MRB-101 and NC-0002 were signed on
// 2026-09-19, before the handover, with no stored subject and no build stamp.
const legacy = () => { const state = MES.upgrade(JSON.parse(readFileSync(new URL('../tools/demo/seed-curated.json', import.meta.url), 'utf8'))); FlightManeuver.ensure(state); return state; };
const as = (state, username, fn) => host.withAccount({ username, displayName: username, role: 'admin' }, fn, state);
const ok = result => { assert.ok(result && result.ok, result && result.message); return result; };

// A current export: the same workspace after this build verified the WO-10004 FAIR (Verified only, no box 22 yet) and
// closed CAR-1001, with MRB-101 and NC-0002 signed in the current format (subject stored, build stamped, signed today).
const current = () => {
  const state = legacy();
  for (const [charId, result] of [['C-2', '2.750'], ['C-3', '0.010']]) ok(as(state, 'fair-inspector', () => MES.updateFairChar(state, 'WO-10004', charId, { result, tool: 'CAL-QA-1', ok: true })));
  ok(as(state, 'fair-verifier', () => MES.verifyFair(state, 'WO-10004', { pin: '' })));
  const car = state.maneuver.cars.find(c => c.id === 'CAR-1001');
  for (const action of car.actions) ok(as(state, 'car-owner', () => FlightManeuver.completeAction(state, car.id, action.id, 'Template revised and released; evidence filed.')));
  ok(as(state, 'car-verifier', () => FlightManeuver.verifyCAR(state, car.id, 'Reviewed the revised template and observed two torque steps.')));
  ok(as(state, 'car-verifier', () => FlightManeuver.effectivenessCheck(state, car.id, { checkDate: RECENT.slice(0, 10), result: 'Effective', note: 'No recurrence across twelve orders.' })));
  ok(as(state, 'car-closer', () => FlightManeuver.closeCAR(state, car.id, 'Root cause addressed at the template level.')));
  // MRB-101 and NC-0002 re-signed as this build signs them (decideMRB and the stock NC approval). The subject shapes are
  // written out here independently of the engine, so a change to either shape fails this test.
  const mrb = state.maneuver.mrb.find(m => m.id === 'MRB-101'), nc = state.maneuver.ncs.find(t => t.id === 'NC-0002');
  const resign = (signed, subject) => { signed.at = RECENT; signed.manifest = { ...signed.manifest, at: RECENT, hash: H(subject), subject: structuredClone(subject), authenticated: false, build: BUILD }; };
  resign(mrb.decision, { id: mrb.id, orderId: mrb.orderId, ticketId: mrb.ticketId, partNumber: mrb.partNumber, serials: mrb.serials, proposed: mrb.proposed, votes: mrb.votes.map(v => ({ seat: v.seat, vote: v.vote, by: v.by.credentialId, at: v.at })), status: mrb.decision.status, note: mrb.decision.note });
  const a = nc.affected;
  resign(nc.resolution, { id: nc.id, partNumber: nc.partNumber, serial: nc.serial, lot: nc.lot, disposition: nc.dispo.decision, defect: { defectCode: a.defectCode, defectName: a.defectName, subCode: a.subCode, subName: a.subName }, quantity: a.quantity, mrbId: nc.mrbId, note: nc.resolution.note });
  assert.equal(MES.validate(state), true, 'the current export is valid');
  assert.equal(MES.verifyManifests(state).ok, true, 'the current export verifies');
  return state;
};
// Removes the stored subject and build stamp, as #481 and #512 describe.
const strip = manifest => { delete manifest.subject; delete manifest.build; };

const refused = async (name, state, pattern) => {
  // The edit passes the checks that ran before this change: the workspace validates and every manifest verifies.
  assert.equal(MES.validate(state), true, `${name}: the edited export still validates`);
  assert.equal(MES.verifyManifests(state).ok, true, `${name}: the edited export still passes verifyManifests`);
  const problem = MES.provenanceProblem(state);
  assert.match(String(problem), pattern, `${name}: provenanceProblem names the record`);
  assert.doesNotMatch(problem, /\u2014/, 'refusal text has no em dash');
  assert.throws(() => inspectMigration({ storage: { 'skyryse-mes-work-order-v1': JSON.stringify(state) } }, host), error => error.message.includes(problem), `${name}: the migration dry run refuses it`);
  const audited = async () => (await server.store.auditRows(500)).filter(row => row.action === 'workspace-put-refused');
  const before = (await audited()).length;
  const put = await api('PUT', '/workspace', { token, body: state });
  assert.equal(put.status, 422, `${name}: the empty server refuses the initialization`);
  assert.equal(put.json.code, 'SIGNATURE_PROVENANCE');
  assert.equal(put.json.error, problem);
  assert.equal((await api('GET', '/workspace', { token })).status, 404, `${name}: the server stays empty`);
  const rows = await audited();
  assert.equal(rows.length, before + 1, `${name}: the refusal is in the server audit log`);
  const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
  assert.equal(detail.status, 422); assert.equal(detail.code, 'SIGNATURE_PROVENANCE'); assert.equal(detail.reason, problem.slice(0, 500));
};

await check('#481: a Verified-only FAIR stripped of subject and build, backdated, with Form 3 altered, is refused on empty-server init', async () => {
  const state = current(), fair = state.orders.find(o => o.id === 'WO-10004').fair;
  assert.equal(fair.status, 'Verified'); assert.equal(fair.approved, null, 'no QA approval yet, so nothing chains to the verification');
  strip(fair.verified.manifest); fair.verified.at = fair.verified.manifest.at = BACKDATED;
  fair.chars.find(c => c.id === 'C-2').result = '2.900';
  await refused('#481', state, /^WO-10004 FAIR verification \(blocks 20 and 21\) has no build stamp, but the WO-10004 history records the verification with one, so a later build signed it/);
});

await check('#481: the same forgery with the build stamp removed from the verification history event is refused by its time', async () => {
  const state = current(), order = state.orders.find(o => o.id === 'WO-10004'), fair = order.fair;
  strip(fair.verified.manifest); fair.verified.at = fair.verified.manifest.at = BACKDATED;
  fair.chars.find(c => c.id === 'C-2').result = '2.900';
  const event = order.history.find(e => e.action.startsWith('AS9102 FAIR WO-10004 verified')); delete event.build;
  await refused('#481 history', state, /^WO-10004 FAIR verification \(blocks 20 and 21\) is dated 2026-09-20 15:00:00 UTC, but the WO-10004 history records the verification at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\./);
});

await check('#481: the same forgery with an earlier build-stamped record on the order is refused by the order build history', async () => {
  const state = current(), order = state.orders.find(o => o.id === 'WO-10004'), fair = order.fair;
  strip(fair.verified.manifest); fair.verified.at = fair.verified.manifest.at = BACKDATED;
  fair.chars.find(c => c.id === 'C-2').result = '2.900';
  // The verification event is deleted, but the order still holds a record stamped by a v82 build dated before the claim.
  const event = order.history.find(e => e.action.startsWith('AS9102 FAIR WO-10004 verified'));
  order.history = order.history.filter(e => e !== event);
  order.history.push({ ...event, id: 'WO-10004-event-900', action: 'Note added: kit checked.', at: '2026-09-20T14:00:00.000Z' });
  await refused('#481 build history', state, /^WO-10004 FAIR verification \(blocks 20 and 21\) has no build stamp and claims 2026-09-20 15:00:00 UTC, but WO-10004 holds records stamped by a later build at or before that time\./);
});

await check('#481: a subjectless FAIR verification left at its real date is refused as a format downgrade', async () => {
  const state = current(), fair = state.orders.find(o => o.id === 'WO-10004').fair;
  strip(fair.verified.manifest); fair.chars.find(c => c.id === 'C-3').result = '0.020';
  await refused('#481 undated', state, /^WO-10004 FAIR verification \(blocks 20 and 21\) was signed on \d{4}-\d\d-\d\d, after Flight System began storing the signed subject, but its manifest has no subject\./);
});

await check('a current-format FAIR verification whose box 14 reasons were changed (subject kept) is refused', async () => {
  const state = current(), fair = state.orders.find(o => o.id === 'WO-10004').fair;
  fair.reasons = [...fair.reasons.filter(r => r !== 'Mfg. process change'), 'Mfg. process change'].reverse();
  assert.notEqual(MES.canonical(MES.fairSnapshot(state, state.orders.find(o => o.id === 'WO-10004')).form1.reasons), MES.canonical(fair.verified.manifest.subject.form1.reasons), 'the edit changes Form 1 box 14');
  await refused('FAIR reasons', state, /^WO-10004 FAIR verification \(blocks 20 and 21\) does not match what was signed: Forms 1 to 3 were changed after verification\./);
});

await check('a current-format FAIR verification whose Form 3 was changed (subject kept) is refused', async () => {
  const state = current(); state.orders.find(o => o.id === 'WO-10004').fair.chars.find(c => c.id === 'C-2').result = '2.900';
  await refused('FAIR forms', state, /^WO-10004 FAIR verification \(blocks 20 and 21\) does not match what was signed: Forms 1 to 3 were changed after verification\./);
});

const mrbOf = s => s.maneuver.mrb.find(m => m.id === 'MRB-101'), carOf = s => s.maneuver.cars.find(c => c.id === 'CAR-1001'), ncOf = s => s.maneuver.ncs.find(t => t.id === 'NC-0002');
for (const [kind, label, signed, edit, field] of [
  ['MRB', 'MRB-101 board decision', s => mrbOf(s).decision, s => { mrbOf(s).decision.note = 'Accepted as is per phone call.'; }, 'note'],
  ['CAR', 'CAR-1001 closure', s => carOf(s).closure, s => { carOf(s).rootCause.statement = 'Operator error.'; }, 'rootCause'],
  ['stock NC', 'NC-0002 disposition approval', s => ncOf(s).resolution, s => { ncOf(s).affected.quantity = 1; }, 'quantity']
]) {
  await check(`#512: a ${kind} signature stripped to the legacy format and altered is refused on empty-server init`, async () => {
    const state = current(); strip(signed(state).manifest); edit(state);
    await refused(`#512 ${kind}`, state, new RegExp(`^${label} was signed on \\d{4}-\\d\\d-\\d\\d, after Flight System began storing the signed subject, but its manifest has no subject\\.`));
  });
  await check(`#512: a ${kind} signature downgraded, backdated and rehashed over a weaker subject is refused`, async () => {
    const state = current(), s = signed(state), weak = { ...s.manifest.subject };
    strip(s.manifest); edit(state);
    // The attacker leaves the altered field out of the subject they rehash, which is what a weaker legacy verifier allowed.
    delete weak[field]; s.at = s.manifest.at = BACKDATED; s.manifest.hash = H(weak);
    await refused(`#512 ${kind} rehash`, state, new RegExp(`^${label} does not match what was signed: the record was changed after it was signed\\.`));
  });
  await check(`a current-format ${kind} signature whose record was changed (subject kept) is refused`, async () => {
    const state = current(); edit(state);
    await refused(`${kind} record`, state, new RegExp(`^${label} does not match what was signed`));
  });
}

await check('a genuine legacy export (signed before the handover, no subject, no build stamp) still loads on an empty server', async () => {
  const state = legacy();
  assert.ok(MES.verifyManifests(state).legacy > 0, 'the workspace carries legacy signatures');
  assert.equal(state.orders.find(o => o.id === 'WO-10002').fair.verified.manifest.subject, undefined);
  assert.equal(MES.provenanceProblem(state), null);
  assert.equal(inspectMigration({ storage: { 'skyryse-mes-work-order-v1': JSON.stringify(state) } }, host).report.valid, true);
  const put = await api('PUT', '/workspace', { token, body: state });
  assert.equal(put.status, 204, put.json && put.json.error);
});

await check('a normal current export initializes an empty server', async () => {
  const fresh = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
  await fresh.ready;
  const call = caller(fresh), t = await signIn(call), state = current();
  assert.equal(MES.provenanceProblem(state), null);
  assert.equal(inspectMigration({ storage: { 'skyryse-mes-work-order-v1': JSON.stringify(state) } }, host).report.valid, true);
  const put = await call('PUT', '/workspace', { token: t, body: state });
  assert.equal(put.status, 204, put.json && put.json.error);
  assert.equal((await call('GET', '/workspace', { token: t })).status, 200);
  fresh.close?.();
});

server.close?.();
console.log(`test_import_provenance: ${checks} checks passed`);
