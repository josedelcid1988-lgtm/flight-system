import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);

  await page.evaluate(() => { view = 'plan-kanban'; render(); });
  await page.getByRole('heading', { name: 'Kanban.' }).waitFor();
  assert.equal(await page.locator('.fr-plan-lane').count(), 4, 'React Kanban renders all live planned-order stages');
  const stageCounts = await page.locator('.fr-plan-lane .fr-count').allTextContents();
  const expectedCounts = await page.evaluate(() => {
    const all = FlightPlan.list(state), covered = item => !item.netsuite || item.netsuite.onHand >= item.quantity;
    return [all.filter(item => item.status === 'Planned'), all.filter(item => item.status === 'Firm' && !covered(item)), all.filter(item => item.status === 'Firm' && covered(item)), all.filter(item => item.status === 'Converted')].map(rows => String(rows.length).padStart(2, '0'));
  });
  assert.deepEqual(stageCounts, expectedCounts, 'Kanban lane counts are derived from the current FlightPlan records');
  assert.equal(await page.locator('.fr-plan-card').count(), expectedCounts.reduce((sum, count) => sum + Number(count), 0));
  await page.waitForFunction(() => [...document.getAnimations()].filter(animation => animation.effect?.target?.id === 'flight-react-island').every(animation => animation.playState === 'finished'));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-plan-kanban-1440.png', import.meta.url).pathname });
  const density = page.locator('.fr-kanban-page .fr-density');
  await density.click();
  assert.equal(await density.getAttribute('aria-pressed'), 'true', 'Kanban density toggle is interactive');
  assert.ok((await page.locator('.fr-plan-lanes').getAttribute('class')).includes('is-compact'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('.fr-plan-card').first().evaluate(element => parseFloat(getComputedStyle(element).transitionDuration) < 0.001), 'Kanban honors reduced-motion preferences');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const firstPlanId = await page.locator('.fr-plan-card .fr-mono').first().textContent();
  await page.locator('.fr-plan-card [data-action="plan-open"]').first().click();
  await page.getByRole('heading', { name: 'Planned orders.' }).waitFor();
  assert.equal(await page.locator('[aria-label="Search planned orders"]').inputValue(), firstPlanId.trim(), 'Kanban detail action opens the existing filtered planning workflow');
  await page.evaluate(() => { view = 'plan-kanban'; render(); });
  await page.getByRole('heading', { name: 'Kanban.' }).waitFor();
  await page.locator('.fr-planning-nav').getByRole('button', { name: 'MRP forecast' }).click();
  await page.getByRole('heading', { name: 'MRP forecast.' }).waitFor();
  const counts = await page.evaluate(() => {
    const f = FlightPlan.forecast(state);
    return [f.open.length, f.explosion.length, f.shelfLife.length, f.designChanges.length];
  });
  const summary = await page.locator('.fr-forecast-summary strong').allTextContents();
  assert.deepEqual(summary.map(Number), counts, 'MRP summary values match the live forecast engine');
  await page.waitForFunction(() => [...document.getAnimations()].filter(animation => animation.effect?.target?.id === 'flight-react-island').every(animation => animation.playState === 'finished'));
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-plan-mrp-forecast-1440.png', import.meta.url).pathname });
  for (const heading of ['Component demand', 'Lead time from actuals', 'First Production FAIR', 'Shelf life', 'Design changes']) {
    await page.getByRole('heading', { name: heading }).waitFor();
    assert.ok(await page.locator('.fr-forecast-section').filter({ has: page.getByRole('heading', { name: heading }) }).count());
  }
  assert.ok(await page.locator('.fr-forecast-section table').count() >= 1, 'the forecast retains structured comparison tables');
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: new URL('../artifacts/design/final/flight-plan-mrp-forecast-tablet.png', import.meta.url).pathname });
  await page.locator('.fr-planning-nav').getByRole('button', { name: 'Kanban', exact: true }).click();
  await page.getByRole('heading', { name: 'Kanban.' }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  console.log('React Flight Plan Kanban and MRP forecast render live records, expose density and retain structured planning views.');
} finally { await browser.close(); }
