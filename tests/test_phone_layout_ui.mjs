// Run after the Playwright setup in TESTING.md. Optional: CHROME_PATH=/path/to/chrome.
// Phone layout (below 700px): no screen scrolls sideways at 390 and 360 px, work-order lists render as cards with
// every field a person needs, tables that stay tables scroll inside their own box, and the sign-in form is readable
// over the photograph. At 1024 and 1440 px the work-order lists stay tables and the sign-in keeps its desktop look.
//
// html and body carry overflow-x:clip, which hides a sideways overflow from document.documentElement.scrollWidth
// while a phone browser can still pan to it. Every width check here lifts that clip first, so it measures what the
// page really lays out, and the probe is checked against a planted wide element so it cannot pass by accident.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const fixtureDir = process.env.FS_FIXTURES_DIR
  ? new URL(process.env.FS_FIXTURES_DIR.endsWith('/') ? process.env.FS_FIXTURES_DIR : process.env.FS_FIXTURES_DIR + '/', 'file:///')
  : new URL('./fixtures/', import.meta.url);
const fixture = name => new URL(name, fixtureDir).href;
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 740 }];
const ORDER_TABS = ['operations', 'materials', 'quality', 'inventory', 'record'];
const ROUTES = ['home', 'orders', 'plan-home', 'plan', 'plan-kanban', 'plan-forecast', 'mnv-home', 'mnv-intake', 'mnv-mrb', 'mnv-cars', 'activity'];
const FAILS = [];
const check = (label, fn) => fn().then(() => console.log('PASS', label), error => { const line = error.message.split('\n')[0]; FAILS.push(`${label}: ${line}`); console.log('FAIL', label, line); });

// Widest point the page lays out, with the html/body clip lifted for the measurement only.
const layoutWidth = page => page.evaluate(() => {
  const lift = document.createElement('style');
  lift.textContent = 'html,body{overflow-x:visible!important}';
  document.head.append(lift);
  const width = document.documentElement.scrollWidth;
  lift.remove();
  return { width, viewport: innerWidth };
});
const assertNoSideScroll = async (page, where) => {
  const { width, viewport } = await layoutWidth(page);
  assert.ok(width <= viewport, `${where} lays out ${width}px on a ${viewport}px screen`);
};

