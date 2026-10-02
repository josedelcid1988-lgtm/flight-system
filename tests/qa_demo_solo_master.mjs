// Solo walk-through of the demo build: one person signs in as master on the real sign-in screen and drives every
// multi-person workflow to its final state through the interface (clicks and form fills). Engine calls are used
// only to read state for the checks. Every refusal the page gives is collected; the run fails if any of them says
// another person is needed. A short counterpart signs in as the pilot seats tech and quality and proves a
// self-approval is still refused there, so both demo modes are covered.
//   node tests/qa_demo_solo_master.mjs                every workflow
//   ONLY=wo,fai node tests/qa_demo_solo_master.mjs    named workflows only (development aid)
// The workflows themselves are in tests/lib/solo_master_flows.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { FLOWS, pilotCounterpart } from './lib/solo_master_flows.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = process.env.FS_FIXTURES_DIR ? path.resolve(process.env.FS_FIXTURES_DIR) : path.join(TESTS, 'fixtures');
const DEMO_URL = pathToFileURL(path.join(FIXTURES, 'demo_publish.html')).href;
const SHOTS = path.join(TESTS, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'fs-solo-'));
const CHROME = process.env.CHROME_PATH; // set CHROME_PATH when the Playwright browser is not the installed one
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()) : null;
const PASSWORD = 'demo1234';
const today = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const kitFile = path.join(SCRATCH, 'netsuite-kit-list.pdf'); fs.writeFileSync(kitFile, '%PDF-1.4\n% demo kit list\n');
const photoFile = path.join(SCRATCH, 'evidence.png');
fs.writeFileSync(photoFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

// A refusal that says the step needs another person. A success message that names the next person ("a second
// person reviews it in box 22 next") is not a refusal: it comes back from an engine call that succeeded.
export const NEEDS_ANOTHER_PERSON = /separation of duties|\b(cannot|can.t|may not) (approve|review|release|inspect|close|verify|sign|accept|record|assign|issue|change)\b[^.]*\b(own|their|you|your)\b|\b(different|second|another|independent) (person|credential|quality (account|credential|reviewer)|qa (account|manager)|reviewer|inspector|account|discipline)\b|\bnobody (inspects|approves|releases|records|issues|assigns|changes|grants)\b|\bnot the person who\b|\bthe person who (requested|recorded|wrote|verified|completed|authored|opened|performed|built)\b|\bthird person\b|\balready (approved|voted)\b|\byou (verified|completed|recorded|authored|requested|performed|wrote|built)\b/i;

const FAILS = [];
const RESULTS = [];
const ALL_REFUSALS = [];
const pageErrors = [];
let flowName = '';
let expectRefusals = false; // the pilot counterpart expects separation-of-duties refusals

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', e => pageErrors.push(e.message));
page.on('dialog', d => d.accept());

function log(ok, what, detail = '') {
  const where = flowName ? flowName + ': ' : '';
  console.log((ok ? '  ok   ' : '  FAIL ') + where + what + (ok || !detail ? '' : ' -> ' + detail));
  if (!ok) FAILS.push(where + what + (detail ? ' -> ' + String(detail).slice(0, 300) : ''));
  return ok;
}
const check = (what, cond, detail) => log(!!cond, what, cond ? '' : detail);

// ---------- page helpers ----------
const wait = ms => page.waitForTimeout(ms);
const settle = () => wait(350);
const dialogOpen = () => page.evaluate(() => !!document.querySelector('#dialog[open]'));
const dialogText = () => page.evaluate(() => document.querySelector('#dialog[open]')?.innerText || '');
const toast = () => page.evaluate(() => document.querySelector('#toast p')?.textContent || '');
const read = (fn, arg) => page.evaluate(fn, arg);

// Every engine result is recorded, so a refusal is caught however the screen shows it, together with the text the
// page puts in a toast or a form error.
async function instrument() {
  await page.evaluate(() => {
    if (window.__soloWrapped) return; window.__soloWrapped = true;
    window.__refusals = []; window.__successes = []; window.__uiMessages = [];
    for (const name of ['MES', 'FlightManeuver', 'FlightPlan', 'skAuth']) {
      const obj = window[name]; if (!obj || Object.isFrozen(obj)) continue;
      for (const key of Object.keys(obj)) {
        const fn = obj[key]; if (typeof fn !== 'function' || /^[A-Z]/.test(key)) continue;
        const d = Object.getOwnPropertyDescriptor(obj, key); if (!d || !d.writable) continue;
        obj[key] = function (...args) {
          const r = fn.apply(this, args);
          if (r && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.message === 'string') (r.ok ? window.__successes : window.__refusals).push(r.message);
          return r;
        };
      }
    }
    // Read the list at call time: drainRefusals swaps in a new one.
    const grab = el => { const seen = window.__uiMessages, t = (el.textContent || '').trim(); if (t && seen[seen.length - 1] !== t) seen.push(t); };
    new MutationObserver(ms => { for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; const host = el?.closest?.('#toast p, .form-error, [role=alert]'); if (host) grab(host); } })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

// What the page refused since the last call. A refusal that names another person fails the step.
async function drainRefusals(label) {
  const r = await page.evaluate(() => { const out = { refusals: window.__refusals || [], successes: window.__successes || [], ui: window.__uiMessages || [] }; window.__refusals = []; window.__successes = []; window.__uiMessages = []; return out; });
  const success = new Set(r.successes);
  const texts = [...new Set([...r.refusals, ...r.ui.filter(t => !success.has(t))])];
  for (const text of texts) {
    ALL_REFUSALS.push({ flow: flowName, step: label, text, user: await read(() => skAuth.user()?.username).catch(() => null) });
    if (!expectRefusals && NEEDS_ANOTHER_PERSON.test(text)) log(false, label + ': refusal says another person is needed', text);
  }
  return texts;
}

// Clicks go through Playwright's actionability checks only: a control a person could not click (hidden, covered,
// disabled) fails the step instead of being activated from script. A control inside a closed menu (a <details> such
// as an order's More menu) is reached the way a person reaches it: its menu is opened with a click first.
async function clickLoc(loc, { timeout = 5000 } = {}) {
  if (!await loc.isVisible()) {
    const menu = loc.locator('xpath=ancestor::details[not(@open)][1]/summary');
    if (await menu.count()) await menu.first().click({ timeout });
  }
  await loc.click({ timeout });
}
async function click(selector, { root = '#main', timeout = 5000 } = {}) {
  const loc = page.locator(`${root} ${selector}`).first();
  if (!await loc.count()) throw new Error(`no control ${root} ${selector}`);
  await clickLoc(loc, { timeout });
  await settle();
}
async function clickText(text, { root = '#main', tag = 'button', timeout = 5000 } = {}) {
  const loc = page.locator(`${root} ${tag}`).filter({ hasText: text }).first();
  if (!await loc.count()) throw new Error(`no ${tag} "${text}" in ${root}`);
  await clickLoc(loc, { timeout });
  await settle();
}
async function closeDialog() {
  if (await dialogOpen()) { await page.evaluate(() => document.querySelector('#dialog[open]')?.close()); await wait(150); }
}
// Navigation goes through the side navigation; entries of a module that is not shown are clicked in place.
async function nav(viewName) {
  await closeDialog();
  const btn = page.locator(`[data-action=nav][data-view="${viewName}"]`).first();
  if (!await btn.count()) throw new Error('no navigation to ' + viewName);
  // Only a link that is not shown (its module is not the one on screen) is activated in place; a shown link that cannot
  // be clicked fails the step.
  if (await btn.isVisible()) await btn.click({ timeout: 5000 }); else await btn.evaluate(e => e.click());
  await wait(450);
  await page.evaluate(() => document.querySelectorAll('.mnv-landing').forEach(e => e.remove()));
}
// Fills named fields: text, number, date, textarea, select (value or label), checkbox (true/false or value), radio.
async function fill(root, fields) {
  for (const [name, value] of Object.entries(fields)) {
    const loc = page.locator(`${root} [name="${name}"]`);
    if (!await loc.count()) throw new Error(`no field ${name} in ${root}`);
    const first = loc.first();
    const kind = await first.evaluate(e => e.tagName === 'SELECT' ? 'select' : (e.type || 'text'));
    if (kind === 'radio') await page.locator(`${root} [name="${name}"][value="${value}"]`).first().check();
    else if (kind === 'checkbox') { if (typeof value === 'boolean') await first.setChecked(value); else await page.locator(`${root} [name="${name}"][value="${value}"]`).first().check(); }
    else if (kind === 'select') {
      const opts = await first.evaluate(e => [...e.options].map(o => ({ v: o.value, t: o.textContent.trim() })));
      const hit = opts.find(o => o.v === value) || opts.find(o => o.t === value) || opts.find(o => o.v && (o.t.startsWith(value) || o.v.startsWith(value)));
      if (!hit) throw new Error(`no option ${value} for ${name}: ${opts.map(o => o.v).join('/')}`);
      await first.selectOption(hit.v);
    } else await first.fill(String(value));
    await wait(80);
  }
}
async function submitDialog(text) {
  const all = page.locator('#dialog[open] button[type=submit]:not([data-action])');
  const loc = text ? all.filter({ hasText: text }).first() : all.last();
  if (!await loc.count()) throw new Error('no submit button' + (text ? ' "' + text + '"' : '') + ' in the dialog');
  await loc.click(); await wait(450);
}
async function openOrder(id) {
  await nav('orders');
  const row = page.locator(`#main tr[data-order-row="${id}"] button.fr-record-link`).first();
  if (!await row.count()) throw new Error('order ' + id + ' is not listed in All work orders');
  await row.click(); await wait(300);
  // The row opens a summary panel; Open full work order goes to the order page.
  await page.locator('dialog.fr-drawer[open] button.fr-primary').filter({ hasText: 'Open full work order' }).first().click();
  await wait(450);
  const at = await read(() => [view, selectedId]);
  if (at[0] !== 'order' || at[1] !== id) throw new Error(`order ${id} did not open (view ${at[0]}, ${at[1]})`);
}
// The stage chips of a work order: record, materials, operations, quality, inventory.
const orderTab = name => click(`[data-action=tab][data-tab="${name}"]`);
const order = id => read(i => { const o = MES.getOrder(state, i); return o && JSON.parse(JSON.stringify(o)); }, id);
const valid = () => read(() => MES.validate(state));
async function expectValid(what) { const ok = await valid(); return check(`${what}: MES.validate(state) is true`, ok, ok ? '' : JSON.stringify(await read(() => MES.diagnose(state))).slice(0, 400)); }

// One user action. It passes when its function returns without throwing; the refusals it caused are checked
// either way, and a failure leaves a screenshot.
async function step(label, fn) {
  try { const r = await fn(); await drainRefusals(label); log(true, label); return r; }
  catch (e) {
    const refused = await drainRefusals(label).catch(() => []);
    log(false, label, e.message + (refused.length ? ' | page said: ' + refused.slice(-2).join(' / ') : ''));
    await page.screenshot({ path: path.join(SHOTS, 'solo_' + (flowName + '_' + label).replace(/[^a-z0-9]+/gi, '_').slice(0, 70) + '.png') }).catch(() => {});
    throw e;
  }
}
async function flow(name, title, fn) {
  if (ONLY && !ONLY.includes(name)) return;
  flowName = title; const before = FAILS.length; let note = '';
  try { note = (await fn()) || ''; } catch (e) { if (FAILS.length === before) log(false, 'aborted', e.message); }
  await closeDialog().catch(() => {});
  await expectValid('workspace after the flow').catch(e => log(false, 'validate', e.message));
  RESULTS.push({ flow: title, pass: FAILS.length === before, note, fails: FAILS.slice(before) });
  flowName = '';
}

async function signIn(username) {
  // The demo keeps its session under its own key (D-41); clear both so the sign-in screen shows.
  await page.evaluate(() => { try { for (const k of ['skyryse-mes-demo-session-v1', 'skyryse-mes-session-v1']) sessionStorage.removeItem(k); } catch {} }).catch(() => {});
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sk-username', { timeout: 15000 });
  check(`the sign-in screen for ${username} says DEMO, NOT FOR ACCEPTANCE`, await page.evaluate(() => document.body.innerText.includes('DEMO, NOT FOR ACCEPTANCE')));
  await page.fill('#sk-username', username);
  await page.fill('#sk-password', PASSWORD);
  await page.click('#sk-login-submit');
  await page.waitForFunction(() => !document.getElementById('sk-boot'), null, { timeout: 15000 });
  await wait(600);
  await page.evaluate(() => { document.querySelectorAll('.mnv-landing').forEach(e => e.remove()); try { sessionStorage.setItem('sk-mnv-landing-seen', '1'); } catch {} });
  await instrument();
  const who = await read(() => skAuth.user()?.username);
  check(`signed in through the sign-in screen as ${username}`, who === username, 'signed in as ' + who);
}

async function expectPrint(label, trigger) {
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 8000 }).catch(() => null), trigger()]);
  if (!popup) return check(`${label} opens`, false, 'no print window opened; toast: ' + await toast());
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const text = await popup.evaluate(() => document.body?.innerText || '').catch(() => '');
  await popup.close().catch(() => {});
  return check(`${label} opens and says DEMO, NOT FOR ACCEPTANCE`, /DEMO, NOT FOR ACCEPTANCE/.test(text), text.slice(0, 200));
}

