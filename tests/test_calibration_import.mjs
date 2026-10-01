// Calibrated tools can be loaded in bulk from a CSV by a QA Manager or Master Access account. Each row becomes
// its own signed, hash-chained calibration log entry, exactly as if it were recorded by hand with
// recordCalibration, so the import changes no rule: the same role gate, field checks, torque answer, retired
// refusal and log limit apply. The import is all or nothing: one bad row records nothing and names the row.
// This suite checks the engine, the server action boundary, and the System QMS records screen.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
const tech = { username: 'tech-sam', displayName: 'Sam Tech', role: 'technician' };
const now = '2026-10-01T19:00:00.000Z';
let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const fresh = () => MES.seed();
const run = (state, account, fn) => host.withAccount(account, fn, state);
const HEADER = 'tag,description,torque,serial,calibratedAt,expires,status,location,note';
const GOOD = [
  HEADER,
  'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,In Calibration,Production Floor,Lab cert 101',
  'IMP-002,TORQUE WRENCH,Yes,SN-2,2026-09-28,2027-03-28,,Production Floor,Lab cert 102',
  '"IMP-003","DIGITAL MULTIMETER, BENCH",no,SN-3,2026-09-29,2027-09-29,In Calibration,"Lab, Bay 2",',
].join('\n');

check('importCalibrations resolves as a server action', typeof host.resolveAction('MES.importCalibrations') === 'function');

// ---- the role gate (refusal path) ----------------------------------------------------------------------
{
  const state = fresh(), before = JSON.stringify(state);
  const res = run(state, tech, () => MES.importCalibrations(state, GOOD));
  check('a technician cannot import calibrations, and nothing changes', !res.ok && /QA Manager or Master Access/.test(res.message) && JSON.stringify(state) === before, res.message);
}

// ---- a good import -------------------------------------------------------------------------------------------
{
  const state = fresh();
  const res = run(state, qa, () => MES.importCalibrations(state, GOOD));
  check('a QA Manager imports every row', res.ok && res.ids.length === 3 && state.calibrationLog.length === 3, res.message);
  check('the result names how many tools and the entry ids', /Imported 3 calibration entries: CALLOG-00001 to CALLOG-00003\./.test(res.message), res.message);
  check('each row is its own entry in file order', state.calibrationLog.map(e => e.tag).join() === 'IMP-001,IMP-002,IMP-003');
  check('quoted cells keep their commas', state.calibrationLog[2].description === 'DIGITAL MULTIMETER, BENCH' && state.calibrationLog[2].location === 'Lab, Bay 2');
  check('a blank status records In Calibration', state.calibrationLog[1].status === 'In Calibration');
  check('the torque answer is recorded per row', state.calibrationLog[0].torque === false && state.calibrationLog[1].torque === true && state.calibrationLog[2].torque === false);
  check('every entry is signed by the person importing, with their role', state.calibrationLog.every(e => /^Quinn Manager · /.test(e.recordedBy) && e.signerRole === 'Quality Manager' && e.calibrationSignature && e.calibrationSignature.manifest));
  check('the workspace validates and every manifest verifies', MES.validate(state) === true && MES.verifyManifests(state).ok === true);
  check('the hash chain covers every imported entry', state.calibrationLogHead && state.calibrationLogHead.count === 3);
  check('an imported tool passes the point-of-use check', MES.toolCheck('IMP-001', now, state).ok === true && MES.toolCheck('IMP-002', now, state).ok === true);
  const again = run(state, qa, () => MES.importCalibrations(state, [HEADER, 'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-30,2027-09-30,In Calibration,Production Floor,Recalibrated'].join('\n')));
  check('importing a tool already in the log appends a new entry; the earlier one stays', again.ok && state.calibrationLog.length === 4 && state.calibrationLog[0].calibratedAt === '2026-09-28' && MES.calibrationStatus(state, 'IMP-001').calibratedAt === '2026-09-30');
  check('the chain still validates after a second import', MES.validate(state) === true && MES.verifyManifests(state).ok === true && state.calibrationLogHead.count === 4);
}

