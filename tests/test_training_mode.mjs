// Training mode (--training, FLIGHT_TRAINING=1 or the training option) runs the production build with every gate on
// and marks every page, print and download TRAINING, NOT THE RECORD. The mark is added to the page the server sends.
// With the flag: the served page carries the strip (sign-in screen included), the tab title says Training, every
// print and HTML download made through markDocument carries the mark, and the server's archive print and export
// carry it too. Without the flag: none of them do, and the served page is the production page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer, servedIndex, parseTrainingSetting, TRAINING_MARK, trainingPage, trainingPrintMark, redactConnectors } from '../server/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [], errors = [];
let checks = 0;
const ok = (name, cond, detail = '') => { checks += 1; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`); if (!cond) fails.push(`${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); };
const count = (text, needle) => text.split(needle).length - 1;

// ---- the page and print helpers ------------------------------------------------------------------------------
{
  const page = trainingPage('<!doctype html><html><head><title>x</title></head><body><p>app</p><script>/*</body>*/</script></body></html>');
  ok('trainingPage puts the connector guard first in the head, then the style', /<head><script id="flight-training-connectors">[^<]*<\/script><style id="flight-training-style">/.test(page), page.slice(0, 160));
  ok('trainingPage adds the strip and its script before the last </body>', /<div class="training-banner" role="note">TRAINING, NOT THE RECORD<\/div><script id="flight-training">[\s\S]*<\/script><\/body><\/html>$/.test(page), page.slice(-200));
  ok('trainingPage puts a print-only mark first in the body', /<body><div class="training-print-top" aria-hidden="true">TRAINING, NOT THE RECORD<\/div><p>app<\/p>/.test(page), page.slice(0, 400));
  ok('trainingPrintMark puts the mark right after <body>', /^<html><body[^>]*><div class="training-print-mark"[^>]*>TRAINING, NOT THE RECORD<\/div>/.test(trainingPrintMark('<html><body class="x"><p>r</p></body></html>')));
  ok('trainingPrintMark marks a fragment with no body', trainingPrintMark('<p>r</p>').startsWith('<div class="training-print-mark"'));
  ok('the mark reads TRAINING, NOT THE RECORD and has no em dash', TRAINING_MARK === 'TRAINING, NOT THE RECORD' && !/\u2014/.test(page));
  ok('FLIGHT_TRAINING 1, true, yes and on turn training on', ['1', 'true', 'TRUE', ' yes ', 'On'].every(v => parseTrainingSetting(v) === true));
  ok('FLIGHT_TRAINING unset, empty, 0, false, no and off leave it off', [undefined, '', '0', 'false', 'No', 'off'].every(v => parseTrainingSetting(v) === false));
  const configured = "<script>window.SK_MIRROR = window.SK_MIRROR || {\n  url: 'https://mirror.example/x',\n  token: \"mirror-secret\",\n  batchSize: 50\n};\nwindow.SK_INTEGRATIONS = window.SK_INTEGRATIONS || {\n  jira: { enabled: false, baseUrl: 'https://jira.example', endpoint: 'https://jira.example/e' },\n  mode: 'mcp',\n  endpoint: `https://bridge.example/mcp`,\n  authHeader: 'Authorization',\n  token: 'bridge-\\'secret'\n};\nconst other = { token: 'kept' };</script>";
  const redacted = redactConnectors(configured);
  ok('the connector blocks lose every token, url and endpoint value, whatever the quotes', !/secret|mirror\.example|bridge\.example|jira\.example/.test(redacted) && /token: '',?/.test(redacted) && redacted.includes("authHeader: 'Authorization'") && redacted.includes("mode: 'mcp'") && redacted.includes('batchSize: 50'), redacted);
  ok('text outside the connector blocks is left alone', redacted.includes("const other = { token: 'kept' };") && redactConnectors('<p>token: "x"</p>') === '<p>token: "x"</p>', redacted);
  ok('trainingPage serves the redacted connector blocks', !/secret/.test(trainingPage(`<html><head></head><body>${configured}</body></html>`)));
  let thrown = '';
  try { parseTrainingSetting('enabled'); } catch (error) { thrown = error.message; }
  ok('any other FLIGHT_TRAINING value stops the server instead of starting it unmarked', /FLIGHT_TRAINING is "enabled"\. Set it to 1/.test(thrown), thrown);
}

