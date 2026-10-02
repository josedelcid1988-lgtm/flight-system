// Hermes audit sweep (engine): the behavior changes in the claude/sweep-hermes-engine bundle.
// #587 and #588: record date checks use the site (Pacific) calendar day, not the UTC day. The clock is pinned to
//       2026-10-01 17:30 PDT (2026-10-02T00:30Z): the UTC day is already 2026-10-02, the site day is 2026-10-01.
// #589: editing an operation decides "records a torque value" with the same rule as adding one (MES.stepRecordsTorque).
// #590: editing an Inspection or Source Inspection operation to a non-inspection buy-off is refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightPlan, FlightManeuver } = host;
const SEED = fs.readFileSync(new URL('../tools/demo/seed-curated.json', import.meta.url), 'utf8');
const DEMO = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1];
const admin = { username: 'admin', displayName: 'Flight Master', role: 'admin' };
const me = { username: 'me-mia', displayName: 'Mia Engineer', role: 'me' };
const qm = { username: 'qm-qara', displayName: 'Qara Manager', role: 'qm' };
let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const run = (state, account, fn) => host.withAccount(account, fn, state);

// The engine runs in its own vm realm, so the clock is pinned there: the realm's Function reaches the realm's Date.
const realm = Object.getPrototypeOf(MES.validate).constructor;
realm('globalThis.__RealDate = globalThis.__RealDate || Date;')();
const pinClock = iso => realm('iso', 'const R = globalThis.__RealDate, t = R.parse(iso); globalThis.Date = class extends R { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } };')(iso);
const EVENING = '2026-10-02T00:30:00.000Z', SITE_DAY = '2026-10-01', UTC_DAY = '2026-10-02';
pinClock(EVENING);
check('the pinned clock is 17:30 Pacific on 2026-10-01 and already 2026-10-02 in UTC', realm("return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })")() === SITE_DAY && realm('return new Date().toISOString().slice(0, 10)')() === UTC_DAY);
check('MES.siteToday() is the Pacific site day', MES.siteToday() === SITE_DAY, MES.siteToday());

const fresh = () => MES.upgrade(JSON.parse(DEMO));
const technician = { username: 'tech-tom', displayName: 'Tom Tech', role: 'technician' };
const qe = { username: 'qe-quinn', displayName: 'Quinn Quality', role: 'qe' };
const ops = { username: 'ops-olive', displayName: 'Olive Ops', role: 'ops' };
// A conformity grant is signed by a QA Manager against current training (mes-host grantValid), never by the holder.
const grant = (username, cap) => {
  const g = { by: { account: qm.username, name: qm.displayName, credentialId: `ACCT-${qm.username}` }, at: '2026-09-01T16:00:00.000Z', reason: 'Granted for the Hermes sweep test.', trainingCode: 'ESD' };
  return { ...g, hash: createHash('sha256').update(MES.canonical({ account: username, authority: cap, action: 'granted', ...g })).digest('hex') };
};
const conf = { username: 'qe-cora', displayName: 'Cora Conformity', role: 'qe', grants: { conformity: grant('qe-cora', 'conformity') } };
const inspector = state => {
  const trained = run(state, qm, () => MES.recordTraining(state, { account: conf.username, code: 'ESD', expires: '2031-12-31' }));
  const issued = run(state, qm, () => MES.issueStamp(state, { name: conf.displayName, buyoffType: 'Quality', account: conf.username, expires: '2031-12-31' }));
  const stamp = issued.ok && state.stamps.find(s => s.number === issued.number);
  const pin = stamp && run(state, conf, () => MES.setStampPin(state, stamp.id, '1357', '1357'));
  assert.ok(trained.ok && issued.ok && pin && pin.ok, `inspector setup: ${trained.message} ${issued.message} ${pin && pin.message}`);
  return state;
};

// ---- #587: consumable shelf life ---------------------------------------------------------------------------------
{
  const attempt = expires => {
    const state = fresh(), order = MES.getOrder(state, 'WO-10006'), op = order.operations.find(x => !x.done);
    Object.assign(op, { buyoffType: 'Technician', inspectionPoint: false });
    op.steps[0].consumables = [MES.CONSUMABLES[0]];
    return run(state, technician, () => MES.setStepCheck(state, order.id, op.id, op.steps[0].id, true, { consumables: [{ name: MES.CONSUMABLES[0], lot: 'L-587', expires }] }));
  };
  const lastDay = attempt(SITE_DAY), expired = attempt('2026-09-30');
  check('a lot on its last day of shelf life is accepted at 17:30 Pacific (#587)', lastDay.ok, lastDay.message);
  check('a lot that expired the day before is refused with the expiry message', !expired.ok && /expired on 2026-09-30\. Use in-date material/.test(expired.message), expired.message);
}

