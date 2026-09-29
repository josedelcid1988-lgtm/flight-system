import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';
import { createServer } from '../server/server.mjs';

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
check('editing a signed calibration field is rejected by entry validation', !MES.validate(tampered));
check('editing a signed calibration field is detected by manifest verification', !MES.verifyManifests(tampered).ok);
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

// P1 follow-up: an emptied manifest must fail entry validation, not just the verifier.
const emptied = structuredClone(state);
emptied.calibrationLog[emptied.calibrationLog.length - 1].calibrationSignature.manifest = {};
check('an emptied calibration manifest fails entry validation', !MES.validate(emptied));
check('an emptied calibration manifest fails manifest verification', !MES.verifyManifests(emptied).ok);
const rehashed = structuredClone(state);
rehashed.calibrationLog[rehashed.calibrationLog.length - 1].calibrationSignature.manifest.hash = '0'.repeat(64);
check('a manifest with a mismatched hash fails entry validation', !MES.validate(rehashed));
const resignMeaning = structuredClone(state);
resignMeaning.calibrationLog[resignMeaning.calibrationLog.length - 1].calibrationSignature.manifest.meaning = 'Something else';
check('a manifest with a rebound meaning fails entry validation', !MES.validate(resignMeaning));

// Server gate: validState runs manifest verification, not just entry validation.
const srv = createServer({ dbPath: ':memory:', quiet: true, indexPath: fileURLToPath(new URL('../index.html', import.meta.url)) });
check('the server gate accepts a valid workspace', srv.validState(structuredClone(state)) === null);
const srvEmptied = srv.validState(emptied);
check('the server gate rejects a workspace with an emptied manifest', typeof srvEmptied === 'string' && srvEmptied.length > 0);
const shapeHole = structuredClone(state);
shapeHole._probe = { manifest: {} };
check('the server gate rejects a manifest that entry validation ignores', MES.validate(shapeHole) && typeof srv.validState(shapeHole) === 'string');

// P1 regression: a non-calibration payload that uses "manifest" as an ordinary data key
// (for example an AI analysis draft body) is payload data, not a signature. updateSkillDraft
// accepts it, and the manifest walk plus the server gate must leave it untouched instead of
// rejecting it as a malformed signature.
const spc = run(qa, () => MES.runSkill(state, { skill: 'spc-chart-builder', values: [10.1, 10.2, 9.9, 10.0, 10.3], reason: 'Exercise the draft body manifest-key regression.' }));
check('a skill draft is created', spc.ok && !!spc.draftId);
const draftUpdated = run(qa, () => MES.updateSkillDraft(state, spc.draftId, { summary: 'review', manifest: 'supplier package manifest' }, 'The evidence references the supplier package manifest.'));
check('updateSkillDraft accepts a body that uses manifest as an ordinary key', draftUpdated.ok);
check('a draft body with a manifest key passes manifest verification', MES.verifyManifests(state).ok);
check('a draft body with a manifest key passes the server gate', MES.validate(state) && srv.validState(structuredClone(state)) === null);
// ...while a tampered calibration manifest is still rejected by the same gate.
check('the server gate still rejects a tampered calibration manifest', typeof srv.validState(tampered) === 'string');

// P1: a calibration-log entry whose description omits TORQUE must not declassify a seeded
// torque wrench. Torque classification is authoritative from the seed record (tool identity),
// never from a log entry's free-text description.
const tqSeed = MES.CAL_TOOLS.find(t => t.tag === 'NONE-174');
check('the seed classifies NONE-174 as a torque wrench', !!tqSeed && MES.isTorqueTool(tqSeed) === true);
const tqRec = run(qa, () => MES.recordCalibration(state, { tag: 'NONE-174', description: 'CLICK WRENCH', serial: 'A75179030', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: 'Production Floor', note: '' }));
const tqCheck = MES.toolCheck('NONE-174', now, state);
check('a log entry without TORQUE in its description does not declassify a seeded torque wrench', tqRec.ok && tqCheck.ok && MES.isTorqueTool(tqCheck.tool) === true);
check('the torque-evidence requirement survives declassification (completeOperation missingTorque gate)', tqCheck.ok && MES.isTorqueTool(tqCheck.tool) === true);
const seedOnly = MES.toolCheck('NONE-175', now, state);
check('a seeded torque wrench with no log entry still classifies as a torque tool', seedOnly.ok && MES.isTorqueTool(seedOnly.tool) === true);
const ntRec = run(qa, () => MES.recordCalibration(state, { tag: 'NT-TOOL', description: 'CLICK WRENCH', serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const ntCheck = MES.toolCheck('NT-TOOL', now, state);
check('a log-only tool without TORQUE in its description is not a torque tool', ntRec.ok && ntCheck.ok && MES.isTorqueTool(ntCheck.tool) === false);
console.log(`calibration: ${checks} checks, all passed`);