// ---- served page, archive print and export, with and without the option ------------------------------------------
const fixtureHtml = fs.readFileSync(path.join(ROOT, 'tests/fixtures/demo_publish.html'), 'utf8');
const closed = JSON.parse(fixtureHtml.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]).orders.find(order => order.status === 'Closed');
async function serverCase(training) {
  const server = createServer({ dbPath: ':memory:', quiet: true, training, setupCode: 'training-mode-setup' });
  const port = await server.listenAsync(0, '127.0.0.1'), base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/`)).text();
  const created = await fetch(`${base}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'training-mode-setup', users: [{ username: 'trainer', displayName: 'Training Lead', role: 'admin', password: 'training-password-1' }] }) });
  const session = await (await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'trainer', password: 'training-password-1' }) })).json();
  const json = JSON.stringify({ order: closed, activity: [] });
  await server.store.putArchived({ id: closed.id, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: closed.partNumber, serials: [], lots: [], parts: [closed.partNumber], title: closed.title || 'Closed order', closedAt: null }, by: 'test' });
  const auth = { headers: { Authorization: `Bearer ${session.token}` } };
  const print = await fetch(`${base}/api/archive/${closed.id}/print`, auth);
  const printed = await print.text();
  const exported = await fetch(`${base}/api/archive/${closed.id}/export`, auth);
  const exportJson = await exported.json();
  const signedInPage = await (await fetch(`${base}/`, auth)).text();
  await server.closeAsync();
  return { html, signedInPage, created: created.status, print: print.status, printed, exportStatus: exported.status, disposition: exported.headers.get('content-disposition') || '', exportJson };
}
{
  const on = await serverCase(true);
  ok('with training on, the served page carries the strip and the style', on.html.includes('<div class="training-banner" role="note">TRAINING, NOT THE RECORD</div>') && on.html.includes('id="flight-training-style"') && on.html.includes('id="flight-training"'));
  ok('with training on, the server context says training', /window\.FLIGHT_SERVER=\{[^<]*"training":true/.test(on.html));
  ok('with training on, the signed-in page carries the strip too', on.signedInPage.includes('class="training-banner"'));
  ok('with training on, the archive print carries the mark at the top', on.print === 200 && /<body[^>]*><div class="training-print-mark"[^>]*>TRAINING, NOT THE RECORD<\/div>/.test(on.printed) && /flight-extract-stamp/.test(on.printed), on.printed.slice(0, 300));
  ok('with training on, the archive export is named TRAINING- and carries the mark', on.exportStatus === 200 && /filename="TRAINING-WO-/.test(on.disposition) && on.exportJson.training === TRAINING_MARK, `${on.disposition} ${on.exportJson.training}`);
  {
    const x = on.exportJson, covered = Object.fromEntries(Object.entries(x.evidence || {}).map(([key, { base64, ...meta }]) => [key, meta]));
    const content = { order: x.order, activity: x.activity, evidence: covered, archiveSha256: x.archiveSha256, archivedAt: x.archivedAt, archivedBy: x.archivedBy, schema: x.schema, training: x.training };
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    ok('with training on, the extract hash covers the training mark, so removing it breaks the hash', x.extractSha256 === hash(content) && x.extractSha256 !== hash({ ...content, training: undefined }) && /, training$/.test(x.extractHashCovers), x.extractHashCovers);
  }
  const off = await serverCase(false);
  ok('with training off, no page carries the mark', !off.html.includes(TRAINING_MARK) && !off.signedInPage.includes(TRAINING_MARK) && !off.html.includes('training-banner') && !/"training":true/.test(off.html));
  ok('with training off, the archive print and export carry no mark', off.print === 200 && !off.printed.includes(TRAINING_MARK) && off.exportStatus === 200 && !/TRAINING-/.test(off.disposition) && off.exportJson.training === undefined);
  const withoutContext = html => html.replace(/<script id="flight-server">[^<]*<\/script>/, '');
  ok('training changes only the mark: the off page plus the injected parts is the on page', trainingPage(withoutContext(off.html)) === withoutContext(on.html));
  ok('with training off, the served page is the production page byte for byte, plus only the server context', withoutContext(off.html) === servedIndex(path.join(ROOT, 'index.html')));
}

// ---- a training server opens only a training database; a production server refuses one ---------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-training-db-'));
  const start = async (file, training, extra = {}) => { const server = createServer({ dbPath: path.join(dir, file), quiet: true, training, setupCode: 'designation-code', ...extra }); try { await server.listenAsync(0, '127.0.0.1'); return { server, error: null }; } catch (error) { await server.store.close?.(); return { server: null, error: error.message }; } };
  const prod = await start('production.sqlite', false);
  const port = prod.server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'designation-code', users: [{ username: 'prodadmin', displayName: 'Production Admin', role: 'admin', password: 'production-password-1' }] }) });
  await prod.server.closeAsync();
  const onProd = await start('production.sqlite', true);
  ok('a training server refuses a database that already holds records', /opens only a training database, and this database already holds records/.test(onProd.error || ''), onProd.error);
  const fresh = await start('training.sqlite', true);
  const first = fresh.server && await fresh.server.store.firstAuditRow();
  ok('a training server designates a new database with its first audit row', !!fresh.server && first?.id === 1 && first.action === 'training-database', JSON.stringify(first));
  await fresh.server.closeAsync();
  const again = await start('training.sqlite', true);
  ok('a training server opens its own training database again', !!again.server, again.error);
  await again.server.closeAsync();
  const prodOnTraining = await start('training.sqlite', false);
  ok('a production server refuses a training database', /created for a training server\. Start it with --training/.test(prodOnTraining.error || ''), prodOnTraining.error);
  const prodAgain = await start('production.sqlite', false);
  ok('a production server still opens its own database', !!prodAgain.server, prodAgain.error);
  await prodAgain.server.closeAsync();
  // A server refused at start writes nothing to the database it refused: the legacy password migration waits for
  // the designation check, so neither a training server on a production database nor a production server on a
  // training database wraps a legacy SHA-256 hash or appends password-wrap.
  const { openDb } = await import('../server/db.mjs');
  const legacy = { username: 'legacy', displayName: 'Legacy Account', salt: 'legacy-salt', hash: createHash('sha256').update('legacy-salt:legacy-password-1').digest('hex'), role: 'tech' };
  const plant = file => { const db = openDb(path.join(dir, file)); db.upsertAccount(legacy); db.close(); };
  const untouched = async file => { await new Promise(resolve => setTimeout(resolve, 1500)); const db = openDb(path.join(dir, file)); const account = db.accounts().find(a => a.username === 'legacy'), rows = db.auditRows(50); db.close(); return { hash: account?.hash, wraps: rows.filter(row => row.action === 'password-wrap').length, actions: rows.map(row => row.action) }; };
  plant('legacy-production.sqlite');
  const trainingOnLegacy = await start('legacy-production.sqlite', true);
  const afterTraining = await untouched('legacy-production.sqlite');
  ok('a training server refused on a production database does not migrate its legacy password hashes or write to its audit chain', /already holds records/.test(trainingOnLegacy.error || '') && afterTraining.hash === legacy.hash && afterTraining.wraps === 0 && afterTraining.actions.length === 0, JSON.stringify({ error: trainingOnLegacy.error, ...afterTraining }));
  const designatedLegacy = await start('legacy-training.sqlite', true);
  await designatedLegacy.server.closeAsync();
  plant('legacy-training.sqlite');
  const productionOnLegacy = await start('legacy-training.sqlite', false);
  const afterProduction = await untouched('legacy-training.sqlite');
  ok('a production server refused on a training database does not migrate its legacy password hashes or write to its audit chain', /created for a training server/.test(productionOnLegacy.error || '') && afterProduction.hash === legacy.hash && afterProduction.wraps === 0 && afterProduction.actions.join() === 'training-database', JSON.stringify({ error: productionOnLegacy.error, ...afterProduction }));
  const acceptedLegacy = await start('legacy-training.sqlite', true);
  const afterAccepted = acceptedLegacy.server && { hash: (await acceptedLegacy.server.store.account('legacy'))?.hash, wraps: (await acceptedLegacy.server.store.auditRows(50)).filter(row => row.action === 'password-wrap').length };
  ok('once the database is accepted, the legacy password hash is wrapped as before', !!afterAccepted && afterAccepted.hash !== legacy.hash && afterAccepted.wraps === 1, JSON.stringify(afterAccepted));
  await acceptedLegacy.server?.closeAsync();
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const jira = { baseUrl: 'https://example.atlassian.net', email: 'svc@example.com', apiToken: 'secret-token' };
  const server = createServer({ dbPath: ':memory:', quiet: true, training: true, setupCode: 'connector-code', jira });
  const port = await server.listenAsync(0, '127.0.0.1'), base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'connector-code', users: [{ username: 'trainer', displayName: 'Training Lead', role: 'admin', password: 'training-password-1' }] }) });
  const session = await (await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'trainer', password: 'training-password-1' }) })).json();
  const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const html = await (await fetch(`${base}/`, { headers: auth })).text();
  ok('a training server reports the Jira connector as not configured even when Jira settings are present', /"jiraConfigured":false/.test(html));
  const jiraCall = await fetch(`${base}/api/jira/issue`, { method: 'POST', headers: auth, body: JSON.stringify({ recordType: 'ecr', recordId: 'ECR-0001' }) });
  ok('a training server sends nothing to Jira', jiraCall.status === 503, String(jiraCall.status));
  const exportSetting = await fetch(`${base}/api/record-exports/settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ recordType: 'work-order', enabled: true, destinationKind: 'folder', destination: 'exports', namingPattern: '{recordId}', rationale: 'Training test setting.' }) });
  ok('a training server refuses to configure record exports', exportSetting.status === 409 && /off on a training server/.test((await exportSetting.json()).error || ''), String(exportSetting.status));
  await server.closeAsync();
}

// ---- a workspace saved by a training server cannot initialize a production server ------------------------------
{
  const { createHost } = await import('../server/mes-host.mjs');
  const engine = createHost(path.join(ROOT, 'index.html')).MES;
  const boot = async training => {
    const server = createServer({ dbPath: ':memory:', quiet: true, training, setupCode: 'provenance-code' });
    const port = await server.listenAsync(0, '127.0.0.1'), base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'provenance-code', users: [{ username: 'lead', displayName: 'Training Lead', role: 'admin', password: 'provenance-password-1' }] }) });
    const { token } = await (await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead', password: 'provenance-password-1' }) })).json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    return { server, base, headers };
  };
  const seed = engine.seed(); engine.ensureMasterWIs(seed);
  const t = await boot(true);
  const init = await fetch(`${t.base}/api/workspace`, { method: 'PUT', headers: t.headers, body: JSON.stringify(seed) });
  const saved = await (await fetch(`${t.base}/api/workspace`, { headers: t.headers })).json();
  const governanceCheck = async (base, headers) => {
    const response = await fetch(`${base}/api/governance`, { headers });
    const doc = await response.json().catch(() => ({}));
    const { manifest, ...content } = doc;
    const hash = value => engine.sha256(engine.canonical(value));
    return { status: response.status, doc, verifies: !!manifest && hash(content) === manifest.hash, strippedVerifies: !!manifest && hash({ ...content, training: undefined }) === manifest.hash && hash(Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'training'))) === manifest.hash };
  };
  const govTraining = await governanceCheck(t.base, t.headers);
  ok('a training server governance export carries the training mark inside the manifest hash, and removing it breaks the hash', govTraining.status === 200 && govTraining.doc.training === TRAINING_MARK && govTraining.verifies && !govTraining.strippedVerifies && /TRAINING, NOT THE RECORD$/.test(govTraining.doc.manifest?.meaning || ''), JSON.stringify({ status: govTraining.status, training: govTraining.doc.training, error: govTraining.doc.error, meaning: govTraining.doc.manifest?.meaning, verifies: govTraining.verifies }));
  ok('a training server records that its governance export was a training export', (await t.server.store.auditRows(20)).some(row => row.action === 'governance-export' && /"training":true/.test(row.detail || '')));
  ok('a training server marks the workspace it saves', init.status === 204 && saved.trainingServer?.mark === TRAINING_MARK && engine.validate(engine.upgrade(structuredClone(saved))) === true, `${init.status} ${JSON.stringify(saved.trainingServer)}`);
  await t.server.closeAsync();
  const p = await boot(false);
  const refused = await fetch(`${p.base}/api/workspace`, { method: 'PUT', headers: p.headers, body: JSON.stringify(saved) });
  const refusal = await refused.json().catch(() => ({}));
  const audit = await p.server.store.auditRows(20);
  ok('a production server refuses to initialize from a training workspace, and records the refusal', refused.status === 422 && /saved by a training server/.test(refusal.error || '') && audit.some(row => row.action === 'workspace-put-refused') && !(await p.server.store.getDoc('default')), `${refused.status} ${refusal.error}`);
  const plainInit = await fetch(`${p.base}/api/workspace`, { method: 'PUT', headers: p.headers, body: JSON.stringify(seed) });
  ok('a production server still initializes from a workspace with no training mark', plainInit.status === 204, String(plainInit.status));
  const prodSaved = await (await fetch(`${p.base}/api/workspace`, { headers: p.headers })).json();
  ok('a production server does not mark its workspace', !Object.hasOwn(prodSaved, 'trainingServer'));
  const govProduction = await governanceCheck(p.base, p.headers);
  ok('a production governance export carries no training mark and its manifest still verifies', govProduction.status === 200 && !Object.hasOwn(govProduction.doc, 'training') && govProduction.verifies && govProduction.doc.manifest.meaning === 'ISO/IEC 42001 evidence export', JSON.stringify({ status: govProduction.status, meaning: govProduction.doc.manifest?.meaning }));
  await p.server.closeAsync();
}

// ---- two servers starting together on one new database; a production server never serves a training workspace ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-training-race-'));
  const file = path.join(dir, 'shared.sqlite');
  const prod = createServer({ dbPath: file, quiet: true, training: false, setupCode: 'race-code' });
  const train = createServer({ dbPath: file, quiet: true, training: true, setupCode: 'race-code' });
  const [p, t] = await Promise.allSettled([prod.listenAsync(0, '127.0.0.1'), train.listenAsync(0, '127.0.0.1')]);
  const first = await train.store.firstAuditRow();
  ok('two servers starting together on one new database: the training designation is the first audit row exactly once', t.status === 'fulfilled' && first?.action === 'training-database' && (await train.store.auditRows(50)).filter(row => row.action === 'training-database').length === 1, JSON.stringify({ p: p.status, t: t.status, first }));
  if (t.status === 'fulfilled') {
    const tb = `http://127.0.0.1:${t.value}`;
    await fetch(`${tb}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'race-code', users: [{ username: 'lead', displayName: 'Training Lead', role: 'admin', password: 'race-password-1' }] }) });
    const { token } = await (await fetch(`${tb}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead', password: 'race-password-1' }) })).json();
    const { createHost } = await import('../server/mes-host.mjs');
    const engine = createHost(path.join(ROOT, 'index.html')).MES, seed = engine.seed(); engine.ensureMasterWIs(seed);
    await fetch(`${tb}/api/workspace`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
    if (p.status === 'fulfilled') {
      // The production server that started alongside sees the same file: it neither serves nor changes the training workspace.
      const pb = `http://127.0.0.1:${p.value}`;
      const signIn = await fetch(`${pb}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead', password: 'race-password-1' }) });
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const read = await fetch(`${pb}/api/workspace`, { headers: auth });
      const row = await prod.store.getDoc('default');
      const act = await fetch(`${pb}/api/workspace/actions/MES.setPriority`, { method: 'POST', headers: { ...auth, 'If-Match': row.etag }, body: JSON.stringify({ args: ['WO-NONE', 'High'] }) });
      ok('a production server that started alongside refuses to sign in, serve or change the training workspace', signIn.status === 422 && read.status === 422 && act.status === 422 && /claimed by a training server/.test((await act.json()).error || ''), `${signIn.status} ${read.status} ${act.status}`);
    } else ok('the production server that lost the race did not start (it found the training designation, or the training server held the database)', /created for a training server|database is locked/.test(String(p.reason?.message)), String(p.reason?.message));
  }
  if (p.status === 'fulfilled') await prod.closeAsync(); else await prod.store.close?.();
  if (t.status === 'fulfilled') await train.closeAsync();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // A production server already running on an empty database, then a training server claims that database: from then
  // on the production server refuses every API route, archives and exports included, not only the workspace.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-training-late-'));
  const file = path.join(dir, 'shared.sqlite');
  const prod = createServer({ dbPath: file, quiet: true, training: false, setupCode: 'late-code' });
  const pb = `http://127.0.0.1:${await prod.listenAsync(0, '127.0.0.1')}`;
  const before = await fetch(`${pb}/api/health`);
  const train = createServer({ dbPath: file, quiet: true, training: true, setupCode: 'late-code' });
  const tb = `http://127.0.0.1:${await train.listenAsync(0, '127.0.0.1')}`;
  await fetch(`${tb}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'late-code', users: [{ username: 'lead', displayName: 'Training Lead', role: 'admin', password: 'late-password-1' }] }) });
  const { token } = await (await fetch(`${tb}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead', password: 'late-password-1' }) })).json();
  const auth = { Authorization: `Bearer ${token}` };
  const statuses = {};
  for (const route of ['/health', '/archive', '/archive/WO-10001', '/archive/WO-10001/print', '/archive/WO-10001/export', '/trace?q=SN-1', '/calibration-archive', '/workspace']) statuses[route] = (await fetch(`${pb}/api${route}`, { headers: auth })).status;
  const signIn = await fetch(`${pb}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead', password: 'late-password-1' }) });
  const setup = await fetch(`${pb}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'late-code', users: [{ username: 'other', displayName: 'Other', role: 'admin', password: 'late-password-2' }] }) });
  const refusal = (await signIn.json()).error || '';
  ok('a production server running before a training server claimed its database refuses every API route afterwards, archives and exports included', before.status === 200 && Object.values(statuses).every(s => s === 422) && signIn.status === 422 && setup.status === 422 && /claimed by a training server/.test(refusal), JSON.stringify({ before: before.status, statuses, signIn: signIn.status, setup: setup.status }));
  const trainingStill = await fetch(`${tb}/api/archive`, { headers: auth });
  ok('the training server that claimed the database keeps working', trainingStill.status === 200, String(trainingStill.status));
  await prod.closeAsync(); await train.closeAsync();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // However a training workspace reached a production store, the production server neither serves nor changes it.
  const { createHost } = await import('../server/mes-host.mjs');
  const engine = createHost(path.join(ROOT, 'index.html')).MES, seed = engine.seed(); engine.ensureMasterWIs(seed);
  const server = createServer({ dbPath: ':memory:', quiet: true, training: false, setupCode: 'planted-code' });
  const port = await server.listenAsync(0, '127.0.0.1'), base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/api/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'planted-code', users: [{ username: 'lead', displayName: 'Production Lead', role: 'admin', password: 'planted-password-1' }] }) });
  const { token } = await (await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead', password: 'planted-password-1' }) })).json();
  const etag = await server.store.putDoc('default', JSON.stringify({ ...seed, trainingServer: { mark: TRAINING_MARK } }), null, 'test');
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const read = await fetch(`${base}/api/workspace`, { headers: auth });
  const act = await fetch(`${base}/api/workspace/actions/MES.setPriority`, { method: 'POST', headers: { ...auth, 'If-Match': etag }, body: JSON.stringify({ args: ['WO-NONE', 'High'] }) });
  const actJson = await act.json().catch(() => ({}));
  ok('a production server neither serves nor changes a training workspace that reached its store', read.status === 422 && act.status === 422 && /saved by a training server/.test(actJson.error || ''), `${read.status} ${act.status} ${actJson.error}`);
  await server.closeAsync();
}

