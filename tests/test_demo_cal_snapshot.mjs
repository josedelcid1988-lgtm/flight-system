// The demo seeds carry no calibration log, so demo tool checks read the Calibrated Tool Log snapshot shipped in
// index.html (CAL_SNAPSHOT, CAL_TOOLS). Without a demo deviation every snapshot tool expires within a year of
// capture and every operation that needs tooling is blocked in the demo. The demo build moves the snapshot
// label and tool expiries forward by the same days as the seed rebase (tools/demo/seed-dates.mjs), counted from
// the first-load day the page records, so the demo keeps the usable-tool share it had when it was captured.
// Production must not change: its snapshot lines are pinned by hash and its engine reports the shipped expiries.
// Signed buy-offs keep the tool expiries they recorded.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';
import { rebaseDemoSeed, rebaseCalSnapshot } from '../tools/demo/seed-dates.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'skyryse-mes-work-order-qa100-v1';
const DAY = 86400000;
const read = p => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
const gap = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const SEEDS = { curated: read('tools/demo/seed-curated.json'), qa150: read('tools/demo/seed-qa150.json') };
const FIXTURES = { curated: 'tests/fixtures/demo_publish.html', qa150: 'tests/fixtures/demo_qa150.html' };
const capturedOn = seed => seed.activity.map(a => a.at.slice(0, 10)).sort().pop();
// The first-load days from issue #152: by 2027-09-01 every production snapshot tool has expired.
const FIRST_LOAD_DAYS = ['2027-09-01', '2028-06-01'];
// The production snapshot lines, byte for byte. Refreshing the production snapshot is a production change made
// on purpose: update this hash in the same commit.
const PRODUCTION_SNAPSHOT_SHA256 = '93cb4b8aba7ea6aacb76d4ffa3fbe5c67f625158246c7b54ba1055ba5c969b8a';
const PRODUCTION_SNAPSHOT = '2026-09-15 15:13';

let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const usable = list => list.filter(c => c.ok).length;
const buyoffTools = orders => orders.flatMap(o => (o.operations || []).filter(op => op.buyoff && Array.isArray(op.buyoff.tools)).map(op => ({ id: `${o.id}/${op.id}`, tools: op.buyoff.tools })));

