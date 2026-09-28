// Flight Plan exposes the guarded iCal file connector and imports external events as busy time.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const TESTS = new URL('.', import.meta.url);
const fixtures = process.env.FS_FIXTURES_DIR || new URL('./fixtures/', TESTS).pathname;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(`${fixtures.replace(/\/?$/, '/') }demo_qa150_publish.html`).href);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const username = document.querySelector('#sk-boot input[name=username]');
    const form = username.closest('form');
    for (const [element, value] of [[username, 'master'], [form.querySelector('input[type=password]'), 'demo1234']]) {
      element.value = value; element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(2700);

  await page.evaluate(() => { document.querySelectorAll('.mnv-landing').forEach(item => item.remove()); view = 'plan'; render(); });
  assert.equal(await page.locator('[data-action="cal-toggle"]').count(), 1, 'QA Manager sees iCal setting control');
  assert.equal(await page.locator('[data-cal-import]').count(), 0, 'iCal file import stays hidden while disabled');
  await page.locator('[data-action="cal-toggle"]').click();
  await page.waitForFunction(() => state.planner.calendar.connectors.ical === true);
  assert.equal(await page.locator('[data-cal-import]').count(), 1, 'enabling iCal shows the import control');
  const date = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await page.evaluate(date => {
    const plan = MES.createBigThreePlan(state, date);
    if (!plan.ok) throw new Error(plan.message);
    const proposed = MES.proposeBigThreeTimeBlock(state, date, 0, '13:00', '14:00', 'QA calendar export flow');
    if (!proposed.ok) throw new Error(proposed.message);
    const accepted = MES.decideBigThreeTimeBlock(state, proposed.id, 'accept');
    if (!accepted.ok) throw new Error(accepted.message);
    save(); render();
  }, date);
  const event = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:external-ui-check\r\nDTSTART:${date.replaceAll('-', '')}T143000\r\nDTEND:${date.replaceAll('-', '')}T144500\r\nSUMMARY:External calendar hold\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  await page.locator('[data-cal-import]').setInputFiles({ name: 'external.ics', mimeType: 'text/calendar', buffer: Buffer.from(event) });
  await page.waitForFunction(() => state.planner.calendar.blocks.some(item => item.status === 'Busy' && item.source === 'ical:external-ui-check'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="cal-export"]').click()]);
  assert.equal(download.suggestedFilename(), 'flight-plan.ics');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log('calendar UI: gated enable, iCal import to busy time, accepted-block export and no browser errors passed');
} finally {
  await context.close(); await browser.close();
}
