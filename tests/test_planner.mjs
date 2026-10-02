// The Big Three planner rules, run against the production engine in index.html (MES.plannerStatus,
// createBigThreePlan, decideBigThree, carryBigThree) through the same Node host the server uses. This suite used
// to test planner/big3.mjs, a separate module no product code imported; it was removed so the rules are tested
// where they run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(new URL('../index.html', import.meta.url).pathname);
const seed = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(seed, 'the curated demo fixture carries a workspace');
const fresh = () => { const state = host.MES.upgrade(JSON.parse(seed[1])); host.FlightPlan.ensure(state); host.MES.syncBlockers(state); return state; };
// The engine runs in a vm context, so its objects carry that realm's prototypes; compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const snapshot = state => JSON.stringify({ planner: state.planner ?? null, blockers: state.blockers ?? null });
const BLANK = { t: '', done: false, why: '', ref: null, goal: '', src: '', status: '' };
const DAY = '2026-09-28', NEXT = '2026-09-29';

let n = 0, failed = 0;
const ok = (name, fn) => { n += 1; try { fn(); console.log('  ok   ' + name); } catch (e) { failed += 1; console.log('  FAIL ' + name + ' -> ' + e.message); } };

ok('an unplanned day reads as three empty slots and saves nothing', () => {
  const state = fresh();
  const status = host.MES.plannerStatus(state, DAY);
  assert.deepEqual(plain(status.day), { date: DAY, big3: [BLANK, BLANK, BLANK], win: '', notes: '' });
  assert.ok(status.total >= 3, 'the sample has at least three open tasks for the planner to rank');
  assert.equal(state.planner.days[status.username]?.[DAY], undefined, 'reading the status does not create the day');
});

ok('planning fills the three slots with the top-ranked tasks as proposals', () => {
  const state = fresh();
  const ranked = host.MES.plannerStatus(state, DAY).candidates;
  const plan = host.MES.createBigThreePlan(state, DAY);
  assert.equal(plan.ok, true);
  assert.deepEqual(plain(plan.day.big3.map(slot => slot.ref?.id)), plain(ranked.slice(0, 3).map(task => task.id)), 'slots take the candidates in rank order');
  // A must-start milestone ranks among blockers but is marked as a milestone; each slot carries its candidate's kind.
  const source = task => task.kind === 'must-start milestone' ? 'milestone' : 'blocker';
  assert.deepEqual(plain(plan.day.big3.map(slot => [slot.src, slot.ref.type])), plain(ranked.slice(0, 3).map(task => [source(task), source(task)])), 'each slot is marked with its candidate\'s source');
  assert.ok(plan.day.big3.every(slot => slot.t && slot.status === 'proposed' && slot.done === false));
  assert.equal(plan.top.length, 3);
  assert.equal(host.MES.validate(state), true);
});

ok('planning fills only empty slots, never repeats a task already set, and stops when the day is full', () => {
  const state = fresh();
  const status = host.MES.plannerStatus(state, DAY), ranked = status.candidates;
  state.planner.days[status.username] = { [DAY]: { date: DAY, big3: [{ ...BLANK, t: 'Own task', status: 'accepted' }, { ...BLANK, t: ranked[0].title, ref: { type: 'blocker', id: ranked[0].id }, src: 'blocker', status: 'proposed' }, { ...BLANK }], win: '', notes: '' } };
  const plan = host.MES.createBigThreePlan(state, DAY);
  assert.deepEqual(plain(plan.day.big3.map(slot => slot.t)), ['Own task', ranked[0].title, ranked[1].title], 'the one empty slot takes the next task, not the one already set');
  assert.equal(plan.day.big3.filter(slot => slot.ref?.id === ranked[0].id).length, 1, 'a task is never in two slots');
  assert.ok(!plan.day.big3.some(slot => slot.ref?.id === ranked[2].id), 'a lower task waits when no slot is empty');
  assert.equal(host.MES.validate(state), true);
});

ok('accept marks a proposal accepted once; accepting an empty slot or twice is refused and changes nothing', () => {
  const state = fresh();
  host.MES.createBigThreePlan(state, DAY);
  const accepted = host.MES.decideBigThree(state, DAY, 0, 'accept');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.day.big3[0].status, 'accepted');
  let before = snapshot(state);
  assert.equal(host.MES.decideBigThree(state, DAY, 0, 'accept').ok, false, 'an accepted task is not accepted again');
  assert.equal(snapshot(state), before);
  const username = accepted.username;
  state.planner.days[username][DAY].big3[2] = { ...BLANK };
  state.planner.signals.push({ username, date: DAY, index: 2, decision: 'decline', ref: { type: 'blocker', id: accepted.candidates[2].id }, reason: 'Keep this slot open', at: new Date().toISOString() });
  before = snapshot(state);
  const empty = host.MES.decideBigThree(state, DAY, 2, 'accept');
  assert.equal(empty.ok, false, 'an empty slot cannot be accepted');
  assert.match(empty.message, /empty/);
  assert.equal(snapshot(state), before, 'the refusal leaves the planner and blockers as they were');
  assert.equal(host.MES.decideBigThree(state, DAY, 3, 'accept').ok, false, 'there is no fourth slot');
  assert.equal(host.MES.decideBigThree(state, DAY, 0, 'maybe').ok, false, 'only accept and decline are decisions');
});