// ---- production is untouched ----------------------------------------------------------------------
const production = fs.readFileSync(`${ROOT}index.html`, 'utf8');
const lines = production.match(/  const CAL_SNAPSHOT = [^\n]*\n  const CAL_TOOLS = [^\n]*\n/);
check('index.html: the CAL_SNAPSHOT and CAL_TOOLS lines are byte-identical to the shipped snapshot', !!lines && crypto.createHash('sha256').update(lines[0]).digest('hex') === PRODUCTION_SNAPSHOT_SHA256);
check('tests/fixtures/publish.html: carries the same snapshot lines', fs.readFileSync(`${ROOT}tests/fixtures/publish.html`, 'utf8').includes(lines[0]));
const shipped = JSON.parse(/const CAL_TOOLS = Object\.freeze\((\[\[.*?\]\])\.map\(/.exec(lines[0])[1]).map(([tag, , , expires]) => ({ tag, expires }));
const prod = createHost(`${ROOT}index.html`).MES;
check('production engine: CAL_SNAPSHOT is the shipped label', prod.CAL_SNAPSHOT === PRODUCTION_SNAPSHOT, prod.CAL_SNAPSHOT);
check('production engine: every snapshot tool reports its shipped expiry', prod.CAL_TOOLS.length === shipped.length && shipped.every((t, i) => prod.CAL_TOOLS[i].tag === t.tag && prod.CAL_TOOLS[i].expires === t.expires));
const snapshotShare = usable(prod.calibratedToolChecks({}, '2026-09-15T22:13:00.000Z')) / shipped.length;
check('production engine: most snapshot tools are usable on the snapshot day', snapshotShare > 0.5, String(snapshotShare));
for (const day of FIRST_LOAD_DAYS) check(`production engine, ${day}: the shipped expiries still apply (every snapshot tool has expired)`, usable(prod.calibratedToolChecks({}, `${day}T15:00:00.000Z`)) === 0);

// ---- the function on its own -------------------------------------------------------------------------
for (const [name, seed] of Object.entries(SEEDS)) {
  const captured = capturedOn(seed);
  for (const now of [captured, addDays(captured, -30)]) {
    const out = rebaseCalSnapshot(PRODUCTION_SNAPSHOT, seed, `${now}T15:00:00.000Z`);
    check(`${name}, clock ${now} (on or before capture): nothing moves`, out.days === 0 && out.snapshot === PRODUCTION_SNAPSHOT && shipped.every(t => out.expires(t.expires) === t.expires));
  }
  for (const day of FIRST_LOAD_DAYS) {
    const now = `${day}T15:00:00.000Z`, out = rebaseCalSnapshot(PRODUCTION_SNAPSHOT, seed, now);
    // The seed rebase moves an open order's due date by its offset; the snapshot must move by the same days.
    const open = seed.orders.find(o => o.status !== 'Closed' && /^\d{4}-\d{2}-\d{2}$/.test(o.due || ''));
    const seedDays = gap(open.due, rebaseDemoSeed(seed, now).orders.find(o => o.id === open.id).due);
    check(`${name}, first load ${day}: the snapshot moves by the same days as the seed rebase (${seedDays})`, out.days === seedDays && out.days === gap(captured, day));
    check(`${name}, first load ${day}: the snapshot label keeps its time and moves its date`, out.snapshot === `${addDays('2026-09-15', out.days)} 15:13`, out.snapshot);
    check(`${name}, first load ${day}: every tool expiry moves by those days, so the spacing between tools is kept`, shipped.every(t => t.expires === '' ? out.expires('') === '' : gap(t.expires, out.expires(t.expires)) === out.days));
    check(`${name}, first load ${day}: a value that is not a date is returned as it is`, out.expires('') === '' && out.expires(undefined) === undefined && out.expires('soon') === 'soon');
  }
}
check('no seed or no activity: nothing moves', ['x', null, {}, { activity: [] }].every(s => rebaseCalSnapshot(PRODUCTION_SNAPSHOT, s, '2028-01-01T00:00:00.000Z').days === 0));

// ---- the demo page, first opened on those days ------------------------------------------------------------
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
const inPage = key => {
  const now = new Date().toISOString(), state = MES.upgrade(JSON.parse(localStorage.getItem(key)));
  const list = MES.calibratedToolChecks(state, now);
  const signed = state.orders.flatMap(o => (o.operations || []).filter(op => op.buyoff && Array.isArray(op.buyoff.tools)).map(op => ({ id: `${o.id}/${op.id}`, tools: op.buyoff.tools })));
  return { now, snapshot: MES.CAL_SNAPSHOT, tools: MES.CAL_TOOLS.map(t => ({ tag: t.tag, expires: t.expires })), usable: list.filter(c => c.ok).length, dueSoon: list.filter(c => c.ok && c.dueSoon).length, total: list.length, signed, manifests: MES.verifyManifests(state).ok };
};
try {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const seed = SEEDS[name], captured = capturedOn(seed);
    const atCapture = usable(prod.calibratedToolChecks(prod.upgrade(structuredClone(seed)), `${captured}T15:00:00.000Z`));
    const seedBuyoffs = buyoffTools(seed.orders);
    for (const day of FIRST_LOAD_DAYS) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name} ${day}: ${e.message}`));
      await page.clock.setFixedTime(new Date(`${day}T15:00:00Z`));
      await page.goto(pathToFileURL(`${ROOT}${fixture}`).href);
      await page.waitForFunction(key => typeof window.MES === 'object' && !!localStorage.getItem(key), KEY);
      const r = await page.evaluate(inPage, KEY);
      const days = gap(captured, day);
      check(`${name} page, first load ${day}: the snapshot label moved to ${addDays('2026-09-15', days)}`, r.snapshot === `${addDays('2026-09-15', days)} 15:13`, r.snapshot);
      check(`${name} page, first load ${day}: every tool expiry moved by ${days} days`, r.tools.length === shipped.length && shipped.every((t, i) => r.tools[i].tag === t.tag && r.tools[i].expires === (t.expires ? addDays(t.expires, days) : '')));
      check(`${name} page, first load ${day}: the usable-tool count is the one the seed had on its capture day (${atCapture} of ${r.total})`, r.usable === atCapture && r.usable > 0, `${r.usable}`);
      check(`${name} page, first load ${day}: the usable-tool share is close to the share on the snapshot day`, Math.abs(r.usable / r.total - snapshotShare) <= 0.1, `${r.usable}/${r.total} vs ${snapshotShare}`);
      check(`${name} page, first load ${day}: some tools still come due within 30 days`, r.dueSoon > 0 && r.dueSoon < r.usable, String(r.dueSoon));
      check(`${name} page, first load ${day}: signed buy-offs keep the tool expiries they recorded`, seedBuyoffs.length > 0 && JSON.stringify(r.signed) === JSON.stringify(seedBuyoffs));
      check(`${name} page, first load ${day}: every signature manifest verifies`, r.manifests === true);
      // A later visit keeps the first-load day: the snapshot does not roll forward with the clock.
      await page.clock.setFixedTime(new Date(`${addDays(day, 45)}T15:00:00Z`));
      await page.reload();
      await page.waitForFunction(() => typeof window.MES === 'object');
      const later = await page.evaluate(inPage, KEY);
      check(`${name} page, 45 days after first load ${day}: the snapshot stays on the first-load day`, later.snapshot === r.snapshot && JSON.stringify(later.tools) === JSON.stringify(r.tools));
      check(`${name} page, 45 days after first load ${day}: tools come due as the days pass`, later.usable < r.usable, `${later.usable} vs ${r.usable}`);
      await context.close();
    }
  }
  // Production page at the same clock: the shipped snapshot, unchanged.
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`publish: ${e.message}`));
  await page.clock.setFixedTime(new Date(`${FIRST_LOAD_DAYS[0]}T15:00:00Z`));
  await page.goto(pathToFileURL(`${ROOT}tests/fixtures/publish.html`).href);
  await page.waitForFunction(() => typeof window.MES === 'object');
  const p = await page.evaluate(() => ({ snapshot: MES.CAL_SNAPSHOT, tools: MES.CAL_TOOLS.map(t => ({ tag: t.tag, expires: t.expires })) }));
  check(`production page, ${FIRST_LOAD_DAYS[0]}: the shipped snapshot label and expiries, unchanged`, p.snapshot === PRODUCTION_SNAPSHOT && JSON.stringify(p.tools) === JSON.stringify(shipped));
  await context.close();
} finally {
  await browser.close();
}
check('the pages opened without page errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks} fail 0`);
