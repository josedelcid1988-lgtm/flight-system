import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true });
let browser;
try {
  const port = await server.listenAsync(0, '127.0.0.1');
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('Server UI Admin');
  await page.locator('#sk-username').fill('server-ui-admin');
  await page.locator('#sk-password').fill('server-ui-password');
  await page.locator('#sk-confirm').fill('server-ui-password');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('#main .flight-react').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await page.evaluate(() => serverPush);

  const token = await page.evaluate(() => sessionStorage.getItem('skyryse-mes-server-token-v1'));
  assert.ok(token, 'the browser receives a server-managed session');
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, 'first-run sign-in initializes and loads the shared workspace');
  const workspace = await response.json();
  assert.equal(server.host.MES.validate(workspace), true, 'the browser and server use a valid Flight workspace');
  assert.equal(await page.evaluate(() => window.skServer.sync.status), 'synced');
  const snapshotCountBeforeActions = (await server.store.auditRows(1000)).filter(row => row.action === 'workspace-put').length;

  const priorityChange = await page.evaluate(() => {
    const next = structuredClone(state);
    const created = MES.addAdhocOrder(next, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: 'C3', partNumber: 'SERVER-TEST-001', title: 'Server persistence check', revision: 'A' });
    if (!created.ok) return { result: created };
    const result = MES.setPriority(next, created.id, 'High');
    if (result.ok) mediaCommit(next);
    return { id: created.id, result };
  });
  assert.equal(priorityChange.result.ok, true, 'the real Flight engine accepts the authorized change');
  await page.waitForFunction(async ({ port, token, id }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    const value = await response.json(); return value.orders.find(order => order.id === id)?.priority === 'High';
  }, { port, token, id: priorityChange.id }, { timeout: 15000 });
  const audit = await server.store.auditRows(1000);
  const recordedActions = audit.filter(row => row.action === 'action').map(row => JSON.parse(row.detail).action);
  assert.ok(recordedActions.includes('MES.addAdhocOrder'), 'work-order creation ran through the server MES action endpoint');
  assert.ok(recordedActions.includes('MES.setPriority'), 'the follow-up priority edit ran through the server MES action endpoint');
  const snapshotWrites = (await server.store.auditRows(1000)).filter(row => row.action === 'workspace-put');
  assert.equal(snapshotWrites.length, snapshotCountBeforeActions, 'record edits do not fall back to another full-workspace write');

  const supportChange = await page.evaluate(() => {
    window.__authSaved = false;
    window.addEventListener('sk-auth-saved', () => { window.__authSaved = true; }, { once: true });
    return window.skAuth.setSupportAccess('server-ui-admin', true, 'server UI profile persistence check');
  });
  assert.equal(supportChange.ok, true);
  await page.waitForFunction(() => window.__authSaved === true);
  assert.equal(server.store.account('server-ui-admin').supportAccess, true, 'account profile data persists in the server store');

  // Load a valid Building order so this browser-level check exercises the controlled evidence path.
  const fixtureHtml = await readFile(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
  const seedStart = fixtureHtml.indexOf('window.__DEMO_SEED=');
  assert.notEqual(seedStart, -1, 'the portable demo fixture contains its embedded workspace');
  const jsonStart = fixtureHtml.indexOf('{', seedStart);
  let depth = 0, inString = false, escaped = false, jsonEnd = -1;
  for (let i = jsonStart; i < fixtureHtml.length; i++) {
    const char = fixtureHtml[i];
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { jsonEnd = i + 1; break; }
  }
  assert.ok(jsonEnd > jsonStart, 'the portable fixture workspace JSON is balanced');
  const fixture = JSON.parse(fixtureHtml.slice(jsonStart, jsonEnd));
  const buildingOrder = fixture.orders.find(order => order.status === 'Building');
  assert.ok(buildingOrder, 'the fixture includes a Building order for evidence attachment');
  const currentWorkspace = server.store.getDoc('default');
  const fixtureEtag = server.store.putDoc('default', JSON.stringify(fixture), currentWorkspace.etag, 'server-ui-test-fixture');
  assert.ok(fixtureEtag, 'the test installs a valid portable Building workspace directly into its isolated test database');
  await page.evaluate(() => loadServerWorkspace());
  await page.evaluate(() => { view = 'plan'; render(); });
  await page.locator('#big3-heading').waitFor();
  assert.equal(await page.locator('[data-action="big3-create"]').count(), 1, `Flight Plan offers the actual user's daily priority plan`);
  await page.locator('[data-action="big3-create"]').click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced');
  const plannerWorkspaceResponse = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
  const plannerWorkspace = await plannerWorkspaceResponse.json();
  const plannerUser = 'server-ui-admin';
  const plannerDate = new Date().toISOString().slice(0, 10);
  assert.equal(plannerWorkspace.planner.days[plannerUser][plannerDate].big3.filter(slot => slot.t).length, 3, 'the server stores three derived proposals for the signed-in account');
  await page.locator('[data-action="big3-decide"][data-decision="accept"]').first().click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced');
  const acceptedWorkspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(acceptedWorkspace.planner.days[plannerUser][plannerDate].big3.some(slot => slot.status === 'accepted'), 'the server records a person accepting a proposed task');
  const timeInputs = page.locator('[data-action="big3-time-propose"]').first();
  const timeIndex = await timeInputs.getAttribute('data-index');
  await page.locator(`#big3-start-${timeIndex}`).fill('09:00');
  await page.locator(`#big3-end-${timeIndex}`).fill('10:00');
  await timeInputs.click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced');
  let timeWorkspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(timeWorkspace.planner.calendar.blocks.filter(block => block.status === 'Proposed').length, 1, 'the server stores a proposed calendar time block');
  await page.locator('[data-action="big3-time-decide"][data-decision="accept"]').click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced');
  timeWorkspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(timeWorkspace.planner.calendar.blocks[0].status, 'Accepted', "the server records the assigned person's time-block decision");
  await page.locator('.big3-reason[placeholder="Escalation reason"]').first().fill('Quality response is needed before the due date');
  await page.locator('[data-action="big3-escalate"]').first().click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced');
  const escalationWorkspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(escalationWorkspace.planner.calendar.escalations.length > 0, 'the server persists escalation to QA follow-up');

  const evidenceCheck = await page.evaluate(async () => {
    const order = state.orders.find(item => item.status === 'Building' && item.operations.some(operation => !operation.done));
    const operation = order?.operations.find(item => !item.done);
    if (!order || !operation) throw new Error('No unfinished Building operation is available for the evidence check.');
    const id = 'EV-12345678-1234-4234-8234-123456789abd';
    const bytes = new Blob(['browser controlled evidence fixture'], { type: 'video/webm' });
    await MESMedia.put(id, bytes);
    const next = structuredClone(state);
    const result = MES.attachEvidence(next, order.id, operation.id, { id, fileName: 'browser-evidence.webm', mimeType: bytes.type, size: bytes.size, source: 'upload', description: 'Browser evidence storage integration check' });
    if (!result.ok) throw new Error(result.message);
    mediaCommit(next);
    return { id, orderId: order.id, opId: operation.id, size: bytes.size };
  });
  await page.waitForFunction(async ({ port, token, id }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/evidence/${id}/meta`, { headers: { Authorization: `Bearer ${token}` } });
    return response.ok;
  }, { port, token, id: evidenceCheck.id }, { timeout: 15000 });
  const storedEvidence = await server.store.evidenceMeta(evidenceCheck.id);
  assert.equal(storedEvidence.size, evidenceCheck.size, 'the server stores the browser recording bytes');
  assert.ok(storedEvidence.sha256, 'the shared evidence copy has a SHA-256 digest');
  const fetchedEvidence = await page.evaluate(async id => {
    const blob = await MESMedia.get(id);
    return { size: blob.size, type: blob.type };
  }, evidenceCheck.id);
  assert.equal(fetchedEvidence.size, evidenceCheck.size, 'the browser can retrieve and verify the shared recording');
  assert.equal(fetchedEvidence.type, 'video/webm');
  assert.deepEqual(errors, []);
  console.log('server UI: first-run account, server session, shared workspace hydration, engine change persistence, account profile persistence and controlled evidence storage passed');
} finally {
  if (browser) await browser.close();
  await server.closeAsync();
}
