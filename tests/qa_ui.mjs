// Run after the Playwright setup in TESTING.md. Optional: CHROME_PATH=/path/to/chrome.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.FLIGHT_UI_URL || new URL('../index.html', import.meta.url).href);
  await page.waitForSelector('#sk-boot input[name=username]');
  await page.evaluate(() => {
    const form = document.querySelector('#sk-boot form');
    for (const [name, value] of Object.entries({ username: 'ui-check', password: 'UiCheck2026!', confirm: 'UiCheck2026!', displayName: 'UI Check' })) {
      const input = form.elements.namedItem(name);
      if (input) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    form.requestSubmit();
  });
  await page.waitForFunction(() => !document.getElementById('sk-boot'));
  assert.equal(await page.evaluate(() => MES.validate(state)), true);
  await page.getByRole('button', { name: 'Next aircraft photograph' }).click();
  await page.getByRole('button', { name: 'Next aircraft photograph' }).click();
  await page.waitForFunction(() => {
    const img = document.querySelector('.fs-photo img');
    return img.complete && img.naturalWidth > 0 && img.src.startsWith('data:image/jpeg');
  });
  await page.locator('.fs-glossary summary').click();
  await page.getByText('Material requirements planning', { exact: true }).waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Close navigation' }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fs-menu-toggle').getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'Search records' }).click();
  assert.equal(await page.locator('#global-search').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.fs-photo img').evaluate(el => getComputedStyle(el).animationName), 'none');
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
  const recent = await page.evaluate(() => {
    const wi = state.masterWIs[0];
    // Existing WI rendering initializes change-request metadata on first visit.
    selectedWI = { id: wi.id, revision: wi.revision }; view = 'wi'; render();
    view = 'home'; render(); save();
    const before = JSON.stringify(state);
    selectedWI = { id: wi.id, revision: wi.revision }; view = 'wi'; render();
    view = 'home'; render();
    return { unchanged: before === JSON.stringify(state), id: wi.id, revision: wi.revision, key: 'flight-system-recent-v1:' + location.pathname + ':' + encodeURIComponent(skAuth.user().username) };
  });
  assert.equal(recent.unchanged, true);
  await page.reload();
  await page.waitForSelector('[data-fs-resume]');
  const beforeResume = await page.evaluate(() => JSON.stringify(state));
  await page.locator('[data-fs-resume]').first().click();
  assert.deepEqual(await page.evaluate(() => ({ view, ...selectedWI })), { view: 'wi', id: recent.id, revision: recent.revision });
  assert.equal(await page.evaluate(() => JSON.stringify(state)), beforeResume);
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify([{ view: 'order', id: 'missing-record', at: Date.now() }]));
    view = 'home'; render();
  }, recent.key);
  assert.equal(await page.locator('[data-fs-resume]').count(), 0);
  await page.evaluate(key => { localStorage.setItem(key, '{broken'); render(); }, recent.key);
  assert.equal(await page.locator('[data-fs-resume]').count(), 0);
  await page.evaluate(() => { view = 'orders'; render(); view = 'home'; render(); });
  await page.locator('[data-fs-recent-clear]').click();
  assert.equal(await page.locator('[data-fs-resume]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('UI checks passed: photographs, glossary, mobile controls, reduced motion, resume after reload, missing/corrupt recent records, clear history, unchanged valid state.');
} finally {
  await browser.close();
}
