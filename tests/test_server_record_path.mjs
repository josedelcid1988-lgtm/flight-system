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
  const views = await serverViews();
  assert.ok(views.includes('Record path sent') && !views.some(name => name.startsWith('Refused')), `the server record is unchanged by the refused attempts: ${views.join(', ')}`);
  assert.deepEqual(errors, []);
  await page.close();

  // Standalone use, no server: the browser is the record store and changes save there.
  const standalone = await browser.newPage();
  await standalone.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
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
  console.log('server record path: with a server configured, record changes reach the server or are refused before they run; standalone still saves in the browser');
} finally {
  await browser.close();
  server.close?.();
}
