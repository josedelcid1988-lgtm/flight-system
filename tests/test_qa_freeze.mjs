// Issue #542: a work order in QA review is frozen, and the only way back is a signed QA send back to Building.
// Part 1 drives the engine through the server host (the same calls the server action route makes): every frozen
// action is refused with the freeze text and changes nothing, QA records stay allowed, MES.sendBackToBuilding is
// refused for a role without approve-wo, an empty or oversized rationale, an NC from another order and any status
// other than Quality, and the send-back record is signed, bounded and tamper-evident.
// Part 2 drives the demo build in Chromium: the freeze holds in the demo, the button and dialog send the order
// back, the banner, activity and prints show it, and the order goes through a rework operation, Send to QA and
// Review & close.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';

const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : TESTS + 'fixtures/';
const fails = [];
const ok = (what, cond, more = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + more)); if (!cond) fails.push(what); };

const FREEZE = 'This work order is in QA review. Ask Quality to send it back to Building before changing it.';
const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const account = (role, name) => ({ username: `freeze-${role}`, displayName: name, role });
const technician = account('technician', 'Terry Tech');
const operator = account('operator', 'Owen Operator');
const me = account('me', 'Morgan Engineer');
const qe = account('qe', 'Quinn Quality');
const qm = account('qm', 'Quincy Manager');
const curated = () => JSON.parse(fs.readFileSync(FIXTURES + 'demo_publish.html', 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const QA_ID = 'WO-10004';
const fresh = () => { const state = curated(); assert.equal(MES.getOrder(state, QA_ID).status, 'Quality', 'the curated sample keeps WO-10004 in Quality'); return state; };
const snap = (state, id = QA_ID) => JSON.stringify({ order: MES.getOrder(state, id), serials: state.serialLog || null });

// ---- Part 1: every frozen action is refused in Quality and changes nothing, even for a QA Manager ----
{
  const state = fresh();
  const run = fn => host.withAccount(qm, fn, state);
  const o = MES.getOrder(state, QA_ID);
  const op = o.operations[0];
  const kitFile = (o.kitFiles || [])[0];
  const serial = (state.serialLog || []).find(e => e.orderId === QA_ID && e.status === 'Assigned');
  const frozen = [
    ['assignSerial', () => MES.assignSerial(state, QA_ID, '')],
    ['voidSerial', () => MES.voidSerial(state, QA_ID, serial ? serial.serial : 'X-1', 'Mislabeled unit.')],
    ['removeAttachment', () => MES.removeAttachment(state, QA_ID, op.id, 'ATT-0001')],
    ['removeTicketAttachment', () => MES.removeTicketAttachment(state, QA_ID, 'NC-9999', 'FILE-1')],
    ['removeKitFile', () => MES.removeKitFile(state, QA_ID, kitFile ? kitFile.id : 'KIT-1')],
    ['submitEngineeringChange', () => MES.submitEngineeringChange(state, QA_ID, { quantity: o.quantity + 1, reason: 'More units needed.' })],
    ['approveECR', () => MES.approveECR(state, QA_ID)],
    ['approveEngineeringChange', () => MES.approveEngineeringChange(state, QA_ID)],
    ['setPriority', () => MES.setPriority(state, QA_ID, o.priority === 'High' ? 'Normal' : 'High')],
    ['resolveAog', () => MES.resolveAog(state, QA_ID, 'Normal', 'Part arrived.')],
    ['setSchedule', () => MES.setSchedule(state, QA_ID, '2026-01-02', '2026-12-30')],
    ['linkATPSoftware', () => MES.linkATPSoftware(state, QA_ID, op.id, {})],
    ['addPurchaseOrder', () => MES.addPurchaseOrder(state, QA_ID, op.id, { number: 'PO-1' })],
    ['linkWorkOrderProject', () => MES.linkWorkOrderProject(state, QA_ID, null)]
  ];
  for (const [name, call] of frozen) {
    const before = snap(state);
    const r = run(call);
    ok(`${name} is refused in Quality with the freeze text`, r && r.ok === false && r.message === FREEZE, JSON.stringify(r));
    ok(`${name} changes nothing in Quality`, snap(state) === before);
  }
  ok('serial auto-assign assigns nothing to a work order in Quality', run(() => MES.autoAssignSerials(state, o)).length === 0);
  // Already refused in Quality before #542, and must stay that way.
  const kept = [
    ['addOrderOperation', () => MES.addOrderOperation(state, QA_ID, { position: o.operations.length, title: 'Rework the seal', description: 'Replace the seal.', classification: 'Rework' })],
    ['removeOrderOperation', () => MES.removeOrderOperation(state, QA_ID, op.id)],
    ['editOrderOperation', () => MES.editOrderOperation(state, QA_ID, op.id, { title: 'Changed' })],
    ['splitOrder', () => MES.splitOrder(state, QA_ID, 1)],
    ['requestPedigreeChange', () => MES.requestPedigreeChange(state, QA_ID, { to: 'Development', reason: 'Not flight hardware.' })],
    ['setMaterialLot', () => MES.setMaterialLot(state, QA_ID, o.materials[0].id, 'LOT-NEW')]
  ];
  for (const [name, call] of kept) {
    const before = snap(state);
    const r = run(call);
    ok(`${name} stays refused in Quality`, r && r.ok === false && snap(state) === before, JSON.stringify(r));
  }
  // QA adds evidence files; nobody else does while the order is in QA review.
  const file = { name: 'qa-photo.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  const before = snap(state);
  const tech = host.withAccount(technician, () => MES.addAttachment(state, QA_ID, op.id, file), state);
  ok('a technician cannot add a file to a work order in QA review', tech.ok === false && tech.message === FREEZE && snap(state) === before, JSON.stringify(tech));
  const qa = host.withAccount(qm, () => MES.addAttachment(state, QA_ID, op.id, file), state);
  ok('a QA Manager adds an evidence file in QA review', qa.ok === true, JSON.stringify(qa));
  ok('the workspace is valid after the freeze checks', MES.validate(state));
}

// ---- Part 1: QA records stay allowed in Quality ----
{
  const state = fresh();
  const note = host.withAccount(technician, () => MES.addNote(state, QA_ID, 'Waiting on the QA review.'), state);
  ok('a note is added in Quality', note.ok === true, JSON.stringify(note));
  const o = MES.getOrder(state, QA_ID);
  const nc = host.withAccount(qe, () => MES.createTicket(state, QA_ID, o.operations.at(-1).id, { type: 'NC', title: 'Torque stripe missing', description: 'No torque stripe on J3.', hold: true }), state);
  ok('an NC is raised in Quality and puts the order on hold', nc.ok === true && MES.blockingTickets(MES.getOrder(state, QA_ID)).length === 1, JSON.stringify(nc));
  ok('Review & close stays refused while the NC is open', host.withAccount(qm, () => MES.closeOrder(state, QA_ID), state).ok === false);
  ok('the workspace is valid with the NC raised in Quality', MES.validate(state));
}

// ---- Part 1: sendBackToBuilding refusals ----
{
  const state = fresh();
  const before = snap(state);
  for (const who of [technician, operator, me]) {
    const r = host.withAccount(who, () => MES.sendBackToBuilding(state, QA_ID, { rationale: 'Missing torque stripe.' }), state);
    ok(`${who.displayName} (${who.role}, no approve-wo) cannot send a work order back`, r.ok === false && /Your role cannot send a work order back to Building/.test(r.message) && snap(state) === before, JSON.stringify(r));
  }
  const send = input => host.withAccount(qe, () => MES.sendBackToBuilding(state, QA_ID, input), state);
  for (const [label, input] of [['an empty rationale', { rationale: '' }], ['a blank rationale', { rationale: '   ' }], ['a missing rationale', {}], ['no input', undefined], ['a 301-character rationale', { rationale: 'x'.repeat(301) }]]) {
    const r = send(input);
    ok(`send back is refused for ${label}`, r.ok === false && /rationale/.test(r.message) && snap(state) === before, JSON.stringify(r));
  }
  ok('a 300-character rationale is accepted', send({ rationale: 'y'.repeat(300) }).ok === true);
  const other = curated();
  const ncElsewhere = other.orders.find(x => x.id !== QA_ID && x.tickets.length).tickets[0].id;
  const s2 = fresh(), b2 = snap(s2);
  const wrong = host.withAccount(qe, () => MES.sendBackToBuilding(s2, QA_ID, { rationale: 'Rework needed.', ticketId: ncElsewhere }), s2);
  ok('send back refuses an NC that is not on this work order', wrong.ok === false && /is not an NC on WO-10004/.test(wrong.message) && snap(s2) === b2, JSON.stringify(wrong));
  for (const status of ['Draft', 'Kitting', 'Building', 'Closed']) {
    const s3 = curated(), id = s3.orders.find(x => x.status === status).id, b3 = snap(s3, id);
    const r = host.withAccount(qe, () => MES.sendBackToBuilding(s3, id, { rationale: 'Rework needed.' }), s3);
    ok(`send back is refused from ${status}`, r.ok === false && /Only a work order in QA review can be sent back to Building/.test(r.message) && snap(s3, id) === b3, JSON.stringify(r));
  }
  const s4 = fresh();
  ok('send back is refused for an unknown work order', host.withAccount(qe, () => MES.sendBackToBuilding(s4, 'WO-99999', { rationale: 'x' }), s4).ok === false);
}

// ---- Part 1: the signed send back, its record, the bound and the tamper checks ----
{
  const state = fresh();
  const o = MES.getOrder(state, QA_ID);
  const nc = host.withAccount(qe, () => MES.createTicket(state, QA_ID, o.operations.at(-1).id, { type: 'NC', title: 'Seal damaged', description: 'Seal nicked at J2.', hold: true }), state);
  const r = host.withAccount(qe, () => MES.sendBackToBuilding(state, QA_ID, { rationale: '  Seal at J2 must be replaced.  ', ticketId: nc.id }), state);
  ok('Quality sends the work order back to Building', r.ok === true && o.status === 'Building', JSON.stringify(r));
  const e = MES.lastSendBack(o);
  ok('the send back records the trimmed rationale, the NC, the statuses and the revisions', e && e.rationale === 'Seal at J2 must be replaced.' && e.ticketId === nc.id && e.from === 'Quality' && e.to === 'Building' && e.revision === o.revision && e.woRev === (o.woRev || 'Baseline'), JSON.stringify(e));
  ok('the send back records the person and credential', e.by.name === 'Quinn Quality' && !!e.by.credentialId && e.manifest.signer.credentialId === e.by.credentialId);
  ok('the send back carries a SHA-256 manifest bound to the record', e.manifest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(e.manifest.hash) && e.manifest.meaning === 'QA send back to Building' && e.manifest.at === e.at);
  for (const key of ['orderId', 'revision', 'woRev', 'rationale', 'ticketId', 'from', 'to']) ok(`the manifest binds ${key}`, Object.hasOwn(e.manifest.subject, key));
  ok('the activity record shows the send back', o.history.at(-1).action.startsWith('Sent back by QA: Seal at J2 must be replaced. (linked ' + nc.id + ')'));
  ok('the workspace validates and every manifest verifies after a send back', MES.validate(state) && MES.verifyManifests(state).ok);
  ok('the server action route accepts MES.sendBackToBuilding', typeof host.resolveAction('MES.sendBackToBuilding') === 'function');
  // Tamper: change a bound field after signing.
  const tamper = (label, mutate) => {
    const t = structuredClone(state), te = MES.lastSendBack(MES.getOrder(t, QA_ID));
    mutate(te);
    const v = MES.verifyManifests(t);
    ok(`tamper (${label}) fails validation`, MES.validate(t) === false, 'still valid');
    ok(`tamper (${label}) fails manifest verification`, v.ok === false, JSON.stringify(v.failures));
    const d = MES.diagnose(t);
    ok(`tamper (${label}) is named by diagnose`, !!d && d.where === QA_ID && /QA send back to Building record is malformed or does not match its signature/.test(d.detail), JSON.stringify(d));
  };
  tamper('rationale edited', x => { x.rationale = 'Nothing to see.'; });
  tamper('linked NC removed', x => { x.ticketId = null; });
  tamper('linked NC replaced with a value that is not an NC id', x => { x.ticketId = 'WO-10004'; });
  tamper('revision edited', x => { x.revision = 'Z'; });
  tamper('from status edited', x => { x.from = 'Closed'; });
  tamper('signer swapped', x => { x.by = { ...x.by, credentialId: 'ACCT-other' }; });
  tamper('time moved', x => { x.at = '2020-01-01T00:00:00.000Z'; });
  tamper('manifest hash replaced', x => { x.manifest.hash = '0'.repeat(64); });
  tamper('manifest removed', x => { delete x.manifest; });
  // A send back whose manifest subject was rewritten along with the record but not re-hashed still fails.
  tamper('record and subject edited without a new hash', x => { x.rationale = 'Edited'; x.manifest.subject.rationale = 'Edited'; });
  // Bound: the order keeps its last 20 send backs.
  const s = fresh(), so = MES.getOrder(s, QA_ID);
  for (let n = 1; n <= 22; n += 1) {
    const back = host.withAccount(qe, () => MES.sendBackToBuilding(s, QA_ID, { rationale: `Round ${n}.` }), s);
    const again = host.withAccount(qm, () => MES.advance(s, QA_ID), s);
    if (!back.ok || !again.ok) { ok(`round ${n} sends back and returns through Send to QA`, false, JSON.stringify([back, again])); break; }
  }
  ok('the order keeps its last 20 send backs, numbered on', so.sendBacks.length === 20 && so.sendBacks[0].id === 'SB-3' && so.sendBacks.at(-1).id === 'SB-22', JSON.stringify(so.sendBacks.map(x => x.id)));
  ok('the workspace validates after 22 send backs', MES.validate(s) && MES.verifyManifests(s).ok);
  const over = structuredClone(s), oo = MES.getOrder(over, QA_ID);
  oo.sendBacks = [...oo.sendBacks, { ...oo.sendBacks[0], id: 'SB-99' }];
  ok('a 21-entry send-back list fails validation', MES.validate(over) === false);
}

// ---- Part 1: a split after a send back keeps the signed send backs on the order that signed them ----
{
  const admin = account('admin', 'Flight Master');
  for (const linked of [false, true]) {
    const state = MES.upgrade(fresh()), o = MES.getOrder(state, QA_ID);
    const nc = linked ? host.withAccount(qe, () => MES.createTicket(state, QA_ID, o.operations.at(-1).id, { type: 'NC', title: 'Seal damaged', description: 'Seal nicked at J2.', hold: true }), state) : null;
    const back = host.withAccount(qe, () => MES.sendBackToBuilding(state, QA_ID, { rationale: 'Seal at J2 must be replaced.', ...(nc ? { ticketId: nc.id } : {}) }), state);
    Object.assign(o, { quantity: 3 });
    o.splitRequests = [{ id: 'SPR-FREEZE-1', ticketId: nc ? nc.id : null, quantity: 1, of: 3, serials: [], reason: 'Split the affected unit', status: 'Open', requestedBy: { name: 'Quinn Quality', role: 'Quality Engineer', credentialId: 'QE-1' }, requestedAt: new Date().toISOString() }];
    const label = linked ? 'a send back linked to an NC' : 'a send back';
    ok(`the work order is back in Building with ${label} before the split`, back.ok && o.status === 'Building' && MES.validate(state), JSON.stringify(back));
    const split = host.withAccount(admin, () => MES.splitRequestOrder(state, QA_ID, 'SPR-FREEZE-1'), state);
    const child = split.ok ? MES.getOrder(state, split.id) : null;
    ok(`a split request is fulfilled on an order with ${label}`, split.ok && !!child, JSON.stringify(split));
    ok(`the split child carries no send backs signed for the parent (${label})`, !!child && child.sendBacks === undefined);
    ok(`the parent keeps its signed send back (${label})`, o.sendBacks.length === 1 && o.sendBacks[0].id === 'SB-1');
    const v = MES.verifyManifests(state);
    ok(`the workspace validates and every manifest verifies after the split (${label})`, MES.validate(state) && v.ok, JSON.stringify(v.failures));
  }
}

// ---- Part 2: the demo build keeps the freeze, and the UI flow end to end ----
{
  const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  // WO-10019 is in QA review in the 150-order set: not an FAI order, with a resolved NC to link the rework to.
  const UI_ID = 'WO-10019';
  await p.goto('file://' + FIXTURES + 'demo_qa150_publish.html'); await p.waitForTimeout(900);
  await p.evaluate(() => { const un = document.querySelector('#sk-boot input[name=username]'); const pw = document.querySelector('#sk-boot input[type=password]'); un.value = 'demo'; un.dispatchEvent(new Event('input', { bubbles: true })); pw.value = 'demo1234'; pw.dispatchEvent(new Event('input', { bubbles: true })); un.closest('form').requestSubmit(); });
  await p.waitForTimeout(1200);
  const demoFreeze = await p.evaluate(([id]) => { const r = MES.setPriority(state, id, 'High'); const s = MES.assignSerial(state, id, ''); return [r.message, s.message]; }, [UI_ID]);
  ok('the demo build keeps the freeze (priority and serials)', demoFreeze.every(m => m === FREEZE), JSON.stringify(demoFreeze));
  // A Quality order held by an open NC (the usual reason to send it back) still offers the send back.
  const held = await p.evaluate(() => { const o = state.orders.find(x => x.status === 'Quality' && x.id !== 'WO-10019' && !MES.blockingTickets(x).length); const nc = MES.createTicket(state, o.id, o.operations.at(-1).id, { type: 'NC', title: 'Loose clamp', description: 'Clamp at P4 is loose.', hold: true }); selectedId = o.id; view = 'order'; tab = 'operations'; render(); return { nc: nc.ok, button: !!document.querySelector('[data-action="send-back"]') }; });
  ok('a Quality order held by an open NC still shows Send back to Building', held.nc && held.button, JSON.stringify(held));
  await p.evaluate(([id]) => { selectedId = id; view = 'order'; tab = 'operations'; render(); }, [UI_ID]); await p.waitForTimeout(400);
  ok('a Quality work order shows Send back to Building next to Review & close', await p.evaluate(() => { const s = document.querySelector('[data-action="send-back"]'), r = document.querySelector('[data-action="review"]'); return !!s && !!r && s.parentElement === r.parentElement; }));
  await p.click('[data-action="send-back"]'); await p.waitForTimeout(300);
  ok('the dialog has a required rationale and an optional NC picker', await p.evaluate(() => { const f = document.getElementById('send-back-form'); return !!f && f.elements.rationale.required && f.elements.rationale.maxLength === 300 && f.elements.ticketId.options[0].value === '' && !f.elements.ticketId.required; }));
  await p.evaluate(() => document.getElementById('send-back-form').requestSubmit()); await p.waitForTimeout(200);
  ok('an empty rationale does not send the work order back', await p.evaluate(([id]) => MES.getOrder(state, id).status === 'Quality', [UI_ID]));
  await p.fill('#send-back-rationale', 'Torque stripe missing on J3. Rework and re-inspect.');
  const linked = await p.evaluate(([id]) => { const t = MES.getOrder(state, id).tickets[0]; document.getElementById('send-back-ticket').value = t.id; return t.id; }, [UI_ID]);
  await p.evaluate(() => document.getElementById('send-back-form').requestSubmit()); await p.waitForTimeout(500);
  const after = await p.evaluate(([id]) => { const o = MES.getOrder(state, id); return { status: o.status, banner: (document.querySelector('.send-back-banner') || {}).textContent || '', saved: JSON.parse(localStorage.getItem(KEY)).orders.find(x => x.id === id).status }; }, [UI_ID]);
  ok('the dialog sends the work order back to Building and saves it', after.status === 'Building' && after.saved === 'Building', JSON.stringify(after));
  ok('the send back links the NC picked in the dialog', await p.evaluate(([id, t]) => MES.lastSendBack(MES.getOrder(state, id)).ticketId === t, [UI_ID, linked]));
  ok('the work order shows the Sent back by QA banner with rationale, name and date', /Sent back by QA: Torque stripe missing on J3\. Rework and re-inspect\., .+, \w+ \d+, \d{4}/.test(after.banner), after.banner);
  ok('the banner has no em dash', !after.banner.includes('—'));
  await p.evaluate(() => { tab = 'record'; render(); }); await p.waitForTimeout(300);
  ok('the Record tab shows the send back', await p.evaluate(() => /Sent back by QA: Torque stripe missing on J3/.test(document.querySelector('main').textContent)));
  const prints = await p.evaluate(([id]) => { const o = MES.getOrder(state, id); return { record: MESPrint.document(o, 'external'), traveler: MESPrint.traveler(o, { serials: [] }) }; }, [UI_ID]);
  ok('the record print shows the send back', /QA send back to Building/.test(prints.record) && /Sent back by QA: Torque stripe missing on J3/.test(prints.record));
  ok('the traveler shows the send back', /Sent back by QA: Torque stripe missing on J3/.test(prints.traveler));
  // Rework through a sequence change, buy-off, Send to QA, Review & close.
  const flow = await p.evaluate(([id]) => {
    const o = MES.getOrder(state, id), out = {};
    out.add = MES.addOrderOperation(state, id, { ticketId: MES.lastSendBack(o).ticketId, position: o.operations.length, title: 'Apply torque stripe at J3', description: 'Apply the torque stripe to J3 per the drawing.', classification: 'Rework', buyoffType: 'Technician', requiresTooling: false, steps: [{ title: 'Apply stripe', instruction: 'Apply the torque stripe.' }] });
    out.inQAFirst = MES.closeOrder(state, id).ok === false;
    out.release = MES.approveSequenceChange(state, id);
    const op = o.operations.find(x => !x.done);
    out.steps = (op && op.steps || []).map(s => MES.setStepCheck(state, id, op.id, s.id, true, {})).every(x => x.ok);
    out.buy = op ? MES.completeOperation(state, id, op.id, 'Stripe applied.', { tools: [], noTools: true, toolControlAck: true, stampNumber: 'DEMO' }) : { ok: false, message: 'no open operation' };
    out.toQA = MES.advance(state, id);
    out.close = MES.closeOrder(state, id);
    out.status = o.status; out.valid = MES.validate(state); out.verify = MES.verifyManifests(state).ok; save();
    return out;
  }, [UI_ID]);
  ok('Review & close is refused while the work order is back in Building', flow.inQAFirst);
  ok('a rework operation is added through a sequence change after the send back', flow.add.ok && flow.release.ok, JSON.stringify([flow.add, flow.release]));
  ok('the rework operation is bought off in Building', flow.steps && flow.buy.ok, JSON.stringify(flow.buy));
  ok('the work order returns through Send to QA', flow.toQA.ok, JSON.stringify(flow.toQA));
  ok('Review & close closes the work order', flow.close.ok && flow.status === 'Closed', JSON.stringify(flow.close));
  ok('the workspace validates and every manifest verifies after the flow', flow.valid && flow.verify);
  ok('no page errors', errs.length === 0, JSON.stringify(errs));
  await b.close();
}

console.log('FAILS', JSON.stringify(fails));
if (fails.length) process.exit(1);
