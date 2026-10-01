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
        assert.equal(await list.locator('table').isVisible(), false, 'the table is hidden below 700px');
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
          open: card.querySelector('.fr-wo-card-open')?.getBoundingClientRect().height,
          right: card.getBoundingClientRect().right
        })));
        for (const card of sample) {
          assert.match(card.id, /^WO-/, 'card shows the work order id');
          assert.ok(card.status && card.title && card.part, `${card.id} shows status, title and part number`);
          assert.deepEqual(card.fields.map(([label]) => label), ['Next step', 'Owner', 'Due'], `${card.id} shows next step, owner and due date`);
          assert.ok(card.fields.every(([, value]) => value), `${card.id} fills every field`);
          assert.ok(card.open >= 44, `${card.id} open button is at least 44px tall`);
          assert.ok(card.right <= size.width, `${card.id} card fits the screen`);
        }
        if (route === 'orders') assert.match(await cards.first().locator('.fr-wo-card-part').innerText(), / \/ Rev /, 'All work orders cards show part number and revision');
        const id = await cards.first().locator('.fr-wo-card-id').innerText();
        await cards.first().getByRole('button', { name: 'Open ' + id }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Open full work order' }).waitFor();
        await page.getByRole('button', { name: 'Close record details' }).click();
      });
    }
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
      const tap = await toggle.evaluate(el => el.getBoundingClientRect());
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
    await context.close();
  }
} finally {
  await browser.close();
}
console.log('page errors', JSON.stringify(errors));
console.log('FAILS', JSON.stringify(FAILS));
if (FAILS.length || errors.length) process.exitCode = 1;
