// The printed traveler (F-850-001) names how a closed work order was closed: "Closed as Scrap" or "Closed as Obsolete"
// when the order carries closedAs, plain "Closed" for a normal closure, and no status row while the order is open.
// Display only: the order record is not changed by printing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, MESPrint } = host;
const account = (role, name) => ({ username: `traveler-${role}`, displayName: name, role });
const requester = account('me', 'Morgan Engineer');
const approver = account('qm', 'Quincy Manager');
let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };

const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : decodeURI(new URL('.', import.meta.url).pathname) + 'fixtures/';
const state = JSON.parse(fs.readFileSync(FIXTURES + 'demo_publish.html', 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const as = (who, fn) => host.withAccount(who, fn, state);
const statusRow = html => (html.match(/<dt>Status<\/dt><dd>([^<]*)<\/dd>/) || [])[1];
const print = id => MESPrint.traveler(MES.getOrder(state, id), { serials: [], printedAt: '2026-10-01T15:00:00.000Z', printedBy: 'Test Printer' });
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// The curated sample: two Building orders to close (Scrap links the NC on WO-10005), an open Kitting order and an
// order that was closed the normal way.
const SCRAP = 'WO-10003', OBSOLETE = 'WO-10006', OPEN = 'WO-10007', NORMAL = 'WO-10001', NC = 'NC-0001';
check('the sample has the orders and the NC the closures need',
  [SCRAP, OBSOLETE].every(id => MES.getOrder(state, id)?.status === 'Building') && MES.getOrder(state, OPEN)?.status === 'Kitting' && MES.getOrder(state, NORMAL)?.status === 'Closed' && !MES.getOrder(state, NORMAL).closedAs && MES.getOrder(state, 'WO-10005').tickets.some(t => t.id === NC));

const close = (id, input) => {
  const request = as(requester, () => MES.requestOrderClosure(state, id, input));
  check(`${id} closure request for ${input.reason} is accepted`, request.ok, request.message);
  const decision = as(approver, () => MES.decideOrderClosure(state, id, true, 'Confirmed.'));
  check(`${id} closure as ${input.reason} is approved`, decision.ok, decision.message);
};

check('an open order prints no status row', statusRow(print(OPEN)) === undefined);

close(SCRAP, { reason: 'Scrap', note: 'Scrapped after damage.', ticketId: NC });
close(OBSOLETE, { reason: 'Obsolete', note: 'Superseded by the next revision.' });

const scrap = print(SCRAP);
const obsolete = print(OBSOLETE);
check('a scrapped order prints "Closed as Scrap" in the header', statusRow(scrap) === 'Closed as Scrap' && text(scrap).includes('Closed as Scrap'));
check('an obsolete order prints "Closed as Obsolete" in the header', statusRow(obsolete) === 'Closed as Obsolete' && text(obsolete).includes('Closed as Obsolete'));
check('the scrap traveler does not say Obsolete and the obsolete traveler does not say Scrap', !/Closed as Obsolete/.test(scrap) && !/Closed as Scrap/.test(obsolete));

// An order closed the normal way carries no closedAs.
const normalHtml = print(NORMAL);
check('a normally closed order prints plain "Closed" without "as"', statusRow(normalHtml) === 'Closed' && !/Closed as/.test(normalHtml));

// Text from the order is escaped like the rest of the template.
const hostile = { ...MES.getOrder(state, NORMAL), closedAs: '<img src=x onerror=alert(1)>' };
const hostileHtml = MESPrint.traveler(hostile, { serials: [], printedAt: '2026-10-01T15:00:00.000Z', printedBy: 'Test Printer' });
check('the closed-as text is escaped', !hostileHtml.includes('<img src=x') && hostileHtml.includes('Closed as &lt;img'));

check('printing does not change the order', MES.getOrder(state, SCRAP).closedAs === 'Scrap' && MES.getOrder(state, OBSOLETE).closedAs === 'Obsolete');
check('the traveler text has no em dash', ![scrap, obsolete, normalHtml].some(h => /—/.test(text(h))));
check('the workspace is valid after the closures', MES.validate(state));

console.log(`${checks} checks passed`);
