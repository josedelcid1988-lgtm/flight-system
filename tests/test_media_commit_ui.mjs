import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// mediaCommit is the atomic commit used by evidence, discussion and profile changes. Like save(), it must refuse an
// invalid workspace before anything reaches browser storage, the shared server or the mirror.
const KEY = 'skyryse-mes-work-order-v1';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('./fixtures/publish.html', import.meta.url).href);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('QA Administrator');
  await page.locator('#sk-username').fill('qa-admin');
  await page.locator('#sk-password').fill('qa-admin-pass');
  await page.locator('#sk-confirm').fill('qa-admin-pass');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });

  const refused = await page.evaluate(key => {
    const stored = localStorage.getItem(key), live = JSON.stringify(state);
    const next = structuredClone(state);
    next.masterWIs.find(wi => wi.revision === 'A').operations[0].steps[0].title = '';
    let message = null;
    try { mediaCommit(next); } catch (error) { message = error.message; }
    return { message, storageUnchanged: localStorage.getItem(key) === stored, liveUnchanged: JSON.stringify(state) === live };
  }, KEY);
  assert.match(refused.message || '', /^Change not saved: it would leave this workspace in an invalid state/, 'an invalid workspace is refused with a plain reason');
  assert.equal(refused.storageUnchanged, true, 'nothing is written to browser storage');
  assert.equal(refused.liveUnchanged, true, 'the live workspace is unchanged');

  const accepted = await page.evaluate(key => {
    const next = structuredClone(state);
    next.masterWIs.find(wi => wi.revision === 'A').title = 'Retitled by the media commit test';
    mediaCommit(next);
    return { stored: JSON.parse(localStorage.getItem(key)).masterWIs.find(wi => wi.revision === 'A').title, live: state.masterWIs.find(wi => wi.revision === 'A').title };
  }, KEY);
  assert.equal(JSON.stringify(accepted), JSON.stringify({ stored: 'Retitled by the media commit test', live: 'Retitled by the media commit test' }), 'a valid workspace is committed to storage and becomes live');
  assert.deepEqual(errors, []);
  console.log('media commit UI: invalid workspaces are refused before storage; valid ones commit');
} finally {
  await browser.close();
}
