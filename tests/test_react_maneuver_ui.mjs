import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = process.env.FS_FIXTURES_DIR
  ? new URL('demo_qa150_publish.html', new URL(process.env.FS_FIXTURES_DIR.endsWith('/') ? process.env.FS_FIXTURES_DIR : `${process.env.FS_FIXTURES_DIR}/`, 'file:///')).href
  : new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'mnv-home'; render(); });
  await page.locator('.fr-maneuver').waitFor();
  assert.equal(await page.locator('.fr-mnv-metric').count(), 6);
  assert.equal(await page.locator('.fr-queue table thead th').count(), 6);
  const id = (await page.locator('.fr-queue tbody tr').first().locator('td strong').first().textContent()).trim();
  assert.ok(id, 'dashboard table is bound to a current Flight Maneuver record');
  await page.getByRole('button', { name: new RegExp(id) }).first().click();
  const dialog = page.locator('.fr-drawer[open]');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), new RegExp(id));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('FLIGHT') || document.activeElement?.classList?.contains('fr-record-link')), true);
  for (const [view, kind, heading] of [['mnv-intake', 'NC', 'NC Intake'], ['mnv-cars', 'CAR', 'Corrective Actions'], ['mnv-mrb', 'MRB', 'Material Review Board'], ['mnv-spr', 'SPR', 'Problem Reports']]) {
    await page.evaluate(value => { view = value; render(); }, view);
    await page.getByRole('heading', { name: `${heading}.` }).waitFor();
    assert.equal(await page.locator('.fr-maneuver .fr-queue tbody tr').count() > 0, true, `${heading} page renders current records`);
    assert.equal(await page.locator('[aria-label="Filter record type"]').inputValue(), kind);
    assert.ok((await page.locator('.fr-queue tbody tr .fr-record-link small').allTextContents()).every(text => text.startsWith(`${kind} · `)), `${heading} page filters to its record type`);
    if (view === 'mnv-cars') assert.equal(await page.locator('.fr-queue tbody tr').filter({ hasText: 'CAR-1001' }).getAttribute('class'), '', 'a closed past-due CAR is not shown as overdue');
  }
  await page.evaluate(() => { view = 'mnv-home'; render(); });
  await page.getByRole('heading', { name: 'Quality Hangar.' }).waitFor();
  const density = page.locator('.fr-density');
  await density.click();
  assert.equal(await density.getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('.fr-queue table').getAttribute('class') === 'fr-compact');
  const firstType = (await page.locator('.fr-queue tbody tr .fr-record-link small').first().textContent()).split(' · ')[0];
  await page.locator('[aria-label="Filter record type"]').selectOption(firstType);
  assert.ok(await page.locator('.fr-queue tbody tr').count() > 0);
  assert.ok((await page.locator('.fr-queue tbody tr .fr-record-link small').allTextContents()).every(text => text.startsWith(firstType + ' · ')));
  await page.locator('[aria-label="Filter record type"]').selectOption('All');
  await page.locator('[aria-label="Search Flight Maneuver records"]').fill(id);
  assert.equal(await page.locator('.fr-queue tbody tr').count(), 1);
  await page.locator('[aria-label="Search Flight Maneuver records"]').fill('record-that-does-not-exist');
  assert.equal(await page.locator('.fr-queue tbody tr').count(), 0);
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  // The full-page handoff below is specifically a CAR workflow. The Hangar's
  // mixed queue is due-date sorted, so its first record is not guaranteed to
  // be a CAR when fixtures or the current date change.
  await page.evaluate(() => { view = 'mnv-cars'; render(); });
  await page.getByRole('heading', { name: 'Corrective Actions.' }).waitFor();
  await page.locator('.fr-maneuver').waitFor();
  const carRow = page.locator('.fr-queue tbody tr').filter({ hasText: 'CAR-1001' });
  await carRow.waitFor();
  await carRow.locator('.fr-record-link').click();
  await page.locator('.fr-drawer[open]').waitFor();
  await page.getByRole('button', { name: 'Open full record' }).click({ force: true });
  await page.locator('body[data-view="mnv-car"]').waitFor();
  assert.equal(await page.locator('.flight-react').count(), 0, 'complex edits remain in the existing gated CAR workflow');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('React Flight Maneuver dashboard uses live records, supports search/filter/density, and provides an accessible record drawer.');
} finally { await browser.close(); }
