// #241: with the shared server active, the browser copy is a cache. A full or unavailable browser storage must not
// refuse a change the server can take: the change goes to the server and the page says this device's offline copy is
// out of date, in its own notice. Until a server request that carried such a change is confirmed, the change is kept as
// a device copy to download, and an ended session or a dropped connection does not lose it. A standalone page, where the browser copy is the only record,
// still refuses the change. A workspace that changed in another tab still blocks changes in either mode.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const KEY = 'skyryse-mes-work-order-v1';
const FIXTURES = new URL('./fixtures/', import.meta.url);
let passed = 0;
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); passed += 1; console.log(`ok ${name}`); };
// Refuse every write of the page's own workspace key (the demo build uses its own): a full storage throws
// QuotaExceededError, and storage the browser has turned off throws SecurityError.
const fillStorage = (page, name = 'QuotaExceededError') => page.evaluate(name => { const key = KEY; const set = Storage.prototype.setItem; window.__restoreStorage = () => { Storage.prototype.setItem = set; }; Storage.prototype.setItem = function (k, v) { if (k === key) throw new DOMException('Browser storage refused the write.', name); return set.call(this, k, v); }; }, name);
const shown = (page, selector) => page.evaluate(selector => { const box = document.querySelector(selector); return box && !box.hidden ? box.textContent : ''; }, selector);

