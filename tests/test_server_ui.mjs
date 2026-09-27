import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true });
let browser;
let aqiPage;
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
  for (const action of ['containNC', 'effectivenessCheck', 'pfmeaSafetyBuyoff']) assert.equal(typeof server.host.resolveAction(`FlightManeuver.${action}`), 'function', `the server accepts ${action} through its authorized action boundary`);
  assert.deepEqual(await page.evaluate(() => ['containNC', 'effectivenessCheck', 'pfmeaSafetyBuyoff'].map(name => FlightManeuver[name].__serverCommandWrapped === true)), [true, true, true], 'the browser queues all three non-prefix-named quality commands for the server');

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
  const aqiOrder = fixture.orders.find(order => order.id === 'WO-10002');
  const aqiPackage = aqiOrder?.conformity?.find(item => item.serial === 'FC-200-00001');
  assert.ok(aqiPackage?.form, 'the portable fixture includes a completed 8130-9 for the AQI server-action check');
  aqiPackage.status = '8130-9 completed';
  aqiPackage.aqi = null;
  aqiPackage.notified = null;
  aqiPackage.darApproval = null;
  aqiPackage.form.prepared.by.credentialId = 'ACCT-independent-inspector';
  aqiOrder.status = 'Quality';
  delete aqiOrder.closure;
  delete aqiOrder.closedAt;
  delete aqiOrder.closureRequest;
  assert.equal(server.host.MES.confGaps(fixture, aqiOrder, aqiPackage, 'aqi').length, 0, 'the AQI package fixture has no open checklist gaps');
  const aqiStamp = fixture.stamps.find(stamp => stamp.buyoffType === '8130-9 Authorized Inspector');
  assert.ok(aqiStamp, 'the fixture has an AQI stamp record');
  Object.assign(aqiStamp, { account: 'aqi-inspector', name: 'AQI Test Inspector', status: 'Active', expires: '2027-12-31' });
  const pinResult = server.host.withAccount(server.store.account('server-ui-admin'), () => server.host.MES.setStampPin(fixture, aqiStamp.id, '2468', '2468'), fixture);
  assert.equal(pinResult.ok, true, 'the QA manager sets a valid test PIN using the production PIN hashing path');
  const trainingResult = server.host.withAccount(server.store.account('server-ui-admin'), () => server.host.MES.recordTraining(fixture, { account: 'aqi-inspector', code: 'ESD', expires: '2027-12-31', note: 'Server UI authorization fixture' }), fixture);
  assert.equal(trainingResult.ok, true, 'the QA manager records current training for the AQI test inspector');
  const adminAccount = server.store.account('server-ui-admin');
  const grant = { account: 'aqi-inspector', authority: 'aqi-sign', action: 'granted', by: { name: adminAccount.displayName, credentialId: 'ACCT-server-ui-admin', account: 'server-ui-admin' }, at: new Date().toISOString(), reason: 'Current AQI qualification for the server UI integration test', trainingCode: 'ESD' };
  const grantHash = server.host.MES.sha256(server.host.MES.canonical(grant));
  const inspectorAccount = { ...adminAccount, username: 'aqi-inspector', displayName: 'AQI Test Inspector', role: 'qe', roles: ['qe'], extraRoles: [], roleTraining: {}, grants: { 'aqi-sign': { by: grant.by, at: grant.at, reason: grant.reason, trainingCode: grant.trainingCode, hash: grantHash } }, grantHistory: [{ ...grant, hash: grantHash }], supportAccess: false, createdBy: 'server-ui-admin' };
  server.store.upsertAccount(inspectorAccount);
  assert.equal(server.host.MES.validate(fixture), true, `the browser fixture remains valid after adding qualified AQI test credentials: ${(server.host.MES.diagnose(fixture) || {}).detail || ''}`);
  assert.ok(server.host.MES.upgrade(fixture).orders.some(order => order.id === aqiOrder.id), 'the server migration retains the AQI package used by this test');
  const buildingOrder = fixture.orders.find(order => order.status === 'Building');
  assert.ok(buildingOrder, 'the fixture includes a Building order for evidence attachment');
  const currentWorkspace = server.store.getDoc('default');
  const fixtureEtag = server.store.putDoc('default', JSON.stringify(fixture), currentWorkspace.etag, 'server-ui-test-fixture');
  assert.ok(fixtureEtag, 'the test installs a valid portable Building workspace directly into its isolated test database');
  const installed = JSON.parse(server.store.getDoc('default').json);
  assert.ok(installed.orders.some(order => order.id === aqiOrder.id && order.conformity?.some(part => part.serial === aqiPackage.serial)), `the database installs the AQI package: ${installed.orders.map(order => order.id).join(', ')}`);
  await page.evaluate(() => loadServerWorkspace());
  aqiPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const aqiErrors = [];
  aqiPage.on('pageerror', error => aqiErrors.push(error.message));
  await aqiPage.goto(`http://127.0.0.1:${port}/`);
  await aqiPage.locator('#sk-login').waitFor({ state: 'visible' });
  await aqiPage.locator('#sk-username').fill('aqi-inspector');
  await aqiPage.locator('#sk-password').fill('server-ui-password');
  await aqiPage.locator('#sk-login-submit').click();
  await aqiPage.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await aqiPage.locator('#main .flight-react').waitFor({ timeout: 15000 });
  await aqiPage.evaluate(() => loadServerWorkspace());
  await aqiPage.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await aqiPage.evaluate(({ orderId }) => { selectedId = orderId; selectedOp = null; view = 'order'; tab = 'quality'; render(); }, { orderId: aqiOrder.id });
  const aqiClientRoute = await aqiPage.evaluate(async () => { const order=state.orders.find(item=>item.id==='WO-10002'), response=await window.skServer.api('/workspace'); return { wrapped: MES.aqiSign8130_9.__serverCommandWrapped === true, active: window.skServer.active, hasToken: !!window.skServer.token(), before: order?.conformity?.[0]?.status||null, orderIds: state.orders.map(item=>item.id), permitted: window.skAuth.can('aqi-sign'), account: window.skAuth.user()?.username, apiStatus: response.status, apiOrderIds: response.json?.orders?.map(item=>item.id) }; });
  assert.equal(aqiClientRoute.before, '8130-9 completed', `the AQI session loads the shared package: ${JSON.stringify(aqiClientRoute)}`);
  const aqiRequests = [];
  aqiPage.on('request', request => { if (request.url().includes('/workspace/actions/MES.aqiSign8130_9')) aqiRequests.push(request.url()); });
  await aqiPage.locator('#main [data-action="conf-wizard"][data-order="WO-10002"]').click();
  const aqiSubmit = aqiPage.locator('#dialog form[data-form="conf-aqi"] button[type="submit"]');
  assert.equal(await aqiSubmit.isEnabled(), true, 'the authorized inspector sees an enabled AQI signature form');
  await aqiPage.locator('#dialog form[data-form="conf-aqi"] [name="pin"]').fill('2468');
  await aqiSubmit.click();
  await aqiPage.waitForTimeout(100);
  const aqiOutcome = await aqiPage.evaluate(() => ({ status: state.orders.find(order => order.id === 'WO-10002')?.conformity?.[0]?.status, error: document.querySelector('#dialog form[data-form="conf-aqi"] .form-error')?.textContent || '', pending: serverActionPending, queued: serverActionQueue.length }));
  await aqiPage.waitForFunction(async ({ port, token }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    const value = await response.json(), item = value.orders.find(order => order.id === 'WO-10002')?.conformity?.find(part => part.serial === 'FC-200-00001');
    return item?.status === 'AQI signed' && item.aqi?.by?.credentialId === 'ACCT-aqi-inspector';
  }, { port, token: await aqiPage.evaluate(() => window.skServer.token()) }, { timeout: 15000 });
  await aqiPage.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await page.waitForFunction(async ({ port, token }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    const value = await response.json(), item = value.orders.find(order => order.id === 'WO-10002')?.conformity?.find(part => part.serial === 'FC-200-00001');
    return item?.status === 'AQI signed' && item.aqi?.by?.credentialId === 'ACCT-aqi-inspector';
  }, { port, token }, { timeout: 15000 });
  const aqiActions = (await server.store.auditRows(1000)).filter(row => row.action === 'action').map(row => JSON.parse(row.detail).action);
  assert.ok(aqiActions.includes('MES.aqiSign8130_9'), `the 8130-9 AQI signature runs through the authorized server command and persists its signer; actions: ${aqiActions.join(', ')}; route requests: ${aqiRequests.length}; client: ${JSON.stringify(aqiClientRoute)}; result: ${JSON.stringify(aqiOutcome)}`);
  assert.deepEqual(aqiErrors, [], 'the qualified AQI browser session has no client errors');
  await page.evaluate(() => loadServerWorkspace());
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  const clockTarget = await page.evaluate(() => {
    const order = state.orders.find(item => item.status === 'Building' && item.operations.find(operation => !operation.done) && !item.operations.find(operation => !operation.done).clock);
    const operation = order?.operations.find(item => !item.done);
    if (!order || !operation) throw new Error('No current Building operation is available for the labor clock check.');
    selectedId = order.id; selectedOp = operation.id; tab = 'operations'; view = 'order'; render();
    return { orderId: order.id, operationId: operation.id };
  });
  await page.locator('#operation-detail [data-action="labor-clock"]').click();
  await page.waitForFunction(async ({ port, token, orderId, operationId }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    const value = await response.json(), order = value.orders.find(item => item.id === orderId);
    return order?.operations.find(item => item.id === operationId)?.clock?.person?.credentialId === 'ACCT-server-ui-admin';
  }, { port, token, ...clockTarget }, { timeout: 15000 });
  const clockActions = (await server.store.auditRows(1000)).filter(row => row.action === 'action').map(row => JSON.parse(row.detail).action);
  assert.ok(clockActions.includes('MES.clockOnOperation'), 'starting a labor clock uses the authorized server command and stores the actor');
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

  const refusalCheck = await page.evaluate(() => {
    const order = state.orders.find(item => item.status === 'Building');
    if (!order) throw new Error('No Building order is available for the server refusal check.');
    const previous = order.priority, next = previous === 'AOG' ? 'Normal' : 'AOG';
    const api = window.skServer.api.bind(window.skServer);
    window.__rejectNextPriorityAction = true;
    window.skServer.api = async (path, options) => {
      if (window.__rejectNextPriorityAction && String(path).includes('/workspace/actions/MES.setPriority')) {
        window.__rejectNextPriorityAction = false;
        return { status: 403, json: { error: 'Controlled server refusal check' } };
      }
      return api(path, options);
    };
    const result = MES.setPriority(state, order.id, next);
    if (!result.ok) throw new Error(result.message);
    save();
    return { id: order.id, previous, next };
  });
  await page.waitForFunction(() => window.skServer?.sync?.status === 'error', null, { timeout: 10000 });
  await page.waitForFunction(({ id, previous }) => state.orders.find(item => item.id === id)?.priority === previous, refusalCheck, { timeout: 10000 });
  const refusalServerWorkspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(refusalServerWorkspace.orders.find(item => item.id === refusalCheck.id)?.priority, refusalCheck.previous, 'a definite server refusal discards the unaccepted client edit and reloads the committed record');
  assert.match(await page.locator('#flight-server-sync').getAttribute('title'), /refused/i, 'the sync status explains the refusal after reconciliation');
  await page.locator('#flight-server-recovery').waitFor({ state: 'visible', timeout: 10000 });
  const [recoveryDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="download-server-recovery"]').click()
  ]);
  const recoveryPath = await recoveryDownload.path();
  const recovery = JSON.parse(await readFile(recoveryPath, 'utf8'));
  assert.equal(recovery.type, 'Flight System unconfirmed server recovery', 'refused edits are downloadable with an explicit unconfirmed warning');
  assert.equal(recovery.username, 'server-ui-admin', 'the recovery copy is bound to the account that made the refused edit');
  assert.equal(recovery.workspace.orders.find(item => item.id === refusalCheck.id)?.priority, refusalCheck.next, 'the recovery file preserves the refused local change for manual reconciliation');
  await page.reload();
  await page.locator('#main .flight-react').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await page.locator('#flight-server-recovery').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate(() => {
    unconfirmedServerRecovery.username = 'different-account';
    sessionStorage.setItem(SERVER_RECOVERY_KEY, JSON.stringify(unconfirmedServerRecovery));
    showUnconfirmedServerRecovery();
  });
  assert.equal(await page.locator('#flight-server-recovery').count(), 0, 'a recovery copy is removed rather than exposed to another account');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('skyryse-mes-work-order-v1-unconfirmed-server-recovery-v1')), null);

  const snapshotRefusal = await page.evaluate(() => {
    const order = state.orders.find(item => item.status === 'Building');
    if (!order) throw new Error('No Building order is available for the snapshot refusal check.');
    const previous = order.priority, next = previous === 'AOG' ? 'Normal' : 'AOG';
    const api = window.skServer.api.bind(window.skServer);
    window.__rejectNextWorkspaceSnapshot = true;
    window.skServer.api = async (path, options) => {
      if (window.__rejectNextWorkspaceSnapshot && path === '/workspace' && options?.method === 'PUT') {
        window.__rejectNextWorkspaceSnapshot = false;
        return { status: 403, json: { error: 'Controlled snapshot refusal check' } };
      }
      return api(path, options);
    };
    order.priority = next;
    save();
    return { id: order.id, previous, next };
  });
  await page.waitForFunction(({ id, previous }) => state.orders.find(item => item.id === id)?.priority === previous, snapshotRefusal, { timeout: 10000 });
  const snapshotRefusalWorkspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(snapshotRefusalWorkspace.orders.find(item => item.id === snapshotRefusal.id)?.priority, snapshotRefusal.previous, 'a refused legacy snapshot reloads the server record instead of leaving an unshared edit on screen');
  assert.match(await page.locator('#flight-server-sync').getAttribute('title'), /refused/i, 'the snapshot refusal remains visible after server reconciliation');

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
  console.log('server UI: account session, shared workspace, authorized changes, refused-edit recovery, account profiles and controlled evidence passed');
} finally {
  if (aqiPage) await aqiPage.close();
  if (browser) await browser.close();
  await server.closeAsync();
}
