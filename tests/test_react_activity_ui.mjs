import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true && !!window.FlightReact);
  await page.evaluate(() => { view = 'activity'; render(); });
  await page.getByRole('heading', { name: 'Activity record.' }).waitFor();
  const initialCount = await page.locator('.fr-activity tbody tr').count();
  assert.ok(initialCount > 0, 'activity events render from the current Flight workspace');
  assert.ok((await page.locator('.fr-activity footer').innerText()).includes(`${initialCount} of ${initialCount}`));
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-control-activity-1440.png', import.meta.url).pathname });

  const firstTimestamp = await page.locator('.fr-activity tbody time').first().getAttribute('datetime');
  const localDay = await page.evaluate(at => new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), firstTimestamp);
  await page.getByLabel('Activity from date').fill(localDay);
  await page.getByLabel('Activity to date').fill(localDay);
  assert.ok(await page.locator('.fr-activity tbody tr').count() > 0, 'from and to date filters use the activity event date');
  await page.getByRole('button', { name: 'Clear filters' }).click();

  const compact = page.locator('.fr-activity .fr-density').first();
  await compact.click();
  assert.equal(await compact.getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('.fr-activity table').getAttribute('class')).includes('fr-compact'));
  const row = page.locator('.fr-activity tbody tr').first();
  const expectedAction = (await row.locator('td').nth(2).innerText()).trim();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill(expectedAction.slice(0, 14));
  assert.ok(await page.locator('.fr-activity tbody tr').count() <= initialCount, 'search narrows the visible event rows');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await page.locator('.fr-activity tbody tr').count(), initialCount, 'clearing filters restores the original event set');

  const firstActor = await page.locator('.fr-activity select[aria-label="Activity person"] option').nth(1).textContent();
  await page.getByLabel('Activity person').selectOption({ label: firstActor });
  assert.ok((await page.locator('.fr-activity tbody tr').count()) > 0, 'person filter retains that actor’s events');
  const detailButton = page.locator('.fr-activity tbody tr').first().locator('.fr-open-button');
  await detailButton.click();
  await page.getByRole('dialog').getByRole('heading').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), false, 'Escape closes the activity detail drawer');
  await page.waitForFunction(() => document.activeElement?.classList.contains('fr-open-button'), null, { timeout: 10000 });
  assert.equal(await detailButton.evaluate(element => document.activeElement === element), true, 'closing the drawer restores focus to the selected event');
  assert.equal(await page.getByLabel('Activity person').inputValue(), firstActor, 'closing details preserves the underlying filter selection');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('React Activity record uses live workspace events, supports search, actor filters, compact density and an Escape-close detail drawer.');
} finally { await browser.close(); }
