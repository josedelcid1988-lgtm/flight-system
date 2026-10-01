// Work orders can be loaded in bulk from a CSV by an account that may create work orders (create-wo). Each row is
// one work order cloned from a released master WI through addOrder, the same path as Create work order, so every
// rule applies: only a released WI issues orders (an unreleased-drawing WI only Development ones), the pedigree,
// subcategory, quantity, aircraft and site checks, the first-article flag and its waiver, and the workspace limit.
// The import is all or nothing: one bad row creates nothing and names the row.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const ops = { username: 'ops-olive', displayName: 'Olive Ops', role: 'ops' };
const tech = { username: 'tech-sam', displayName: 'Sam Tech', role: 'technician' };
const SEED = fs.readFileSync(new URL('../tools/demo/seed-curated.json', import.meta.url), 'utf8');
let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const fresh = () => MES.upgrade(JSON.parse(SEED));
const run = (state, account, fn) => host.withAccount(account, fn, state);
const HEADER = 'masterWI,wiRevision,pedigree,subcategory,quantity,aircraft,site,start,due,fai,faiWaiver';
const GOOD = [
  HEADER,
  'MWI-0002,A,Production,Mfg.,2,C3,HHR,2026-10-05,2026-10-12,,',
  'mwi-0009,a,development,mfg.,1,c4,,,,No,"FAI covered on WO-10001, same revision"',
  'MWI-0010,A,Production,Mfg.,1,C3,CMA,2026-10-06,,,',
].join('\n');

check('importWorkOrders resolves as a server action', typeof host.resolveAction('MES.importWorkOrders') === 'function');

// ---- the role gate (refusal path) ----------------------------------------------------------------------------
{
  const state = fresh(), before = JSON.stringify(state);
  const res = run(state, tech, () => MES.importWorkOrders(state, GOOD));
  check('an account without create-wo cannot import work orders, and nothing changes', !res.ok && JSON.stringify(state) === before, res.message);
}

// ---- a good import -------------------------------------------------------------------------------------------
{
  const state = fresh(), before = state.orders.length;
  const res = run(state, ops, () => MES.importWorkOrders(state, GOOD));
  check('an account with create-wo imports every row', res.ok && res.ids.length === 3 && state.orders.length === before + 3, res.message);
  const made = res.ids.map(id => state.orders.find(o => o.id === id));
  check('the result names how many orders and their ids', /^Imported 3 work orders as drafts: /.test(res.message), res.message);
  check('each order is cloned from its master WI', made[0].masterWI.id === 'MWI-0002' && made[1].masterWI.id === 'MWI-0009' && made[2].masterWI.id === 'MWI-0010');
  check('names are matched without regard to case', made[1].pedigree === 'Development' && made[1].subcategory === 'Mfg.' && made[1].aircraft === 'C4');
  check('quantity, site and dates come from the file', made[0].quantity === 2 && made[0].site === 'HHR' && made[0].start === '2026-10-05' && made[0].due === '2026-10-12' && made[1].site === null);
  check('an order with the first-article flag cleared records the waiver', made[1].faiWaiver === 'FAI covered on WO-10001, same revision' || JSON.stringify(made[1]).includes('FAI covered on WO-10001, same revision'));
  check('every order starts as a draft, as when created by hand', made.every(o => o.status === 'Draft'));
  check('the workspace validates and every manifest verifies', MES.validate(state) === true && MES.verifyManifests(state).ok === true, (MES.diagnose(state) || {}).detail);
}

