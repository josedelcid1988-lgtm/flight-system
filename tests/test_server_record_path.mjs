// With a server configured, the server is the only record store. A record change goes to the server or is refused
// before it runs; it is never kept on this device alone. Standalone use, with no server, still saves in the browser.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'record-path-setup-code' });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const port = await server.listenAsync(0, '127.0.0.1');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], actions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/workspace/actions/')) actions.push(request.url().replace(/.*\/actions\//, '')); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('Record Path Admin');
  await page.locator('#sk-username').fill('record-path-admin');
  await page.locator('#sk-password').fill('record-path-password');
  await page.locator('#sk-confirm').fill('record-path-password');
  await page.locator('#sk-setup').fill('record-path-setup-code');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await page.evaluate(() => serverPush);
  const token = await page.evaluate(() => sessionStorage.getItem('skyryse-mes-server-token-v1'));
  const serverViews = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json()).savedViews || []).map(view => view.name);

  // The accepted path: a record change is sent to the server as an action.
  assert.equal(await page.evaluate(() => { const r = MES.addSavedView(state, 'Record path sent', {}); if (r.ok) save(); return r.ok; }), true);
  await page.waitForFunction(() => !serverActionPending && !serverActionQueue.length && window.skServer.sync.status === 'synced', null, { timeout: 15000 });
  assert.ok(actions.includes('MES.addSavedView'), `the change is sent to the server: ${actions.join(', ')}`);
  assert.ok((await serverViews()).includes('Record path sent'), 'the server holds the change');

  // Each state in which a change could not reach the server refuses the change before it runs.
  const refusals = [
    ['no server session', /Sign in to the shared server/, () => { window.__token = sessionStorage.getItem('skyryse-mes-server-token-v1'); sessionStorage.removeItem('skyryse-mes-server-token-v1'); }, () => sessionStorage.setItem('skyryse-mes-server-token-v1', window.__token)],
    ['shared workspace not loaded', /has not loaded from the server/, () => { serverWorkspaceReady = false; }, () => { serverWorkspaceReady = true; }],
    ['an earlier action needs review', /not confirmed by the server/, () => { serverActionStopped = true; }, () => { serverActionStopped = false; }],
    ['a server reply is unconfirmed', /not confirmed by the server/, () => { serverReconcilePending = true; }, () => { serverReconcilePending = false; }]
  ];
  for (const [label, message, enter, leave] of refusals) {
    const sentBefore = actions.length;
    const outcome = await page.evaluate(({ label, enter, leave }) => {
      const stored = localStorage.getItem(KEY), before = JSON.stringify(state.savedViews || []);
      (0, eval)(`(${enter})`)();
      try {
        const r = MES.addSavedView(state, `Refused ${label}`.slice(0, 40), {});
        let media = null;
        try { mediaCommit(structuredClone(state)); } catch (error) { media = error.message; }
        return { ok: r.ok, message: r.message, serverRequired: r.serverRequired, unchanged: JSON.stringify(state.savedViews || []) === before, storedUnchanged: localStorage.getItem(KEY) === stored, queue: serverActionQueue.length, media };
      } finally { (0, eval)(`(${leave})`)(); }
    }, { label, enter: enter.toString(), leave: leave.toString() });
    assert.equal(outcome.ok, false, `${label}: the change is refused`);
    assert.equal(outcome.serverRequired, true, `${label}: the refusal says the server is required`);
    assert.match(outcome.message, message, `${label}: the refusal says what to do`);
    assert.match(outcome.message, /Nothing was saved/, `${label}: the refusal says nothing was saved`);
    assert.equal(outcome.unchanged, true, `${label}: the live workspace is unchanged`);
    assert.equal(outcome.storedUnchanged, true, `${label}: nothing is written to browser storage`);
    assert.equal(outcome.queue, 0, `${label}: nothing is queued to send later`);
    assert.match(outcome.media || '', message, `${label}: an evidence or discussion commit is refused the same way`);
    await page.waitForTimeout(200);
    assert.equal(actions.length, sentBefore, `${label}: nothing is sent`);
  }
  // A proposed copy of the live workspace is recognized even when the live workspace has moved on from the last
  // save (upgrade convergence fills derived fields): its change is sent as an action, not lost to a snapshot PUT.
  await page.evaluate(() => {
    lastSaved = { ...structuredClone(lastSaved), savedViews: [] };
    const next = structuredClone(state), r = MES.addSavedView(next, 'Record path copy', {});
    if (!r.ok) throw new Error(r.message);
    mediaCommit(next);
  });
  await page.waitForFunction(() => !serverActionPending && !serverActionQueue.length && window.skServer.sync.status === 'synced', null, { timeout: 15000 });
  assert.ok((await serverViews()).includes('Record path copy'), 'a change on a copy of the live workspace reaches the server');

  // A shared workspace reload that fails leaves writes refused, not running against the stale copy.
  const reload = await page.evaluate(async () => {
    const api = window.skServer.api;
    window.skServer.api = async () => { throw new Error('offline'); };
    try { await loadServerWorkspace(); } finally { window.skServer.api = api; }
    const r = MES.addSavedView(state, 'Refused after reload', {});
    await loadServerWorkspace();
    return { ok: r.ok, message: r.message, readyAgain: serverWorkspaceReady };
  });
  assert.equal(reload.ok, false, 'a change after a failed reload is refused');
  assert.match(reload.message, /has not loaded from the server/);
  assert.equal(reload.readyAgain, true, 'a successful reload makes the workspace ready again');

  // A shared server workspace is never reset from a page, even signed in and ready: nothing on this device is
  // cleared or replaced, and no snapshot is sent for the server to refuse.
  const reset = await page.evaluate(() => {
    const stored = localStorage.getItem(KEY), before = JSON.stringify(state);
    resetWorkspace();
    return { unchanged: JSON.stringify(state) === before, storedUnchanged: localStorage.getItem(KEY) === stored, toast: document.querySelector('#toast p')?.textContent || '' };
  });
  assert.deepEqual({ unchanged: reset.unchanged, storedUnchanged: reset.storedUnchanged }, { unchanged: true, storedUnchanged: true }, 'a refused reset changes nothing');
  assert.match(reset.toast, /cannot be reset from this page/, 'the reset refusal says why');

  // After a shared workspace load succeeds, the signed-in account's stamp profile is bound again: binding is refused
  // while the workspace loads, so an in-place account switch would otherwise keep the previous account's profile.
  const rebound = await page.evaluate(async () => {
    let calls = 0; const bind = window.skBindCredential;
    window.skBindCredential = () => { calls++; return bind(); };
    try { await loadServerWorkspace(); } finally { window.skBindCredential = bind; }
    return calls;
  });
  assert.equal(rebound, 1, 'a successful shared workspace load binds the credential again');

  // A traveler is printed only when its print record can reach the server.
  const orderId = await page.evaluate(() => {
    const wi = state.masterWIs.find(item => item.status === 'Released');
    const r = MES.addOrder(state, { masterWI: wi.id + '|' + wi.revision, pedigree: 'Development', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] });
    if (!r.ok) throw new Error(r.message);
    save();
    return r.id || state.orders[state.orders.length - 1].id;
  });
  await page.waitForFunction(() => !serverActionPending && !serverActionQueue.length && window.skServer.sync.status === 'synced', null, { timeout: 15000 });
  const traveler = await page.evaluate(id => {
    const opened = []; const open = window.open; window.open = () => { opened.push(1); return null; };
    const token = sessionStorage.getItem('skyryse-mes-server-token-v1'), history = JSON.stringify(MES.getOrder(state, id).history || []);
    sessionStorage.removeItem('skyryse-mes-server-token-v1');
    try { printTraveler(id); return { opened: opened.length, downloads: document.querySelectorAll('a[download^="traveler-"]').length, historyUnchanged: JSON.stringify(MES.getOrder(state, id).history || []) === history, toast: document.querySelector('#toast p')?.textContent || '' }; }
    finally { sessionStorage.setItem('skyryse-mes-server-token-v1', token); window.open = open; }
  }, orderId);
  assert.equal(traveler.opened, 0, 'the traveler is not opened when its print record is refused');
  assert.equal(traveler.historyUnchanged, true, 'no print record is kept on this device');
  assert.match(traveler.toast, /Sign in to the shared server/, 'the print refusal says what to do');
  // When the print record cannot be saved on this device (storage unavailable), nothing is printed either.
  const unsaved = await page.evaluate(id => {
    const opened = []; const open = window.open; window.open = () => { opened.push(1); return null; };
    const history = JSON.stringify(MES.getOrder(state, id).history || []);
    storageBlocked = true;
    try { printTraveler(id); return { opened: opened.length, historyUnchanged: JSON.stringify(MES.getOrder(state, id).history || []) === history, queue: serverActionQueue.length }; }
    finally { storageBlocked = false; window.open = open; }
  }, orderId);
  assert.deepEqual(unsaved, { opened: 0, historyUnchanged: true, queue: 0 }, 'an unsaved print record means no traveler is printed');

  // With a server configured, the traveler opens only after the server confirms its print record, and not at all
  // when the server refuses it. The action is held at the network until the test releases it.
  const printCount = history => history.filter(entry => /Shop traveler printed/.test(entry.text || entry.message || JSON.stringify(entry))).length;
  const serverPrints = async id => printCount((((await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json()).orders || []).find(o => o.id === id) || {}).history || []);
  const holdPrint = async reply => {
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/workspace/actions/MES.logTravelerPrint', async route => { await held; if (reply) await route.fulfill(reply); else await route.continue(); });
    return async () => { release(); };
  };
  const startPrint = id => page.evaluate(id => {
    // A window may be opened at the click to keep the pop-up allowed; only the traveler itself written into it counts.
    window.__opened = []; window.__closed = 0; window.__open = window.open;
    window.open = () => { const doc = { open() {}, write(html) { if (html.includes(id)) window.__opened.push(html); }, close() {}, querySelector() { return null; } }; return { document: doc, focus() {}, print() {}, close() { window.__closed++; } }; };
    window.__printDone = Promise.resolve(printTraveler(id));
    return window.__opened.length;
  }, id);
  const finishPrint = () => page.evaluate(async () => { try { await window.__printDone; } finally { window.open = window.__open; } return { opened: window.__opened.length, closed: window.__closed, toast: document.querySelector('#toast p')?.textContent || '' }; });
  {
    const before = await serverPrints(orderId);
    const release = await holdPrint(null);
    const openedWhilePending = await startPrint(orderId);
    await page.waitForTimeout(300);
    const openedBeforeReply = await page.evaluate(() => window.__opened.length);
    await release();
    const done = await finishPrint();
    await page.unroute('**/api/workspace/actions/MES.logTravelerPrint');
    assert.equal(openedWhilePending, 0, 'the traveler is not opened while its print record is on its way to the server');
    assert.equal(openedBeforeReply, 0, 'the traveler is not opened before the server confirms the print record');
    assert.equal(done.opened, 1, `the traveler opens once the server confirms the print record: ${done.toast}`);
    assert.equal(await serverPrints(orderId), before + 1, 'the server holds the print record');
  }
  {
    const before = await serverPrints(orderId);
    const release = await holdPrint({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Test refusal of the print record.' }) });
    const openedWhilePending = await startPrint(orderId);
    await release();
    const done = await finishPrint();
    await page.unroute('**/api/workspace/actions/MES.logTravelerPrint');
    await page.waitForFunction(() => !serverActionPending && !serverActionQueue.length && !serverReconcilePending, null, { timeout: 15000 });
    assert.equal(openedWhilePending, 0, 'the traveler is not opened while a refused print record is pending');
    assert.equal(done.opened, 0, 'the traveler is not opened when the server refuses its print record');
    assert.equal(done.closed, 1, 'the window held open for the traveler is closed');
    assert.match(done.toast, /traveler was not printed/, `the refusal says the traveler was not printed: ${done.toast}`);
    assert.equal(await serverPrints(orderId), before, 'the refused print record is not on the server');
    assert.equal(await page.evaluate(id => MES.getOrder(state, id).history.filter(entry => /Shop traveler printed/.test(JSON.stringify(entry))).length, orderId), before, 'this page holds the server copy, without the refused print record');
  }

  // A role change reason is kept in the server audit trail when a server is configured, and the refusal says so.
  const roleReason = await page.evaluate(() => {
    const auth = window.FLIGHT_SERVER.auth, users = auth.users;
    auth.users = [...users, { username: 'reason-target', displayName: 'Reason Target', role: 'technician' }];
    try { return skAuth.setRoles('reason-target', ['general'], 'short'); } finally { auth.users = users; }
  });
  assert.equal(roleReason.ok, false, 'a short role change reason is refused');
  assert.match(roleReason.message, /kept in the server audit trail/, `the reason is said to go to the server audit trail: ${roleReason.message}`);
  assert.doesNotMatch(roleReason.message, /device/, 'the server-mode reason message does not name this device');

  // Codex review on #621: with a server, a skill run input or draft body is measured before the action is copied for
  // the server, so a refused shape is never serialized in the tab and gets the engine's own refusal, not the encoding one.
  const shaped = await page.evaluate(() => {
    const stringify = JSON.stringify; let copied = 0;
    const wide = Array.from({ length: 1000000 }, () => ({}));
    let deep = {}; for (let i = 0; i < 3000; i++) deep = { next: deep };
    JSON.stringify = function (value, ...rest) { if (Array.isArray(value) && (value.includes(wide) || value.includes(deep))) copied++; return stringify.call(this, value, ...rest); };
    try {
      const queued = serverActionQueue.length;
      const wideRun = MES.runSkill(state, 'drawing-review', wide);
      const deepRun = MES.runSkill(state, 'drawing-review', deep);
      const wideEdit = MES.updateSkillDraft(state, 'AID-NONE', wide, 'Record path check.');
      return { copied, queued: serverActionQueue.length - queued, wideRun, deepRun, wideEdit: wideEdit.ok };
    } finally { JSON.stringify = stringify; }
  });
  assert.equal(shaped.copied, 0, 'a refused skill input or draft body is not serialized for the server');
  assert.equal(shaped.queued, 0, 'nothing is queued for the server');
  assert.equal(shaped.wideRun.ok, false);
  assert.match(shaped.wideRun.message, /more than 50,000 values/, `a wide run input gets the value-count refusal: ${shaped.wideRun.message}`);
  assert.equal(shaped.deepRun.ok, false);
  assert.match(shaped.deepRun.message, /nested too deeply/, `a deep run input gets the depth refusal, not the encoding one: ${shaped.deepRun.message}`);
  assert.equal(shaped.wideEdit, false, 'a wide draft body is refused');
  const views = await serverViews();
  assert.ok(views.includes('Record path sent') && !views.some(name => name.startsWith('Refused')), `the server record is unchanged by the refused attempts: ${views.join(', ')}`);
  assert.deepEqual(errors, []);
  await page.close();

  // Standalone use, no server: the browser is the record store and changes save there.
  const standalone = await browser.newPage();
  await standalone.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }, { username: 'bench', displayName: 'Bench Tech', salt: 'test', hash: 'unused', role: 'technician', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  await standalone.goto(new URL('./fixtures/publish.html', import.meta.url).href);
  await standalone.waitForFunction(() => typeof state !== 'undefined' && typeof save === 'function');
  const local = await standalone.evaluate(() => {
    const r = MES.addSavedView(state, 'Standalone view', {}); if (r.ok) save();
    return { ok: r.ok, saved: (JSON.parse(localStorage.getItem(KEY)).savedViews || []).some(view => view.name === 'Standalone view') };
  });
  assert.deepEqual(local, { ok: true, saved: true }, 'standalone changes still save in the browser');
  // Standalone, the role change reason is kept in this device's security log, and the refusal says so.
  const localReason = await standalone.evaluate(() => skAuth.setRoles('bench', ['general'], 'short'));
  assert.equal(localReason.ok, false, 'a short role change reason is refused standalone');
  assert.match(localReason.message, /kept in this device's security log/, `the reason is said to stay on this device: ${localReason.message}`);
  console.log('server record path: with a server configured, record changes reach the server or are refused before they run; standalone still saves in the browser');
} finally {
  await browser.close();
  server.close?.();
}
