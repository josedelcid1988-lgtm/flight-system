// #583: browser security headers on every server response, and the page still works under its Content-Security-Policy.
// Each header is checked on the page, a JSON route, an error, a static asset, the demo page and an evidence download.
// The policy itself is checked for what it refuses (an injected script or event handler, a framing site, any CDN) and,
// in Chromium, for what it must allow: the production page signed in through the server and the demo page are walked
// through every view, three work orders with every tab, and every print window, with no policy violation and no page
// error. A new inline event handler in index.html fails here until it is reviewed and added to INLINE_HANDLERS.
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer, makeHash } from '../server/server.mjs';
import { BASE_HEADERS, EVIDENCE_CSP, INLINE_HANDLERS, NON_PAGE_CSP, connectSources, hashSource, inlineScriptHashes, pageCsp } from '../server/security-headers.mjs';

const fails = [];
let checks = 0;
const ok = (name, pass, detail = '') => { checks += 1; if (pass) console.log(`ok ${name}`); else { fails.push(name); console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); } };
const directives = csp => Object.fromEntries(String(csp || '').split(';').map(part => part.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...values]) => [name, values]));

// ---- the policy builder ----------------------------------------------------------------------------------------
{
  const html = '<script>one()</script><script src="assets/x.js"></script><script id="b">two()\r\nthree()</script ><p>text</p><SCRIPT>four()</SCRIPT>';
  const hashes = inlineScriptHashes(html);
  ok('inline script hashes: one per inline script, none for a script file', hashes.length === 3, JSON.stringify(hashes));
  ok('inline script hashes: CR LF is hashed as LF, as the browser does', hashes.includes(hashSource('two()\nthree()')), JSON.stringify(hashes));
  ok('inline script hashes: tags are matched in any case', hashes.includes(hashSource('four()')));
  const page = directives(pageCsp(hashes));
  ok('page policy: scripts from this server and listed hashes only, never unsafe-inline or unsafe-eval', page['script-src'][0] === "'self'" && !page['script-src'].includes("'unsafe-inline'") && !page['script-src'].includes("'unsafe-eval'") && hashes.every(h => page['script-src'].includes(h)), JSON.stringify(page['script-src']));
  ok('page policy: only the reviewed inline handlers are allowed, by hash', page['script-src'].includes("'unsafe-hashes'") && INLINE_HANDLERS.every(h => page['script-src'].includes(hashSource(h))));
  ok('page policy: no framing, no plugins, no base URL change', page['frame-ancestors']?.join(' ') === "'none'" && page['object-src']?.join(' ') === "'none'" && page['base-uri']?.join(' ') === "'none'");
  ok('page policy: no remote origin anywhere (local assets only)', !/https?:|\*/.test(pageCsp(hashes)), pageCsp(hashes));
  ok('page policy: connect-src is this server unless the operator lists more', page['connect-src'].join(' ') === "'self'");
  ok('page policy: listed connect origins are added', directives(pageCsp([], ['https://skyryse.okta.com']))['connect-src'].join(' ') === "'self' https://skyryse.okta.com");
  ok('connect origins: a default port and capitals in the host are stored as the origin', JSON.stringify(connectSources('https://Skyryse.Okta.com:443 http://mirror.example:80')) === JSON.stringify(['https://skyryse.okta.com', 'http://mirror.example']));
  ok('page policy: a frame may show only this server and blob: URLs the page made (the training certificate preview)', page['frame-src']?.join(' ') === "'self' blob:");
  ok('connect origins: spaces and commas separate, duplicates and a trailing slash collapse', JSON.stringify(connectSources('https://a.example, https://a.example/ wss://b.example:8443')) === JSON.stringify(['https://a.example', 'wss://b.example:8443']));
  for (const bad of ['*', 'https:', 'https://a.example/path', 'https://a.example?x=1', 'https://a.example#x', 'https://user:pw@a.example', 'https://*', 'http://*', 'wss://*', 'https://*:443', 'https://*.okta.com', 'https://%2a', 'https://%2a:443', 'https://%2a.example.com', 'https://allowed.example;frame-ancestors', "https://allowed.example'", 'https://allowed.example\\x', 'javascript:alert(1)', 'data:', 'a.example', "'unsafe-inline'"]) {
    let error = null; try { connectSources(bad); } catch (e) { error = e; }
    ok(`connect origins: "${bad}" is refused with what to write instead`, !!error && /not an origin/.test(error.message) && /https:\/\/skyryse\.okta\.com/.test(error.message), error?.message);
  }
  // A refused entry is named by position, never repeated: it can hold a credential, and the error reaches the log.
  for (const [value, position] of [['https://operator:tokenvalue@identity.example', 1], ['https://ok.example https://operator:tokenvalue@identity.example/path', 2], ['https://identity.example/?token=tokenvalue', 1]]) {
    let error = null; try { connectSources(value); } catch (e) { error = e; }
    ok(`connect origins: a refused entry holding a credential is named as entry ${position} and never echoed`, !!error && error.message.includes(`entry ${position} `) && !error.message.includes('tokenvalue') && !error.message.includes('operator'), error?.message);
  }
  let logged = null; try { createServer({ dbPath: ':memory:', quiet: true, cspConnectSrc: 'https://operator:tokenvalue@identity.example' }); } catch (e) { logged = e; }
  ok('the server start refusal does not carry the credential either', !!logged && !String(logged.stack).includes('tokenvalue'), logged?.message);
  let startError = null; try { createServer({ dbPath: ':memory:', quiet: true, cspConnectSrc: '*' }); } catch (e) { startError = e; }
  ok('the server does not start with a connect origin that is not an origin', !!startError && /FLIGHT_CSP_CONNECT_SRC/.test(startError.message), startError?.message);
}

