// The printed traveler (F-850-001) and the work order print number operations exactly as the screen does: by position
// in the sequence (010, 020, ...). Inserted rework ops keep stored ids like op-add-1; the print must not show those, and
// later ops must shift on paper the same way they shift on screen. Stored op ids are not changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const host = createHost(indexPath);
const { MES, MESPrint } = host;
let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };

// The screen's own numbering functions, taken from the page source so the test compares against what the screen runs.
const html = fs.readFileSync(indexPath, 'utf8');
const screenSrc = ['function sequence(n)', 'function operationNumber(o,opId)'].map(sig => {
  const line = html.split('\n').find(l => l.startsWith(sig));
  assert.ok(line, `screen function ${sig} not found in index.html`);
  return line;
}).join('\n');
const screen = vm.runInNewContext(`${screenSrc}\n({ operationNumber })`);

const ctx = { serials: [], printedAt: '2026-10-01T15:00:00.000Z', printedBy: 'Test Printer' };
// Op numbers printed in the traveler's operation header rows, in order, with the title printed beside each.
const travelerOps = page => [...page.matchAll(/<tr class="oh"><td class="no">([^<]*)<\/td><td><strong>([^<]*)<\/strong>/g)].map(m => ({ number: m[1], title: m[2] }));
const travelerSteps = page => [...page.matchAll(/<tr class="st"><td class="no">([^<]+)<\/td>/g)].map(m => m[1]);
const recordOps = page => [...page.matchAll(/<tr class="op-row"><th scope="row">([^<]*)<\/th><td>([^<]*)/g)].map(m => ({ number: m[1], title: m[2] }));
const unescape = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// The production seed carries no work orders; use the generated demo workspace, upgraded by this engine.
const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const seed = fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(seed, 'fixture has a workspace seed');
const state = MES.upgrade(JSON.parse(seed[1]));
const admin = { username: 'traveler-numbers', displayName: 'Traveler Numbers', role: 'admin' };
const order = state.orders.find(o => ['Kitting', 'Building', 'Quality'].includes(o.status) && !MES.pendingSequenceChange(o) && MES.firstInsertIndex(o) < o.operations.length - 1);
assert.ok(order, 'seed has an open order with room to insert an operation before later operations');

// An order without inserted ops prints unchanged: the position number equals the old id-derived number.
const untouched = state.orders.find(o => o.operations.length && o.operations.every((op, i) => op.id === `op-${String((i + 1) * 10).padStart(3, '0')}`));
assert.ok(untouched, 'seed has an order whose op ids are op-010, op-020, ...');
const untouchedPrint = travelerOps(MESPrint.traveler(untouched, ctx));
check('an order without inserted ops prints the same numbers as before (id-derived)',
  untouchedPrint.length === untouched.operations.length && untouchedPrint.every((row, i) => row.number === untouched.operations[i].id.replace(/^op-/, '')),
  JSON.stringify(untouchedPrint.map(r => r.number)));

// Raise an NC, then insert the rework op that works it ahead of later operations, as the floor does.
const position = MES.firstInsertIndex(order);
const nc = host.withAccount(admin, () => MES.createTicket(state, order.id, order.operations[position].id, { type: 'NC', title: 'Fastener torque low', description: 'Torque audit found one fastener under drawing value.', hold: false }), state);
check('the NC is raised', nc && nc.ok !== false, nc && nc.message);
const ncId = MES.getOrder(state, order.id).tickets.at(-1).id;
const before = order.operations.map(op => op.id);
const added = host.withAccount(admin, () => MES.addOrderOperation(state, order.id, { title: 'Re-torque fastener(s)', description: 'Re-torque to drawing value.', steps: 'Loosen\nRe-torque', position, buyoffType: 'Technician', classification: 'Rework', ticketId: ncId, callouts: [] }), state);
check('the rework operation is inserted', added && added.ok !== false, added && added.message);
const after = MES.getOrder(state, order.id);
const inserted = after.operations[position];
check('the inserted op keeps its stored op-add id (stored ids are not renumbered)', /^op-add-\d+$/.test(inserted.id), inserted.id);
check('existing op ids are unchanged', before.every(id => after.operations.some(op => op.id === id)));

const traveler = MESPrint.traveler(after, ctx);
const printed = travelerOps(traveler);
check('the traveler prints one header row per operation', printed.length === after.operations.length, `${printed.length} vs ${after.operations.length}`);
check('every traveler op number equals the screen operationNumber()',
  after.operations.every((op, i) => printed[i].number === screen.operationNumber(after, op.id) && unescape(printed[i].title) === op.title),
  JSON.stringify(printed.map(r => r.number)));
check('no traveler op number is an add-N id', !printed.some(r => /add/.test(r.number)));
check('ops after the insert shift on paper as they do on screen',
  after.operations.slice(position + 1).every((op, k) => printed[position + 1 + k].number === String((position + 2 + k) * 10).padStart(3, '0')));
check('traveler step numbers use the screen op number', (() => {
  const expected = after.operations.flatMap(op => (op.steps || []).map((_, i) => `${screen.operationNumber(after, op.id)}-${MES.stepLetter(i)}`));
  const got = travelerSteps(traveler).filter(s => s.trim());
  return got.length === expected.length && got.every((s, i) => s === expected[i]);
})());
check('the traveler names the inserted op with the screen number',
  printed[position].number === screen.operationNumber(after, inserted.id) && unescape(printed[position].title) === 'Re-torque fastener(s)');
// #327: each step row keeps one check-off box; print name and date stay on the operation row.
const stepRowHtml = [...traveler.matchAll(/<tr class="st"><td class="no">[^<]+<\/td>[\s\S]*?<\/tr>/g)].map(m => m[0]);
check('every numbered step row has one check-off box and no blank name or date cells',
  stepRowHtml.length > 0 && stepRowHtml.every(row => (row.match(/class="chk"/g) || []).length === 1 && !row.includes('<td class="blank">')));

for (const mode of ['internal', 'external']) {
  const page = MESPrint.document(after, mode);
  const rows = recordOps(page);
  check(`the ${mode} work order print numbers every op as the screen does`,
    rows.length === after.operations.length && after.operations.every((op, i) => rows[i].number === screen.operationNumber(after, op.id)),
    JSON.stringify(rows.map(r => r.number)));
  check(`the ${mode} work order print never shows an add-N op number`, !/Op add-|>add-\d/.test(page));
}

check('the fallback signature box stays blank for the floor to fill in',
  /<section class="fallback">[\s\S]*?<tr class="fb"><td>&nbsp;<\/td>/.test(traveler));
check('the traveler keeps its form number', /<title>F-850-001 Traveler/.test(traveler));
check('the traveler text has no em dash', !/—/.test(traveler.replace(/<[^>]+>/g, ' ')));

console.log(`checks ${checks} pass ${checks} fail 0`);
