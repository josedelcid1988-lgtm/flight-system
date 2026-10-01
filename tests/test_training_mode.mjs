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
import { createServer, servedIndex, parseTrainingSetting, TRAINING_MARK, trainingPage, trainingPrintMark } from '../server/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [], errors = [];
let checks = 0;
const ok = (name, cond, detail = '') => { checks += 1; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -> ${detail}`}`); if (!cond) fails.push(`${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); };
const count = (text, needle) => text.split(needle).length - 1;

// ---- the page and print helpers ------------------------------------------------------------------------------
{
  const page = trainingPage('<!doctype html><html><head><title>x</title></head><body><p>app</p><script>/*</body>*/</script></body></html>');
  ok('trainingPage adds the style in the head', /<head><style id="flight-training-style">/.test(page), page.slice(0, 120));
  ok('trainingPage adds the strip and its script before the last </body>', /<div class="training-banner" role="note">TRAINING, NOT THE RECORD<\/div><script id="flight-training">[\s\S]*<\/script><\/body><\/html>$/.test(page), page.slice(-200));
  ok('trainingPage puts a print-only mark first in the body', /<body><div class="training-print-top" aria-hidden="true">TRAINING, NOT THE RECORD<\/div><p>app<\/p>/.test(page), page.slice(0, 400));
  ok('trainingPrintMark puts the mark right after <body>', /^<html><body[^>]*><div class="training-print-mark"[^>]*>TRAINING, NOT THE RECORD<\/div>/.test(trainingPrintMark('<html><body class="x"><p>r</p></body></html>')));
  ok('trainingPrintMark marks a fragment with no body', trainingPrintMark('<p>r</p>').startsWith('<div class="training-print-mark"'));
  ok('the mark reads TRAINING, NOT THE RECORD and has no em dash', TRAINING_MARK === 'TRAINING, NOT THE RECORD' && !/\u2014/.test(page));
  ok('FLIGHT_TRAINING 1, true, yes and on turn training on', ['1', 'true', 'TRUE', ' yes ', 'On'].every(v => parseTrainingSetting(v) === true));
  ok('FLIGHT_TRAINING unset, empty, 0, false, no and off leave it off', [undefined, '', '0', 'false', 'No', 'off'].every(v => parseTrainingSetting(v) === false));
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
    for (const until = Date.now() + 20000; !/listening on [^\s]+:(\d+)/.test(out) && Date.now() < until;) await new Promise(r => setTimeout(r, 100));
    const port = (out.match(/listening on [^\s]+:(\d+)/) || [])[1];
    if (!port) return { out, html: '' };
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
      ['controlled document', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<!doctype html><html><body><p>Procedure</p></body></html>'], { type: 'text/html' })); a.download = 'procedure.html'; a.click(); }]
    ]) {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.evaluate(script)]);
      downloads.push({ label, name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), 'utf8') });
    }
    if (training) {
      ok('every saved file is named TRAINING-', downloads.every(d => /^TRAINING-/.test(d.name) && !/^TRAINING-TRAINING-/.test(d.name)), downloads.map(d => d.name).join(', '));
      ok('every saved HTML file carries the training mark exactly once', downloads.filter(d => d.label !== 'anchor').every(d => count(d.text, TRAINING_MARK) === 1), downloads.map(d => `${d.label}:${count(d.text, TRAINING_MARK)}`).join(', '));
      ok('a saved JSON file is unchanged inside', downloads.find(d => d.label === 'anchor').text === '{"x":1}');
      ok('text that only names the mark class does not count as marked', /Report naming training-print-mark/.test(downloads.find(d => d.label === 'dlFile').text) && count(downloads.find(d => d.label === 'dlFile').text, TRAINING_MARK) === 1);
      ok('an HTML controlled document downloaded through a link carries the mark ahead of its own bytes', /^<div class="training-print-mark"[\s\S]*<!doctype html><html><body><p>Procedure<\/p><\/body><\/html>$/.test(downloads.find(d => d.label === 'controlled document').text), downloads.find(d => d.label === 'controlled document').text.slice(0, 120));
    } else {
      ok('production saves files under their own names with no training mark', downloads.map(d => d.name).join() === 'report.html,atp-report.html,export.json,record.html,procedure.html' && downloads.every(d => !d.text.includes(TRAINING_MARK)), downloads.map(d => d.name).join(', '));
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

ok('no page errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks - fails.length} fail ${fails.length}`);
console.log('errors', JSON.stringify(errors), 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
