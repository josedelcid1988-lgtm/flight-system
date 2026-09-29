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
{
  const state = curated();
  FlightManeuver.ensure(state);
  const run = (who, fn) => host.withAccount(who, fn, state);
  const mrb = state.maneuver.mrb[0], car = state.maneuver.cars.find(c => c.status !== 'Closed' && c.status !== 'Cancelled'), nc = state.maneuver.ncs[0];
  const count = (kind, id) => (FlightManeuver.get(state, kind, id).attachments || []).length;
  for (const who of [general, technician, operator, safety]) {
    const before = JSON.stringify(state);
    const result = run(who, () => FlightManeuver.addRecordFile(state, 'mrb', mrb.id, photo));
    check(`${who.displayName} (${who.role}) cannot attach a file to an MRB record and nothing changes`, roleRefused(result) && /MRB record/.test(result.message) && JSON.stringify(state) === before);
  }
  for (const who of [me, qe, swe, cert]) {
    const before = count('mrb', mrb.id);
    check(`${who.displayName} (${who.role}, board authority) attaches a file to an MRB record`, run(who, () => FlightManeuver.addRecordFile(state, 'mrb', mrb.id, photo)).ok && count('mrb', mrb.id) === before + 1);
  }
  for (const who of [general, technician, safety, me, qe]) {
    const before = count('cars', car.id) + count('ncs', nc.id);
    const ok = run(who, () => FlightManeuver.addRecordFile(state, 'cars', car.id, photo)).ok && run(who, () => FlightManeuver.addRecordFile(state, 'ncs', nc.id, photo)).ok;
    check(`${who.displayName} (${who.role}, raise-nc) attaches evidence to an NC and a CAR`, ok && count('cars', car.id) + count('ncs', nc.id) === before + 2);
  }
  check('a Quality manager cancels the CAR for the closed record check', run(qm, () => FlightManeuver.cancelCAR(state, car.id, 'Raised in error.')).ok);
  const before = JSON.stringify(state);
  const closed = run(qm, () => FlightManeuver.addRecordFile(state, 'cars', car.id, photo));
  check('a cancelled record refuses a new file, even for the QA Manager, and nothing changes', closed.ok === false && /cancelled and keeps the files/.test(closed.message) && JSON.stringify(state) === before);
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
    const planted = await server.store.putDoc('default', JSON.stringify(state), null, 'record-file-authz');
    const mrbId = state.maneuver.mrb[0].id, ncId = state.maneuver.ncs[0].id;
    const token = async username => (await call('POST', '/api/auth/session', null, { username, password: `${username}-pass-1` })).json.token;
    const tech = await token('srv-tech'), quality = await token('srv-qe');
    const files = async (kind, id) => (JSON.parse((await server.store.getDoc('default')).json).maneuver[kind].find(r => r.id === id).attachments || []).length;
    const refused = await call('POST', '/api/workspace/actions/FlightManeuver.addRecordFile', tech, { args: ['mrb', mrbId, photo] }, { 'If-Match': planted });
    check('over the server a Technician is refused an MRB file with 403 and the workspace is not written', refused.status === 403 && /MRB record/.test(refused.json.error) && (await server.store.getDoc('default')).etag === planted && await files('mrb', mrbId) === 0);
    const ncFile = await call('POST', '/api/workspace/actions/FlightManeuver.addRecordFile', tech, { args: ['ncs', ncId, photo] }, { 'If-Match': planted });
    check('over the server a Technician (raise-nc) attaches evidence to an NC', ncFile.status === 200 && await files('ncs', ncId) === 1);
    const allowed = await call('POST', '/api/workspace/actions/FlightManeuver.addRecordFile', quality, { args: ['mrb', mrbId, photo] }, { 'If-Match': (await server.store.getDoc('default')).etag });
    check('over the server Quality (approve-nc) attaches a file to an MRB record', allowed.status === 200 && await files('mrb', mrbId) === 1);
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

console.log(`engine authz: ${checks} checks, all passed`);
