// Standalone (browser storage) sign-in lockouts are recorded like the server's (#594): five failed sign-ins lock
// the account for five minutes under skyryse-mes-lockout-v1 and leave a lockout record in the security log
// (skyryse-mes-security-v1), the record the server's audit keeps as `lockout` with the minutes; a locked account is
// refused even with the right password; a successful sign-in clears the count. The sign-in form works while the
// rest of the page is still loading, so the lockout is also recorded when it happens before the security log layer
// has started: the page is served with that layer held back, five failures lock the account, and the record is
// there once the layer starts.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const ROOT = path.resolve(TESTS, '..');
const FIXTURE = 'tests/fixtures/publish.html';
const fails = [], errs = [];
const ok = (w, c, m = '') => { console.log((c ? '  ok   ' : '  FAIL ') + w + (c ? '' : ' -> ' + m)); if (!c) fails.push(w); };
const LOCK_KEY = 'skyryse-mes-lockout-v1', SEC_KEY = 'skyryse-mes-security-v1', SESSION_KEY = 'skyryse-mes-session-v1';
const USER = 'qmgr', PASSWORD = 'correct-horse-9', SALT = 'a1b2c3';
const account = { username: USER, displayName: 'Quinn Manager', salt: SALT, hash: createHash('sha256').update(`${SALT}:${PASSWORD}`).digest('hex'), role: 'qm', createdAt: '2026-01-05T16:00:00.000Z' };

// ---- the page and the server agree on the rule and on the record ----
const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), server = fs.readFileSync(path.join(ROOT, 'server/server.mjs'), 'utf8');
const pageRule = /var LOCK_KEY='skyryse-mes-lockout-v1',LOCK_AFTER=(\d+),LOCK_MINUTES=(\d+);/.exec(page);
const serverRule = /const LOCK_AFTER = (\d+), LOCK_MS = (\d+) \* 60 \* 1000;/.exec(server);
ok('the page keeps lockouts under skyryse-mes-lockout-v1', !!pageRule);
ok('the page locks after as many failures, for as many minutes, as the server', !!pageRule && !!serverRule && pageRule[1] === serverRule[1] && pageRule[2] === serverRule[2] && pageRule[1] === '5' && pageRule[2] === '5', JSON.stringify([pageRule && pageRule.slice(1), serverRule && serverRule.slice(1)]));
ok('the server audits a lockout as `lockout` with its minutes', /store\.audit\(username, 'lockout', \{ minutes: LOCK_MS \/ 60000 \}\)/.test(server));
ok('the page records a lockout as `lockout` with the account and its minutes', /secEvent\('lockout',\{username:username,minutes:LOCK_MINUTES\}\)/.test(page));

