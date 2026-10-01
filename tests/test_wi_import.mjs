// Master WIs can be loaded in bulk from a CSV by an account that may write WIs (edit-wi). The file has one row per
// step: the wi column groups rows into one master WI and the operation column groups steps into one operation.
// Each WI is created through addMasterWI and saveWIOperations, so every rule a hand-built WI meets still applies,
// and every imported WI is a Draft: it still needs peer review and release by other people before it can issue a
// work order, and the importer is recorded as its author, so the importer cannot release it. The import is all or
// nothing: one bad WI imports nothing and names the WI and its rows.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const me = { username: 'me-ana', displayName: 'Ana Engineer', role: 'me' };
const tech = { username: 'tech-sam', displayName: 'Sam Tech', role: 'technician' };
let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const run = (state, account, fn) => host.withAccount(account, fn, state);
const part = MES.PART_CATALOG[0], rev = part.revisions[0];
const HEADER = 'wi,partNumber,partRevision,title,operation,operationTitle,operationSummary,buyoffType,classification,stepTitle,instruction,requiresTooling,recordsTorque';
const GOOD = [
  HEADER,
  `1,${part.partNumber},${rev},Bracket assembly,10,Prepare parts,Clean and lay out the parts,Technician,,Clean,"Wipe each part with IPA, then let it dry",No,No`,
  `1,${part.partNumber},${rev},Bracket assembly,10,Prepare parts,Clean and lay out the parts,Technician,,Lay out,Lay the parts out in kit order,No,No`,
  `1,${part.partNumber},${rev},Bracket assembly,20,Torque fasteners,Install and torque the fasteners,Technician,Manufacturing,Torque,Torque each bolt to the drawing value,Yes,Yes`,
  `1,${part.partNumber},${rev},Bracket assembly,30,Final inspection,Inspect the assembly,Quality,Inspection,Visual,Check for damage and missing hardware,No,No`,
  `B2,${part.partNumber},${rev},Bracket rework,10,Rework,Rework the bracket,Technician,,Rework,Follow the disposition,No,No`,
].join('\n');

check('importMasterWIs resolves as a server action', typeof host.resolveAction('MES.importMasterWIs') === 'function');

// ---- the role gate (refusal path) ----------------------------------------------------------------------------
{
  const state = MES.seed(), before = JSON.stringify(state);
  const res = run(state, tech, () => MES.importMasterWIs(state, GOOD));
  check('an account without edit-wi cannot import WIs, and nothing changes', !res.ok && JSON.stringify(state) === before, res.message);
}

// ---- a good import -------------------------------------------------------------------------------------------
{
  const state = MES.seed(), before = (state.masterWIs || []).length;
  const res = run(state, me, () => MES.importMasterWIs(state, GOOD));
  check('an account with edit-wi imports every WI', res.ok && res.ids.length === 2 && state.masterWIs.length === before + 2, res.message);
  const wis = res.ids.map(id => state.masterWIs.find(w => w.id === id));
  check('the result says they are drafts that still need peer review and release', /Imported 2 master WIs as drafts/.test(res.message) && /peer review and release by other people/.test(res.message), res.message);
  check('every imported WI is a Draft at Rev A with no peer review or QA review', wis.every(w => w.status === 'Draft' && w.revision === 'A' && !w.peerReview && !w.qaReview));
  check('the WI header comes from the file', wis[0].partNumber === part.partNumber && wis[0].partRevision === rev && wis[0].title === 'Bracket assembly' && wis[1].title === 'Bracket rework');
  check('operations are grouped and numbered in file order', wis[0].operations.map(o => `${o.id}:${o.title}`).join('|') === 'op-010:Prepare parts|op-020:Torque fasteners|op-030:Final inspection');
  check('steps are grouped under their operation in file order', wis[0].operations[0].steps.map(s => s.title).join('|') === 'Clean|Lay out' && wis[0].operations[0].steps[0].instruction === 'Wipe each part with IPA, then let it dry');
  check('Yes/No columns are read', wis[0].operations[1].requiresTooling === true && wis[0].operations[1].steps[0].recordsTorque === true && wis[0].operations[0].requiresTooling === false);
  check('an inspection operation keeps its buy-off and gets the standard inspection step, as when built by hand', wis[0].operations[2].buyoffType === 'Quality' && wis[0].operations[2].inspectionPoint === true && wis[0].operations[2].steps.length === 2);
  check('the importer is recorded as an author of each WI', wis.every(w => Array.isArray(w.authors) && w.authors.length === 1));
  check('the workspace validates', MES.validate(state) === true, (MES.diagnose(state) || {}).detail);
  const release = run(state, me, () => MES.releaseMasterWI(state, wis[0].id, 'A', {}));
  check('the importer cannot release an imported WI', !release.ok, release.message);
}

