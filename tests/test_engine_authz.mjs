// Engine write paths that are reachable as server actions check the caller's capability themselves, so a direct
// POST /api/workspace/actions/<name> cannot do what the page would refuse. Each rule is checked for the refusal
// (nothing changes) and for the role that is meant to do it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';
import { createServer, makeHash } from '../server/server.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver } = host;
const account = (role, name) => ({ username: `authz-${role}`, displayName: name, role });
const general = account('general', 'Gale General');
const technician = account('technician', 'Terry Tech');
const operator = account('operator', 'Owen Operator');
const me = account('me', 'Morgan Engineer');
const qe = account('qe', 'Quinn Quality');
const qm = account('qm', 'Quincy Manager');
const safety = account('safety', 'Sam Safety');
const swe = account('swe', 'Ellis Engineer');
const cert = account('cert', 'Casey Cert');
let checks = 0;
const check = (name, result) => { checks += 1; assert.ok(result, name); console.log(`ok ${name}`); };
const roleRefused = result => !!result && result.ok === false && /Your role cannot/.test(result.message);

// ---- Flight Maneuver record files (#75): removing a file from a quality record needs a record authority ----
{
  const state = MES.seed();
  const run = (who, fn) => host.withAccount(who, fn, state);
  FlightManeuver.ensure(state);
  const nc = run(qm, () => FlightManeuver.raiseNC(state, { sourceType: 'Serial number', type: 'NC', title: 'Scratched housing', description: 'Scratch on the housing face.', partNumber: 'SR-IH-040', revision: 'A', serial: 'IH-040-AZ1', quantity: 1, foundAt: 'Stock', pedigree: 'Production', escaped: 'no' }));
  check('an NC is raised for the record file checks', nc.ok);
  const photo = { name: 'scratch.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  const added = run(technician, () => FlightManeuver.addRecordFile(state, 'ncs', nc.id, photo));
  check('a Technician (raise-nc) attaches a file to an NC', added.ok);
  const files = () => (FlightManeuver.get(state, 'ncs', nc.id).attachments || []).map(f => f.id);
  const fileId = files().at(-1);
  for (const who of [general, technician, operator]) {
    const result = run(who, () => FlightManeuver.removeRecordFile(state, 'ncs', nc.id, fileId));
    check(`${who.displayName} (${who.role}) cannot remove a file from a quality record and the file stays`, roleRefused(result) && files().includes(fileId));
  }
  check('Manufacturing Engineering (dispo-nc) removes a file from a quality record', run(me, () => FlightManeuver.removeRecordFile(state, 'ncs', nc.id, fileId)).ok && !files().includes(fileId));
  const again = run(technician, () => FlightManeuver.addRecordFile(state, 'ncs', nc.id, photo));
  check('Quality (approve-nc) removes a file from a quality record', again.ok && run(qe, () => FlightManeuver.removeRecordFile(state, 'ncs', nc.id, files().at(-1))).ok && files().length === 0);
  check('the workspace is valid after the record file checks', MES.validate(state));
}

// ---- Flight Maneuver record files (#102): attaching follows the authority over the record type ----
const curated = () => JSON.parse(fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const photo = { name: 'evidence.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
// An open stock NC with a Use as is disposition and the open MRB board it convenes, raised through the engine.
const openBoard = (h, state) => h.withAccount(qm, () => {
  const nc = h.FlightManeuver.raiseNC(state, { sourceType: 'Serial number', type: 'NC', title: 'Scuffed bracket', description: 'Scuff on the bracket face.', partNumber: 'SR-IH-040', revision: 'A', serial: 'IH-040-AF1', quantity: 1, foundAt: 'Stock', pedigree: 'Production', escaped: 'no' });
  const dispo = nc.ok && h.FlightManeuver.dispositionNC(state, nc.id, { decision: 'Use as is', note: 'Cosmetic only.' });
  const board = dispo && dispo.ok && h.FlightManeuver.openMRB(state, 'STOCK', nc.id, 'Cosmetic scuff, justification attached.');
  return { ncId: nc.id, mrbId: board && board.ok ? board.id : null };
}, state);
{
  const state = curated();
  FlightManeuver.ensure(state);
  const run = (who, fn) => host.withAccount(who, fn, state);
  const { ncId, mrbId } = openBoard(host, state);
  check('an open stock NC and its open MRB board are raised for the attach checks', !!mrbId && FlightManeuver.get(state, 'mrb', mrbId).status === 'Open' && FlightManeuver.get(state, 'ncs', ncId).status === 'Open');
  const car = state.maneuver.cars.find(c => !['Closed', 'Cancelled'].includes(c.status));
  const count = (kind, id) => (FlightManeuver.get(state, kind, id).attachments || []).length;
  for (const who of [general, technician, operator, safety]) {
    const before = JSON.stringify(state);
    const result = run(who, () => FlightManeuver.addRecordFile(state, 'mrb', mrbId, photo));
    check(`${who.displayName} (${who.role}) cannot attach a file to an MRB record and nothing changes`, roleRefused(result) && /MRB record/.test(result.message) && JSON.stringify(state) === before);
  }
  for (const who of [me, qe, swe]) {
    const before = count('mrb', mrbId);
    check(`${who.displayName} (${who.role}, board authority) attaches a file to an open MRB record`, run(who, () => FlightManeuver.addRecordFile(state, 'mrb', mrbId, photo)).ok && count('mrb', mrbId) === before + 1);
  }
  // A Certification seat counts only on a board convened with one: Production FAI and Mfg. work orders.
  {
    check('the stock NC board has the three standard seats and no Certification seat', !FlightManeuver.get(state, 'mrb', mrbId).seats.includes('Certification'));
    const before = JSON.stringify(state);
    const result = run(cert, () => FlightManeuver.addRecordFile(state, 'mrb', mrbId, photo));
    check('Certification cannot attach to a board without a Certification seat and nothing changes', roleRefused(result) && result.message.includes(`without a seat on ${mrbId}`) && JSON.stringify(state) === before && run(cert, () => FlightManeuver.canAttach('mrb', FlightManeuver.get(state, 'mrb', mrbId))) === false);
    const order = state.orders.find(o => o.id === 'WO-10006');
    const certBoard = run(qm, () => {
      const op = order.operations.find(x => !x.done) || order.operations[0];
      const raised = MES.createTicket(state, order.id, op.id, { type: 'NC', title: 'Scratch on the bracket face', description: 'Light surface scratch, no structural effect.', hold: true });
      const tid = raised.ok && MES.getOrder(state, order.id).tickets.slice(-1)[0].id;
      const dispo = tid && MES.dispositionTicket(state, order.id, tid, { decision: 'Use as is', note: 'Cosmetic only.' });
      const board = dispo && dispo.ok && FlightManeuver.openMRB(state, order.id, tid, 'Cosmetic scratch, justification attached.');
      return board && board.ok ? board.id : null;
    });
    check('a Production Mfg. work order convenes an open board with a Certification seat', !!certBoard && FlightManeuver.get(state, 'mrb', certBoard).seats.includes('Certification'));
    const seated = count('mrb', certBoard);
    check('Certification (mrb-cert) attaches a file to a board with a Certification seat', run(cert, () => FlightManeuver.addRecordFile(state, 'mrb', certBoard, photo)).ok && count('mrb', certBoard) === seated + 1);
  }
  for (const who of [general, technician, safety, me, qe]) {
    const before = count('cars', car.id) + count('ncs', ncId);
    const ok = run(who, () => FlightManeuver.addRecordFile(state, 'cars', car.id, photo)).ok && run(who, () => FlightManeuver.addRecordFile(state, 'ncs', ncId, photo)).ok;
    check(`${who.displayName} (${who.role}, raise-nc) attaches evidence to an open NC and CAR`, ok && count('cars', car.id) + count('ncs', ncId) === before + 2);
  }
  // A record that is no longer open keeps the files it had, for every role: the rule each detail page uses.
  const resolvedNc = state.maneuver.ncs.find(t => t.status === 'Resolved'), decidedBoard = state.maneuver.mrb.find(m => m.status !== 'Open');
  check('the curated set carries a resolved NC and a decided MRB board', !!resolvedNc && !!decidedBoard);
  check('a Quality manager cancels the CAR for the closed record check', run(qm, () => FlightManeuver.cancelCAR(state, car.id, 'Raised in error.')).ok);
  for (const [kind, rec, word] of [['ncs', resolvedNc, 'resolved'], ['mrb', decidedBoard, decidedBoard.status.toLowerCase()], ['cars', car, 'cancelled']]) {
    const before = JSON.stringify(state);
    const result = run(qm, () => FlightManeuver.addRecordFile(state, kind, rec.id, photo));
    check(`${/^[aeiou]/.test(word) ? "an" : "a"} ${word} ${kind === 'ncs' ? 'NC' : kind === 'mrb' ? 'MRB board' : 'CAR'} refuses a new file, even for the QA Manager, and nothing changes`, result.ok === false && result.message.includes(`is ${word} and keeps the files it had`) && JSON.stringify(state) === before);
  }
  check('the page offers the upload only where the engine would take the file', FlightManeuver.acceptsFiles('ncs', resolvedNc) === false && FlightManeuver.acceptsFiles('mrb', decidedBoard) === false && FlightManeuver.acceptsFiles('mrb', FlightManeuver.get(state, 'mrb', mrbId)) === true && run(technician, () => FlightManeuver.canAttach('mrb')) === false && run(technician, () => FlightManeuver.canAttach('ncs')) === true);
  check('the workspace is valid after the record attach checks', MES.validate(state));
}

// ---- the same rule over the server action: POST /api/workspace/actions/FlightManeuver.addRecordFile ----
{
  const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'record-file-authz' });
  await server.ready;
  const call = async (method, url, token, body, headers = {}) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); incoming.method = method; incoming.url = url;
    incoming.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
    const done = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
    server.listeners('request')[0](incoming, outgoing); await done;
    const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: outgoing.statusCode, json };
  };
  try {
    for (const [username, role] of [['srv-tech', 'technician'], ['srv-qe', 'qe']]) await server.store.upsertAccount({ username, displayName: `Server ${role}`, salt: '', hash: await makeHash(`${username}-pass-1`), role, roles: [role] });
    const state = curated();
    server.host.FlightManeuver.ensure(state);
    const { ncId, mrbId } = openBoard(server.host, state);
    const resolvedId = state.maneuver.ncs.find(t => t.status === 'Resolved').id;
    const planted = await server.store.putDoc('default', JSON.stringify(state), null, 'record-file-authz');
    const token = async username => (await call('POST', '/api/auth/session', null, { username, password: `${username}-pass-1` })).json.token;
    const tech = await token('srv-tech'), quality = await token('srv-qe');
    const files = async (kind, id) => (JSON.parse((await server.store.getDoc('default')).json).maneuver[kind].find(r => r.id === id).attachments || []).length;
    const post = async (who, args) => call('POST', '/api/workspace/actions/FlightManeuver.addRecordFile', who, { args }, { 'If-Match': (await server.store.getDoc('default')).etag });
    const refused = await post(tech, ['mrb', mrbId, photo]);
    check('over the server a Technician is refused an MRB file with 403 and the workspace is not written', refused.status === 403 && /MRB record/.test(refused.json.error) && (await server.store.getDoc('default')).etag === planted && await files('mrb', mrbId) === 0);
    const locked = await post(quality, ['ncs', resolvedId, photo]);
    check('over the server a resolved NC refuses a new file with 403 and the workspace is not written', locked.status === 403 && /is resolved and keeps the files it had/.test(locked.json.error) && (await server.store.getDoc('default')).etag === planted);
    const ncFile = await post(tech, ['ncs', ncId, photo]);
    check('over the server a Technician (raise-nc) attaches evidence to an open NC', ncFile.status === 200 && await files('ncs', ncId) === 1);
    const allowed = await post(quality, ['mrb', mrbId, photo]);
    check('over the server Quality (approve-nc) attaches a file to an open MRB record', allowed.status === 200 && await files('mrb', mrbId) === 1);
  } finally { server.store.close(); }
}

