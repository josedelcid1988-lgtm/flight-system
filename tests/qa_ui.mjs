// Run after the Playwright setup in TESTING.md. Optional: CHROME_PATH=/path/to/chrome.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = process.env.FS_FIXTURES_DIR
    ? new URL('demo_qa150_publish.html', new URL(process.env.FS_FIXTURES_DIR.endsWith('/') ? process.env.FS_FIXTURES_DIR : process.env.FS_FIXTURES_DIR + '/', 'file:///')).href
    : new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
  await page.goto(process.env.FLIGHT_UI_URL || fixture);
  await page.waitForSelector('#sk-boot input[name=username]');
  await page.locator('#sk-boot input[name=username]').fill('demo');
  await page.locator('#sk-boot input[name=password]').fill('demo1234');
  await page.locator('#sk-boot form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => !document.getElementById('sk-boot'));
  assert.equal(await page.evaluate(() => MES.validate(state)), true);
  // The approved React Hangar is the production home surface.
  await page.locator('#main .flight-react').waitFor();
  await page.getByRole('heading', { name: 'Hangar.' }).waitFor();
  await page.getByRole('heading', { name: 'Work orders' }).waitFor();
  assert.ok(await page.locator('.fr-table-scroll tbody tr').count() > 0);
  // Flight Plan uses the same bundled React table controls while retaining FlightPlan commands.
  await page.evaluate(() => { view = 'plan'; render(); });
  await page.getByRole('heading', { name: 'Planned orders.' }).waitFor();
  assert.ok(await page.locator('.fr-plan .fr-table-scroll tbody tr').count() > 0);
  assert.equal(await page.getByRole('heading', { name: 'Work-center dispatch' }).count(), 1);
  assert.equal(await page.locator('.fr-dispatch-controls select[aria-label="Work center"] option').count(), 12);
  await page.getByRole('heading', { name: 'Projects and milestones' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'New WBS project' }).count(), 1);
  await page.getByText(/hours scheduled/).waitFor();
  await page.getByRole('button', { name: 'Compact' }).click();
  assert.equal(await page.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed'), 'true');
  const plannedSearch = page.getByRole('textbox', { name: 'Search planned orders' });
  const planId = (await page.locator('.fr-plan tbody tr').first().locator('td').first().innerText()).split('\n')[0];
  await plannedSearch.fill(planId);
  assert.equal(await page.locator('.fr-plan tbody tr').count(), 1);
  await page.getByRole('combobox', { name: 'Planned order status' }).selectOption('All');
  await page.getByRole('button', { name: 'Comfortable' }).click();
  await page.evaluate(() => { view = 'home'; render(); });
  await page.getByRole('button', { name: 'Compact' }).click();
  assert.equal(await page.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Comfortable' }).click();
  const firstOrder = page.locator('.fr-table-scroll tbody tr').first();
  const firstOrderId = (await firstOrder.locator('small').first().innerText()).split(' · ')[0];
  await firstOrder.locator('.fr-record-link').click();
  await page.getByRole('dialog').getByRole('heading').waitFor();
  await page.getByRole('button', { name: 'Close record details' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Open ' + firstOrderId }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open full work order' }).click();
  await page.waitForFunction(() => view === 'order');
  await page.evaluate(() => { view = 'home'; render(); });
  await page.setViewportSize({ width: 390, height: 844 });
  const search = page.getByRole('textbox', { name: 'Search work orders' });
  await page.keyboard.press('Control+k');
  assert.equal(await search.evaluate(el => el === document.activeElement), true);
  await search.fill('no matching work order');
  await page.getByText('No work orders match the current search and filter.').waitFor();
  await search.fill('');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.fr-page-heading h1').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.evaluate(() => {
    const probe = document.createElement('div'); probe.id = 'flight-motion-check'; probe.className = 'flight-progress';
    probe.innerHTML = '<span class="progress-helicopter" aria-hidden="true"></span>'; document.body.append(probe);
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const helicopter = page.locator('#flight-motion-check .progress-helicopter');
  assert.equal(await helicopter.evaluate(el => getComputedStyle(el).display), 'block');
  assert.equal(await helicopter.evaluate(el => getComputedStyle(el).animationName), 'aog-hover');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await helicopter.evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.evaluate(() => document.getElementById('flight-motion-check').remove());
  let bridgePayload = null;
  await page.route('https://flight-bridge.test/netsuite/assembly-build', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': 'null', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
      return;
    }
    bridgePayload = route.request().postDataJSON();
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': 'null', 'access-control-allow-credentials': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ reference: 'IA-TEST-82' }) });
  });
  const bridgeResult = await page.evaluate(async () => {
    const stocked = state.orders.find(item => item.inventory && item.inventory.lotNumber);
    if (!stocked) throw new Error('QA fixture has no stocked order for NetSuite bridge posting coverage.');
    window.SK_INTEGRATIONS.mode = 'mcp'; window.SK_INTEGRATIONS.endpoint = 'https://flight-bridge.test';
    return window.skIntegrations.netsuite.postAssemblyBuild(stocked.id);
  });
  assert.equal(bridgeResult.ok, true);
  assert.ok(bridgePayload.csv.includes(bridgePayload.inventory.lotNumber), 'NetSuite bridge receives a CSV built from the work order, including its lot');
  assert.equal(bridgePayload.orderId.length > 0, true);
  assert.deepEqual(errors, []);
  console.log('UI checks passed: React Hangar and Flight Plan, project planning controls, NetSuite assembly build bridge payload, work-center dispatch and capacity, queue search and density, plan filters, record drawer, native order handoff, mobile overflow and reduced motion.');
} finally {
  await browser.close();
}
