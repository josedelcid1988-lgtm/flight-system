import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'orders'; render(); });
  await page.getByRole('heading', { name: 'All work orders.' }).waitFor();
  const rows = page.locator('.fr-order-table tbody tr');
  assert.ok(await rows.count() > 0, 'the React queue renders current Flight System work orders');
  assert.equal(await page.locator('.fr-order-table thead th').count(), 8, 'the structured work-order table retains all eight operational columns');
  assert.match((await page.locator('.fr-order-table tbody tr').first().locator('td time[datetime]').first().innerText()).trim(), /^[A-Za-z]+ \d{1,2}, \d{4}$/, 'record dates use Month Day, Year formatting');
  assert.ok(await page.locator('.fr-order-table .flight-progress .progress-helicopter').count() > 0, 'the protected floating helicopter remains in lifecycle progress');
  assert.equal(await page.evaluate(() => {
    const row = document.querySelector('.fr-order-table tbody tr'), order = state.orders.find(item => item.id === row?.dataset.orderRow);
    if (!order) return false;
    const held = MES.blockingTickets(order).length > 0 || !!MES.engineeringChange(order), expected = document.createElement('div');
    expected.innerHTML = flightProgress(order, held);
    return expected.firstElementChild.outerHTML === row.querySelector('.flight-progress')?.outerHTML;
  }), true, 'the React table preserves the existing helicopter progress markup and binding exactly');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-control-orders-1440.png', import.meta.url).pathname });

  const id = (await rows.first().locator('td').first().innerText()).trim().split('\n')[0];
  await page.locator('[aria-label="Search work orders"]').fill(id);
  assert.equal(await rows.count(), 1, 'search filters the live work-order records');
  const compact = page.locator('.fr-order-page .fr-density');
  await compact.click();
  assert.equal(await compact.getAttribute('aria-pressed'), 'true', 'compact density can be selected');
  assert.ok((await page.locator('.fr-order-table').getAttribute('class')).includes('fr-compact'));
  await rows.first().locator('.fr-record-link').click();
  const drawer = page.locator('.fr-drawer[open]');
  await drawer.waitFor();
  assert.match(await drawer.innerText(), new RegExp(id));
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await rows.count(), 1, 'closing the drawer preserves the queue filter and selection context');
  await page.locator('.fr-order-page .fr-density').click();
  await rows.first().locator('.fr-record-link').click();
  await drawer.waitFor();
  await drawer.getByRole('button', { name: 'Open full work order' }).click({ force: true });
  await page.locator('body[data-view="order"]').waitFor();
  assert.equal(await page.locator('.flight-react').count(), 0, 'complex work-order execution remains in the established full-page workflow');

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.evaluate(() => { view = 'orders'; search = ''; render(); });
  await page.getByRole('heading', { name: 'All work orders.' }).waitFor();
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-control-orders-tablet.png', import.meta.url).pathname });
  assert.equal(await page.locator('.fr-order-page .fr-table-scroll').evaluate(wrapper => wrapper.scrollWidth > wrapper.clientWidth), true, 'the structured table retains its columns in a horizontally scrollable tablet layout');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('React Flight Control work-order queue renders live records, preserves helicopter progress, supports filters, density, drawer and full-page execution.');
} finally { await browser.close(); }