// ---- smaller write paths (#78): each checks the capability of the page control that calls it ----
{
  const state = MES.seed();
  MES.ensureMasterWIs(state);
  FlightManeuver.ensure(state);
  const run = (who, fn) => host.withAccount(who, fn, state);
  const wi = state.masterWIs.find(w => w.status === 'Released' && MES.SERIALIZED_PARTS.includes(w.partNumber));
  const created = run(qm, () => MES.addOrder(state, { masterWI: `${wi.id}|${wi.revision}`, pedigree: 'Development', subcategory: 'Mfg.', quantity: 2, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }));
  check('a serialized work order is created for the checks', created.ok);
  const order = () => MES.getOrder(state, created.id);
  const snapshot = () => JSON.stringify(state);

  // Voiding a serial number: operate, like assigning one.
  const serial = MES.orderSerials(state, order())[0].serial;
  const serialStatus = () => state.serialLog.find(e => e.orderId === created.id && e.serial === serial).status;
  for (const who of [general, technician]) check(`${who.role} cannot void a serial number and it stays assigned`, roleRefused(run(who, () => MES.voidSerial(state, created.id, serial, 'Mislabelled'))) && serialStatus() === 'Assigned');
  check('Operations (operate) voids a serial number', run(operator, () => MES.voidSerial(state, created.id, serial, 'Mislabelled')).ok && serialStatus() === 'Voided');

  // Recording the NetSuite posting: operate, like moving units to inventory.
  {
    const copy = structuredClone(state), stocked = MES.getOrder(copy, created.id);
    stocked.inventory = { lotNumber: 'LOT-AUTHZ', netsuite: { status: 'Pending' } };
    const posted = who => host.withAccount(who, () => MES.markNetSuitePosted(copy, created.id, 'IA-1001'), copy);
    check('a Technician cannot record a NetSuite posting', roleRefused(posted(technician)) && stocked.inventory.netsuite.status === 'Pending');
    check('Quality cannot record a NetSuite posting', roleRefused(posted(qe)) && stocked.inventory.netsuite.status === 'Pending');
    check('Operations (operate) records a NetSuite posting', posted(operator).ok && stocked.inventory.netsuite.status === 'Posted');
  }

  // Storing a computed quality study value: approve-nc, the Quality approval that signs the verdict on it.
  const values = () => (state.qualityValues || []).length;
  for (const who of [general, operator, me]) check(`${who.role} cannot store a quality study value`, (() => { const before = values(); return roleRefused(run(who, () => MES.storeQualityValue(state, { kind: 'gage', value: 12.5, name: 'caliper' }))) && values() === before; })());
  check('Quality (approve-nc) stores a quality study value', run(qe, () => MES.storeQualityValue(state, { kind: 'gage', value: 12.5, name: 'caliper' })).ok && values() === 1);

  // Operation attachments: operate-steps or inspect-steps, like the step media on the same operation.
  const op = order().operations[0];
  const opFiles = () => (MES.getOrder(state, created.id).operations[0].attachments || []).map(f => f.id);
  const file = { name: 'setup.txt', type: 'text/plain', size: 4 };
  for (const who of [general, qe]) check(`${who.role} without a stamp cannot add an operation attachment`, roleRefused(run(who, () => MES.addAttachment(state, created.id, op.id, file))) && opFiles().length === 0);
  const attached = run(technician, () => MES.addAttachment(state, created.id, op.id, file));
  check('a Technician (operate-steps) adds an operation attachment', attached.ok && opFiles().length === 1);
  check('a General User cannot remove an operation attachment', roleRefused(run(general, () => MES.removeAttachment(state, created.id, op.id, opFiles()[0]))) && opFiles().length === 1);
  check('a Technician (operate-steps) removes an operation attachment', run(technician, () => MES.removeAttachment(state, created.id, op.id, opFiles()[0])).ok && opFiles().length === 0);

  // Incorporating MCRs into a WI revision: edit-wi, on a draft revision only.
  const mcr = run(qm, () => MES.submitECRRequest(state, { type: 'process', title: 'Torque callout', description: 'Add the torque value.', reason: 'Missing value.', wiId: wi.id, wiRevision: wi.revision, opId: wi.operations[0].id }));
  check('an MCR is submitted against the released WI', mcr.ok);
  const mcrStatus = () => state.ecrRequests.find(e => e.id === mcr.id).status;
  const draft = state.masterWIs.find(w => w.id === wi.id && w.status === 'Draft') || (() => { const r = run(me, () => MES.reviseMasterWI(state, wi.id, wi.revision)); return state.masterWIs.find(w => w.id === wi.id && w.revision === r.revision); })();
  check('a Technician cannot incorporate an MCR and it stays open', roleRefused(run(technician, () => MES.incorporateECRs(state, wi.id, draft.revision, [mcr.id]))) && mcrStatus() === 'Open');
  check('Quality cannot incorporate an MCR', roleRefused(run(qe, () => MES.incorporateECRs(state, wi.id, draft.revision, [mcr.id]))) && mcrStatus() === 'Open');
  check('an MCR is not incorporated into a released revision', run(me, () => MES.incorporateECRs(state, wi.id, wi.revision, [mcr.id])).ok === false && mcrStatus() === 'Open');
  check('Manufacturing Engineering (edit-wi) incorporates an MCR into the draft revision', run(me, () => MES.incorporateECRs(state, wi.id, draft.revision, [mcr.id])).ok && mcrStatus() === 'Incorporating');

  // Linking a rework order to an NC: dispo-nc, like the other NC links.
  const nc = run(qm, () => FlightManeuver.raiseNC(state, { sourceType: 'Serial number', type: 'NC', title: 'Bent bracket', description: 'Bracket bent in handling.', partNumber: 'SR-IH-040', revision: 'A', serial: 'IH-040-AZ2', quantity: 1, foundAt: 'Stock', pedigree: 'Production', escaped: 'no' }));
  const reworkLink = () => FlightManeuver.get(state, 'ncs', nc.id).reworkOrderId;
  for (const who of [technician, qe]) check(`${who.role} cannot link a rework order to an NC`, roleRefused(run(who, () => FlightManeuver.linkReworkOrder(state, nc.id, created.id))) && !reworkLink());
  check('Manufacturing Engineering (dispo-nc) links a rework order to an NC', run(me, () => FlightManeuver.linkReworkOrder(state, nc.id, created.id)).ok && reworkLink() === created.id);

  // The AOG escalation is logged by whichever signed-in page is open when it is due, so it keeps no role check,
  // but it is refused until the next escalation is due: a direct call cannot inflate the count or post early.
  check('the order is set AOG', run(qm, () => MES.setPriority(state, created.id, 'AOG')).ok && MES.aogDue(order()));
  check('a due AOG escalation is logged for any signed-in role', run(general, () => MES.logAogBroadcast(state, created.id)).ok && order().aog.notified === 1);
  const early = snapshot();
  const repeat = run(qm, () => MES.logAogBroadcast(state, created.id));
  check('an AOG escalation that is not yet due is refused and nothing changes', repeat.ok === false && /not due/.test(repeat.message) && snapshot() === early);

  check('the workspace is valid after the write path checks', MES.validate(state));
}

