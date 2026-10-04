// #109: a PFMEA row delete stays traceable. The message it returns (which the server writes to its audit log for
// every remote action) and the history entry both name the PFMEA, the work instruction revision, the row and what
// the row held, so a deleted failure mode can be reconstructed from the record. A role without edit-wi is refused
// and nothing is removed or logged.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';
import { loadSample } from './lib/production-sample.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver } = host;
// Production ships no WIs (issue #247): load the sample WIs as this suite's data.
const state = loadSample(host, MES.seed());
FlightManeuver.ensure(state);
const admin = { username: 'trace-admin', displayName: 'Master Access', role: 'admin' };
const tech = { username: 'trace-tech', displayName: 'Technician', role: 'technician' };
const as = (account, fn) => host.withAccount(account, fn, state);
let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };

const wi = state.masterWIs.find(item => item.status === 'Draft');
assert.ok(wi, 'the seed has a draft work instruction');
const op = wi.operations[0].id;

// Flight Maneuver PFMEA: removePfmeaMode.
const opened = as(admin, () => FlightManeuver.openPFMEA(state, wi.id, wi.revision));
assert.ok(opened.ok, opened.message);
assert.ok(as(admin, () => FlightManeuver.setPfmeaScope(state, opened.id, { team: 'ME, QE, Design', boundaries: 'Every operation of this revision.' })).ok);
const added = as(admin, () => FlightManeuver.addPfmeaMode(state, opened.id, { opId: op, mode: 'Connector not seated', effect: 'Intermittent signal', cause: 'No latch check', controls: 'Visual', s: 5, o: 3, d: 4 }));
assert.ok(added.ok, added.message);
const pfmea = () => state.maneuver.pfmeas.find(item => item.id === opened.id);

const refusedMode = as(tech, () => FlightManeuver.removePfmeaMode(state, opened.id, added.id));
check('a role without edit-wi cannot remove a Maneuver PFMEA row, and nothing is removed', !refusedMode.ok && pfmea().rows.some(r => r.id === added.id));

const historyBefore = pfmea().history.length;
const removedMode = as(admin, () => FlightManeuver.removePfmeaMode(state, opened.id, added.id));
const modeText = removedMode.message || '';
check('a Maneuver PFMEA row delete names the PFMEA, the WI revision, the row and what it held',
  removedMode.ok && modeText.includes(opened.id) && modeText.includes(`${wi.id} Rev ${wi.revision}`) && modeText.includes(added.id) && modeText.includes('Connector not seated') && modeText.includes('RPN 60'), modeText);
const lastMode = pfmea().history.at(-1);
check('the same text is written to the PFMEA history with the actor', pfmea().history.length === historyBefore + 1 && lastMode.action === modeText && /ACCT-trace-admin/.test(lastMode.actor), JSON.stringify(lastMode));
check('the row is gone and the workspace still validates', !pfmea().rows.some(r => r.id === added.id) && MES.validate(state));

// Work instruction PFMEA table: updatePfmeaRow with remove.
assert.ok(as(admin, () => MES.setWICriticalSafety(state, wi.id, wi.revision, true)).ok);
const row = as(admin, () => MES.addPfmeaRow(state, wi.id, wi.revision, { opId: op, mode: 'Under-torque', effect: 'Loss of preload', cause: 'Wrong unit', s: 4, o: 2, d: 3 }));
assert.ok(row.ok, row.message);
const wiNow = () => MES.findWI(state, wi.id, wi.revision);
const rowId = wiNow().pfmea.rows.at(-1).id;

const refusedRow = as(tech, () => MES.updatePfmeaRow(state, wi.id, wi.revision, rowId, { remove: true }));
check('a role without edit-wi cannot remove a WI PFMEA row, and nothing is removed', !refusedRow.ok && wiNow().pfmea.rows.some(r => r.id === rowId));

const removedRow = as(admin, () => MES.updatePfmeaRow(state, wi.id, wi.revision, rowId, { remove: true }));
const rowText = removedRow.message || '';
check('a WI PFMEA row delete names the WI revision, the row and what it held',
  removedRow.ok && rowText.includes(`${wi.id} Rev ${wi.revision}`) && rowText.includes(rowId) && rowText.includes('Under-torque') && rowText.includes('RPN 24'), rowText);
const lastRow = wiNow().history.at(-1);
check('the same text is written to the WI history with the actor', lastRow.action === rowText && /ACCT-trace-admin/.test(lastRow.actor), JSON.stringify(lastRow));
check('the WI row is gone and the workspace still validates', !wiNow().pfmea.rows.some(r => r.id === rowId) && MES.validate(state));
check('neither message uses an em dash', !/—/.test(modeText + rowText));

console.log(`${checks} checks passed`);
