// Flight Control sweep (engine): the behavior changes in the claude/sweep-flight-control bundle.
// #403: a split order does not inherit the parent's sequence baseline, and QA releasing a sequence change clears it.
// #294: the calibration, master WI and work order CSV imports share one header check, so they refuse a duplicate,
//       unknown or missing column and a row of the wrong width with the same words, and still import nothing.
// #196 and #197: MES.calibrationCapacity builds the calibration archive note once for both QMS records views, and the
//       note says only work orders already moved to the server archive stop holding their cited entries in the log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const SEED = fs.readFileSync(new URL('../tools/demo/seed-curated.json', import.meta.url), 'utf8');
const me = { username: 'me-mia', displayName: 'Mia Engineer', role: 'me' };
const qe = { username: 'qe-quinn', displayName: 'Quinn Quality', role: 'qe' };
const qm = { username: 'qm-qara', displayName: 'Qara Manager', role: 'qm' };
const ops = { username: 'ops-olive', displayName: 'Olive Ops', role: 'ops' };
const admin = { username: 'admin', displayName: 'Flight Master', role: 'admin' };
let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const fresh = () => MES.upgrade(JSON.parse(SEED));
const run = (state, account, fn) => host.withAccount(account, fn, state);

// ---- #403: sequence baseline -----------------------------------------------------------------------------------
{
  const state = fresh();
  const order = state.orders.find(o => ['Kitting', 'Building'].includes(o.status) && !o.inventory && o.operations.some(op => !op.done));
  check('the seed has an open order to change', !!order);
  const op = order.operations.find(x => !x.done);
  const edited = run(state, me, () => MES.editOrderOperation(state, order.id, op.id, { ...op, title: `${op.title} revised`, reason: "Clarify the operation title" }));
  check('editing an operation opens a sequence change and captures the baseline', edited.ok && Array.isArray(MES.getOrder(state, order.id).sequenceBaseline), edited.message);
  const released = run(state, qe, () => MES.approveSequenceChange(state, order.id));
  check('QA releases the sequence change', released.ok, released.message);
  check('the released sequence leaves no stale baseline behind (#403)', !Object.hasOwn(MES.getOrder(state, order.id), 'sequenceBaseline'));
  check('the workspace validates after the release', MES.validate(state), MES.diagnose(state)?.detail);
  // The refusal path is unchanged: the person who changed the sequence still cannot release it, and the baseline stays.
  const again = run(state, me, () => MES.editOrderOperation(state, order.id, op.id, { ...op, title: `${op.title} revised twice`, reason: "Clarify the title again" }));
  check('a second change captures a fresh baseline', again.ok && Array.isArray(MES.getOrder(state, order.id).sequenceBaseline), again.message);
  const self = run(state, me, () => MES.approveSequenceChange(state, order.id));
  check('the person who changed the sequence still cannot release it, and the baseline stays', !self.ok && Array.isArray(MES.getOrder(state, order.id).sequenceBaseline), self.message);
}
{
  const state = fresh();
  const parent = state.orders.find(o => o.status === 'Building' && !o.inventory) || state.orders.find(o => ['Kitting', 'Building'].includes(o.status) && !o.inventory);
  Object.assign(parent, { status: 'Building', quantity: 3 });
  delete parent.closure; delete parent.closureRequest;
  // A baseline left behind on the parent by a release made before #403.
  parent.sequenceBaseline = JSON.parse(JSON.stringify(parent.operations));
  parent.splitRequests = [{ id: 'SPR-SWEEP-1', ticketId: null, quantity: 1, of: 3, serials: [], reason: 'Split one unit out for the sweep test', status: 'Open', requestedBy: { name: 'Flight Master', role: 'Master Access', credentialId: 'MA-1' }, requestedAt: new Date().toISOString() }];
  const split = run(state, admin, () => MES.splitRequestOrder(state, parent.id, 'SPR-SWEEP-1'));
  const child = split.ok ? state.orders.find(o => o.id === split.id) : null;
  check('the split runs', split.ok && !!child, split.message);
  check('the split order does not inherit the parent sequence baseline (#403)', !!child && !Object.hasOwn(child, 'sequenceBaseline'));
}

// ---- #294: one shared CSV header check -------------------------------------------------------------------------
{
  const imports = [
    ['calibration', qm, (s, t) => MES.importCalibrations(s, t), 'tag,description,calibratedAt,expires', 'CAL-901,CALIPER,2026-09-01,2027-09-01'],
    ['master WI', me, (s, t) => MES.importMasterWIs(s, t), 'wi,partNumber,partRevision,title,operation,operationTitle,operationSummary,buyoffType,stepTitle,instruction', 'NEW-1,PN-1,A,Title,10,Op,Summary,Production,Step,Do it'],
    ['work order', ops, (s, t) => MES.importWorkOrders(s, t), 'masterWI,wiRevision,pedigree,subcategory,quantity,aircraft', 'MWI-0002,A,Production,Mfg.,1,C3'],
  ];
  const cases = [
    ['an unclosed quote', (h, r) => `${h}\n"${r}`, /^The CSV has an unclosed or misplaced quote\. Nothing was imported\.$/],
    ['a duplicate column', (h, r) => `${h},${h.split(',')[0]}\n${r},x`, /^The CSV has duplicate column names\. Nothing was imported\.$/],
    ['an unknown column', (h, r) => `${h},bogus\n${r},x`, /^The header row has columns this import does not read: bogus\. Columns: /],
    ['a missing column', (h, r) => `${h.split(',').slice(1).join(',')}\n${r.split(',').slice(1).join(',')}`, /^The header row needs the columns /],
    ['a short row', (h, r) => `${h}\n${r.split(',').slice(1).join(',')}`, /^Row 2 has \d+ cells but the header has \d+ columns\. Nothing was imported\.$/],
    ['a header with no rows', h => h, /^Paste a header row and at least one /],
  ];
  for (const [label, makeText, pattern] of cases) {
    for (const [name, account, fn, header, row] of imports) {
      const state = fresh(), before = JSON.stringify(state);
      const res = run(state, account, () => fn(state, makeText(header, row)));
      check(`the ${name} import refuses ${label} with the shared wording and changes nothing`, !res.ok && pattern.test(res.message) && JSON.stringify(state) === before, res.message);
    }
  }
  const state = fresh();
  const cal = run(state, qm, () => MES.importCalibrations(state, 'Tag, Description ,Calibrated At,EXPIRES,Torque\nCAL-902,CALIPER,2026-09-01,2027-09-01,No'));
  check('a header written with spaces and capitals still imports', cal.ok, cal.message);
}

// ---- #196 and #197: the archive note ---------------------------------------------------------------------------
{
  const cap = MES.calibrationCapacity(fresh());
  check('calibrationCapacity returns the archive note both QMS records views print', typeof cap.archiveNote === 'string' && cap.archiveNote.length > 0);
  check('the note no longer claims every buy-off citation stays in the log', !/every entry a work order buy-off cites/.test(cap.archiveNote) && /every entry a buy-off on a work order still in this workspace cites stay in the log, closed orders not yet archived included/.test(cap.archiveNote), cap.archiveNote);
  check('the note says only an entry cited by archived work orders alone can move', /cited only by work orders already moved to the server archive can move; it keeps its signature and opens by its ID from the server archive/.test(cap.archiveNote), cap.archiveNote);
  check('the note uses no em dash', !/\u2014/.test(cap.archiveNote));
}

console.log(`FAILS []\n${checks} checks passed`);