// ---- audit close (#126): signing a finding closed and closing the audit need approve-nc, like opening one ----
{
  const state = MES.seed();
  const run = (who, fn) => host.withAccount(who, fn, state);
  const snapshot = () => JSON.stringify(state);
  const opened = run(qm, () => MES.openAudit(state, { scope: 'Internal process audit', findings: ['Record sample was short.'] }));
  check('an audit is opened for the close checks', opened.ok);
  const audit = () => state.audits.at(-1);
  const auditId = audit().id, findingId = audit().findings[0].id;
  for (const who of [general, technician, operator, me]) {
    const before = snapshot();
    check(`${who.displayName} (${who.role}) cannot sign an audit finding closed and nothing changes`, roleRefused(run(who, () => MES.closeAuditFinding(state, auditId, findingId))) && snapshot() === before);
  }
  check('Quality (approve-nc) signs the audit finding closed', run(qe, () => MES.closeAuditFinding(state, auditId, findingId)).ok && audit().findings[0].status === 'Closed');
  for (const who of [general, technician, operator, me]) {
    const before = snapshot();
    check(`${who.displayName} (${who.role}) cannot close an audit and nothing changes`, roleRefused(run(who, () => MES.closeAudit(state, auditId))) && snapshot() === before);
  }
  check('Quality (approve-nc) closes the audit', run(qe, () => MES.closeAudit(state, auditId)).ok && audit().status === 'Closed');
  check('the workspace is valid after the audit close checks', MES.validate(state));
}

