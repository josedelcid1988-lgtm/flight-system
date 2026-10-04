// Issue #247, go-live clean slate. The owner's decision: the demo keeps its sample data; production starts with
// none. This suite checks the three sides of that:
//   1. a new production workspace holds no sample work orders, WIs, planned orders, Flight Maneuver records,
//      stamps, standard rework drafts, calibrated tools, NetSuite stock or default person, validates, and can be
//      used (records are added through the normal paths), and its screens show plain empty states without errors;
//   2. the demo build still carries every sample, through the numbered deviations D-37, D-48 and D-49;
//   3. a workspace saved by the v82 production engine before the clean slate (tests/fixtures/
//      workspace_v82_before_clean_slate.json, written once by that engine at commit e2e2bc3, with the sample WIs,
//      placeholder stamps, the Morgan Lee profile, sample planned orders with a NetSuite read, and calibration
//      entries, a work unit and a maintenance record that name tools of the old snapshot) loads unchanged.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';
import { createServer } from '../server/server.mjs';
import { SAMPLE_WIS, loadSampleInPage } from './lib/production-sample.mjs';

const here = rel => fileURLToPath(new URL(rel, import.meta.url));
const read = rel => fs.readFileSync(here(rel), 'utf8');
let checks = 0;
const FAILS = [];
const check = (name, ok, detail = '') => { checks += 1; if (ok) console.log(`ok ${name}`); else { FAILS.push(name); console.log(`not ok ${name}${detail ? `: ${detail}` : ''}`); } };
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
const me = { username: 'me-lee', displayName: 'Robin Engineer', role: 'me' };
const admin = { username: 'go-live', displayName: 'Go Live', role: 'admin' };
const now = '2026-10-01T19:00:00.000Z';

// The load path the page runs on a workspace (index.html: state=FlightPlan.ensure(MES.ensureMasterWIs(...))),
// plus the Flight Maneuver register and the standard rework library, which are created on first use.
const load = (host, state) => { const { MES, FlightPlan, FlightManeuver } = host; FlightManeuver.ensure(FlightPlan.ensure(MES.ensureMasterWIs(state))); MES.reworkLibrary(state); return state; };

