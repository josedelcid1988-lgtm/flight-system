import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const saved = [];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'qa', displayName: 'QA Manager', salt: 'test', hash: 'unused', role: 'qm', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'qa');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => {
    window.__exportSettingsSaved = [];
    window.__exportRetries = [];
    window.skServer.active = true;
    window.skServer.api = (route, options = {}) => {
      if (route === '/record-exports/settings' && !options.method) return Promise.resolve({ ok: true, json: { recordTypes: ['work-order', 'fair', '8130-9', 'nc-idr', 'car', 'mrb', 'stamp', 'training', 'pfmea'], settings: [] } });
      if (route === '/record-exports/jobs' && !options.method) return Promise.resolve({ ok: true, json: { jobs: [{ id: 'JOB-ABCD', exportId: 'EXT-1', recordType: 'fair', recordId: 'FAIR-1', sha256: 'a'.repeat(64), status: 'failed', attempts: 3, lastError: 'HTTPS destination refused the export with 503' }] } });
      if (route === '/record-exports/jobs/JOB-ABCD/retry' && options.method === 'POST') { window.__exportRetries.push(route); return Promise.resolve({ ok: true, json: { id: 'JOB-ABCD', status: 'pending', exportId: 'EXT-1' } }); }
      if (route !== '/record-exports/settings' || options.method !== 'PUT') return Promise.resolve({ ok: false, json: { error: 'Unexpected export API call.' } });
      const setting = options.body;
      window.__exportSettingsSaved.push(setting);
      return Promise.resolve({ ok: true, json: { setting: { ...setting, updatedAt: new Date().toISOString(), updatedBy: 'qa' } } });
    };
    view = 'qms-config'; render();
  });
  const form = page.locator('.export-setting-form[data-export-setting="fair"]');
  await form.waitFor();
  await form.locator('[name=destinationKind]').selectOption('https');
  await form.locator('[name=enabled]').check();
  await form.locator('[name=destination]').fill('https://records.example.test/flight');
  await form.locator('[name=tokenSetting]').fill('FLIGHT_EXPORT_TOKEN');
  await form.locator('[name=namingPattern]').fill('{recordType}-{recordId}-{exportId}.json');
  await form.locator('[name=rationale]').fill('Route approved FAIR exports to the records gateway.');
  await form.getByRole('button', { name: 'Save fair export settings' }).click();
  await page.waitForFunction(() => document.querySelector('.export-setting-form[data-export-setting="fair"] .pill')?.textContent === 'Enabled');
  const savedSettings = await page.evaluate(() => window.__exportSettingsSaved);
  assert.equal(savedSettings.length, 1);
  assert.deepEqual({
    recordType: savedSettings[0].recordType,
    enabled: savedSettings[0].enabled,
    destinationKind: savedSettings[0].destinationKind,
    destination: savedSettings[0].destination,
    tokenSetting: savedSettings[0].tokenSetting,
    namingPattern: savedSettings[0].namingPattern,
  }, {
    recordType: 'fair', enabled: true, destinationKind: 'https', destination: 'https://records.example.test/flight', tokenSetting: 'FLIGHT_EXPORT_TOKEN', namingPattern: '{recordType}-{recordId}-{exportId}.json',
  });
  assert.doesNotMatch(JSON.stringify(savedSettings[0]), /secret-value|Bearer /i);
  const retry = page.locator('[data-export-retry="JOB-ABCD"]');
  await retry.waitFor();
  assert.match(await page.locator('.qms-config-page').innerText(), /destination refused the export with 503/);
  await retry.click();
  await page.waitForFunction(() => window.__exportRetries.length === 1);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('Record export settings UI saves an HTTPS destination, server token setting name, audit rationale, and naming pattern without exposing a token value.');
} finally {
  await browser.close();
}