// ---- System QMS records (#97 to #100): signing an audit, certification, supplier approval or study verdict needs
// approve-nc, the Quality approval that already gates storing the study value on the same page ----
{
  const state = MES.seed();
  const run = (who, fn) => host.withAccount(who, fn, state);
  const count = key => (state[key] || []).length;
  const refusedUnchanged = (who, key, fn) => { const before = JSON.stringify(state); return roleRefused(run(who, fn)) && JSON.stringify(state) === before && count(key) === 0; };
  for (const who of [general, technician, operator, me]) {
    check(`${who.role} cannot open an audit and no audit is recorded`, refusedUnchanged(who, 'audits', () => MES.openAudit(state, { scope: 'Internal process audit', findings: ['Record sample was short.'] })));
    check(`${who.role} cannot issue a certification and none is recorded`, refusedUnchanged(who, 'certifications', () => MES.issueCertification(state, { statement: 'Process audit complete for this period.' })));
    check(`${who.role} cannot approve a supplier and none is recorded`, refusedUnchanged(who, 'supplierApprovals', () => MES.approveSupplier(state, { supplier: 'North Rivet' })));
  }
  check('Quality (approve-nc) opens an audit', run(qe, () => MES.openAudit(state, { scope: 'Internal process audit', findings: ['Record sample was short.'] })).ok && count('audits') === 1);
  check('Quality (approve-nc) issues a certification', run(qe, () => MES.issueCertification(state, { statement: 'Process audit complete for this period.' })).ok && count('certifications') === 1);
  check('the QA Manager (approve-nc) approves a supplier', run(qm, () => MES.approveSupplier(state, { supplier: 'North Rivet' })).ok && count('supplierApprovals') === 1);

  const stored = run(qe, () => MES.storeQualityValue(state, { kind: 'gage', value: 8.4, name: 'bore gage' }));
  check('a gage value is stored for the verdict checks', stored.ok);
  const valueId = state.qualityValues.at(-1).id;
  for (const who of [general, technician, operator, me]) check(`${who.role} cannot record a quality study verdict and none is recorded`, refusedUnchanged(who, 'qualityVerdicts', () => MES.recordQualityVerdict(state, { kind: 'gage', valueId, verdict: 'Acceptable' })));
  check('Quality (approve-nc) records a quality study verdict', run(qe, () => MES.recordQualityVerdict(state, { kind: 'gage', valueId, verdict: 'Acceptable' })).ok && count('qualityVerdicts') === 1);
  check('the workspace is valid after the QMS record checks', MES.validate(state) && MES.verifyManifests(state).ok);
}

