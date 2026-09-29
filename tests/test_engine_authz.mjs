// Engine write paths that are reachable as server actions check the caller's capability themselves, so a direct
// POST /api/workspace/actions/<name> cannot do what the page would refuse. Each rule is checked for the refusal
// (nothing changes) and for the role that is meant to do it.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver } = host;
const account = (role, name) => ({ username: `authz-${role}`, displayName: name, role });
const general = account('general', 'Gale General');
const technician = account('technician', 'Terry Tech');
const operator = account('operator', 'Owen Operator');
const me = account('me', 'Morgan Engineer');
const qe = account('qe', 'Quinn Quality');
const qm = account('qm', 'Quincy Manager');
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
  check('anyone who can raise an NC still attaches a file to it', added.ok);
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

console.log(`engine authz: ${checks} checks, all passed`);