ok('decline needs a reason, clears the slot, records the signal, and the declined task is not proposed again that day', () => {
  const state = fresh();
  const plan = host.MES.createBigThreePlan(state, DAY), declinedId = plan.day.big3[1].ref.id;
  const before = snapshot(state);
  assert.equal(host.MES.decideBigThree(state, DAY, 1, 'decline', ' x ').ok, false, 'a decline without a real reason is refused');
  assert.equal(snapshot(state), before);
  const declined = host.MES.decideBigThree(state, DAY, 1, 'decline', 'Waiting on the supplier');
  assert.equal(declined.ok, true);
  assert.deepEqual(plain(state.planner.signals.at(-1)), { ...plain(state.planner.signals.at(-1)), username: plan.username, date: DAY, index: 1, decision: 'decline', reason: 'Waiting on the supplier', ref: { type: 'blocker', id: declinedId } });
  assert.ok(!declined.day.big3.some(slot => slot.ref?.id === declinedId), 'the declined task stays out of the day');
  assert.ok(host.MES.createBigThreePlan(state, NEXT).day.big3.some(slot => slot.ref?.id === declinedId), 'it can be proposed again on another day');
  assert.equal(host.MES.validate(state), true);
});

ok('a task resolved in its record shows as done, and nothing can be decided on it', () => {
  const state = fresh();
  const plan = host.MES.createBigThreePlan(state, DAY);
  state.planner.days[plan.username][DAY].big3[0].ref = { type: 'blocker', id: 'BLK-99999' };
  const view = host.MES.createBigThreePlan(state, DAY);
  assert.equal(view.day.big3[0].done, true, 'a task whose blocker is no longer open is done');
  assert.match(view.day.big3[0].why, /Resolved in the record\./);
  const before = snapshot(state);
  assert.equal(host.MES.decideBigThree(state, DAY, 0, 'accept').ok, false);
  assert.equal(host.MES.decideBigThree(state, DAY, 0, 'decline', 'No longer needed').ok, false);
  assert.equal(snapshot(state), before);
});

ok('carry moves only unfinished accepted tasks into tomorrow as proposals, noting where they came from', () => {
  const state = fresh();
  const plan = host.MES.createBigThreePlan(state, DAY);
  host.MES.decideBigThree(state, DAY, 0, 'accept');
  host.MES.decideBigThree(state, DAY, 1, 'accept');
  state.planner.days[plan.username][DAY].big3[1].ref = { type: 'blocker', id: 'BLK-99999' };
  const carriedId = plan.day.big3[0].ref.id, proposedId = plan.day.big3[2].ref.id;
  const carried = host.MES.carryBigThree(state, DAY);
  assert.equal(carried.ok, true);
  const tomorrow = state.planner.days[plan.username][NEXT];
  const moved = tomorrow.big3.filter(slot => slot.src === 'carried');
  assert.deepEqual(plain(moved.map(slot => slot.ref.id)), [carriedId], 'only the accepted, unresolved task carries');
  assert.equal(moved[0].status, 'proposed'); assert.equal(moved[0].done, false);
  assert.match(moved[0].why, new RegExp(`carried from ${DAY}$`));
  assert.ok(!tomorrow.big3.some(slot => slot.ref?.id === 'BLK-99999'), 'a task resolved in its record does not carry');
  assert.ok(!moved.some(slot => slot.ref.id === proposedId), 'a task never accepted does not carry');
  assert.equal(host.MES.carryBigThree(state, DAY).day.big3.filter(slot => slot.ref?.id === carriedId).length, 1, 'carrying twice does not duplicate a task');
  assert.equal(host.MES.validate(state), true);
});

ok('a day that is not a calendar date is refused', () => {
  const state = fresh();
  assert.equal(host.MES.createBigThreePlan(state, '2026-9-28').ok, false);
  assert.equal(host.MES.plannerStatus(state, 'tomorrow'), null);
  assert.equal(host.MES.decideBigThree(state, '28/09/2026', 0, 'accept').ok, false);
});

console.log(`\nplanner: ${n} checks, ${n - failed} pass`);
console.log(`checks ${n} pass ${n - failed} fail ${failed}`);
if (failed) process.exitCode = 1;