// ---- #588: source inspection, MDL, 8130-9 check date, DAR date ---------------------------------------------------
{
  const state = inspector(fresh()), order = state.orders.find(o => o.status === 'Draft' && o.operations.length);
  const added = run(state, admin, () => MES.addOrderOperation(state, order.id, { title: 'Customer source inspection', description: 'Inspect before release', classification: 'Source Inspection', sourceInspectionCode: 'CSI', buyoffType: 'Quality', steps: 'Inspect parts', position: 0 }));
  check('a source-inspection operation is added for the date check', added.ok, added.message);
  const record = day => { const copy = structuredClone(state); return run(copy, conf, () => MES.recordSourceInspection(copy, order.id, order.operations[0].id, { agency: 'Customer', inspector: 'Inspector One', reference: 'CSI-588', notifiedDate: '2026-09-20', inspectedDate: day })); };
  const tomorrow = record(UTC_DAY), today = record(SITE_DAY);
  check('a source inspection dated the next site day is refused as in the future (#588)', !tomorrow.ok && /cannot be in the future/.test(tomorrow.message), tomorrow.message);
  check('a source inspection dated the site day is recorded', today.ok, today.message);
}
{
  const save = day => { const state = inspector(fresh()); return run(state, conf, () => MES.saveConformity(state, 'WO-10003', 'CI-110-00001', { mdlReceived: day })); };
  const tomorrow = save(UTC_DAY), today = save(SITE_DAY);
  check('an MDL received date of the next site day is refused (#588)', !tomorrow.ok && /MDL was received \(not in the future\)/.test(tomorrow.message), tomorrow.message);
  check('an MDL received date of the site day is saved', today.ok, today.message);
  const age = received => { const state = fresh(), order = MES.getOrder(state, 'WO-10003'), p = order.conformity[0]; p.mdlReceived = received; return run(state, conf, () => MES.confGaps(state, order, p, 'prepare')).filter(g => /MDL copy is/.test(g)); };
  check('an MDL copy received 30 site days ago is still within the limit at 17:30 Pacific (#588)', age('2026-09-01').length === 0, age('2026-09-01').join(' '));
  check('an MDL copy received 31 site days ago is past the limit', age('2026-08-31').length === 1 && /31 days old/.test(age('2026-08-31')[0]));
}
{
  const conformed = () => { const state = inspector(fresh()), order = MES.getOrder(state, 'WO-10002'), p = order.conformity[0]; return { state, order, p }; };
  const complete = day => {
    const { state, order, p } = conformed();
    Object.assign(p, { status: 'Open', form: null, aqi: null, notified: null, darApproval: null, faa8130_3: null, closed: null });
    return run(state, conf, () => MES.complete8130_9(state, order.id, p.serial, { section: 'Aircraft', item: 'B', make: 'Skyryse', model: 'One', checkDate: day, basis: 'Type design data per the RFC' }, { pin: '1357' }));
  };
  const tomorrow = complete(UTC_DAY), today = complete(SITE_DAY);
  check('an 8130-9 flight check dated the next site day is refused (#588)', !tomorrow.ok && /needs the date of the flight check/.test(tomorrow.message), tomorrow.message);
  check('an 8130-9 flight check dated the site day completes the form', today.ok, today.message);
  const dar = (day, aqiAt) => {
    const { state, order, p } = conformed();
    Object.assign(p, { status: 'Ready for DAR review', darApproval: null, faa8130_3: null, closed: null });
    if (aqiAt) p.aqi.at = aqiAt;
    return run(state, conf, () => MES.recordDarApproval(state, order.id, p.serial, { name: 'J. Rivera', designation: 'DAR-F 123', date: day, aqiPresent: true, fieldsSigned: true }));
  };
  const darTomorrow = dar(UTC_DAY), darToday = dar(SITE_DAY);
  check('a DAR signature dated the next site day is refused (#588)', !darTomorrow.ok && /not in the future/.test(darTomorrow.message), darTomorrow.message);
  check('a DAR signature dated the site day is recorded', darToday.ok, darToday.message);
  // An AQI signed at 17:10 Pacific carries a UTC timestamp of the next day; the DAR floor is the site day it was signed.
  const sameEvening = dar(SITE_DAY, '2026-10-02T00:10:00.000Z'), dayBefore = dar('2026-09-30', '2026-10-02T00:10:00.000Z');
  check('a DAR date on the site day of an evening AQI signature is accepted (#588)', sameEvening.ok, sameEvening.message);
  check('a DAR date before the AQI signature day is still refused', !dayBefore.ok && /on or after the AQI signature/.test(dayBefore.message), dayBefore.message);
}