// A local server for the production fixture. `stall` holds back a script placed just before the security log
// layer, so the page stops loading there while the sign-in form already works.
let release = null;
const stalled = new Promise(resolve => { release = resolve; });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const site = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__hold.js') { await stalled; res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.__held=true;'); return; }
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (url.searchParams.has('stall') && file.endsWith('.html')) {
    const text = body.toString('utf8'), at = text.indexOf(`var SEC_KEY = '${SEC_KEY}';`), open = text.lastIndexOf('<script>', at);
    body = Buffer.from(text.slice(0, open) + '<script src="/__hold.js"></script>' + text.slice(open));
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(body);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${site.address().port}/${FIXTURE}`;

const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const fresh = async () => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); return { ctx, p }; };
const seed = async p => {
  await p.goto(base); await p.waitForSelector('#sk-boot');
  await p.evaluate(([key, users]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify({ users })); }, ['skyryse-mes-auth-v1', [account]]);
};
const signIn = async (p, password) => {
  await p.waitForSelector('#sk-boot input[name=username]', { state: 'visible' });
  await p.locator('#sk-boot input[name=username]').fill(USER); await p.locator('#sk-boot input[name=password]').fill(password);
  await p.locator('#sk-boot form').evaluate(f => f.requestSubmit());
  await p.waitForFunction(key => { const btn = document.getElementById('sk-login-submit'), err = document.getElementById('sk-login-error'); return sessionStorage.getItem(key) || (btn && !btn.disabled && err && err.textContent); }, SESSION_KEY);
  return p.evaluate(key => ({ error: (document.getElementById('sk-login-error') || {}).textContent || '', session: sessionStorage.getItem(key) }), SESSION_KEY);
};
const stored = p => p.evaluate(([lock, sec, user]) => ({ lock: (JSON.parse(localStorage.getItem(lock) || '{}'))[user] || null, log: JSON.parse(localStorage.getItem(sec) || '[]') }), [LOCK_KEY, SEC_KEY, USER]);
const lockouts = log => log.filter(e => e.type === 'lockout' && e.username === USER);

try {
  // ---- five failures lock for five minutes and leave the record ----
  {
    const { ctx, p } = await fresh(); await seed(p); await p.reload();
    for (let i = 1; i <= 4; i++) await signIn(p, `wrong-password-${i}`);
    let s = await stored(p);
    ok('four failed sign-ins count but do not lock', s.lock && s.lock.fails === 4 && !(s.lock.until > Date.now()) && lockouts(s.log).length === 0, JSON.stringify(s.lock));
    const before = Date.now(), fifth = await signIn(p, 'wrong-password-5'), after = Date.now();
    s = await stored(p);
    ok('the fifth failure says the account is locked for 5 minutes', /Account locked for 5 minutes\./.test(fifth.error) && !fifth.session, fifth.error);
    ok('the account is locked for five minutes under skyryse-mes-lockout-v1', s.lock && s.lock.fails === 0 && s.lock.until >= before + 5 * 60000 && s.lock.until <= after + 5 * 60000, JSON.stringify(s.lock));
    const rec = lockouts(s.log);
    ok('one lockout record names the account and the minutes, at the time of the fifth failure', rec.length === 1 && rec[0].minutes === 5 && Date.parse(rec[0].at) >= before - 1000 && Date.parse(rec[0].at) <= after + 1000, JSON.stringify(rec));
    ok('the five failures are recorded too, the lockout with the fifth', s.log.filter(e => e.type === 'signin-failed' && e.username === USER).length === 5 && s.log.findIndex(e => e.type === 'lockout') === 4, JSON.stringify(s.log.map(e => e.type)));
    // Refusal: the right password is refused while locked, and nothing signs in.
    const blocked = await signIn(p, PASSWORD);
    s = await stored(p);
    ok('a locked account is refused even with the right password', /Too many failed attempts\. Try again in 5 minutes\./.test(blocked.error) && !blocked.session, JSON.stringify(blocked));
    ok('the refused attempt is recorded as signin-blocked and the lock stands', s.log.some(e => e.type === 'signin-blocked' && e.username === USER) && s.lock.until > Date.now() && lockouts(s.log).length === 1, JSON.stringify(s.lock));
    // Five minutes later (the stored lock moved into the past): the right password signs in and clears the count.
    await p.evaluate(([key, user]) => { const all = JSON.parse(localStorage.getItem(key)); all[user].until = Date.now() - 1000; localStorage.setItem(key, JSON.stringify(all)); }, [LOCK_KEY, USER]);
    const good = await signIn(p, PASSWORD);
    s = await stored(p);
    ok('after the five minutes the right password signs in', good.session === USER, JSON.stringify(good));
    ok('a successful sign-in clears the count and the lock and is recorded', s.lock && s.lock.fails === 0 && s.lock.until === 0 && s.log.some(e => e.type === 'signin' && e.username === USER), JSON.stringify(s.lock));
    await ctx.close();
  }
  // ---- success clears the count: failures before it do not add to failures after it ----
  {
    const { ctx, p } = await fresh(); await seed(p); await p.reload();
    for (let i = 1; i <= 4; i++) await signIn(p, `wrong-password-${i}`);
    const good = await signIn(p, PASSWORD);
    let s = await stored(p);
    ok('four failures then the right password signs in and clears the count', good.session === USER && s.lock.fails === 0 && s.lock.until === 0, JSON.stringify(s.lock));
    await p.evaluate(() => sessionStorage.clear()); await p.reload();
    for (let i = 1; i <= 4; i++) await signIn(p, `wrong-password-again-${i}`);
    s = await stored(p);
    ok('four more failures after that success do not lock and leave no lockout record', s.lock.fails === 4 && !(s.lock.until > Date.now()) && lockouts(s.log).length === 0, JSON.stringify(s.lock));
    await ctx.close();
  }
  // ---- a lockout before the security log layer has started is still recorded ----
  {
    const { ctx, p } = await fresh(); await seed(p);
    await p.goto(base + '?stall=1', { waitUntil: 'commit' });
    await p.waitForSelector('#sk-boot input[name=username]', { state: 'visible' });
    const early = await p.evaluate(() => ({ layer: !!window.skSecurityLog, held: !!window.__held }));
    ok('the sign-in form works while the security log layer has not started', !early.layer && !early.held, JSON.stringify(early));
    const before = Date.now();
    for (let i = 1; i <= 5; i++) await signIn(p, `wrong-password-${i}`);
    let s = await stored(p);
    ok('five early failures lock the account for five minutes', s.lock && s.lock.until >= before + 5 * 60000 && !(await p.evaluate(() => !!window.skSecurityLog)), JSON.stringify(s.lock));
    release();
    await p.waitForFunction(() => !!window.skSecurityLog);
    s = await stored(p);
    const rec = lockouts(s.log);
    ok('once the layer starts, the early lockout is in the security log with its minutes and the time it happened', rec.length === 1 && rec[0].minutes === 5 && Date.parse(rec[0].at) >= before - 1000, JSON.stringify(s.log));
    ok('the early failures are recorded in the order they happened', JSON.stringify(s.log.filter(e => e.username === USER).map(e => e.type)) === JSON.stringify(['signin-failed', 'signin-failed', 'signin-failed', 'signin-failed', 'lockout', 'signin-failed']), JSON.stringify(s.log.map(e => e.type)));
    ok('nothing is left waiting and no record is written twice', await p.evaluate(() => (window.skSecurityPending || []).length === 0) && lockouts((await stored(p)).log).length === 1);
    await ctx.close();
  }
} finally {
  release();
  await b.close();
  site.close();
}
ok('no page errors', errs.length === 0, errs.join(' | '));
console.log('errors', errs, 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
