// #585: record ids never repeat. Software pushes (PUSH-), assignments (ASG-), work order requests (WOR-) and notices
// (NTC-) took their number from the list length and then trimmed the list to a cap, so once a list was full, or after
// a notice was removed, the next record reused a live id and every lookup by id landed on the older record. Ids now
// come from a stored high-water mark (state.idCounters, op.atp.idCounters) in the same formats as before; validation
// refuses a list that holds an id twice or a mark below an id it holds; upgrade seeds the marks from the highest ids
// in a workspace saved before them and gives each later repeat in an affected workspace a new id.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHost } from '../server/mes-host.mjs';

const FAILS = [];
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${name}`); } catch (error) { FAILS.push(`${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
};
const fixtureHtml = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const seed = () => JSON.parse(fixtureHtml.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const host = createHost(new URL('../index.html', import.meta.url).pathname);
const { MES } = host;
const admin = { username: 'id-admin', displayName: 'Id Admin', role: 'admin', roles: ['admin'] };
const reviewer = { username: 'id-reviewer', displayName: 'Id Reviewer', role: 'admin', roles: ['admin'] };
const as = (account, state, fn) => host.withAccount(account, () => fn(state), state);
const fresh = () => { const state = MES.upgrade(seed()); assert.ok(state, 'the demo seed upgrades'); return state; };
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const ids = list => list.map(item => item.id);
const dupes = list => ids(list).filter((id, i, all) => all.indexOf(id) !== i);
const notice = (state, n) => as(admin, state, s => MES.postNotice(s, { kind: 'Shout-out', title: `Notice ${n}`, body: 'Record id regression.' }));
const request = state => as(admin, state, s => MES.requestWorkOrder(s, { partNumber: s.orders[0].partNumber, quantity: 1, pedigree: s.orders[0].pedigree, subcategory: s.orders[0].subcategory, reason: 'Record id regression.' }));
// An open order with an operation linked to ATP software and not bought off.
const atpOp = state => {
  const order = state.orders.find(o => ['Kitting', 'Building'].includes(o.status) && o.operations.some(op => !op.done));
  const op = order.operations.find(item => !item.done);
  op.atp = { repo: 'https://github.example/skyryse/atp', baseline: { sha: 'f'.repeat(40), version: 'v1.0.0' }, pushes: [] };
  return { order, op };
};

await check('a removed notice never gives its id to the next notice', async () => {
  const state = fresh();
  const posted = [1, 2, 3].map(n => notice(state, n));
  posted.forEach(r => assert.equal(r.ok, true, r.message));
  assert.equal(as(admin, state, s => MES.updateNotice(s, posted[0].id, 'remove')).ok, true);
  const again = notice(state, 4);
  assert.equal(again.ok, true, again.message);
  assert.ok(!posted.some(r => r.id === again.id), `the new id ${again.id} was not used before`);
  // Removing the newest notice keeps its number too.
  assert.equal(as(admin, state, s => MES.updateNotice(s, again.id, 'remove')).ok, true);
  const after = notice(state, 5);
  assert.ok(![...posted.map(r => r.id), again.id].includes(after.id), 'the removed newest notice keeps its number');
  assert.match(after.id, /^NTC-\d{4}$/, 'the NTC id format is unchanged');
  same(dupes(state.notices), []);
  assert.equal(MES.validate(state), true);
});

await check('past the 200-notice cap each notice gets a new id and acknowledgment lands on it', async () => {
  const state = fresh();
  for (let n = 0; n < 201; n += 1) assert.equal(notice(state, n).ok, true);
  const posted = as(admin, state, s => MES.postNotice(s, { kind: 'QMS change', title: 'QP change', body: 'Read the new revision.', docNumber: 'QP-7.5-001', docRevision: 'B', ackRequired: true }));
  assert.equal(posted.ok, true, posted.message);
  assert.equal(state.notices.length, 200);
  same(dupes(state.notices), []);
  assert.equal(state.notices.filter(n => n.id === posted.id).length, 1);
  assert.equal(as(reviewer, state, s => MES.acknowledgeNotice(s, posted.id)).ok, true);
  assert.equal(state.notices.find(n => n.id === posted.id).acks.length, 1, 'the acknowledgment is on the new notice');
  assert.equal(MES.validate(state), true);
});

await check('past the 500-assignment cap each assignment gets a new id and completion lands on it', async () => {
  const state = fresh();
  let last = null;
  for (let n = 0; n < 502; n += 1) {
    last = as(admin, state, s => MES.assignWork(s, { type: 'create-wo', assigneeUsername: `tech-${n}`, assigneeName: `Tech ${n}` }));
    assert.equal(last.ok, true, last.message);
  }
  assert.equal(state.assignments.length, 500);
  same(dupes(state.assignments), []);
  assert.match(last.id, /^ASG-\d{4}$/, 'the ASG id format is unchanged');
  assert.equal(state.assignments.filter(a => a.id === last.id).length, 1);
  const done = as(admin, state, s => MES.completeAssignment(s, last.id));
  assert.equal(done.ok, true, done.message);
  assert.equal(state.assignments.find(a => a.id === last.id).status, 'Done', 'completion is on the new assignment');
  assert.equal(MES.validate(state), true);
});

await check('past the 500-request cap each work order request gets a new id and the decision lands on it', async () => {
  const state = fresh();
  let last = null;
  for (let n = 0; n < 502; n += 1) { last = request(state); assert.equal(last.ok, true, last.message); }
  assert.equal(state.woRequests.length, 500);
  same(dupes(state.woRequests), []);
  assert.match(last.id, /^WOR-\d{4}$/, 'the WOR id format is unchanged');
  const declined = as(admin, state, s => MES.decideWORequest(s, last.id, 'declined', { note: 'Duplicate request.' }));
  assert.equal(declined.ok, true, declined.message);
  same(state.woRequests.filter(e => e.status === 'Declined').map(e => e.id), [last.id], 'only the new request is declined');
  assert.equal(MES.validate(state), true);
});

await check('past the 50-push cap each software push gets a new id and the review lands on it', async () => {
  const state = fresh();
  const { order, op } = atpOp(state);
  for (let n = 1; n <= 52; n += 1) { const r = as(admin, state, s => MES.pushATPSoftware(s, order.id, op.id, { sha: `abc${String(n).padStart(4, '0')}`, version: `v1.${n}` })); assert.equal(r.ok, true, r.message); }
  assert.equal(op.atp.pushes.length, 50);
  same(dupes(op.atp.pushes), []);
  const latest = op.atp.pushes.at(-1);
  assert.equal(latest.id, 'PUSH-52', 'the PUSH id format is unchanged');
  const reviewed = as(reviewer, state, s => MES.reviewATPPush(s, order.id, op.id, latest.id, 'Accepted', ''));
  assert.equal(reviewed.ok, true, reviewed.message);
  assert.equal(latest.status, 'Accepted');
  assert.equal(op.atp.baseline.version, 'v1.52', 'the accepted push is the one reviewed, not an older one');
  assert.equal(op.atp.pushes.filter(p => p.status === 'Accepted').length, 1);
  assert.equal(MES.validate(state), true);
});

await check('validation refuses a repeated id in any of the four lists and a mark below an id it holds', async () => {
  const base = fresh();
  for (let n = 0; n < 3; n += 1) notice(base, n);
  assert.equal(request(base).ok, true);
  assert.equal(request(base).ok, true);
  as(admin, base, s => MES.assignWork(s, { type: 'create-wo', assigneeUsername: 'tech-a', assigneeName: 'Tech A' }));
  as(admin, base, s => MES.assignWork(s, { type: 'create-wo', assigneeUsername: 'tech-b', assigneeName: 'Tech B' }));
  assert.equal(MES.validate(base), true);
  const pushes = idList => idList.map((id, i) => ({ id, sha: `abc000${i}`, version: `v${i}`, message: '', status: 'Pending' }));
  const broken = {
    'two notices share an id': s => { s.notices[1].id = s.notices[0].id; },
    'two assignments share an id': s => { s.assignments[1].id = s.assignments[0].id; },
    'two work order requests share an id': s => { s.woRequests[1].id = s.woRequests[0].id; },
    'two pushes on one operation share an id': s => { atpOp(s).op.atp.pushes = pushes(['PUSH-1', 'PUSH-1']); },
    'the notice mark is below a notice id': s => { s.idCounters = { ...s.idCounters, NTC: 1 }; },
    'the push mark is below a push id': s => { const { op } = atpOp(s); op.atp.pushes = pushes(['PUSH-3']); op.atp.idCounters = { PUSH: 2 }; },
    'a mark is negative': s => { s.idCounters = { ...s.idCounters, NTC: -1 }; },
    'a mark names an unknown prefix': s => { s.idCounters = { ...s.idCounters, XYZ: 4 }; }
  };
  for (const [name, damage] of Object.entries(broken)) {
    const state = structuredClone(base); damage(state);
    assert.equal(MES.validate(state), false, `${name} is refused`);
    assert.equal(MES.diagnose(state).where, 'record ids', `diagnose names the record ids for: ${name}`);
  }
});

await check('a workspace saved before the marks loads, its marks start from its highest ids, and repeats get new ids', async () => {
  const state = fresh();
  const by = { name: 'Old Poster', role: 'QA Manager', credentialId: 'ACCT-old' };
  const at = new Date().toISOString();
  delete state.idCounters;
  state.notices = ['NTC-0002', 'NTC-0003', 'NTC-0003'].map((id, i) => ({ id, kind: 'Shout-out', title: `Old ${i}`, body: 'Saved before #585.', by, at }));
  const { order, op } = atpOp(state);
  op.atp.pushes = ['PUSH-50', 'PUSH-51', 'PUSH-51'].map((id, i) => ({ id, sha: `abc000${i}`, version: `v${i}`, message: '', by, at, status: 'Pending' }));
  assert.equal(MES.validate(state), false, 'the repeated ids fail validation as stored');
  const upgraded = MES.upgrade(structuredClone(state));
  assert.ok(upgraded, 'the workspace still loads');
  assert.equal(MES.validate(upgraded), true);
  same(ids(upgraded.notices), ['NTC-0002', 'NTC-0003', 'NTC-0004'], 'the first record keeps its id; the repeat gets the next one');
  assert.equal(upgraded.idCounters.NTC, 4);
  const upOp = upgraded.orders.find(o => o.id === order.id).operations.find(item => item.id === op.id);
  same(ids(upOp.atp.pushes), ['PUSH-50', 'PUSH-51', 'PUSH-52']);
  assert.equal(notice(upgraded, 9).id, 'NTC-0005', 'the next notice continues from the mark');
  // A workspace with no repeats keeps every id and only gains the marks.
  const clean = fresh();
  delete clean.idCounters;
  clean.notices = ['NTC-0007', 'NTC-0009'].map((id, i) => ({ id, kind: 'Shout-out', title: `Old ${i}`, body: 'Saved before #585.', by, at }));
  const cleanUp = MES.upgrade(structuredClone(clean));
  same(ids(cleanUp.notices), ['NTC-0007', 'NTC-0009']);
  assert.equal(cleanUp.idCounters.NTC, 9);
  assert.equal(as(admin, cleanUp, s => MES.updateNotice(s, 'NTC-0009', 'remove')).ok, true);
  assert.equal(notice(cleanUp, 1).id, 'NTC-0010', 'the removed highest notice keeps its number after upgrade');
  assert.equal(MES.verifyManifests(cleanUp).ok, true, 'every signature still verifies');
});

console.log(`record ids: checks ${passed + FAILS.length} pass ${passed} fail ${FAILS.length}`);
console.log(`FAILS ${JSON.stringify(FAILS)}`);
if (FAILS.length) process.exitCode = 1;