const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'storage-full-setup' });
let browser;
const errors = [];
try {
  const port = await server.listenAsync(0, '127.0.0.1');
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const signIn = async (page, setup) => {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#sk-login').waitFor({ state: 'visible' });
    if (setup) {
      await page.locator('#sk-displayname').fill('Storage Full Admin');
      await page.locator('#sk-confirm').fill('storage-admin-password');
      await page.locator('#sk-setup').fill('storage-full-setup');
    }
    await page.locator('#sk-username').fill('storage-admin');
    await page.locator('#sk-password').fill('storage-admin-password');
    await page.locator('#sk-login-submit').click();
    await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
    return page.evaluate(() => sessionStorage.getItem('skyryse-mes-server-token-v1'));
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const token = await signIn(page, true);
  // Reads the shared workspace with a session token; a token that no longer works fails the check instead of reading as absent.
  const serverHas = async (id, bearer = token) => { const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${bearer}` } }); assert.equal(response.status, 200, 'the test reads the shared workspace'); return (await response.json()).orders.some(order => order.partNumber === id); };
  const tabToken = tab => tab.evaluate(() => sessionStorage.getItem('skyryse-mes-server-token-v1'));
  const waitForServer = id => page.waitForFunction(async ({ port, token, id }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
    return response.ok && (await response.json()).orders.some(order => order.partNumber === id);
  }, { port, token, id }, { timeout: 15000 });
  const addOrder = (target, partNumber) => target.evaluate(partNumber => {
    const next = structuredClone(state);
    const created = MES.addAdhocOrder(next, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: 'C3', partNumber, title: 'Storage full check', revision: 'A' });
    if (!created.ok) return { ok: false, message: created.message };
    let ok = false, message = '';
    try { ok = mediaCommit(next) !== false; } catch (error) { message = error.message; }
    return { ok, message, kept: state.orders.some(order => order.partNumber === partNumber) };
  }, partNumber);

  // Server mode, browser storage full: the change is kept and reaches the server, and the page says why the offline copy lags.
  await fillStorage(page);
  const full = await addOrder(page, 'STORAGE-FULL-001');
  check('server mode keeps a change when browser storage is full', full.ok && full.kept, JSON.stringify(full));
  await waitForServer('STORAGE-FULL-001');
  check('the change saved with browser storage full reaches the shared server', true);
  const banner = await shown(page, '#offline-copy-alert');
  check('the page says the offline copy on this device is out of date, that changes still save to the server, and to free storage', /offline copy/i.test(banner) && /shared server/i.test(banner) && /Free browser storage/.test(banner) && !/—/.test(banner), banner);
  check('a full browser storage in server mode does not block later changes', await page.evaluate(() => storageBlocked) === false);
  const second = await addOrder(page, 'STORAGE-FULL-002');
  await waitForServer('STORAGE-FULL-002');
  check('a second change with browser storage still full also reaches the server', second.ok && second.kept, JSON.stringify(second));

  // Storage works again: the offline copy is written and the notice clears.
  await page.evaluate(() => window.__restoreStorage());
  const third = await addOrder(page, 'STORAGE-FULL-003');
  await waitForServer('STORAGE-FULL-003');
  // The server can hold the change before the page has handled the server's answer, and the notice says unconfirmed
  // until it has. Wait (bounded) for the page to write the offline copy and clear the notice, then check both.
  await page.waitForFunction(key => { const box = document.querySelector('#offline-copy-alert'); return (!box || box.hidden) && JSON.parse(localStorage.getItem(key) || '{}').orders?.some(order => order.partNumber === 'STORAGE-FULL-003'); }, KEY, { timeout: 15000 }).catch(() => {});
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').orders?.some(order => order.partNumber === 'STORAGE-FULL-003'), KEY);
  check('once browser storage works again the offline copy is updated and the notice clears', third.ok && stored && !(await shown(page, '#offline-copy-alert')), await shown(page, '#offline-copy-alert'));

  // Codex review on #264: any successful cache write of the server's copy clears the out-of-date notice, not only a new change.
  await fillStorage(page);
  await addOrder(page, 'STORAGE-FULL-010');
  await waitForServer('STORAGE-FULL-010');
  await page.waitForFunction(() => !cachelessUnconfirmed(), null, { timeout: 15000 });
  await page.evaluate(() => window.__restoreStorage());
  await page.evaluate(() => refreshServerWorkspace());
  check('a reload of the server copy into working browser storage clears the out-of-date notice', await page.evaluate(() => offlineCopyStale) === false && !(await shown(page, '#offline-copy-alert')), await shown(page, '#offline-copy-alert'));

  // Codex review on #264: another notice already on screen does not hide the offline-copy warning.
  await page.evaluate(() => { const box = document.querySelector('#storage-alert'); box.hidden = false; box.textContent = 'An earlier notice.'; });
  await fillStorage(page);
  const behind = await addOrder(page, 'STORAGE-FULL-004');
  await waitForServer('STORAGE-FULL-004');
  check('the offline-copy warning shows even while another notice is on screen, and leaves that notice as it was', behind.ok && /offline copy/i.test(await shown(page, '#offline-copy-alert')) && await shown(page, '#storage-alert') === 'An earlier notice.', `${await shown(page, '#offline-copy-alert')} | ${await shown(page, '#storage-alert')}`);
  await page.evaluate(() => { window.__restoreStorage(); document.querySelector('#storage-alert').hidden = true; });
  await addOrder(page, 'STORAGE-FULL-005');

  // Codex review on #264: storage the browser has turned off gets advice that can fix it, not "free storage".
  await fillStorage(page, 'SecurityError');
  const blocked = await addOrder(page, 'STORAGE-FULL-006');
  await waitForServer('STORAGE-FULL-006');
  const blockedText = await shown(page, '#offline-copy-alert');
  check('when the browser has turned storage off, the notice says so and says to allow site storage', blocked.ok && /Allow site storage/.test(blockedText) && !/Free browser storage/.test(blockedText) && !/—/.test(blockedText), blockedText);
  await page.evaluate(() => window.__restoreStorage());
  await addOrder(page, 'STORAGE-FULL-007');
  await waitForServer('STORAGE-FULL-007');
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced' && !serverActionPending && !serverActionQueue.length, null, { timeout: 15000 });

  // Refusal path: a workspace changed in another tab still blocks changes in server mode.
  await page.evaluate(key => window.dispatchEvent(new StorageEvent('storage', { key })), KEY);
  const otherTab = await addOrder(page, 'STORAGE-FULL-008');
  check('a workspace changed in another tab still blocks changes in server mode', !otherTab.ok && !otherTab.kept, JSON.stringify(otherTab));
  await page.close();

  // Codex review on #264: a change kept without a browser copy is only in this tab until a server request that carried it
  // is confirmed. When the server session ends first, the tab stays open with the device copy to download.
  const openHeld = async () => {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await signIn(tab, false);
    await tab.evaluate(() => { window.__sameDocument = true; });
    await fillStorage(tab);
    return tab;
  };
  const actionRoute = /\/api\/workspace\/actions\/.*$/;
  const deviceCopy = async tab => {
    const [download] = await Promise.all([tab.waitForEvent('download'), tab.locator('[data-action="download-device-copy"]').first().click()]);
    return fs.readFile(await download.path(), 'utf8');
  };
  const held = await openHeld();
  const heldToken = await tabToken(held);
  await held.route(actionRoute, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Session ended.' }) }));
  const lost = await addOrder(held, 'STORAGE-HELD-001');
  await held.waitForFunction(() => /only in this tab/.test(document.querySelector('#flight-server-recovery')?.textContent || ''), null, { timeout: 15000 });
  const heldState = await held.evaluate(() => ({ sameDocument: window.__sameDocument === true, kept: state.orders.some(order => order.partNumber === 'STORAGE-HELD-001'), copy: !!cachelessCopy?.workspace?.orders?.some(order => order.partNumber === 'STORAGE-HELD-001'), signIn: !!document.querySelector('#flight-server-recovery [data-action="server-sign-in-again"]') }));
  check('an ended session does not reload away a change that is only in this tab', lost.kept && heldState.sameDocument && heldState.kept && heldState.copy && heldState.signIn && !(await serverHas('STORAGE-HELD-001', heldToken)), JSON.stringify({ lost, heldState }));
  check('the device copy downloads with the unconfirmed change in it', /STORAGE-HELD-001/.test(await deviceCopy(held)));
  const afterHold = await addOrder(held, 'STORAGE-HELD-002');
  check('after the session ends, further changes are refused until the person signs in again', !afterHold.ok && !afterHold.kept, JSON.stringify(afterHold));
  await held.close({ runBeforeUnload: false });

  // Codex review on #264: two quick changes go out in separate batches. The first is confirmed and reloads the server
  // copy; the second is refused because the session ended. The second change is still kept as the device copy.
  const twice = await openHeld();
  const twiceToken = await tabToken(twice);
  let actionCalls = 0;
  await twice.route(actionRoute, route => { actionCalls += 1; return /STORAGE-TWICE-002/.test(route.request().postData() || '') ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Session ended.' }) }) : route.continue(); });
  await addOrder(twice, 'STORAGE-TWICE-001');
  await addOrder(twice, 'STORAGE-TWICE-002');
  await twice.waitForFunction(() => /only in this tab/.test(document.querySelector('#flight-server-recovery')?.textContent || ''), null, { timeout: 15000 });
  const twiceState = await twice.evaluate(() => ({ sameDocument: window.__sameDocument === true, copy: !!cachelessCopy?.workspace?.orders?.some(order => order.partNumber === 'STORAGE-TWICE-002') }));
  check('when a later batch is refused after an earlier one was confirmed, the later change is still kept as the device copy', twiceState.sameDocument && twiceState.copy && await serverHas('STORAGE-TWICE-001', twiceToken) && !(await serverHas('STORAGE-TWICE-002', twiceToken)) && /STORAGE-TWICE-002/.test(await deviceCopy(twice)), JSON.stringify({ actionCalls, twiceState }));
  await twice.close({ runBeforeUnload: false });

  // Codex review on #264: a dropped connection leaves the change unconfirmed. The notice offers the device copy, and closing
  // the tab asks first.
  const dropped = await openHeld();
  const droppedToken = await tabToken(dropped);
  await dropped.route(actionRoute, route => route.abort('connectionreset'));
  await addOrder(dropped, 'STORAGE-DROP-001');
  await dropped.waitForFunction(() => /offline|error/.test(window.skServer?.sync?.status || ''), null, { timeout: 15000 });
  const droppedState = await dropped.evaluate(() => ({ unconfirmed: cachelessUnconfirmed(), button: !!document.querySelector('#offline-copy-alert [data-action="download-device-copy"]') }));
  check('a dropped connection keeps the unconfirmed change as a device copy, offered for download, and closing the tab asks first', droppedState.unconfirmed && droppedState.button && /STORAGE-DROP-001/.test(await deviceCopy(dropped)) && !(await serverHas('STORAGE-DROP-001', droppedToken)), JSON.stringify(droppedState));
  await dropped.close({ runBeforeUnload: false });

  // Refusal path: a standalone page, where the browser copy is the only record, still refuses the change.
  const standalone = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  standalone.on('pageerror', error => errors.push(error.message));
  await standalone.goto(new URL('demo_qa150_publish.html', FIXTURES).href);
  await standalone.waitForFunction(() => !!document.querySelector('#sk-boot input[name=username]'), null, { timeout: 15000 });
  await standalone.evaluate(() => { const un = document.querySelector('#sk-boot input[name=username]'), pw = document.querySelector('#sk-boot input[type=password]'); un.value = 'mfgeng'; un.dispatchEvent(new Event('input', { bubbles: true })); pw.value = 'demo1234'; pw.dispatchEvent(new Event('input', { bubbles: true })); un.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await standalone.waitForFunction(() => window.skAuth?.user?.()?.username === 'mfgeng', null, { timeout: 15000 });
  await fillStorage(standalone);
  const local = await standalone.evaluate(() => {
    const before = state.orders.length;
    const r = MES.addAdhocOrder(state, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], partNumber: 'STORAGE-LOCAL-001', title: 'Standalone storage full check', revision: 'A' });
    const saved = r.ok ? save() : null;
    return { created: r.ok, saved, kept: state.orders.length > before };
  });
  const localBanner = await shown(standalone, '#storage-alert');
  check('a standalone page still refuses a change when browser storage is full', local.created && local.saved === false && !local.kept && /Browser storage is full/.test(localBanner), `${JSON.stringify(local)} ${localBanner}`);
  await standalone.close();
  check('no page errors', errors.length === 0, JSON.stringify(errors));
  console.log(`server storage full: ${passed} checks, all passed`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  server.store.close();
}
