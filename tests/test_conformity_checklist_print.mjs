// LRU conformity package checklist print (#477): before the DAR signs, the DAR row says it is a review and not yet
// signed, so a review date cannot be read as a signature date; with nothing recorded it says so instead of printing
// "undefined"; after approval the row names the DAR approval and its signed date.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = process.env.FS_FIXTURES_DIR
  ? new URL('demo_publish.html', new URL(process.env.FS_FIXTURES_DIR.endsWith('/') ? process.env.FS_FIXTURES_DIR : `${process.env.FS_FIXTURES_DIR}/`, 'file:///')).href
  : new URL('./fixtures/demo_publish.html', import.meta.url).href;
const FAILS = [];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  const rows = await page.evaluate(() => {
    const o = state.orders.find(order => (order.conformity || []).length);
    if (!o) return null;
    const base = structuredClone(o.conformity[0]);
    const darRow = p => {
      const doc = new DOMParser().parseFromString(confCoverHtml(o, p), 'text/html');
      const row = [...doc.querySelectorAll('table')[0].querySelectorAll('tr')].find(tr => /^DAR/.test(tr.querySelector('th').textContent));
      return row ? [row.querySelector('th').textContent, row.querySelector('td').textContent] : null;
    };
    const signed = { ...base, darName: 'Sweep DAR', darDate: '2026-09-30', darApproval: { name: 'Sweep DAR', designation: 'DAR-F', date: '2026-10-01' } };
    const reviewed = { ...base, darName: 'Sweep DAR', darDate: '2026-09-30' }; delete reviewed.darApproval;
    const none = { ...base }; delete none.darApproval; delete none.darName; delete none.darDate;
    return { signed: darRow(signed), reviewed: darRow(reviewed), none: darRow(none) };
  });
  try {
    assert.ok(rows, 'the curated fixture holds a conformity package');
    assert.deepEqual(rows.signed, ['DAR approval', 'Sweep DAR (DAR-F) · signed 2026-10-01']);
    assert.deepEqual(rows.reviewed, ['DAR review (not yet signed)', 'Sweep DAR · reviewed 2026-09-30']);
    assert.deepEqual(rows.none, ['DAR review (not yet signed)', 'Not yet recorded']);
    for (const [, value] of Object.values(rows)) assert.doesNotMatch(value, /undefined|null|—/);
    console.log('PASS conformity checklist DAR row', JSON.stringify(rows));
  } catch (error) { FAILS.push(error.message); console.log('FAIL', error.message); }
  await context.close();
} finally { await browser.close(); }
if (errors.length) FAILS.push(`page errors: ${errors.join(' | ')}`);
console.log('FAILS', JSON.stringify(FAILS));
process.exit(FAILS.length ? 1 : 0);