// ---- all or nothing: every refusal leaves the workspace untouched -------------------------------------------------
const refused = (name, text, pattern) => {
  const state = fresh(), before = JSON.stringify(state);
  const res = run(state, ops, () => MES.importWorkOrders(state, text));
  check(name, !res.ok && pattern.test(res.message) && JSON.stringify(state) === before, res.message);
};
const row = (over = {}) => { const r = { masterWI: 'MWI-0002', wiRevision: 'A', pedigree: 'Production', subcategory: 'Mfg.', quantity: '1', aircraft: 'C3', site: '', start: '', due: '', fai: '', faiWaiver: '', ...over }; return HEADER.split(',').map(k => r[k]).join(','); };
refused('one bad row creates nothing and names the row', [HEADER, row(), row({ masterWI: 'MWI-0001', wiRevision: 'B' })].join('\n'), /^Nothing was imported\. Row 3 \(MWI-0001 Rev B\): MWI-0001 Rev B is Draft\. Only released master WIs can issue work orders\./);
refused('an unreleased-drawing WI cannot issue a Production order', [HEADER, row({ masterWI: 'MWI-0011' })].join('\n'), /Row 2 \(MWI-0011 Rev A\): MWI-0011 Rev A is written to an unreleased drawing/);
refused('an unknown master WI is refused', [HEADER, row({ masterWI: 'MWI-0999' })].join('\n'), /Row 2 \(MWI-0999 Rev A\): Choose a released master WI/);
refused('a quantity that is not a whole number is refused', [HEADER, row({ quantity: '1.5' })].join('\n'), /Row 2 \(MWI-0002 Rev A\): Choose a master WI, pedigree, subcategory, and a whole quantity from 1 to 1,000\./);
refused('an unknown aircraft is refused', [HEADER, row({ aircraft: 'C9' })].join('\n'), /Row 2 \(MWI-0002 Rev A\): Choose the intended aircraft/);
refused('a bad fai value is refused', [HEADER, row({ fai: 'maybe' })].join('\n'), /Row 2: fai is Yes or No/);
refused('a missing required column is refused and named', 'masterWI,wiRevision,pedigree\nMWI-0002,A,Production', /needs the columns subcategory, quantity, aircraft/);
refused('an unknown column is refused', `${HEADER},priority\n${row()},High`, /columns this import does not read: priority/);
refused('a row with the wrong number of cells is refused', [HEADER, `${row()},extra`].join('\n'), /Row 2 has 12 cells but the header has 11 columns/);
refused('an unclosed quote is refused', [HEADER, `"${row()}`].join('\n'), /unclosed or misplaced quote/);
refused('a header with no rows is refused', HEADER, /header row and at least one work order/);
refused('more than 100 rows at a time is refused', [HEADER, ...Array.from({ length: 101 }, () => row())].join('\n'), /up to 100 work orders at a time/);
{
  const state = fresh(), room = 100 - state.orders.length;
  const before = JSON.stringify(state);
  const res = run(state, ops, () => MES.importWorkOrders(state, [HEADER, ...Array.from({ length: room + 1 }, () => row({ pedigree: 'Development' }))].join('\n')));
  check('the workspace limit refuses the whole import, naming the row that would pass it', !res.ok && new RegExp(`Row ${room + 2} \\(MWI-0002 Rev A\\): A workspace holds up to 100 work orders`).test(res.message) && JSON.stringify(state) === before, res.message);
}

// ---- the All work orders screen -----------------------------------------------------------------------------------
const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(seed => {
    if (!sessionStorage.getItem('wo-import-seeded')) { localStorage.setItem('skyryse-mes-work-order-v1', seed); sessionStorage.setItem('wo-import-seeded', '1'); }
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'olive', displayName: 'Olive Ops', salt: 'test', hash: 'unused', role: 'ops', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'olive');
    sessionStorage.setItem('sk-boot-seen', '1');
  }, SEED);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'orders'; render(); });
  const button = page.locator('[data-action="wo-import"]');
  check('the work order list offers the CSV import', await button.count() === 1);
  const before = await page.evaluate(() => state.orders.length);
  await button.click();
  await page.locator('#wo-import-form [name=csv]').fill([HEADER, row(), row({ masterWI: 'MWI-0001', wiRevision: 'B' })].join('\n'));
  await page.locator('#wo-import-form button[type=submit]').click();
  await page.locator('#wo-import-error', { hasText: 'Nothing was imported. Row 3 (MWI-0001 Rev B)' }).waitFor();
  check('a bad file shows the refusal and creates nothing', await page.evaluate(() => state.orders.length) === before);
  await page.locator('#wo-import-form [name=csv]').fill(GOOD);
  await page.locator('#wo-import-form button[type=submit]').click();
  await page.waitForFunction(n => state.orders.length === n + 3, before);
  check('a good file creates the orders and the workspace validates', await page.evaluate(() => MES.validate(state) === true));
  check('the import dialog text has no em dash', !(await page.evaluate(() => document.getElementById('dialog')?.innerText || '')).includes('—'));
  await context.close();
} finally {
  await browser.close();
}
check('the page opened without errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks} fail 0`);
