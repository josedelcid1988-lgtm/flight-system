// The training floor samples in samples/training import cleanly through the real engine importers, in the order a
// trainer runs them: calibration (QA Manager), master WIs (an account with edit-wi), peer review and release of each
// WI by two other people (separation of duties), then work orders (an account with create-wo). Each step checks the
// importer result, the counts and MES.validate. The refusal path is checked too: an account without create-wo cannot
// import the work order file and nothing changes, and the work order file is refused while the WIs are still drafts.
// The files must hold no em dash and every name field must read as training data.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const dir = new URL('../samples/training/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, dir), 'utf8');
const FILES = ['master_wis.csv', 'work_orders.csv', 'calibration.csv', 'README.md'];
const EXPECT = { wis: 5, orders: 30, tools: 20 };
// Pinned instant for the point-of-use tool check, so the result does not drift with the calendar.
const NOW = '2026-10-01T19:00:00.000Z';
const ECO = 'ECO-TRN-1001';

const qa = { username: 'trn-qa-quinn', displayName: 'Quinn Trainer QA', role: 'qm' };
const author = { username: 'trn-me-ana', displayName: 'Ana Trainer ME', role: 'me' };
const peer = { username: 'trn-me-ben', displayName: 'Ben Trainer ME', role: 'me' };
const releaser = { username: 'trn-qe-cara', displayName: 'Cara Trainer QE', role: 'qe' };
const planner = { username: 'trn-ops-olive', displayName: 'Olive Trainer Ops', role: 'ops' };
const tech = { username: 'trn-tech-sam', displayName: 'Sam Trainer Tech', role: 'technician' };

const failures = [];
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (ok) { console.log(`ok ${name}`); return; }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
};
const run = (state, account, fn) => host.withAccount(account, fn, state);
const csvRows = text => text.split(/\r?\n/).filter(line => line.trim() !== '').slice(1);
const diag = state => (MES.diagnose(state) || {}).detail || '';

