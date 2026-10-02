// UI review fixes: buy-off dialog prerequisites and refusals (H3), visible reasons on disabled buttons (M14),
// the Raise NC form (M10), sign-in messages (M15) and the Print traveler header button (M16).
// Set FLIGHT_UX_SHOTS to a folder to save 1024x768 screenshots of each fixed screen.
import { mkdirSync, readFileSync } from 'fs';
import { chromium } from 'playwright';
const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : TESTS + 'fixtures/';
const SHOTS = process.env.FLIGHT_UX_SHOTS ? process.env.FLIGHT_UX_SHOTS.replace(/\/?$/, '/') : '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const GENERIC = 'Account or password is incorrect. Check both and try again, or ask a QA Manager to reset your password.';

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const fails = [], errors = [];
let pass = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name); console.log(`${cond ? '  ok   ' : '  FAIL '}${name}${!cond && detail ? ' · ' + detail : ''}`); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: SHOTS + name + '.png' }); };

async function open(user, password = 'demo1234') {
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + FIXTURES + 'demo_publish.html');
  if (user) {
    await page.locator('#sk-username').fill(user); await page.locator('#sk-password').fill(password);
    await page.locator('#sk-login-submit').click();
    await page.waitForFunction(() => !document.getElementById('sk-boot'));
  }
  return page;
}
const signInError = async (page, user, password) => {
  await page.evaluate(() => { document.getElementById('sk-login-error').textContent = ''; });
  await page.locator('#sk-username').fill(user); await page.locator('#sk-password').fill(password);
  await page.locator('#sk-login-submit').click();
  await page.waitForFunction(() => document.getElementById('sk-login-error').textContent.trim(), null, { timeout: 5000 }).catch(() => {});
  return (await page.locator('#sk-login-error').innerText()).trim();
};

