// The access review report in server mode, in a real browser against the real server: the page reloads the shared
// workspace before it builds the report (so training and stamps another person changed are current) and builds it
// only from the workspace version the server read (one more try, then a plain refusal, when they differ); the report
// carries the generation time the server sent, and is refused when this computer is on another Pacific day than the
// server; a role given in another session counts because the account list is reloaded first; a change of the
// page's own that the server has not confirmed yet makes it wait with a plain message.
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const fails = [];
const ok = (what, cond, more = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + more)); if (!cond) fails.push(what); };
const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'access-report-ui-setup' });
const errors = [];
let browser;
try {
  const port = await server.listenAsync(0, '127.0.0.1');
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('Report Admin');
  await page.locator('#sk-username').fill('report-admin');
  await page.locator('#sk-password').fill('report-admin-password');
  await page.locator('#sk-confirm').fill('report-admin-password');
  await page.locator('#sk-setup').fill('access-report-ui-setup');
  await page.locator('#sk-login-submit').click();
  await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 15000 });

  // The server's time is the report's time: the response is rewritten to one second before the server's own
  // time (same Pacific day), a value the workstation clock does not produce. The response also names the workspace
  // version the server read; the report is built only from that same version.
  let rewrite = body => { const t = Date.parse(body.generatedAt); body.generatedAt = new Date(t - 1000).toISOString(); return body; };
  const sent = [];
  let duringFetch = null;
  await page.route('**/api/auth/access-report', async route => { const response = await route.fetch(); if (duringFetch) await duringFetch(); let body = await response.json(); if (body && Array.isArray(body.users)) { body = rewrite(body); sent.push({ generatedAt: body.generatedAt, workspaceEtag: body.workspaceEtag }); } await route.fulfill({ response, json: body }); });
  const build = () => page.evaluate(async () => {
    let reloads = 0; const real = refreshServerWorkspace;
    refreshServerWorkspace = async function () { reloads += 1; return real.apply(this, arguments); };
    try { const r = await skAuth.accessReport(); return { ok: r.ok, message: r.message, generatedAt: r.generatedAt, accounts: (r.accounts || []).map(a => a.username), reloads, etag: window.skServer.etag }; } finally { refreshServerWorkspace = real; }
  });
  const report = await build();
  ok('Master Access builds the report from the server', report.ok === true && report.accounts.includes('report-admin'), JSON.stringify(report));
  ok('the shared workspace is reloaded once before the report is built', report.reloads === 1, String(report.reloads));
  ok('the report carries the generation time the server sent', sent.length === 1 && report.generatedAt === sent[0].generatedAt, JSON.stringify({ report: report.generatedAt, sent }));
  ok('the server names the workspace version it read, and it is the version the page loaded', !!sent[0]?.workspaceEtag && sent[0].workspaceEtag === report.etag, JSON.stringify({ sent, etag: report.etag }));

  // A change lands between the page's reload and the report: the versions differ, the page reloads and tries once
  // more, and when they still differ it refuses rather than mix two versions.
  rewrite = body => { body.workspaceEtag = 'a-newer-version'; return body; };
  const changed = await build();
  ok('when the server read a different workspace version, the page reloads once more and then refuses with a plain message', changed.ok === false && changed.message === 'The shared workspace changed while the access review was being built. Try again in a moment.' && changed.reloads === 2, JSON.stringify(changed));

  // The statuses are decided on the Pacific day: a server time on another day than this computer is refused.
  rewrite = body => { body.generatedAt = new Date(Date.parse(body.generatedAt) + 2 * 86400000).toISOString(); return body; };
  const skewed = await build();
  ok('when this computer and the server are on different Pacific days, the report is refused with a plain message', skewed.ok === false && /does not match the server's/.test(skewed.message || '') && /Correct the computer's date and time/.test(skewed.message || ''), JSON.stringify(skewed));
  ok('no em dash in either refusal', !/\u2014/.test((changed.message || '') + (skewed.message || '')));
  rewrite = body => body;

  // A role given in another session: this tab's cached account still says General user, but the report reloads the
  // account list from the server before its own check, so the account the server knows as Master Access is let in.
  const fresh = await page.evaluate(async () => {
    const auth = window.skServer.context.auth, mine = auth.users.find(u => u.username === 'report-admin');
    window.skServer.context.auth = Object.assign({}, auth, { users: auth.users.map(u => u.username === 'report-admin' ? Object.assign({}, u, { role: 'general', roles: ['general'] }) : u) });
    const stale = skAuth.canReviewAccess();
    const r = await skAuth.accessReport();
    return { stale, ok: r.ok, message: r.message, after: skAuth.canReviewAccess(), role: mine && mine.role };
  });
  ok('a stale cached role does not refuse the report: the account list is reloaded from the server first', fresh.stale === false && fresh.ok === true && fresh.after === true, JSON.stringify(fresh));

  // A record change sent to the server but not yet confirmed (the queue already flushed) also makes it wait, as does a
  // workspace snapshot write in flight.
  const inflight = await page.evaluate(async () => {
    let reloads = 0; const real = refreshServerWorkspace;
    refreshServerWorkspace = async function () { reloads += 1; return real.apply(this, arguments); };
    serverActionPending += 1;
    let a, b; try { a = await skAuth.accessReport(); } finally { serverActionPending -= 1; }
    const sync = window.skServer.sync, before = sync.status; sync.status = 'saving';
    try { b = await skAuth.accessReport(); } finally { sync.status = before; refreshServerWorkspace = real; }
    return { a: a.message, b: b.message, reloads };
  });
  const WAIT = 'Your last change is still being saved to the server. Try the access review again once it is saved.';
  ok('a sent but unconfirmed change, or a snapshot write in flight, makes the report wait without reloading', inflight.a === WAIT && inflight.b === WAIT && inflight.reloads === 0, JSON.stringify(inflight));

  // A change this tab starts while the report requests are running: the server read the version before it, so the
  // report is refused rather than built from a page state the server has not confirmed.
  duringFetch = () => page.evaluate(() => { serverActionPending += 1; });
  let midway;
  try { midway = await page.evaluate(async () => { const r = await skAuth.accessReport(); return { ok: r.ok, message: r.message }; }); }
  finally { duringFetch = null; await page.evaluate(() => { serverActionPending -= 1; }); }
  ok('a change started while the report requests run makes the report wait instead of mixing versions', midway.ok === false && midway.message === WAIT, JSON.stringify(midway));

  // The generator is named from the account list the server read, not this tab's cache: a display name changed in
  // another session shows as the server has it.
  // The report response carries a name the tab's cache does not (as if renamed between the two requests).
  rewrite = body => { body.users = body.users.map(u => u.username === 'report-admin' ? Object.assign({}, u, { displayName: 'Name In The Report' }) : u); return body; };
  const named = await page.evaluate(async () => { const r = await skAuth.accessReport(); return { ok: r.ok, name: r.generatedBy && r.generatedBy.name, cached: skAuth.user().displayName }; });
  rewrite = body => body;
  ok('"Generated by" names the generator as the server read the account, not from this tab\'s cache', named.ok === true && named.name === 'Name In The Report' && named.cached !== 'Name In The Report', JSON.stringify(named));

  // An older account record keeps several standard roles in `roles`, which the server holds: the report lists the
  // second role as Active and the capabilities the server enforces, not the narrower set this page would derive.
  await server.store.upsertAccount({ username: 'legacy-two', displayName: 'Legacy Two', role: 'technician', roles: ['technician', 'qe'], extraRoles: [], roleTraining: {}, grants: {}, grantHistory: [], supportAccess: false, salt: '', hash: 'x'.repeat(64), createdBy: 'report-admin' });
  const legacy = await page.evaluate(async () => { const r = await skAuth.accessReport(); const row = (r.accounts || []).find(a => a.username === 'legacy-two'); return { ok: r.ok, message: r.message, row }; });
  ok('an account with two standard roles from an older record shows both, with the capabilities the server enforces', legacy.ok === true && !!legacy.row && legacy.row.extraRoles.some(x => x.role === 'Quality' && x.status === 'Active') && legacy.row.capabilities.length > 0, JSON.stringify(legacy));

  // Midnight Pacific time passing while the rows are built: refused, so no report mixes two days.
  // The clock moves forward at the first stamp check after the server's response has arrived, that is while the rows
  // are being derived (the page's own drawing also checks stamps, so the shift is armed only then).
  duringFetch = () => page.evaluate(() => { window.__armMidnight = true; });
  let midnight;
  try {
    midnight = await page.evaluate(async () => {
      const realNow = Date.now, realStamp = MES.hasValidInspectionStamp; let shifted = false;
      MES.hasValidInspectionStamp = function () { if (window.__armMidnight && !shifted) { shifted = true; const skew = 2 * 86400000; Date.now = () => realNow.call(Date) + skew; } return realStamp.apply(this, arguments); };
      try { const r = await skAuth.accessReport(); return { ok: r.ok, message: r.message, shifted }; } finally { Date.now = realNow; MES.hasValidInspectionStamp = realStamp; window.__armMidnight = false; }
    });
  } finally { duringFetch = null; }
  ok('when midnight Pacific time passes while the report is built, it is refused with a plain message', midnight.shifted === true && midnight.ok === false && /Midnight Pacific time passed/.test(midnight.message || '') && !/—/.test(midnight.message || ''), JSON.stringify(midnight));

  // The Admin page itself: with this tab's cached role stale (Quality Supervisor, who sees Admin but not the report),
  // opening Admin reloads the account list and draws the report action once the server's role allows it.
  const button = await page.evaluate(async () => {
    const auth = window.skServer.context.auth;
    window.skServer.context.auth = Object.assign({}, auth, { users: auth.users.map(u => u.username === 'report-admin' ? Object.assign({}, u, { role: 'qs', roles: ['qs'] }) : u) });
    view = 'admin'; render();
    const before = !!document.querySelector('[data-action="access-report"]');
    for (let i = 0; i < 50 && !document.querySelector('[data-action="access-report"]'); i += 1) await new Promise(r => setTimeout(r, 100));
    return { before, after: !!document.querySelector('[data-action="access-report"]') };
  });
  ok('Admin with a stale cached role reloads the accounts and shows the report action without a page reload', button.before === false && button.after === true, JSON.stringify(button));

  // A change the server has not confirmed: the report waits rather than reload over it.
  const waiting = await page.evaluate(async () => {
    let reloads = 0; const real = refreshServerWorkspace;
    refreshServerWorkspace = async function () { reloads += 1; return real.apply(this, arguments); };
    serverActionQueue.push({ action: 'test-unconfirmed' });
    try { const r = await skAuth.accessReport(); return { ok: r.ok, message: r.message, reloads }; } finally { serverActionQueue.pop(); refreshServerWorkspace = real; }
  });
  ok('with an unconfirmed change of its own, the page refuses with a plain message and does not reload', waiting.ok === false && waiting.message === 'Your last change is still being saved to the server. Try the access review again once it is saved.' && waiting.reloads === 0, JSON.stringify(waiting));
  ok('no em dash in the refusal', !/—/.test(waiting.message || ''));
} catch (error) {
  fails.push('setup: ' + error.message);
  console.log('FAIL setup -> ' + error.stack);
} finally {
  if (browser) await browser.close();
  await server.closeAsync();
}
ok('no page errors', errors.length === 0, JSON.stringify(errors));
console.log('errors', JSON.stringify(errors), 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
