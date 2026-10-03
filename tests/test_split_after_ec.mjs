// Issue #458: splitting a work order after an engineering change was applied set the parent order aside.
// engineeringChangesValid holds the order quantity to the one the applied change records name, so a split that
// lowered it left the workspace invalid, save() repaired it by quarantining the parent, and the toast still said the
// split worked. A split (by hand or through a split request) is now refused once an engineering change has been
// applied, naming the change and what to do next, and the workspace is left exactly as it was.
// Part 1 drives the production engine through the server host. Part 2 drives the demo build's Split quantity dialog
// in Chromium: the toast, the dialog error and the saved workspace agree, and no order is quarantined.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';

const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : TESTS + 'fixtures/';
const fails = [];
const ok = (what, cond, more = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + more)); if (!cond) fails.push(what); };

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const me = { username: 'split-me', displayName: 'Morgan Engineer', role: 'me' };
const qm = { username: 'split-qm', displayName: 'Quincy Manager', role: 'qm' };
const curated = () => JSON.parse(fs.readFileSync(FIXTURES + 'demo_publish.html', 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
// WO-10007 is the curated sample's Kitting order with a quantity of 2 (Production, Mfg., so a change needs an ECR).
const ID = 'WO-10007';
const fresh = () => { const state = curated(); const o = MES.getOrder(state, ID); assert.equal(o.status, 'Kitting'); assert.equal(o.quantity, 2); return state; };
const snap = state => JSON.stringify({ orders: state.orders, serials: state.serialLog || null, quarantine: state.quarantine || null });
const NO_EM_DASH = message => !String(message).includes('\u2014');

// Submits a change as Manufacturing Engineering and applies it as a QA Manager (separate people).
function applyChange(state, input) {
  const submitted = host.withAccount(me, () => MES.submitEngineeringChange(state, ID, input), state);
  assert.ok(submitted.ok, JSON.stringify(submitted));
  if (MES.getOrder(state, ID).engineeringChanges.at(-1).status === 'Awaiting ECR') assert.ok(host.withAccount(qm, () => MES.approveECR(state, ID), state).ok);
  const applied = host.withAccount(qm, () => MES.approveEngineeringChange(state, ID), state);
  assert.ok(applied.ok, JSON.stringify(applied));
  return submitted.id;
}

// ---- Part 1: the engine ----
{
  // The allowed path is unchanged: an order with no engineering change still splits and stays valid.
  const state = fresh();
  const r = host.withAccount(qm, () => MES.splitOrder(state, ID, 1), state);
  ok('an order with no engineering change still splits', r.ok && r.id === `${ID}-Split-1`, JSON.stringify(r));
  ok('the split order and its parent both validate', MES.validate(state) && MES.diagnose(state) === null, JSON.stringify(MES.diagnose(state)));
  ok('the toast text matches the state after an allowed split', MES.getOrder(state, ID).quantity === 1 && MES.getOrder(state, r.id).quantity === 1 && r.message === `${r.id} created with 1 units. 1 remain on ${ID}.`, r.message);
}
{
  // The bug: a quantity change applied, then a split.
  const state = fresh();
  const ec = applyChange(state, { quantity: 4, reason: 'Two more units for the build.' });
  ok('the workspace is valid after the engineering change is applied', MES.validate(state));
  const before = snap(state);
  const r = host.withAccount(qm, () => MES.splitOrder(state, ID, 1), state);
  ok('a split after an applied engineering change is refused', r.ok === false, JSON.stringify(r));
  ok('the refusal names the change, the approved quantity and what to do next', r.message === `Engineering change ${ec} set this work order to 4 units, and that approved quantity can only change through another engineering change. To move units off this order, submit an engineering change to the reduced quantity, then open a new work order for the units taken off.`, r.message);
  ok('the refusal has no em dash', NO_EM_DASH(r.message));
  ok('the refused split changes nothing', snap(state) === before);
  ok('the workspace still validates after the refusal', MES.validate(state) && MES.diagnose(state) === null, JSON.stringify(MES.diagnose(state)));
  // What save() does with an invalid workspace: repair quarantines the broken order. Nothing is set aside now.
  const repaired = JSON.parse(JSON.stringify(state));
  MES.repair(repaired);
  ok('repair sets no order aside after the refusal', !(repaired.quarantine || []).length && MES.getOrder(repaired, ID)?.quantity === 4);
  // The next step the message names: a change to the reduced quantity applies and stays valid.
  const reduced = applyChange(state, { quantity: 3, reason: 'One unit moves to its own work order.' });
  ok('the engineering change to the reduced quantity applies and validates', MES.getOrder(state, ID).quantity === 3 && MES.validate(state), reduced);
  const again = host.withAccount(qm, () => MES.splitOrder(state, ID, 1), state);
  ok('a split is still refused after a second applied change, naming the latest one', again.ok === false && again.message.startsWith(`Engineering change ${reduced} set this work order to 3 units,`), JSON.stringify(again));
}
{
  // An instruction-only change also fixes the quantity its record names, so the split is refused there too.
  const state = fresh();
  const op = MES.getOrder(state, ID).operations.find(o => !o.done && !o.evidence.length);
  const ec = applyChange(state, { instructions: [{ operationId: op.id, description: `${op.description} Check the seal seating.` }], reason: 'Clarify the seal check.' });
  const before = snap(state);
  const r = host.withAccount(qm, () => MES.splitOrder(state, ID, 1), state);
  ok('a split after an instruction-only change is refused, naming the quantity of 2', r.ok === false && r.message.startsWith(`Engineering change ${ec} set this work order to 2 units,`), JSON.stringify(r));
  ok('that refusal changes nothing and the workspace validates', snap(state) === before && MES.validate(state));
}
{
  // A pending change keeps its existing hold message.
  const state = fresh();
  assert.ok(host.withAccount(me, () => MES.submitEngineeringChange(state, ID, { quantity: 3, reason: 'One more unit.' }), state).ok);
  const before = snap(state);
  const r = host.withAccount(qm, () => MES.splitOrder(state, ID, 1), state);
  ok('a split with a pending engineering change keeps the hold message', r.ok === false && r.message === 'An engineering change is pending. QA re-release is required before work can continue.' && snap(state) === before, JSON.stringify(r));
}
{
  // The split request path lowers the parent quantity the same way, so it is refused the same way.
  const state = fresh();
  const ec = applyChange(state, { quantity: 4, reason: 'Two more units for the build.' });
  const o = MES.getOrder(state, ID);
  const reviewer = { ...o.engineeringChanges.at(-1).qaApproval }; delete reviewer.virtual; delete reviewer.at;
  o.splitRequests = [{ id: `SPR-${ID.slice(3)}-1`, ticketId: 'NC-99001', quantity: 1, of: 4, serials: [], reason: 'NC-99001 Rework: 1 of 4 units affected.', status: 'Open', requestedBy: reviewer, at: new Date().toISOString() }];
  ok('the open split request is a valid record', MES.validate(state), JSON.stringify(MES.diagnose(state)));
  const before = snap(state);
  const r = host.withAccount(qm, () => MES.splitRequestOrder(state, ID, `SPR-${ID.slice(3)}-1`), state);
  ok('fulfilling a split request after an applied engineering change is refused with the same message', r.ok === false && r.message.startsWith(`Engineering change ${ec} set this work order to 4 units,`), JSON.stringify(r));
  ok('the refused split request changes nothing and the workspace validates', snap(state) === before && MES.validate(state));
}

// ---- Part 2: the Split quantity dialog in the demo build ----
{
  const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const signIn = async () => {
    await p.goto('file://' + FIXTURES + 'demo_publish.html'); await p.waitForTimeout(900);
    await p.evaluate(() => { const un = document.querySelector('#sk-boot input[name=username]'); const pw = document.querySelector('#sk-boot input[type=password]'); un.value = 'demo'; un.dispatchEvent(new Event('input', { bubbles: true })); pw.value = 'demo1234'; pw.dispatchEvent(new Event('input', { bubbles: true })); un.closest('form').requestSubmit(); });
    await p.waitForTimeout(1200);
  };
  const splitThroughDialog = async quantity => {
    await p.evaluate(([id]) => { selectedId = id; view = 'order'; tab = 'operations'; render(); }, [ID]); await p.waitForTimeout(300);
    await p.evaluate(() => { document.getElementById('toast').hidden = true; });
    // Split quantity sits in the order's actions menu; open it the way a user does.
    await p.evaluate(() => { const menu = document.querySelector('[data-action="split-order"]').closest('details'); if (menu) menu.open = true; });
    await p.click('[data-action="split-order"]'); await p.waitForTimeout(300);
    await p.evaluate(([q]) => { const f = document.getElementById('split-form'); f.elements.quantity.value = String(q); f.requestSubmit(); }, [quantity]); await p.waitForTimeout(500);
    return p.evaluate(([id]) => { const saved = JSON.parse(localStorage.getItem(KEY)); return {
      toast: document.getElementById('toast').hidden ? '' : document.querySelector('#toast p').textContent,
      error: (document.getElementById('split-error') || {}).textContent || '',
      dialogOpen: !!document.getElementById('dialog')?.open,
      orders: state.orders.map(o => o.id), savedOrders: saved.orders.map(o => o.id),
      quantity: MES.getOrder(state, id)?.quantity ?? null, savedQuantity: saved.orders.find(o => o.id === id)?.quantity ?? null,
      quarantine: (state.quarantine || []).length + (saved.quarantine || []).length, valid: MES.validate(state) }; }, [ID]);
  };
  await signIn();
  // The allowed path first: without an engineering change the dialog splits, and the toast and saved state agree.
  const split = await splitThroughDialog(1);
  ok('without an engineering change the dialog splits and the toast says so', split.toast === `${ID}-Split-1 created with 1 units. 1 remain on ${ID}.` && !split.dialogOpen, JSON.stringify(split));
  ok('the saved workspace holds both orders with the quantities the toast names, nothing quarantined', split.savedOrders.includes(ID) && split.savedOrders.includes(`${ID}-Split-1`) && split.savedQuantity === 1 && split.quarantine === 0 && split.valid, JSON.stringify(split));
  // Then raise the parent to 3 through an applied engineering change (the demo lets one person approve their own change).
  const applied = await p.evaluate(([id]) => { const s = MES.submitEngineeringChange(state, id, { quantity: 3, reason: 'Two more units for the build.' }); const e = MES.engineeringChange(MES.getOrder(state, id))?.status === 'Awaiting ECR' ? MES.approveECR(state, id) : { ok: true }; const a = MES.approveEngineeringChange(state, id); save(); return { ok: s.ok && e.ok && a.ok, id: s.id, quantity: MES.getOrder(state, id).quantity, detail: [s, e, a] }; }, [ID]);
  ok('the demo applies an engineering change raising the quantity to 3', applied.ok && applied.quantity === 3, JSON.stringify(applied));
  const refused = await splitThroughDialog(1);
  ok('the dialog shows the refusal and no success toast', refused.dialogOpen && refused.error.startsWith(`Engineering change ${applied.id} set this work order to 3 units,`) && refused.toast === '', JSON.stringify(refused));
  ok('no second split order is created, in memory or in storage', !refused.orders.includes(`${ID}-Split-2`) && !refused.savedOrders.includes(`${ID}-Split-2`), JSON.stringify(refused.orders));
  ok('the parent order stays on the list with its approved quantity, and nothing is quarantined', refused.orders.includes(ID) && refused.savedOrders.includes(ID) && refused.quantity === 3 && refused.savedQuantity === 3 && refused.quarantine === 0 && refused.valid, JSON.stringify(refused));
  await p.evaluate(() => document.getElementById('dialog').close());
  ok('no page errors', errs.length === 0, JSON.stringify(errs));
  await b.close();
}

console.log('FAILS', JSON.stringify(fails));
if (fails.length) process.exit(1);