// ---- all or nothing: every refusal leaves the workspace untouched -------------------------------------------------
const refused = (name, text, pattern) => {
  const state = MES.seed(), before = JSON.stringify(state);
  const res = run(state, me, () => MES.importMasterWIs(state, text));
  check(name, !res.ok && pattern.test(res.message) && JSON.stringify(state) === before, res.message);
};
const row = (over = {}) => { const r = { wi: '1', partNumber: part.partNumber, partRevision: rev, title: 'Bracket assembly', operation: '10', operationTitle: 'Prepare', operationSummary: 'Prepare parts', buyoffType: 'Technician', classification: '', stepTitle: 'Clean', instruction: 'Clean the parts', requiresTooling: 'No', recordsTorque: 'No', ...over }; return HEADER.split(',').map(k => r[k]).join(','); };
refused('a bad WI imports nothing and names the WI and its rows', [HEADER, row(), row({ wi: '2', partNumber: 'NOT-A-PART' })].join('\n'), /^Nothing was imported\. WI 2 \(row 3\): Choose a part number\./);
refused('a rule a hand-built WI must meet is enforced', [HEADER, row({ classification: 'Inspection', buyoffType: 'Technician' })].join('\n'), /WI 1 \(row 2\): Operation 010: inspection operations need an authorized inspection buy-off\./);
refused('rows of one WI that disagree on the header are refused', [HEADER, row(), row({ title: 'Different title', stepTitle: 'Two' })].join('\n'), /Row 3: WI 1 has title Bracket assembly on row 2/);
refused('rows of one operation that disagree are refused', [HEADER, row(), row({ buyoffType: 'Quality', stepTitle: 'Two' })].join('\n'), /Row 3: operation 10 of WI 1 has buyoffType Technician on row 2/);
refused('a WI split across the file is refused', [HEADER, row(), row({ wi: '2' }), row({ stepTitle: 'Again' })].join('\n'), /Row 4: keep the rows of WI 1 together/);
refused('a missing required column is refused and named', 'wi,partNumber,partRevision,title\n1,X,A,T', /needs the columns operation, operationTitle, operationSummary, buyoffType, stepTitle, instruction/);
refused('an unknown column is refused', `${HEADER},approvedBy\n${row()},Someone`, /columns this import does not read: approvedBy/);
refused('a row with the wrong number of cells is refused', [HEADER, `${row()},extra`].join('\n'), /Row 2 has 14 cells but the header has 13 columns/);
refused('an unclosed quote is refused', [HEADER, `"${row()}`].join('\n'), /unclosed or misplaced quote/);
refused('a header with no rows is refused', HEADER, /header row and at least one step/);
refused('more than 500 rows at a time is refused', [HEADER, ...Array.from({ length: 501 }, (_, i) => row({ stepTitle: `S${i}` }))].join('\n'), /up to 500 rows at a time/);

// ---- the Master WI library screen ---------------------------------------------------------------------------------
const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'ana', displayName: 'Ana Engineer', salt: 'test', hash: 'unused', role: 'me', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'ana');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'wis'; render(); });
  const button = page.locator('[data-action="wi-import"]');
  check('the Master WI library offers the CSV import', await button.count() === 1);
  const before = await page.evaluate(() => (state.masterWIs || []).length);
  await button.click();
  await page.locator('#wi-import-form [name=csv]').fill([HEADER, row(), row({ wi: '2', partNumber: 'NOT-A-PART' })].join('\n'));
  await page.locator('#wi-import-form button[type=submit]').click();
  await page.locator('#wi-import-error', { hasText: 'Nothing was imported. WI 2 (row 3)' }).waitFor();
  check('a bad file shows the refusal and imports nothing', await page.evaluate(() => (state.masterWIs || []).length) === before);
  await page.locator('#wi-import-form [name=csv]').fill(GOOD);
  await page.locator('#wi-import-form button[type=submit]').click();
  await page.waitForFunction(n => (state.masterWIs || []).length === n + 2, before);
  check('a good file creates the drafts and the workspace validates', await page.evaluate(() => state.masterWIs.slice(0, 2).every(w => w.status === 'Draft') && MES.validate(state) === true));
  check('the import dialog text has no em dash', !(await page.evaluate(() => document.getElementById('dialog')?.innerText || '')).includes('—'));
  await context.close();
} finally {
  await browser.close();
}
check('the page opened without errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks} fail 0`);
