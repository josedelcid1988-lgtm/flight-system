import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.FS_CAPTURE_DIR || 'artifacts/design/baseline');
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(OUT)) if (/^page@.*\.webm$/.test(name)) fs.rmSync(path.join(OUT, name));

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } }
});
const page = await context.newPage();
const recording = page.video();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  await page.goto(new URL('../tests/fixtures/demo_qa150_publish.html', import.meta.url).href);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-username').fill('demo');
  await page.locator('#sk-password').fill('demo1234');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('#flight-react-island').waitFor({ state: 'visible' });
  if (await page.locator('#toast:not([hidden])').count()) await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'hangar-1440.png') });
  await page.getByRole('textbox', { name: 'Search work orders' }).focus();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'hangar-focus-1440.png') });
  if (await page.locator('.fr-hold-row').count()) {
    await page.locator('.fr-hold-row').first().click();
    await page.locator('.fr-drawer[open] .fr-hold-callout').waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, 'hangar-open-hold-1440.png') });
    await page.keyboard.press('Escape');
    await page.locator('.fr-drawer[open]').waitFor({ state: 'detached' });
  }

  await page.getByRole('button', { name: 'Compact' }).click();
  await page.locator('.fr-search input').fill('WO-');
  await page.locator('.fr-record-link').first().click();
  await page.locator('.fr-drawer[open]').waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'hangar-drawer-1440.png') });
  await page.keyboard.press('Escape');
  await page.locator('.fr-drawer[open]').waitFor({ state: 'detached' });
  await page.locator('.fr-record-link').first().click();
  await page.getByRole('button', { name: 'Open full work order' }).click();
  await page.locator('body[data-view="order"]').waitFor();
  await page.waitForTimeout(350);
  if (await page.locator('dialog[open]').count()) throw new Error('The record drawer stayed open after navigating to the full order.');
  await page.screenshot({ path: path.join(OUT, 'work-order-detail-1440.png') });
  await page.getByRole('button', { name: 'All work orders' }).click();
  await page.locator('.flight-progress .progress-helicopter').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  if (await page.locator('dialog[open]').count()) throw new Error('A modal stayed open on the work-order log.');
  await page.screenshot({ path: path.join(OUT, 'work-order-helicopter-1440.png') });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole('button', { name: 'Go to Hangar' }).click();
  await page.locator('#flight-react-island').waitFor({ state: 'visible' });
  await page.getByRole('textbox', { name: 'Search work orders' }).fill('');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'hangar-1920.png') });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(900);
  if (await page.locator('dialog[open]').count()) throw new Error('A dialog remained open in the tablet capture.');
  await page.screenshot({ path: path.join(OUT, 'hangar-768.png') });
  await page.evaluate(() => { view = 'plan'; render(); });
  await page.locator('.fr-plan').waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: 'Planned orders.' }).waitFor();
  const planDensity = page.locator('.fr-plan .fr-density');
  if (await planDensity.getAttribute('aria-pressed') === 'true') await planDensity.click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'flight-plan-1440.png') });
  await page.locator('.fr-equipment-setup summary').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'flight-plan-equipment-setup-1440.png') });
  await page.locator('.fr-equipment-setup summary').click();
  await planDensity.click();
  await page.getByRole('textbox', { name: 'Search planned orders' }).fill('PO-');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'flight-plan-search-compact-1440.png') });
  await page.getByRole('textbox', { name: 'Search planned orders' }).fill('');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { view = 'mnv-home'; render(); window.scrollTo(0, 0); });
  await page.locator('.fr-maneuver').waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'flight-maneuver-1440.png') });
  if (await page.locator('.fr-queue tbody tr').count()) {
    await page.locator('.fr-queue tbody tr .fr-record-link').first().click();
    await page.locator('.fr-drawer[open]').waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, 'flight-maneuver-record-drawer-1440.png') });
    await page.keyboard.press('Escape');
    await page.locator('.fr-drawer[open]').waitFor({ state: 'detached' });
  }
  for (const [view, file, heading] of [
    ['mnv-intake', 'flight-maneuver-nc-intake-1440.png', 'NC Intake.'],
    ['mnv-cars', 'flight-maneuver-corrective-actions-1440.png', 'Corrective Actions.'],
    ['mnv-mrb', 'flight-maneuver-mrb-1440.png', 'Material Review Board.'],
    ['mnv-spr', 'flight-maneuver-problem-reports-1440.png', 'Problem Reports.']
  ]) {
    await page.evaluate(nextView => { view = nextView; render(); window.scrollTo(0, 0); }, view);
    await page.getByRole('heading', { name: heading }).waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, file) });
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join(' | ')}`);
console.log(`Design captures written to ${path.relative(ROOT, OUT)}. Flight Plan, Flight Maneuver, and the protected work-order helicopter progress element rendered.`);
} finally {
  await context.close();
  await browser.close();
  const videoPath = await recording.path();
  const targetVideo = path.join(OUT, 'protected-helicopter-workflow.webm');
  if (fs.existsSync(targetVideo)) fs.rmSync(targetVideo);
  if (fs.existsSync(videoPath)) fs.renameSync(videoPath, targetVideo);
}