// The "Start over" line in docs/DEMO_QUICK_START.md, run exactly as written: it must bring the sample data back and
// leave every production key alone (the demo and production can share one browser storage origin).
async function quickStartReset(sample) {
  const doc = fs.readFileSync(path.join(TESTS, '..', 'docs', 'DEMO_QUICK_START.md'), 'utf8');
  const code = (doc.match(/## 4\. Start over[\s\S]*?```js\n([\s\S]*?)\n\s*```/) || [])[1];
  if (!check('the quick start gives a reset line', !!code)) return '';
  const changed = await read(() => ({ orders: (state.orders || []).length, users: skAuth.users().map(u => u.username).sort().join(',') }));
  check('the walk-through changed the demo data before the reset', changed.orders !== sample.orders || changed.users !== sample.users, JSON.stringify({ sample, changed }));
  await read(() => localStorage.setItem('skyryse-mes-work-order-v1', '{"production":"keep"}'));
  await page.evaluate(code.trim());
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  check('after the reset the demo opens on the sign-in screen', await page.waitForSelector('#sk-username', { timeout: 15000 }).then(() => true, () => false));
  check('the reset leaves the production workspace key alone', await read(() => localStorage.getItem('skyryse-mes-work-order-v1')) === '{"production":"keep"}');
  await signIn('master');
  const after = await read(() => ({ orders: (state.orders || []).length, users: skAuth.users().map(u => u.username).sort().join(',') }));
  check('the reset brings back the original sample orders and accounts', after.orders === sample.orders && after.users === sample.users, JSON.stringify({ sample, after }));
  await expectValid('the demo workspace after the reset');
  return `${after.orders} sample orders and ${after.users.split(',').length} accounts back; production key kept`;
}

const ui = {
  page, context, flow, step, check, log, read, order, nav, click, clickText, fill, submitDialog, dialogOpen, dialogText,
  clickLoc, closeDialog, openOrder, orderTab, toast, wait, settle, expectPrint, expectValid, signIn, today, kitFile, photoFile,
  drainRefusals, setExpectRefusals: v => { expectRefusals = v; }, allRefusals: () => ALL_REFUSALS, needsAnotherPerson: t => NEEDS_ANOTHER_PERSON.test(t),
};

try {
  await signIn('master');
  await expectValid('the demo workspace after sign-in');
  const sample = await read(() => ({ orders: (state.orders || []).length, users: skAuth.users().map(u => u.username).sort().join(',') }));
  for (const f of FLOWS) await flow(f.name, f.title, () => f.run(ui));
  if (!ONLY || ONLY.includes('pilot')) await flow('pilot', 'Pilot seats keep the real rules (tech, quality)', () => pilotCounterpart(ui));
  if (!ONLY || ONLY.includes('reset')) await flow('reset', 'Start over: the quick start reset brings the sample back', () => quickStartReset(sample));
} finally {
  await browser.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log('\nWorkflow'.padEnd(64) + 'Result');
for (const r of RESULTS) console.log(r.flow.padEnd(63) + (r.pass ? 'pass' : 'FAIL') + (r.note ? '  ' + r.note : ''));
const named = ALL_REFUSALS.filter(r => r.user === 'master' && NEEDS_ANOTHER_PERSON.test(r.text));
// Page messages that did not come back from a successful engine call: refusals and plain notices (a print opened, a tool logged).
console.log(`page messages seen as master ${ALL_REFUSALS.filter(r => r.user === 'master').length}, refusals naming another person ${named.length}`);
fs.writeFileSync(path.join(TESTS, 'qa_demo_solo_master_results.json'), JSON.stringify({ results: RESULTS, refusals: ALL_REFUSALS }, null, 1));
console.log('page errors', JSON.stringify(pageErrors));
console.log('FAILS', JSON.stringify(FAILS));
if (FAILS.length || pageErrors.length) process.exitCode = 1;
