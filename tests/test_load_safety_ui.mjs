import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const state = host.MES.ensureMasterWIs(host.MES.seed());
host.FlightManeuver.ensure(state);
const wi = state.masterWIs.find(item => item.revision === 'A');
wi.operations[0].steps[0].title = '';
const savedCopy = JSON.stringify(state);
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => { throw error; });
  await page.goto(new URL('./fixtures/publish.html', import.meta.url).href);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('QA Administrator');
  await page.locator('#sk-username').fill('qa-admin');
  await page.locator('#sk-password').fill('qa-admin-pass');
  await page.locator('#sk-confirm').fill('qa-admin-pass');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await page.evaluate(raw => localStorage.setItem('skyryse-mes-work-order-v1', raw), savedCopy);
  await page.reload();
  await page.locator('.storage-failure h1').waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await page.locator('.storage-failure').innerText(), /MWI-\d{4} Rev A is malformed at field operations\[0\]\.steps\[0\]\.title/);
  assert.equal(await page.locator('#flight-react-island').count(), 0, 'the app does not mount the working interface on damaged records');
  assert.equal(await page.evaluate(() => localStorage.getItem('skyryse-mes-work-order-v1')), savedCopy, 'loading leaves the stored bytes unchanged');
  console.log('load safety UI: damaged master WI shows its revision and field, blocks the app, and preserves storage');
} finally {
  await browser.close();
}