// ---- 1. production: a new workspace is empty, valid and usable --------------------------------------------------
const prod = createHost(here('../index.html'));
{
  const { MES, FlightPlan } = prod;
  const state = load(prod, MES.seed());
  const mv = state.maneuver;
  check('a new production workspace has no work orders', state.orders.length === 0);
  check('a new production workspace has no master WIs', Array.isArray(state.masterWIs) && state.masterWIs.length === 0);
  check('a new production workspace has no planned orders', Array.isArray(state.plannedOrders) && state.plannedOrders.length === 0);
  check('a new production workspace has no Flight Maneuver records', ['ncs', 'cars', 'mrb', 'sprs', 'pfmeas'].every(k => Array.isArray(mv[k]) && mv[k].length === 0));
  check('a new production workspace has an empty stamp register (no placeholders, no role credentials)', Array.isArray(state.stamps) && state.stamps.length === 0);
  check('a new production workspace has no standard rework drafts', Array.isArray(state.reworkLibrary) && state.reworkLibrary.length === 0);
  check('a new production workspace has no calibration log entries', !(state.calibrationLog || []).length);
  check('the device profile names no person before sign-in', state.profile.name === 'Not signed in' && state.profile.credentialId === 'NOT-SIGNED-IN');
  check('production ships no Calibrated Tool Log snapshot', MES.CAL_TOOLS.length === 0 && MES.CAL_SNAPSHOT === '' && MES.calibratedToolChecks(state, now).length === 0);
  check('production ships no NetSuite stock', Object.keys(MES.NETSUITE_STOCK).length === 0 && MES.NETSUITE_SNAPSHOT === '' && MES.availableLots('SR-2401').length === 0 && FlightPlan.netsuiteRead('SR-FC-200') === null);
  const f = FlightPlan.forecast(state);
  check('production ships no MRP forecast tables', Object.keys(FlightPlan.DEMO_MBOM).length === 0 && FlightPlan.DEMO_COMPONENT_LOTS.length === 0 && FlightPlan.DEMO_PARTS.length === 0 && ['explosion', 'leadTime', 'fair', 'shelfLife', 'designChanges'].every(k => f[k].length === 0));
  check('the credential list offers no sample person', !JSON.stringify(MES.profileOptions(state)).includes('Morgan Lee'));
  check('the new workspace validates', MES.validate(state) === true, JSON.stringify(MES.diagnose(state)));
  check('diagnose finds nothing wrong', MES.diagnose(state) === null);
  check('every signature manifest verifies', MES.verifyManifests(state).ok === true);
  const again = JSON.stringify(state);
  load(prod, state);
  check('loading the new workspace again changes nothing (no seed appears later)', JSON.stringify(state) === again);

  // Usable with empty data: records arrive through the normal, signed paths.
  const cal = prod.withAccount(qa, () => MES.recordCalibration(state, { tag: 'GL-001', description: 'DIGITAL CALIPER', torque: 'no', serial: 'SN-1', calibratedAt: '2026-09-30', expires: '2027-09-30', status: 'In Calibration', location: 'Production Floor', note: 'Go-live load' }), state);
  check('a QA Manager records the first calibrated tool', cal.ok && MES.toolCheck('GL-001', now, state).ok === true, cal.message);
  const stamp = prod.withAccount(qa, () => MES.issueStamp(state, { name: 'Pat Rivera', buyoffType: 'Quality', account: 'priv', expires: '2027-12-31' }), state);
  check('a QA Manager issues the first stamp, numbered SKY-0000', stamp.ok && state.stamps.length === 1 && state.stamps[0].number === 'SKY-0000', stamp.message);
  const part = MES.PART_CATALOG[0];
  const wiCsv = ['wi,partNumber,partRevision,title,operation,operationTitle,operationSummary,buyoffType,stepTitle,instruction', `1,${part.partNumber},${part.revisions[0]},First WI,10,Prepare,Prepare parts,Technician,Clean,Wipe each part with IPA`].join('\n');
  const wi = prod.withAccount(me, () => MES.importMasterWIs(state, wiCsv), state);
  check('Manufacturing Engineering imports the first master WI as a Draft', wi.ok && state.masterWIs.length === 1 && state.masterWIs[0].status === 'Draft', wi.message);
  check('the workspace still validates after the first records', MES.validate(state) === true && MES.verifyManifests(state).ok === true, JSON.stringify(MES.diagnose(state)));
  const po = prod.withAccount(admin, () => FlightPlan.addPlannedOrder(state, { masterWI: `${state.masterWIs[0].id}|A`, pedigree: 'Production', subcategory: 'Mfg.', aircraft: MES.AIRCRAFT[0], site: null, quantity: 1, needDate: '2026-12-01' }), state);
  // Kit lines come from the released WI's operation BOM (Codex review on #331); a WI without a BOM starts empty.
  const bomState = load(prod, MES.seed());
  bomState.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const bomWi = bomState.masterWIs.find(w => w.status === 'Released');
  bomWi.operations[0].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 2 }];
  const fromWi = prod.withAccount(admin, () => MES.addOrder(bomState, { masterWI: `${bomWi.id}|${bomWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), bomState);
  const bomOrder = fromWi.ok ? MES.getOrder(bomState, fromWi.id) : null;
  check('a work order from a WI with an operation BOM starts its kit with those lines, unverified', !!bomOrder && bomOrder.materials.length === 1 && bomOrder.materials[0].partNumber === 'BOM-001' && bomOrder.materials[0].required === 2 && bomOrder.materials[0].ready === false && MES.validate(bomState) === true, fromWi.message);
  const advanced = prod.withAccount(admin, () => { const o = MES.getOrder(bomState, fromWi.id); if (MES.requiresReleaseQA(o)) o.release = { status: 'Approved', name: 'QA Peer', role: 'Quality Engineer', credentialId: 'ACCT-qapeer', at: new Date().toISOString(), note: 'test' }; MES.advance(bomState, fromWi.id); o.kitFiles = [{ id: 'f1', name: 'kit.pdf' }]; return MES.advance(bomState, fromWi.id); }, bomState);
  check('Building stays refused until that BOM line is kitted with a verified lot', !advanced.ok && /Confirm all materials/.test(advanced.message || '') && MES.getOrder(bomState, fromWi.id).status === 'Kitting', advanced.message);
  // WI BOM lines are per unit (Codex review on #331): a quantity-5 order needs five times each line, and a part on two
  // operations is one kit line. An order whose kit would pass the kit limits is refused before anything is created.
  const qtyState = load(prod, MES.seed());
  qtyState.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const qtyWi = qtyState.masterWIs.find(w => w.status === 'Released');
  qtyWi.operations[0].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 2 }];
  qtyWi.operations[1].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 1 }, { partNumber: 'BOM-002', name: 'Clip', required: 3 }];
  const mk = (st, q) => prod.withAccount(admin, () => MES.addOrder(st, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: q, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), st);
  const five = mk(qtyState, 5), fiveOrder = five.ok ? MES.getOrder(qtyState, five.id) : null;
  const need = part => (fiveOrder ? fiveOrder.materials.find(m => m.partNumber === part) || {} : {}).required;
  check('a quantity-5 order kits each WI BOM line times 5, one line per part', !!fiveOrder && fiveOrder.materials.length === 2 && need('BOM-001') === 15 && need('BOM-002') === 15 && MES.validate(qtyState) === true, five.message);
  if (fiveOrder) {
    const opNeed = (o, i, part) => ((o.operations[i].materials || []).find(m => m.partNumber === part) || {}).required;
    const split = prod.withAccount(admin, () => MES.splitOrder(qtyState, fiveOrder.id, 2), qtyState);
    const child = split.ok ? MES.getOrder(qtyState, split.id) : null, kitOf = (o, part) => (o.materials.find(m => m.partNumber === part) || {}).required;
    check('splitting 2 of 5 units divides the kit by quantity: 9 stay, 6 move', !!child && fiveOrder.quantity === 3 && kitOf(fiveOrder, 'BOM-001') === 9 && kitOf(fiveOrder, 'BOM-002') === 9 && kitOf(child, 'BOM-001') === 6 && kitOf(child, 'BOM-002') === 6 && MES.validate(qtyState) === true, split.message);
    check('the operation BOM lines are divided the same way', !!child && opNeed(fiveOrder, 0, 'BOM-001') === 6 && opNeed(child, 0, 'BOM-001') === 4 && opNeed(fiveOrder, 1, 'BOM-002') === 9 && opNeed(child, 1, 'BOM-002') === 6, split.message);
    const removed = prod.withAccount(admin, () => MES.removeOrderOperation(qtyState, fiveOrder.id, fiveOrder.operations[0].id, 'Not needed on this order'), qtyState);
    check('removing an operation takes its share off a kit line it shares: 9 less 6 leaves 3', removed.ok && kitOf(fiveOrder, 'BOM-001') === 3 && kitOf(fiveOrder, 'BOM-002') === 9 && MES.validate(qtyState) === true, removed.message);
  }
  {
    // Split rounding across operations (Codex review on #331): the kit is the sum of the rounded operation shares, so
    // on each order the kit line and its operations' BOM lines agree. Stored op lines of 1 and 2 on a quantity-3 order.
    const rs = load(prod, MES.seed());
    rs.masterWIs = JSON.parse(JSON.stringify(qtyState.masterWIs));
    const rw = rs.masterWIs.find(w => w.id === qtyWi.id && w.revision === qtyWi.revision);
    rw.operations[0].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 1 }];
    rw.operations[1].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 1 }];
    const made = prod.withAccount(admin, () => MES.addOrder(rs, { masterWI: `${rw.id}|${rw.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 3, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), rs);
    const o = made.ok ? MES.getOrder(rs, made.id) : null;
    if (o) { o.operations[0].materials[0].required = 1; o.operations[1].materials[0].required = 2; o.materials[0].required = 3; }
    const sp = o ? prod.withAccount(admin, () => MES.splitOrder(rs, o.id, 1), rs) : { message: 'order not created' };
    const c = sp.ok ? MES.getOrder(rs, sp.id) : null, opSum = x => x.operations.reduce((n, op) => n + (op.materials || []).filter(m => m.partNumber === 'BOM-001').reduce((k, m) => k + m.required, 0), 0);
    check('a split derives each kit line from the rounded operation shares, so kit and operations agree on both orders', !!c && o.materials[0].required === opSum(o) && c.materials[0].required === opSum(c) && opSum(o) === 3 && opSum(c) === 2 && MES.validate(rs) === true, `${sp.message} ${o && o.materials[0].required}/${o && opSum(o)} ${c && c.materials[0].required}/${c && opSum(c)}`);
  }
  {
    // QA rejecting a sequence change restores the kit with the operations (Codex review on #331): a removal that took a
    // shared share off a kit line, and an added operation's BOM line, both roll back.
    const sq = load(prod, MES.seed());
    sq.masterWIs = JSON.parse(JSON.stringify(qtyState.masterWIs));
    const sw = sq.masterWIs.find(w => w.id === qtyWi.id && w.revision === qtyWi.revision);
    sw.operations[0].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 2 }];
    sw.operations[1].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 3 }];
    const made = prod.withAccount(admin, () => MES.addOrder(sq, { masterWI: `${sw.id}|${sw.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 2, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), sq);
    const o = made.ok ? MES.getOrder(sq, made.id) : null, need = part => ((o && o.materials.find(m => m.partNumber === part)) || {}).required;
    const removed = o ? prod.withAccount(me, () => MES.removeOrderOperation(sq, o.id, o.operations[0].id, 'Not needed on this order'), sq) : { message: 'order not created' };
    const added = o ? prod.withAccount(me, () => MES.addOrderOperation(sq, o.id, { title: 'Fit clip', description: 'Fit the clip', steps: 'Fit clip', position: o.operations.length, buyoffType: 'Technician', classification: 'Manufacturing', callouts: [], bom: [{ partNumber: 'BOM-009', name: 'Clip', required: 4 }] }), sq) : { message: 'order not created' };
    const during = { a: need('BOM-001'), b: need('BOM-009') };
    check('an added operation\'s BOM lines are per unit: 4 per unit on a quantity-2 order kits 8 and stores 8 on the operation', added.ok && during.b === 8 && ((o.operations.find(op => op.id === added.opId) || {}).materials || [])[0]?.required === 8, `${added.message} ${during.b}`);
    const rejected = o ? prod.withAccount(qa, () => MES.rejectSequenceChange(sq, o.id, 'Keep the released sequence for this order.'), sq) : { message: 'order not created' };
    check('rejecting a sequence change restores the kit: the removed share comes back (10) and the added operation\'s line goes', removed.ok && added.ok && during.a === 6 && during.b === 8 && rejected.ok && need('BOM-001') === 10 && need('BOM-009') === undefined && MES.validate(sq) === true, `${removed.message} | ${added.message} | ${rejected.message} | during ${JSON.stringify(during)} after ${need('BOM-001')}/${need('BOM-009')}`);
    // An added operation's BOM can't add to a kit line already issued (Codex security review on #331), nothing changed.
    if (o) { const m = o.materials.find(x => x.partNumber === 'BOM-001'); if (m) Object.assign(m, { ready: true, lot: 'LOT-ISSUED-1' }); }
    const issuedBefore = o && JSON.stringify(o);
    const onIssued = o ? prod.withAccount(me, () => MES.addOrderOperation(sq, o.id, { title: 'Fit bracket', description: 'Fit another bracket', steps: 'Fit bracket', position: o.operations.length, buyoffType: 'Technician', classification: 'Manufacturing', callouts: [], bom: [{ partNumber: 'BOM-001', name: 'Bracket', required: 1 }] }), sq) : { message: 'order not created' };
    check('an added operation\'s BOM that reuses an issued kit part is refused with the next step, the order unchanged', !onIssued.ok && /already issued to this order/.test(onIssued.message) && JSON.stringify(o) === issuedBefore, onIssued.message);
    // During Building every kit line must be verified, so an added operation can't bring a new kit part.
    if (o) o.status = 'Building';
    const buildBefore = o && JSON.stringify(o);
    const inBuild = o ? prod.withAccount(me, () => MES.addOrderOperation(sq, o.id, { title: 'Fit washer', description: 'Fit the washer', steps: 'Fit washer', position: o.operations.length, buyoffType: 'Technician', classification: 'Manufacturing', callouts: [], bom: [{ partNumber: 'NEW-WASHER', name: 'Washer', required: 1 }] }), sq) : { message: 'order not created' };
    check('during Building an added operation\'s BOM with a new kit part is refused with the next step, the order unchanged', !inBuild.ok && /The build has started/.test(inBuild.message) && JSON.stringify(o) === buildBefore, inBuild.message);
    if (o) o.status = 'Draft';
    // An operation whose BOM would take the kit past 20 lines is refused before anything changes.
    if (o) { o.materials = Array.from({ length: 20 }, (_, n) => ({ id: `kit-f${n}`, name: `Part ${n}`, partNumber: `FULL-${n}`, required: 1, ready: false })); }
    const fullBefore = o && JSON.stringify(o.materials);
    const full = o ? prod.withAccount(me, () => MES.addOrderOperation(sq, o.id, { title: 'Fit cap', description: 'Fit the cap', steps: 'Fit cap', position: o.operations.length, buyoffType: 'Technician', classification: 'Manufacturing', callouts: [], bom: [{ partNumber: 'NEW-CAP', name: 'Cap', required: 1 }] }), sq) : { message: 'order not created' };
    check('adding an operation whose BOM would take the kit past 20 lines is refused, the kit unchanged', !full.ok && /a work order kit holds up to 20/.test(full.message) && JSON.stringify(o.materials) === fullBefore, full.message);
  }
  {
    const ecState = load(prod, MES.seed());
    ecState.masterWIs = JSON.parse(JSON.stringify(qtyState.masterWIs));
    const make = () => { const r = mk(ecState, 5); return r.ok ? MES.getOrder(ecState, r.id) : null; };
    const changeQty = (o, quantity) => {
      const sub = prod.withAccount(me, () => MES.submitEngineeringChange(ecState, o.id, { reason: 'Customer changed the quantity.', quantity }), ecState);
      if (!sub.ok) return sub;
      if (MES.engineeringChange(o).status === 'Awaiting ECR') { const ecr = prod.withAccount(qa, () => MES.approveECR(ecState, o.id), ecState); if (!ecr.ok) return ecr; }
      return prod.withAccount(qa, () => MES.approveEngineeringChange(ecState, o.id), ecState);
    };
    const kitOf = (o, part) => (o.materials.find(m => m.partNumber === part) || {}).required;
    const up = make(), upResult = up ? changeQty(up, 10) : { message: 'order not created' };
    check('an engineering change from 5 to 10 units rescales the kit and the operation BOM: 15 becomes 30', upResult.ok && up.quantity === 10 && kitOf(up, 'BOM-001') === 30 && kitOf(up, 'BOM-002') === 30 && (up.operations[0].materials || [])[0]?.required === 20 && MES.validate(ecState) === true, upResult.message);
    const issued = make();
    if (issued) { const line = issued.materials.find(m => m.partNumber === 'BOM-001'); line.lot = 'LOT-EC-1'; line.ready = true; }
    const issuedBefore = issued && JSON.stringify({ materials: issued.materials, ops: issued.operations.map(op => op.materials || null), quantity: issued.quantity });
    const refused = issued ? changeQty(issued, 10) : { message: 'order not created' };
    check('an engineering quantity change that would rescale an issued kit line is refused at QA re-release, nothing changed', !refused.ok && /already issued to this order for 5 units/.test(refused.message) && JSON.stringify({ materials: issued.materials, ops: issued.operations.map(op => op.materials || null), quantity: issued.quantity }) === issuedBefore, refused.message);
    // Only the BOM share of a kit line rescales; what it holds beyond its operations' BOM lines stays (Codex on #331).
    const based = make();
    if (based) based.materials.find(m => m.partNumber === 'BOM-002').required += 1;
    const basedResult = based ? changeQty(based, 10) : { message: 'order not created' };
    check('a quantity change rescales only the BOM share of a kit line: 15 plus 1 becomes 30 plus 1', basedResult.ok && kitOf(based, 'BOM-002') === 31 && MES.validate(ecState) === true, `${basedResult.message} ${based && kitOf(based, 'BOM-002')}`);
    // A quantity re-release waits for a sequence change awaiting QA, whose rollback would restore the old quantity.
    const seq = make();
    if (seq) seq.sequenceChange = { status: 'Awaiting QA', entries: [], requestedBy: { name: 'Robin Engineer', role: 'Manufacturing Engineer', credentialId: 'ACCT-me-lee' }, requestedAt: now };
    const seqBefore = seq && JSON.stringify(seq);
    const seqResult = seq ? changeQty(seq, 10) : { message: 'order not created' };
    check('a quantity re-release is refused while a sequence change awaits QA, the order unchanged', !seqResult.ok && /sequence change on this order is awaiting QA/.test(seqResult.message) && seq.quantity === 5, seqResult.message);
  }
  {
    // Only a drawn kit line survives a sequence rollback or an operation removal (Codex review on #331): a lot chosen
    // but not verified has issued nothing, so the added operation's line goes; a verified line stays as recorded.
    const ls = load(prod, MES.seed());
    ls.masterWIs = JSON.parse(JSON.stringify(qtyState.masterWIs));
    const toKitting = o => prod.withAccount(admin, () => { if (MES.requiresReleaseQA(o)) o.release = { status: 'Approved', name: 'QA Peer', role: 'Quality Engineer', credentialId: 'ACCT-qapeer', at: new Date().toISOString(), note: 'test' }; return MES.advance(ls, o.id); }, ls);
    prod.withAccount(admin, () => MES.postInventoryTransaction(ls, { type: 'Receive', partNumber: 'BOM-009', lot: 'LOT-CLIP-1', quantity: 40, buildClass: 'Production', conformityStatus: 'Accepted', conformityRef: 'NS-LOT-CLIP-1', note: 'Receipt for the rollback test' }), ls);
    const clipOp = { title: 'Fit clip', description: 'Fit the clip', steps: 'Fit clip', buyoffType: 'Technician', classification: 'Manufacturing', callouts: [], bom: [{ partNumber: 'BOM-009', name: 'Clip', required: 4 }] };
    const order = () => { const r = prod.withAccount(admin, () => MES.addOrder(ls, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 2, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), ls); const o = r.ok ? MES.getOrder(ls, r.id) : null; return o && toKitting(o).ok ? o : null; };
    const addClip = o => prod.withAccount(me, () => MES.addOrderOperation(ls, o.id, { ...clipOp, position: o.operations.length }), ls);
    const clip = o => o.materials.find(m => m.partNumber === 'BOM-009');
    const pick = (o, verify) => prod.withAccount(admin, () => { const a = MES.setMaterialLot(ls, o.id, clip(o).id, 'LOT-CLIP-1'); return a.ok && verify ? MES.setMaterial(ls, o.id, clip(o).id, true) : a; }, ls);
    const reject = o => prod.withAccount(qa, () => MES.rejectSequenceChange(ls, o.id, 'Keep the released sequence for this order.'), ls);
    const issued = o => -(ls.inventoryLedger.transactions.filter(t => t.orderId === o.id && t.partNumber === 'BOM-009').reduce((n, t) => n + t.quantity, 0));
    const a = order(), aAdd = a && addClip(a), aPick = aAdd && aAdd.ok && pick(a, false), aRej = aPick && aPick.ok && reject(a);
    check('rejecting a sequence change removes the added operation\'s kit line when its lot was chosen but not verified', !!aRej && aRej.ok && clip(a) === undefined && issued(a) === 0 && MES.validate(ls) === true, `${aAdd && aAdd.message} | ${aPick && aPick.message} | ${aRej && aRej.message}`);
    const b = order(), bAdd = b && addClip(b), bPick = bAdd && bAdd.ok && pick(b, true), bRej = bPick && bPick.ok && reject(b);
    check('a verified kit line stays as recorded when the sequence change is rejected (its 8 stay issued to the order)', !!bRej && bRej.ok && !!clip(b) && clip(b).ready === true && issued(b) === 8 && MES.validate(ls) === true, `${bAdd && bAdd.message} | ${bPick && bPick.message} | ${bRej && bRej.message}`);
    check('the kept verified line names no removed operation after the rollback', !!clip(b) && clip(b).forOps === undefined, JSON.stringify(clip(b) && clip(b).forOps));
    const c = order(), cAdd = c && addClip(c), cPick = cAdd && cAdd.ok && pick(c, false);
    const cRem = cPick && cPick.ok && prod.withAccount(me, () => MES.removeOrderOperation(ls, c.id, cAdd.opId, 'Not needed on this order'), ls);
    check('removing an operation removes its kit line when the lot was chosen but not verified', !!cRem && cRem.ok && clip(c) === undefined && MES.validate(ls) === true, `${cAdd && cAdd.message} | ${cPick && cPick.message} | ${cRem && cRem.message}`);
    // Issue #545: a lot chosen but not verified has issued nothing, so another operation's BOM can add to that line.
    const e = order(), eAdd = e && addClip(e), ePick = eAdd && eAdd.ok && pick(e, false), eMore = ePick && ePick.ok && addClip(e);
    check('an added operation\'s BOM adds to a kit line whose lot was chosen but not verified (8 plus 8)', !!eMore && eMore.ok && clip(e).required === 16 && clip(e).lot === 'LOT-CLIP-1' && clip(e).ready === false && issued(e) === 0 && MES.validate(ls) === true, `${eAdd && eAdd.message} | ${ePick && ePick.message} | ${eMore && eMore.message}`);
    const f = order(), fAdd = f && addClip(f), fPick = fAdd && fAdd.ok && pick(f, true), fBefore = f && JSON.stringify(f), fMore = fPick && fPick.ok && addClip(f);
    check('an added operation\'s BOM on a verified kit line is still refused with the next step, the order unchanged', !!fMore && !fMore.ok && /already issued to this order/.test(fMore.message) && JSON.stringify(f) === fBefore, fMore && fMore.message);
  }
  {
    // Issue #614: a rollback that needs more than a drawn line holds is refused until the line goes back to stock. A
    // released op needing 5 of BOM-007 is removed and replaced by one needing 1; the 1 is issued; QA rejects.
    const rb = load(prod, MES.seed());
    rb.masterWIs = JSON.parse(JSON.stringify(qtyState.masterWIs));
    const rw = rb.masterWIs.find(w => w.id === qtyWi.id && w.revision === qtyWi.revision);
    rw.operations.forEach((op, i) => { if (i === 0) op.materials = [{ partNumber: 'BOM-007', name: 'Spacer', required: 5 }]; else delete op.materials; });
    prod.withAccount(admin, () => MES.postInventoryTransaction(rb, { type: 'Receive', partNumber: 'BOM-007', lot: 'LOT-SPACER-1', quantity: 40, buildClass: 'Production', conformityStatus: 'Accepted', conformityRef: 'NS-LOT-SPACER-1', note: 'Receipt for the rollback shortfall test' }), rb);
    const toKitting = o => prod.withAccount(admin, () => { if (MES.requiresReleaseQA(o)) o.release = { status: 'Approved', name: 'QA Peer', role: 'Quality Engineer', credentialId: 'ACCT-qapeer', at: new Date().toISOString(), note: 'test' }; return MES.advance(rb, o.id); }, rb);
    const order = () => { const r = prod.withAccount(admin, () => MES.addOrder(rb, { masterWI: `${rw.id}|${rw.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), rb); const o = r.ok ? MES.getOrder(rb, r.id) : null; return o && toKitting(o).ok ? o : null; };
    const spacer = o => o.materials.find(m => m.partNumber === 'BOM-007');
    const verify = (o, ready) => prod.withAccount(admin, () => { const m = spacer(o); const a = ready ? MES.setMaterialLot(rb, o.id, m.id, 'LOT-SPACER-1') : { ok: true }; return a.ok ? MES.setMaterial(rb, o.id, m.id, ready) : a; }, rb);
    const remove = (o, opId) => prod.withAccount(me, () => MES.removeOrderOperation(rb, o.id, opId, 'Replaced on this order'), rb);
    const reject = o => prod.withAccount(qa, () => MES.rejectSequenceChange(rb, o.id, 'Keep the released sequence for this order.'), rb);
    const issued = o => -(rb.inventoryLedger.transactions.filter(t => t.orderId === o.id && t.partNumber === 'BOM-007').reduce((n, t) => n + t.quantity, 0));
    const a = order(), first = a && a.operations[0].id;
    const aRem = a && remove(a, first);
    const aAdd = aRem && aRem.ok && prod.withAccount(me, () => MES.addOrderOperation(rb, a.id, { title: 'Fit spacer', description: 'Fit one spacer', steps: 'Fit spacer', position: a.operations.length, buyoffType: 'Technician', classification: 'Manufacturing', callouts: [], bom: [{ partNumber: 'BOM-007', name: 'Spacer', required: 1 }] }), rb);
    const aPick = aAdd && aAdd.ok && verify(a, true);
    const before = a && JSON.stringify(rb);
    const refused = aPick && aPick.ok && reject(a);
    check('setup: the replacement operation\'s line of 1 is issued while the sequence change awaits QA', !!aPick && aPick.ok && spacer(a).required === 1 && spacer(a).ready === true && issued(a) === 1, `${aRem && aRem.message} | ${aAdd && aAdd.message} | ${aPick && aPick.message}`);
    check('rejecting a sequence change that would leave a drawn line short of the released need is refused with the next step, nothing changed', !!refused && !refused.ok && /has 1 drawn for the changed operations, and the released sequence needs 5/.test(refused.message) && /Mark it missing on the Kitting tab/.test(refused.message) && JSON.stringify(rb) === before, refused && refused.message);
    const withdrawn = a && prod.withAccount(me, () => MES.rejectSequenceChange(rb, a.id, 'Withdraw the replacement.', 'withdraw'), rb);
    check('withdrawing the same sequence change is refused the same way, nothing changed', !!withdrawn && !withdrawn.ok && /released sequence needs 5/.test(withdrawn.message) && JSON.stringify(rb) === before, withdrawn && withdrawn.message);
    // Outside Kitting a kit line can't go back to stock, so the refusal names the way forward that exists.
    if (a) a.status = 'Building';
    const building = a && reject(a);
    if (a) a.status = 'Kitting';
    check('outside Kitting the same refusal says to release the change and add the operation back, nothing changed', !!building && !building.ok && /goes back to stock only during Kitting, so QA can release the change instead/.test(building.message) && JSON.stringify(rb) === before, building && building.message);
    const back = a && verify(a, false), done = back && back.ok && reject(a);
    check('once the line is marked missing (its 1 back to stock) the rejection restores the released kit: 5 for the restored operation', !!done && done.ok && spacer(a).required === 5 && spacer(a).ready === false && JSON.stringify(spacer(a).forOps) === JSON.stringify([first]) && issued(a) === 0 && MES.validate(rb) === true, `${back && back.message} | ${done && done.message} | ${JSON.stringify(a && spacer(a))}`);
    // A drawn line whose own operation was removed and is restored by the rollback covers it: no refusal.
    const b = order(), bFirst = b && b.operations[0].id, bPick = b && verify(b, true), bRem = bPick && bPick.ok && remove(b, bFirst), bRej = bRem && bRem.ok && reject(b);
    check('a drawn line kept through an operation removal covers that operation when the rollback restores it', !!bRej && bRej.ok && spacer(b).required === 5 && spacer(b).ready === true && JSON.stringify(spacer(b).forOps) === JSON.stringify([bFirst]) && issued(b) === 5 && MES.validate(rb) === true, `${bPick && bPick.message} | ${bRem && bRem.message} | ${bRej && bRej.message}`);
    // Codex on #331: a kit line holding more than its only operation's BOM share (a starter kit line merged with the
    // BOM) goes back to that baseline when the operation is removed, and the rollback adds the share back.
    const c = order(), cFirst = c && c.operations[0].id;
    if (c) spacer(c).required += 1;
    const cRem = c && remove(c, cFirst);
    check('removing the only operation of a kit line with a baseline keeps the baseline (6 less 5 leaves 1)', !!cRem && cRem.ok && !!spacer(c) && spacer(c).required === 1 && Array.isArray(spacer(c).forOps) && spacer(c).forOps.length === 0 && MES.validate(rb) === true, `${cRem && cRem.message} ${JSON.stringify(c && spacer(c))}`);
    const cRej = cRem && cRem.ok && reject(c);
    check('rejecting that change adds the restored operation\'s share back to the baseline (1 plus 5)', !!cRej && cRej.ok && spacer(c).required === 6 && JSON.stringify(spacer(c).forOps) === JSON.stringify([cFirst]) && MES.validate(rb) === true, `${cRej && cRej.message} ${JSON.stringify(c && spacer(c))}`);
    const d = order(), dRem = d && remove(d, d.operations[0].id);
    check('removing the only operation of a kit line with no baseline still removes the line', !!dRem && dRem.ok && spacer(d) === undefined && MES.validate(rb) === true, dRem && dRem.message);
  }
  {
    // A split moves the issued share of a kit line on the inventory ledger too (Codex review on #331): a return from
    // the parent and an issue to the new order, so each order holds what it was issued and marking a line missing
    // later returns only that order's share.
    const ledState = load(prod, MES.seed());
    ledState.masterWIs = JSON.parse(JSON.stringify(qtyState.masterWIs));
    const toKitting = o => prod.withAccount(admin, () => { if (MES.requiresReleaseQA(o)) o.release = { status: 'Approved', name: 'QA Peer', role: 'Quality Engineer', credentialId: 'ACCT-qapeer', at: new Date().toISOString(), note: 'test' }; return MES.advance(ledState, o.id); }, ledState);
    const receive = (part, lot, qty) => prod.withAccount(admin, () => MES.postInventoryTransaction(ledState, { type: 'Receive', partNumber: part, lot, quantity: qty, buildClass: 'Production', conformityStatus: 'Accepted', conformityRef: `NS-${lot}`, note: 'Receipt for the split test' }), ledState);
    const kitLine = (o, part, lot) => prod.withAccount(admin, () => { const m = o.materials.find(x => x.partNumber === part); const a = MES.setMaterialLot(ledState, o.id, m.id, lot); return a.ok ? MES.setMaterial(ledState, o.id, m.id, true) : a; }, ledState);
    const net = (orderId, part, lot) => -(ledState.inventoryLedger.transactions.filter(t => t.orderId === orderId && t.partNumber === part && t.lot === lot && ['Issue', 'Return'].includes(t.type)).reduce((n, t) => n + t.quantity, 0));
    const onHand = (part, lot) => (MES.inventoryLots(ledState, part).find(x => x.lot === lot) || {}).onHand;
    const r1 = prod.withAccount(admin, () => MES.addOrder(ledState, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 5, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), ledState);
    const o1 = r1.ok ? MES.getOrder(ledState, r1.id) : null;
    const setup = o1 && toKitting(o1).ok && receive('BOM-001', 'LOT-SPLIT-1', 40).ok && kitLine(o1, 'BOM-001', 'LOT-SPLIT-1');
    check('setup: a quantity-5 order in Kitting has 15 of BOM-001 issued from a received lot', !!setup && setup.ok && net(o1.id, 'BOM-001', 'LOT-SPLIT-1') === 15 && onHand('BOM-001', 'LOT-SPLIT-1') === 25, setup && setup.message);
    const sp = o1 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o1.id, 2), ledState) : { message: 'order not created' };
    const c1 = sp.ok ? MES.getOrder(ledState, sp.id) : null, line = (o, part) => o.materials.find(m => m.partNumber === part);
    check('splitting an issued kit line moves the new order\'s share on the ledger: 9 stay issued, 6 are issued to the new order, stock unchanged', !!c1 && net(o1.id, 'BOM-001', 'LOT-SPLIT-1') === 9 && net(c1.id, 'BOM-001', 'LOT-SPLIT-1') === 6 && line(o1, 'BOM-001').required === 9 && line(c1, 'BOM-001').required === 6 && line(c1, 'BOM-001').ready === true && onHand('BOM-001', 'LOT-SPLIT-1') === 25 && MES.validate(ledState) === true, sp.message);
    const missing = o1 ? prod.withAccount(admin, () => MES.setMaterial(ledState, o1.id, line(o1, 'BOM-001').id, false), ledState) : { message: 'order not created' };
    check('marking the parent line missing afterwards returns only the parent\'s 9, not the full 15', missing.ok && net(o1.id, 'BOM-001', 'LOT-SPLIT-1') === 0 && net(c1.id, 'BOM-001', 'LOT-SPLIT-1') === 6 && onHand('BOM-001', 'LOT-SPLIT-1') === 34, missing.message);
    // Refusals, with nothing changed: a lot no longer Accepted can't be issued to the new order.
    const r2 = prod.withAccount(admin, () => MES.addOrder(ledState, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 5, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), ledState);
    const o2 = r2.ok ? MES.getOrder(ledState, r2.id) : null;
    const ok2 = o2 && toKitting(o2).ok && receive('BOM-002', 'LOT-HOLD-1', 20).ok && kitLine(o2, 'BOM-002', 'LOT-HOLD-1').ok;
    const hold = ok2 && prod.withAccount(admin, () => MES.postInventoryTransaction(ledState, { type: 'Conformity', partNumber: 'BOM-002', lot: 'LOT-HOLD-1', quantity: 0, conformityStatus: 'Hold', conformityRef: 'NS-HOLD', note: 'Supplier escape under review' }), ledState);
    const holdBefore = JSON.stringify(ledState);
    const held = o2 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o2.id, 2), ledState) : { message: 'order not created' };
    check('a split over an issued line whose lot is now on Hold is refused with the reason, nothing changed', !!hold && hold.ok && !held.ok && /LOT-HOLD-1 of BOM-002 is Hold for conformity/.test(held.message) && JSON.stringify(ledState) === holdBefore, held.message);
    // Too little issued to give each order a share: refused, nothing changed.
    if (o2) { const m = line(o2, 'BOM-002'); const back = prod.withAccount(admin, () => MES.postInventoryTransaction(ledState, { type: 'Conformity', partNumber: 'BOM-002', lot: 'LOT-HOLD-1', quantity: 0, conformityStatus: 'Accepted', conformityRef: 'NS-HOLD-OK', note: 'Released after review' }), ledState); if (back.ok) { prod.withAccount(admin, () => MES.setMaterial(ledState, o2.id, m.id, false), ledState); m.required = 1; prod.withAccount(admin, () => MES.setMaterial(ledState, o2.id, m.id, true), ledState); } }
    const fewBefore = JSON.stringify(ledState);
    const few = o2 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o2.id, 2), ledState) : { message: 'order not created' };
    check('a split whose issued quantity can\'t cover both orders\' rounded needs is refused with the next step, nothing changed', !few.ok && /has 1 issued from lot LOT-HOLD-1, but after the split the two orders need/.test(few.message) && /Mark it missing on the Kitting tab/.test(few.message) && JSON.stringify(ledState) === fewBefore, few.message);
    // A ready kit line the ledger doesn't show as issued (an older workspace) refuses the split until it is reconciled.
    const r5 = prod.withAccount(admin, () => MES.addOrder(ledState, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 5, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), ledState);
    const o5 = r5.ok ? MES.getOrder(ledState, r5.id) : null;
    // LOT-SPLIT-1 is on the ledger (received above), so a ready line citing it must show this order's issue.
    if (o5) { toKitting(o5); Object.assign(line(o5, 'BOM-001'), { ready: true, lot: 'LOT-SPLIT-1' }); }
    const oldBefore = JSON.stringify(ledState);
    const oldSplit = o5 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o5.id, 2), ledState) : { message: 'order not created' };
    check('a split over a ready kit line with no ledger issue is refused until it is reconciled, nothing changed', !oldSplit.ok && /ledger shows no issue of it to this order/.test(oldSplit.message) && /verify it again so the issue is recorded/.test(oldSplit.message) && JSON.stringify(ledState) === oldBefore, oldSplit.message);
    // A lot the ledger doesn't track at all (an older workspace, or the demo sample) has nothing to move: the split
    // divides the line's requirement and posts no ledger rows.
    if (o5) Object.assign(line(o5, 'BOM-001'), { lot: 'LOT-NOT-ON-LEDGER' });
    const rowsBefore = ledState.inventoryLedger.transactions.length;
    const untracked = o5 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o5.id, 2), ledState) : { message: 'order not created' };
    check('a split over a ready line whose lot the ledger does not track divides the requirement and posts no ledger rows', untracked.ok && ledState.inventoryLedger.transactions.length === rowsBefore && MES.validate(ledState) === true, untracked.message);
    // A split waits for a pending sequence change, as a split request already does (Codex review on #331).
    const r4 = prod.withAccount(admin, () => MES.addOrder(ledState, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 5, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), ledState);
    const o4 = r4.ok ? MES.getOrder(ledState, r4.id) : null;
    if (o4) o4.sequenceChange = { status: 'Awaiting QA', entries: [], requestedBy: { name: 'Robin Engineer', role: 'Manufacturing Engineer', credentialId: 'ACCT-me-lee' }, requestedAt: now };
    const seqBefore = JSON.stringify(ledState);
    const seqSplit = o4 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o4.id, 2), ledState) : { message: 'order not created' };
    check('a split is refused while a sequence change awaits QA, nothing changed', !seqSplit.ok && /QA must release the updated sequence/.test(seqSplit.message) && JSON.stringify(ledState) === seqBefore, seqSplit.message);
    // A sub-assembly issued from another work order (Codex review and Jinx #482 on #331). The kit line records what the
    // order needs, not what the source order issued, so a split over it is refused, by lot or by serial, nothing changed.
    const r3 = prod.withAccount(admin, () => MES.addOrder(ledState, { masterWI: `${qtyWi.id}|${qtyWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 5, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), ledState);
    const o3 = r3.ok ? MES.getOrder(ledState, r3.id) : null;
    const src = serials => ({ orderId: 'WO-SUB-1', lotNumber: 'LOT-SUB-1', serials, revision: 'A', issuedAt: now, issuedBy: { name: 'Go Live', role: 'Administrator', credentialId: 'ACCT-go-live' } });
    if (o3) { toKitting(o3); const m = line(o3, 'BOM-002'); Object.assign(m, { ready: true, lot: 'LOT-SUB-1', required: 7, source: src([]) }); }
    const lotBefore = JSON.stringify(ledState);
    const lotSplit = o3 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o3.id, 2), ledState) : { message: 'order not created' };
    check('a split over a sub-assembly issued by lot (7 needed, a partial fill possible) is refused with the next step, nothing changed', !lotSplit.ok && /filled from WO-SUB-1 with lot LOT-SUB-1/.test(lotSplit.message) && /Return it on the Kitting tab/.test(lotSplit.message) && JSON.stringify(ledState) === lotBefore, lotSplit.message);
    if (o3) Object.assign(line(o3, 'BOM-002'), { source: src(['SUB-SN-1', 'SUB-SN-2']) });
    const serialBefore = JSON.stringify(ledState);
    const serialSplit = o3 ? prod.withAccount(admin, () => MES.splitOrder(ledState, o3.id, 1), ledState) : { message: 'order not created' };
    check('a split over a serialized sub-assembly line is refused with the next step, nothing changed', !serialSplit.ok && /SUB-SN-1, SUB-SN-2/.test(serialSplit.message) && /Return it on the Kitting tab/.test(serialSplit.message) && JSON.stringify(ledState) === serialBefore, serialSplit.message);
  }
  const before = JSON.stringify(qtyState);
  const tooMany = mk(qtyState, 400);
  check('an order that would need more than 999 of one part is refused before anything is created', !tooMany.ok && /a kit line holds up to 999/.test(tooMany.message) && JSON.stringify(qtyState) === before, tooMany.message);
  qtyWi.operations[0].materials = Array.from({ length: 12 }, (_, n) => ({ partNumber: `WIDE-A${n}`, name: `Part A${n}`, required: 1 }));
  qtyWi.operations[1].materials = Array.from({ length: 12 }, (_, n) => ({ partNumber: `WIDE-B${n}`, name: `Part B${n}`, required: 1 }));
  const wideBefore = JSON.stringify(qtyState);
  const wide = mk(qtyState, 1);
  check('an order whose WI lists more than 20 BOM parts is refused with a plain reason, nothing created', !wide.ok && /would need 24 different kit parts/.test(wide.message) && /up to 20 lines/.test(wide.message) && JSON.stringify(qtyState) === wideBefore, wide.message);
  const adhoc = prod.withAccount(admin, () => MES.addAdhocOrder(state, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], partNumber: 'GL-PART-001', title: 'First production order', revision: 'A' }), state);
  const first = adhoc.ok ? MES.getOrder(state, adhoc.id) : null;
  check('a production work order starts with an empty kit, not the sample kit lines, and validates', !!first && Array.isArray(first.materials) && first.materials.length === 0 && MES.validate(state) === true, adhoc.message);
  if (first) {
    // With an empty kit allowed, the only issued sub-assembly line can be returned (Codex review on #331).
    const ret = JSON.parse(JSON.stringify(state)), wo = ret.orders.find(o => o.id === first.id);
    wo.status = 'Kitting';
    wo.materials = [{ id: 'sub-1', name: 'Harness', partNumber: 'SUB-001', required: 1, ready: true, lot: 'LOT-SUB-9', source: { orderId: 'WO-SUB-9', lotNumber: 'LOT-SUB-9', serials: [], revision: 'A', issuedAt: now, issuedBy: { name: 'Go Live', role: 'Administrator', credentialId: 'ACCT-go-live' } } }];
    const back = prod.withAccount(admin, () => MES.returnIssuedOrder(ret, wo.id, 'sub-1', 'Issued to the wrong order'), ret);
    check('the only issued sub-assembly line on a kit can be returned, leaving a valid empty kit', back.ok && wo.materials.length === 0, back.message);
    const jsx = read('../src/react/flight-ui.jsx');
    check('the React kit view explains an empty kit as the legacy view does', jsx.includes('No kit lines on this work order. A kit line comes from a BOM line on an operation'));
  }
  if (first) {
    // An empty kit is valid, so diagnose names the field that is actually wrong (Codex review on #331).
    const broken = JSON.parse(JSON.stringify(state)), bad = broken.orders.find(o => o.id === first.id);
    bad.history = 'not a list';
    const why = MES.diagnose(broken);
    check('diagnose does not blame a valid empty kit for another field\'s failure', MES.validate(broken) === false && !!why && !/\(materials\)/.test(why.detail), why && why.detail);
    bad.history = first.history; bad.materials = [{ id: 'x' }];
    const kitWhy = MES.diagnose(broken);
    check('diagnose still names a malformed kit line as the materials', MES.validate(broken) === false && !!kitWhy && /\(materials\)/.test(kitWhy.detail), kitWhy && kitWhy.detail);
  }
  check('a planned order is refused until a WI is released, with a plain reason', !po.ok && typeof po.message === 'string' && po.message.length > 0, po && po.message);
}

// Refusal paths for the rules this change touches.
{
  const { MES } = prod;
  const legacy = JSON.parse(read('fixtures/workspace_v82_before_clean_slate.json'));
  legacy.masterWIs = [];
  check('an empty WI library is refused once a work order cites a master WI, with a plain reason', MES.validate(legacy) === false && /Master WI library is empty, but work orders, planned orders, PFMEAs, open process MCRs or open WI review tasks in this workspace cite master WIs/.test((MES.diagnose(legacy) || {}).detail || ''));
  // A PFMEA names a WI revision too (Codex review on #331): emptying the library under it is refused as well.
  const withPfmea = load(prod, MES.seed());
  withPfmea.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const draft = withPfmea.masterWIs.find(w => w.status === 'Draft');
  const opened = prod.withAccount(admin, () => prod.FlightManeuver.openPFMEA(withPfmea, draft.id, draft.revision), withPfmea);
  check('a PFMEA is opened on a WI revision for the check', opened.ok && MES.validate(withPfmea) === true, opened.message);
  withPfmea.masterWIs = [];
  check('an empty WI library is refused while a PFMEA cites a master WI', MES.validate(withPfmea) === false && /PFMEAs, open process MCRs or open WI review tasks in this workspace cite master WIs/.test((MES.diagnose(withPfmea) || {}).detail || ''));
  // An open process MCR names a WI revision and operation (issue #615): emptying the library under it is refused, so
  // the MCR is not orphaned. A closed MCR is a record only and does not hold the library.
  const withMcr = load(prod, MES.seed());
  withMcr.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const mwi = withMcr.masterWIs.find(w => w.status === 'Released');
  const mcr = prod.withAccount(me, () => MES.submitECRRequest(withMcr, { type: 'process', wiId: mwi.id, wiRevision: mwi.revision, opId: mwi.operations[0].id, title: 'Clarify the torque step', description: 'Add the torque value to step A.', reason: 'Operators asked for the value.' }), withMcr);
  check('a process MCR is submitted on a released WI for the check', mcr.ok && MES.validate(withMcr) === true, mcr.message);
  withMcr.masterWIs = [];
  check('an empty WI library is refused while an open process MCR cites a master WI', MES.validate(withMcr) === false && /open process MCRs/.test((MES.diagnose(withMcr) || {}).detail || ''), JSON.stringify(MES.diagnose(withMcr)));
  withMcr.ecrRequests.forEach(e => Object.assign(e, { status: 'Rejected', closedReason: 'Not needed after review.', closedBy: { name: 'Quinn Manager', role: 'QA Manager', credentialId: 'ACCT-qa-manager' }, closedAt: now }));
  check('a closed process MCR does not hold the library: the empty library is valid again', MES.validate(withMcr) === true, JSON.stringify(MES.diagnose(withMcr)));
  // An open WI review task names a WI revision too (Codex on #331): emptying the library under it is refused, so the
  // review is not closed automatically for a WI that is gone.
  const withTask = load(prod, MES.seed());
  withTask.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const twi = withTask.masterWIs.find(w => w.status === 'Draft');
  const task = prod.withAccount(qa, () => MES.assignWork(withTask, { type: 'qa-review-wi', wiId: twi.id, wiRevision: twi.revision, assigneeUsername: 'qa-peer', assigneeName: 'QA Peer' }), withTask);
  check('a WI review task is assigned for the check', task.ok && MES.validate(withTask) === true, task.message);
  withTask.masterWIs = [];
  check('an empty WI library is refused while an open WI review task cites a master WI', MES.validate(withTask) === false && /open WI review tasks/.test((MES.diagnose(withTask) || {}).detail || ''), JSON.stringify(MES.diagnose(withTask)));
  withTask.assignments.forEach(a => Object.assign(a, { status: 'Done', doneAt: now }));
  check('a finished WI review task does not hold the library', MES.validate(withTask) === true, JSON.stringify(MES.diagnose(withTask)));
  // A workspace saved before the WI library existed (no masterWIs key, orders with no WI link) gets an empty library.
  // Earlier builds invented sample released WIs and linked its orders to them; production does not invent records.
  const preLibrary = JSON.parse(read('fixtures/workspace_v82_before_clean_slate.json'));
  delete preLibrary.masterWIs; delete preLibrary.plannedOrders; preLibrary.orders.forEach(o => { delete o.masterWI; });
  const preOrders = JSON.stringify(preLibrary.orders);
  load(prod, preLibrary);
  check('a workspace saved before the WI library loads with an empty library, its orders untouched and not linked to invented WIs', Array.isArray(preLibrary.masterWIs) && preLibrary.masterWIs.length === 0 && JSON.stringify(preLibrary.orders) === preOrders && MES.validate(preLibrary) === true, JSON.stringify(MES.diagnose(preLibrary)));
  const fresh = load(prod, MES.seed());
  const old = MES.toolCheck('DMM-08', now, fresh);
  check('a tool of the old snapshot cannot be used until the calibration log records it', !old.ok && /no entry in the calibration log/.test(old.message) && /2026-09-15/.test(old.message), old.message);
  const atp = MES.atpAssets([{ asset: 'DMM-08', description: 'Bench meter', noCal: true }], now, fresh);
  check('an ATP buy-off cannot list a tool of the old snapshot as not calibration-controlled', !atp.ok && /calibration log/.test(atp.message), atp.message);
  const declassify = prod.withAccount(qa, () => MES.recordCalibration(fresh, { tag: 'NONE-174', description: 'TORQUE SCREWDRIVER', torque: 'no', serial: 'TQ', calibratedAt: '2026-09-30', expires: '2027-03-30', status: 'In Calibration', location: 'Production Floor', note: 'x' }), fresh);
  check('a torque tool of the old snapshot stays a torque tool', !declassify.ok && /torque tool and stays one/.test(declassify.message), declassify.message);
  const undated = prod.withAccount(qa, () => MES.recordCalibration(fresh, { tag: 'CAL-022', description: 'DIGITAL CALIPER', serial: 'S', calibratedAt: '', expires: '', status: 'Retired', location: 'Production Floor', note: 'x' }), fresh);
  check('a tool of the old snapshot cannot be retired without its calibration dates', !undated.ok && /calibration dates on record/.test(undated.message), undated.message);
}

// The production file carries no sample record. Format hints in input placeholders are not records.
{
  const html = read('../index.html');
  for (const [what, text] of [['the sample person', 'Morgan Lee'], ['a sample NetSuite lot', 'LOT-2401-0088'], ['a sample component lot', 'LOT-DEMO-'], ['a sample tool serial', '150151267'], ['a sample bill of materials', 'DEMO drive motor'], ['a sample planned order', 'Demand withdrawn (DEMO).'], ['a sample master WI history', 'Released by QA.'], ['a sample rework draft', 'Re-torque fastener(s) to drawing value'], ['a sample stamp holder', "'Quality inspector', 'Quality'"]]) {
    check(`index.html does not carry ${what}`, !html.includes(text));
  }
  const bundle = read('../assets/flight-ui.js'), fallback = 'The log is the calibration record that a QA Manager keeps or imports.';
  check('the tooling help names the calibration log, not a blank snapshot time, in both renderers', html.includes(fallback) && bundle.includes(fallback) && !html.includes('can be added. Log read ${esc(MES.CAL_SNAPSHOT)} PT.') && !read('../src/react/flight-ui.jsx').includes('can be added. Log read {asText(MES.CAL_SNAPSHOT)} PT.'));
  // #438: the tool source strings on a signed buy-off never end in a blank snapshot time either.
  { const bare = html.split('\n').filter(l => l.includes('${CAL_SNAPSHOT}') && !l.includes('CAL_SNAPSHOT ?')); check('every snapshot time in a buy-off tool source is guarded, so production records "Calibrated Tool Log" or "Calibration log" and never a blank time', bare.length === 0, bare.map(l => l.trim().slice(0, 120)).join(' | ')); }
  check('the production fixture is a copy of index.html', read('fixtures/publish.html') === html.replace(/((?:src|href)=")assets\//g, '$1../../assets/'));
}

// ---- 2. the demo keeps every sample ---------------------------------------------------------------------------------
{
  const demoHtml = read('../demo.html');
  const demo = createHost(here('../demo.html'));
  const { MES, FlightPlan } = demo;
  check('the demo writes the sample snapshot label as a JSON string literal', demoHtml.includes(`(${JSON.stringify(JSON.parse(read('../tools/demo/cal-snapshot.json')).snapshot)},`));
  check('the demo marks each sample deviation', ['DEMO D-37', 'DEMO D-48: sample data', 'DEMO D-49: sample data'].every(m => demoHtml.includes(m)));
  check('the demo carries the sample tool snapshot', MES.CAL_TOOLS.length === JSON.parse(read('../tools/demo/cal-snapshot.json')).tools.length && MES.CAL_TOOLS.length > 300 && MES.CAL_SNAPSHOT !== '');
  check('the demo carries the sample NetSuite lots', MES.availableLots('SR-2401').some(l => l.lot === 'LOT-2401-0088') && MES.NETSUITE_SNAPSHOT !== '');
  check('the demo carries the sample MRP tables', Object.keys(FlightPlan.DEMO_MBOM).length > 0 && FlightPlan.DEMO_COMPONENT_LOTS.length > 0);
  const demoState = load(demo, MES.seed());
  const demoOrder = demo.withAccount(admin, () => MES.addAdhocOrder(demoState, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], partNumber: 'DEMO-PART-001', title: 'Demo order', revision: 'A' }), demoState);
  check('a demo work order starts with the three sample kit lines', demoOrder.ok && MES.getOrder(demoState, demoOrder.id).materials.map(m => m.partNumber).join() === 'SR-2401,SR-2402,SR-2403', demoOrder.message);
  const reset = load(demo, MES.seed());
  check('a reset demo workspace starts with the sample WIs, planned orders, stamps and rework drafts', reset.masterWIs.some(w => w.status === 'Released') && reset.plannedOrders.length > 0 && reset.stamps.some(s => s.number === 'SKY-0000') && reset.reworkLibrary.length === 6, `${reset.masterWIs.length} ${reset.plannedOrders.length} ${reset.stamps.length} ${reset.reworkLibrary.length}`);
  check('a reset demo workspace validates', MES.validate(reset) === true, JSON.stringify(MES.diagnose(reset)));
  // The demo's three sample kit lines (D-48) count toward the kit limit too (Codex review on #331): a WI with 18 BOM
  // parts would make a 21-line kit, so the demo refuses it rather than creating an order that fails validation.
  const demoWide = load(demo, MES.seed()), demoWi = demoWide.masterWIs.find(w => w.status === 'Released');
  demoWi.operations[0].materials = Array.from({ length: 9 }, (_, n) => ({ partNumber: `DW-A${n}`, name: `Part A${n}`, required: 1 }));
  demoWi.operations[1].materials = Array.from({ length: 9 }, (_, n) => ({ partNumber: `DW-B${n}`, name: `Part B${n}`, required: 1 }));
  const demoWideBefore = JSON.stringify(demoWide);
  const demoRefused = demo.withAccount(admin, () => MES.addOrder(demoWide, { masterWI: `${demoWi.id}|${demoWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), demoWide);
  check('the demo counts its sample kit lines toward the 20-line kit limit', !demoRefused.ok && /would need 21 different kit parts/.test(demoRefused.message) && JSON.stringify(demoWide) === demoWideBefore, demoRefused.message);
  for (const fixture of ['fixtures/demo_publish.html', 'fixtures/demo_qa150.html', 'fixtures/demo_qa150_publish.html']) {
    const text = read(fixture);
    check(`${fixture} keeps its sample workspace and sample tools`, text.includes('window.__DEMO_SEED={') && text.includes('DEMO D-37') && text.includes('LOT-2401-0088'));
  }
  const curated = JSON.parse(read('../tools/demo/seed-curated.json'));
  check('the curated demo seed still holds its sample records', curated.orders.length > 0 && curated.masterWIs.length > 0 && curated.stamps.length > 0);
}

// ---- 3. a workspace saved before the clean slate loads unchanged ------------------------------------------------------
{
  const { MES, FlightPlan } = prod;
  const text = read('fixtures/workspace_v82_before_clean_slate.json');
  const state = JSON.parse(text), before = JSON.stringify(state);
  check('the saved workspace validates under the clean-slate engine', MES.validate(state) === true, JSON.stringify(MES.diagnose(state)));
  check('diagnose finds nothing wrong in it', MES.diagnose(state) === null);
  check('every signature manifest in it verifies', MES.verifyManifests(state).ok === true);
  check('the server finds nothing to refuse in its registers', MES.stampRegisterProblem(state) === null && FlightPlan.plannedOrdersProblem(state) === null);
  load(prod, state);
  check('loading it changes nothing: no record is removed, added or rewritten', JSON.stringify(state) === before);
  check('it keeps its sample WIs, stamps, rework drafts, planned orders and profile', state.masterWIs.length === 11 && state.stamps.length === 13 && state.reworkLibrary.length === 6 && state.plannedOrders.length === 6 && state.profile.name === 'Morgan Lee');
  check('its planned orders keep the NetSuite read they recorded', state.plannedOrders.every(po => po.netsuite && po.netsuite.snapshotAt === '2026-09-15 15:13'));
  const tq = MES.toolCheck('NONE-174', now, state), cal = MES.toolCheck('CAL-022', now, state), log = MES.toolCheck('LOG-001', now, state);
  check('its calibration entries for tools of the old snapshot still work at point of use', tq.ok && cal.ok && log.ok, [tq, cal, log].map(r => r.message).join(' | '));
  check('a torque tool of the old snapshot recorded with no torque answer is still a torque tool', tq.ok && tq.tool.torqueTool === true && cal.tool.torqueTool === false);
  check('its work unit and maintenance record on old snapshot tags still validate', state.resources.units.some(u => u.toolTag === 'DMM-08') && state.resources.maintenance.some(m => m.assetTag === 'PS-007'));
  check('a trace search for an old snapshot tag is still a tool search', MES.traceSearch(state, 'DMM-08').kind === 'tool');
  {
    // A retired snapshot tag has no current record, but the operations that used it still show (Codex review on #331).
    const used = JSON.parse(JSON.stringify(state)), o = used.orders[0];
    o.operations[0].buyoff = { ...(o.operations[0].buyoff || {}), tools: [{ tag: 'DMM-08', description: 'Bench meter' }] };
    const r = MES.traceSearch(used, 'DMM-08'), hit = r.orders.find(x => x.id === o.id);
    check('a trace of a retired snapshot tag finds the operations that used it, with no current tool record', r.kind === 'tool' && r.tool === null && !!hit && hit.ops.length >= 1, JSON.stringify({ kind: r.kind, tool: r.tool, ops: hit && hit.ops.length }));
    const html = read('../index.html'), jsx = read('../src/react/flight-ui.jsx');
    check('both trace renderers show the operations column for any tool search, not only one with a current record', html.includes("r.kind === 'tool' ? 'Operations with this tool'") && html.includes("r.kind === 'tool' ? o.ops.map(") && jsx.includes("result.kind === 'tool' ? 'Operations using tool'") && jsx.includes("result.kind === 'tool' ? order.ops.map("));
  }
}

// ---- the production screens on a new workspace -----------------------------------------------------------------------
{
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(new URL('fixtures/publish.html', import.meta.url).href);
    const password = 'Test-' + crypto.randomUUID();
    await page.locator('#sk-displayname').fill('Go Live');
    await page.locator('#sk-username').fill('go-live');
    await page.locator('#sk-password').fill(password);
    await page.locator('#sk-confirm').fill(password);
    await page.locator('#sk-login-submit').click();
    await page.waitForFunction(() => !document.getElementById('sk-boot'));
    const counts = await page.evaluate(() => ({ orders: state.orders.length, wis: state.masterWIs.length, stamps: state.stamps.length, planned: FlightPlan.list(state).length, valid: MES.validate(state) }));
    check('the production page opens a new workspace with nothing in it, and it validates', counts.orders === 0 && counts.wis === 0 && counts.stamps === 0 && counts.planned === 0 && counts.valid === true, JSON.stringify(counts));
    const show = async v => { await page.evaluate(v => document.querySelector(`[data-view="${v}"]`).click(), v); await page.waitForTimeout(250); return page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' ')); };
    for (const v of ['home', 'orders', 'plan-home', 'plan-kanban', 'plan-forecast', 'mnv-home', 'mnv-intake', 'mnv-mrb', 'mnv-cars', 'mnv-spr', 'mnv-pfmea', 'mnv-metrics', 'serials', 'trace', 'activity']) await show(v);
    check('every Flight Control, Flight Plan and Flight Maneuver screen opens without a page error', errors.length === 0, errors.join(' | '));
    check('the empty Master WI library says how to start', /No master WIs yet Start one with New master WI, or import WIs from a CSV/.test(await show('wis')));
    check('the empty standard rework library says how to start', /No standard rework operations yet/.test(await show('wis')));
    check('the empty calibration log says how to load tools', /No calibrations recorded\. Record each calibrated tool above or import the calibration log as a CSV/.test(await show('qms-records')));
    await page.evaluate(() => document.querySelector('[data-view="plan-home"]').click());
    await page.getByRole('button', { name: 'Plan from master WI' }).first().click();
    check('planning with no released WI says what to do next', /No master WI is released yet\. Write one on the Master WI library or import WIs from a CSV/.test(await page.locator('#dialog').innerText()));
    await page.evaluate(() => document.getElementById('dialog').close());
    // The stamp register is on the Admin page (#332), Stamps tab.
    await page.evaluate(() => { const d = document.getElementById('dialog'); if (d && d.open) d.close(); view = 'admin'; render(); });
    await page.click('[data-admin-tab="stamps"]');
    check('the empty stamp register says how to load stamps', /No stamps issued\. Issue a stamp to each named person below, or import the current register from a CSV/.test(await page.locator('#admin-panel-stamps').innerText()));
    await loadSampleInPage(page, { wis: true });
    const firmed = await page.evaluate(() => { const wi = state.masterWIs.find(w => w.status === 'Released'); const r = FlightPlan.addPlannedOrder(state, { masterWI: `${wi.id}|${wi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', aircraft: MES.AIRCRAFT[0], site: null, quantity: 1, needDate: '2026-12-01' }); const f = r.ok ? FlightPlan.firm(state, r.id) : r; if (typeof save === 'function') save(); return { ok: f.ok, message: f.message || r.message, netsuite: r.ok ? FlightPlan.get(state, r.id).netsuite : 'none' }; });
    const kanban = await show('plan-kanban');
    const lane = await page.evaluate(() => { const card = [...document.querySelectorAll('main article')].find(a => /No NetSuite stock read/.test(a.innerText)); const section = card && card.closest('section[aria-label]'); return section ? section.getAttribute('aria-label') : null; });
    check('a firm planned order with no NetSuite read is not shown as covered: it waits under Pending materials and says the stock is unread', firmed.ok && firmed.netsuite === null && lane === 'Pending materials' && /No NetSuite stock read\. Check stock before converting/.test(kanban), JSON.stringify({ firmed, lane }));
    check('no page error on any screen', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }
  console.log('errors ' + JSON.stringify(errors));
}

// ---- the production server: the first Master Access sign-in creates an empty shared workspace ------------------------
// The pilot runs in server mode. Before the clean slate a fresh server's first workspace carried 11 master WIs with a
// "QA reviewer · SR-QA-001" history signer, planned orders PO-20001 to PO-20005, their planning blockers, placeholder
// stamps SKY-0000 to SKY-0006, and the app code shipped sample stock and calibrated tools. None of it may appear.
{
  const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'clean-slate-setup-code' });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];
  try {
    const port = await server.listenAsync(0, '127.0.0.1');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#sk-login').waitFor({ state: 'visible' });
    const password = 'Test-' + crypto.randomUUID();
    await page.locator('#sk-displayname').fill('Go Live');
    await page.locator('#sk-username').fill('go-live');
    await page.locator('#sk-password').fill(password);
    await page.locator('#sk-confirm').fill(password);
    await page.locator('#sk-setup').fill('clean-slate-setup-code');
    await page.locator('#sk-login-submit').click();
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 30000 });
    const account = server.store.account('go-live');
    check('server mode: the first sign-in creates the Master Access account', !!account && server.host.rolesOf(account).includes('admin'), JSON.stringify(account && { role: account.role, roles: account.roles }));
    const row = await server.store.getDoc('default');
    const doc = row ? JSON.parse(row.json) : null;
    check('server mode: the first sign-in stores a shared workspace that validates', !!doc && server.host.MES.validate(doc) === true, row ? JSON.stringify(server.host.MES.diagnose(doc)) : 'no workspace stored');
    if (doc) {
      check('server mode: the first workspace has no master WIs', Array.isArray(doc.masterWIs) && doc.masterWIs.length === 0, JSON.stringify((doc.masterWIs || []).map(w => w.id)));
      check('server mode: the first workspace has no planned orders', !(doc.plannedOrders || []).length, JSON.stringify((doc.plannedOrders || []).map(p => p.id)));
      check('server mode: the first workspace has no planning blockers', !(doc.blockers || []).length, JSON.stringify(doc.blockers));
      check('server mode: the first workspace has no stamps, placeholder or otherwise', Array.isArray(doc.stamps) && doc.stamps.length === 0, JSON.stringify(doc.stamps));
      check('server mode: the first workspace has no work orders, calibration entries or Flight Maneuver records', !(doc.orders || []).length && !(doc.calibrationLog || []).length && ['ncs', 'cars', 'mrb', 'sprs', 'pfmeas'].every(k => !((doc.maneuver || {})[k] || []).length));
      check('server mode: the stored workspace carries no sample record text', !/SR-QA-001|SKY-000[0-6]|PO-2000[1-5]|Morgan Lee|LOT-2401-0088/.test(row.json));
    }
    const shipped = await page.evaluate(() => ({ tools: MES.CAL_TOOLS.length, snapshot: MES.CAL_SNAPSHOT, stock: Object.keys(MES.NETSUITE_STOCK).length, lots: MES.availableLots('SR-2401').length, wis: state.masterWIs.length, planned: FlightPlan.list(state).length, stamps: state.stamps.length }));
    check('server mode: the page ships no sample stock or calibrated tools and shows an empty workspace', shipped.tools === 0 && shipped.snapshot === '' && shipped.stock === 0 && shipped.lots === 0 && shipped.wis === 0 && shipped.planned === 0 && shipped.stamps === 0, JSON.stringify(shipped));
    check('server mode: the engine host ships no sample stock or calibrated tools', server.host.MES.CAL_TOOLS.length === 0 && Object.keys(server.host.MES.NETSUITE_STOCK).length === 0);
    check('server mode: no page error during the first sign-in', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

console.log(`checks ${checks} pass ${checks - FAILS.length} fail ${FAILS.length}`);
console.log('FAILS ' + JSON.stringify(FAILS));
if (FAILS.length) process.exit(1);