// ---- all or nothing: every refusal leaves the workspace untouched --------------------------------------------
const refused = (name, text, pattern) => {
  const state = fresh(), before = JSON.stringify(state);
  const res = run(state, qa, () => MES.importCalibrations(state, text));
  check(name, !res.ok && pattern.test(res.message) && JSON.stringify(state) === before, res.message);
};
refused('one bad row imports nothing and names the row and tag', [HEADER, 'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,In Calibration,Floor,', 'IMP-002,DIGITAL CALIPER,No,SN-2,2027-09-28,2026-09-28,In Calibration,Floor,'].join('\n'), /^Nothing was imported\. Row 3 \(IMP-002\): /);
refused('a tool not in the shipped snapshot with no torque answer is refused', [HEADER, 'IMP-009,DIGITAL CALIPER,,SN-9,2026-09-28,2027-09-28,In Calibration,Floor,'].join('\n'), /Row 2 \(IMP-009\): Say whether IMP-009 is a torque tool/);
refused('the same tag twice in one file is refused', [HEADER, 'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,,Floor,', 'imp-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,,Floor,'].join('\n'), /Row 3 repeats tool IMP-001 from row 2/);
refused('a missing required column is refused and named', 'tag,description,torque,calibratedAt\nIMP-001,DIGITAL CALIPER,No,2026-09-28', /needs the columns expires/);
refused('a duplicate column name is refused', 'tag,description,torque,calibratedAt,expires,Tag\nIMP-001,DIGITAL CALIPER,No,2026-09-28,2027-09-28,IMP-001', /duplicate column names/);
refused('a row with the wrong number of cells is refused', [HEADER, 'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,,Floor,,extra'].join('\n'), /Row 2 has 10 cells but the header has 9 columns/);
refused('an unclosed quote is refused', [HEADER, '"IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,,Floor,'].join('\n'), /unclosed or misplaced quote/);
refused('a header with no rows is refused', HEADER, /header row and at least one tool/);
refused('more than 500 rows at a time is refused', [HEADER, ...Array.from({ length: 501 }, (_, i) => `IMP-${String(i).padStart(4, '0')},DIGITAL CALIPER,No,SN,2026-09-28,2027-09-28,,Floor,`)].join('\n'), /up to 500 tools at a time/);
{
  const state = fresh();
  run(state, qa, () => MES.recordCalibration(state, { tag: 'IMP-RET', description: 'DIGITAL CALIPER', torque: false, serial: '', calibratedAt: '', expires: '', status: 'Retired', location: '', note: 'Never calibrated' }));
  const before = JSON.stringify(state);
  const res = run(state, qa, () => MES.importCalibrations(state, [HEADER, 'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,,Floor,', 'IMP-RET,DIGITAL CALIPER,No,SN-2,2026-09-28,2027-09-28,,Floor,'].join('\n')));
  check('a retired tool in the file refuses the whole import', !res.ok && /Row 3 \(IMP-RET\): IMP-RET is retired/.test(res.message) && JSON.stringify(state) === before, res.message);
}

// ---- the System QMS records screen -----------------------------------------------------------------------------
const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'qa', displayName: 'Quinn Manager', salt: 'test', hash: 'unused', role: 'qm', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'qa');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'qms-records'; render(); });
  const form = page.locator('[data-qms-calibration-import]');
  check('the QMS records screen offers the calibration CSV import', await form.count() === 1);
  await form.locator('[name=csv]').fill([HEADER, 'IMP-001,DIGITAL CALIPER,No,SN-1,2026-09-28,2027-09-28,,Floor,', 'IMP-002,DIGITAL CALIPER,No,SN-2,2027-09-28,2026-09-28,,Floor,'].join('\n'));
  await form.locator('button[type=submit]').click();
  await page.getByText(/Nothing was imported\. Row 3 \(IMP-002\)/).first().waitFor();
  check('a bad file shows the refusal and records nothing', await page.evaluate(() => (state.calibrationLog || []).length) === 0);
  await page.locator('[data-qms-calibration-import] [name=csv]').fill(GOOD);
  await page.locator('[data-qms-calibration-import] button[type=submit]').click();
  await page.getByText(/CALLOG-00003 · IMP-003/).waitFor();
  check('a good file records every row and lists the entries', await page.evaluate(() => state.calibrationLog.length === 3 && MES.validate(state) === true && MES.verifyManifests(state).ok === true));
  check('the import text has no em dash', !(await page.locator('[data-qms-calibration-import]').innerText()).includes('—'));
  await context.close();
} finally {
  await browser.close();
}
check('the page opened without errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks} fail 0`);
