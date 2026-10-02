// Visual and wording polish (tablet first): each check names the audit item it covers and fails on the old behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_publish.html', import.meta.url).href;
const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const bundle = fs.readFileSync(new URL('../assets/flight-ui.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [], passed = [];
const check = (name, fn) => fn().then(() => passed.push(name));

// WCAG relative luminance contrast between an element's text and the first opaque background behind it.
const contrastOf = (page, selector) => page.locator(selector).first().evaluate(el => {
  const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  let node = el, bg = null;
  while (node && node.nodeType === 1) { const c = rgb(getComputedStyle(node).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.95)) { bg = c; break; } node = node.parentElement; }
  bg = bg || [255, 255, 255];
  const fg = lum(rgb(getComputedStyle(el).color)), back = lum(bg);
  return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
});

async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
    sessionStorage.setItem('sk-mnv-landing-seen', '1');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  return { context, page };
}
const go = (page, view) => page.evaluate(value => { view = value; render(); }, view);
const action = (page, name, data) => page.evaluate(([name, data]) => { const b = document.createElement('button'); b.dataset.action = name; Object.assign(b.dataset, data); document.body.appendChild(b); b.click(); b.remove(); }, [name, data]);

try {
  const { context, page } = await open(1024, 768);

  await check('H1 order table keeps ids, dates and badges on one line at 1024 and hides Created and Flight progress', async () => {
    await go(page, 'orders');
    await page.locator('.fr-order-table tbody tr').first().waitFor();
    const layout = await page.evaluate(() => {
      const table = document.querySelector('.fr-order-table');
      const oneLine = el => el.getClientRects().length === 1 && getComputedStyle(el).whiteSpace === 'nowrap';
      return {
        ids: [...table.querySelectorAll('.fr-record-link strong')].every(oneLine),
        dates: [...table.querySelectorAll('time')].filter(t => t.offsetParent).every(oneLine),
        badges: [...table.querySelectorAll('.fr-fai-tag,.fr-status,.fr-order-blocked')].every(oneLine),
        breakAnywhere: [...table.querySelectorAll('th,td')].some(cell => ['anywhere', 'break-word'].includes(getComputedStyle(cell).overflowWrap) || getComputedStyle(cell).wordBreak === 'break-all'),
        hidden: [...table.querySelectorAll('thead th')].filter(th => getComputedStyle(th).display === 'none').map(th => th.textContent.trim()),
        headerBreaks: [...table.querySelectorAll('thead th .log-sort span:first-child')].filter(span => span.textContent.trim().split(/\s+/).length === 1 && span.getBoundingClientRect().height > 30).map(span => span.textContent)
      };
    });
    assert.equal(layout.ids, true, 'work-order ids stay on one line');
    assert.equal(layout.dates, true, 'dates stay on one line');
    assert.equal(layout.badges, true, 'FAI, status and blocked badges stay on one line');
    assert.equal(layout.breakAnywhere, false, 'no order-table cell may break a word mid-letter');
    assert.deepEqual(layout.hidden, ['Created', 'Flight progress'], 'below 1200px Created and Flight progress are hidden');
    assert.deepEqual(layout.headerBreaks, [], 'one-word headers never wrap letter by letter');
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.fr-order-table thead th')].filter(th => getComputedStyle(th).display !== 'none').length), 8, 'a printed queue keeps Created and Flight progress');
    await page.emulateMedia({ media: 'screen' });
  });

  await check('H2 work-order section tabs are visible below a read-only stepper and navigate', async () => {
    await page.evaluate(() => { selectedId = state.orders.find(o => o.operations.length > 4).id; selectedOp = null; tab = 'operations'; view = 'order'; render(); });
    const tabs = page.locator('nav.tabs[aria-label="Work order sections"] [role="tab"]');
    await tabs.first().waitFor({ state: 'visible' });
    assert.deepEqual(await tabs.evaluateAll(list => list.map(b => b.firstChild.textContent.trim())), ['Kit', 'Build', 'Quality', 'Stock', 'Record']);
    assert.ok(await tabs.evaluateAll(list => list.every(b => b.querySelector('.badge')?.textContent.trim())), 'every tab shows its count');
    assert.equal(await page.locator('.route-stages button').count(), 0, 'lifecycle stages are status, not buttons');
    await page.evaluate(() => { selectedId = 'WO-10003'; tab = 'operations'; view = 'order'; render(); });
    const quality = await page.evaluate(() => { const o = MES.getOrder(state, 'WO-10003'); return [Number(document.querySelector('nav.tabs [data-tab="quality"] .badge').textContent), o.tickets.length + o.reports.length + (o.fai?.required ? 1 : 0) + o.conformity.length, o.conformity.length]; });
    assert.ok(quality[2] > 0, 'WO-10003 carries a conformity package');
    assert.equal(quality[0], quality[1], 'the Quality tab count includes FAIR and conformity packages, not only NC tickets and reports');
    await page.evaluate(() => { selectedId = state.orders.find(o => o.operations.length > 4).id; tab = 'operations'; view = 'order'; render(); });
    assert.equal(await page.locator('.route-stage[aria-current="step"]').count(), 1);
    await tabs.filter({ hasText: 'Kit' }).click();
    assert.equal(await page.evaluate(() => tab), 'materials', 'the Kit tab opens the kit section');
    assert.equal(await tabs.filter({ hasText: 'Kit' }).getAttribute('aria-selected'), 'true');
    await tabs.filter({ hasText: 'Record' }).click();
    assert.equal(await page.evaluate(() => tab), 'record', 'the Record tab opens the record section');
    await page.locator('.route-stage').filter({ hasText: /closed/i }).click({ force: true });
    assert.equal(await page.evaluate(() => tab), 'record', 'clicking the CLOSED stage no longer jumps to Stock');
  });

  await check('H4 light Maneuver headings use readable chips and next-step text, show the record id and align left', async () => {
    await action(page, 'mnv-open-board', { board: 'MRB-101' });
    await page.locator('#mnv-board-h').waitFor();
    for (const chip of ['.page-heading .order-link >> nth=0', '.page-heading .order-link >> nth=1']) assert.ok(await contrastOf(page, chip) >= 4.5, `${chip} contrast is at least 4.5:1`);
    assert.match(await page.locator('.page-heading .hero-eyebrow').innerText(), /MRB-101/i, 'the MRB id is visible in the eyebrow');
    await action(page, 'mnv-open-car', { car: 'CAR-1001' });
    await page.locator('#mnv-car-h').waitFor();
    assert.ok(await contrastOf(page, '.page-heading .small strong') >= 4.5, 'the CAR next step reads at 4.5:1 or better');
    assert.match(await page.locator('.page-heading .hero-eyebrow').innerText(), /CAR-1001/i);
    const offset = await page.evaluate(() => { const h = document.querySelector('.page-heading'); return document.querySelector('#mnv-car-h').getBoundingClientRect().left - h.getBoundingClientRect().left; });
    assert.ok(offset < 24, `the heading is left aligned (offset ${offset}px)`);
    await page.evaluate(() => { selectedId = state.orders[0].id; view = 'order'; render(); });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.page-heading h1')).color), 'rgb(255, 255, 255)', 'the dark work-order hero keeps white text');
  });

  await check('M1 Flight Plan nav marks only the current view', async () => {
    for (const [view, label] of [['plan-forecast', 'MRP forecast'], ['plan-kanban', 'Kanban']]) {
      await go(page, view);
      await page.locator('.fr-planning-nav').waitFor();
      assert.deepEqual(await page.locator('.fr-planning-nav [aria-current="page"]').allTextContents(), [label]);
    }
  });

  await check('M2 breadcrumbs and page titles use readable names', async () => {
    for (const [view, label] of [['qms-config', 'QMS configuration'], ['qms-records', 'System QMS records'], ['support-log', 'Support overrides'], ['trace-report', 'Traceability report']]) {
      await go(page, view);
      await page.waitForFunction(text => document.querySelector('#breadcrumb').textContent.trim() === text, label);
      assert.ok((await page.title()).endsWith(label), `${view} title ends with ${label}`);
    }
  });

  await check('M7 Maneuver nav badges equal the open records the lists count', async () => {
    for (const [view, badge] of [['mnv-intake', 'mnv-intake-count'], ['mnv-cars', 'mnv-car-count'], ['mnv-mrb', 'mnv-mrb-count'], ['mnv-spr', 'mnv-spr-count']]) {
      await go(page, view);
      await page.locator('.fr-count-open').waitFor();
      const open = Number(await page.locator('.fr-count-open').getAttribute('data-open-count'));
      assert.equal(Number(await page.locator(`#${badge}`).textContent()), open, `${view} badge equals the list's open count`);
    }
    await go(page, 'mnv-intake');
    await page.locator('[aria-label="Filter NC intake"]').selectOption('Open');
    assert.equal(await page.locator('.fr-queue tbody tr').count(), Number(await page.locator('#mnv-intake-count').textContent()), 'NC intake badge equals the Open list');
    assert.ok(Number(await page.locator('#mnv-intake-count').textContent()) > 0, 'an open NC inside a work order is counted');
    await go(page, 'mnv-mrb');
    await page.locator('.fr-count-open').waitFor();
    assert.equal(await page.locator('.fr-queue tbody tr').filter({ hasText: /Open/ }).count(), Number(await page.locator('#mnv-mrb-count').textContent()), 'the MRB badge counts only boards the MRB list shows as open');
  });

  await check('M17 empty lists say whether nothing exists or nothing matches', async () => {
    await go(page, 'mnv-spr');
    await page.locator('.fr-empty').waitFor();
    assert.equal(await page.locator('.fr-empty').innerText(), 'No problem reports yet.');
    assert.equal(await page.locator('.fr-maneuver footer').innerText(), '0 problem reports');
    await page.locator('[aria-label="Search Flight Maneuver records"]').fill('nothing-like-this');
    assert.match(await page.locator('.fr-empty').innerText(), /^No records match the search or filters/);
    assert.ok(bundle.includes('Nothing needs attention right now.'), 'an empty Quality Hangar says nothing needs attention, not that no records exist');
    await go(page, 'mnv-intake');
    await page.locator('[aria-label="Filter NC intake"]').selectOption('Escapes');
    await go(page, 'mnv-spr');
    await page.locator('.fr-empty').waitFor();
    assert.equal(await page.locator('.fr-empty').innerText(), 'No problem reports yet.', 'a hidden NC intake filter does not leak into another page');
  });

  await check('M18 an expired lot reads Expired N days ago in the danger colour', async () => {
    await go(page, 'plan-forecast');
    await page.locator('.fr-forecast-page').waitFor();
    const expected = await page.evaluate(() => FlightPlan.forecast(state).shelfLife.filter(item => item.daysLeft < 0).length);
    const cells = page.locator('.fr-expired-label');
    assert.equal(await cells.count(), expected);
    for (const text of await cells.allTextContents()) assert.match(text, /Expired \d+ days? ago$/);
    assert.doesNotMatch(await page.locator('.fr-forecast-page').innerText(), /· -\d+ days/);
  });

  await check('M8 a table wider than its panel is marked so it shows a scroll edge', async () => {
    await go(page, 'serials');
    await page.waitForFunction(() => document.querySelector('#main [data-scroll-x]'));
    const box = await page.locator('#main [data-scroll-x]').first().evaluate(el => { el.scrollLeft = el.scrollWidth; return new Promise(r => setTimeout(() => r([el.dataset.scrollX, getComputedStyle(el).boxShadow]), 100)); });
    assert.equal(box[0], 'end');
    assert.notEqual(box[1], 'none');
  });

  await check('M9 keyboard focus shows a ring on toolbar, search, filters and sidebar', async () => {
    await go(page, 'orders');
    await page.locator('.fr-order-table').waitFor();
    for (const selector of ['.fr-order-heading-actions .btn >> nth=0', '.fr-order-heading-actions .btn >> nth=-1', '.global-search input', '.fr-order-table th .log-menu summary >> nth=0', '.fs-utilities > summary']) {
      await page.keyboard.press('Shift');
      const ring = await page.locator(selector).evaluate(el => { el.focus(); const s = getComputedStyle(el); return [el.matches(':focus-visible'), s.outlineStyle, parseFloat(s.outlineWidth)]; });
      assert.equal(ring[0], true, `${selector} takes keyboard focus`);
      assert.equal(ring[1], 'solid', `${selector} shows a focus outline`);
      assert.ok(ring[2] >= 2, `${selector} focus outline is at least 2px`);
    }
  });

  await check('M13 keep-screen-awake toggle has a name and a visible label', async () => {
    const lock = page.locator('[data-wakelock]');
    assert.equal(await lock.getAttribute('aria-label'), 'Keep screen awake');
    assert.equal((await lock.locator('.wakelock-label').innerText()).trim(), 'Stay awake');
    assert.ok(await lock.locator('.wakelock-label').isVisible());
    await page.setViewportSize({ width: 360, height: 740 });
    assert.equal(await lock.locator('.wakelock-label').isVisible(), false, 'on a phone the label hides so the top bar fits');
    assert.equal(await lock.getAttribute('aria-label'), 'Keep screen awake', 'the accessible name stays on a phone');
    await page.setViewportSize({ width: 1024, height: 768 });
  });

  await check('M12 conformity history uses human labels', async () => {
    const entry = await page.evaluate(() => {
      const result = MES.saveConformity(state, 'WO-10003', 'CI-110-00001', { jira: 'MES-77', darName: 'J. Rivera', darDesignation: 'DAR-F 123' });
      return result.ok ? MES.getOrder(state, 'WO-10003').history.at(-1).action : result.message;
    });
    assert.match(entry, /Jira ticket MES-77; DAR name J\. Rivera; DAR designation no\. DAR-F 123/);
    const reviewEntry = await page.evaluate(() => { const result = MES.saveConformity(state, 'WO-10003', 'CI-110-00001', { darDate: '2026-09-30' }); return result.ok ? MES.getOrder(state, 'WO-10003').history.at(-1).action : result.message; });
    assert.match(reviewEntry, /DAR review date 2026-09-30/, 'the DAR review date is not recorded as a signature');
    assert.doesNotMatch(reviewEntry, /DAR signed/);
    assert.doesNotMatch(entry, /darName|darDesignation|jira MES/);
    assert.ok(source.includes('`Completed operation recorded: ${operation.title}.'), 'the buy-off entry starts with its subject');
    assert.ok(!source.includes('record(state, order, ` operation recorded:'), 'no buy-off entry starts with a dropped word');
  });

  await check('L1 count pills show plain numbers', async () => {
    for (const view of ['orders', 'plan-kanban', 'mnv-home']) {
      await go(page, view);
      await page.locator('.fr-count').first().waitFor();
      for (const text of await page.locator('.fr-count').allTextContents()) assert.doesNotMatch(text.trim(), /^0\d/, `${view} count "${text}" has no leading zero`);
    }
  });
  await context.close();

  await check('M5 the tablet top bar never lets the breadcrumb run into the search', async () => {
    for (const width of [901, 1024]) {
      const { context: narrow, page: narrowPage } = await open(width, 768);
      for (const view of ['qms-records', 'orders', 'order']) {
        if (view === 'order') await narrowPage.evaluate(() => { selectedId = state.orders.find(o => o.operations.length > 4).id; view = 'order'; render(); });
        else await go(narrowPage, view);
        const gap = await narrowPage.evaluate(() => document.querySelector('.topbar .global-search').getBoundingClientRect().left - document.querySelector('.breadcrumbs').getBoundingClientRect().right);
        assert.ok(gap >= 0, `${view} at ${width}px: the breadcrumb ends before the search (gap ${gap})`);
      }
      if (width === 1024) assert.equal(await narrowPage.evaluate(() => { const c = document.querySelector('#breadcrumb'); return c.scrollWidth <= c.clientWidth; }), true, 'at 1024 the work-order crumb is shown in full');
      await narrow.close();
    }
  });

  await check('H1 at 1440 the Created and Flight progress columns are shown', async () => {
    const { context: wide, page: widePage } = await open(1440, 900);
    await go(widePage, 'orders');
    await widePage.locator('.fr-order-table tbody tr').first().waitFor();
    assert.equal(await widePage.evaluate(() => [...document.querySelectorAll('.fr-order-table thead th')].filter(th => getComputedStyle(th).display !== 'none').length), 8);
    assert.equal(await widePage.evaluate(() => [...document.querySelectorAll('.fr-order-table .fr-record-link strong')].every(el => el.getClientRects().length === 1)), true);
    await wide.close();
  });

  await check('L3 L6 L9 L10 L15 low items: copy, touch targets and one primary style', async () => {
    assert.ok(source.includes('placeholder="Example: Functional test result requires review"') && !source.includes('placeholder="Example:  test'), 'the NC summary example has no dropped word');
    assert.ok(source.includes("${/[.!?]$/.test(note) ? '' : '.'}"), 'an MRB vote note that ends in a period is not given a second one');
    const { context: tablet, page: tabletPage } = await open(1024, 768);
    await go(tabletPage, 'mnv-intake');
    await tabletPage.locator('.fr-primary').first().waitFor();
    const primary = await tabletPage.locator('.fr-primary').first().evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage]);
    assert.deepEqual(primary, ['rgb(20, 22, 21)', 'none'], 'Raise NC uses the same solid primary as Create work order');
    await go(tabletPage, 'orders');
    await tabletPage.locator('.fr-order-table th .log-menu > summary').first().waitFor();
    const taps = await tabletPage.evaluate(() => [...document.querySelectorAll('.fr-order-table thead th')].filter(th => th.querySelector('.log-menu > summary') && getComputedStyle(th).display !== 'none').map(th => { const f = th.querySelector('.log-menu > summary').getBoundingClientRect(), s = th.querySelector('.log-sort').getBoundingClientRect(); return [f.width, f.height, f.left - s.right]; }));
    for (const [w, h, gap] of taps) assert.ok(w >= 44 && h >= 44 && gap >= 0, `column filter is a 44px target that does not overlap its sort button (${w}x${h}, gap ${gap})`);
    assert.equal(await tabletPage.locator('.fr-order-page .fr-table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'the 44px filters still fit the table at 1024');
    await tablet.close();
  });

  await check('M3 and M11 view names match the nav and developer copy is gone', async () => {
    for (const old of ["'Planning board'", "'Material forecast'", "wis:'Work instruction library'", "'Process risk analysis'", 'Skyryse Problem Reports']) assert.ok(!source.includes(old), `index.html no longer names a view ${old}`);
    for (const old of ['remain authoritative', 'approval gates remain in Flight Maneuver', 'supplied Datum source', 'Corrective action · in-house', 'Current Flight System records', 'Running serial assignment register', 'NC Intake', 'Corrective Actions', 'Problem Reports']) assert.ok(!bundle.includes(old), `the React bundle no longer shows "${old}"`);
  });
} finally {
  await browser.close();
}
console.log(`checks ${passed.length} pass 0 fail 0`);
console.log('page errors', JSON.stringify(errors));
assert.deepEqual(errors, []);