// ---- browser-side connectors stay off on a training server whatever the build configures -------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-training-connectors-'));
  // Start from the committed (unstamped) form, so the edited copy is stamped in memory like a checkout; a stamped copy
  // edited here would be refused as changed after stamping.
  const { clear, verify } = await import('../tools/stamp-build.mjs');
  const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const configured = clear(source, verify(source).build)
    .replace("  url: '',        // e.g. https://mes-mirror.internal:8787", "  url: 'http://127.0.0.1:9/mirror',        // e.g. https://mes-mirror.internal:8787")
    .replace("  mode: 'local',            // 'local' keeps", "  mode: 'mcp',            // 'local' keeps")
    .replace("  endpoint: '',             // e.g. https://mes-bridge.internal/mcp", "  endpoint: 'http://127.0.0.1:9/bridge',             // e.g. https://mes-bridge.internal/mcp")
    .replace("  token: '',      // sent as Authorization", "  token: 'mirror-token-literal',      // sent as Authorization")
    .replace("  token: ''                 // bearer token for the bridge", "  token: 'bridge-token-literal'                 // bearer token for the bridge")
    .replace("window.SK_IDENTITY = window.SK_IDENTITY || {\n  provider: 'local',", "window.SK_IDENTITY = window.SK_IDENTITY || {\n  provider: 'okta',")
    .replace("    issuer: '',                     // e.g.", "    issuer: 'http://127.0.0.1:9/okta',                     // e.g.")
    .replace("    clientId: '',                   // the SPA", "    clientId: 'production-client-id',                   // the SPA");
  ok('the connector test build really carries both tokens and a production identity provider', configured.includes("'mirror-token-literal'") && configured.includes("'bridge-token-literal'") && configured.includes("provider: 'okta',") && configured.includes("'production-client-id'"));
  const indexPath = path.join(dir, 'index.html');
  fs.writeFileSync(indexPath, configured);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    for (const training of [true, false]) {
      const server = createServer({ dbPath: ':memory:', quiet: true, training, setupCode: 'connector-ui', indexPath });
      const port = await server.listenAsync(0, '127.0.0.1');
      const raw = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      if (training) ok('the training page sent before sign-in carries neither connector token, identity provider issuer or client id, nor their addresses', !raw.includes('mirror-token-literal') && !raw.includes('bridge-token-literal') && !raw.includes('production-client-id') && !raw.includes('127.0.0.1:9/') && /SK_IDENTITY \|\| \{\n  provider: 'local',/.test(raw), raw.match(/(token|issuer|provider): '[^']*'/g)?.join());
      else ok('the same build on a production server is served unchanged, tokens included (the test configuration is real)', raw.includes('mirror-token-literal') && raw.includes('bridge-token-literal'));
      const page = await browser.newPage();
      const outbound = [];
      page.on('request', request => { if (/127\.0\.0\.1:9\//.test(request.url())) outbound.push(request.url()); });
      page.on('pageerror', error => errors.push(`connectors ${training}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.locator('#sk-login').waitFor({ state: 'visible', timeout: 15000 });
      const seen = await page.evaluate(async () => {
        window.SK_MIRROR = { url: 'http://127.0.0.1:9/later', token: 'x' };
        if (window.SK_INTEGRATIONS) window.SK_INTEGRATIONS.mode = 'mcp';
        const bridge = await window.skIntegrations.netsuite.itemAvailability(['TRN-1']);
        return { mirror: window.skMirror.enabled, url: window.SK_MIRROR.url, mode: window.SK_INTEGRATIONS.mode, endpoint: window.SK_INTEGRATIONS.endpoint, manual: bridge.manual === true, identity: window.skIdentity.provider, configured: window.SK_IDENTITY.provider, issuer: window.SK_IDENTITY.okta.issuer };
      });
      if (training) ok('on a training server the configured mirror, integration bridge and identity provider stay off, and nothing reaches them', seen.mirror === false && seen.url === '' && seen.mode === 'local' && seen.endpoint === '' && seen.manual && seen.identity === 'local' && seen.configured === 'local' && seen.issuer === '' && outbound.length === 0, JSON.stringify({ seen, outbound }));
      else ok('the same build on a production server keeps its configured mirror, bridge and identity provider (the test configuration is real)', seen.mirror === true && seen.mode === 'mcp' && seen.endpoint === 'http://127.0.0.1:9/bridge' && seen.configured === 'okta' && seen.issuer === 'http://127.0.0.1:9/okta' && outbound.some(url => /127\.0\.0\.1:9\/okta/.test(url)), JSON.stringify({ seen, outbound }));
      await page.close();
      await server.closeAsync();
    }
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- the command line flag and the environment setting ------------------------------------------------------
// Stops a server process and waits until it has exited, so its database files are closed before they are removed.
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
}
async function cli(args, env) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flight-training-cli-')), 'training.sqlite');
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.mjs'), '--host', '127.0.0.1', '--port', '0', '--db', db, ...args], { cwd: ROOT, env: { ...process.env, FLIGHT_TRAINING: '', FLIGHT_BOOTSTRAP_TOKEN: '', ...env } });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  try {
    for (const until = Date.now() + 20000; !/listening on [^\s]+:(\d+)/.test(out) && child.exitCode === null && Date.now() < until;) await new Promise(r => setTimeout(r, 100));
    const port = (out.match(/listening on [^\s]+:(\d+)/) || [])[1];
    if (!port) { for (const until = Date.now() + 5000; child.exitCode === null && Date.now() < until;) await new Promise(r => setTimeout(r, 50)); return { out, html: '', exitCode: child.exitCode }; }
    for (const until = Date.now() + 5000; !/First-run setup code/.test(out) && Date.now() < until;) await new Promise(r => setTimeout(r, 50));
    return { out, html: await (await fetch(`http://127.0.0.1:${port}/`)).text() };
  } finally { await stop(child); fs.rmSync(path.dirname(db), { recursive: true, force: true }); }
}
{
  const flag = await cli(['--training'], {});
  ok('node server/server.mjs --training marks the served page', flag.html.includes('class="training-banner"'), flag.out);
  ok('the console says training mode is on and every rule is enforced', /Training mode: every page, print and download is marked TRAINING, NOT THE RECORD\. Every rule and gate is enforced/.test(flag.out), flag.out);
  ok('the console still prints the first-run setup code in training mode', /First-run setup code: \S+/.test(flag.out), flag.out);
  const envOn = await cli([], { FLIGHT_TRAINING: '1' });
  ok('FLIGHT_TRAINING=1 marks the served page', envOn.html.includes('class="training-banner"'), envOn.out);
  const plain = await cli([], {});
  ok('the production default serves no mark and logs no training mode', plain.html.length > 1000 && !plain.html.includes(TRAINING_MARK) && !/Training mode/.test(plain.out), plain.out);
  // The demo build relaxes the gates a training server enforces, so the two cannot run together, by flag or setting.
  const withDemo = await cli(['--training', '--serve-demo'], {});
  const withDemoEnv = await cli([], { FLIGHT_TRAINING: '1', FLIGHT_SERVE_DEMO: '1' });
  ok('a training server refuses to start with --serve-demo or FLIGHT_SERVE_DEMO=1, and says why', [withDemo, withDemoEnv].every(r => r.exitCode === 1 && !r.html && /did not start: Training mode enforces every gate, and the demo build relaxes them/.test(r.out)), withDemo.out + withDemoEnv.out);
  let thrown = null; try { createServer({ dbPath: ':memory:', quiet: true, training: true, serveDemo: true }); } catch (e) { thrown = e; }
  ok('createServer refuses training with serveDemo', /does not serve demo\.html/.test(thrown?.message || ''), String(thrown));
}

// ---- in the browser: the strip, the title and every print -------------------------------------------------------
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  for (const training of [true, false]) {
    const server = createServer({ dbPath: ':memory:', quiet: true, training, setupCode: 'training-mode-ui' });
    const port = await server.listenAsync(0, '127.0.0.1');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${training ? 'training' : 'production'}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#sk-login').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(300);
    const signIn = await page.evaluate(() => { const e = document.querySelector('.training-banner'); if (!e) return null; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { text: e.textContent, visibility: s.visibility, display: s.display, z: Number(s.zIndex), x: r.x, y: r.y, r: r.right, b: r.bottom, h: r.height, vw: innerWidth, vh: innerHeight, boot: Number(getComputedStyle(document.getElementById('sk-boot')).zIndex) }; });
    if (training) ok('training sign-in screen shows TRAINING, NOT THE RECORD on screen, above the sign-in layer', !!signIn && signIn.text === TRAINING_MARK && signIn.visibility === 'visible' && signIn.display !== 'none' && signIn.h > 0 && signIn.x >= 0 && signIn.r <= signIn.vw && signIn.b <= signIn.vh && signIn.z > signIn.boot, JSON.stringify(signIn));
    else ok('production sign-in screen shows no training strip', signIn === null, JSON.stringify(signIn));
    for (const [id, value] of Object.entries({ 'sk-displayname': 'Training Lead', 'sk-username': 'trainer', 'sk-password': 'training-password-1', 'sk-confirm': 'training-password-1', 'sk-setup': 'training-mode-ui' })) await page.locator(`#${id}`).fill(value);
    await page.locator('#sk-login-submit').click();
    await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });
    await page.waitForTimeout(500);
    const marks = await page.evaluate(async () => {
      let got = null; const make = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob && blob.type === 'text/html') got = blob; return make(blob); };
      window.open = () => ({ opener: 1, focus() {}, print() {} });
      printRecord('<!doctype html><html><head><title>x</title></head><body><p>Record body</p></body></html>', 'x.html');
      const preview = got ? await got.text() : '';
      const banner = document.querySelector('.training-banner');
      return { banner: banner ? { text: banner.textContent, visible: getComputedStyle(banner).visibility === 'visible' && banner.getBoundingClientRect().height > 0 } : null, title: document.title, mark: markDocument('<html><body><p>x</p></body></html>'), preview };
    });
    // Every way the page saves a file: an HTML file through dlFile and through saveFile (the ATP report), a JSON file
    // through an anchor, and a print whose pop-up was blocked, which falls back to a download.
    const downloads = [];
    for (const [label, script] of [
      ['dlFile', () => dlFile('report.html', '<html><body><p>Report naming training-print-mark in its text</p></body></html>')],
      ['saveFile', () => saveFile(new Blob(['<html><body><p>ATP report</p></body></html>'], { type: 'text/html' }), 'atp-report.html')],
      ['anchor', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['{"x":1}'], { type: 'application/json' })); a.download = 'export.json'; a.click(); }],
      ['blocked print', () => { window.open = () => null; printRecord('<html><body><p>Record</p></body></html>', 'record.html'); }],
      ['controlled document', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<!doctype html><html><body><p>Procedure</p></body></html>'], { type: 'text/html' })); a.download = 'procedure.html'; a.click(); }],
      ['hostile document', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<html><head><style>.training-print-mark{display:none!important}</style><script>window.parent.__ran=1;try{parent.document.querySelector(".training-print-mark").remove();}catch(e){}</script></head><body><p>Hostile "quoted" &amp; text</p></body></html>'], { type: 'text/html' })); a.download = 'hostile.html'; a.click(); }]
    ]) {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.evaluate(script)]);
      downloads.push({ label, name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), 'utf8') });
    }
    // JSON files, on a page of their own: Chromium stops automatic downloads from one page after ten.
    const jsonPage = await context.newPage();
    jsonPage.on('pageerror', error => errors.push(`json downloads ${training}: ${error.message}`));
    await jsonPage.goto(`http://127.0.0.1:${port}/`);
    await jsonPage.locator('#sk-login').waitFor({ state: 'visible', timeout: 15000 });
    for (const [label, script] of [
      ['record export', () => saveFile(new Blob([JSON.stringify({ internal: true, workOrder: { id: 'WO-1' } }, null, 2)], { type: 'application/json' }), 'WO-1-record.json')],
      ['dlFile json', () => dlFile('register.json', '{"tools":[]}', 'application/json')],
      ['json claiming not training', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['{"training":false,"trainingNote":"production","y":2}'], { type: 'application/json' })); a.download = 'claim.json'; a.click(); }],
      ['already marked json', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['{"manifest":{"hash":"h"},"training":"TRAINING, NOT THE RECORD","z":3}'], { type: 'application/json' })); a.download = 'governance.json'; a.click(); }],
      ['json array', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['[1,2]'], { type: 'application/json' })); a.download = 'list.json'; a.click(); }],
    ]) {
      const [download] = await Promise.all([jsonPage.waitForEvent('download', { timeout: 10000 }), jsonPage.evaluate(script)]);
      downloads.push({ label, name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), 'utf8') });
    }
    await jsonPage.close();
    if (training) {
      ok('every saved file is named TRAINING-', downloads.every(d => /^TRAINING-/.test(d.name) && !/^TRAINING-TRAINING-/.test(d.name)), downloads.map(d => d.name).join(', '));
      const jsonOf = label => { try { return JSON.parse(downloads.find(d => d.label === label).text); } catch { return null; } };
      ok('every saved HTML file the app builds carries the training mark exactly once', downloads.filter(d => ['dlFile', 'saveFile', 'blocked print'].includes(d.label)).every(d => count(d.text, TRAINING_MARK) === 1), downloads.map(d => `${d.label}:${count(d.text, TRAINING_MARK)}`).join(', '));
      const marked = ['anchor', 'record export', 'dlFile json', 'json claiming not training'].map(label => ({ label, json: jsonOf(label) }));
      ok('every saved JSON object carries the training mark inside it, first, whatever the file is renamed to', marked.every(({ json }) => !!json && Object.keys(json)[0] === 'training' && json.training === TRAINING_MARK && json.trainingNote === 'Saved by a Flight System training server. Not a quality record.'), JSON.stringify(marked));
      ok('a saved JSON file keeps its own content beside the mark', jsonOf('anchor').x === 1 && jsonOf('record export').workOrder.id === 'WO-1' && jsonOf('record export').internal === true && Array.isArray(jsonOf('dlFile json').tools) && jsonOf('json claiming not training').y === 2);
      ok('a JSON file that already carries the mark (the governance export) is saved byte for byte, so its manifest still verifies', downloads.find(d => d.label === 'already marked json').text === '{"manifest":{"hash":"h"},"training":"TRAINING, NOT THE RECORD","z":3}');
      ok('JSON that is not an object is saved unchanged, under a TRAINING- name', downloads.find(d => d.label === 'json array').text === '[1,2]');
      ok('text that only names the mark class does not count as marked', /Report naming training-print-mark/.test(downloads.find(d => d.label === 'dlFile').text) && count(downloads.find(d => d.label === 'dlFile').text, TRAINING_MARK) === 1);
      const doc = downloads.find(d => d.label === 'controlled document').text;
      ok('an HTML controlled document downloaded through a link is a wrapper page: the mark, then the document in a sandboxed frame', /^<!doctype html>/.test(doc) && doc.indexOf('class="training-print-mark"') < doc.indexOf('<iframe sandbox ') && doc.includes('srcdoc="<!doctype html><html><body><p>Procedure</p></body></html>"') && count(doc, TRAINING_MARK) >= 1, doc.slice(0, 200));
      const hostile = await context.newPage();
      await hostile.setContent(downloads.find(d => d.label === 'hostile document').text);
      await hostile.waitForTimeout(300);
      const shown = await hostile.evaluate(() => { const m = document.querySelector('.training-print-mark'), f = document.querySelector('iframe'); return { mark: !!m && getComputedStyle(m).display !== 'none' && m.getBoundingClientRect().height > 0, ran: window.__ran === 1, sandbox: f && f.getAttribute('sandbox') === '', text: f && f.contentDocument ? null : 'opaque' }; });
      ok('a downloaded HTML document cannot hide or remove the mark: its CSS and script stay inside the sandboxed frame', shown.mark && !shown.ran && shown.sandbox, JSON.stringify(shown));
      await hostile.close();
      // saveFile can wait on a downloads service. An HTML document downloaded while it waits is still wrapped: only the
      // blob saveFile marked is trusted, not every blob made during the wait.
      const slow = await context.newPage();
      slow.on('pageerror', error => errors.push(`slow save: ${error.message}`));
      await slow.goto(`http://127.0.0.1:${port}/`);
      await slow.locator('#sk-login').waitFor({ state: 'visible', timeout: 15000 });
      const [during] = await Promise.all([slow.waitForEvent('download', { timeout: 10000 }), slow.evaluate(async () => {
        let release = () => {}, saved = null;
        window.claude = { use: async () => ({ save: ({ data }) => new Promise(resolve => { saved = data; release = resolve; }) }) };
        const pending = saveFile(new Blob(['<html><body><p>ATP report</p></body></html>'], { type: 'text/html' }), 'slow-atp.html');
        await new Promise(resolve => setTimeout(resolve, 150));
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<!doctype html><html><head><style>.training-print-mark{display:none!important}</style></head><body><p>During save</p></body></html>'], { type: 'text/html' })); a.download = 'during.html'; a.click();
        await new Promise(resolve => setTimeout(resolve, 150));
        release(); await pending;
        window.__slowSaved = saved ? await saved.text() : '';
      })]);
      const duringText = fs.readFileSync(await during.path(), 'utf8'), slowSaved = await slow.evaluate(() => window.__slowSaved);
      ok('an HTML document downloaded while saveFile waits still gets the sandboxed wrapper with the mark first', /^TRAINING-during\.html$/.test(during.suggestedFilename()) && duringText.indexOf('class="training-print-mark"') >= 0 && duringText.indexOf('class="training-print-mark"') < duringText.indexOf('<iframe sandbox ') && duringText.includes('srcdoc="'), `${during.suggestedFilename()} ${duringText.slice(0, 160)}`);
      ok('the file saveFile hands to the downloads service still carries the mark once', count(slowSaved, TRAINING_MARK) === 1, slowSaved.slice(0, 160));
      await slow.close();
    } else {
      ok('production saves files under their own names with no training mark', downloads.map(d => d.name).join() === 'report.html,atp-report.html,export.json,record.html,procedure.html,hostile.html,WO-1-record.json,register.json,claim.json,governance.json,list.json' && downloads.filter(d => d.label !== 'already marked json').every(d => !d.text.includes(TRAINING_MARK)) && downloads.find(d => d.label === 'anchor').text === '{"x":1}' && downloads.find(d => d.label === 'dlFile json').text === '{"tools":[]}', downloads.map(d => d.name).join(', '));
    }
    if (training) {
      ok('signed in, every page keeps the strip', !!marks.banner && marks.banner.text === TRAINING_MARK && marks.banner.visible, JSON.stringify(marks.banner));
      ok('the tab title starts with Training', /^Training · Flight System/.test(marks.title), marks.title);
      ok('an HTML download carries the training mark once, at the top, and keeps the build line', count(marks.mark, TRAINING_MARK) === 1 && /^<html><body><div class="training-print-mark"/.test(marks.mark) && /fs-build-line/.test(marks.mark), marks.mark);
      ok('a print preview carries the training mark', count(marks.preview, TRAINING_MARK) === 1 && /print-action/.test(marks.preview), marks.preview.slice(0, 200));
      // A render that removes the strip gets it back.
      const restored = await page.evaluate(async () => { document.querySelector('.training-banner').remove(); await new Promise(r => setTimeout(r, 50)); return !!document.querySelector('.training-banner'); });
      ok('a strip removed from the page comes back', restored);
      const view = await context.newPage();
      await view.setContent(marks.preview);
      const shown = await view.evaluate(() => { const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; }; const m = document.querySelector('.training-print-mark'), b = document.querySelector('.print-action'); return m && b ? { mark: box(m), btn: box(b) } : null; });
      ok('print preview on screen: the Print button does not cover the training mark', !!shown && (shown.mark.y >= shown.btn.b || shown.mark.r <= shown.btn.x), JSON.stringify(shown));
      await view.emulateMedia({ media: 'print' });
      const printed = await view.evaluate(() => ({ top: document.querySelector('.training-print-mark').getBoundingClientRect().top, button: getComputedStyle(document.querySelector('.print-action')).display }));
      ok('printed page: the training mark is at the top and the Print button is not printed', printed.top < 40 && printed.button === 'none', JSON.stringify(printed));
      await page.emulateMedia({ media: 'print' });
      const livePrint = await page.evaluate(() => { const e = document.querySelector('.training-banner'), s = getComputedStyle(e), top = document.querySelector('.training-print-top'), t = top && getComputedStyle(top); return { position: s.position, display: s.display, text: e.textContent, top: top ? { first: document.body.firstElementChild === top, display: t.display, y: top.getBoundingClientRect().top, text: top.textContent } : null }; });
      ok('printing the page itself (trace report) puts the mark first on the first sheet and repeats the strip at the foot of every sheet', livePrint.position === 'fixed' && livePrint.display !== 'none' && livePrint.text === TRAINING_MARK && !!livePrint.top && livePrint.top.first && livePrint.top.display === 'block' && livePrint.top.y < 40 && livePrint.top.text === TRAINING_MARK, JSON.stringify(livePrint));
    } else {
      ok('production pages, title, prints and downloads carry no training mark', marks.banner === null && !/^Training/.test(marks.title) && !marks.mark.includes(TRAINING_MARK) && !marks.preview.includes(TRAINING_MARK) && /fs-build-line/.test(marks.mark), JSON.stringify({ title: marks.title, mark: marks.mark }));
    }
    await context.close();
    await server.closeAsync();
  }
} finally { await browser.close(); }

{
  const guide = fs.readFileSync(path.join(ROOT, 'docs/TRAINING_SERVER_SETUP.md'), 'utf8').replace(/\s+/g, ' ');
  ok('the setup guide asks for a training-only password and a training-only stamp PIN on plain HTTP', /training password they use nowhere else/.test(guide) && /training-only stamp PIN here and never enters the PIN they use on the production system/.test(guide), '');
}

ok('no page errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks - fails.length} fail ${fails.length}`);
console.log('errors', JSON.stringify(errors), 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
