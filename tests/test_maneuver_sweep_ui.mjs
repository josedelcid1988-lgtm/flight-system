// Flight Maneuver sweep (#460, #461), driven in Chromium against the demo fixture.
// #460: Raise NC outside a work order shows "Escaped from" once the escape answer is Yes, hides it again on No,
//       and the NC records the control point that was chosen, not the default.
// #461: the React Problem reports drawer reaches Record Jira key and Close from Jira through the same page
//       actions as the legacy table, and shows each only to a role that may use it.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixture = process.env.FS_FIXTURES_DIR
  ? new URL('demo_qa150_publish.html', new URL(process.env.FS_FIXTURES_DIR.endsWith('/') ? process.env.FS_FIXTURES_DIR : `${process.env.FS_FIXTURES_DIR}/`, 'file:///')).href
  : new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const FAILS = [];
let page = null;
const check = async (name, fn) => {
  try { await fn(); console.log('PASS', name); } catch (error) { FAILS.push(`${name}: ${error.message.split('\n')[0]}`); console.log('FAIL', name, error.message.split('\n')[0]); }
  finally { if (page) await page.evaluate(() => { try { $('#dialog').close(); } catch {} document.querySelectorAll('dialog[open]').forEach(d => d.close()); }).catch(() => {}); }
};
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  const raiseSpr = title => page.evaluate(title => {
    const r = window.FlightManeuver.raiseSPR(state, { title, partNumber: 'PN-SWEEP-461', foundAt: window.FlightManeuver.SPR_FOUND_AT[0], description: 'Raised by the Flight Maneuver sweep test.', occurred: window.MES.siteToday() });
    if (r.ok) save();
    return r.ok ? r.id : `refused: ${r.message}`;
  }, title);
  const openDrawer = async id => {
    await page.evaluate(() => { view = 'mnv-spr'; render(); });
    await page.getByRole('heading', { name: 'Problem reports.' }).waitFor();
    await page.locator('[aria-label="Search Flight Maneuver records"]').fill(id);
    await page.locator('.fr-queue tbody tr .fr-record-link').first().click();
    const drawer = page.locator('.fr-drawer[open]');
    await drawer.waitFor();
    return drawer;
  };

  await check('#460 Escaped from appears on Yes, hides on No, and the chosen control point is recorded', async () => {
    await page.evaluate(() => { view = 'mnv-intake'; render(); });
    await page.locator('[data-action="mnv-nc-new"]').first().click();
    const form = page.locator('#mnv-nc-form');
    await form.waitFor();
    const from = form.locator('#mnv-nc-from');
    assert.equal(await from.isVisible(), false, 'Escaped from is hidden while the answer is No');
    await form.locator('input[name="escaped"][value="yes"]').check();
    assert.equal(await from.isVisible(), true, 'Escaped from shows once the answer is Yes');
    await form.locator('input[name="escaped"][value="no"]').check();
    assert.equal(await from.isVisible(), false, 'Escaped from hides again on No');
    await form.locator('input[name="escaped"][value="yes"]').check();
    const options = await from.locator('option').evaluateAll(list => list.map(o => o.value));
    const choice = options.find(value => value && value !== 'Final inspection');
    assert.ok(choice, 'a control point other than the default exists');
    await from.selectOption(choice);
    const before = await page.evaluate(() => window.FlightManeuver.list(state, 'ncs').map(nc => nc.id));
    await form.locator('#mnv-nc-title').fill('Sweep escape check');
    await form.locator('#mnv-nc-part').fill('PN-SWEEP-460');
    await form.locator('#mnv-nc-desc').fill('Raised by the Flight Maneuver sweep test.');
    await form.locator('#mnv-nc-po').fill('PO46000');
    await form.locator('#mnv-nc-line').fill('1');
    await form.locator('button[type="submit"]').click();
    const nc = await page.waitForFunction(ids => window.FlightManeuver.list(state, 'ncs').find(nc => !ids.includes(nc.id) && nc.title === 'Sweep escape check'), before).then(handle => handle.jsonValue());
    assert.ok(nc.escape, 'the NC records an escape');
    assert.equal(nc.escape.from, choice, 'the escape names the control point chosen in the form');
  });

  await check('#461 Problem reports drawer records the Jira key and closes from Jira', async () => {
    const id = await raiseSpr('Sweep Jira check');
    assert.match(id, /^SPR-/, id);
    let drawer = await openDrawer(id);
    assert.equal(await drawer.getByRole('button', { name: 'Open full record' }).count(), 0, 'no dead link back to the same list');
    assert.equal(await drawer.getByRole('button', { name: 'Copy payload' }).count(), 1);
    assert.equal(await drawer.getByRole('button', { name: 'Close from Jira' }).count(), 0, 'Close from Jira waits for the Jira key');
    await drawer.getByRole('button', { name: 'Record Jira key' }).click();
    await page.locator('.fr-drawer[open]').waitFor({ state: 'detached' });
    const jira = page.locator('#mnv-spr-jira-form');
    await jira.waitFor();
    await jira.locator('input[name="key"]').fill('SPR-9461');
    await jira.locator('button[type="submit"]').click();
    await page.waitForFunction(id => window.FlightManeuver.get(state, 'sprs', id).status === 'In Jira', id);
    await page.evaluate(() => { try { $('#dialog').close(); } catch {} });
    drawer = await openDrawer(id);
    assert.equal(await drawer.getByRole('button', { name: 'Record Jira key' }).count(), 0, 'the key is recorded once');
    await drawer.getByRole('button', { name: 'Close from Jira' }).click();
    const close = page.locator('#mnv-spr-close-form');
    await close.waitFor();
    await close.locator('textarea[name="note"]').fill('Closed in Jira after the sweep test.');
    await close.locator('button[type="submit"]').click();
    await page.waitForFunction(id => window.FlightManeuver.get(state, 'sprs', id).status === 'Closed', id);
    await page.evaluate(() => { try { $('#dialog').close(); } catch {} });
  });

  await check('#461 refusal: a role without the capability sees no Jira action in the drawer', async () => {
    const id = await raiseSpr('Sweep refusal check');
    assert.match(id, /^SPR-/, id);
    await page.evaluate(() => { window.__sweepAuth = window.skAuth; window.skAuth = { ...(window.skAuth || {}), can: () => false }; });
    try {
      const drawer = await openDrawer(id);
      assert.equal(await drawer.getByRole('button', { name: 'Record Jira key' }).count(), 0);
      assert.equal(await drawer.getByRole('button', { name: 'Close from Jira' }).count(), 0);
      assert.equal(await drawer.getByRole('button', { name: 'Copy payload' }).count(), 1, 'reading the payload stays open to everyone');
      await page.keyboard.press('Escape');
    } finally {
      await page.evaluate(() => { window.skAuth = window.__sweepAuth; delete window.__sweepAuth; });
    }
  });
  await context.close();
} finally { await browser.close(); }
if (errors.length) FAILS.push(`page errors: ${errors.join(' | ')}`);
console.log('FAILS', JSON.stringify(FAILS));
process.exit(FAILS.length ? 1 : 0);
