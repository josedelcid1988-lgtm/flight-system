import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const entry = { tag: 'TEST-001', description: 'DIGITAL CALIPER', torque: false, serial: 'SN-1', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: 'Production Floor', note: 'Lab cert 42' };

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

// Fixed point-of-use clock. The fixtures and the shipped CAL_TOOLS seed carry fixed calibration and due
// dates, so every point-of-use check runs at this reference time instead of the wall clock; otherwise the
// seed assertions start failing once NONE-175 expires (2026-10-17) and the fixtures once they expire.
const now = '2026-10-01T19:00:00.000Z';
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
const b1rec = run(qa, () => MES.recordCalibration(state, { tag: 'B1-TOOL', description: 'TORQUE WRENCH', torque: true, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const b1quar = run(qa, () => MES.updateCalibration(state, b1rec.id, { status: 'Quarantined', note: 'dropped on floor' }));
check('a correction to a superseded entry is refused', b1rec.ok && b1quar.ok && !run(qa, () => MES.updateCalibration(state, b1rec.id, { note: 'sneaky restore' })).ok);
check('the quarantined tool still reads unusable after the refused correction', !MES.toolCheck('B1-TOOL', now, state).ok && MES.calibrationStatus(state, 'B1-TOOL').status === 'Quarantined');

// B2 regression: atpAssets resolves through the calibration log first and fails closed.
check('atpAssets refuses a quarantined tool that exists only in the calibration log', !MES.atpAssets([{ asset: 'B1-TOOL', description: 'torque wrench' }], now, state).ok);
const b2rec = run(qa, () => MES.recordCalibration(state, { tag: 'B2-TOOL', description: 'MICROMETER', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
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
const ntRec = run(qa, () => MES.recordCalibration(state, { tag: 'NT-TOOL', description: 'CLICK WRENCH', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const ntCheck = MES.toolCheck('NT-TOOL', now, state);
check('a log-only tool without TORQUE in its description is not a torque tool', ntRec.ok && ntCheck.ok && MES.isTorqueTool(ntCheck.tool) === false);

// #38: the asset tag rule matches its message and the form's maxlength: 2 to 40 characters.
const tag40 = 'T' + '1'.repeat(39);
const rec40 = run(qa, () => MES.recordCalibration(state, { ...entry, tag: tag40 }));
check('a 40-character asset tag is accepted', tag40.length === 40 && rec40.ok && MES.validate(state));
const rec41 = run(qa, () => MES.recordCalibration(state, { ...entry, tag: tag40 + '2' }));
check('a 41-character asset tag is refused with the 2 to 40 message', !rec41.ok && /2 to 40/.test(rec41.message));
check('a 1-character asset tag is refused', !run(qa, () => MES.recordCalibration(state, { ...entry, tag: 'X' })).ok);

// #39: a correction honors the same 5,000-entry cap as a new record, so it cannot push a full log
// past the limit that validation enforces.
const full = structuredClone(state);
const fullTarget = MES.calibrationStatus(full, 'CAL-022').id;
while (full.calibrationLog.length < 5000) full.calibrationLog.push({ id: `FILLER-${full.calibrationLog.length}` });
const fullCorrect = host.withAccount(qa, () => MES.updateCalibration(full, fullTarget, { note: 'correction on a full log' }), full);
check('a correction to a full calibration log is refused', !fullCorrect.ok && /5,000/.test(fullCorrect.message) && full.calibrationLog.length === 5000);
check('a new record on a full calibration log is refused', !host.withAccount(qa, () => MES.recordCalibration(full, { ...entry, tag: 'FULL-001' }), full).ok && full.calibrationLog.length === 5000);
// #40: a calibration dated after today is refused at record time, and at point of use a tool is not
// usable before its calibration date.
const futureRec = run(qa, () => MES.recordCalibration(state, { ...entry, tag: 'DATE-FUT', calibratedAt: '2099-01-01', expires: '2099-12-31' }));
check('a calibration dated in the future is refused', !futureRec.ok && /later than today/.test(futureRec.message) && !MES.calibrationStatus(state, 'DATE-FUT'));
const dateRec = run(qa, () => MES.recordCalibration(state, { ...entry, tag: 'DATE-001', calibratedAt: '2026-09-28', expires: '2027-09-28' }));
check('a calibration dated today or earlier is recorded', dateRec.ok);
const beforeCal = MES.toolCheck('DATE-001', '2026-09-27T19:00:00.000Z', state);
check('a tool is not usable on a day before its calibration date', !beforeCal.ok && /2026-09-28/.test(beforeCal.message));
check('the same tool is usable from its calibration date on', MES.toolCheck('DATE-001', '2026-09-28T19:00:00.000Z', state).ok && MES.toolCheck('DATE-001', now, state).ok);

// #47: a correction may fix a mis-entered calibration date, under the same rules as a new record.
const dateFix = run(qa, () => MES.updateCalibration(state, dateRec.id, { calibratedAt: '2026-09-26' }));
check('a correction changes the calibration date', dateFix.ok && MES.calibrationStatus(state, 'DATE-001').calibratedAt === '2026-09-26' && MES.calibrationStatus(state, 'DATE-001').supersedes === dateRec.id);
check('the corrected calibration date is signed and verifies', MES.validate(state) && MES.verifyManifests(state).ok);
const dateFixFuture = run(qa, () => MES.updateCalibration(state, dateFix.id, { calibratedAt: '2099-01-01', expires: '2099-12-31' }));
check('a correction to a future calibration date is refused', !dateFixFuture.ok && /later than today/.test(dateFixFuture.message) && MES.calibrationStatus(state, 'DATE-001').id === dateFix.id);
const dateFixAfterDue = run(qa, () => MES.updateCalibration(state, dateFix.id, { calibratedAt: '2026-09-28', expires: '2026-09-28' }));
check('a correction that puts the due date on or before the calibration date is refused', !dateFixAfterDue.ok && MES.calibrationStatus(state, 'DATE-001').id === dateFix.id);
// #48, #53, #58, #59, #65: every point-of-use list (buy-off tools, torque tools, ATP assets) comes from
// one engine helper that reads the seed and the live calibration log together.
check('calibratedToolChecks is exported and not remotely callable', typeof MES.calibratedToolChecks === 'function' && host.resolveAction('MES.calibratedToolChecks') === null);
const sugRec = run(qa, () => MES.recordCalibration(state, { ...entry, tag: 'SUG-001', description: 'OLD GAGE NAME' }));
const sugFix = run(qa, () => MES.updateCalibration(state, sugRec.id, { description: 'THREAD GAGE', expires: '2027-06-30' }));
const suggestions = MES.calibratedToolChecks(state, now);
const suggestionTags = suggestions.map(c => c.tool && c.tool.tag);
check('the tool list has one result per tag', sugRec.ok && sugFix.ok && new Set(suggestionTags).size === suggestionTags.length);
const sug = suggestions.find(c => c.tool && c.tool.tag === 'SUG-001');
check('a log-only tool is offered with its corrected description and due date', !!sug && sug.ok && sug.tool.description === 'THREAD GAGE' && sug.tool.expires === '2027-06-30');
check('a seed tool with no log entry is still offered', suggestions.some(c => c.ok && c.tool.tag === 'NONE-175'));
check('a tool quarantined through the log is listed but not usable', suggestions.some(c => c.tool && c.tool.tag === 'CAL-022' && !c.ok));
const torqueOffer = suggestions.filter(c => c.ok && MES.isTorqueTool(c.tool)).map(c => c.tool.tag);
check('the torque list keeps seeded torque wrenches and leaves out non-torque log tools', torqueOffer.includes('NONE-174') && torqueOffer.includes('NONE-175') && !torqueOffer.includes('NT-TOOL'));
check('each list entry matches the single-tool point-of-use check', suggestions.every(c => { const one = MES.toolCheck(c.tool.tag, now, state); return one.ok === c.ok && one.tool.expires === c.tool.expires; }));
// The log is read once for the whole list, not once per tag: count element reads on a large log.
const bigLog = structuredClone(state.calibrationLog);
for (let i = 0; i < 2000; i += 1) bigLog.push({ id: `CALLOG-${String(90000 + i)}`, tag: `BIG-${i}`, description: 'FILLER', serial: '', calibratedAt: '2026-09-01', expires: '2027-09-01', status: 'In Calibration', location: '', note: '' });
let logReads = 0;
const countedLog = new Proxy(bigLog, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) logReads += 1; return Reflect.get(target, key, receiver); } });
const bigState = { ...structuredClone({ ...state, calibrationLog: [] }), calibrationLog: countedLog };
const bigChecks = MES.calibratedToolChecks(bigState, now);
check('the tool list reads the calibration log a bounded number of times', bigChecks.length >= 2000 && logReads <= bigLog.length * 4);
// Page and React interface: no suggestion list is built from the seed alone, and every point-of-use
// check passes the workspace so it resolves through the calibration log.
const pageSources = [['index.html', readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')], ['src/react/flight-ui.jsx', readFileSync(fileURLToPath(new URL('../src/react/flight-ui.jsx', import.meta.url)), 'utf8')]];
for (const [name, source] of pageSources) {
  check(`${name} builds no tool list from the seed alone`, !/MES\.CAL_TOOLS\.(filter|forEach|find|some)\(/.test(source));
  const calls = [...source.matchAll(/MES\.toolCheck\(((?:[^()]|\([^()]*\))*)\)/g)].map(m => m[1].trim());
  check(`${name} passes the workspace to every MES.toolCheck call`, calls.length > 0 && calls.every(args => /,\s*state$/.test(args)));
}
// #54: traceability search resolves a tag through the live calibration log, not only the seed.
const traceState = structuredClone(state);
const traceOrder = { id: 'WO-TRACE-1', status: 'In Work', partNumber: 'PN-TRACE', revision: 'A', pedigree: 'Production', subcategory: 'Mfg.', materials: [], tickets: [], history: [], operations: [{ id: 'OP-1', title: 'Torque fasteners', buyoff: { at: '2026-09-30T18:00:00.000Z', name: 'Sam Tech', tools: [{ tag: 'B2-TOOL', description: 'MICROMETER' }] } }, { id: 'OP-2', title: 'Inspect', buyoff: { at: '2026-09-30T19:00:00.000Z', name: 'Sam Tech', tools: [{ tag: 'NONE-175', description: 'TORQUE WRENCH' }] } }] };
traceState.orders = [traceOrder];
const traceLog = MES.traceSearch(traceState, 'b2-tool');
check('searching a log-only tool tag resolves it as a tool', traceLog.kind === 'tool' && !!traceLog.tool && traceLog.tool.tag === 'B2-TOOL' && traceLog.tool.description === 'MICROMETER');
check('searching a log-only tool tag finds the operations that used it', traceLog.orders.length === 1 && traceLog.orders[0].why.includes('tool used') && traceLog.orders[0].ops.map(op => op.id).join() === 'OP-1');
const traceSeed = MES.traceSearch(traceState, 'NONE-175');
check('searching a seed tool tag still finds its operations', traceSeed.kind === 'tool' && traceSeed.orders.length === 1 && traceSeed.orders[0].ops.map(op => op.id).join() === 'OP-2');
const traceCorrected = MES.traceSearch(traceState, 'SUG-001');
check('a corrected tool shows its current log values in the search result', traceCorrected.kind === 'tool' && traceCorrected.tool.description === 'THREAD GAGE' && traceCorrected.tool.expires === '2027-06-30');
check('an unknown tag is not treated as a tool', MES.traceSearch(traceState, 'NO-SUCH-TOOL').kind !== 'tool');
// #56: a buy-off and an ATP asset list record which calibration entry was checked and where the tool
// record came from, instead of citing the shipped snapshot for a live-log tool.
check('toolUseRecords is exported and not remotely callable', typeof MES.toolUseRecords === 'function' && host.resolveAction('MES.toolUseRecords') === null);
const liveCheck = MES.toolCheck('B2-TOOL', now, state), seedCheck = MES.toolCheck('NONE-175', now, state);
const liveEntryId = MES.calibrationStatus(state, 'B2-TOOL').id;
const mixed = MES.toolUseRecords([liveCheck, seedCheck], { 'NONE-175': { value: '25', unit: 'in-lb' } });
const liveUse = mixed.tools.find(t => t.tag === 'B2-TOOL'), seedUse = mixed.tools.find(t => t.tag === 'NONE-175');
check('a live-log tool on a buy-off carries its CALLOG entry id and the calibration log as source', liveCheck.ok && liveUse.calibrationEntry === liveEntryId && liveUse.source === 'Calibration log');
check('a seed tool on a buy-off cites the shipped snapshot and no entry id', seedUse.calibrationEntry === undefined && seedUse.source.includes(MES.CAL_SNAPSHOT) && seedUse.torque.value === 25 && seedUse.torque.unit === 'in-lb');
check('the buy-off tool log label names both sources when both were used', /Calibration log/.test(mixed.toolLog) && mixed.toolLog.includes(MES.CAL_SNAPSHOT));
check('a seed-only buy-off keeps the snapshot label', MES.toolUseRecords([seedCheck], { 'NONE-175': { value: '25', unit: 'in-lb' } }).toolLog === MES.CAL_SNAPSHOT);
check('a log-only buy-off is labeled the calibration log', MES.toolUseRecords([liveCheck], {}).toolLog === 'Calibration log');
const pageSource = pageSources[0][1];
check('completeOperation records its tools through toolUseRecords', /const toolUse = toolUseRecords\(toolChecks, execution\.torque\)/.test(pageSource) && /tools: toolUse\.tools, toolLog: toolUse\.toolLog/.test(pageSource));
const atpLive = MES.atpAssets([{ asset: 'B2-TOOL' }, { asset: 'NONE-175' }], now, state);
check('an ATP asset from the calibration log carries its CALLOG entry id', atpLive.ok && atpLive.list[0].calibrationEntry === liveEntryId && atpLive.list[1].calibrationEntry === undefined);
// #57: the maintenance register and work-unit links accept a tool recorded only in the calibration log.
const admin = { username: 'admin-ada', displayName: 'Ada Admin', role: 'admin' };
const mntState = structuredClone(state);
const mntRun = (account, fn) => host.withAccount(account, fn, mntState);
const mntOpen = mntRun(admin, () => MES.recordMaintenance(mntState, { assetTag: 'sug-001', type: MES.MAINTENANCE_TYPES[0], description: 'Anvil chipped, send for repair' }));
check('maintenance can be opened on a tool recorded only in the calibration log', mntOpen.ok && MES.validate(mntState));
const mntBlocked = MES.toolCheck('SUG-001', now, mntState);
check('a log-only tool under open maintenance is unusable at point of use', !mntBlocked.ok && /open/.test(mntBlocked.message));
check('maintenance on an unknown tag is still refused', !mntRun(admin, () => MES.recordMaintenance(mntState, { assetTag: 'NO-SUCH-TOOL', type: MES.MAINTENANCE_TYPES[0], description: 'Not a registered asset' })).ok);
const unitLink = mntRun(admin, () => MES.addEquipmentUnit(mntState, { name: 'Micrometer bench', workCenterId: MES.WORK_CENTERS[0].id, toolTag: 'b2-tool' }));
check('a work unit can link a tool recorded only in the calibration log', unitLink.ok && unitLink.unit.toolTag === 'B2-TOOL' && MES.validate(mntState));
check('a work unit link to an unknown tag is still refused', !mntRun(admin, () => MES.addEquipmentUnit(mntState, { name: 'Unknown bench', workCenterId: MES.WORK_CENTERS[0].id, toolTag: 'NO-SUCH-TOOL' })).ok);
const reactSource = pageSources[1][1];
check('the React equipment forms list calibration-log tools, not the seed alone', !/MES\.CAL_TOOLS\.map\(/.test(reactSource) && (reactSource.match(/MES\.calibratedToolChecks\(state\)\.map\(c => c\.tool\)/g) || []).length === 2);
// #49: diagnose names the calibration entry and field that fail validation, for browser recovery and
// the server error path, and never offers an automatic repair of a signed record.
check('diagnose reports nothing for a valid workspace with a calibration log', MES.validate(state) && MES.diagnose(state) === null);
const diagBroken = structuredClone(state);
diagBroken.calibrationLog[2].expires = 'not-a-date';
const diagField = MES.diagnose(diagBroken);
check('diagnose names the malformed calibration entry and field', !!diagField && diagField.where === 'CALLOG-00003' && /CALLOG-00003/.test(diagField.detail) && /expires/.test(diagField.detail) && !diagField.fix);
const srvDiag = srv.validState(structuredClone(diagBroken));
check('the server error names the malformed calibration entry', typeof srvDiag === 'string' && /CALLOG-00003/.test(srvDiag));
const diagDup = structuredClone(state);
diagDup.calibrationLog.push(structuredClone(diagDup.calibrationLog[0]));
const diagDupResult = MES.diagnose(diagDup);
check('diagnose names a duplicate calibration entry id', !!diagDupResult && /duplicate/i.test(diagDupResult.detail) && /CALLOG-00001/.test(diagDupResult.detail));
const diagUnsigned = structuredClone(state);
delete diagUnsigned.calibrationLog[0].calibrationSignature;
const diagUnsignedResult = MES.diagnose(diagUnsigned);
check('diagnose names an unsigned calibration entry', !!diagUnsignedResult && diagUnsignedResult.where === 'CALLOG-00001' && /signature/.test(diagUnsignedResult.detail));
const diagNotArray = structuredClone(state);
diagNotArray.calibrationLog = {};
check('diagnose reports a calibration log that is not a list', /calibration log/i.test((MES.diagnose(diagNotArray) || {}).detail || ''));
// #66: an AI draft body is payload, even when it holds a plain object under a "manifest" key; the
// draft's own signature manifest is still checked, and a stray manifest elsewhere is still refused.
const objDraft = run(qa, () => MES.updateSkillDraft(state, spc.draftId, { summary: 'review', manifest: { document: 'supplier package', revision: 'A' } }, 'The evidence lists the supplier package manifest contents.'));
check('updateSkillDraft accepts a body with a plain-object manifest key', objDraft.ok);
check('a plain-object manifest key in a draft body passes manifest verification', MES.verifyManifests(state).ok);
check('a plain-object manifest key in a draft body passes the server gate', MES.validate(state) && srv.validState(structuredClone(state)) === null);
const nestedDraft = structuredClone(state);
nestedDraft.aiSkillDrafts.find(d => d.id === spc.draftId).body = { sections: [{ manifest: { items: 3 } }] };
check('a nested plain-object manifest key inside a draft body is not treated as a signature', !MES.verifyManifests(nestedDraft).failures.some(f => /body/.test(f.where)));
const draftSigTampered = structuredClone(state);
delete draftSigTampered.aiSkillDrafts.find(d => d.id === spc.draftId).manifest.meaning;
check('the draft\'s own signature manifest is still verified', !MES.verifyManifests(draftSigTampered).ok);
const strayManifest = structuredClone(state);
strayManifest._probe = { manifest: { document: 'not a signature' } };
check('a plain-object manifest outside a draft body is still refused by the server gate', typeof srv.validState(strayManifest) === 'string');
// #114 (#115 duplicate): the edit-history bodyHash covers the full body. It used the manifest-stripping
// canonical form, so two revisions that differed only in a payload key named manifest hashed the same.
const payloadForm = value => JSON.stringify(value, (key, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, k) => { o[k] = val[k]; return o; }, Object.create(null)) : val);
const hist = structuredClone(state), runHist = fn => host.withAccount(qa, fn, hist);
const draftOf = s => s.aiSkillDrafts.find(d => d.id === spc.draftId);
const lastEdit = () => draftOf(hist).editHistory[draftOf(hist).editHistory.length - 1];
const revA = { summary: 'review', manifest: { document: 'supplier package', revision: 'A' } };
const revB = { summary: 'review', manifest: { document: 'supplier package', revision: 'B' } };
check('the old stripping form hashed revisions that differ only in a manifest key identically', MES.sha256(MES.canonical(revA)) === MES.sha256(MES.canonical(revB)));
runHist(() => MES.updateSkillDraft(hist, spc.draftId, revA, 'The supplier package manifest is at revision A.'));
const hashA = lastEdit().bodyHash;
runHist(() => MES.updateSkillDraft(hist, spc.draftId, revB, 'The supplier package manifest moved to revision B.'));
const hashB = lastEdit().bodyHash;
check('edits that differ only in a manifest-named payload key record different body hashes', /^[0-9a-f]{64}$/.test(hashA) && /^[0-9a-f]{64}$/.test(hashB) && hashA !== hashB);
check('the recorded body hash is the key-preserving digest of the body and names its form', hashB === MES.sha256(payloadForm(revB)) && lastEdit().bodyHashForm === 'payload');
runHist(() => MES.updateSkillDraft(hist, spc.draftId, { manifest: { revision: 'B', document: 'supplier package' }, summary: 'review' }, 'Resubmitted the same revision B content.'));
check('identical bodies record the same body hash regardless of key order', lastEdit().bodyHash === hashB);
// #141: an own __proto__ key falls outside the signed canonical forms, so saved data may not carry one.
// updateSkillDraft refuses it, and validation, diagnose and the server gate refuse a workspace holding one.
const protoA = JSON.parse('{"summary":"review","__proto__":{"revision":"A"}}');
const nestedProto = JSON.parse('{"summary":"review","sections":[{"__proto__":{"items":3}}]}');
const beforeProto = JSON.stringify(draftOf(hist));
const protoRefused = runHist(() => MES.updateSkillDraft(hist, spc.draftId, protoA, 'The body carries a __proto__ key at revision A.'));
const nestedRefused = runHist(() => MES.updateSkillDraft(hist, spc.draftId, nestedProto, 'A nested section carries a __proto__ key.'));
check('updateSkillDraft refuses a body with an own __proto__ key and names the key', !protoRefused.ok && /__proto__/.test(protoRefused.message) && !nestedRefused.ok && JSON.stringify(draftOf(hist)) === beforeProto);
const probeWith = key => { const s = JSON.parse(JSON.stringify(hist)); s._probe = JSON.parse(`{"list":[{"${key}":{"text":"x"}}]}`); return s; };
check('the same nested payload validates under an ordinary key but fails under __proto__ anywhere in the workspace', MES.validate(probeWith('other')) && !MES.validate(probeWith('__proto__')) && MES.diagnose(probeWith('__proto__')).where === 'workspace._probe.list[0]' && /__proto__/.test(srv.validState(probeWith('__proto__')) || ''));
const lookalike = JSON.parse(JSON.stringify(hist)); lookalike._probe = JSON.parse('{"text":"see \\"__proto__\\": in the spec","x\\"__proto__":1,"__proto__x":2}');
check('text that only looks like a __proto__ key (inside a string value or a longer key name) is not refused', !Object.hasOwn(lookalike._probe, '__proto__') && MES.validate(lookalike));
check('edits with the new body hash pass validation, manifest verification and the server gate', MES.validate(hist) && MES.verifyManifests(hist).ok && srv.validState(structuredClone(hist)) === null);
// Legacy history written before #114 has no bodyHashForm and a stripping-form hash. It still loads and validates.
const draftSubjectOf = d => ({ id: d.id, skill: d.skill, title: d.title, body: d.body, status: d.status, reason: d.reason, targetRefs: d.targetRefs, runId: d.runId, createdAt: d.createdAt, review: d.review, decision: d.decision, editHistory: d.editHistory || [], ...(/"manifest":/.test(JSON.stringify(d.body)) ? { bodyDigest: MES.sha256(payloadForm(d.body)) } : {}) });
const resignDraft = s => { const d = draftOf(s); host.withAccount(qa, () => { d.manifest = MES.signManifest(s, 'AI analysis draft edited', draftSubjectOf(d), new Date().toISOString()); }, s); return s; };
const legacy = structuredClone(hist);
draftOf(legacy).editHistory = draftOf(legacy).editHistory.map(({ bodyHashForm, ...edit }) => ({ ...edit, bodyHash: MES.sha256(MES.canonical(revA)) }));
resignDraft(legacy);
check('the re-signed control draft matches the engine draft subject', MES.validate(resignDraft(structuredClone(hist))));
check('legacy edit history without bodyHashForm still validates', draftOf(legacy).editHistory.every(e => e.bodyHashForm === undefined) && MES.validate(legacy) && MES.verifyManifests(legacy).ok && srv.validState(structuredClone(legacy)) === null);
const legacyEdited = run(qa, () => MES.updateSkillDraft(legacy, spc.draftId, revA, 'Edited again after loading legacy history.'));
check('a draft with legacy history can be edited and the new row uses the full-body hash', legacyEdited.ok && draftOf(legacy).editHistory.at(-1).bodyHashForm === 'payload' && MES.validate(legacy));
const unknownForm = structuredClone(hist);
draftOf(unknownForm).editHistory.at(-1).bodyHashForm = 'stripped';
resignDraft(unknownForm);
check('an edit-history row naming an unknown body hash form fails validation', !MES.validate(unknownForm));
// #141: a draft signed with an own __proto__ key in its body. The signed forms do not cover content under that
// key, so changing it leaves every manifest valid; the new rule is what refuses the workspace.
const protoSigned = structuredClone(hist);
draftOf(protoSigned).body = JSON.parse('{"summary":"review","__proto__":{"revision":"A"}}');
resignDraft(protoSigned);
const protoTampered = structuredClone(protoSigned);
draftOf(protoTampered).body.__proto__.revision = 'TAMPERED';
check('content changed under a signed __proto__ key still passes manifest verification (the gap #141 closes)', Object.hasOwn(draftOf(protoTampered).body, '__proto__') && MES.verifyManifests(protoTampered).ok);
check('a signed draft body holding a __proto__ key fails validation, before and after the change', !MES.validate(protoSigned) && !MES.validate(protoTampered));
const protoDiag = MES.diagnose(protoTampered);
check('diagnose names where the __proto__ key sits', !!protoDiag && protoDiag.where === `workspace.aiSkillDrafts[${protoTampered.aiSkillDrafts.findIndex(d => d.id === spc.draftId)}].body` && /__proto__/.test(protoDiag.detail) && protoDiag.fix === null);
check('the server gate refuses the tampered workspace and says why', /__proto__/.test(srv.validState(structuredClone(protoTampered)) || ''));
// Codex review on #168 (4145296659): the standalone boot path opens whatever MES.upgrade returns, and save() writes when
// MES.repair reports ok. Both close over the engine's own validate and diagnose, so the rule must live there too.
check('MES.upgrade refuses a stored workspace holding a __proto__ key, so the standalone boot path does not open it', MES.upgrade(structuredClone(protoTampered)) === null && !!MES.upgrade(structuredClone(hist)));
const protoRepair = MES.repair(structuredClone(protoTampered));
check('MES.repair does not report a __proto__ workspace as fixed, so save() refuses to write it', protoRepair.ok === false && /__proto__/.test(protoRepair.blocker?.detail || ''));
const oldVersion = structuredClone(protoTampered); oldVersion.version = 2;
check('an older-version workspace holding a __proto__ key is not upgraded either', !MES.upgrade(oldVersion));
// Codex review on #168 (4145767754): the diagnostic path walk must not overflow the stack on deeply nested input.
{ let deep = '{"__proto__":1}'; for (let n = 0; n < 5000; n += 1) deep = `{"a":${deep}}`; const d = JSON.parse(JSON.stringify(hist)); d._probe = JSON.parse(deep);
  let found = null, threw = null; try { found = MES.diagnose(d); } catch (e) { threw = e; }
  check('diagnose names a __proto__ key nested 5000 levels deep instead of overflowing the stack', !threw && !MES.validate(d) && !!found && found.where.startsWith('workspace._probe.a.a') && found.where.endsWith('.a') && /__proto__/.test(found.detail)); }
// Codex review on #168 (4145767770): a closed order holding a __proto__ key must not move into the archive, where the
// live-workspace check no longer sees it. Every archive candidate passes archivedOrderValid (server commitState, archiveOrders).
const closedEntry = { order: { id: 'WO-ARCH-1', status: 'Closed', operations: [], tickets: [] }, activity: [] };
const taintedEntry = { order: { id: 'WO-ARCH-2', status: 'Closed', operations: [JSON.parse('{"__proto__":{"note":"hidden"}}')], tickets: [] }, activity: [] };
check('an archive candidate holding a __proto__ key is refused, while a clean closed order still archives', MES.archivedOrderValid(closedEntry) && !MES.archivedOrderValid(taintedEntry));
// Codex review on #168 (4146176864): archiving must name the forbidden key, not report missing fields.
{ const a = JSON.parse(JSON.stringify(hist)); a.orders = [JSON.parse('{"id":"WO-9001","status":"Closed","inventory":{"at":"2026-09-30"},"operations":[{"__proto__":{"x":1}}],"tickets":[],"materials":[],"partNumber":"P-1"}')];
  const r = MES.archiveOrders(a);
  check('archiving a closed order that holds a __proto__ key names the order and the key, and keeps it live', !r.ok && /WO-9001/.test(r.message) && /__proto__/.test(r.message) && /WO-9001\.operations\[0\]/.test(r.message) && !/missing required/.test(r.message) && a.orders.length === 1); }
// Codex review on #168 (4146176855): a deeply nested draft body gets the key refusal (or a plain depth message), never a throw.
{ let deepProto = '{"__proto__":1}', deepPlain = '{"x":1}'; for (let n = 0; n < 5000; n += 1) { deepProto = `{"a":${deepProto}}`; deepPlain = `{"a":${deepPlain}}`; }
  let rp = null, rq = null, threw = null;
  try { rp = runHist(() => MES.updateSkillDraft(hist, spc.draftId, JSON.parse(deepProto), 'A deeply nested body with the forbidden key.')); rq = runHist(() => MES.updateSkillDraft(hist, spc.draftId, JSON.parse(deepPlain), 'A deeply nested body without the forbidden key.')); } catch (e) { threw = e; }
  check('a deeply nested draft body is refused with the __proto__ message, and one without the key with a plain depth message, never a throw', !threw && rp && !rp.ok && /__proto__/.test(rp.message) && rq && !rq.ok && /nested too deeply/.test(rq.message)); }
// #64: the calibration log is append-only. Retirement, not deletion, removes a tool from use: a retired
// tool reads unusable at point of use and its entries stay in the signed log.
check('there is no calibration delete command', MES.deleteCalibration === undefined && MES.removeCalibration === undefined && host.resolveAction('MES.deleteCalibration') === null);
const retireLogBefore = state.calibrationLog.length;
const retireLive = run(qa, () => MES.updateCalibration(state, MES.calibrationStatus(state, 'B2-TOOL').id, { status: 'Retired', note: 'Worn out, removed from service' }));
const retireSeed = run(qa, () => MES.recordCalibration(state, { tag: 'NONE-176', description: 'TORQUE WRENCH', serial: '0617112253', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'Retired', location: '', note: 'Scrapped' }));
check('retiring a tool appends entries and removes nothing', retireLive.ok && retireSeed.ok && state.calibrationLog.length === retireLogBefore + 2);
const retiredCheck = MES.toolCheck('B2-TOOL', now, state);
check('a retired log tool is unusable at point of use', !retiredCheck.ok && /Retired/.test(retiredCheck.message));
check('a retired seed tool is unusable at point of use', !MES.toolCheck('NONE-176', now, state).ok);
check('a retired tool is refused on an ATP asset list', !MES.atpAssets([{ asset: 'B2-TOOL' }], now, state).ok);
const retiredList = MES.calibratedToolChecks(state, now);
check('a retired tool is not offered as usable', !retiredList.some(c => c.ok && ['B2-TOOL', 'NONE-176'].includes(c.tool.tag)));
check('the retired tool\'s earlier signed entries stay in the log and verify', state.calibrationLog.filter(e => e.tag === 'B2-TOOL').length === 2 && MES.validate(state) && MES.verifyManifests(state).ok);
check('the record form tells the user that Retired is how a tool leaves service', /record it as Retired/.test(pageSource));
// An imported row is linked into the hash chain and the head moved, as an application write would, so each check
// below exercises the rule it names rather than the chain (#116, #117 cover the chain on their own).
const relinkHead = ws => { const log = ws.calibrationLog; ws.calibrationLogHead = { ...ws.calibrationLogHead, count: log.length, hash: log.length ? MES.calibrationEntryHash(log[log.length - 1]) : null }; };
const appendImported = (ws, e) => { const log = ws.calibrationLog; e.previousHash = log.length ? MES.calibrationEntryHash(log[log.length - 1]) : null; log.push(e); relinkHead(ws); };
// The signed subject of a calibration entry (calibrationSubject in index.html), for building imported rows.
const calSubject = e => ({ id: e.id, tag: e.tag, description: e.description, serial: e.serial, calibratedAt: e.calibratedAt, expires: e.expires, status: e.status, location: e.location, note: e.note, recordedAt: e.recordedAt, recordedBy: e.recordedBy, supersedes: e.supersedes || null, ...(e.torque !== undefined ? { torque: e.torque } : {}), ...(e.signerRole !== undefined ? { signerRole: e.signerRole } : {}) });
// #35 review: only the current entry for a tag can be corrected. With two independent entries A (usable)
// then B (Quarantined), correcting A would copy A's usable status into the newest row and re-enable the tool.
const curA = run(qa, () => MES.recordCalibration(state, { tag: 'CUR-TOOL', description: 'DIAL INDICATOR', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const curB = run(qa, () => MES.recordCalibration(state, { tag: 'CUR-TOOL', description: 'DIAL INDICATOR', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'Quarantined', location: '', note: 'Failed gage check' }));
const curLog = state.calibrationLog.length;
const staleFix = run(qa, () => MES.updateCalibration(state, curA.id, { note: 'cert reference' }));
check('a correction to an older, non-current entry for the tag is refused and names the current entry', curA.ok && curB.ok && !staleFix.ok && staleFix.message.includes(curB.id) && state.calibrationLog.length === curLog);
check('the quarantined tool stays unusable after the refused correction', !MES.toolCheck('CUR-TOOL', now, state).ok && MES.calibrationStatus(state, 'CUR-TOOL').id === curB.id);
check('the current entry can still be corrected', run(qa, () => MES.updateCalibration(state, curB.id, { note: 'Failed gage check, sent to lab' })).ok);
const staleImport = structuredClone(state), staleSource = staleImport.calibrationLog.find(e => e.id === curA.id);
appendImported(staleImport, host.withAccount(qa, () => { const e = { ...staleSource, id: 'CALLOG-09990', supersedes: curA.id, note: 'restored', recordedAt: new Date().toISOString() }; e.calibrationSignature = { manifest: MES.signManifest(staleImport, 'Calibration entry corrected', calSubject(e), e.recordedAt) }; return e; }, staleImport));
check('a workspace with a correction of a non-current entry fails validation', !MES.validate(staleImport));
check('diagnose names the correction of a non-current entry', /CALLOG-09990/.test(MES.diagnose(staleImport)?.where || '') && /not the current entry/.test(MES.diagnose(staleImport)?.detail || ''));

// #35 review: a new record cannot bring a retired tag back into use.
const reuse = run(qa, () => MES.recordCalibration(state, { tag: 'B2-TOOL', description: 'MICROMETER', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const reuseSeed = run(qa, () => MES.recordCalibration(state, { tag: 'NONE-176', description: 'TORQUE WRENCH', serial: '0617112253', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
check('a new record for a retired tag is refused and says how a mistaken retirement is undone', !reuse.ok && /retired/i.test(reuse.message) && /reason/.test(reuse.message) && !reuseSeed.ok);
check('the retired tools stay unusable after the refused records', !MES.toolCheck('B2-TOOL', now, state).ok && !MES.toolCheck('NONE-176', now, state).ok);
const reuseImport = structuredClone(state), retiredRow = MES.calibrationStatus(reuseImport, 'B2-TOOL');
appendImported(reuseImport, host.withAccount(qa, () => { const e = { ...retiredRow, id: 'CALLOG-09991', status: 'In Calibration', note: '', recordedAt: new Date().toISOString() }; delete e.supersedes; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(reuseImport, 'Calibration recorded', calSubject(e), e.recordedAt) }; return e; }, reuseImport));
check('a workspace that records a retired tag again fails validation', !MES.validate(reuseImport));
check('diagnose names the entry that records a retired tag again', /CALLOG-09991/.test(MES.diagnose(reuseImport)?.where || '') && /retired/.test(MES.diagnose(reuseImport)?.detail || ''));

// Owner decision on #35: a QA Manager may correct a Retired entry back to service, with a mandatory reason in
// the signed note. Example: TW-042 was retired after a drop, but the dropped wrench was TW-024.
const tw = run(qa, () => MES.recordCalibration(state, { tag: 'TW-042', description: 'TORQUE WRENCH', torque: true, serial: '', calibratedAt: '2026-09-26', expires: '2027-09-26', status: 'In Calibration', location: '', note: 'Lab cert 77' }));
const twRetired = run(qa, () => MES.updateCalibration(state, tw.id, { status: 'Retired', note: 'Dropped on the floor' }));
const noReason = run(qa, () => MES.updateCalibration(state, twRetired.id, { status: 'In Calibration' }));
const sameReason = run(qa, () => MES.updateCalibration(state, twRetired.id, { status: 'In Calibration', note: 'Dropped on the floor' }));
const shortReason = run(qa, () => MES.updateCalibration(state, twRetired.id, { status: 'In Calibration', note: 'oops' }));
check('returning a retired tool to service without a new reason is refused', tw.ok && twRetired.ok && !noReason.ok && /reason/.test(noReason.message) && !sameReason.ok && !shortReason.ok && !MES.toolCheck('TW-042', now, state).ok);
check('a technician cannot return a retired tool to service', !run(tech, () => MES.updateCalibration(state, twRetired.id, { status: 'In Calibration', note: 'Retired by mistake: the dropped wrench was TW-024' })).ok);
const reinstated = run(qa, () => MES.updateCalibration(state, twRetired.id, { status: 'In Calibration', note: 'Retired by mistake: the dropped wrench was TW-024' }));
const twRows = state.calibrationLog.filter(e => e.tag === 'TW-042');
check('a QA Manager returns a mistakenly retired tool to service with a reason', reinstated.ok && MES.toolCheck('TW-042', now, state).ok);
check('the retirement stays in the signed history under the same tag, with the reason on the correction', twRows.length === 3 && twRows[1].status === 'Retired' && twRows[2].supersedes === twRows[1].id && /TW-024/.test(twRows[2].note) && MES.validate(state) && MES.verifyManifests(state).ok);
const noReasonImport = structuredClone(state);
noReasonImport.calibrationLog.pop();
appendImported(noReasonImport, host.withAccount(qa, () => { const e = { ...twRows[1], id: 'CALLOG-09992', status: 'In Calibration', supersedes: twRows[1].id, recordedAt: new Date().toISOString() }; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(noReasonImport, 'Calibration entry corrected', calSubject(e), e.recordedAt) }; return e; }, noReasonImport));
check('a workspace that returns a retired tool to service without a reason fails validation', !MES.validate(noReasonImport) && /CALLOG-09992/.test(MES.diagnose(noReasonImport)?.where || ''));
// #35 review (Codex 4133296942): the current entry follows log order, so the order is bound to the signed ids.
// Reversing an independent usable entry and a later quarantine would otherwise re-enable the tool.
const orderA = run(qa, () => MES.recordCalibration(state, { tag: 'ORD-TOOL', description: 'BORE GAGE', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const orderB = run(qa, () => MES.recordCalibration(state, { tag: 'ORD-TOOL', description: 'BORE GAGE', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'Quarantined', location: '', note: 'Out of tolerance' }));
const reordered = structuredClone(state), ia = reordered.calibrationLog.findIndex(e => e.id === orderA.id), ib = reordered.calibrationLog.findIndex(e => e.id === orderB.id);
[reordered.calibrationLog[ia], reordered.calibrationLog[ib]] = [reordered.calibrationLog[ib], reordered.calibrationLog[ia]];
check('a calibration log whose entries are out of id order fails validation', orderA.ok && orderB.ok && !MES.validate(reordered));
check('diagnose names the out-of-order calibration entry', /out of order/.test(MES.diagnose(reordered)?.detail || '') && [orderA.id, orderB.id].includes(MES.diagnose(reordered)?.where));
check('the quarantine stays current in the log as recorded', !MES.toolCheck('ORD-TOOL', now, state).ok && MES.validate(state));

// #35 review (Codex 4133296971): calibration ids stay five digits. After CALLOG-99999 a new entry is refused
// before anything is written, instead of producing CALLOG-100000 and an invalid workspace.
const idFull = structuredClone(state), highRow = idFull.calibrationLog[idFull.calibrationLog.length - 1];
appendImported(idFull, host.withAccount(qa, () => { const e = { ...highRow, id: 'CALLOG-99999', tag: 'HIGH-TOOL', status: 'In Calibration', note: '', recordedAt: new Date().toISOString() }; delete e.supersedes; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(idFull, 'Calibration recorded', calSubject(e), e.recordedAt) }; return e; }, idFull));
const fullLen = idFull.calibrationLog.length, exhausted = host.withAccount(qa, () => MES.recordCalibration(idFull, { ...entry, tag: 'NEXT-TOOL' }), idFull), exhaustedFix = host.withAccount(qa, () => MES.updateCalibration(idFull, 'CALLOG-99999', { note: 'cert 9' }), idFull);
check('a new calibration entry after CALLOG-99999 is refused without writing', MES.validate(idFull) && !exhausted.ok && !exhaustedFix.ok && /CALLOG-99999/.test(exhausted.message) && idFull.calibrationLog.length === fullLen);

// #35 review (Codex 4133296980): a draft body may use "manifest" as an ordinary key (#66), and the draft's
// own signature must still cover that key, so changing it is detected.
const coveredDraft = structuredClone(state), coveredBody = coveredDraft.aiSkillDrafts.find(d => d.id === spc.draftId).body;
check('the draft fixture still carries a plain-object manifest key in its body', coveredBody && coveredBody.manifest && coveredBody.manifest.revision === 'A' && MES.validate(state) && MES.verifyManifests(state).ok);
coveredBody.manifest.revision = 'B';
check('changing a manifest key inside a signed draft body fails validation', !MES.validate(coveredDraft));
check('changing a manifest key inside a signed draft body fails manifest verification', !MES.verifyManifests(coveredDraft).ok);
const addedKey = structuredClone(state), plainDraft = run(qa, () => MES.runSkill(addedKey, { skill: 'spc-chart-builder', values: [1, 2, 3, 2, 1], reason: 'A draft whose body has no manifest key.' }));
addedKey.aiSkillDrafts.find(d => d.id === plainDraft.draftId).body.manifest = { injected: true };
check('adding a manifest key to a signed draft body fails validation', plainDraft.ok && !MES.validate(addedKey));

// #35 review (Codex 4133610007): a log-only tool's torque classification is an explicit signed answer, not a
// guess from its description, and once a tag is a torque tool no later entry can declassify it.
const clickRec = run(qa, () => MES.recordCalibration(state, { tag: 'CW-310', description: 'CLICK WRENCH', torque: 'yes', serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
const clickCheck = MES.toolCheck('CW-310', now, state);
check('a log-only click wrench recorded as a torque tool is a torque tool at point of use', clickRec.ok && state.calibrationLog.find(e => e.id === clickRec.id).torque === true && clickCheck.ok && MES.isTorqueTool(clickCheck.tool) === true);
check('the torque suggestion list offers a log-only click wrench recorded as a torque tool', MES.calibratedToolChecks(state, now).some(c => c.ok && c.tool.tag === 'CW-310' && MES.isTorqueTool(c.tool)));
const unanswered = run(qa, () => MES.recordCalibration(state, { tag: 'CW-311', description: 'CLICK WRENCH', serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
check('a new log-only tool must say whether it is a torque tool', !unanswered.ok && /torque/i.test(unanswered.message) && !state.calibrationLog.some(e => e.tag === 'CW-311'));
const declassFix = run(qa, () => MES.updateCalibration(state, clickRec.id, { torque: 'no', note: 'relabel' }));
const declassNew = run(qa, () => MES.recordCalibration(state, { tag: 'CW-310', description: 'CLICK WRENCH', torque: 'no', serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }));
check('a torque tool cannot be declassified by a correction or a new record', !declassFix.ok && !declassNew.ok && /torque/i.test(declassFix.message) && MES.isTorqueTool(MES.toolCheck('CW-310', now, state).tool));
const keepFix = run(qa, () => MES.updateCalibration(state, clickRec.id, { note: 'Lab cert 88' }));
const keepNew = run(qa, () => MES.recordCalibration(state, { tag: 'CW-310', description: 'CLICK WRENCH', serial: '', calibratedAt: '2026-09-29', expires: '2027-09-29', status: 'In Calibration', location: '', note: 'Annual' }));
check('corrections and later records keep the torque classification without restating it', keepFix.ok && keepNew.ok && state.calibrationLog.filter(e => e.tag === 'CW-310').every(e => e.torque === true));
const promote = run(qa, () => MES.updateCalibration(state, MES.calibrationStatus(state, 'NT-TOOL').id, { torque: 'yes', note: 'It is a torque wrench' }));
check('a correction can classify a tool as a torque tool', promote.ok && MES.isTorqueTool(MES.toolCheck('NT-TOOL', now, state).tool));
const declassImport = structuredClone(state), cwCurrent = MES.calibrationStatus(declassImport, 'CW-310');
appendImported(declassImport, host.withAccount(qa, () => { const e = { ...cwCurrent, id: 'CALLOG-09993', torque: false, supersedes: cwCurrent.id, note: 'relabel', recordedAt: new Date().toISOString() }; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(declassImport, 'Calibration entry corrected', calSubject(e), e.recordedAt) }; return e; }, declassImport));
check('a workspace that declassifies a torque tool fails validation and diagnose names the entry', !MES.validate(declassImport) && MES.diagnose(declassImport)?.where === 'CALLOG-09993' && /torque/.test(MES.diagnose(declassImport)?.detail || ''));
const badFlag = structuredClone(state);
badFlag.calibrationLog[badFlag.calibrationLog.length - 1].torque = 'yes';
check('a torque flag that is not true or false invalidates the entry', !MES.validate(badFlag));

// #107: a tool used only as an ATP test asset is found by a traceability search for its tag.
const atpTrace = structuredClone(state), atpOrder = { id: 'WO-ATP-TRACE', status: 'Complete', partNumber: 'P-100', revision: 'A', materials: [], tickets: [], operations: [{ id: 'op-atp', title: 'Acceptance test', buyoff: { tools: [], testAssets: [{ asset: 'CW-310', calibrationEntry: MES.calibrationStatus(state, 'CW-310').id }] } }] };
atpTrace.orders = [...(atpTrace.orders || []), atpOrder];
const atpHits = MES.traceSearch(atpTrace, 'cw-310');
check('traceability finds a tool used only as an ATP test asset', atpHits.kind === 'tool' && JSON.stringify(atpHits.orders).includes(atpOrder.id));
check('an unused tag still finds no orders', MES.traceSearch(atpTrace, 'CW-310-X').orders.length === 0);

// #108: the signed meaning is bound to the entry kind: "Calibration recorded" for an original entry and
// "Calibration entry corrected" for a correction. Swapping them is detected.
const relabel = structuredClone(state), original = relabel.calibrationLog.find(e => !e.supersedes), correction = relabel.calibrationLog.find(e => e.supersedes);
original.calibrationSignature.manifest.meaning = 'Calibration entry corrected';
check('an original calibration entry relabeled as a correction fails validation', !MES.validate(relabel) && /CALLOG-/.test(MES.diagnose(relabel)?.where || ''));
const relabel2 = structuredClone(state);
relabel2.calibrationLog.find(e => e.id === correction.id).calibrationSignature.manifest.meaning = 'Calibration recorded';
check('a calibration correction relabeled as an original entry fails validation', !MES.validate(relabel2));

// #41: one rule decides which entries are current. The log view reads it from the engine instead of rebuilding it.
const currentIds = MES.calibrationCurrentIds(state);
check('calibrationCurrentIds holds exactly the current entry for every logged tag', [...new Set(state.calibrationLog.map(e => e.tag))].every(tag => currentIds.has(MES.calibrationStatus(state, tag).id)) && currentIds.size === new Set(state.calibrationLog.map(e => e.tag)).size);
check('calibrationCurrentIds is read-only and not remotely callable', host.resolveAction('MES.calibrationCurrentIds') === null);
check('the log views take the current entries from the engine, not an inline supersede rule', /MES\.calibrationCurrentIds\(state\)/.test(pageSource) && !/calSuperseded/.test(pageSource) && /MES\.calibrationCurrentIds\(state\)/.test(readFileSync(new URL('../src/react/flight-ui.jsx', import.meta.url), 'utf8')));

// #35 review (Codex 4134256601): the torque answer is required on load too, not only in recordCalibration, so an
// imported log-only entry without it cannot be read as a non-torque tool. Seeded tags may omit it.
const noFlag = structuredClone(state), cwRow = MES.calibrationStatus(noFlag, 'NT-TOOL');
appendImported(noFlag, host.withAccount(qa, () => { const e = { ...cwRow, id: 'CALLOG-09994', tag: 'CW-IMPORT', description: 'CLICK WRENCH', note: '', recordedAt: new Date().toISOString() }; delete e.supersedes; delete e.torque; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(noFlag, 'Calibration recorded', calSubject(e), e.recordedAt) }; return e; }, noFlag));
check('an imported log-only entry without a torque answer fails validation and diagnose names it', !MES.validate(noFlag) && MES.diagnose(noFlag)?.where === 'CALLOG-09994' && /torque/.test(MES.diagnose(noFlag)?.detail || ''));
check('seeded tags recorded without a torque answer still validate', state.calibrationLog.some(e => MES.CAL_TOOLS.some(t => t.tag === e.tag) && e.torque === undefined) && MES.validate(state));

// #35 review (Codex 4134256621): every calibration entry a buy-off cites must resolve to a log row for the same
// tool, so calibration evidence cannot drop out of the log while the acceptance records that cite it stay valid.
const refFixture = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const refState = MES.upgrade(JSON.parse(refFixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]));
const refOrder = refState.orders.find(o => o.operations.some(op => op.buyoff && Array.isArray(op.buyoff.tools) && op.buyoff.tools.length));
const refOp = refOrder.operations.find(op => op.buyoff && Array.isArray(op.buyoff.tools) && op.buyoff.tools.length), refTag = refOp.buyoff.tools[0].tag;
const refEntry = host.withAccount(qa, () => MES.recordCalibration(refState, { tag: refTag, description: refOp.buyoff.tools[0].description, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: '' }), refState);
refOp.buyoff.tools[0] = { ...refOp.buyoff.tools[0], source: 'Calibration log', calibrationEntry: refEntry.id };
// The buy-off happened after the entry it cites was recorded, as in a real flow (the fixture buy-off predates it).
refOp.buyoff.at = new Date(Date.parse(refState.calibrationLog.find(e => e.id === refEntry.id).recordedAt) + 60000).toISOString();
check('a buy-off that cites an existing calibration entry for its tool validates', refEntry.ok && MES.validate(refState));
const dangling = structuredClone(refState);
dangling.calibrationLog = dangling.calibrationLog.filter(e => e.id !== refEntry.id);
relinkHead(dangling); // the removed entry was the only one; a head that still named it would fail first on the chain
delete dangling.calibrationLogStart; // likewise the start marker (#162), which would otherwise name the removed entry first
check('a buy-off that cites a calibration entry missing from the log fails validation', !MES.validate(dangling));
check('diagnose names the work order whose buy-off cites the missing entry', MES.diagnose(dangling)?.where === refOrder.id && new RegExp(refEntry.id).test(MES.diagnose(dangling)?.detail || ''));
const wrongTool = structuredClone(refState);
wrongTool.orders.find(o => o.id === refOrder.id).operations.find(op => op.id === refOp.id).buyoff.tools[0].tag = 'OTHER-TAG';
check('a buy-off citing a calibration entry recorded for another tool fails validation', !MES.validate(wrongTool));
const danglingAtp = structuredClone(refState), atpOpRef = danglingAtp.orders.find(o => o.id === refOrder.id).operations.find(op => op.id === refOp.id);
atpOpRef.buyoff.tools[0] = { ...atpOpRef.buyoff.tools[0] }; delete atpOpRef.buyoff.tools[0].calibrationEntry;
atpOpRef.buyoff.testAssets = [{ asset: refTag, calibrationEntry: 'CALLOG-09995' }];
check('an ATP test asset citing a missing calibration entry fails validation', !MES.validate(danglingAtp));

// #35 review (Codex 4134619499): the write-path rule that a calibration is dated on or before the Pacific day it
// is recorded also holds on load, so an imported or hand-signed entry cannot postdate its own calibration.
const postdated = structuredClone(state), pdSource = MES.calibrationStatus(postdated, 'NT-TOOL');
appendImported(postdated, host.withAccount(qa, () => { const e = { ...pdSource, id: 'CALLOG-09996', tag: 'PD-TOOL', torque: false, calibratedAt: '2026-10-01', expires: '2027-10-01', note: '', recordedAt: '2026-09-29T19:00:00.000Z' }; delete e.supersedes; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(postdated, 'Calibration recorded', calSubject(e), e.recordedAt) }; return e; }, postdated));
check('a calibration dated after the day it was recorded fails validation and diagnose names it', !MES.validate(postdated) && MES.diagnose(postdated)?.where === 'CALLOG-09996');
const sameDay = structuredClone(state);
appendImported(sameDay, host.withAccount(qa, () => { const e = { ...pdSource, id: 'CALLOG-09997', tag: 'SD-TOOL', torque: false, calibratedAt: '2026-09-29', expires: '2027-09-29', note: '', recordedAt: '2026-09-29T19:00:00.000Z' }; delete e.supersedes; delete e.calibrationSignature; e.calibrationSignature = { manifest: MES.signManifest(sameDay, 'Calibration recorded', calSubject(e), e.recordedAt) }; return e; }, sameDay));
check('a calibration dated the Pacific day it was recorded validates', MES.validate(sameDay));

// #35 review (Codex 4135389174, Jinx option B): a buy-off may cite only calibration evidence that existed when it
// was signed. The cited entry must be recorded at or before the buy-off time and calibrated on or before its Pacific day.
const citedRow = refState.calibrationLog.find(e => e.id === refEntry.id);
check('a buy-off signed after the calibration entry it cites validates', MES.validate(refState) && Date.parse(refOp.buyoff.at) > Date.parse(citedRow.recordedAt));
const retro = structuredClone(refState), retroOp = retro.orders.find(o => o.id === refOrder.id).operations.find(op => op.id === refOp.id);
retroOp.buyoff.at = new Date(Date.parse(citedRow.recordedAt) - 60000).toISOString();
check('a buy-off citing a calibration entry recorded after the buy-off fails validation', !MES.validate(retro));
check('diagnose names the work order whose buy-off cites evidence recorded after it', MES.diagnose(retro)?.where === refOrder.id && /after/.test(MES.diagnose(retro)?.detail || ''));
const retroDay = structuredClone(refState), retroDayOp = retroDay.orders.find(o => o.id === refOrder.id).operations.find(op => op.id === refOp.id);
retroDayOp.buyoff.at = '2026-09-27T19:00:00.000Z';
check('a buy-off dated the day before the cited calibration fails validation', citedRow.calibratedAt === '2026-09-28' && !MES.validate(retroDay) && MES.diagnose(retroDay)?.where === refOrder.id);
const retroAtp = structuredClone(refState), retroAtpOp = retroAtp.orders.find(o => o.id === refOrder.id).operations.find(op => op.id === refOp.id);
retroAtpOp.buyoff.tools[0] = { ...retroAtpOp.buyoff.tools[0] }; delete retroAtpOp.buyoff.tools[0].calibrationEntry;
retroAtpOp.buyoff.testAssets = [{ asset: refTag, calibrationEntry: refEntry.id }];
retroAtpOp.buyoff.at = new Date(Date.parse(citedRow.recordedAt) - 60000).toISOString();
check('an ATP test asset citing calibration evidence recorded after the buy-off fails validation', !MES.validate(retroAtp));

// #35 review (Codex 4137333755, Jinx ruling A): the server gate verifies every signature on every write, so a split
// that carries completed operations (and their signed buy-offs) onto a new order must still verify end to end.
const splitFixture = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const splitState = MES.upgrade(JSON.parse(splitFixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]));
const splitAdmin = { username: 'admin', displayName: 'Flight Master', role: 'admin' };
const splitParent = splitState.orders.find(o => o.operations.some(op => op.buyoff && op.buyoff.manifest && Array.isArray(op.buyoff.evidenceIds) && op.buyoff.evidenceIds.length)) || splitState.orders.find(o => o.operations.some(op => op.buyoff && op.buyoff.manifest));
Object.assign(splitParent, { status: 'Building', quantity: 3 });
delete splitParent.closure; delete splitParent.closureRequest;
splitParent.splitRequests = [{ id: 'SPR-TEST-1', ticketId: null, quantity: 1, of: 3, serials: [], reason: 'Split one unit out after early buy-offs', status: 'Open', requestedBy: { name: 'Flight Master', role: 'Master Access', credentialId: 'MA-1' }, requestedAt: new Date().toISOString() }];
check('the split fixture verifies before the split', MES.verifyManifests(splitState).ok);
const splitResult = host.withAccount(splitAdmin, () => MES.splitRequestOrder(splitState, splitParent.id, 'SPR-TEST-1'), splitState);
const splitChild = splitState.orders.find(o => o.id === splitResult.id);
check('the split carries a signed buy-off onto the new order', splitResult.ok && !!splitChild && splitChild.operations.some(op => op.buyoff && op.buyoff.manifest));
const splitVerify = MES.verifyManifests(splitState);
check('carried buy-offs still verify against their original signed subject after a split', splitVerify.ok, JSON.stringify(splitVerify.failures && splitVerify.failures[0]));
check('the server write gate accepts the split workspace', srv.validState(structuredClone(splitState)) === null);
const carried = splitChild.operations.find(op => op.buyoff && op.buyoff.manifest).buyoff;
check('a carried buy-off records the order and evidence ids it was signed under', carried.carriedFrom && carried.carriedFrom.orderId === splitParent.id && Array.isArray(carried.carriedFrom.evidenceIds));
const forged = structuredClone(splitState), forgedOp = forged.orders.find(o => o.id === splitChild.id).operations.find(op => op.buyoff && op.buyoff.manifest);
forgedOp.buyoff.tools = [...(forgedOp.buyoff.tools || []), { tag: 'FORGED-TOOL' }];
check('a carried buy-off edited after the split still fails verification', !MES.verifyManifests(forged).ok);
const stray = structuredClone(splitState), strayOp = stray.orders.find(o => o.id === splitParent.id).operations.find(op => op.buyoff && op.buyoff.manifest);
strayOp.buyoff.carriedFrom = { orderId: splitParent.id, evidenceIds: strayOp.buyoff.evidenceIds };
strayOp.buyoff.evidenceIds = ['EV-00000000-0000-0000-0000-000000000000'];
check('carriedFrom cannot excuse an edited buy-off on an order that was not split', !MES.verifyManifests(stray).ok);

// The split can also move the NC that caused it onto the new order; a resolved ticket's signed approval must verify too.
const tkState = MES.upgrade(JSON.parse(splitFixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]));
const tkOrderId = splitParent.id;
// Setup, signature and split run in one withAccount call, against the live workspace it acts on.
const tkRun = host.withAccount(splitAdmin, () => {
  const parent = tkState.orders.find(o => o.id === tkOrderId);
  Object.assign(parent, { status: 'Building', quantity: 3 }); delete parent.closure; delete parent.closureRequest;
  const template = tkState.orders.flatMap(o => o.tickets || [])[0];
  const createdAt = new Date(Date.now() - 3600000).toISOString();
  const tk = { ...structuredClone(template), id: 'NC-9901', operationId: parent.operations[0].id, status: 'Resolved', createdAt, resolution: 'Reworked and reinspected', resolvedAt: new Date().toISOString() };
  // An ordinary disposition approval: a Rework or Repair NC closes only through its plan and a signed QA release (#581),
  // so the cloned ticket is dispositioned Return to supplier and carries no plan.
  delete tk.reworkPlan; tk.dispo = { ...tk.dispo, decision: 'Return to supplier' };
  tk.manifest = MES.signManifest(tkState, 'NC disposition approval', { orderId: tkOrderId, ticketId: tk.id, operationId: tk.operationId, dispo: tk.dispo, resolution: tk.resolution, defect: tk.defect || null, affected: tk.affected || null }, tk.resolvedAt);
  parent.tickets = [...(parent.tickets || []), tk];
  parent.splitRequests = [{ id: 'SPR-TEST-2', ticketId: tk.id, quantity: 1, of: 3, serials: [], reason: 'Split the affected unit', status: 'Open', requestedBy: { name: 'Flight Master', role: 'Master Access', credentialId: 'MA-1' }, requestedAt: new Date().toISOString() }];
  const before = MES.validate(tkState) && MES.verifyManifests(tkState).ok;
  const split = MES.splitRequestOrder(tkState, tkOrderId, 'SPR-TEST-2');
  const child = tkState.orders.find(o => o.id === split.id), after = tkState.orders.find(o => o.id === tkOrderId);
  const moved = child && child.tickets.find(t => t.id === tk.id);
  return { before, split, moved: !!moved && !after.tickets.some(t => t.id === tk.id), carriedFrom: moved && moved.carriedFrom, verify: MES.verifyManifests(tkState) };
}, tkState);
check('the signed ticket verifies on its original order before the split', tkRun.before);
check('the split moves the signed ticket onto the new order', tkRun.split.ok && tkRun.moved, JSON.stringify(tkRun.split));
check('a moved ticket still verifies against the order it was signed on', tkRun.verify.ok && tkRun.carriedFrom?.orderId === tkOrderId, JSON.stringify(tkRun.verify.failures?.[0]));

// #111: a traceability search matches buy-off tools by exact tag, like test assets and torque steps, so the search for
// one tool does not report operations that used only a longer tag that starts with it.
const prefixTrace = structuredClone(traceState);
prefixTrace.orders = [...prefixTrace.orders, { id: 'WO-PREFIX-1', status: 'In Work', partNumber: 'PN-TRACE', revision: 'A', pedigree: 'Production', subcategory: 'Mfg.', materials: [], tickets: [], history: [], operations: [{ id: 'OP-9', title: 'Measure', buyoff: { at: '2026-09-30T18:00:00.000Z', name: 'Sam Tech', tools: [{ tag: 'B2-TOOLX', description: 'MICROMETER' }, 'B2-TOOL-2'] } }] }];
const prefixHits = MES.traceSearch(prefixTrace, 'B2-TOOL');
check('a tool search does not report an operation that used only a longer tag starting with it', prefixHits.kind === 'tool' && !prefixHits.orders.some(o => o.id === 'WO-PREFIX-1'));
check('a tool search still reports the operation that used the exact tag', prefixHits.orders.some(o => o.id === 'WO-TRACE-1'));
const exactString = structuredClone(prefixTrace);
exactString.orders[1].operations[0].buyoff.tools = ['b2-tool'];
check('a buy-off tool stored as a plain string still matches its exact tag, in any case', MES.traceSearch(exactString, 'B2-TOOL').orders.some(o => o.id === 'WO-PREFIX-1'));

// #112: the manifest signer of a calibration entry must hold calibration authority, the role gate the mutators apply.
// A hand-made entry signed as a technician fails validation, the manifest verifier and the server gate.
const signerBase = structuredClone(state);
const signerRow = signerBase.calibrationLog[signerBase.calibrationLog.length - 1];
check('a calibration entry recorded by a QA Manager is signed with the Quality Manager role', signerRow.calibrationSignature.manifest.signer.role === 'Quality Manager' && MES.validate(signerBase));
const forgedRole = structuredClone(signerBase);
forgedRole.calibrationLog[forgedRole.calibrationLog.length - 1].calibrationSignature.manifest.signer.role = 'Assembly technician';
relinkHead(forgedRole);
check('a calibration entry signed by a technician fails entry validation', !MES.validate(forgedRole));
check('a calibration entry signed by a technician fails manifest verification', !MES.verifyManifests(forgedRole).ok && MES.verifyManifests(forgedRole).failures.some(f => /calibration authority/.test(f.reason)));
check('the server gate rejects a calibration entry signed by a technician', typeof srv.validState(forgedRole) === 'string');
check('diagnose names the signature of the technician-signed entry', /signature/.test(JSON.stringify(MES.diagnose(forgedRole))));
// The allowed signer roles are exactly the account roles that hold configure-qms, so the list cannot drift from ROLE_CAPS.
// Re-signs a workspace's last calibration entry as the same named person holding another role: signerRole and the
// manifest are rebuilt together, so only the role differs from an entry the mutators would write.
const resignLastAs = (ws, role) => {
  const row = ws.calibrationLog[ws.calibrationLog.length - 1], [name, credentialId] = row.recordedBy.split(' \u00b7 ');
  const saved = ws.profile; ws.profile = { name, role, credentialId };
  row.signerRole = role;
  row.calibrationSignature = { manifest: MES.signManifest(ws, row.calibrationSignature.manifest.meaning, calSubject(row), row.recordedAt) };
  ws.profile = saved;
  relinkHead(ws);
  return ws;
};
const roleVerdicts = host.roles.ROLES.map(r => {
  const probe = resignLastAs(structuredClone(signerBase), r.profileRole);
  return { key: r.key, allowed: (host.roles.ROLE_CAPS[r.key] || host.roles.EVERYONE).includes('configure-qms'), valid: MES.validate(probe) };
});
check('every role with configure-qms signs a valid calibration entry and every other role does not', roleVerdicts.length > 5 && roleVerdicts.every(v => v.allowed === v.valid) && roleVerdicts.filter(v => v.valid).map(v => v.key).sort().join() === 'admin,qm');
// Codex review on #129: the signer role is inside the signed subject (entry.signerRole), so changing only the manifest's
// signer role, or only the entry's signerRole, no longer turns a technician entry into a valid one.
const techSigned = resignLastAs(structuredClone(signerBase), 'Assembly technician');
check('a fully signed technician entry fails validation', !MES.validate(techSigned) && !MES.verifyManifests(techSigned).ok);
const roleOnlyEdit = structuredClone(techSigned);
roleOnlyEdit.calibrationLog[roleOnlyEdit.calibrationLog.length - 1].calibrationSignature.manifest.signer.role = 'Quality Manager';
relinkHead(roleOnlyEdit);
check('changing only the manifest signer role of a technician entry does not make it valid', !MES.validate(roleOnlyEdit) && !MES.verifyManifests(roleOnlyEdit).ok && typeof srv.validState(roleOnlyEdit) === 'string');
const bothEdited = structuredClone(roleOnlyEdit);
bothEdited.calibrationLog[bothEdited.calibrationLog.length - 1].signerRole = 'Quality Manager';
relinkHead(bothEdited);
check('changing the signed signerRole without re-signing breaks the manifest hash', !MES.validate(bothEdited) && !MES.verifyManifests(bothEdited).ok);
check('entries written by this build carry the signer role in the signed subject', signerBase.calibrationLog.every(e => e.signerRole === e.calibrationSignature.manifest.signer.role && e.calibrationSignature.manifest.subject.signerRole === e.signerRole));
// Entries from builds before the signer-role gate have no signerRole, and their manifest role is not hashed, so they
// are grandfathered as recorded rather than role-verified (Codex review on #129). Saved workspaces from those builds
// load at any date; the role binding applies to every entry this build writes.
const resignLegacy = (ws, role, credentialId, recordedAt) => {
  const row = ws.calibrationLog[ws.calibrationLog.length - 1], [name] = row.recordedBy.split(' · ');
  const cred = credentialId || row.recordedBy.split(' · ')[1];
  const saved = ws.profile; ws.profile = { name, role, credentialId: cred };
  delete row.signerRole; row.recordedBy = `${name} · ${cred}`; if (recordedAt) row.recordedAt = recordedAt;
  row.calibrationSignature = { manifest: MES.signManifest(ws, row.calibrationSignature.manifest.meaning, calSubject(row), row.recordedAt) };
  ws.profile = saved;
  relinkHead(ws);
  return ws;
};
const legacyQe = resignLegacy(structuredClone(signerBase), 'Quality Engineer', 'SR-QE-001', '2026-09-30T12:00:00.000Z');
check('a legacy calibration entry signed by a standalone Quality Engineer profile validates and verifies', MES.validate(legacyQe) && MES.verifyManifests(legacyQe).ok && srv.validState(structuredClone(legacyQe)) === null);
check('a saved workspace holding the legacy standalone entry still upgrades and loads', !!MES.upgrade(structuredClone(legacyQe)));
const legacyLateQe = resignLegacy(structuredClone(signerBase), 'Quality Engineer', 'SR-QE-001', '2027-03-01T12:00:00.000Z');
check('a legacy standalone entry is not expired by any date', MES.validate(legacyLateQe) && MES.verifyManifests(legacyLateQe).ok);
const legacyAcct = resignLegacy(structuredClone(signerBase), 'Quality Engineer');
check('a legacy account-signed entry is grandfathered as recorded', /ACCT-/.test(legacyAcct.calibrationLog.at(-1).recordedBy) && MES.validate(legacyAcct) && MES.verifyManifests(legacyAcct).ok);
const legacyStrip = structuredClone(signerBase); delete legacyStrip.calibrationLog.at(-1).signerRole; relinkHead(legacyStrip);
check('removing signerRole from an entry this build wrote breaks its manifest hash', !MES.validate(legacyStrip) && !MES.verifyManifests(legacyStrip).ok);
// Standalone use (no account): the profile signs, so a profile without calibration authority cannot record or correct.
const standalone = structuredClone(state);
standalone.profile = { name: 'Riley Quality', role: 'Quality Engineer', credentialId: 'SR-QE-001' };
const standaloneLen = standalone.calibrationLog.length;
const standaloneRecord = MES.recordCalibration(standalone, { ...entry, tag: 'SOLO-001' });
const standaloneFix = MES.updateCalibration(standalone, MES.calibrationStatus(standalone, 'TEST-001').id, { note: 'Lab cert 44' });
check('a standalone profile without calibration authority cannot record or correct a calibration', !standaloneRecord.ok && /Quality Manager or System Administrator/.test(standaloneRecord.message) && !standaloneFix.ok && standalone.calibrationLog.length === standaloneLen);
standalone.profile = { name: 'Morgan Lee', role: 'Quality Manager', credentialId: 'SR-QM-001' };
const standaloneQm = MES.recordCalibration(standalone, { ...entry, tag: 'SOLO-002' });
check('a standalone Quality Manager profile records a calibration that validates', standaloneQm.ok && MES.validate(standalone) && MES.verifyManifests(standalone).ok);

// #113, #130: the log limits say what happened and what to do next. A full log makes room when a QA Manager archives
// superseded entries on the shared server; archiving does not free entry numbers, so the last number names the administrator.
check('the full-log refusal says a QA Manager archives superseded entries to make room', !/Archive older/.test(fullCorrect.message) && /was not recorded/.test(fullCorrect.message) && /archive superseded entries/.test(fullCorrect.message) && /shared Flight System server/.test(fullCorrect.message) && !/\u2014/.test(fullCorrect.message));
check('the last-entry-number refusal says archiving does not free numbers and names the administrator', !/Archive the log/.test(exhausted.message) && /was not recorded/.test(exhausted.message) && /does not free entry numbers/.test(exhausted.message) && /administrator/.test(exhausted.message));
check('the page carries no calibration archive instruction', !/Archive older entries|Archive the log before/.test(pageSource));

// #120: a tool that was never calibrated can be retired with blank calibration and due dates. Every status that
// claims a calibration still needs both dates.
const undated = structuredClone(state);
const undatedFields = { tag: 'SR0077', description: 'LOAD CELL', serial: '902115', calibratedAt: '', expires: '', location: 'Production Floor', note: 'Never calibrated; scrapped' };
const undatedLen = undated.calibrationLog.length;
for (const status of ['In Calibration', 'Out for Calibration', 'Quarantined']) {
  const refused = host.withAccount(qa, () => MES.recordCalibration(undated, { ...undatedFields, status }), undated);
  check(`blank calibration dates on a ${status} entry are refused`, !refused.ok && /calibration date/.test(refused.message) && undated.calibrationLog.length === undatedLen);
}
const halfDated = host.withAccount(qa, () => MES.recordCalibration(undated, { ...undatedFields, calibratedAt: '2026-09-01', status: 'Retired' }), undated);
check('a Retired entry with only one of the two dates is refused', !halfDated.ok && /due date/.test(halfDated.message) && undated.calibrationLog.length === undatedLen);
const halfDated2 = host.withAccount(qa, () => MES.recordCalibration(undated, { ...undatedFields, expires: '2027-09-01', status: 'Retired' }), undated);
check('a Retired entry with only a due date is refused', !halfDated2.ok && /blank/.test(halfDated2.message) && undated.calibrationLog.length === undatedLen);
const retiredUndated = host.withAccount(qa, () => MES.recordCalibration(undated, { ...undatedFields, status: 'Retired' }), undated);
const undatedRetiredRow = undated.calibrationLog.find(e => e.id === retiredUndated.id);
check('the confirmation for an undated retirement names no due date', retiredUndated.ok && /recorded as Retired with no calibration dates/.test(retiredUndated.message) && !/due/.test(retiredUndated.message));
check('a never-calibrated tool is retired with blank calibration and due dates', retiredUndated.ok && undatedRetiredRow.calibratedAt === '' && undatedRetiredRow.expires === '' && undatedRetiredRow.status === 'Retired');
check('the undated Retired entry validates and its manifest verifies', MES.validate(undated) && MES.verifyManifests(undated).ok && srv.validState(structuredClone(undated)) === null);
check('the undated retired tool is unusable at point of use', !MES.toolCheck('SR0077', now, undated).ok && /Retired/.test(MES.toolCheck('SR0077', now, undated).message));
const reinstateUndated = host.withAccount(qa, () => MES.updateCalibration(undated, retiredUndated.id, { status: 'In Calibration', note: 'Retired by mistake: the scrapped cell was SR0079' }), undated);
check('returning an undated retired tool to service without calibration dates is refused', !reinstateUndated.ok && /calibration date/.test(reinstateUndated.message) && MES.calibrationStatus(undated, 'SR0077').id === retiredUndated.id);
const datedRetire = host.withAccount(qa, () => MES.updateCalibration(undated, MES.calibrationStatus(undated, 'TEST-001').id, { status: 'Retired', calibratedAt: '', expires: '', note: 'Entered in error; never calibrated' }), undated);
// Codex review on #129: only a tool that was never calibrated may be retired without dates. A tool with dates in the
// log or in the shipped snapshot keeps them on its Retired entry, at write time and when the workspace loads.
check('a correction to Retired cannot clear the dates of a tool with calibration dates in the log', !datedRetire.ok && /calibration dates on record/.test(datedRetire.message) && MES.calibrationStatus(undated, 'TEST-001').expires !== '');
const seedDatedRetire = host.withAccount(qa, () => MES.recordCalibration(undated, { tag: 'NONE-175', description: 'TORQUE WRENCH', serial: '', calibratedAt: '', expires: '', status: 'Retired', location: '', note: 'Scrapped' }), undated);
check('a tool with a due date in the shipped snapshot cannot be retired without dates', !seedDatedRetire.ok && /shipped tool snapshot/.test(seedDatedRetire.message));
const datedRetireOk = host.withAccount(qa, () => MES.updateCalibration(undated, MES.calibrationStatus(undated, 'TEST-001').id, { status: 'Retired', note: 'Worn out; retired with its last calibration dates' }), undated);
check('a tool with calibration history is retired with its dates', datedRetireOk.ok && MES.calibrationStatus(undated, 'TEST-001').status === 'Retired' && MES.calibrationStatus(undated, 'TEST-001').expires !== '' && MES.validate(undated));
const forgedStrip = structuredClone(undated);
const stripRow = { ...structuredClone(forgedStrip.calibrationLog.find(e => e.id === retiredUndated.id)), id: 'CALLOG-09000', tag: 'CAL-022', description: 'DIGITAL CALIPER', recordedAt: new Date().toISOString() };
host.withAccount(qa, () => { stripRow.calibrationSignature = { manifest: MES.signManifest(forgedStrip, 'Calibration recorded', calSubject(stripRow), stripRow.recordedAt) }; }, forgedStrip);
appendImported(forgedStrip, stripRow);
check('a signed undated retirement of a tool with calibration dates on record fails validation', !MES.validate(forgedStrip) && /calibration dates on record/.test(JSON.stringify(MES.diagnose(forgedStrip))));
// Codex review on #129: load validation reads only the signed log, not the shipped snapshot, so a later build that ships
// new snapshot dates cannot invalidate a retirement that was valid when it was signed. The write path still reads it.
const snapshotOnly = structuredClone(undated);
const snapRow = { ...structuredClone(snapshotOnly.calibrationLog.find(e => e.id === retiredUndated.id)), id: 'CALLOG-09001', tag: 'NONE-175', description: 'TORQUE WRENCH', recordedAt: new Date().toISOString() };
host.withAccount(qa, () => { snapRow.calibrationSignature = { manifest: MES.signManifest(snapshotOnly, 'Calibration recorded', calSubject(snapRow), snapRow.recordedAt) }; }, snapshotOnly);
appendImported(snapshotOnly, snapRow);
check('an undated retirement whose only dated record is the shipped snapshot still loads', MES.validate(snapshotOnly) && MES.verifyManifests(snapshotOnly).ok);
const clearedInService = host.withAccount(qa, () => MES.updateCalibration(undated, MES.calibrationStatus(undated, 'CAL-022').id, { calibratedAt: '', expires: '' }), undated);
check('a correction that clears the dates of an entry that is not Retired is refused', !clearedInService.ok && /calibration date/.test(clearedInService.message));
// A hand-made undated entry with any status but Retired fails validation, even with a valid signature.
const forgedUndated = structuredClone(undated);
const undatedRow = forgedUndated.calibrationLog.find(e => e.id === retiredUndated.id);
undatedRow.status = 'In Calibration';
host.withAccount(qa, () => { undatedRow.calibrationSignature = { manifest: MES.signManifest(forgedUndated, 'Calibration recorded', calSubject(undatedRow), undatedRow.recordedAt) }; }, forgedUndated);
forgedUndated.calibrationLog.forEach((e, i, log) => { if (i) e.previousHash = MES.calibrationEntryHash(log[i - 1]); }); relinkHead(forgedUndated);
check('a signed In Calibration entry with blank dates fails validation', !MES.validate(forgedUndated) && /calibratedAt/.test(JSON.stringify(MES.diagnose(forgedUndated))));
check('the calibration record forms leave the dates optional and say when they may be blank', /leaves them blank/.test(pageSource) && !/name="calibratedAt" type="date" required/.test(pageSource));

// Codex review on #129: the demo build gives every account that is not a pilot seat full capabilities (D-6), so the
// signer-role rule is relaxed there too (D-36); production keeps only the Quality Manager and System Administrator roles.
const demoHost = createHost(fileURLToPath(new URL('./fixtures/demo_publish.html', import.meta.url)));
const demoCal = demoHost.MES.seed(), prodCal = MES.seed();
for (const ws of [demoCal, prodCal]) ws.profile = { name: 'Sky Safety', role: 'Safety Engineer', credentialId: 'SR-SF-001' };
const demoSafety = demoHost.MES.recordCalibration(demoCal, { ...entry, tag: 'DEMO-CAL-1' });
check('in the demo build a full-access signer role records a calibration that validates', demoSafety.ok && demoHost.MES.validate(demoCal) && demoHost.MES.verifyManifests(demoCal).ok);
check('the production build still refuses the same signer role', !MES.recordCalibration(prodCal, { ...entry, tag: 'DEMO-CAL-1' }).ok && !MES.validate({ ...structuredClone(prodCal), calibrationLog: structuredClone(demoCal.calibrationLog), calibrationLogHead: structuredClone(demoCal.calibrationLogHead) }));

console.log(`calibration: ${checks} checks, all passed`);
