import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, makeHash } from '../server/server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-jira-'));
let posts = [];
let server = createServer({
  dbPath: path.join(dir, 'flight.sqlite'), quiet: true, setupCode: 'jira-test-setup-code',
  jira: { baseUrl: 'https://skyryse.atlassian.net', email: 'flight-connector@example.invalid', apiToken: 'test-only-secret' },
  jiraFetch: async (url, options) => {
    const body = JSON.parse(options.body);
    posts.push({ url, options, body });
    if (body.fields.summary.includes('uncertain response')) throw new Error('simulated timeout after request');
    if (body.fields.summary.includes('rejected once') && !posts.some(post => post !== posts.at(-1) && post.body?.fields?.summary.includes('rejected once'))) return new Response(JSON.stringify({ errors: { issuetype: 'The issue type selected is invalid.' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (body.fields.summary.includes('server error')) return new Response('upstream failure', { status: 500 });
    return new Response(JSON.stringify({ key: `ECR-${100 + posts.length}` }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
});

try {
  await server.ready;
  const port = await server.listenAsync(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/api`;
  const api = async (method, route, body, token) => {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, json, etag: response.headers.get('etag') };
  };
  const adminHash = await makeHash('flight-password-test');
  const created = await api('PUT', '/auth/accounts', { setupCode: 'jira-test-setup-code', users: [{ username: 'jira-admin', displayName: 'Jira Admin', role: 'admin', salt: '', hash: adminHash }] });
  assert.equal(created.status, 200);
  const login = await api('POST', '/auth/session', { username: 'jira-admin', password: 'flight-password-test' });
  assert.equal(login.status, 200);
  let token = login.json.token;

  const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
  const seed = JSON.parse(fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
  const owner = { username: 'jira-admin', displayName: 'Jira Admin', role: 'admin', roles: ['admin'] };
  const requestECR = (title, description) => server.host.withAccount(owner, () => server.host.MES.submitECRRequest(seed, { type: 'design', title, description, reason: 'Verify the Jira server integration safely.', partNumber: seed.orders[0].partNumber }), seed);
  const first = requestECR('Server-created ECR', 'Canonical Flight description for the ECR.');
  const uncertain = requestECR('uncertain response ECR', 'This request simulates a lost Jira response.');
  const rejected = requestECR('rejected once ECR', 'Jira refuses the first request because of a configuration error.');
  const serverError = requestECR('server error ECR', 'Jira answers with a server error, so the result is uncertain.');
  const maneuverRecords = server.host.withAccount(owner, () => {
    const spr = server.host.FlightManeuver.raiseSPR(seed, { title: 'Test report', foundAt: 'SIL', occurred: '2026-09-01', partNumber: seed.orders[0].partNumber, description: 'Canonical Flight SPR description.' });
    const car = server.host.FlightManeuver.raiseCAR(seed, { title: 'Supplier issue', description: 'Canonical Flight supplier description.', sourceType: 'Customer feedback', severity: 'Major', dueDate: '2099-12-31', ref: 'Integration contract test' });
    const scar = car.ok && server.host.FlightManeuver.requestSCAR(seed, car.id, 'Flight Test Supplier');
    return { spr, car, scar };
  }, seed);
  assert.equal(first.ok, true);
  assert.equal(uncertain.ok, true);
  assert.equal(rejected.ok, true);
  assert.equal(serverError.ok, true);
  assert.equal(maneuverRecords.spr.ok, true);
  assert.equal(maneuverRecords.car.ok, true);
  assert.equal(maneuverRecords.scar.ok, true);
  assert.equal((await api('PUT', '/workspace', seed, token)).status, 204);

  assert.equal((await api('POST', '/jira/issue', { recordType: 'ECR', recordId: first.id })).status, 401);
  const invalid = await api('POST', '/jira/issue', { recordType: 'WORKSPACE', recordId: first.id }, token);
  assert.equal(invalid.status, 400);

  const pushed = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: first.id, summary: 'attacker-controlled title', project: 'EVIL' }, token);
  assert.equal(pushed.status, 200);
  assert.equal(pushed.json.issue.key, 'ECR-101');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://skyryse.atlassian.net/rest/api/3/issue');
  assert.equal(posts[0].options.headers.Authorization, `Basic ${Buffer.from('flight-connector@example.invalid:test-only-secret').toString('base64')}`);
  assert.equal(posts[0].body.fields.project.key, 'ECR');
  assert.equal(posts[0].body.fields.summary, `[${seed.orders[0].partNumber}] Server-created ECR`);
  assert.deepEqual(posts[0].body.fields.labels, [`flight-mes-ecr-${first.id.toLowerCase()}`]);
  assert.equal(posts[0].body.fields.description.type, 'doc');
  assert.equal(JSON.stringify(posts[0].body).includes('attacker-controlled title'), false);

  const duplicate = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: first.id }, token);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(posts.length, 1);
  let workspace = (await api('GET', '/workspace', undefined, token)).json;
  const linked = workspace.ecrRequests.find(row => row.id === first.id);
  assert.equal(linked.jira.key, 'ECR-101');
  assert.equal(linked.status, 'In Jira');

  const pushedSPR = await api('POST', '/jira/issue', { recordType: 'SPR', recordId: maneuverRecords.spr.id }, token);
  assert.equal(pushedSPR.status, 200);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.fields.project.key, 'SPR');
  assert.deepEqual(posts[1].body.fields.labels, [`flight-mes-spr-${maneuverRecords.spr.id.toLowerCase()}`]);
  assert.equal((await api('POST', '/jira/issue', { recordType: 'SPR', recordId: maneuverRecords.spr.id }, token)).json.duplicate, true);
  assert.equal(posts.length, 2);
  const pushedSCAR = await api('POST', '/jira/issue', { recordType: 'SCAR', recordId: maneuverRecords.car.id }, token);
  assert.equal(pushedSCAR.status, 200);
  assert.equal(posts.length, 3);
  assert.equal(posts[2].body.fields.project.key, 'SCAR');
  assert.equal((await api('GET', '/workspace', undefined, token)).json.maneuver.sprs.find(row => row.id === maneuverRecords.spr.id).jira.key, 'ECR-102');
  assert.equal((await api('GET', '/workspace', undefined, token)).json.maneuver.cars.find(row => row.id === maneuverRecords.car.id).scar.jira.key, 'ECR-103');

  // A definite refusal creates no issue: the record can be sent again once the configuration is fixed.
  const refused = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: rejected.id }, token);
  assert.equal(refused.status, 502, JSON.stringify(refused.json));
  assert.equal(refused.json.code, 'JIRA_REJECTED');
  assert.match(refused.json.error, /created no issue/);
  const resent = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: rejected.id }, token);
  assert.equal(resent.status, 200, JSON.stringify(resent.json));
  assert.match(resent.json.issue.key, /^ECR-\d+$/);
  // A server error may have created the issue, so it stays uncertain and is not resent.
  const upstream = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: serverError.id }, token);
  assert.equal(upstream.json.code, 'JIRA_RESULT_UNKNOWN');
  assert.equal((await api('POST', '/jira/issue', { recordType: 'ECR', recordId: serverError.id }, token)).status, 409);
  const lost = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: uncertain.id }, token);
  assert.equal(lost.status, 502);
  assert.equal(lost.json.code, 'JIRA_RESULT_UNKNOWN');
  const callsAtTimeout = posts.length;
  const retry = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: uncertain.id }, token);
  assert.equal(retry.status, 409);
  assert.equal(retry.json.code, 'JIRA_RESULT_UNKNOWN');
  assert.equal(posts.length, callsAtTimeout, 'an uncertain Jira response must not be sent twice');

  const readerHash = await makeHash('reader-password-test');
  const persistedAdminHash = (await server.store.account('jira-admin')).hash;
  const reader = await api('PUT', '/auth/accounts', { users: [
    { username: 'jira-admin', displayName: 'Jira Admin', role: 'admin', salt: '', hash: persistedAdminHash },
    { username: 'reader', displayName: 'Read Only', role: 'general', salt: '', hash: readerHash }
  ] }, token);
  assert.equal(reader.status, 200);
  const readerToken = (await api('POST', '/auth/session', { username: 'reader', password: 'reader-password-test' })).json.token;
  const forbidden = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: uncertain.id }, readerToken);
  assert.equal(forbidden.status, 403);
  assert.equal(posts.length, callsAtTimeout);

  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.doesNotMatch(page, /test-only-secret|flight-connector@example\.invalid/);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const ui = await browser.newPage();
    await ui.goto(`http://127.0.0.1:${port}/`);
    await ui.locator('#sk-username').fill('jira-admin');
    await ui.locator('#sk-password').fill('flight-password-test');
    await ui.locator('#sk-login-submit').click();
    await ui.waitForFunction(() => window.skServer?.active && typeof window.MES?.upgrade === 'function');
    await ui.waitForFunction(() => Boolean(window.skServer?.etag));
    await ui.evaluate(id => { const button=document.createElement('button');button.type='button';button.dataset.action='ecr-jira';button.dataset.id=id;button.textContent='Open Jira request';document.body.append(button); }, first.id);
    await ui.locator('[data-action="ecr-jira"]').evaluate(button => button.click());
    await ui.getByRole('button', { name: 'Send this ECR to Jira' }).click();
    await ui.waitForFunction(() => !document.querySelector('#dialog')?.open);
  assert.equal(posts.length, callsAtTimeout, 'the UI retry must reuse the existing linked Jira issue');
  } finally { await browser.close(); }
  token = (await api('POST', '/auth/session', { username: 'jira-admin', password: 'flight-password-test' })).json.token;
  await server.closeAsync();
  server = createServer({
    dbPath: path.join(dir, 'flight.sqlite'), quiet: true,
    jira: { baseUrl: 'https://skyryse.atlassian.net', email: 'flight-connector@example.invalid', apiToken: 'test-only-secret' },
    jiraFetch: async () => { posts.push({ unexpectedRetry: true }); return new Response(JSON.stringify({ key: 'ECR-9999' }), { status: 201 }); }
  });
  await server.ready;
  const restartedPort = await server.listenAsync(0, '127.0.0.1');
  const restartedBase = `http://127.0.0.1:${restartedPort}/api`;
  const afterRestart = async (recordId) => {
    const response = await fetch(restartedBase + '/jira/issue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ recordType: 'ECR', recordId }) });
    const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, json };
  };
  const linkedAgain = await afterRestart(first.id);
  assert.equal(linkedAgain.status, 200);
  assert.equal(linkedAgain.json.issue.key, 'ECR-101');
  const sprAgain = await fetch(restartedBase + '/jira/issue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ recordType: 'SPR', recordId: maneuverRecords.spr.id }) });
  assert.equal(sprAgain.status, 200);
  const uncertainAgain = await afterRestart(uncertain.id);
  assert.equal(uncertainAgain.status, 409);
  assert.equal(uncertainAgain.json.code, 'JIRA_RESULT_UNKNOWN');
  assert.equal(posts.length, callsAtTimeout, 'the idempotency record must survive server restart');

  const invalidServer = createServer({ dbPath: ':memory:', quiet: true, jira: { baseUrl: 'http://jira.example.invalid', email: 'service@example.invalid', apiToken: 'test-only-secret' }, jiraFetch: async () => { throw new Error('invalid Jira configuration must not send a request'); } });
  try {
    await invalidServer.ready;
    await invalidServer.store.upsertAccount({ username: 'invalid-jira', displayName: 'Invalid Jira', role: 'admin', roles: ['admin'], salt: '', hash: await makeHash('invalid-jira-password'), createdAt: new Date().toISOString() });
    const invalidToken = (await invalidServer.store.openSession('invalid-jira')).token;
    const invalidPort = await invalidServer.listenAsync(0, '127.0.0.1');
    const refusal = await fetch(`http://127.0.0.1:${invalidPort}/api/jira/issue`, { method: 'POST', headers: { Authorization: `Bearer ${invalidToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recordType: 'ECR', recordId: 'ECR-0001' }) });
    assert.equal(refusal.status, 503);
    const pageContext = await (await fetch(`http://127.0.0.1:${invalidPort}/`)).text();
    assert.match(pageContext, /"jiraConfigured":false/);
    assert.doesNotMatch(pageContext, /test-only-secret|service@example\.invalid/);
  } finally { await invalidServer.closeAsync(); }
  console.log('Jira server bridge: authenticated canonical issue creation, durable retry protection, role refusal, and ECR linking passed.');
} finally {
  if (server.listening) await server.closeAsync();
  fs.rmSync(dir, { recursive: true, force: true });
}