try {
  // ---- M15: sign-in uses the app's messages and one refusal for unknown account and wrong password.
  {
    const page = await open(null);
    ok('sign-in form is novalidate so the app reports errors', await page.evaluate(() => document.getElementById('sk-login').noValidate));
    const short = await signInError(page, 'demo', 'short');
    ok('short password gets the app message, not a browser tooltip', short === 'Password must be at least 8 characters.', short);
    const wrong = await signInError(page, 'demo', 'wrong-password');
    ok('wrong password gets the generic refusal', wrong === GENERIC, wrong);
    await shot(page, 'm15_wrong_password');
    const unknown = await signInError(page, 'nobody-here', 'wrong-password');
    ok('unknown account gets the same generic refusal', unknown === GENERIC, unknown);
    ok('the refusal never says whether the account exists', !/No account|Incorrect password/.test(wrong + unknown));
    // An identity-provider (SSO) account answers the same as an unknown one, and counts toward lockout; the note says where those accounts sign in.
    await page.evaluate(() => { const k = 'skyryse-mes-auth-v1', au = JSON.parse(localStorage.getItem(k)); au.users.push({ username: 'sso-person', displayName: 'SSO Person', sso: true, role: 'general', createdAt: new Date().toISOString() }); localStorage.setItem(k, JSON.stringify(au)); localStorage.removeItem('skyryse-mes-lockout-v1'); });
    await page.reload(); await page.waitForSelector('#sk-login:not([hidden])');
    const sso = await signInError(page, 'sso-person', 'any-password');
    ok('an identity-provider account gets the same generic refusal', sso === GENERIC, sso);
    ok('an identity-provider account counts toward lockout', await page.evaluate(() => (JSON.parse(localStorage.getItem('skyryse-mes-lockout-v1') || '{}')['sso-person'] || {}).fails === 1));
    ok('the sign-in note says where identity-provider accounts sign in', /company identity provider sign in through it/.test(await page.locator('#sk-login-note').innerText()));
    await page.evaluate(() => { const k = 'skyryse-mes-auth-v1', au = JSON.parse(localStorage.getItem(k)); au.users = au.users.filter(u => u.username !== 'sso-person'); localStorage.setItem(k, JSON.stringify(au)); localStorage.removeItem('skyryse-mes-lockout-v1'); });
    await page.reload(); await page.waitForSelector('#sk-login:not([hidden])');
    // Lockout is unchanged: the fifth failure locks, the next attempt is refused with the wait time.
    await page.evaluate(() => localStorage.removeItem('skyryse-mes-lockout-v1'));
    let last = '';
    for (let i = 0; i < 5; i++) last = await signInError(page, 'demo', 'wrong-password-' + i);
    ok('fifth failure still locks the account', last === GENERIC + ' Account locked for 5 minutes.', last);
    const blocked = await signInError(page, 'demo', 'demo1234');
    // The fifth failure on an unknown account reads the same as on a real one, so the lockout text cannot be used to find accounts.
    let lastUnknown = '';
    for (let i = 0; i < 5; i++) lastUnknown = await signInError(page, 'nobody-here', 'wrong-password-' + i);
    ok('fifth failure on an unknown account reads the same as on a real account', lastUnknown === last, JSON.stringify({ lastUnknown, last }));
    const blockedUnknown = await signInError(page, 'nobody-here', 'wrong-password');
    ok('a locked unknown account reads the same as a locked real account', blockedUnknown === blocked, JSON.stringify({ blockedUnknown, blocked }));
    ok('locked account is still refused with the wait time', /^Too many failed attempts\. Try again in 5 minutes\.$/.test(blocked), blocked);
    await page.evaluate(() => localStorage.removeItem('skyryse-mes-lockout-v1'));
    await page.locator('#sk-username').fill('demo'); await page.locator('#sk-password').fill('demo1234'); await page.locator('#sk-login-submit').click();
    await page.waitForFunction(() => !document.getElementById('sk-boot'));
    const sw = await page.evaluate(() => skAuth.switchAccount('master', 'wrong-password'));
    ok('switching account with a wrong password gets the generic refusal', !sw.ok && sw.message === GENERIC, sw.message);
    await page.context().close();
  }

  // ---- M16: Print traveler is its own header button, not in the More menu.
  {
    const page = await open('demo');
    for (const id of ['WO-10006', 'WO-10009']) {
      await page.evaluate(id => openOrder(id), id); await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({ header: [...document.querySelectorAll('.heading-actions > [data-action="print-traveler"]')].filter(b => b.offsetParent).length, more: document.querySelectorAll('.more-menu [data-action="print-traveler"]').length, text: document.querySelector('.heading-actions > [data-action="print-traveler"]')?.textContent.trim() }));
      ok(`${id}: Print traveler is a visible header button`, r.header === 1 && r.text === 'Print traveler', JSON.stringify(r));
      ok(`${id}: Print traveler is no longer inside More`, r.more === 0, JSON.stringify(r));
      if (id === 'WO-10006') await shot(page, 'm16_order_header');
    }
    await page.context().close();
  }

  // ---- M14: disabled buttons say why, in visible text tied to the button.
  {
    const page = await open('tech');
    await page.evaluate(() => openOrder('WO-10009')); await page.waitForTimeout(400);
    const nc = await page.evaluate(() => { const b = document.querySelector('[data-action="create-ticket"]'), r = document.getElementById('create-nc-reason'); return { disabled: b?.disabled, described: b?.getAttribute('aria-describedby'), reason: r?.textContent.trim(), visible: !!r && r.offsetParent !== null }; });
    ok('Create NC on a Draft order is disabled', nc.disabled === true, JSON.stringify(nc));
    ok('Create NC shows its reason as visible text', nc.visible && /Release this order to Kitting first/.test(nc.reason), JSON.stringify(nc));
    ok('Create NC reason is tied to the button', nc.described === 'create-nc-reason', JSON.stringify(nc));
    await page.evaluate(() => document.querySelector('[data-action="create-ticket"]').scrollIntoView({ block: 'center' }));
    await shot(page, 'm14_create_nc_draft');
    await page.evaluate(() => openOrder('WO-10006')); await page.waitForTimeout(300);
    ok('Create NC on a Building order is enabled with no reason shown', await page.evaluate(() => document.querySelector('[data-action="create-ticket"]')?.disabled === false && !document.getElementById('create-nc-reason')));
    await page.context().close();
  }
  {
    const page = await open('demo');
    await page.evaluate(() => { view = 'plan'; render(); }); await page.waitForTimeout(500);
    const obj = () => page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Add objective'), r = document.getElementById('fr-objective-reason'); return { found: !!b, disabled: b?.disabled, described: b?.getAttribute('aria-describedby'), reason: r?.textContent.trim(), visible: !!r && r.offsetParent !== null }; });
    await page.evaluate(() => { state.projectPlan = { ...(state.projectPlan || {}), projects: [] }; render(); }); await page.waitForTimeout(400);
    let o = await obj();
    ok('Add objective with no project is disabled and says why', o.found && o.disabled && o.visible && /Add a WBS project first/.test(o.reason) && o.described === 'fr-objective-reason', JSON.stringify(o));
    await page.evaluate(() => document.getElementById('fr-objective-reason')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'm14_add_objective');
    await page.evaluate(() => { state.projectPlan.projects = [{ id: 'PRJ-0001', name: 'Test project', parentId: null, lifecycle: 'Development', sensitivity: 'None', sensitivityHistory: [], startDate: '2026-01-01', dueDate: '2026-12-31', partNumbers: [] }]; render(); }); await page.waitForTimeout(400);
    o = await obj();
    ok('Add objective with a project is enabled and shows no reason', o.found && !o.disabled && !o.visible, JSON.stringify(o));
    // Close work order on an FAI order whose FAIR is not approved (changed in memory only, never saved).
    ok('demo account can open the quality review', await page.evaluate(() => skCan('approve-wo')));
    await page.evaluate(() => { const o = state.orders.find(x => x.status === 'Quality'); openOrder(o.id); const live = order(); live.fai = { ...(live.fai || {}), required: true }; live.fair = null; reviewDialog(); });
    await page.waitForTimeout(300);
    const cl = await page.evaluate(() => { const b = document.querySelector('#review-form button[type=submit]'), r = document.getElementById('review-close-reason'); return { disabled: b?.disabled, described: b?.getAttribute('aria-describedby'), reason: r?.textContent.trim(), visible: !!r && r.offsetParent !== null }; });
    ok('Close work order is disabled until the FAIR is approved', cl.disabled === true, JSON.stringify(cl));
    ok('Close work order shows its reason as visible text tied to the button', cl.visible && /unlocks when the AS9102 FAIR is approved/.test(cl.reason) && cl.described === 'review-close-reason', JSON.stringify(cl));
    await shot(page, 'm14_close_work_order');
    await page.context().close();
  }

  // ---- M10: Raise NC form.
  {
    const page = await open('tech');
    await page.evaluate(() => { const b = document.createElement('button'); b.dataset.action = 'mnv-nc-new'; b.hidden = true; document.body.append(b); b.click(); b.remove(); });
    await page.waitForSelector('#mnv-nc-form');
    const f = await page.evaluate(() => { const form = document.getElementById('mnv-nc-form'); const labels = [...form.querySelectorAll('label, legend')].map(l => l.textContent.replace(/\s*\*\s*$/, '').trim()); const dup = labels.filter((t, i) => labels.indexOf(t) !== i); return { novalidate: form.noValidate, title: document.getElementById('dialog-title').textContent.trim(), submit: form.querySelector('button[type=submit]').textContent.trim(), dup, poLine: labels.filter(t => t === 'PO line').length, serial: labels.filter(t => t === 'Serial number').length, required: [...form.querySelectorAll('.req-mark')].map(m => m.closest('label').getAttribute('for')) }; });
    ok('NC form is novalidate', f.novalidate, JSON.stringify(f));
    ok('NC submit button matches the title (Raise NC)', f.submit === 'Raise NC' && /^Raise NC/.test(f.title), JSON.stringify(f));
    ok('no control label appears twice in the NC form', f.dup.length === 0, JSON.stringify(f.dup));
    ok('PO line and Serial number each label one control', f.poLine === 0 && f.serial === 1, JSON.stringify(f));
    ok('required fields are marked', ['mnv-nc-title', 'mnv-nc-part', 'mnv-nc-qty', 'mnv-nc-desc'].every(id => f.required.includes(id)), JSON.stringify(f.required));
    const align = await page.evaluate(() => [...document.querySelectorAll('#mnv-nc-form .mnv-src-row label, #mnv-nc-form .mnv-escape-q label')].map(l => { const a = l.querySelector('input').getBoundingClientRect(), b = l.querySelector('span').getBoundingClientRect(); return Math.round(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2))); }));
    ok('radio dots line up with their labels', align.length === 6 && align.every(d => d < 4), JSON.stringify(align));
    await shot(page, 'm10_nc_form');
    const before = await page.evaluate(() => JSON.stringify(state).length);
    await page.locator('#mnv-nc-form button[type=submit]').click(); await page.waitForTimeout(300);
    const e = await page.evaluate(() => ({ text: document.getElementById('mnv-nc-error').textContent.trim(), open: document.getElementById('dialog').open, invalid: [...document.querySelectorAll('#mnv-nc-form [aria-invalid=true]')].map(x => x.id), focus: document.activeElement?.id }));
    ok('empty NC submit shows the app error naming the fields', e.open && e.text === 'Fill in the required fields: Title, Part number, Observation / discrepancy, PO number, Line.', JSON.stringify(e));
    ok('empty NC submit marks the empty fields invalid and focuses the error', e.invalid.join() === 'mnv-nc-title,mnv-nc-part,mnv-nc-po,mnv-nc-line,mnv-nc-desc' && e.focus === 'mnv-nc-error', JSON.stringify(e));
    ok('empty NC submit changes nothing in the workspace', await page.evaluate(n => JSON.stringify(state).length === n, before));
    await page.evaluate(() => document.getElementById('mnv-nc-error').scrollIntoView({ block: 'center' }));
    await shot(page, 'm10_nc_empty_submit');
    // The source-dependent fields carry the required mark for the source chosen, and are checked before the engine is asked.
    const marks = () => page.evaluate(() => [...document.querySelectorAll('#mnv-nc-form [data-src-req]')].filter(m => !m.hidden).map(m => m.closest('.field').querySelector('input').id));
    ok('the default PO source marks PO number and Line as required', JSON.stringify(await marks()) === JSON.stringify(['mnv-nc-po', 'mnv-nc-line']), JSON.stringify(await marks()));
    await page.fill('#mnv-nc-title', 'Scratched housing'); await page.fill('#mnv-nc-part', 'SR-IN-030'); await page.fill('#mnv-nc-desc', 'Scratch on the housing at receiving.');
    for (const [src, id, label] of [['Lot', 'mnv-nc-lot', 'Lot number'], ['Serial number', 'mnv-nc-serial', 'Serial number'], ['Work order', 'mnv-nc-wo', 'Work order number']]) {
      await page.check(`#mnv-nc-form input[name=sourceType][value="${src}"]`);
      ok(`choosing ${src} marks only its field as required`, JSON.stringify(await marks()) === JSON.stringify([id]), JSON.stringify(await marks()));
      await page.locator('#mnv-nc-form button[type=submit]').click(); await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({ text: document.getElementById('mnv-nc-error').textContent.trim(), invalid: [...document.querySelectorAll('#mnv-nc-form [aria-invalid=true]')].map(x => x.id), open: document.getElementById('dialog').open }));
      ok(`${src} source with its field empty is refused naming that field`, r.open && r.text === `Fill in the required field: ${label}.` && r.invalid.join() === id, JSON.stringify(r));
    }
    ok('a refused source field changes nothing in the workspace', await page.evaluate(n => JSON.stringify(state).length === n, before));
    await page.check('#mnv-nc-form input[name=sourceType][value="PO line"]');
    await page.fill('#mnv-nc-po', 'PO12345'); await page.fill('#mnv-nc-line', '1');
    await page.locator('#mnv-nc-form button[type=submit]').click(); await page.waitForTimeout(400);
    const raised = await page.evaluate(() => ({ open: document.getElementById('dialog').open, toast: document.querySelector('#toast p').textContent, err: document.getElementById('mnv-nc-error')?.textContent }));
    ok('a complete NC form still raises the NC', !raised.open && /raised\./.test(raised.toast), JSON.stringify(raised));
    await page.context().close();
  }

  // ---- H3: the buy-off dialog lists what is missing, keeps Complete off until done, and keeps its entries on refusal.
  {
    const page = await open('demo');
    await page.evaluate(() => { localStorage.removeItem('skyryse-mes-drafts-v1'); openOrder('WO-10006'); }); await page.waitForTimeout(400);
    const fx = await page.evaluate(() => { const o = order(), op = o.operations.find(x => !x.done); return { o: o.id, op: op.id, insp: MES.isInspectionOp(op), test: MES.isTestOperation(op), steps: op.steps.length, stamp: MES.buyoffCredential(state.profile, op.buyoffType).holder?.number || '' }; });
    ok('fixture: next operation on WO-10006 is an ATP inspection with steps', fx.insp && fx.test && fx.steps > 0, JSON.stringify(fx));
    for (let i = 0; i < fx.steps; i++) { const l = page.locator('label.step-check:has(input[data-step-check]:not(:checked))').first(); if (!await l.count()) break; await l.click(); await page.waitForTimeout(300); }
    await page.waitForSelector('#step-stamp-form', { timeout: 3000 }).catch(() => {});
    let d = await page.evaluate(() => ({ open: document.getElementById('dialog').open, items: [...document.querySelectorAll('#buyoff-prereqs li span')].map(s => s.textContent.trim()), gotos: [...document.querySelectorAll('#buyoff-prereqs [data-action="buyoff-goto"]')].map(b => b.textContent.trim()), complete: document.querySelector('#step-stamp-form button[type=submit]')?.disabled, reason: document.getElementById('buyoff-prereqs-reason')?.textContent.trim() }));
    ok('last step opens the buy-off dialog', d.open, JSON.stringify(d));
    ok('dialog lists the missing standard inspection and ATP test equipment', d.items.length === 2 && /standard inspection/i.test(d.items[0]) && /test equipment or asset/i.test(d.items[1]), JSON.stringify(d.items));
    ok('each missing item has a Go to button', d.gotos.length === 2 && d.gotos.every(t => /^Go to /.test(t)), JSON.stringify(d.gotos));
    ok('Complete operation is disabled while prerequisites are missing, with a visible reason', d.complete === true && /unlocks when the 2 items above are done/.test(d.reason), JSON.stringify(d));
    await shot(page, 'h3_dialog_prerequisites');
    // A forced submit while items are missing is refused inside the dialog and records nothing.
    await page.fill('#step-stamp-number', fx.stamp);
    await page.evaluate(() => document.getElementById('step-stamp-form').requestSubmit()); await page.waitForTimeout(300);
    d = await page.evaluate(a => ({ open: document.getElementById('dialog').open, err: document.getElementById('step-stamp-error').textContent.trim(), done: MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done }), fx);
    ok('a forced submit with items missing is refused in the dialog', d.open && /^Not ready to buy off\. Confirm the standard inspection\./.test(d.err) && !d.done, JSON.stringify(d));
    // Go to the standard inspection: the dialog closes on that control and the stamp number is kept for later.
    await page.locator('#buyoff-prereqs [data-action="buyoff-goto"]').first().click(); await page.waitForTimeout(300);
    const focus = await page.evaluate(() => ({ open: document.getElementById('dialog').open, name: document.activeElement?.name }));
    ok('Go to the standard inspection closes the dialog and focuses that checkbox', !focus.open && focus.name === 'stdInspection', JSON.stringify(focus));
    await page.locator('#operation-form input[name=stdInspection]').check({ force: true });
    const tool = await page.evaluate(() => MES.calibratedToolChecks(state, new Date().toISOString()).find(c => c.ok)?.tool.tag);
    await page.fill('#operation-form [data-asset-row] input[name=assetId]', tool); await page.locator('#operation-form [data-asset-row] input[name=assetId]').dispatchEvent('change');
    await page.waitForTimeout(200);
    await page.locator('.steps-complete [data-action="buyoff-now"]').click(); await page.waitForSelector('#step-stamp-form');
    d = await page.evaluate(() => ({ prereqs: !!document.getElementById('buyoff-prereqs'), complete: document.querySelector('#step-stamp-form button[type=submit]').disabled, stamp: document.getElementById('step-stamp-number').value }));
    ok('with the items done, the dialog shows no list and Complete is enabled', !d.prereqs && d.complete === false, JSON.stringify(d));
    ok('the stamp number entered before Go to is kept', d.stamp === fx.stamp, JSON.stringify(d));
    // Production requires the PIN (the demo build drops the attribute): an empty PIN is refused in the dialog, not by a browser bubble.
    const pinRequired = readFileSync(FIXTURES + 'publish.html', 'utf8').includes('<input id="step-stamp-pin" name="pin" type="password" inputmode="numeric" class="mono" autocomplete="off" maxlength="8" required>');
    ok('production stamp prompt still requires the PIN', pinRequired);
    await page.evaluate(() => { const p = document.getElementById('step-stamp-pin'); p.required = true; p.value = ''; });
    await page.locator('#step-stamp-form button[type=submit]').click(); await page.waitForTimeout(200);
    d = await page.evaluate(a => ({ open: document.getElementById('dialog').open, err: document.getElementById('step-stamp-error').textContent.trim(), focus: document.activeElement?.id, done: MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done }), fx);
    ok('an empty required PIN is refused inside the dialog with the app message', d.open && d.err === 'Enter your stamp PIN to buy off.' && d.focus === 'step-stamp-pin' && !d.done, JSON.stringify(d));
    // An engine refusal stays in the dialog with the stamp number and PIN still entered.
    await page.fill('#step-stamp-number', fx.stamp); await page.fill('#step-stamp-pin', '2468');
    await page.evaluate(() => { document.getElementById('toast').hidden = true; document.querySelector('#toast p').textContent = 'toast-before'; });
    await page.evaluate(() => { window.__realComplete = MES.completeOperation; MES.completeOperation = () => ({ ok: false, message: 'Refused by the engine for this test.' }); });
    await page.locator('#step-stamp-form button[type=submit]').click(); await page.waitForTimeout(400);
    d = await page.evaluate(a => ({ open: document.getElementById('dialog').open, err: document.getElementById('step-stamp-error').textContent.trim(), stamp: document.getElementById('step-stamp-number')?.value, pin: document.getElementById('step-stamp-pin')?.value, button: document.querySelector('#step-stamp-form button[type=submit]')?.disabled, toast: !document.getElementById('toast').hidden && document.querySelector('#toast p').textContent, done: MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done }), fx);
    ok('engine refusal keeps the dialog open', d.open, JSON.stringify(d));
    ok('engine refusal message is shown inside the dialog', d.err === 'Refused by the engine for this test.', JSON.stringify(d));
    ok('engine refusal keeps the stamp number and PIN entered', d.stamp === fx.stamp && d.pin === '2468', JSON.stringify(d));
    ok('engine refusal re-enables Complete operation and records nothing', d.button === false && !d.done, JSON.stringify(d));
    ok('engine refusal raises no toast; the dialog carries it', d.toast === false && await page.evaluate(() => document.querySelector('#toast p').textContent === 'toast-before'), JSON.stringify(d));
    await shot(page, 'h3_dialog_refusal');
    await page.evaluate(() => { MES.completeOperation = window.__realComplete; });
    // A refusal from the operation form's own checks (here the async recording check) is routed to the dialog too.
    await page.evaluate(a => { const op = MES.getOrder(state, a.o).operations.find(x => x.id === a.op); window.__realEvidence = op.evidence; op.evidence = [...(op.evidence || []), { id: 'EV-UXTEST', reviewedAt: new Date().toISOString(), size: 5, fileName: 'missing.webm' }]; }, fx);
    await page.locator('#step-stamp-form button[type=submit]').click(); await page.waitForTimeout(300);
    d = await page.evaluate(a => ({ open: document.getElementById('dialog').open, err: document.getElementById('step-stamp-error').textContent.trim(), pin: document.getElementById('step-stamp-pin')?.value, done: MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done, toast: document.querySelector('#toast p').textContent, title: document.getElementById('dialog-title').textContent }), fx);
    ok('operation-form refusal is shown in the dialog with the PIN kept', d.open && /^A reviewed recording is unavailable in this browser\./.test(d.err) && d.pin === '2468' && !d.done, JSON.stringify(d));
    await page.evaluate(a => { MES.getOrder(state, a.o).operations.find(x => x.id === a.op).evidence = window.__realEvidence; }, fx);
    // The PIN copied into the operation form's hidden buy-off field is cleared when the prompt closes without a buy-off.
    const copied = await page.evaluate(() => document.querySelector('#operation-form .buyoff-inline[hidden] [name=pin]')?.value);
    await page.locator('#step-stamp-form [data-action="close-dialog"]').click(); await page.waitForTimeout(200);
    const cleared = await page.evaluate(() => ({ copy: document.querySelector('#operation-form .buyoff-inline[hidden] [name=pin]')?.value, prompt: document.getElementById('step-stamp-pin')?.value }));
    ok('the PIN copied for a refused buy-off is cleared when the prompt closes', copied === '2468' && cleared.copy === '', JSON.stringify({ copied, cleared }));
    ok('the PIN in the closed prompt itself is cleared too', cleared.prompt === '', JSON.stringify(cleared));
    await page.locator('.steps-complete [data-action="buyoff-now"]').click(); await page.waitForSelector('#step-stamp-form');
    await page.fill('#step-stamp-number', fx.stamp); await page.fill('#step-stamp-pin', '2468');
    // While the buy-off is being recorded the prompt cannot be closed; if it is closed anyway, nothing is recorded.
    // The media check is made slow but passing, so only the closed prompt can stop the buy-off.
    await page.evaluate(() => { window.__realEnsure = window.ensureMediaForBuyoff; window.ensureMediaForBuyoff = () => new Promise(r => setTimeout(r, 900)); });
    await page.locator('#step-stamp-form button[type=submit]').click(); await page.waitForTimeout(150);
    const locked = await page.evaluate(() => ({ err: document.getElementById('step-stamp-error')?.textContent, opErr: document.getElementById('operation-error')?.textContent, open: document.getElementById('dialog').open, pending: !!document.querySelector('#step-stamp-form[data-pending]'), closers: [...document.querySelectorAll('#dialog [data-action="close-dialog"]')].map(b => b.disabled), complete: document.querySelector('#step-stamp-form button[type=submit]').disabled }));
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    ok('while a buy-off is pending, Not yet, the close button and Complete are disabled', locked.pending && locked.closers.length >= 2 && locked.closers.every(Boolean) && locked.complete, JSON.stringify(locked));
    ok('while a buy-off is pending, Escape does not close the prompt', await page.evaluate(() => document.getElementById('dialog').open));
    await page.evaluate(() => document.getElementById('dialog').close());
    await page.waitForTimeout(1200);
    d = await page.evaluate(a => ({ done: MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done, error: document.getElementById('operation-error')?.textContent.trim(), closers: [...document.querySelectorAll('#dialog [data-action="close-dialog"]')].map(b => b.disabled) }), fx);
    ok('a prompt closed while pending records nothing and says so', !d.done && /stamp prompt was closed/.test(d.error), JSON.stringify(d));
    ok('the dialog close buttons work again for the next dialog', d.closers.every(b => !b), JSON.stringify(d));
    await page.evaluate(() => { window.ensureMediaForBuyoff = window.__realEnsure; });
    await page.locator('.steps-complete [data-action="buyoff-now"]').click(); await page.waitForSelector('#step-stamp-form');
    await page.fill('#step-stamp-number', fx.stamp); await page.fill('#step-stamp-pin', '2468');
    // The real buy-off goes through and closes the dialog.
    await page.locator('#step-stamp-form button[type=submit]').click();
    await page.waitForFunction(a => MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done, fx, { timeout: 5000 }).catch(() => {});
    d = await page.evaluate(a => ({ done: MES.getOrder(state, a.o).operations.find(x => x.id === a.op).done, open: document.getElementById('dialog').open, err: document.getElementById('step-stamp-error')?.textContent }), fx);
    ok('the buy-off records and the dialog closes once nothing is missing', d.done && !d.open, JSON.stringify(d));
    ok('the workspace is still valid after the buy-off', await page.evaluate(() => MES.validate(state)));
    await page.context().close();
  }

  // ---- H3: required calibrated tooling is listed too, and the engine still refuses it on its own.
  {
    const page = await open('demo');
    const pre = await page.evaluate(() => { const o = state.orders.find(x => x.status === 'Building'); const op = structuredClone(o.operations.find(x => !x.done)); op.requiresTooling = true; op.stepChecks = {}; op.steps = []; return buyoffPrereqs(o, op).map(x => x.text); });
    ok('missing calibrated tools are listed as a prerequisite', pre.includes('Log each calibrated tool you used.'), JSON.stringify(pre));
    // Each prerequisite branch, on a copy of a real operation (nothing saved).
    const branches = await page.evaluate(() => {
      const o = state.orders.find(x => x.id === 'WO-10006'), base = o.operations.find(x => !x.done);
      const tool = MES.calibratedToolChecks(state, new Date().toISOString()).find(c => c.ok && MES.isTorqueTool(c.tool))?.tool.tag;
      const run = mut => { const op = structuredClone(base); op.classification = 'Manufacturing'; op.topLevelType = 'Manufacturing'; op.subCode = ''; op.requiresTooling = false; op.requiresRecording = false; op.evidence = []; op.buyoffType = 'Technician'; op.inspectionPoint = false; delete op.fodLevel; delete op.atp; mut(op); return buyoffPrereqs(o, op).map(x => x.text + ' > ' + x.target); };
      return {
        clean: run(() => {}),
        source: run(op => { op.classification = MES.SOURCE_INSPECTION_CLASS; op.sourceInspection = null; }),
        push: run(op => { op.atp = { repo: 'https://example.invalid/r', pushes: [{ sha: 'abc', status: 'Pending' }] }; }),
        po: run(op => { op.classification = MES.EXTERNAL_CLASS; op.externalPO = null; }),
        poTest: run(op => { op.classification = MES.EXTERNAL_CLASSES.find(c => c !== MES.EXTERNAL_CLASS); op.externalPO = null; }),
        fod: run(op => { op.fodLevel = 'critical'; op.fodChecklist = {}; }),
        recording: run(op => { op.requiresRecording = true; }),
        rejected: run(op => { op.evidence = [{ id: 'EV-1', rejectedAt: new Date().toISOString() }]; }),
        torque: tool ? (() => { drafts.set(`${o.id}/${base.id}`, { tools: [tool], torque: {} }); const form = document.getElementById('operation-form'); if (form) form.dataset.op = 'elsewhere'; const r = run(op => { op.requiresTooling = true; }); if (form) form.dataset.op = base.id; drafts.delete(`${o.id}/${base.id}`); return r; })() : ['no torque tool in the log'],
      };
    });
    ok('a plain operation lists nothing', branches.clean.length === 0, JSON.stringify(branches.clean));
    ok('source inspection branch', branches.source.some(t => /source inspection for this operation\. > \[data-action="source-inspection-record"\]/.test(t)), JSON.stringify(branches.source));
    ok('pending ATP software push branch', branches.push.some(t => /Software Engineering .* > \.atp-pushes/.test(t)), JSON.stringify(branches.push));
    ok('external PO branch', branches.po.some(t => /NetSuite PO .* > \.po-request-block/.test(t)), JSON.stringify(branches.po));
    ok('external PO branch covers External Testing too', branches.poTest.some(t => /NetSuite PO .* > \.po-request-block/.test(t)), JSON.stringify(branches.poTest));
    // An External Testing operation waiting on its PO reaches the order holds and Planning's queue, like External Sub-Processing.
    const etQueue = await page.evaluate(() => {
      const o = state.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done), keep = { c: op.classification, po: op.externalPO };
      op.classification = MES.EXTERNAL_CLASSES.find(c => c !== MES.EXTERNAL_CLASS); op.externalPO = null;
      try { return { holds: JSON.stringify(orderHolds(o)), tasks: dashboardTasks().filter(t => t.o === o && t.op === op).map(t => t.title), canAdjust: skCan('adjust-wo') }; }
      finally { op.classification = keep.c; op.externalPO = keep.po; }
    });
    ok('an External Testing operation without a PO is listed as an order hold', /NetSuite PO missing/.test(etQueue.holds), etQueue.holds);
    ok('an External Testing operation without a PO is queued for Planning', etQueue.canAdjust && etQueue.tasks.includes('Add NetSuite PO'), JSON.stringify(etQueue));
    ok('FOD checklist branch', branches.fod.some(t => /FOD checklist .* > \.fod-checklist/.test(t)), JSON.stringify(branches.fod));
    ok('recording branch', branches.recording.some(t => /(installation|operation) recording\. > \.installation-evidence/.test(t)), JSON.stringify(branches.recording));
    ok('rejected recording branch', branches.rejected.some(t => /rejected recording/.test(t)), JSON.stringify(branches.rejected));
    const stepTool = await page.evaluate(() => { const o = state.orders.find(x => x.id === 'WO-10006'), op = structuredClone(o.operations.find(x => !x.done)); op.requiresTooling = false; op.steps = [{ id: 's1', title: 'Torque', instruction: 'Torque it.' }]; op.stepChecks = { s1: { torque: { tool: 'NOT-IN-LOG-1', value: '5', unit: 'in-lb' } } }; return buyoffPrereqs(o, op).map(x => x.text); });
    ok('a tool captured on a step that is not usable is listed as a blocker', stepTool.some(t => /NOT-IN-LOG-1/.test(t)), JSON.stringify(stepTool));
    const conf = await page.evaluate(() => { const o = structuredClone(state.orders.find(x => x.operations.some(op => MES.isPartsConformityOperation(op)))); o.conformity = []; const op = o.operations.find(x => MES.isPartsConformityOperation(x)); return buyoffPrereqs(o, op).map(x => x.text + ' > ' + x.target); });
    ok('an unfinished conformity package is listed, with a way to the checklist', conf.some(t => /^Part Conformity: finish Phases 1 to 6 .* > \.conf-op$/.test(t)), JSON.stringify(conf));
    ok('torque value branch', branches.torque.some(t => /^Enter the torque value applied with .* > #torque-/.test(t)), JSON.stringify(branches.torque));
    // A requested PO on an External Testing operation can be filled, as on External Sub-Processing; a non-external operation is still refused.
    const po = await page.evaluate(() => {
      const c = structuredClone(state), o = c.orders.find(x => x.status === 'Building' && !MES.pendingSequenceChange(x) && !MES.engineeringChange(x));
      const testClass = MES.EXTERNAL_CLASSES.find(x => x !== MES.EXTERNAL_CLASS);
      const a = MES.addOrderOperation(c, o.id, { title: 'Environmental test', description: 'x', steps: 'A\nB', position: o.operations.length, buyoffType: 'Technician', classification: testClass, callouts: [], poMode: 'request', poVendor: 'Acme Labs', poProcess: 'Thermal cycle per spec' });
      if (!a.ok) return { setup: a.message };
      const ord = MES.getOrder(c, o.id), op = ord.operations.find(x => x.classification === testClass && !x.externalPO);
      const pending = buyoffPrereqs(ord, op).map(x => x.text);
      const r = MES.addPurchaseOrder(c, o.id, op.id, { poNumber: 'PO-99002' });
      const plain = ord.operations.find(x => !MES.EXTERNAL_CLASSES.includes(x.classification));
      const refused = MES.addPurchaseOrder(structuredClone(c), o.id, plain.id, { poNumber: 'PO-99003' });
      return { pending, ok: r.ok, message: r.message, po: op.externalPO?.number, valid: MES.validate(c), refused: !refused.ok && refused.message };
    });
    ok('External Testing without its PO lists the PO as the blocker', !!po.pending && po.pending.includes('Add the NetSuite PO for this external testing operation.'), JSON.stringify(po));
    ok('a requested PO on External Testing can be filled and the workspace stays valid', po.ok && po.po === 'PO-99002' && po.valid, JSON.stringify(po));
    ok('adding a PO to a non-external operation is still refused', po.refused === 'This is not an external operation.', JSON.stringify(po));
    const stepGo = await page.evaluate(() => { const o = state.orders.find(x => x.id === 'WO-10006'), op = structuredClone(o.operations.find(x => !x.done)); op.requiresTooling = false; op.steps = [{ id: 's1', title: 'A', instruction: 'A' }, { id: 's2', title: 'B', instruction: 'B' }]; op.stepChecks = { s2: { torque: { tool: 'NOT-IN-LOG-2', value: '5', unit: 'in-lb' } } }; return buyoffPrereqs(o, op).find(x => /NOT-IN-LOG-2/.test(x.text)); });
    ok('a lapsed step tool points at its own step, not the tool field', !!stepGo && stepGo.target === '.step-dots [data-step="1"]' && stepGo.go === 'Go to step B' && /captured on step B: uncheck that step/.test(stepGo.text), JSON.stringify(stepGo));
    // An offsite work center on an operation that is not classified as external: receiving cannot be recorded for it, so the
    // dialog says so and names who corrects it, with no Go to that leads nowhere.
    const mis = await page.evaluate(() => {
      const o = state.orders.find(x => x.id === 'WO-10006'), op = structuredClone(o.operations.find(x => !x.done)), center = MES.WORK_CENTERS.find(c => c.external);
      op.classification = 'Manufacturing'; op.workCenterId = center.id; op.externalReceipt = null;
      const item = buyoffPrereqs(o, op).find(x => /offsite work center/.test(x.text));
      const html = item ? buyoffPrereqBlock(o, op, [item]) : '';
      const c = structuredClone(state), live = c.orders.find(x => x.id === o.id).operations.find(x => x.id === op.id); live.classification = 'Manufacturing'; live.workCenterId = center.id;
      const receive = MES.recordExternalReceipt(c, o.id, op.id, { erpReceipt: 'R1', supplierInspectionLot: 'L1', level: 'Full' });
      return { item, hold: buyoffHold(op), goto: /buyoff-goto/.test(html), receive: !receive.ok };
    });
    ok('an offsite work center on a non-external operation is explained, with no Go to', !!mis.item && mis.item.target === '' && /not classified as External Sub-Processing or External Testing/.test(mis.item.text) && /Manufacturing Engineering/.test(mis.item.text) && !mis.goto, JSON.stringify(mis));
    ok('the no-step hold gives the same explanation', mis.hold?.text === mis.item?.text && mis.hold?.target === '', JSON.stringify(mis.hold));
    ok('the engine refuses receiving on such an operation, so the explanation is accurate', mis.receive, JSON.stringify(mis));
    // Own-work and training refusals are known before the PIN is asked, so they are listed (the engine still refuses them).
    const sod = await page.evaluate(() => {
      const o = state.orders.find(x => x.id === 'WO-10006'), op = structuredClone(o.operations.find(x => !x.done));
      const realOwn = MES.ownWorkRefusal, realTraining = MES.trainingCheck;
      try {
        MES.ownWorkRefusal = () => ({ ok: false, message: 'Nobody inspects their own work. A different inspector must check off and buy off this inspection.' });
        MES.trainingCheck = () => ({ ok: false, message: 'Torque training for the holder is expired. This operation requires it. Record the training in the stamp register before buy-off.' });
        return buyoffPrereqs(o, op).filter(x => /own work|training/i.test(x.text));
      } finally { MES.ownWorkRefusal = realOwn; MES.trainingCheck = realTraining; }
    });
    ok('an own-work inspection is listed before the PIN is asked, with no Go to', sod.some(x => /^Nobody inspects their own work\./.test(x.text) && x.target === ''), JSON.stringify(sod));
    ok('lapsed training is listed before the PIN is asked, naming who records it', sod.some(x => /training .* expired/.test(x.text) && /A QA Manager records training; nobody records their own\./.test(x.text) && x.target === ''), JSON.stringify(sod));
    // A recording-required operation on an order that is not an Installation order still gets the recording controls.
    const rec = await page.evaluate(() => {
      const o = structuredClone(state.orders.find(x => x.id === 'WO-10006')), op = o.operations.find(x => !x.done); o.subcategory = 'Assembly'; op.evidence = [];
      op.requiresRecording = false; const without = renderMediaEvidence(o, op);
      op.requiresRecording = true; const withRec = renderMediaEvidence(o, op);
      return { without, with: /class="installation-evidence"/.test(withRec) && /Recording required/.test(withRec) };
    });
    ok('a recording-required operation shows the recording section on any order type', rec.with && rec.without === '', JSON.stringify(rec));
    // The recording labels and context follow the order, not a hard-coded Development / Installation.
    const labels = await page.evaluate(() => {
      const o = structuredClone(state.orders.find(x => x.id === 'WO-10006')), op = o.operations.find(x => !x.done); op.evidence = []; op.requiresRecording = true;
      o.pedigree = 'Production'; o.subcategory = 'Assembly';
      const asm = { section: renderMediaEvidence(o, op), context: mediaContext(o, op), prereq: buyoffPrereqs(o, op).map(x => x.text).join(' | ') };
      o.subcategory = 'Installation';
      const inst = { section: renderMediaEvidence(o, op), prereq: buyoffPrereqs(o, op).map(x => x.text).join(' | ') };
      return { asm, inst };
    });
    ok('an Assembly order labels its recordings as operation evidence, not installation', /<h3 id="media-heading">Operation evidence<\/h3>/.test(labels.asm.section) && !/Installation/.test(labels.asm.section) && /Attach and review the operation recording\./.test(labels.asm.prereq), JSON.stringify(labels.asm));
    ok('the recording context shows the order pedigree and subcategory', /Production \/ Assembly/.test(labels.asm.context) && !/Development \/ Installation/.test(labels.asm.context), labels.asm.context);
    ok('an Installation order keeps the installation wording', /<h3 id="media-heading">Installation evidence<\/h3>/.test(labels.inst.section) && /Attach and review the installation recording\./.test(labels.inst.prereq), JSON.stringify(labels.inst));
    await page.evaluate(() => { const o = state.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done); window.__realSub = o.subcategory; window.__realRec = op.requiresRecording; o.subcategory = 'Assembly'; op.requiresRecording = true; openOrder(o.id); });
    await page.waitForTimeout(400);
    ok('the Hangar view shows the recording section for it too', await page.evaluate(() => !!document.querySelector('.installation-evidence')));
    ok('the Hangar view labels it as operation evidence', await page.evaluate(() => document.querySelector('.installation-evidence #media-heading')?.textContent === 'Operation evidence'));
    await page.evaluate(() => { const o = state.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done); o.subcategory = window.__realSub; op.requiresRecording = window.__realRec; });
    const eng = await page.evaluate(() => { const s = structuredClone(state), o = s.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done); return MES.completeOperation(s, o.id, op.id, '', { stampNumber: MES.buyoffCredential(s.profile, op.buyoffType).holder?.number }); });
    ok('the engine still refuses a buy-off with the standard inspection unconfirmed', !eng.ok && /standard inspection|Check off/.test(eng.message), JSON.stringify(eng));
    // The engine's own recording refusal names the order's kind too.
    const engRec = await page.evaluate(() => [x => x.id === 'WO-10006' && x.subcategory !== 'Installation', x => x.id === 'WO-10006'].map((pick, n) => {
      const s = structuredClone(state), o = s.orders.find(pick); if (n) { o.subcategory = 'Installation'; o.pedigree = 'Development NFF'; } if (!MES.validate(s)) return 'invalid: ' + (MES.diagnose(s) || {}).detail;
      const op = o.operations.find(x => !x.done); op.requiresRecording = true; op.evidence = []; op.steps = []; op.stepChecks = {};
      return MES.completeOperation(s, o.id, op.id, '', { stampNumber: MES.buyoffCredential(s.profile, op.buyoffType).holder?.number }).message || '';
    }));
    ok('the engine recording refusal says operation on a non-Installation order', /before this operation can be bought off/.test(engRec[0]) && !/installation/i.test(engRec[0]), engRec[0]);
    ok('the engine recording refusal keeps installation on an Installation order', /before this installation operation can be bought off/.test(engRec[1]), engRec[1]);
    // Codex P2 on 81e6402: Edit Op shows the PO fields for External Testing too, so its PO can be corrected and other edits are not refused.
    const editPO = await page.evaluate(() => {
      const o = state.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done), keep = { c: op.classification, po: op.externalPO };
      op.classification = MES.EXTERNAL_CLASSES.find(c => c !== MES.EXTERNAL_CLASS); op.externalPO = { number: 'PO-777', line: '1' };
      try { openOrder(o.id); sequenceEditDialog(op.id); const f = document.getElementById('edit-po-number'); return { shown: !!f, value: f ? f.value : null }; }
      finally { document.querySelector('dialog[open] [data-action="close-dialog"], dialog[open] .dialog-close')?.click(); document.querySelectorAll('dialog[open]').forEach(d => d.close()); op.classification = keep.c; op.externalPO = keep.po; }
    });
    ok('Edit Op shows the PO number for an External Testing operation', editPO.shown && editPO.value === 'PO-777', JSON.stringify(editPO));
    // Codex security P1: the engine refuses a buy-off on an external work center until Quality's receipt is accepted. A missing receipt is not a pass.
    const extGate = await page.evaluate(() => {
      const attempt = receipt => {
        const s = structuredClone(state), o = s.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done);
        op.classification = MES.EXTERNAL_CLASSES.find(c => c !== MES.EXTERNAL_CLASS); op.workCenterId = MES.WORK_CENTERS.find(c => c.external && c.site === o.site)?.id || MES.WORK_CENTERS.find(c => c.external).id;
        op.externalPO = { number: 'PO-12345', line: '1' }; op.steps = []; op.stepChecks = {}; op.requiresRecording = false; op.evidence = [];
        if (receipt === undefined) delete op.externalReceipt; else op.externalReceipt = receipt;
        const valid = MES.validate(s);
        const r = MES.completeOperation(s, o.id, op.id, '', { stampNumber: MES.buyoffCredential(s.profile, op.buyoffType).holder?.number });
        return { valid, ok: r.ok, message: r.message || '' };
      };
      const accepted = { status: 'Accepted', level: 'Full', erpReceipt: 'ERP-1', supplierInspectionLot: 'LOT-1', inspectionRef: 'RI-1', by: { name: 'Quality Inspector', role: 'Quality', credentialId: 'Q-1' }, at: new Date().toISOString() };
      return { missing: attempt(undefined), accepted: attempt(accepted) };
    });
    // Jinx-A and Jinx-C on d86229e: the PO refusal names the operation's own process, so External Testing is never called sub-processing.
    const poWording = await page.evaluate(() => {
      const s = structuredClone(state), o = s.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done);
      op.classification = MES.EXTERNAL_CLASSES.find(c => c !== MES.EXTERNAL_CLASS); op.externalPO = null; op.steps = []; op.stepChecks = {}; op.requiresRecording = false; op.evidence = [];
      const engine = MES.completeOperation(s, o.id, op.id, '', { stampNumber: MES.buyoffCredential(s.profile, op.buyoffType).holder?.number }).message || '';
      const dialog = buyoffPrereqs(o, op).map(x => x.text).join(' | ');
      op.classification = MES.EXTERNAL_CLASS;
      const subEngine = MES.completeOperation(s, o.id, op.id, '', { stampNumber: MES.buyoffCredential(s.profile, op.buyoffType).holder?.number }).message || '';
      return { engine, dialog, subEngine };
    });
    ok('the External Testing PO refusal names external testing, in the engine and the dialog', /Add the NetSuite PO for this external testing operation before buy-off\./.test(poWording.engine) && /Add the NetSuite PO for this external testing operation\./.test(poWording.dialog) && !/sub-processing/i.test(poWording.engine + poWording.dialog), JSON.stringify(poWording));
    ok('an External Sub-Processing PO refusal still says sub-processing', /Add the NetSuite PO for this sub-processing operation before buy-off\./.test(poWording.subEngine), poWording.subEngine);
    ok('an external work center buy-off with no receipt is refused by the engine', extGate.missing.valid && !extGate.missing.ok && /External work remains blocked/.test(extGate.missing.message), JSON.stringify(extGate.missing));
    ok('an accepted receipt clears the receiving gate', extGate.accepted.valid && !/External work remains blocked/.test(extGate.accepted.message), JSON.stringify(extGate.accepted));
    // An operation with no steps held by an external PO: Complete operation is disabled and says why next to the button.
    await page.evaluate(() => { const o = state.orders.find(x => x.id === 'WO-10006'), op = o.operations.find(x => !x.done); op.steps = []; op.stepChecks = {}; op.classification = MES.EXTERNAL_CLASS; op.externalPO = null; openOrder(o.id); });
    await page.waitForTimeout(400);
    const hold = await page.evaluate(() => { const b = document.querySelector('#operation-form .task-actions button[type=submit]'), r = document.getElementById('buyoff-hold-reason'); return { found: !!b, disabled: b?.disabled, described: b?.getAttribute('aria-describedby'), reason: r?.textContent.trim(), visible: !!r && r.offsetParent !== null }; });
    ok('a held no-step buy-off shows its reason beside the disabled button', hold.found && hold.disabled && hold.visible && hold.reason.startsWith('Add the NetSuite PO for this sub-processing operation.') && hold.described === 'buyoff-hold-reason', JSON.stringify(hold));
    const goto = await page.evaluate(() => { const b = document.querySelector('#buyoff-hold-reason [data-action="buyoff-goto"]'); if (!b) return { found: false }; const target = b.dataset.target, text = b.textContent.trim(); b.click(); const el = document.querySelector(target); return { found: true, target, text, focusInside: !!el && (el === document.activeElement || el.contains(document.activeElement)) }; });
    ok('the hold reason has a Go to button that moves focus to the PO', goto.found && goto.target === '.po-request-block' && /^Go to the PO/.test(goto.text) && goto.focusInside, JSON.stringify(goto));
    await page.context().close();
  }
} catch (error) {
  fails.push('harness: ' + error.message); console.log('  FAIL harness', error.stack);
} finally {
  await browser.close();
}
console.log(`checks ${pass + fails.length} pass ${pass} fail ${fails.length}`);
console.log('errors', JSON.stringify(errors), 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
