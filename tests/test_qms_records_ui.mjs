import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'qa', displayName: 'Quinn Manager', salt: 'test', hash: 'unused', role: 'qm', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'qa');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'qms-records'; render(); });
  assert.equal(await page.getByRole('heading', { name: 'System QMS records' }).count(), 1);

  await page.locator('[data-qms-record="audit"] [name=scope]').fill('Internal process audit');
  await page.locator('[data-qms-record="audit"] [name=findings]').fill('Record sample was short.');
  await page.locator('[data-qms-record="audit"] button[type=submit]').click();
  await page.getByText('AUD-0001 · Internal process audit').waitFor();

  await page.locator('[data-qms-record="certification"] [name=statement]').fill('Process audit complete for this period.');
  await page.locator('[data-qms-record="certification"] button[type=submit]').click();
  await page.getByText(/CERT-0001 · Process audit complete/).waitFor();
  await page.locator('[data-qms-record="supplier"] [name=supplier]').fill('North Rivet');
  await page.locator('[data-qms-record="supplier"] button[type=submit]').click();
  await page.getByText(/SAP-0001 · North Rivet · Approved/).waitFor();

  await page.locator('[data-qms-record="quality-value"] [name=value]').fill('12.5');
  await page.locator('[data-qms-record="quality-value"] [name=name]').fill('caliper study');
  await page.locator('[data-qms-record="quality-value"] button[type=submit]').click();
  await page.locator('[data-qms-record="quality-verdict"] [name=valueId]').selectOption('QV-0001');
  await page.locator('[data-qms-record="quality-verdict"] [name=verdict]').fill('Acceptable');
  await page.locator('[data-qms-record="quality-verdict"] button[type=submit]').click();
  await page.getByText(/QVD-0001 · gage 12.5 · Acceptable/).waitFor();
  assert.equal(await page.evaluate(() => MES.validate(state) && MES.verifyManifests(state).ok), true);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('System QMS page opens an audit, signs certification and supplier approval records, and stores computed values with signed verdicts.');
} finally {
  await browser.close();
}
