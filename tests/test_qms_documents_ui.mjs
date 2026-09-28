import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [
      { username: 'qa', displayName: 'Quinn Manager', salt: 'test', hash: 'unused', role: 'qm', createdAt: new Date().toISOString() },
      { username: 'reviewer', displayName: 'Riley Reviewer', salt: 'test', hash: 'unused', role: 'qe', createdAt: new Date().toISOString() },
      { username: 'releaser', displayName: 'Morgan Releaser', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }
    ] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'qa');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'qms-records'; render(); });
  await page.getByRole('heading', { name: 'Controlled documents' }).waitFor();
  await page.locator('[data-controlled-document="create"] [name=documentNumber]').fill('SOP-750-001');
  await page.locator('[data-controlled-document="create"] [name=title]').fill('Document Control');
  await page.locator('[data-controlled-document="create"] [name=kind]').selectOption('SOP');
  await page.locator('[data-controlled-document="create"] [name=file]').setInputFiles({ name: 'control.pdf', mimeType: 'application/pdf', buffer: Buffer.from([0, 1, 2, 127, 128, 254, 255]) });
  await page.locator('[data-controlled-document="create"] button[type=submit]').click();
  await page.getByRole('heading', { name: 'SOP-750-001 · Document Control · Rev A' }).waitFor();
  assert.equal(await page.evaluate(() => MES.validate(state) && MES.verifyManifests(state).ok), true);

  await page.locator('[data-controlled-doc-review="QDOC-0001"]').click();
  await page.getByText('The document author cannot review their own document.').waitFor();
  assert.equal(await page.locator('.qms-record-card .pill').first().textContent(), 'Draft');
  const switchAccount = username => page.evaluate(user => {
    sessionStorage.setItem('skyryse-mes-session-v1', user);
    window.dispatchEvent(new Event('sk-auth'));
    view = 'qms-records';
    render();
  }, username);
  await switchAccount('reviewer');
  await page.locator('[data-controlled-doc-review="QDOC-0001"]').click();
  await page.getByText('SOP-750-001 Rev A reviewed by Riley Reviewer.').waitFor();
  await page.locator('[data-controlled-doc-release="QDOC-0001"]').click();
  await page.getByText('The releaser must be a third person, different from the author and reviewer.').waitFor();
  await switchAccount('releaser');
  await page.locator('[data-controlled-doc-release="QDOC-0001"]').click();
  await page.getByText('SOP-750-001 Rev A released by Morgan Releaser.').waitFor();
  const download = page.waitForEvent('download');
  await page.locator('[data-controlled-doc-download="QDOC-0001"]').click();
  assert.equal((await download).suggestedFilename(), 'control.pdf');
  assert.equal(await page.evaluate(() => MES.validate(state) && MES.verifyManifests(state).ok), true);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('Controlled document UI stores an attachment, enforces three-person review and release, and downloads only the hash-verified copy.');
} finally {
  await browser.close();
}
