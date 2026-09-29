import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const state = MES.seed();
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
const tech = { username: 'tech-sam', displayName: 'Sam Tech', role: 'technician' };
const run = (account, fn) => host.withAccount(account, fn, state);
let checks = 0;
const check = (name, result) => { checks += 1; assert.ok(result, name); console.log(`ok ${name}`); };
const entry = { tag: 'TEST-001', description: 'DIGITAL CALIPER', serial: 'SN-1', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: 'Production Floor', note: 'Lab cert 42' };

check('new Flight workspaces include an empty calibration log', Array.isArray(state.calibrationLog) && state.calibrationLog.length === 0);
const old = structuredClone(state);
delete old.calibrationLog;
const upgraded = MES.upgrade(old);
check('a valid existing workspace upgrades with an empty calibration log', !!upgraded && Array.isArray(upgraded.calibrationLog) && MES.validate(upgraded));

check('recordCalibration resolves as a server action', typeof host.resolveAction('MES.recordCalibration') === 'function');
check('updateCalibration resolves as a server action', typeof host.resolveAction('MES.updateCalibration') === 'function');
check('calibrationStatus stays read-only and is not remotely callable', host.resolveAction('MES.calibrationStatus') === null);

check('a technician cannot record a calibration', !run(tech, () => MES.recordCalibration(state, entry)).ok);
const recorded = run(qa, () => MES.recordCalibration(state, entry));
check('a QA Manager records a calibration entry', recorded.ok && recorded.id === 'CALLOG-00001' && state.calibrationLog.length === 1 && MES.validate(state));
check('the calibration entry carries a signed manifest that verifies', state.calibrationLog[0].calibrationSignature && MES.verifyManifests(state).ok);
check('a due date before the calibration date is refused', !run(qa, () => MES.recordCalibration(state, { ...entry, tag: 'TEST-002', calibratedAt: '2027-09-28', expires: '2026-09-28' })).ok);

const now = new Date().toISOString();
check('point-of-use validation accepts a tool recorded in the log', MES.toolCheck('TEST-001', now, state).ok);
const quarantine = run(qa, () => MES.recordCalibration(state, { tag: 'CAL-022', description: 'DIGITAL CALIPER', serial: '150151267', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: 'Quarantined', note: '' }));
check('a newly recorded quarantine supersedes the shipped snapshot at point of use', quarantine.ok && !MES.toolCheck('CAL-022', now, state).ok && /returns to service/.test(MES.toolCheck('CAL-022', now, state).message));

const priorJson = JSON.stringify(state.calibrationLog[0]);
const corrected = run(qa, () => MES.updateCalibration(state, 'CALLOG-00001', { note: 'Lab cert 43, reissued' }));
check('a correction appends a superseding entry instead of editing', corrected.ok && corrected.id === 'CALLOG-00003' && state.calibrationLog.length === 3 && state.calibrationLog[2].supersedes === 'CALLOG-00001');
check('the original entry is untouched by the correction', JSON.stringify(state.calibrationLog[0]) === priorJson);
check('calibrationStatus returns the latest entry for the tag', MES.calibrationStatus(state, 'test-001').id === 'CALLOG-00003');
check('a correction to a missing entry is refused', !run(qa, () => MES.updateCalibration(state, 'CALLOG-99999', { note: 'x' })).ok);
check('the log still validates and every manifest still verifies', MES.validate(state) && MES.verifyManifests(state).ok);

const tampered = structuredClone(state);
tampered.calibrationLog[2].expires = '2030-01-01';
check('editing a signed calibration field is detected by manifest verification', MES.validate(tampered) && !MES.verifyManifests(tampered).ok);
const broken = structuredClone(state);
broken.calibrationLog[2].expires = 'not-a-date';
check('a malformed calibration entry invalidates the workspace', !MES.validate(broken));

// B1 regression: a correction to an already-superseded entry is refused, so a
// quarantined tool cannot be silently restored to usable by correcting the old entry.
const b1rec = run(qa, () => MES.recordCalibration(state, { tag: 'B1-TOOL', description: 'TORQUE WRENCH', serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const b1quar = run(qa, () => MES.updateCalibration(state, b1rec.id, { status: 'Quarantined', note: 'dropped on floor' }));
check('a correction to a superseded entry is refused', b1rec.ok && b1quar.ok && !run(qa, () => MES.updateCalibration(state, b1rec.id, { note: 'sneaky restore' })).ok);
check('the quarantined tool still reads unusable after the refused correction', !MES.toolCheck('B1-TOOL', now, state).ok && MES.calibrationStatus(state, 'B1-TOOL').status === 'Quarantined');

// B2 regression: atpAssets resolves through the calibration log first and fails closed.
check('atpAssets refuses a quarantined tool that exists only in the calibration log', !MES.atpAssets([{ asset: 'B1-TOOL', description: 'torque wrench' }], now, state).ok);
const b2rec = run(qa, () => MES.recordCalibration(state, { tag: 'B2-TOOL', description: 'MICROMETER', serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const b2res = MES.atpAssets([{ asset: 'b2-tool', description: 'micrometer' }], now, state);
check('atpAssets accepts a usable logged tool from the calibration log', b2rec.ok && b2res.ok && b2res.list[0].asset === 'B2-TOOL' && b2res.list[0].source === 'Calibrated Tool Log');

// B3 regression: an unsigned calibration entry fails validation and manifest verification.
const unsigned = structuredClone(state);
delete unsigned.calibrationLog[unsigned.calibrationLog.length - 1].calibrationSignature;
check('a calibration entry without a signature invalidates the workspace', !MES.validate(unsigned));
check('verifyManifests fails on an unsigned calibration entry instead of skipping it', !MES.verifyManifests(unsigned).ok);
console.log(`calibration: ${checks} checks, all passed`);