try {
  // ---- the files themselves --------------------------------------------------------------------------------
  const text = Object.fromEntries(FILES.map(f => [f, read(f)]));
  for (const f of FILES) check(`${f} has no em dash`, !text[f].includes('\u2014'));
  const wiCsv = text['master_wis.csv'], woCsv = text['work_orders.csv'], calCsv = text['calibration.csv'];
  const wiTitles = csvRows(wiCsv).map(line => line.split(',')[3]);
  check('every master WI title reads as training data', wiTitles.length > 0 && wiTitles.every(t => /Training/.test(t) && /TRN-\d{4}/.test(t)), wiTitles.find(t => !/Training/.test(t)));
  check('every master WI key is a TRN number', csvRows(wiCsv).every(line => /^TRN-\d{4},/.test(line)));
  const calCells = csvRows(calCsv).map(line => line.split(','));
  check('every calibration tag is a TRN tag and every description says TRAINING', calCells.length === EXPECT.tools && calCells.every(c => /^TRN-/.test(c[0]) && /^TRAINING /.test(c[1]) && /^TRN-SN-/.test(c[3])));
  check('the work order file has one row per order', csvRows(woCsv).length === EXPECT.orders);

  // ---- 1. calibration, by a QA Manager ---------------------------------------------------------------------
  // The workspace a new server starts with: the seed plus the master WI library it seeds (MWI-0001 to MWI-0010).
  const state = MES.seed();
  MES.ensureMasterWIs(state);
  {
    const res = run(state, qa, () => MES.importCalibrations(state, calCsv));
    check('a QA Manager imports the calibration file', res.ok === true && res.ids.length === EXPECT.tools, res.message);
    check('the calibration log holds every training tool', state.calibrationLog.length === EXPECT.tools && state.calibrationLogHead?.count === EXPECT.tools);
    check('the workspace validates after the calibration import', MES.validate(state) === true, diag(state));
    check('every calibration manifest verifies', MES.verifyManifests(state).ok === true);
    const usable = calCells.filter(c => c[6] === 'In Calibration').map(c => c[0]);
    const blocked = calCells.filter(c => c[6] !== 'In Calibration').map(c => c[0]);
    check('every In Calibration training tool passes the point-of-use check', usable.length >= 15 && usable.every(tag => MES.toolCheck(tag, NOW, state).ok === true), usable.filter(tag => !MES.toolCheck(tag, NOW, state).ok).join(', '));
    const today = new Date().toISOString();
    check('every In Calibration training tool also passes the point-of-use check today', usable.every(tag => MES.toolCheck(tag, today, state).ok === true), usable.filter(tag => !MES.toolCheck(tag, today, state).ok).join(', '));
    check('the training tools stay usable until 2036, so the samples do not expire before a training session', calCells.filter(c => c[6] === 'In Calibration').every(c => c[5] >= '2036-01-01'));
    check('the Out for Calibration and Quarantined training tools are refused at point of use', blocked.length === 2 && blocked.every(tag => MES.toolCheck(tag, NOW, state).ok === false));
  }

  // ---- 2. master WIs, by an account with edit-wi -----------------------------------------------------------
  let wiIds = [];
  {
    const res = run(state, author, () => MES.importMasterWIs(state, wiCsv));
    wiIds = res.ids || [];
    check('an account with edit-wi imports the master WI file', res.ok === true && wiIds.length === EXPECT.wis, res.message);
    check('the imported WIs are the numbers the work order file names', wiIds.join() === 'MWI-0011,MWI-0012,MWI-0013,MWI-0014,MWI-0015', wiIds.join());
    const wis = wiIds.map(id => MES.findWI(state, id, 'A'));
    check('every imported WI is a Draft at Rev A with no review', wis.length === EXPECT.wis && wis.every(w => w && w.status === 'Draft' && w.revision === 'A' && !w.peerReview));
    check('every WI ends with an inspection operation with a Quality buy-off', wis.length === EXPECT.wis && wis.every(w => { const op = w.operations[w.operations.length - 1]; return op.buyoffType === 'Quality' && op.inspectionPoint === true; }));
    check('the workspace validates after the WI import', MES.validate(state) === true, diag(state));
  }

  // ---- refusal: work orders cannot be imported from draft WIs --------------------------------------------
  {
    const before = JSON.stringify(state);
    const res = run(state, planner, () => MES.importWorkOrders(state, woCsv));
    check('the work order file is refused while the WIs are drafts, and nothing changes', res.ok === false && /is Draft\. Only released master WIs can issue work orders/.test(res.message) && JSON.stringify(state) === before, res.message);
  }

  // ---- 3. peer review and release, by two other people ---------------------------------------------------
  {
    const copy = structuredClone(state);
    const own = run(copy, author, () => MES.peerReviewMasterWI(copy, wiIds[0], 'A'));
    check('the person who imported a WI cannot peer-review it', wiIds.length === EXPECT.wis && own.ok === false && /^Separation of duties/.test(own.message), own.message);
    for (const id of wiIds) {
      const reviewed = run(state, peer, () => MES.peerReviewMasterWI(state, id, 'A'));
      check(`${id} is peer-reviewed by a second engineer`, reviewed.ok === true, reviewed.message);
    }
    const copy2 = structuredClone(state);
    const byPeer = run(copy2, { ...peer, role: 'qm' }, () => MES.releaseMasterWI(copy2, wiIds[0], 'A', { eco: ECO }));
    check('the peer reviewer cannot release the WI, even with a role that may release', wiIds.length === EXPECT.wis && byPeer.ok === false && /peer reviewer cannot also release/.test(byPeer.message), byPeer.message);
    for (const id of wiIds) {
      const released = run(state, releaser, () => MES.releaseMasterWI(state, id, 'A', { eco: ECO }));
      check(`${id} is released by a Quality Engineer`, released.ok === true && MES.findWI(state, id, 'A').status === 'Released', released.message);
    }
    check('the workspace validates after release', MES.validate(state) === true, diag(state));
  }

  // ---- refusal: an account without create-wo cannot import work orders -----------------------------------
  {
    const before = JSON.stringify(state);
    const res = run(state, tech, () => MES.importWorkOrders(state, woCsv));
    check('a technician cannot import the work order file, and nothing changes', res.ok === false && JSON.stringify(state) === before, res.message);
  }

  // ---- 4. work orders, by an account with create-wo -------------------------------------------------------
  {
    const res = run(state, planner, () => MES.importWorkOrders(state, woCsv));
    check('an account with create-wo imports the work order file', res.ok === true && (res.ids || []).length === EXPECT.orders, res.message);
    check('the workspace holds every training order', state.orders.length === EXPECT.orders);
    const made = (res.ids || []).map(id => state.orders.find(o => o.id === id));
    check('every imported order starts as a draft', made.length === EXPECT.orders && made.every(o => o && o.status === 'Draft'));
    check('every order is cloned from a training WI', made.length === EXPECT.orders && made.every(o => o && wiIds.includes(o.masterWI?.id)));
    const fai = made.filter(o => o?.fai?.required === true).length;
    check('the first order of four WIs and one chosen order are first articles; the fifth WI records its waiver', fai === 5 && made.some(o => /instructor demo order/.test(o?.fai?.reason || '')), `fai ${fai}`);
    check('quantities, sites and dates come from the file', made[0]?.quantity === 1 && made[0]?.site === 'HHR' && made[0]?.start === '2026-10-05' && made[0]?.due === '2026-10-09' && made.some(o => o?.site === null) && made.some(o => o?.pedigree === 'Development NFF'));
    check('the workspace validates after the work order import', MES.validate(state) === true, diag(state));
    check('every manifest verifies at the end', MES.verifyManifests(state).ok === true);
  }
} catch (error) {
  failures.push(`the suite stopped: ${error?.stack || error}`);
  console.log(`FAIL the suite stopped: ${error?.stack || error}`);
}

console.log(`checks ${checks} pass ${checks - failures.length} fail ${failures.length}`);
console.log(`FAILS ${JSON.stringify(failures)}`);
process.exit(failures.length ? 1 : 0);