// ---- #588, other write paths found by the sweep: CAR due date, SPR date, default start dates, FAIR result date --------
{
  const car = day => { const state = fresh(); return run(state, qm, () => FlightManeuver.raiseCAR(state, { title: 'Hermes CAR', description: 'Due date check.', sourceType: 'Observation', severity: 'Minor', dueDate: day })); };
  const dueToday = car(SITE_DAY), dueYesterday = car('2026-09-30');
  check('a CAR due on the site day is not refused as in the past', dueToday.ok, dueToday.message);
  check('a CAR due the day before is refused as in the past', !dueYesterday.ok && /cannot be in the past/.test(dueYesterday.message), dueYesterday.message);
  const spr = day => { const state = fresh(); return run(state, qm, () => FlightManeuver.raiseSPR(state, { title: 'Hermes SPR', partNumber: 'SR-FC-200', foundAt: 'HIL', description: 'Date check.', occurred: day })); };
  const sprTomorrow = spr(UTC_DAY), sprToday = spr(SITE_DAY);
  check('a problem report dated the next site day is refused as in the future', !sprTomorrow.ok && /cannot be in the future/.test(sprTomorrow.message), sprTomorrow.message);
  check('a problem report dated the site day is raised', sprToday.ok, sprToday.message);
}
{
  const state = fresh(), wi = state.masterWIs.find(w => w.status === 'Released');
  const adhoc = run(state, admin, () => MES.addAdhocOrder(state, { pedigree: 'Development NFF', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], partNumber: 'PN-HERMES-1', title: 'Hermes default start' }));
  check('an ad hoc order with no planned start starts on the site day', adhoc.ok && MES.getOrder(state, adhoc.id).start === SITE_DAY, adhoc.message);
  const order = run(state, admin, () => MES.addOrder(state, { masterWI: `${wi.id}|${wi.revision}`, pedigree: 'Development NFF', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0] }));
  check('a work order with no planned start starts on the site day', order.ok && MES.getOrder(state, order.id).start === SITE_DAY, order.message);
  const planned = run(state, ops, () => FlightPlan.addPlannedOrder(state, { masterWI: `${wi.id}|${wi.revision}`, partNumber: wi.partNumber, revision: MES.partDefinition(wi.partNumber)?.revision, quantity: 1, needDate: '2026-10-20', pedigree: 'Development NFF', subcategory: 'Mfg.', aircraft: MES.AIRCRAFT[0], site: MES.SITES[0], source: 'QA' }));
  const firmed = planned.ok && run(state, ops, () => FlightPlan.firm(state, planned.id));
  const converted = firmed && firmed.ok && run(state, ops, () => FlightPlan.convert(state, planned.id));
  check('a planned order converted on a Pacific evening starts on the site day', !!converted && converted.ok && MES.getOrder(state, converted.id).start === SITE_DAY, converted && converted.message);
  const fair = run(state, qe, () => MES.addFairChar(state, 'WO-10004', { ref: 'Sheet 1', designator: '', requirement: 'Marking per MIL-STD-130', result: 'Conforms', ok: true, tool: 'Visual' }));
  check('a FAIR result recorded on a Pacific evening carries the site day (Form 3 block 9B)', fair.ok && MES.getOrder(state, 'WO-10004').fair.chars.find(c => c.id === fair.id).date === SITE_DAY, fair.message);
}
realm('globalThis.Date = globalThis.__RealDate;')();