const luminance = rgb => {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const parseColor = text => { const parts = text.match(/rgba?\(([^)]+)\)/)[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 }; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const signIn = async page => {
  await page.fill('#sk-boot input[name=username]', 'demo');
  await page.fill('#sk-boot input[name=password]', 'demo1234');
  await page.locator('#sk-boot form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => !document.getElementById('sk-boot'));
};
const show = (page, next, setup) => page.evaluate(([v, s]) => { if (s) Function(s)(); view = v; render(); scrollTo(0, 0); }, [next, setup || '']);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  for (const size of PHONES) {
    const at = `${size.width}x${size.height}`;
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${at}: ${error.message}`));
    await page.goto(fixture('demo_publish.html'));
    await page.waitForSelector('#sk-boot input[name=username]');

    await check(`${at} sign-in: the probe catches a planted overflow`, async () => {
      await page.evaluate(() => { const wide = document.createElement('div'); wide.id = 'phone-probe'; wide.style.cssText = 'width:2000px;height:1px'; document.body.append(wide); });
      const { width, viewport } = await layoutWidth(page);
      await page.evaluate(() => document.getElementById('phone-probe').remove());
      assert.ok(width > viewport, 'a 2000px element must register as a sideways overflow');
    });
    await check(`${at} sign-in: no sideways scroll`, () => assertNoSideScroll(page, 'sign-in'));
    await check(`${at} sign-in: inputs are solid with readable text`, async () => {
      for (const name of ['username', 'password']) {
        const style = await page.locator(`#sk-boot input[name=${name}]`).evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, fg: s.color }; });
        const bg = parseColor(style.bg), fg = parseColor(style.fg);
        assert.equal(bg.alpha, 1, `${name} input background is solid (${style.bg})`);
        const ratio = contrast(fg.rgb, bg.rgb);
        assert.ok(ratio >= 4.5, `${name} input contrast ${ratio.toFixed(2)} is at least 4.5:1`);
      }
      const panel = parseColor(await page.locator('#sk-login').evaluate(el => getComputedStyle(el).backgroundColor));
      assert.equal(panel.alpha, 1, 'the sign-in form sits on a solid panel');
    });
    await check(`${at} sign-in: the kicker clears the hangar light bar`, async () => {
      await page.waitForFunction(() => document.querySelector('#sk-boot .sk-bg')?.complete);
      const geometry = await page.evaluate(() => {
        // The light bar spans 135 to 160 px of the 1200 px tall photograph. Map it through object-fit: cover.
        const img = document.querySelector('#sk-boot .sk-bg'), box = img.getBoundingClientRect();
        const scale = Math.max(box.width / img.naturalWidth, box.height / img.naturalHeight);
        const y = getComputedStyle(img).objectPosition.split(' ')[1] || '50%';
        const top = box.top + (box.height - img.naturalHeight * scale) * (y.endsWith('%') ? parseFloat(y) / 100 : 0.5);
        const kicker = document.querySelector('#sk-boot .sk-eyebrow').getBoundingClientRect();
        return { loaded: img.naturalWidth > 0, barTop: top + 135 * scale, barBottom: top + 160 * scale, kickerTop: kicker.top, kickerBottom: kicker.bottom };
      });
      assert.ok(geometry.loaded, 'the hangar photograph loaded');
      assert.ok(geometry.kickerTop >= geometry.barBottom + 8 || geometry.kickerBottom <= geometry.barTop - 8,
        `kicker ${Math.round(geometry.kickerTop)} to ${Math.round(geometry.kickerBottom)} overlaps the light bar ${Math.round(geometry.barTop)} to ${Math.round(geometry.barBottom)}`);
    });

    await signIn(page);
    assert.equal(await page.evaluate(() => MES.validate(state)), true);
    for (const route of ROUTES) await check(`${at} ${route}: no sideways scroll`, async () => { await show(page, route); await assertNoSideScroll(page, route); });
    const orderId = await page.evaluate(() => (state.orders.find(o => o.status === 'Building') || state.orders[0]).id);
    for (const tab of ORDER_TABS) await check(`${at} work order ${tab}: no sideways scroll`, async () => { await show(page, 'order', `selectedId=${JSON.stringify(orderId)};selectedOp=null;tab=${JSON.stringify(tab)};`); await assertNoSideScroll(page, `work order ${tab}`); });
    await check(`${at} Raise NC form: no sideways scroll`, async () => {
      await show(page, 'mnv-intake');
      await page.evaluate(() => { const b = document.createElement('button'); b.dataset.action = 'mnv-nc-new'; document.body.append(b); b.click(); b.remove(); });
      await page.waitForFunction(() => document.querySelector('#dialog')?.open);
      await assertNoSideScroll(page, 'Raise NC');
      assert.ok(await page.locator('#dialog').evaluate(el => el.getBoundingClientRect().right) <= size.width, 'the Raise NC dialog fits the screen');
      await page.evaluate(() => document.querySelector('#dialog').close());
    });

    for (const route of ['home', 'orders']) {
      await check(`${at} ${route}: work orders render as cards`, async () => {
        await show(page, route);
        const list = page.locator('#main .fr-has-cards');
        assert.equal(await list.locator('table tbody tr').first().isVisible(), false, 'the table rows are hidden below 700px');
        const cards = list.locator('.fr-wo-card');
        const count = await cards.count();
        assert.ok(count > 0, 'cards are shown');
        assert.equal(count, await list.locator('table tbody tr').count(), 'one card per work order');
        const sample = await cards.evaluateAll(els => els.slice(0, 12).map(card => ({
          id: card.querySelector('.fr-wo-card-id')?.textContent.trim(),
          status: card.querySelector('.fr-status, .fr-order-blocked')?.textContent.trim(),
          title: card.querySelector('.fr-wo-card-title')?.textContent.trim(),
          part: card.querySelector('.fr-wo-card-part')?.textContent.trim(),
          fields: [...card.querySelectorAll('.fr-wo-card-fields dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling?.textContent.trim()]),
          open: card.querySelector('.fr-wo-card-open')?.offsetHeight,
          right: card.getBoundingClientRect().right
        })));
        for (const card of sample) {
          assert.match(card.id, /^WO-/, 'card shows the work order id');
          assert.ok(card.status && card.title && card.part, `${card.id} shows status, title and part number`);
          assert.deepEqual(card.fields.map(([label]) => label), ['Next step', 'Owner', 'Due'], `${card.id} shows next step, owner and due date`);
          assert.ok(card.fields.every(([, value]) => value), `${card.id} fills every field`);
          assert.ok(card.open >= 44, `${card.id} open button is at least 44px tall (measured ${card.open})`);
          assert.ok(card.right <= size.width, `${card.id} card fits the screen`);
        }
        if (route === 'orders') assert.match(await cards.first().locator('.fr-wo-card-part').innerText(), / \/ Rev /, 'All work orders cards show part number and revision');
        const id = await cards.first().locator('.fr-wo-card-id').innerText();
        await cards.first().getByRole('button', { name: 'Open ' + id }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Open full work order' }).waitFor();
        await page.getByRole('button', { name: 'Close record details' }).click();
      });
    }
    await check(`${at} home: the Hangar keeps no table header on a phone`, async () => {
      await show(page, 'home');
      assert.equal(await page.locator('#main .fr-has-cards > table').isVisible(), false, 'the Hangar table, header included, is hidden');
    });
    await check(`${at} orders: column sort and filter controls stay reachable above the cards`, async () => {
      await show(page, 'orders');
      const header = page.locator('#main .fr-order-table thead');
      assert.equal(await header.isVisible(), true, 'the column controls are shown');
      const sorts = await header.locator('[data-tbl-sort]').evaluateAll(els => els.map(el => ({ label: el.getAttribute('aria-label'), height: el.offsetHeight, right: el.getBoundingClientRect().right })));
      assert.ok(sorts.length >= 6, 'every sortable column has a control');
      for (const sort of sorts) { assert.ok(sort.height >= 44, `${sort.label} is at least 44px tall (measured ${sort.height})`); assert.ok(sort.right <= size.width, `${sort.label} fits the screen`); }
      await header.getByRole('button', { name: 'Sort by Due' }).click();
      await header.getByRole('button', { name: 'Sort by Due' }).click();
      assert.equal(await page.locator('#main .fr-order-table [data-col="Due"] .log-arrow').innerText(), '▼', 'Due is sorted descending');
      const order = await page.evaluate(() => ({ cards: [...document.querySelectorAll('#main .fr-wo-card')].map(el => el.dataset.woCard), rows: [...document.querySelectorAll('#main .fr-order-table tbody tr')].map(el => el.dataset.orderRow) }));
      assert.deepEqual(order.cards, order.rows, 'the cards follow the sorted order');
      const dues = await page.evaluate(ids => ids.map(id => MES.getOrder(state, id).due || ''), order.cards);
      assert.deepEqual(dues, [...dues].sort().reverse(), 'the cards run from the latest due date');
      await header.locator('summary[aria-label="Filter Priority"]').click();
      const menu = await header.locator('.log-menu[open] .log-menu-body').evaluate(el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right }; });
      assert.ok(menu.left >= 0 && menu.right <= size.width, 'the filter menu opens inside the screen');
      await assertNoSideScroll(page, 'orders with a filter menu open');
      await header.locator('.log-menu[open] [data-tbl-filter][data-value="Low"]').click();
      const shown = await page.locator('#main .fr-wo-card').count();
      assert.equal(shown, await page.evaluate(() => state.orders.filter(o => o.priority === 'Low' && !MES.aogActive(o)).length), 'the priority filter narrows the cards');
      await page.evaluate(() => { skTable.reset('orders'); render(); });
    });
    await check(`${at} orders: a held card names the holds and a superseded revision is marked`, async () => {
      await show(page, 'orders');
      const held = page.locator('#main .fr-wo-card.is-held').first();
      assert.ok(await held.count(), 'the sample has a held work order');
      assert.match(await held.locator('.fr-wo-card-next dd').innerText(), /^Resolve holds before continuing/, 'a held card asks for its holds, not an operation');
      const id = await page.evaluate(() => state.orders.find(o => o.status !== 'Closed').id);
      await page.evaluate(orderId => { window.__revisionLabel = MES.revisionLabel; MES.revisionLabel = o => o.id === orderId ? 'Superseded' : window.__revisionLabel(o); render(); }, id);
      assert.equal(await page.locator(`#main [data-wo-card="${id}"] .fr-wo-card-warning`).innerText(), 'Superseded revision');
      await page.evaluate(() => { MES.revisionLabel = window.__revisionLabel; render(); });
    });
    await check(`${at} orders: Kitting and Quality cards name their stage gate, Building cards their next operation`, async () => {
      for (const route of ['home', 'orders']) {
        await show(page, route);
        const cards = await page.evaluate(() => [...document.querySelectorAll('#main .fr-wo-card:not(.is-held)')].map(card => {
          const order = MES.getOrder(state, card.dataset.woCard);
          return { id: order.id, status: order.status, gate: MES.canAdvance(order), pedigree: !!order.pedigreeChange,
            op: ((order.operations || []).find(o => !o.done) || {}).title, next: card.querySelector('.fr-wo-card-next dd').textContent.trim() };
        }));
        const kitting = cards.filter(c => c.status === 'Kitting' && !c.gate.allowed);
        assert.ok(kitting.length, `${route}: the sample has a Kitting order that cannot start the build`);
        for (const c of kitting) assert.equal(c.next, c.gate.reason, `${route} ${c.id}: a Kitting card names what blocks the build, not an operation`);
        for (const c of cards.filter(c => c.status === 'Quality')) assert.equal(c.next, 'Complete the quality review to close.', `${route} ${c.id}`);
        const building = cards.filter(c => c.status === 'Building' && !c.pedigree && c.op);
        assert.ok(building.length, `${route}: the sample has a Building order`);
        for (const c of building) assert.equal(c.next, c.op, `${route} ${c.id}: a Building card shows its next open operation`);
      }
    });
    await check(`${at} home and orders: an overdue open order's card marks its due date`, async () => {
      const id = await page.evaluate(() => { const o = state.orders.find(x => x.status !== 'Closed' && !MES.blockingTickets(x).length); window.__due = o.due; o.due = '2020-01-02'; return o.id; });
      for (const route of ['home', 'orders']) {
        await show(page, route);
        assert.equal(await page.locator(`#main [data-wo-card="${id}"] .fr-wo-card-fields dd.is-overdue`).count(), 1, `${route}: ${id} due date is marked overdue`);
      }
      await page.evaluate(orderId => { MES.getOrder(state, orderId).due = window.__due; render(); }, id);
      await show(page, 'home');
      assert.equal(await page.locator(`#main [data-wo-card="${id}"] dd.is-overdue`).count(), 0, 'a due date that has not passed is not marked');
    });
    await check(`${at} home and orders: cards show FAI, a nonholding open NC, a source-inspection hold and the QA handoff`, async () => {
      // Each case is set up in memory on a copy of the sample, rendered, checked in both card lists, then put back.
      const setup = await page.evaluate(() => {
        const open = state.orders.filter(o => o.status !== 'Closed');
        const nc = state.orders.find(o => (o.tickets || []).some(t => t.status === 'Open' && t.hold));
        const ticket = nc.tickets.find(t => t.status === 'Open' && t.hold);
        const fai = open.find(o => o !== nc);
        // A Quality order has every operation bought off; set back to Building it is a finished build waiting on the QA handoff.
        const building = state.orders.find(o => o.status === 'Quality' && o !== nc && o !== fai && o.operations.every(op => op.done) && !MES.blockingTickets(o).length && !MES.engineeringChange(o) && !o.pedigreeChange);
        const inspect = open.find(o => o !== nc && o !== fai && o !== building && !MES.blockingTickets(o).length && !MES.engineeringChange(o) && (o.operations || []).some(op => !op.done));
        const op = inspect.operations.find(item => !item.done);
        window.__restore = { ticket: [ticket, ticket.hold], fai: [fai, fai.fai], building: [building, building.status], op: [op, op.classification, op.sourceInspection] };
        ticket.hold = false;
        fai.fai = { ...(fai.fai || {}), required: true };
        building.status = 'Building';
        op.classification = MES.SOURCE_INSPECTION_CLASS; delete op.sourceInspection;
        const hold = MES.sourceInspectionHolds(null, inspect)[0];
        return { nc: nc.id, open: nc.tickets.filter(t => t.status === 'Open').length, fai: fai.id, building: building.id, buildingAllowed: MES.canAdvance(building).allowed, inspect: inspect.id, holdTitle: hold && hold.title };
      });
      try {
        assert.ok(setup.holdTitle, 'the source-inspection setup produces a hold');
        assert.ok(setup.buildingAllowed, 'the finished Building order may advance');
        for (const route of ['home', 'orders']) {
          await show(page, route);
          const card = id => page.locator(`#main [data-wo-card="${id}"]`);
          assert.equal(await card(setup.nc).locator('.fr-order-blocked').count(), 0, `${route}: a card with only a nonholding NC is not Blocked`);
          assert.equal(await card(setup.nc).locator('.fr-wo-card-nc').innerText(), `${setup.open} open NC`, `${route}: a nonholding open NC is shown on the card`);
          assert.equal(await card(setup.fai).locator('.fr-wo-card-id .fr-fai-tag').innerText(), 'FAI', `${route}: an FAI order is marked`);
          assert.equal(await card(setup.inspect).locator('.fr-order-blocked').count(), 1, `${route}: a source-inspection hold blocks the card`);
          assert.match(await card(setup.inspect).locator('.fr-wo-card-next dd').innerText(), new RegExp(`^Resolve holds before continuing: .*source inspection record for ${setup.holdTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${route}: the card names the source inspection`);
          assert.equal(await card(setup.building).locator('.fr-wo-card-next dd').innerText(), 'All operations recorded. Send to QA.', `${route}: a finished build is sent to QA`);
        }
      } finally {
        await page.evaluate(() => { const r = window.__restore; r.ticket[0].hold = r.ticket[1]; r.fai[0].fai = r.fai[1]; r.building[0].status = r.building[1]; r.op[0].classification = r.op[1]; if (r.op[2]) r.op[0].sourceInspection = r.op[2]; render(); });
      }
      assert.equal(await page.evaluate(() => MES.validate(state)), true, 'the restored workspace is valid');
    });
    await check(`${at} orders: Compact changes the cards`, async () => {
      await show(page, 'orders');
      const padding = () => page.locator('#main .fr-wo-card').first().evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
      const before = await padding();
      await page.locator('#main .fr-density').click();
      assert.equal(await page.locator('#main .fr-wo-cards').evaluate(el => el.classList.contains('fr-compact')), true);
      assert.ok(await padding() < before, 'compact cards are tighter');
      await page.locator('#main .fr-density').click();
    });
    await check(`${at} orders: a priority change on a card keeps focus on that card`, async () => {
      await show(page, 'orders');
      const select = page.locator('#main .fr-wo-card select[data-priority-order]:not([disabled])').first();
      const id = await select.getAttribute('data-priority-order');
      const next = await select.evaluate(el => [...el.options].map(o => o.value).find(v => v !== el.value && v !== 'AOG'));
      await select.selectOption(next);
      await page.waitForFunction(([orderId, value]) => MES.getOrder(state, orderId)?.priority === value, [id, next]);
      assert.equal(await page.evaluate(orderId => document.activeElement?.closest('.fr-wo-card')?.dataset.woCard, id), id, 'focus returns to the visible card control');
      assert.equal(await page.evaluate(() => MES.validate(state)), true);
    });
    await check(`${at} activity: a table that stays a table scrolls inside its own box`, async () => {
      await show(page, 'activity');
      const box = await page.locator('#main .fr-table-scroll').first().evaluate(el => ({ overflow: getComputedStyle(el).overflowX, inner: el.scrollWidth, outer: el.clientWidth, cue: getComputedStyle(el).backgroundImage }));
      assert.match(box.overflow, /auto|scroll/);
      assert.ok(box.inner > box.outer, 'the activity table is wider than its box on a phone');
      assert.match(box.cue, /radial-gradient/, 'the box carries the scroll-shadow cue');
      await assertNoSideScroll(page, 'activity');
    });
    await check(`${at} sidebar is a menu drawer and the top bar fits`, async () => {
      await show(page, 'home');
      assert.equal(await page.locator('.sidebar').isVisible(), false, 'the sidebar is closed on a phone');
      const toggle = page.locator('.fs-menu-toggle');
      assert.equal(await toggle.isVisible(), true, 'a menu button is shown');
      const tap = await toggle.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight }));
      assert.ok(tap.width >= 44 && tap.height >= 44, 'the menu button is at least 44px');
      await toggle.click();
      assert.equal(await page.locator('.sidebar').isVisible(), true, 'the menu button opens the drawer');
      await assertNoSideScroll(page, 'open menu drawer');
      await toggle.click();
      assert.ok(await page.locator('.topbar').evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth), 'the top bar fits');
    });
    await context.close();
  }

  for (const size of [{ width: 1024, height: 900 }, { width: 1440, height: 1000 }]) {
    const at = `${size.width}x${size.height}`;
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${at}: ${error.message}`));
    await page.goto(fixture('demo_publish.html'));
    await page.waitForSelector('#sk-boot input[name=username]');
    await check(`${at} sign-in keeps the desktop look`, async () => {
      assert.equal(parseColor(await page.locator('#sk-login').evaluate(el => getComputedStyle(el).backgroundColor)).alpha, 0, 'no phone panel at this width');
    });
    await signIn(page);
    for (const route of ['home', 'orders']) {
      await check(`${at} ${route}: work orders stay a table`, async () => {
        await show(page, route);
        const list = page.locator('#main .fr-has-cards');
        assert.equal(await list.locator('table').isVisible(), true, 'the table is shown');
        assert.ok(await list.locator('table tbody tr').count() > 0);
        assert.equal(await list.locator('.fr-wo-cards').evaluate(el => getComputedStyle(el).display), 'none', 'cards are hidden at tablet and desktop widths');
      });
    }
    await check(`${at} orders: a priority change in the table keeps focus in the table`, async () => {
      await show(page, 'orders');
      const select = page.locator('#main table select[data-priority-order]:not([disabled])').first();
      const id = await select.getAttribute('data-priority-order');
      const next = await select.evaluate(el => [...el.options].map(o => o.value).find(v => v !== el.value && v !== 'AOG'));
      await select.selectOption(next);
      await page.waitForFunction(([orderId, value]) => MES.getOrder(state, orderId)?.priority === value, [id, next]);
      assert.equal(await page.evaluate(orderId => document.activeElement?.closest('tr')?.dataset.orderRow, id), id, 'focus returns to the table control');
    });
    await context.close();
  }
} finally {
  await browser.close();
}
console.log('page errors', JSON.stringify(errors));
console.log('FAILS', JSON.stringify(FAILS));
if (FAILS.length || errors.length) process.exitCode = 1;
