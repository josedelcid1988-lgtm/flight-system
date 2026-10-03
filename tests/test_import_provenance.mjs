// Issues #481 and #512: an empty-server initialization (and the browser migration dry run) refuses a workspace whose
// signed records were edited after signing or downgraded to the v81 manifest shape, which stores no signed subject.
// The current-format workspace is built by the real engine under separate accounts: a FAIR verified and left at
// Verified (no box 22, no QA approval), an MRB decided by its seats, a stock NC approved after it, and a CAR closed.
// Each attack edits a copy of that export the way issues #481 and #512 describe and initializes an empty server with
// it, then strips every subject and build stamp in the workspace or deletes a signature outright; each must be refused
// with a plain message and an audit row. A genuine legacy workspace (the curated sample,
// whose 45 manifests carry no subject and no build stamp) and the unedited current export still initialize.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createServer, makeHash } from '../server/server.mjs';
import { createHost } from '../server/mes-host.mjs';
import { inspectMigration } from '../tools/migrate-browser.mjs';

const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : TESTS + 'fixtures/';
const fails = [];
let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; console.log(`ok ${name}`); } catch (error) { fails.push(name); console.log(`FAIL ${name} -> ${error.message}`); }
};
const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver: FM } = host;
const curated = () => JSON.parse(fs.readFileSync(FIXTURES + 'demo_publish.html', 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const qaSample = () => JSON.parse(fs.readFileSync(FIXTURES + 'demo_qa150.html', 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const account = (role, name) => ({ username: `prov-${role}`, displayName: name, role });
const qe = account('qe', 'Quinn Quality'), me = account('me', 'Morgan Engineer'), swe = account('swe', 'Erin Design'), qm = account('qm', 'Quincy Manager'), admin = account('admin', 'Ada Master');
const BACKDATED = '2026-09-20T15:00:00.000Z';

// The current-format export: every signature below goes through the engine's own signing site.
const current = (() => {
  const state = curated();
  const as = (who, fn) => { const r = host.withAccount(who, fn, state); assert.ok(r && r.ok !== false, `${who.role}: ${JSON.stringify(r)}`); return r; };
  as(admin, () => MES.updateFairChar(state, 'WO-10004', 'C-2', { result: '2.752', tool: 'CAL-02', ok: true }));
  as(admin, () => MES.updateFairChar(state, 'WO-10004', 'C-3', { result: '0.010', tool: 'CAL-02', ok: true }));
  as(admin, () => MES.verifyFair(state, 'WO-10004', {}));
  const base = { type: 'NC', description: 'Found during receiving inspection.', partNumber: 'SR-IH-040', revision: 'A', quantity: 1, foundAt: 'Receiving inspection', pedigree: 'Production', escaped: 'no' };
  const nc = as(qe, () => FM.raiseNC(state, { ...base, title: 'Anodize color mismatch', sourceType: 'PO line', sourcePo: 'PO4411', sourceLine: '3' }));
  as(me, () => FM.dispositionNC(state, nc.id, { decision: 'Use as is', note: 'Cosmetic only.' }));
  const board = as(me, () => FM.openMRB(state, 'STOCK', nc.id, 'Cosmetic mismatch.'));
  const seatHolder = { 'Quality': qe, 'Manufacturing Engineering': me, 'Engineering': swe };
  FM.get(state, 'mrb', board.id).seats.forEach(seat => as(seatHolder[seat], () => FM.voteMRB(state, board.id, seat, 'Approve', 'Concur.')));
  const code = MES.DEFECT_CODES[0];
  as(qm, () => FM.approveNC(state, nc.id, { defectCode: code.code, subCode: code.subs[0].code, note: 'Approved per MRB.', quantity: 1 }));
  const car = as(qe, () => FM.raiseCAR(state, { title: 'Torque escapes', description: 'Repeat backshell torque escapes.', sourceType: 'Observation', severity: 'Major', dueDate: '2026-12-01' }));
  as(qm, () => FM.recordContainment(state, car.id, '100% re-inspection of open orders.'));
  as(me, () => FM.recordRootCause(state, car.id, { why1: 'Not torqued', why2: 'Step unclear', why3: 'No unit', fishMethod: 'WI missing torque unit', statement: 'WI lacked the torque unit.', category: 'Method' }));
  as(qm, () => FM.addAction(state, car.id, { description: 'Add torque unit to the WI.', owner: 'ME', dueDate: '2026-11-01' }));
  as(me, () => FM.completeAction(state, car.id, FM.get(state, 'cars', car.id).actions[0].id, 'MCR incorporated.'));
  as(qe, () => FM.verifyCAR(state, car.id, 'Verified on 5 orders.'));
  as(qe, () => FM.effectivenessCheck(state, car.id, { checkDate: new Date().toISOString().slice(0, 10), result: 'Effective', note: 'No recurrence.' }));
  as(qe, () => FM.closeCAR(state, car.id, 'Closed.'));
  return { json: JSON.stringify(state), ncId: nc.id, mrbId: board.id, carId: car.id };
})();
const exported = () => JSON.parse(current.json);
const fairOf = s => MES.getOrder(s, 'WO-10004').fair;
const mrbOf = s => s.maneuver.mrb.find(m => m.id === current.mrbId);
const ncOf = s => s.maneuver.ncs.find(t => t.id === current.ncId);
const carOf = s => s.maneuver.cars.find(c => c.id === current.carId);
// What a forger does to make a signature look like v81: drop the subject and the build stamp, then recompute the
// public SHA-256 over whatever the record now says, so verifyManifests has nothing to object to.
const downgrade = (m, at, subject = {}) => { delete m.subject; delete m.build; if (at) m.at = at; m.hash = MES.sha256(MES.canonical(subject)); };

// An empty server per initialization, driven through its request handler as the browser and the migration tool do.
const initialize = async doc => {
  const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'provenance-test' });
  await server.ready;
  await server.store.upsertAccount({ username: 'prov-qm', displayName: 'Quincy Manager', salt: '', hash: await makeHash('prov-qm-pass-1'), role: 'qm', roles: ['qm'] });
  const call = async (method, url, token, body) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); incoming.method = method; incoming.url = url;
    incoming.headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
    const done = new Promise(resolve => outgoing.once('finish', resolve));
    server.listeners('request')[0](incoming, outgoing); await done;
    const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: outgoing.statusCode, json };
  };
  const token = (await call('POST', '/api/auth/session', null, { username: 'prov-qm', password: 'prov-qm-pass-1' })).json.token;
  const put = await call('PUT', '/api/workspace', token, doc);
  const stored = await server.store.getDoc('default');
  const audit = (await server.store.auditRows(1000)).map(row => ({ action: row.action, detail: JSON.parse(row.detail || '{}') }));
  return { ...put, stored, audit };
};
const refused = async (doc, where) => {
  const r = await initialize(doc);
  assert.equal(r.status, 422, `status ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.code, 'SIGNATURE_PROVENANCE', JSON.stringify(r.json));
  assert.match(r.json.error, /^The workspace was not loaded\. The signed record at /);
  assert.ok(r.json.error.includes(where), `the refusal names ${where}: ${r.json.error}`);
  assert.match(r.json.error, /Initialize the server from the workspace exactly as Flight System saved or exported it\. Nothing was saved\.$/);
  assert.ok(!/—/.test(r.json.error), 'no em dash in the refusal');
  assert.equal(r.stored, null, 'nothing was saved');
  const row = r.audit.find(a => a.action === 'workspace-put-refused' && a.detail.code === 'SIGNATURE_PROVENANCE');
  assert.ok(row, 'the refusal is in the server audit log');
  assert.equal(row.detail.status, 422);
  assert.ok(row.detail.reason.includes(where), 'the audit row says which record');
  assert.ok(!r.audit.some(a => a.action === 'workspace-initialize'), 'no initialization was audited');
  return r;
};

await check('the unedited current export initializes an empty server', async () => {
  const doc = exported();
  assert.ok(MES.validate(doc) && MES.verifyManifests(doc).ok, 'the export validates');
  assert.ok(fairOf(doc).status === 'Verified' && !fairOf(doc).reviewed && !fairOf(doc).approved, 'the FAIR is Verified only, as in #481');
  assert.ok(fairOf(doc).verified.manifest.subject && fairOf(doc).verified.manifest.build.version === 'v82', 'the FAIR was signed in the current format');
  for (const m of [mrbOf(doc).decision.manifest, ncOf(doc).resolution.manifest, carOf(doc).closure.manifest]) assert.ok(m.subject && m.build, 'the Flight Maneuver signatures were signed in the current format');
  const r = await initialize(doc);
  assert.equal(r.status, 204, JSON.stringify(r.json));
  assert.ok(r.stored, 'the workspace was stored');
});
await check('a genuine legacy workspace (45 subjectless manifests, no build stamps) still initializes', async () => {
  const doc = curated(), v = MES.verifyManifests(doc);
  assert.equal(v.ok, true); assert.equal(v.legacy, 45, 'every curated manifest is in the v81 shape');
  const provenance = MES.verifyImportProvenance(doc); assert.equal(provenance.ok, true, JSON.stringify(provenance.failures));
  const r = await initialize(doc);
  assert.equal(r.status, 204, JSON.stringify(r.json));
});
await check('a seeded workspace initializes', async () => {
  const doc = MES.ensureMasterWIs(MES.seed()); host.FlightPlan.ensure(doc);
  assert.equal((await initialize(doc)).status, 204);
});

// #481 as reported: subject and build removed, both verification times backdated before v82, Form 3 altered.
await check('#481: a backdated subjectless Verified FAIR with an altered Form 3 is refused', async () => {
  const doc = exported(), f = fairOf(doc);
  f.chars[1].result = '2.790';
  f.verified.at = BACKDATED; downgrade(f.verified.manifest, BACKDATED);
  assert.ok(MES.validate(doc) && MES.verifyManifests(doc).ok, 'the forgery passes validation and manifest verification on their own');
  const r = await refused(doc, 'WO-10004 FAIR verification');
  assert.match(r.json.error, /dated before characteristic results it verifies/);
});
await check('#481: the same forgery with the Form 3 result dates also backdated is refused by the order history', async () => {
  const doc = exported(), f = fairOf(doc);
  f.chars.forEach(c => { if (c.date) c.date = '2026-09-19'; });
  f.chars[1].result = '2.790';
  f.verified.at = BACKDATED; downgrade(f.verified.manifest, BACKDATED);
  const r = await refused(doc, 'WO-10004 FAIR verification');
  assert.match(r.json.error, /order history records this verification by a build that stores the signed subject/);
});
await check('#481: a subjectless FAIR verification that keeps its v82 build stamp is refused', async () => {
  const doc = exported(), m = fairOf(doc).verified.manifest;
  delete m.subject; m.hash = MES.sha256(MES.canonical({}));
  const r = await refused(doc, 'verified.manifest');
  assert.match(r.json.error, /signed by build v82, which stores the signed subject, but the subject is missing/);
});
await check('a FAIR whose Form 3 was changed after verification, subject kept, is refused', async () => {
  const doc = exported();
  fairOf(doc).chars[1].result = '2.790';
  assert.ok(MES.verifyManifests(doc).ok, 'the manifest walk alone does not see it');
  const r = await refused(doc, 'WO-10004 FAIR verification');
  assert.match(r.json.error, /Forms 1 to 3 no longer match what was verified/);
});

// #512: MRB, CAR and stock NC signatures downgraded the same way.
await check('#512: an MRB decision downgraded to v81 with its rationale and votes altered is refused', async () => {
  const doc = exported(), b = mrbOf(doc);
  b.decision.note = 'Accepted without engineering review.'; b.votes[2].note = 'Forged.';
  downgrade(b.decision.manifest);
  const r = await refused(doc, 'decision.manifest');
  assert.match(r.json.error, /no build stamp, but it is dated after v82, which stores the subject, replaced v81 on 2026-09-28/);
});
await check('#512: the MRB downgrade with the decision also backdated is refused', async () => {
  const doc = exported(), b = mrbOf(doc);
  b.decision.note = 'Accepted without engineering review.'; b.decision.at = BACKDATED;
  downgrade(b.decision.manifest, BACKDATED);
  const r = await refused(doc, `${current.mrbId} MRB decision`);
  assert.match(r.json.error, /dated before the board was convened or before a vote it decides/);
});
await check('#512: a CAR closure downgraded to v81 is refused, backdated or not', async () => {
  const plain = exported(); carOf(plain).closure.note = 'Closed without verification.'; downgrade(carOf(plain).closure.manifest);
  assert.match((await refused(plain, 'closure.manifest')).json.error, /no build stamp, but it is dated after v82, which stores the subject, replaced v81 on 2026-09-28/);
  const back = exported(); carOf(back).closure.at = BACKDATED; downgrade(carOf(back).closure.manifest, BACKDATED);
  assert.match((await refused(back, `${current.carId} closure`)).json.error, /dated before the steps it closes/);
});
await check('#512: a stock NC disposition approval downgraded to v81 is refused, backdated or not', async () => {
  const plain = exported(); ncOf(plain).resolution.note = 'Use as is, no MRB.'; downgrade(ncOf(plain).resolution.manifest);
  assert.match((await refused(plain, 'resolution.manifest')).json.error, /no build stamp, but it is dated after v82, which stores the subject, replaced v81 on 2026-09-28/);
  const back = exported(); ncOf(back).resolution.at = BACKDATED; downgrade(ncOf(back).resolution.manifest, BACKDATED);
  assert.match((await refused(back, `${current.ncId} disposition approval`)).json.error, /dated before the nonconformance or its disposition/);
});
await check('MRB, CAR and stock NC records changed after signing, subjects kept, are refused', async () => {
  const b = exported(); mrbOf(b).decision.note = 'Accepted without engineering review.';
  assert.match((await refused(b, `${current.mrbId} MRB decision`)).json.error, /board record no longer matches what was signed/);
  const c = exported(); carOf(c).rootCause.statement = 'Operator error.';
  assert.match((await refused(c, `${current.carId} closure`)).json.error, /corrective action no longer matches what was signed/);
  const n = exported(); ncOf(n).affected.quantity = 5;
  assert.match((await refused(n, `${current.ncId} disposition approval`)).json.error, /nonconformance no longer matches what was signed/);
});

// Review findings on this change: strip every subject and build stamp in the workspace so no v82 evidence is left,
// without backdating; and delete a signature manifest outright.
await check('stripping every subject and build stamp in the workspace does not hide a downgrade', async () => {
  const doc = exported();
  const strip = node => { if (Array.isArray(node)) return node.forEach(strip); if (!node || typeof node !== 'object') return; delete node.build; if (node.manifest && typeof node.manifest === 'object') { delete node.manifest.subject; delete node.manifest.build; } Object.values(node).forEach(strip); };
  strip(doc);
  mrbOf(doc).decision.note = 'Accepted without engineering review.';
  for (const m of [fairOf(doc).verified.manifest, mrbOf(doc).decision.manifest, carOf(doc).closure.manifest, ncOf(doc).resolution.manifest]) m.hash = MES.sha256(MES.canonical({}));
  assert.ok(MES.validate(doc) && MES.verifyManifests(doc).ok, 'the forgery passes validation and manifest verification on their own');
  const r = await refused(doc, 'manifest');
  assert.match(r.json.error, /no build stamp, but it is dated after v82, which stores the subject, replaced v81 on 2026-09-28/);
});
await check('a FAIR verification, a FAIR QA approval, a buy-off or a stock NC approval with its manifest deleted is refused', async () => {
  const cases = [
    [s => { delete fairOf(s).verified.manifest; }, 'WO-10004 FAIR verification'],
    [s => { const f = MES.getOrder(s, 'WO-10002').fair; delete f.approved.manifest; f.approved.at = '2026-10-01T16:00:00.000Z'; }, 'WO-10002 FAIR QA approval'],
    [s => { const op = MES.getOrder(s, 'WO-10004').operations.find(o => o.buyoff); delete op.buyoff.manifest; op.buyoff.at = '2026-10-01T16:00:00.000Z'; return `WO-10004 ${op.id} buy-off`; }, null],
    [s => { delete ncOf(s).resolution.manifest; }, `${current.ncId} disposition approval`]
  ];
  for (const [edit, named] of cases) {
    const doc = exported(), where = edit(doc) || named;
    assert.ok(MES.validate(doc) && MES.verifyManifests(doc).ok, `${where}: validation alone accepts the deletion`);
    assert.match((await refused(doc, where)).json.error, /the record says it was signed, but its signature manifest is missing/);
  }
});

// Codex review on #631: signatures from a browser still running v81 after v82 shipped, and closed escapes from before
// the ticket restructure, are genuine and must still initialize.
await check('signatures made by a v81 browser after v82 shipped still initialize', async () => {
  const doc = curated(), late = '2026-10-01T16:00:00.000Z';
  const order = doc.orders.find(o => o.operations.some(op => op.buyoff && op.buyoff.manifest));
  const signed = order.operations.filter(op => op.buyoff && op.buyoff.manifest);
  signed.forEach(op => { op.buyoff.manifest.at = late; op.buyoff.manifest.build = { version: 'v81', sha256: 'f'.repeat(64) }; if (op.buyoff.at) op.buyoff.at = late; });
  assert.ok(MES.validate(doc) && MES.verifyManifests(doc).ok, 'the v81 workspace validates');
  const r = await initialize(doc);
  assert.equal(r.status, 204, JSON.stringify(r.json));
  const stripped = curated(), op = stripped.orders.find(o => o.id === order.id).operations.find(x => x.id === signed[0].id);
  op.buyoff.manifest.at = late; if (op.buyoff.at) op.buyoff.at = late;
  assert.match((await refused(stripped, 'buyoff.manifest')).json.error, /no build stamp, but it is dated after v82/);
});
await check('a closed escape from before the ticket restructure still initializes', async () => {
  const doc = curated(), by = doc.maneuver.ncs[0].raisedBy;
  delete doc.maneuver.__ticketsV2;
  doc.maneuver.escapes = [{ id: 'ESC-0001', title: 'Loose connector found by customer', description: 'Connector J3 was not seated.', status: 'Closed', partNumber: 'SR-IH-040', serials: [], detectedAt: 'Customer', escapedFrom: 'Final inspection', raisedBy: by, raisedAt: '2026-09-10T16:00:00.000Z', closure: { note: 'Reseated and re-inspected.', by, at: '2026-09-12T16:00:00.000Z' }, containment: null, attachments: [], history: [] }];
  const r = await initialize(doc);
  assert.equal(r.status, 204, JSON.stringify(r.json));
  const state = JSON.parse(r.stored.json), nc = state.maneuver.ncs.find(t => t.escape && t.resolution && t.resolution.note === 'Reseated and re-inspected.');
  assert.ok(nc && !nc.resolution.manifest && nc.dispo === null, 'the escape became a resolved NC carrying its old closure');
  const forged = exported(); delete ncOf(forged).resolution.manifest; ncOf(forged).history.push({ at: '2026-09-12T16:00:00.000Z', action: 'Migrated from escape ESC-9.', actor: 'system' });
  assert.match((await refused(forged, `${current.ncId} disposition approval`)).json.error, /signature manifest is missing/);
});

await check('a buy-off from before v80, which carries no manifest, still initializes', async () => {
  const doc = curated(), op = doc.orders.flatMap(o => o.operations).find(o => o.buyoff && o.buyoff.manifest);
  delete op.buyoff.manifest;
  assert.ok(Date.parse(op.buyoff.at) < Date.parse('2026-09-28T22:38:38Z'), 'the buy-off predates v82');
  const r = await initialize(doc);
  assert.equal(r.status, 204, JSON.stringify(r.json));
});
await check('a verified FAIR whose order identity changed after verification is refused', async () => {
  for (const edit of [o => { o.quantity += 1; }, o => { o.drawingRev = 'Z'; }]) {
    const doc = exported(); edit(MES.getOrder(doc, 'WO-10004'));
    assert.match((await refused(doc, 'WO-10004 FAIR verification')).json.error, /Forms 1 to 3 no longer match what was verified/);
  }
});

// Codex review on #631 (39a84e5): a fake v81 stamp on a stripped v82 signature, and a deleted work order ticket approval.
await check('a stripped v82 signature given a fake v81 build stamp is refused', async () => {
  const doc = exported(), m = carOf(doc).closure.manifest;
  carOf(doc).closure.note = 'Closed without verification.';
  delete m.subject; m.build = { version: 'v81', sha256: 'a'.repeat(64) }; m.hash = MES.sha256(MES.canonical({}));
  assert.ok(MES.validate(doc) && MES.verifyManifests(doc).ok, 'the forgery passes validation and manifest verification on their own');
  assert.match((await refused(doc, 'closure.manifest')).json.error, /dated after this workspace was already signed by a build that stores one/);
});
// The QA sample holds 150 work orders, over the server's 100 open-order initialization limit, so these call the check
// the server runs directly.
await check('a larger genuine legacy workspace (the QA sample, 104 subjectless manifests) passes the check', async () => {
  const doc = qaSample();
  assert.equal(MES.verifyManifests(doc).legacy, 104);
  const r = MES.verifyImportProvenance(doc);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});
await check('a recent work order disposition approval with its manifest deleted is refused', async () => {
  const ticket = qaSample(), wo = ticket.orders.find(o => o.tickets.some(t => t.status === 'Resolved' && !t.reworkPlan)), t = wo.tickets.find(x => x.status === 'Resolved' && !x.reworkPlan);
  assert.equal(MES.verifyImportProvenance(ticket).ok, true, 'the same unsigned approval from before v82 is the pre-v80 shape and loads');
  t.resolvedAt = '2026-10-01T16:00:00.000Z';
  const r = MES.verifyImportProvenance(ticket);
  assert.ok(r.failures.some(f => f.where === `${wo.id} ${t.id} disposition approval` && /signature manifest is missing/.test(f.reason)), JSON.stringify(r.failures));
});

// Codex review on #631 (45cbedf): an NC edited to look like a migrated escape, a displayed signer or time that is not
// the signed one, and a deleted manifest whose step is moved before the cutoff.
await check('a signed NC approval edited to look like a migrated escape is refused', async () => {
  const doc = exported(), t = ncOf(doc);
  delete t.resolution.manifest; t.dispo = null; t.affected = null;
  t.history.push({ at: new Date().toISOString(), action: 'Migrated from escape ESC-0009.', actor: 'system' });
  assert.match((await refused(doc, `${current.ncId} disposition approval`)).json.error, /signature manifest is missing/);
});
await check('an approval whose displayed signer or time is not the signed one is refused', async () => {
  const signer = exported(); mrbOf(signer).decision.by = { ...mrbOf(signer).decision.by, credentialId: 'ACCT-prov-qm', name: 'Quincy Manager' };
  assert.match((await refused(signer, `${current.mrbId} MRB decision`)).json.error, /signer shown on the record is not the person who signed/);
  for (const field of [{ name: 'Someone Else' }, { role: 'Technician' }]) {
    const shown = exported(); Object.assign(ncOf(shown).resolution.by, field);
    assert.match((await refused(shown, `${current.ncId} disposition approval`)).json.error, /signer shown on the record is not the person who signed/);
  }
  const when = exported(); carOf(when).closure.at = '2026-10-01T12:00:00.000Z';
  assert.match((await refused(when, `${current.carId} closure`)).json.error, /time shown on the record is not the signed time/);
});
await check('a deleted manifest whose step is moved before v82 shipped is refused by its own chronology', async () => {
  // An MRB decision or CAR closure without its manifest already fails MES.validate; the stock NC carries this rule.
  for (const edit of [s => { delete mrbOf(s).decision.manifest; mrbOf(s).decision.at = BACKDATED; }, s => { delete carOf(s).closure.manifest; carOf(s).closure.at = BACKDATED; }]) { const doc = exported(); edit(doc); assert.equal(MES.validate(doc), false); }
  const n = exported(); delete ncOf(n).resolution.manifest; ncOf(n).resolution.at = BACKDATED;
  assert.match((await refused(n, `${current.ncId} disposition approval`)).json.error, /dated before the nonconformance or its disposition/);
});

await check('the browser migration dry run refuses the #481 forgery and accepts the unedited export', async () => {
  const forged = exported(), f = fairOf(forged);
  f.chars[1].result = '2.790'; f.verified.at = BACKDATED; downgrade(f.verified.manifest, BACKDATED);
  assert.throws(() => inspectMigration({ storage: { 'skyryse-mes-work-order-v1': JSON.stringify(forged), 'skyryse-mes-auth-v1': JSON.stringify({ users: [] }) } }, host), /The signed record at WO-10004 FAIR verification cannot be shown to be unchanged: it is dated before characteristic results it verifies\. Export the workspace again from the browser that holds it, without editing the file\./);
  assert.doesNotThrow(() => inspectMigration({ storage: { 'skyryse-mes-work-order-v1': current.json, 'skyryse-mes-auth-v1': JSON.stringify({ users: [] }) } }, host));
});

console.log(`checks ${checks + fails.length} pass ${checks} fail ${fails.length}`);
console.log('FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
