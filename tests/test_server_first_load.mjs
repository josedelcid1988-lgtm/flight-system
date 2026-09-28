// First sign-in against a server that has no shared workspace yet. The page must not send record changes while
// its first workspace load is in flight: on a slow device a boot-time change used to reach the server before the
// 404, and the page then mistook its own fresh write for an old browser workspace and stopped syncing. A browser
// workspace that was on the device before the page booted must still be refused until it is migrated explicitly.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const KEY = 'skyryse-mes-work-order-v1';
const THROTTLE = 6;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const servers = [];
async function freshServer() {
  const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true });
  servers.push(server);
  return { server, port: await server.listenAsync(0, '127.0.0.1') };
}
async function signIn(page) {
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('First Load Admin');
  await page.locator('#sk-username').fill('first-load-admin');
  await page.locator('#sk-password').fill('first-load-password');
  await page.locator('#sk-confirm').fill('first-load-password');
  await page.locator('#sk-login-submit').click();
}
async function slowPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const errors = [], api = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/workspace')) api.push(`${response.request().method()} ${response.url().replace(/.*\/api/, '')} ${response.status()}`); });
  return { page, errors, api };
}

try {
  {
    const { server, port } = await freshServer();
    const { page, errors, api } = await slowPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await signIn(page);
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced' && window.skServer.sync.message === 'Shared workspace saved on the server.', null, { timeout: 30000 });
    assert.ok(!api.some(line => /\/workspace\/actions\//.test(line) && !/ 200$/.test(line)), `no record change is sent before the first workspace exists: ${api.join(', ')}`);
    assert.ok(api.includes('PUT /workspace 204'), `the first sign-in initializes the shared workspace: ${api.join(', ')}`);
    const row = await server.store.getDoc('default');
    assert.ok(row && server.host.MES.validate(JSON.parse(row.json)), 'the server holds a valid shared workspace');
    await page.reload();
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced' && window.skServer.sync.message === 'Shared workspace loaded from the server.', null, { timeout: 30000 });
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { server, port } = await freshServer();
    const { page, errors, api } = await slowPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify(MES.ensureMasterWIs(MES.seed()))), KEY);
    await page.reload();
    await signIn(page);
    await page.waitForFunction(() => window.skServer?.sync?.status === 'error', null, { timeout: 30000 });
    assert.match(await page.evaluate(() => window.skServer.sync.message), /needs an explicit migration/);
    await page.locator('#storage-alert').filter({ hasText: /Server workspace not initialized/ }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await server.store.getDoc('default'), null, 'a browser workspace that predates the page is not uploaded without migration');
    assert.ok(!api.some(line => /^PUT /.test(line) || /\/actions\//.test(line)), `nothing is written to the server: ${api.join(', ')}`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { server, port } = await freshServer();
    const { page, errors, api } = await slowPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await signIn(page);
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced' && window.skServer.sync.message === 'Shared workspace saved on the server.', null, { timeout: 30000 });
    // Race-3: a refused edit leaves an unconfirmed local copy, and reloading must show the
    // recovery banner from the 200 branch of loadServerWorkspace (showUnconfirmedServerRecovery).
    const orderId = await page.evaluate(() => {
      const created = MES.addAdhocOrder(state, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: 'C3', partNumber: 'RACE3-TEST-001', title: 'Race-3 refusal check', revision: 'A' });
      if (!created.ok) throw new Error(created.message);
      save();
      return created.id;
    });
    await page.waitForFunction(id => window.skServer?.sync?.status === 'synced' && state.orders.some(o => o.id === id), orderId, { timeout: 30000 });
    const refusal = await page.evaluate((id) => {
      const order = state.orders.find(o => o.id === id);
      if (!order) throw new Error('No order is available for the race-3 refusal check.');
      const previous = order.priority, next = previous === 'AOG' ? 'Normal' : 'AOG';
      const api = window.skServer.api.bind(window.skServer);
      window.__rejectNextSnapshot = true;
      window.skServer.api = async (path, options) => {
        if (window.__rejectNextSnapshot && path === '/workspace' && options?.method === 'PUT') {
          window.__rejectNextSnapshot = false;
          return { status: 403, json: { error: 'Controlled race-3 refusal check' } };
        }
        return api(path, options);
      };
      order.priority = next;
      save();
      return { id: order.id, previous };
    }, orderId);
    await page.waitForFunction(({ id, previous }) => state.orders.find(o => o.id === id)?.priority === previous, refusal, { timeout: 15000 });
    await page.locator('#flight-server-recovery').waitFor({ state: 'visible', timeout: 10000 });
    await page.reload();
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced' && window.skServer.sync.message === 'Shared workspace loaded from the server.', null, { timeout: 30000 });
    await page.locator('#flight-server-recovery').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.locator('#flight-server-recovery').innerText(), /unconfirmed device copy/i, 'the recovery banner survives a reload after a refused edit');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('server first load: a slow first sign-in initializes and syncs without early record changes; a pre-existing browser workspace still requires migration; a refused edit shows the recovery banner after reload');
} finally {
  await browser.close();
  for (const server of servers) server.close?.();
}