// ---- #589: one torque rule for adding and editing an operation -----------------------------------------------------
{
  check('MES.stepRecordsTorque: a torque stripe, seal, paint or mark step records no torque', ['Apply torque stripe', 'Apply torque seal to B-nut', 'Torque paint the jam nut', 'Torque mark each fastener'].every(t => MES.stepRecordsTorque(t) === false));
  check('MES.stepRecordsTorque: a torque step records a torque value', ['Torque to 35 in-lb', 'Re-torque fastener(s) to drawing value'].every(t => MES.stepRecordsTorque(t) === true));
  const state = fresh(), order = state.orders.find(o => o.status === 'Draft' && o.operations.length), op = order.operations[0];
  op.steps = [{ id: 'step-1', title: 'Install bracket', instruction: 'Install bracket', recordsTorque: true }];
  const base = { title: op.title, description: op.description, buyoffType: op.buyoffType, requiresTooling: op.requiresTooling, reason: 'Reword the torque steps (#589)' };
  const edited = run(state, me, () => MES.editOrderOperation(state, order.id, op.id, { ...base, steps: ['Install bracket', 'Apply torque stripe to both B-nuts', 'Torque to 35 in-lb'].join('\n') }));
  check('the operation edit is accepted', edited.ok, edited.message);
  const [kept, stripe, torque] = MES.getOrder(state, order.id).operations.find(x => x.id === op.id).steps;
  check('editing in "Apply torque stripe" does not require a torque reading (#589)', stripe.recordsTorque === false);
  check('editing in "Torque to 35 in-lb" requires a torque reading', torque.recordsTorque === true);
  check('an unchanged step keeps its saved torque setting', kept.recordsTorque === true);
  const add = run(state, me, () => MES.addOrderOperation(state, order.id, { classification: 'Manufacturing', title: 'Stripe the B-nuts', description: 'Stripe', buyoffType: 'Technician', steps: 'Apply torque stripe to both B-nuts\nTorque to 35 in-lb', position: MES.getOrder(state, order.id).operations.length }));
  const addedSteps = add.ok && MES.getOrder(state, order.id).operations.find(x => x.title === 'Stripe the B-nuts').steps;
  check('adding and editing the same lines give the same torque settings', add.ok && addedSteps[0].recordsTorque === stripe.recordsTorque && addedSteps[1].recordsTorque === torque.recordsTorque, add.message);
}

// ---- #590: an inspection operation keeps an inspection buy-off on edit ----------------------------------------------
{
  for (const [classification, extra] of [['Inspection', {}], ['Source Inspection', { sourceInspectionCode: 'CSI' }]]) {
    const a = classification === 'Inspection' ? 'an' : 'a';
    const state = fresh(), order = state.orders.find(o => o.status === 'Draft' && o.operations.length);
    const added = run(state, admin, () => MES.addOrderOperation(state, order.id, { classification, ...extra, title: `${classification} point`, description: 'Inspect', buyoffType: 'Quality', steps: 'Inspect the part', position: 0 }));
    check(`${a} ${classification} operation is added with a Quality buy-off`, added.ok, added.message);
    const op = order.operations[0], before = JSON.stringify(op);
    const input = { title: op.title, description: op.description, steps: 'Inspect the part', reason: 'Change the buy-off (#590)' };
    const refused = run(state, me, () => MES.editOrderOperation(state, order.id, op.id, { ...input, buyoffType: 'Technician' }));
    check(`editing ${a} ${classification} operation to a Technician buy-off is refused (#590)`, !refused.ok && /Inspection operations need a Quality, 8130-9 or Conformity Inspector buy-off/.test(refused.message), refused.message);
    check(`the refused ${classification} operation is unchanged`, JSON.stringify(MES.getOrder(state, order.id).operations[0]) === before);
    const allowed = run(state, me, () => MES.editOrderOperation(state, order.id, op.id, { ...input, buyoffType: '8130-9 Authorized Inspector' }));
    check(`editing ${a} ${classification} operation to another inspection buy-off is allowed`, allowed.ok, allowed.message);
  }
  const state = fresh(), order = state.orders.find(o => o.status === 'Draft' && o.operations.length), op = order.operations[0];
  const plain = run(state, me, () => MES.editOrderOperation(state, order.id, op.id, { title: op.title, description: op.description, steps: 'Do the work', reason: 'Plain edit (#590)', buyoffType: 'Technician' }));
  check('a manufacturing operation can still move to a Technician buy-off', plain.ok, plain.message);
}

console.log(`test_sweep_hermes_engine: ${checks} checks passed`);
console.log('FAILS []');
