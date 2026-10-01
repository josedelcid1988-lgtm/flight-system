import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';
import { loadSample } from './lib/production-sample.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver: FM } = host;

// Production ships no WIs (issue #247): load the sample WIs as this suite's data.
const state = loadSample(host, MES.seed());
FM.ensure(state);
assert.equal(state.maneuver.cars.length, 0, 'production first run has no sample CAR records');
assert.equal(state.maneuver.mrb.length, 0, 'production first run has no sample MRB records');
assert.equal(state.maneuver.ncs.length, 0, 'production first run has no sample NC records');
assert.equal(state.maneuver.sprs.length, 0, 'production first run has no sample SPR records');
assert.equal(MES.validate(state), true, 'empty production registry validates');

const damagedWI = structuredClone(state);
const wi = damagedWI.masterWIs.find(item => item.revision === 'A');
wi.operations[0].steps[0].title = '';
const damagedWIBefore = JSON.stringify(damagedWI);
assert.equal(MES.ensureMasterWIs(damagedWI), damagedWI);
assert.equal(JSON.stringify(damagedWI), damagedWIBefore, 'malformed master WI is not reseeded or changed');
assert.equal(MES.validate(damagedWI), false);
const wiIssue = MES.diagnose(damagedWI);
assert.match(wiIssue.where, new RegExp(`${wi.id} Rev ${wi.revision}`));
assert.match(wiIssue.detail, /operations\[0\]\.steps\[0\]\.title/);
assert.equal(wiIssue.fix, null, 'master WI damage has no automatic repair');

const damagedManeuver = structuredClone(state);
damagedManeuver.maneuver.cars.push({ id: 'CAR-1001', title: '' });
const damagedManeuverBefore = JSON.stringify(damagedManeuver);
FM.ensure(damagedManeuver);
assert.equal(JSON.stringify(damagedManeuver), damagedManeuverBefore, 'invalid Flight Maneuver records are not replaced');
assert.equal(MES.validate(damagedManeuver), false);
const maneuverIssue = MES.diagnose(damagedManeuver);
assert.match(maneuverIssue.where, /CAR-1001/);
assert.equal(maneuverIssue.fix, null, 'Flight Maneuver damage has no automatic repair');

const demoSample = structuredClone(state);
FM.seedDemoRecords(demoSample);
assert.ok(demoSample.maneuver.cars.length > 0, 'the explicit demo seeder still creates demo examples');
assert.equal(MES.validate(demoSample), true, 'explicitly seeded demo records validate');

console.log('load safety: production does not seed or overwrite records; damaged masters are diagnosed and preserved');
