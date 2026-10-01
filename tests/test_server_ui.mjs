import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer, makeHash } from '../server/server.mjs';

const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'server-ui-setup-code' });
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
  await page.locator('#sk-setup').fill('server-ui-setup-code');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('#main .flight-react').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await page.evaluate(() => serverPush);

  const token = await page.evaluate(() => sessionStorage.getItem('skyryse-mes-server-token-v1'));
  assert.ok(token, 'the browser receives a server-managed session');
  const qaPassword = 'server-ui-qa-password';
  await server.store.upsertAccount({ username: 'server-ui-qa', displayName: 'Server UI QA Manager', salt: '', hash: await makeHash(qaPassword), role: 'qm', roles: ['qm'], createdAt: new Date().toISOString(), createdBy: 'server-ui-admin' });
  const qaLogin = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'server-ui-qa', password: qaPassword }) });
  assert.equal(qaLogin.status, 200, await qaLogin.clone().text());
  const qaToken = (await qaLogin.json()).token;
  await server.store.upsertAccount({ username: 'support-target', displayName: 'Support Target', salt: '', hash: 'test-only-hash', role: 'general', roles: ['general'], createdAt: new Date().toISOString(), createdBy: 'server-ui-admin' });
  await page.evaluate(async () => { const response = await window.skServer.api('/auth/accounts'); if (response.ok) window.skServer.context.auth = { users: response.json.users }; });
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
  // #157: the workspace can show the new priority a moment before its audit row is readable, so wait for the row
  // itself. A priority that reached the server another way never writes this row, and the full-workspace write
  // check below still fails for it.
  const actionsRecorded = async () => (await server.store.auditRows(1000)).filter(row => row.action === 'action').map(row => JSON.parse(row.detail).action);
  let recordedActions = await actionsRecorded();
  for (const until = Date.now() + 5000; !recordedActions.includes('MES.setPriority') && Date.now() < until;) {
    await new Promise(resolve => setTimeout(resolve, 100));
    recordedActions = await actionsRecorded();
  }
  assert.ok(recordedActions.includes('MES.addAdhocOrder'), 'work-order creation ran through the server MES action endpoint');
  assert.ok(recordedActions.includes('MES.setPriority'), 'the follow-up priority edit ran through the server MES action endpoint');
  const snapshotWrites = (await server.store.auditRows(1000)).filter(row => row.action === 'workspace-put');
  assert.equal(snapshotWrites.length, snapshotCountBeforeActions, 'record edits do not fall back to another full-workspace write');
  for (const action of ['containNC', 'effectivenessCheck', 'pfmeaSafetyBuyoff']) assert.equal(typeof server.host.resolveAction(`FlightManeuver.${action}`), 'function', `the server accepts ${action} through its authorized action boundary`);
  assert.equal(typeof server.host.resolveAction('MES.pruneExpiredNotices'), 'function', 'the server accepts expired announcement cleanup through its authorized action boundary');
  assert.deepEqual(await page.evaluate(() => ['containNC', 'effectivenessCheck', 'pfmeaSafetyBuyoff'].map(name => FlightManeuver[name].__serverCommandWrapped === true)), [true, true, true], 'the browser queues all three non-prefix-named quality commands for the server');
  assert.equal(await page.evaluate(() => MES.pruneExpiredNotices.__serverCommandWrapped === true), true, 'the browser routes background expired-announcement cleanup to the server');

  const supportChange = await page.evaluate(() => {
    window.__authSaved = false;
    window.addEventListener('sk-auth-saved', () => { window.__authSaved = true; }, { once: true });
    return window.skAuth.setSupportAccess('support-target', true, 'server UI profile persistence check');
  });
  assert.equal(supportChange.ok, true);
  await page.waitForFunction(() => window.__authSaved === true);
  assert.equal(server.store.account('support-target').supportAccess, true, 'account profile data persists in the server store');

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
  // The portable fixture has no unblocked non-inspection Building operation; temporarily clear a pending sequence change for the clock check, then restore it.
  const clockFixtureOrder = fixture.orders.find(order => order.status === 'Building' && order.operations.find(operation => !operation.done && !server.host.MES.isInspectionOp(operation)) && server.host.MES.pendingSequenceChange(order));
  assert.ok(clockFixtureOrder, 'the fixture exposes the pending sequence-change condition that blocks its otherwise eligible labor-clock operation');
  const clockSequenceChange = structuredClone(clockFixtureOrder.sequenceChange);
  const clockFixtureOrderId = clockFixtureOrder.id;
  delete clockFixtureOrder.sequenceChange;
  const aqiOrder = fixture.orders.find(order => order.id === 'WO-10002');
  const aqiPackage = aqiOrder?.conformity?.find(item => item.serial === 'FC-200-00001');
  assert.ok(aqiPackage?.form, 'the portable fixture includes a completed 8130-9 for the AQI server-action check');
  aqiPackage.status = '8130-9 completed';
  aqiPackage.aqi = null;
  aqiPackage.notified = null;
  aqiPackage.darApproval = null;
  aqiOrder.status = 'Quality';
  delete aqiOrder.closure;
  delete aqiOrder.closedAt;
  delete aqiOrder.closureRequest;
  // The package's 8130-9 was completed on the day the seed was captured, against the MDL copy received then, and a
  // completed 8130-9 locks the package data. A separate preparer re-completes it below through the production
  // path (void, record the current MDL copy, complete the form), so the AQI check does not depend on the calendar.
  const capturedForm = structuredClone(aqiPackage.form);
  const preparerStamp = fixture.stamps.find(stamp => stamp.buyoffType === 'Quality' && stamp.status === 'Active' && !stamp.account);
  assert.ok(preparerStamp, 'the fixture has an unassigned Quality stamp for the 8130-9 preparer');
  const aqiStamp = fixture.stamps.find(stamp => stamp.buyoffType === '8130-9 Authorized Inspector');
  assert.ok(aqiStamp, 'the fixture has an AQI stamp record');
  const credentialExpires = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  Object.assign(aqiStamp, { account: 'aqi-inspector', name: 'AQI Test Inspector', status: 'Active', expires: credentialExpires });
  const pinResult = server.host.withAccount(server.store.account('server-ui-admin'), () => server.host.MES.setStampPin(fixture, aqiStamp.id, '2468', '2468'), fixture);
  assert.equal(pinResult.ok, true, 'the QA manager sets a valid test PIN using the production PIN hashing path');
  const trainingResult = server.host.withAccount(server.store.account('server-ui-qa'), () => server.host.MES.recordTraining(fixture, { account: 'aqi-inspector', code: 'ESD', expires: credentialExpires, note: 'Server UI authorization fixture' }), fixture);
  assert.equal(trainingResult.ok, true, 'the QA manager records current training for the AQI test inspector');
  Object.assign(preparerStamp, { account: 'conf-preparer', name: 'Conformity Preparer', expires: credentialExpires });
  assert.equal(server.host.withAccount(server.store.account('server-ui-admin'), () => server.host.MES.setStampPin(fixture, preparerStamp.id, '1357', '1357'), fixture).ok, true, 'the QA manager sets the 8130-9 preparer stamp PIN');
  assert.equal(server.host.withAccount(server.store.account('server-ui-qa'), () => server.host.MES.recordTraining(fixture, { account: 'conf-preparer', code: 'ESD', expires: credentialExpires, note: 'Server UI conformity fixture' }), fixture).ok, true, 'the QA manager records current training for the 8130-9 preparer');
  const adminAccount = server.store.account('server-ui-admin');
  const inspectorAccount = { ...adminAccount, username: 'aqi-inspector', displayName: 'AQI Test Inspector', role: 'qe', roles: ['qe'], extraRoles: [], roleTraining: {}, grants: {}, grantHistory: [], supportAccess: false, createdBy: 'server-ui-admin' };
  await server.store.upsertAccount(inspectorAccount);
  assert.equal(server.host.MES.validate(fixture), true, `the browser fixture remains valid after adding qualified AQI test credentials: ${(server.host.MES.diagnose(fixture) || {}).detail || ''}`);
  assert.ok(server.host.MES.upgrade(fixture).orders.some(order => order.id === aqiOrder.id), 'the server migration retains the AQI package used by this test');
  const buildingOrder = fixture.orders.find(order => order.status === 'Building');
  assert.ok(buildingOrder, 'the fixture includes a Building order for evidence attachment');
  const currentWorkspace = server.store.getDoc('default');
  const fixtureEtag = server.store.putDoc('default', JSON.stringify(fixture), currentWorkspace.etag, 'server-ui-test-fixture');
  assert.ok(fixtureEtag, 'the test installs a valid portable Building workspace directly into its isolated test database');
  const grantResponse = await fetch(`http://127.0.0.1:${port}/api/auth/access`, { method: 'POST', headers: { Authorization: `Bearer ${qaToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'grant', username: 'aqi-inspector', cap: 'aqi-sign', reason: 'Current AQI qualification for the server UI integration test', trainingCode: 'ESD' }) });
  assert.equal(grantResponse.status, 200, await grantResponse.text());
  // Re-complete the 8130-9 against a current MDL copy through the server action route, as the preparer.
  const preparerPassword = 'conf-preparer-password';
  await server.store.upsertAccount({ username: 'conf-preparer', displayName: 'Conformity Preparer', salt: '', hash: await makeHash(preparerPassword), role: 'qe', roles: ['qe'], createdAt: new Date().toISOString(), createdBy: 'server-ui-admin' });
  const preparerGrant = await fetch(`http://127.0.0.1:${port}/api/auth/access`, { method: 'POST', headers: { Authorization: `Bearer ${qaToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'grant', username: 'conf-preparer', cap: 'conformity', reason: 'Current conformity qualification for the server UI integration test', trainingCode: 'ESD' }) });
  assert.equal(preparerGrant.status, 200, await preparerGrant.text());
  const preparerLogin = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'conf-preparer', password: preparerPassword }) });
  assert.equal(preparerLogin.status, 200, await preparerLogin.clone().text());
  const preparerToken = (await preparerLogin.json()).token;
  const preparerAction = async (name, args) => {
    const result = await fetch(`http://127.0.0.1:${port}/api/workspace/actions/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${preparerToken}`, 'Content-Type': 'application/json', 'If-Match': server.store.getDoc('default').etag }, body: JSON.stringify({ args }) });
    assert.equal(result.status, 200, `${name}: ${await result.clone().text()}`);
  };
  const today = new Date().toISOString().slice(0, 10);
  await preparerAction('MES.void8130_9', [aqiOrder.id, aqiPackage.serial, 'Re-completed against the current MDL copy for the server UI AQI check.']);
  await preparerAction('MES.saveConformity', [aqiOrder.id, aqiPackage.serial, { mdlReceived: today }]);
  const { section, item, make, model, registration, checkDate, basis } = capturedForm;
  await preparerAction('MES.complete8130_9', [aqiOrder.id, aqiPackage.serial, { section, item, make, model, registration, checkDate, basis }, { pin: '1357' }]);
  await preparerAction('MES.checkConformity', [aqiOrder.id, aqiPackage.serial, '6.1', true]);
  const recompleted = JSON.parse(server.store.getDoc('default').json), recompletedOrder = recompleted.orders.find(order => order.id === aqiOrder.id), recompletedPackage = recompletedOrder.conformity.find(part => part.serial === aqiPackage.serial);
  assert.equal(recompletedPackage.status, '8130-9 completed', 'the preparer completes a new 8130-9');
  assert.equal(recompletedPackage.mdlReceived, today, 'the new 8130-9 is completed against the MDL copy received today');
  assert.equal(recompletedPackage.form.prepared.by.credentialId, 'ACCT-conf-preparer', 'the new 8130-9 records its preparer, a different person from the AQI');
  assert.ok(recompletedPackage.voided.some(entry => entry.hash === capturedForm.prepared.manifest.hash), 'the void record keeps the hash of the form captured with the seed');
  const aqiGaps = server.host.MES.confGaps(recompleted, recompletedOrder, recompletedPackage, 'aqi');
  assert.equal(aqiGaps.length, 0, `the AQI package fixture has no open checklist gaps: ${JSON.stringify(aqiGaps)}`);
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
    const order = state.orders.find(item => { const operation = item.status === 'Building' ? item.operations[currentIndex(item)] : null; return operation && !operation.done && !operation.clock && !MES.isInspectionOp(operation) && !MES.engineeringChange(item) && !MES.pendingSequenceChange(item); });
    const operation = order?.operations[currentIndex(order)];
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
  const currentClockDoc = server.store.getDoc('default'), restoredClockState = JSON.parse(currentClockDoc.json);
  restoredClockState.orders.find(order => order.id === clockFixtureOrderId).sequenceChange = clockSequenceChange;
  assert.ok(server.store.putDoc('default', JSON.stringify(restoredClockState), currentClockDoc.etag, 'server-ui-test-fixture'), 'the pending sequence-change fixture is restored after the clock scenario');
  await page.evaluate(() => loadServerWorkspace());
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
  await page.evaluate(() => { view = 'plan'; render(); });
  await page.locator('#big3-heading').waitFor();
  assert.equal(await page.locator('[data-action="big3-create"]').count(), 1, `Flight Plan offers the actual user's daily priority plan`);
  // #137: the page keys the plan by the UTC day at the click. Read the day before the click and take whichever of
  // that day or the one after the server stored, so a run that crosses 00:00 UTC here does not look up the wrong day.
  const plannerDayBefore = new Date().toISOString().slice(0, 10);
  await page.locator('[data-action="big3-create"]').click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced');
  const plannerWorkspaceResponse = await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
  const plannerWorkspace = await plannerWorkspaceResponse.json();
  const plannerUser = 'server-ui-admin';
  const plannerDays = plannerWorkspace.planner.days[plannerUser] || {};
  const plannerDate = [plannerDayBefore, new Date().toISOString().slice(0, 10)].find(day => plannerDays[day]);
  assert.ok(plannerDate, `the server stores a planner day for the signed-in account: ${Object.keys(plannerDays).join(', ')}`);
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

  // #292: the recovery banner clears once the same account has a later write confirmed by the server, and only then.
  const RECOVERY_STORAGE_KEY = 'skyryse-mes-work-order-v1-unconfirmed-server-recovery-v1';
  // A change counts as the person's only after their own input, so each change below follows a real key press
  // unless the check is about a change made without one.
  // Priorities toggle between High and Normal: an AOG order would start the page's own AOG broadcast tick mid-check.
  const recoveryPriorityChange = async (refuse, personInput = true, target = null) => {
    if (personInput) await page.keyboard.press('Shift');
    return recoveryPriorityEvaluate({ refuse, target });
  };
  const recoveryPriorityEvaluate = ({ refuse, target }) => page.evaluate(({ refuse, target }) => {
    const order = state.orders.find(item => item.status === 'Building');
    if (!order) throw new Error('No Building order is available for the recovery banner check.');
    const next = target || (order.priority === 'High' ? 'Normal' : 'High');
    if (!window.__recoveryApi) {
      const api = window.skServer.api.bind(window.skServer);
      window.__recoveryApi = true;
      window.skServer.api = async (path, options) => {
        if (window.__refusePriority && String(path).includes('/workspace/actions/MES.setPriority')) {
          window.__refusePriority = false;
          return { status: 403, json: { error: 'Controlled recovery banner refusal' } };
        }
        return api(path, options);
      };
    }
    window.__refusePriority = refuse;
    window.skServer.sync = { status: 'pending-check', message: '' };
    const result = MES.setPriority(state, order.id, next);
    if (!result.ok) throw new Error(result.message);
    save();
  }, { refuse, target });
  const recoveryState = () => page.evaluate(key => ({
    banner: !!document.querySelector('#flight-server-recovery'),
    memory: !!unconfirmedServerRecovery,
    stored: sessionStorage.getItem(key) !== null
  }), RECOVERY_STORAGE_KEY);

  const recoveryStartPriority = await page.evaluate(() => state.orders.find(item => item.status === 'Building')?.priority);
  await recoveryPriorityChange(true);
  await page.waitForFunction(() => window.skServer?.sync?.status === 'error', null, { timeout: 10000 });
  await page.locator('#flight-server-recovery').waitFor({ state: 'visible', timeout: 10000 });
  await recoveryPriorityChange(true);
  await page.waitForFunction(() => window.skServer?.sync?.status === 'error', null, { timeout: 10000 });
  assert.deepEqual(await recoveryState(), { banner: true, memory: true, stored: true }, 'a second refused change keeps the recovery banner and its copy');
  await recoveryPriorityChange(false);
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 10000 });
  assert.deepEqual(await recoveryState(), { banner: false, memory: false, stored: false }, 'a later change confirmed by the server for the same account clears the recovery banner and its copy');

  // A confirmed write clears only a copy that belongs to the signed-in account and existed when the write was sent.
  // (Reloading the shared workspace already removes another account's copy from view; this checks the clear itself.)
  await recoveryPriorityChange(true);
  await page.waitForFunction(() => window.skServer?.sync?.status === 'error', null, { timeout: 10000 });
  await page.locator('#flight-server-recovery').waitFor({ state: 'visible', timeout: 10000 });
  const guarded = await page.evaluate(() => {
    const own = unconfirmedServerRecovery;
    const other = { ...own, username: 'different-account' };
    unconfirmedServerRecovery = other;
    sessionStorage.setItem(SERVER_RECOVERY_KEY, JSON.stringify(other));
    clearConfirmedServerRecovery(other);
    const otherKept = unconfirmedServerRecovery === other && sessionStorage.getItem(SERVER_RECOVERY_KEY) !== null && !!document.querySelector('#flight-server-recovery');
    unconfirmedServerRecovery = own;
    sessionStorage.setItem(SERVER_RECOVERY_KEY, JSON.stringify(own));
    clearConfirmedServerRecovery({ ...own });
    const staleKept = unconfirmedServerRecovery === own && sessionStorage.getItem(SERVER_RECOVERY_KEY) !== null;
    clearConfirmedServerRecovery(null);
    const noneKept = unconfirmedServerRecovery === own && sessionStorage.getItem(SERVER_RECOVERY_KEY) !== null;
    return { otherKept, staleKept, noneKept };
  });
  assert.deepEqual(guarded, { otherKept: true, staleKept: true, noneKept: true }, "a confirmed write does not clear another account's recovery copy, a newer copy, or a copy made after it was sent");
  // A change confirmed by the server that the page made on its own keeps the copy, even right after the person's
  // input: credential binding after sign-in or load sends MES.selectProfile as an automatic change.
  await page.keyboard.press('Shift');
  const binding = await page.evaluate(async () => {
    const own = unconfirmedServerRecovery, sent = [], api = window.skServer.api;
    window.skServer.api = async (path, options) => { if (options?.method) sent.push(String(path)); return api(path, options); };
    try {
      state.profile.role = 'unbound-role-check';
      window.skBindCredential();
      await serverActionChain;
    } finally { window.skServer.api = api; }
    return { sent: sent.includes('/workspace/actions/MES.selectProfile'), status: window.skServer.sync.status, kept: unconfirmedServerRecovery === own && sessionStorage.getItem(SERVER_RECOVERY_KEY) !== null && !!document.querySelector('#flight-server-recovery') };
  });
  assert.deepEqual(binding, { sent: true, status: 'synced', kept: true }, 'a confirmed automatic credential binding does not clear the recovery copy');
  // A change with no input from the person behind it keeps the copy as well.
  await page.evaluate(() => { serverLastPersonInput = 0; });
  await recoveryPriorityChange(false, false);
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 10000 });
  assert.deepEqual(await recoveryState(), { banner: true, memory: true, stored: true }, 'a confirmed change that did not follow the person\'s input does not clear the recovery copy');
  await page.evaluate(() => document.querySelector('[data-action="dismiss-server-recovery"]').click());
  assert.deepEqual(await recoveryState(), { banner: false, memory: false, stored: false }, 'Dismiss still clears the recovery banner and its copy');
  // Put the order back to its starting priority for the checks that follow.
  if (await page.evaluate(() => state.orders.find(item => item.status === 'Building')?.priority) !== recoveryStartPriority) {
    await recoveryPriorityChange(false, true, recoveryStartPriority);
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 10000 });
  }

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
  // Archived work orders stay traceable: the React trace view lists the server's archive matches.
  const archivedRows = await server.store.archiveSearch('', 10);
  assert.ok(archivedRows.length, 'the server has archived a closed work order by now');
  const archivedId = archivedRows[0].orderId;
  assert.equal(await page.evaluate(id => state.orders.some(order => order.id === id), archivedId), false, 'the archived order has left the live workspace');
  await page.evaluate(id => { traceQuery = id; view = 'trace'; render(); }, archivedId);
  const archiveSection = page.locator('.fr-trace-section').filter({ has: page.getByRole('heading', { name: 'Archived work orders' }) });
  await archiveSection.waitFor({ timeout: 10000 });
  assert.match(await archiveSection.innerText(), new RegExp(archivedId), 'the archived work order is found by trace search');
  // The archived record opens from the app: the export downloads the signed extract, the print opens the stamped record.
  const [download] = await Promise.all([page.waitForEvent('download'), archiveSection.getByRole('button', { name: `Export archived ${archivedId}` }).click()]);
  const exportedArchive = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(JSON.stringify([exportedArchive.kind, exportedArchive.order.id]), JSON.stringify(['archived-work-order', archivedId]), 'Export downloads the archived record');
  assert.match(exportedArchive.exportId, /^EXT-[A-F0-9]{32}$/);
  const [printed] = await Promise.all([page.context().waitForEvent('page'), archiveSection.getByRole('button', { name: `Print archived ${archivedId}` }).click()]);
  await printed.waitForURL(/^blob:/);
  await printed.waitForLoadState();
  assert.match(await printed.content(), /flight-extract-stamp/, 'Print opens the stamped archived record');
  await printed.close();
  assert.equal(JSON.stringify((await server.store.extractHistory('work-order', archivedId)).map(row => row.kind).sort()), JSON.stringify(['json-download', 'print']), 'both extracts are recorded against the archived order');
  assert.deepEqual(errors, []);
  console.log('server UI: account session, shared workspace, authorized changes, refused-edit recovery, account profiles and controlled evidence passed');
} finally {
  if (aqiPage) await aqiPage.close();
  if (browser) await browser.close();
  await server.closeAsync();
}