// ---- NC ticket files (#101): removing a file from a ticket needs a record authority, like other quality records ----
{
  const state = MES.seed();
  MES.ensureMasterWIs(state);
  const run = (who, fn) => host.withAccount(who, fn, state);
  const wi = state.masterWIs.find(w => w.status === 'Released');
  const created = run(qm, () => MES.addOrder(state, { masterWI: `${wi.id}|${wi.revision}`, pedigree: 'Development', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }));
  check('a work order is created for the ticket file checks', created.ok);
  const order = () => MES.getOrder(state, created.id);
  check('Quality approves the release, which issues the order to kitting', MES.requiresReleaseQA(order()) && run(qe, () => MES.approveRelease(state, created.id, { note: 'Released for the ticket file checks.' })).ok);
  check('the work order is in Kitting, where tickets are raised', order().status === 'Kitting');
  const raised = run(technician, () => MES.createTicket(state, created.id, order().operations[0].id, { type: 'NC', title: 'Scratched bracket', description: 'Light scratch on the bracket face.', hold: false }));
  check('a Technician raises an NC ticket', raised.ok);
  const ticket = () => order().tickets.at(-1);
  const ticketFiles = () => (ticket().attachments || []).map(f => f.id);
  const photo = { name: 'scratch.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  check('anyone who can raise an NC still attaches a file to the ticket', run(technician, () => MES.addTicketAttachment(state, created.id, ticket().id, photo)).ok && ticketFiles().length === 1);
  for (const who of [general, technician, operator]) {
    const before = JSON.stringify(state);
    check(`${who.displayName} (${who.role}) cannot remove a file from an NC ticket and nothing changes`, roleRefused(run(who, () => MES.removeTicketAttachment(state, created.id, ticket().id, ticketFiles()[0]))) && JSON.stringify(state) === before);
  }
  check('Manufacturing Engineering (dispo-nc) removes a file from an NC ticket', run(me, () => MES.removeTicketAttachment(state, created.id, ticket().id, ticketFiles()[0])).ok && ticketFiles().length === 0);
  check('the file is attached again for the Quality check', run(technician, () => MES.addTicketAttachment(state, created.id, ticket().id, photo)).ok && ticketFiles().length === 1);
  check('Quality (approve-nc) removes a file from an NC ticket', run(qe, () => MES.removeTicketAttachment(state, created.id, ticket().id, ticketFiles()[0])).ok && ticketFiles().length === 0);
  check('the workspace is valid after the ticket file checks', MES.validate(state));
}

console.log(`engine authz: ${checks} checks, all passed`);
