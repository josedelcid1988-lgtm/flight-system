// Codex r4161912798: every server commit verifies every signature before any closed work order moves to the archive.
// commitState archives the closed orders nothing live points at, and validates the workspace that is left; the Jira link
// route reaches commitState without an earlier full check. A closed order whose signed record was changed after signing
// must make the write fail, not leave the live workspace for the archive unverified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, makeHash } from '../server/server.mjs';

const fails = [];
const ok = (name, cond, detail = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : ' -> ' + detail)); if (!cond) fails.push(name); };
const server = createServer({
  dbPath: ':memory:', quiet: true, setupCode: 'archive-verify-setup',
  jira: { baseUrl: 'https://skyryse.atlassian.net', email: 'flight-connector@example.invalid', apiToken: 'test-only-secret' },
  jiraFetch: async () => new Response(JSON.stringify({ key: 'ECR-501' }), { status: 201, headers: { 'Content-Type': 'application/json' } })
});
try {
  await server.ready;
  const port = await server.listenAsync(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/api`;
  const api = async (method, route, body, token) => {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, json };
  };
  const hash = await makeHash('flight-password-test');
  assert.equal((await api('PUT', '/auth/accounts', { setupCode: 'archive-verify-setup', users: [{ username: 'qa-admin', displayName: 'QA Admin', role: 'admin', salt: '', hash }] })).status, 200);
  const token = (await api('POST', '/auth/session', { username: 'qa-admin', password: 'flight-password-test' })).json.token;

  const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
  const seed = JSON.parse(fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
  const owner = { username: 'qa-admin', displayName: 'QA Admin', role: 'admin', roles: ['admin'] };
  const ecr = server.host.withAccount(owner, () => server.host.MES.submitECRRequest(seed, { type: 'design', title: 'Archive verification ECR', description: 'Links a Jira issue so the server commits.', reason: 'Exercise the Jira link commit path.', partNumber: seed.orders[0].partNumber }), seed);
  assert.equal(ecr.ok, true, JSON.stringify(ecr));

  // A closed order whose signed buy-off manifest was given a subject it never signed, stored as the shared workspace
  // without passing a commit.
  const state = server.host.MES.upgrade(structuredClone(seed));
  const closed = server.host.MES.archivable(state).map(id => state.orders.find(o => o.id === id)).find(o => o && o.operations.some(op => op.buyoff && op.buyoff.manifest));
  ok('fixture: an archivable closed order with a signed buy-off', !!closed, JSON.stringify(server.host.MES.archivable(state)));
  ok('fixture: the untouched workspace verifies', server.host.MES.verifyManifests(state).ok);
  const signed = closed.operations.find(op => op.buyoff && op.buyoff.manifest);
  signed.buyoff.manifest.subject = { ...(signed.buyoff.manifest.subject || {}), note: 'Edited after signing' };
  ok('fixture: the edited buy-off fails verification', !server.host.MES.verifyManifests(state).ok);
  assert.ok(server.store.putDoc('default', JSON.stringify(state), null, 'archive-verify-fixture'));
  const before = server.store.getDoc('default');

  const linked = await api('POST', '/jira/issue', { recordType: 'ECR', recordId: ecr.id }, token);
  ok('the Jira link commit is refused when a closed order about to be archived fails verification', linked.status === 422 && /failed verification/.test(String(linked.json && linked.json.error)), JSON.stringify(linked));
  ok('nothing moved to the archive', server.store.archiveCount() === 0, String(server.store.archiveCount()));
  ok('the stored workspace is unchanged', server.store.getDoc('default').etag === before.etag);
} finally { await server.closeAsync(); }
console.log('FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
