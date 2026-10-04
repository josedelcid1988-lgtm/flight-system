// Issue #706: Review & close (MES.closeOrder) writes a signed quality review closure record: the person, their
// credential, the time and a SHA-256 signature manifest, the same as the Obsolete and Scrap closure path.
// Drives the engine through the server host (the same calls the server action route makes): the signed path
// writes a record that validates and verifies, any edit to a bound field fails validation and manifest
// verification, the existing refusal paths still refuse and write nothing, and work orders closed before #706
// (no record) still load, validate and verify without a signature being invented for them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : TESTS + 'fixtures/';
const fails = [];
const ok = (what, cond, more = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + more)); if (!cond) fails.push(what); };

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const account = (role, name) => ({ username: `close-${role}`, displayName: name, role });
const qe = account('qe', 'Quinn Quality');
const qm = account('qm', 'Quincy Manager');
const technician = account('technician', 'Terry Tech');
const curated = () => JSON.parse(fs.readFileSync(FIXTURES + 'demo_publish.html', 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const QA_ID = 'WO-10004';
// WO-10004 waits in Quality in the curated sample. It is an FAI order, and the FAIR gate on Review & close has its own
// suites (test_v74, test_v80c), so here it is arranged as a non-FAI order to reach the signing step.
const fresh = () => { const state = curated(), o = MES.getOrder(state, QA_ID); assert.equal(o.status, 'Quality', 'the curated sample keeps WO-10004 in Quality'); o.fai.required = false; assert.ok(MES.validate(state)); return state; };
const closed = () => { const state = fresh(); const r = host.withAccount(qm, () => MES.closeOrder(state, QA_ID), state); assert.ok(r.ok, JSON.stringify(r)); return state; };

// ---- the signed path ----
{
  const state = fresh();
  const r = host.withAccount(qm, () => MES.closeOrder(state, QA_ID), state);
  const o = MES.getOrder(state, QA_ID), q = o.qualityClose;
  ok('Review & close closes the work order', r.ok && o.status === 'Closed', JSON.stringify(r));
  ok('the closure records the person and their credential', !!q && q.by.name === qm.displayName && typeof q.by.credentialId === 'string' && !!q.by.credentialId.trim(), JSON.stringify(q && q.by));
  ok('the closure records the time', !!q && !Number.isNaN(Date.parse(q.at)));
  ok('the closure carries a SHA-256 manifest signed by the same person at the same time', !!q && q.manifest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(q.manifest.hash) && q.manifest.at === q.at && q.manifest.signer.credentialId === q.by.credentialId && q.manifest.signer.account === qm.username, JSON.stringify(q && q.manifest));
  ok('the manifest says what was signed', !!q && q.manifest.meaning === 'Quality review complete. Work order closed');
  ok('the signature binds every buy-off hash on the order', !!q && q.manifest.subject.buyoffs.length === o.operations.length && q.manifest.subject.buyoffs.every((b, i) => b.operationId === o.operations[i].id && b.hash === (o.operations[i].buyoff && o.operations[i].buyoff.manifest ? o.operations[i].buyoff.manifest.hash : null)));
  ok('the closure is not marked Obsolete or Scrap', o.closedAs === undefined && o.closure === undefined);
  const v = MES.verifyManifests(state);
  ok('the workspace validates and every manifest verifies after Review & close', MES.validate(state) && v.ok, JSON.stringify(v.failures));
  ok('manifest verification recomputes the quality review closure', v.recomputed > MES.verifyManifests(fresh()).recomputed);
  ok('the history still records the quality review', o.history.some(h => /Quality review complete\. Work order closed\./.test(h.action)));
}

// ---- a closer with the longest username the server allows (40 characters, credential ACCT- plus 40) ----
{
  const state = fresh(), longQm = { username: 'q'.repeat(40), displayName: 'Long Name Manager', role: 'qm' };
  const r = host.withAccount(longQm, () => MES.closeOrder(state, QA_ID), state);
  const q = MES.getOrder(state, QA_ID).qualityClose;
  ok('a 40-character username closes the order and signs it', r.ok && !!q && q.by.credentialId === `ACCT-${longQm.username}`, JSON.stringify(r));
  ok('the closure signed by a 40-character username validates and verifies', MES.validate(state) && MES.verifyManifests(state).ok);
  const over = structuredClone(state); MES.getOrder(over, QA_ID).qualityClose.by.credentialId += 'X';
  ok('a closer credential over 45 characters fails validation', MES.validate(over) === false);
}

// ---- the tamper path: any edit to a bound field fails validation and manifest verification ----
{
  const tamper = (label, edit) => {
    const state = closed(), o = MES.getOrder(state, QA_ID);
    edit(o, state);
    const v = MES.verifyManifests(state);
    ok(`${label}: validation fails`, MES.validate(state) === false);
    ok(`${label}: manifest verification fails`, v.ok === false, JSON.stringify(v.failures));
  };
  tamper('signer credential edited', o => { o.qualityClose.by.credentialId = 'SOMEONE-ELSE'; });
  tamper('signer credential edited on record and manifest', o => { o.qualityClose.by.credentialId = 'SOMEONE-ELSE'; o.qualityClose.manifest.signer.credentialId = 'SOMEONE-ELSE'; });
  tamper('time moved', o => { o.qualityClose.at = '2020-01-01T00:00:00.000Z'; });
  tamper('manifest hash replaced', o => { o.qualityClose.manifest.hash = '0'.repeat(64); });
  tamper('manifest removed', o => { delete o.qualityClose.manifest; });
  tamper('a buy-off manifest replaced after closure', o => { const op = o.operations.find(x => x.buyoff && x.buyoff.manifest); op.buyoff.manifest.hash = 'f'.repeat(64); });
  tamper('revision edited after closure', o => { o.revision = o.revision + 'X'; });
  tamper('serial edited after closure', o => { o.serial = o.serial + '-X'; });
  tamper('record and subject edited without a new hash', o => { o.qualityClose.at = '2020-01-01T00:00:00.000Z'; o.qualityClose.manifest.at = o.qualityClose.at; o.qualityClose.manifest.subject.at = o.qualityClose.at; });
  {
    const state = closed(), o = MES.getOrder(state, QA_ID);
    o.status = 'Quality';
    ok('a quality review closure on an order that is not Closed fails validation', MES.validate(state) === false);
  }
  {
    const state = closed(), o = MES.getOrder(state, QA_ID);
    o.closedAs = 'Obsolete';
    ok('a quality review closure on an order closed as Obsolete fails validation', MES.validate(state) === false);
  }
  {
    // A signed closure copied onto an order it was not signed for is refused.
    const state = closed(), o = MES.getOrder(state, QA_ID);
    const other = state.orders.find(x => x.id !== QA_ID && x.status === 'Closed' && !x.closedAs && x.qualityClose === undefined);
    if (other) {
      other.qualityClose = structuredClone(o.qualityClose);
      ok(`a signed closure copied onto ${other.id} fails validation and verification`, MES.validate(state) === false && MES.verifyManifests(state).ok === false);
    } else {
      const copy = closed(), target = MES.getOrder(copy, QA_ID);
      target.id = 'WO-19999';
      ok('a signed closure moved to another work order id fails validation and verification', MES.validate(copy) === false && MES.verifyManifests(copy).ok === false);
    }
  }
}

// ---- the existing refusal paths still refuse and write no signature ----
{
  const refused = (label, state, who) => {
    const before = JSON.stringify(MES.getOrder(state, QA_ID));
    const r = host.withAccount(who, () => MES.closeOrder(state, QA_ID), state);
    ok(`${label}: refused`, r.ok === false, JSON.stringify(r));
    ok(`${label}: nothing written`, JSON.stringify(MES.getOrder(state, QA_ID)) === before);
  };
  refused('a role without approve-wo', fresh(), technician);
  {
    const state = fresh(), o = MES.getOrder(state, QA_ID);
    const nc = host.withAccount(qe, () => MES.createTicket(state, QA_ID, o.operations.at(-1).id, { type: 'NC', title: 'Torque stripe missing', description: 'No torque stripe on J3.', hold: true }), state);
    assert.ok(nc.ok, JSON.stringify(nc));
    refused('an open hold NC', state, qm);
  }
  {
    const state = fresh();
    const back = host.withAccount(qe, () => MES.sendBackToBuilding(state, QA_ID, { rationale: 'Rework J3.' }), state);
    assert.ok(back.ok, JSON.stringify(back));
    refused('an order back in Building', state, qm);
  }
  refused('an order already closed', closed(), qm);
}

// ---- legacy: orders closed before #706 carry no record, still load, validate and verify, and get none invented ----
{
  const state = closed(), o = MES.getOrder(state, QA_ID);
  delete o.qualityClose;
  ok('a closed order without a quality review closure record validates', MES.validate(state));
  const up = MES.upgrade(structuredClone(state)), uo = MES.getOrder(up, QA_ID);
  ok('upgrade keeps a legacy closed order valid and invents no signature', MES.validate(up) && uo.status === 'Closed' && uo.qualityClose === undefined);
  const v = MES.verifyManifests(up);
  ok('manifest verification passes on a legacy closed order', v.ok, JSON.stringify(v.failures));
  const upgraded = MES.upgrade(curated());
  ok('the sample workspace, with its closed orders, still validates and verifies', MES.validate(upgraded) && MES.verifyManifests(upgraded).ok);
}

console.log('FAILS', JSON.stringify(fails));
if (fails.length) process.exit(1);