// ---- inline handler inventory: a new one must be reviewed ------------------------------------------------------
{
  const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const found = [...new Set([...source.matchAll(/\son[a-z]+=(["'])(.*?)\1/g)].map(m => m[2]))];
  ok('index.html writes no inline event handler except the reviewed ones', found.every(h => INLINE_HANDLERS.includes(h)), `unreviewed: ${JSON.stringify(found.filter(h => !INLINE_HANDLERS.includes(h)))}`);
  ok('every reviewed inline handler is still used (the list does not grow stale)', INLINE_HANDLERS.every(h => found.includes(h)), JSON.stringify(found));
}

// ---- the headers on each kind of response ------------------------------------------------------------------------
const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'headers-setup-code', serveDemo: true });
let browser;
try {
  const port = await server.listenAsync(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const baseOk = (label, response) => {
    for (const [name, value] of Object.entries(BASE_HEADERS)) ok(`${label}: ${name} ${value}`, response.headers.get(name) === value, response.headers.get(name));
    ok(`${label}: Content-Security-Policy frame-ancestors 'none'`, directives(response.headers.get('content-security-policy'))['frame-ancestors']?.join(' ') === "'none'", response.headers.get('content-security-policy'));
  };
  const pageResponse = await fetch(`${origin}/`);
  const pageHtml = await pageResponse.text();
  baseOk('page', pageResponse);
  const pagePolicy = directives(pageResponse.headers.get('content-security-policy'));
  ok('page: the policy lists every inline script it serves, the server context script included', inlineScriptHashes(pageHtml).every(h => pagePolicy['script-src'].includes(h)) && /<script id="flight-server">/.test(pageHtml));
  const again = await fetch(`${origin}/`);
  ok('page: a second response lists its own server context script', inlineScriptHashes(await again.text()).every(h => directives(again.headers.get('content-security-policy'))['script-src'].includes(h)));
  for (const [label, url] of [['JSON route', '/api/health'], ['not found', '/no-such-page'], ['refused API call', '/api/workspace'], ['static asset', '/assets/flight-ui.css'], ['script file', '/assets/flight-ui.js']]) {
    const response = await fetch(origin + url);
    baseOk(label, response);
    ok(`${label}: the non-page policy (nothing runs, nothing loads)`, response.headers.get('content-security-policy') === NON_PAGE_CSP, response.headers.get('content-security-policy'));
  }
  const demo = await fetch(`${origin}/demo.html`), demoHtml = await demo.text();
  baseOk('demo page', demo);
  ok('demo page: the page policy built from its own inline scripts', inlineScriptHashes(demoHtml).every(h => directives(demo.headers.get('content-security-policy'))['script-src'].includes(h)));

  // Evidence bytes: a sandboxed attachment that the browser does not sniff.
  await server.store.upsertAccount({ username: 'headers-qa', displayName: 'Headers QA', salt: '', hash: await makeHash('headers-qa-password'), role: 'qm', roles: ['qm'], createdAt: new Date().toISOString(), createdBy: 'test' });
  const token = (await (await fetch(`${origin}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'headers-qa', password: 'headers-qa-password' }) })).json()).token;
  const id = 'EV-12345678-1234-4234-8234-1234567890ab';
  const stored = await fetch(`${origin}/api/evidence/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/webm' }, body: Buffer.from('<html><script>alert(1)</script>') });
  ok('evidence upload stored', stored.status === 201, stored.status);
  const evidence = await fetch(`${origin}/api/evidence/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  baseOk('evidence download', evidence);
  ok('evidence download: a sandboxed policy', evidence.headers.get('content-security-policy') === EVIDENCE_CSP, evidence.headers.get('content-security-policy'));
  ok('evidence download: an attachment named by its ID and type', evidence.headers.get('content-disposition') === `attachment; filename="${id}.webm"`, evidence.headers.get('content-disposition'));
  ok('evidence download: served as its stored type', evidence.headers.get('content-type') === 'video/webm');
  await server.store.closeSessionsOf('headers-qa');

  // ---- in Chromium: the app runs under the policy, and the policy refuses what it should ----------------------------
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const walk = async (label, signIn, minPrinted) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    await context.exposeBinding('__cspViolation', (source, text) => problems.push(`violation ${text}`));
    await context.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.__cspViolation(`${e.violatedDirective} ${e.blockedURI} ${String(e.sample).slice(0, 80)}`)));
    const watch = p => { p.on('console', m => { if (/Content Security Policy/i.test(m.text())) problems.push(`console ${m.text().slice(0, 200)}`); }); p.on('pageerror', e => problems.push(`page error ${e.message.slice(0, 200)}`)); };
    context.on('page', watch);
    const page = await context.newPage();
    await signIn(page);
    const views = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-view]')].map(b => b.dataset.view))]);
    for (const name of views) { await page.evaluate(n => { view = n; render(); }, name); await page.waitForTimeout(250); }
    const printed = new Set();
    for (const pick of ['fair', 'conformity', 'any']) {
      const order = await page.evaluate(k => { const o = state.orders.find(x => k === 'fair' ? x.fair : k === 'conformity' ? x.form8130_9 || x.conformity : true); if (o) openOrder(o.id); return o && o.id; }, pick);
      if (!order) continue;
      await page.waitForTimeout(500);
      const tabs = await page.locator('[data-action="tab"]:visible').count();
      for (let i = 0; i < tabs; i++) {
        await page.locator('[data-action="tab"]:visible').nth(i).click().catch(() => {});
        await page.waitForTimeout(250);
        for (const action of ['print-traveler', 'print-order', 'fair-print', 'conf-8130-print']) {
          // A print control inside a closed menu is clicked through the page, as its menu item would.
          const button = page.locator(`[data-action="${action}"]:visible`).first();
          if (printed.has(action) || !(await page.locator(`[data-action="${action}"]`).count())) continue;
          const popup = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
          if (await button.count()) await button.click().catch(() => {});
          else await page.evaluate(a => document.querySelector(`[data-action="${a}"]`).click(), action);
          const w = await popup;
          if (!w) continue;
          await w.waitForLoadState().catch(() => {});
          // With the server, a print window fills once the server confirms its print record.
          await w.locator('.print-action').first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
          await w.waitForTimeout(300);
          // The print document's own Print button is one of the reviewed inline handlers: it must still run.
          if (await w.locator('.print-action').count()) {
            await w.evaluate(() => { window.print = () => { window.__printed = true; }; });
            await w.locator('.print-action').first().click();
            ok(`${label}: ${action} window's Print button runs`, await w.evaluate(() => window.__printed === true));
          }
          printed.add(action);
          await w.close();
        }
      }
    }
    // A training certificate opens in an iframe from a blob: URL the page made; an image and a PDF both load.
    const certificate = await page.evaluate(async () => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
      const loads = [];
      for (const [bytes, type] of [[png, 'image/png'], [pdf, 'application/pdf']]) {
        const frame = document.createElement('iframe'); frame.src = URL.createObjectURL(new Blob([bytes], { type }));
        loads.push(new Promise(resolve => { frame.addEventListener('load', () => resolve(true)); setTimeout(() => resolve(false), 5000); }));
        document.body.appendChild(frame);
      }
      return Promise.all(loads);
    });
    await page.waitForTimeout(500);
    ok(`${label}: a training certificate preview (image and PDF in a blob: iframe) loads`, certificate.every(Boolean), JSON.stringify(certificate));
    // The credentials dialog carries the other reviewed handler (Sign out).
    await page.evaluate(() => profileDialog());
    await page.waitForTimeout(300);
    ok(`${label}: every view, three work orders with every tab and the print windows raise no policy violation or page error`, problems.length === 0, JSON.stringify(problems.slice(0, 5)));
    ok(`${label}: the walk reached every view and printed`, views.length >= 15 && printed.size >= minPrinted, `views ${views.length}, printed ${[...printed]}`);
    // What the policy is for: injected markup does not run.
    const before = problems.length;
    const ran = await page.evaluate(async () => {
      const s = document.createElement('script'); s.textContent = 'window.__injectedScript = true'; document.body.appendChild(s);
      const d = document.createElement('div'); d.innerHTML = '<img src="data:," onerror="window.__injectedHandler = true">'; document.body.appendChild(d);
      await new Promise(r => setTimeout(r, 300));
      return [window.__injectedScript === true, window.__injectedHandler === true];
    });
    await page.waitForTimeout(300);
    ok(`${label}: an injected script and an injected event handler do not run`, !ran[0] && !ran[1], JSON.stringify(ran));
    ok(`${label}: each injection is reported as a violation`, problems.length - before >= 2, JSON.stringify(problems.slice(before)));
    await context.close();
  };
  await walk('production page through the server', async page => {
    await page.goto(`${origin}/`);
    await page.locator('#sk-login').waitFor({ state: 'visible' });
    await page.locator('#sk-username').fill('headers-qa');
    await page.locator('#sk-password').fill('headers-qa-password');
    await page.locator('#sk-login-submit').click();
    await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 30000 });
    await page.locator('#main .flight-react').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 30000 });
    // A production workspace starts with no orders: create one through the engine, as a planner would, to print it.
    const created = await page.evaluate(() => { const next = structuredClone(state); const r = MES.addAdhocOrder(next, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: 'C3', partNumber: 'CSP-TEST-001', title: 'Policy walk order', revision: 'A' }); if (r.ok) mediaCommit(next); return r; });
    ok('production page: an order is created through the server under the policy', created.ok === true, JSON.stringify(created));
    await page.waitForFunction(() => state.orders.length > 0 && window.skServer?.sync?.status === 'synced', null, { timeout: 30000 });
  }, 1);
  await walk('demo page served by the server', async page => {
    await page.goto(`${origin}/demo.html`);
    await page.locator('#sk-login').waitFor({ state: 'visible' });
    await page.locator('#sk-username').fill('demo');
    await page.locator('#sk-password').fill('demo1234');
    await page.locator('#sk-login-submit').click();
    await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 30000 });
  }, 2);

  // Another site cannot frame the app.
  const framing = await browser.newPage();
  const framed = [];
  framing.on('console', m => { if (/frame-ancestors|X-Frame-Options/i.test(m.text())) framed.push(m.text()); });
  await framing.setContent(`<iframe id="f" src="${origin}/"></iframe>`);
  await framing.waitForTimeout(1500);
  const inner = framing.frames().find(f => f !== framing.mainFrame());
  const innerHasApp = inner ? await inner.evaluate(() => !!document.getElementById('sk-login')).catch(() => false) : false;
  ok('another site framing the app gets nothing', !innerHasApp && framed.length > 0, JSON.stringify({ innerHasApp, framed: framed.slice(0, 1) }));
  await framing.close();
} finally {
  if (browser) await browser.close();
  await server.closeAsync();
}

console.log(`FAILS ${JSON.stringify(fails)}`);
console.log(`security headers: checks ${checks} pass ${checks - fails.length} fail ${fails.length}`);
process.exit(fails.length ? 1 : 0);
