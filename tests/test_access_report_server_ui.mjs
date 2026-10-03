// The access review report in server mode, in a real browser against the real server: the page reloads the shared
// workspace before it builds the report (so training and stamps another person changed are current), the report
// carries the generation time the server sent, not the workstation clock, and a change of the page's own that the
// server has not confirmed yet makes it wait with a plain message instead of building from a stale copy.
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

  // The server's time is the report's time: the response is rewritten to a time no workstation clock would show.
  const SENT = '2030-01-01T00:00:00.000Z';
  await page.route('**/api/auth/access-report', async route => { const response = await route.fetch(); const body = await response.json(); if (body && Array.isArray(body.users)) body.generatedAt = SENT; await route.fulfill({ response, json: body }); });
  const report = await page.evaluate(async () => {
    let reloads = 0; const real = refreshServerWorkspace;
    refreshServerWorkspace = async function () { reloads += 1; return real.apply(this, arguments); };
    try { const r = await skAuth.accessReport(); return { ok: r.ok, message: r.message, generatedAt: r.generatedAt, accounts: (r.accounts || []).map(a => a.username), reloads }; } finally { refreshServerWorkspace = real; }
  });
  ok('Master Access builds the report from the server', report.ok === true && report.accounts.includes('report-admin'), JSON.stringify(report));
  ok('the shared workspace is reloaded once before the report is built', report.reloads === 1, String(report.reloads));
  ok('the report carries the generation time the server sent', report.generatedAt === SENT, report.generatedAt);

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
