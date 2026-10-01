import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/publish.html', import.meta.url));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await touch.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await touch.newPage();
  await page.goto(`file://${fileURLToPath(new URL('./fixtures/demo_qa150_publish.html', import.meta.url))}`);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => {
    const label = document.createElement('label');
    label.textContent = 'Sample size';
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: '2', max: '4', step: '1', value: '3', id: 'floor-picker-sample' });
    label.append(input);
    document.body.append(label);
    window.pickerEvents = { input: 0, change: 0 };
    input.addEventListener('input', () => window.pickerEvents.input++);
    input.addEventListener('change', () => window.pickerEvents.change++);
  });
  const input = page.locator('#floor-picker-sample');
  const picker = page.locator('.fs-floor-picker');
  await picker.waitFor();
  assert.equal(await picker.getAttribute('role'), 'group');
  assert.match(await picker.getAttribute('aria-label'), /Sample size, bounded whole-number picker/);
  await picker.getByRole('button', { name: 'Increase Sample size' }).click();
  assert.equal(await input.inputValue(), '4');
  await picker.getByRole('button', { name: 'Increase Sample size' }).click();
  assert.equal(await input.inputValue(), '4', 'upper bound is enforced');
  await picker.getByRole('button', { name: 'Decrease Sample size' }).click();
  assert.equal(await input.inputValue(), '3');
  await picker.getByRole('button', { name: 'Decrease Sample size' }).click();
  await picker.getByRole('button', { name: 'Decrease Sample size' }).click();
  assert.equal(await input.inputValue(), '2', 'lower bound is enforced');
  await input.fill('3');
  await page.evaluate(() => {
    const input = document.querySelector('#floor-picker-sample');
    input.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientY: 100, bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientY: 55, bubbles: true }));
  });
  assert.equal(await input.inputValue(), '4', 'upward touch swipe advances the bounded value');
  assert.deepEqual(await page.evaluate(() => window.pickerEvents), { input: 5, change: 4 });
  await touch.close();

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(`file://${fixture}`);
  await desktopPage.locator('body').waitFor();
  await desktopPage.evaluate(() => {
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: '1', max: '10', step: '1', value: '5' });
    document.body.append(input);
  });
  await desktopPage.waitForTimeout(80);
  assert.equal(await desktopPage.locator('.fs-floor-picker').count(), 0, 'desktop pointer keeps its native number input');
  await desktop.close();
  console.log('Floor picker enhances bounded integer inputs on touch, clamps both bounds and preserves form events; desktop inputs stay native.');
} finally { await browser.close(); }
