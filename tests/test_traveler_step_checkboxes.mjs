// The printed traveler (F-850-001) gives each step one check-off box and no name or date; each operation row carries the
// print name and date sign-off. The ATP test equipment row gets a check-off box too. Inline data blanks (torque,
// consumables lot and expiry, asset IDs and cal due) stay as they were.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MESPrint } = host;
let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };

// Three operations: manufacturing with three steps (one torque, one consumable), an ATP with one step and an inspection
// with two steps. Six step rows and one ATP equipment row in all.
const order = { id: 'WO-TEST-0002', partNumber: 'PN-100', revision: 'A', title: 'Test assembly', quantity: 1, pedigree: 'Production', subcategory: '', woRev: 'Baseline',
  materials: [{ partNumber: 'PN-200', name: 'Bracket', required: 1, lot: '' }],
  operations: [
    { id: 'OP-10', sequence: 10, title: 'Assemble', classification: 'Manufacturing', buyoffType: 'Technician', description: 'Assemble the bracket.',
      steps: [{ title: 'Fit', instruction: 'Fit the bracket.' }, { title: 'Torque', instruction: 'Torque the bolts.', recordsTorque: true }, { title: 'Seal', instruction: 'Apply sealant.', consumables: ['PR-1422'] }] },
    { id: 'OP-20', sequence: 20, title: 'Acceptance test', classification: 'Acceptance Test Procedure (ATP)', buyoffType: 'Technician', description: 'Run the ATP.',
      steps: [{ title: 'Run test', instruction: 'Run the acceptance test.' }] },
    { id: 'OP-30', sequence: 30, title: 'Inspect', classification: 'Inspection', inspectionPoint: true, buyoffType: 'Quality', description: 'Inspect the assembly.',
      steps: [{ title: 'Visual', instruction: 'Inspect visually.' }, { title: 'Dimensions', instruction: 'Check dimensions.' }] }
  ] };
const html = MESPrint.traveler(order, { serials: [], printedAt: new Date().toISOString(), printedBy: 'Test Printer' });
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const rowsOf = cls => html.match(new RegExp(`<tr class="${cls}">[\\s\\S]*?</tr>`, 'g')) || [];
const stepRows = rowsOf('st'), opRows = rowsOf('oh');
const boxes = row => (row.match(/<span class="box"/g) || []).length;
const cells = row => (row.match(/<td[\s>]/g) || []).length;

check('the traveler prints six step rows and one ATP equipment row', stepRows.length === 7, `${stepRows.length}`);
check('every step row and the ATP row has exactly one check-off box', stepRows.every(r => boxes(r) === 1), stepRows.map(boxes).join(','));
check('the check-off box spans the print name and date columns', stepRows.every(r => /<td class="chk" colspan="2">/.test(r) && cells(r) === 3));
check('no step row has a print name or date cell', stepRows.every(r => !/Print name|>Date</.test(r) && !/class="blank"/.test(r)));
const atp = stepRows.find(r => r.includes('Test equipment / assets (required)'));
check('the ATP equipment row keeps its asset ID and cal due blanks and gets a check-off box', !!atp && (atp.match(/Asset ID ____________ cal due ________/g) || []).length === 3 && boxes(atp) === 1);
check('the torque blanks stay inline in the step text', stepRows.some(r => r.includes('Torque: value ______ unit ____ tool ________') && boxes(r) === 1));
check('the consumables lot and expiry blanks stay inline in the step text', stepRows.some(r => r.includes('Consumables: PR-1422 · lot ______ exp ______') && boxes(r) === 1));
check('the traveler prints one operation row per operation', opRows.length === 3, `${opRows.length}`);
check('every operation row has a print name cell and a date cell', opRows.every(r => r.includes('<td class="blank">Print name</td><td class="blank">Date</td>')));
check('no operation row has a check-off box', opRows.every(r => boxes(r) === 0));
const head = html.match(/<h2>Operation sequence<\/h2>[\s\S]*?<\/thead>/);
check('the operation sequence header names the op sign-off and the step check-off',
  !!head && head[0].includes('<th>Op: print name<br>Step: done</th><th>Op: date</th>'));
check('the legend says to tick each step and sign each operation', text.includes('Tick the box on each step when it is done. When the operation is complete, print your name and the date on the operation row.'));
check('the check-off box prints as a black bordered square', /\.box\{[^}]*width:16px;height:16px;border:1\.5px solid #111/.test(html));
check('the kit verification table still has print name and date cells', /<th>Verified by \(print name\)<\/th><th>Date<\/th>/.test(html) && /<td>PN-200<\/td>[\s\S]*?<td class="blank"><\/td><td class="blank"><\/td><\/tr>/.test(html));
check('the record-of-record fallback box is unchanged', /<section class="fallback">/.test(html) && (html.match(/<tr class="fb">/g) || []).length === 4);
check('the bottom signature line is unchanged', html.includes('<div class="sig"><div>Kitted by (print name) / date</div><div>Final inspection (print name) / date</div><div>QA release (print name) / date</div></div>'));
check('the traveler keeps its form number', /<title>F-850-001 Traveler/.test(html) && text.includes('F-850-001'));
check('the traveler text has no em dash', !/—/.test(html));

console.log(`${checks} checks passed`);
