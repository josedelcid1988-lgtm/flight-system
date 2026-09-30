// #10: the printed traveler says Flight System is the record of record and gives a fallback box, used only when an
// operation cannot be recorded in Flight System when performed, to sign and date on paper and enter in the system later.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MESPrint } = host;
let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };

// A small order with the fields the traveler prints; the traveler is a pure function of the order.
const order = { id: 'WO-TEST-0001', partNumber: 'PN-100', revision: 'A', title: 'Test assembly', quantity: 1, pedigree: 'Production', subcategory: '', woRev: 'Baseline',
  materials: [{ partNumber: 'PN-200', name: 'Bracket', required: 1, lot: '' }],
  operations: [{ id: 'OP-10', sequence: 10, title: 'Assemble', classification: 'Manufacturing', buyoffType: 'Technician', description: 'Assemble the bracket.', steps: [{ title: 'Fit', instruction: 'Fit the bracket.' }] }] };
const html = MESPrint.traveler(order, { serials: [], printedAt: new Date().toISOString(), printedBy: 'Test Printer' });
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

check('the traveler states Flight System is the record of record and the traveler is a working aid',
  text.includes('Flight System is the record of record. This traveler is a working aid.'));
check('the statement says when the paper fallback applies and what to do after',
  text.includes('If an operation cannot be recorded in Flight System when performed, sign and date here, then enter it in Flight System when available.'));
const box = html.match(/<section class="fallback"[\s\S]*?<\/section>/);
check('the traveler has a fallback box', !!box);
check('the fallback box has op, print name, signature, date and entered-in-Flight-System columns',
  !!box && ['Op / step', 'Print name', 'Signature', 'Date', 'Entered in Flight System by / date'].every(h => box[0].includes(`<th>${h}</th>`)));
check('the fallback box has blank rows to write in', !!box && (box[0].match(/<tr class="fb">/g) || []).length >= 4);
check('the traveler keeps its form number', /<title>F-850-001 Traveler/.test(html));
check('the traveler text has no em dash', !/—/.test(text));

console.log(`${checks} checks passed`);
