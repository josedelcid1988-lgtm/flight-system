import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'trace'; traceQuery = ''; render(); });
  await page.getByRole('heading', { name: 'Traceability.' }).waitFor();
  const search = page.getByRole('textbox', { name: 'Traceability search' });
  await search.fill('FC-200-00001');
  await search.press('Enter');
  await page.locator('.fr-trace-summary').waitFor();
  assert.match(await page.locator('.fr-trace-summary').innerText(), /Serial number · FC-200-00001/);
  assert.ok((await page.locator('.fr-trace-section[aria-label="Work orders"]').innerText()).includes('WO-10001'), 'work-order results come from the MES trace engine');
  await page.locator('.fr-trace-report').waitFor();
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-control-trace-1440.png', import.meta.url).pathname });
  await page.locator('.fr-trace-report').click({ force: true });
  await page.locator('body[data-view="trace-report"]').waitFor();
  await page.getByRole('button', { name: 'Back to search' }).click({ force: true });
  await page.getByRole('heading', { name: 'Traceability.' }).waitFor();
  await search.fill('LOT-260917-0001');
  await search.press('Enter');
  assert.match(await page.locator('.fr-trace-summary').innerText(), /Lot number · LOT-260917-0001/);
  assert.ok((await page.locator('.fr-trace-alert').innerText()).includes('FC-200-00002'), 'lot results expose the associated serial links');
  const compact = page.locator('.fr-trace .fr-density');
  await compact.click();
  assert.equal(await compact.getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('.fr-trace-section table').first().getAttribute('class')).includes('fr-compact'));
  await page.locator('.fr-trace-section[aria-label="Work orders"] .fr-text-action').first().click({ force: true });
  await page.locator('body[data-view="order"]').waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  console.log('React Flight Control traceability uses MES results, supports serial/lot search, density, full reports and existing work-order routes.');
} finally { await browser.close(); }
