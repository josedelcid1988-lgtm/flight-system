// Planner module (planner/big3.js): the daily big three rules absorbed from the Cyborg planner.
import assert from 'node:assert/strict';
import * as P from '../planner/big3.mjs';
let n = 0; const ok = (name, fn) => { n += 1; try { fn(); console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); process.exitCode = 1; } };

ok('a blank day has three empty slots', () => { const d = P.blankDay('2026-09-28'); assert.equal(d.big3.length, 3); assert.equal(P.big3Counts(d).set, 0); });
ok('normalize repairs a malformed day', () => { const d = P.normalizeDay({ big3: [{ t: ' Release WI ' }] }, '2026-09-28'); assert.equal(d.big3.length, 3); assert.equal(d.big3[0].t, 'Release WI'); assert.equal(d.date, '2026-09-28'); });
ok('week id is ISO, Monday based', () => { assert.equal(P.weekId('2026-09-28'), '2026-W40'); assert.equal(P.weekId('2026-01-01'), '2026-W01'); assert.equal(P.weekId('2027-01-01'), '2026-W53'); });
ok('a day is hit only when all three set slots are done', () => {
  const d = P.blankDay('2026-09-28'); d.big3[0] = { ...d.big3[0], t: 'A', done: true }; d.big3[1] = { ...d.big3[1], t: 'B', done: true };
  assert.equal(P.big3Hit(d), false); d.big3[2] = { ...d.big3[2], t: 'C', done: true }; assert.equal(P.big3Hit(d), true);
});
ok('streak counts back from today, or yesterday when today is not yet hit', () => {
  const hit = date => { const d = P.blankDay(date); d.big3 = d.big3.map((s, i) => ({ ...s, t: 'T' + i, done: true })); return d; };
  const days = { '2026-09-25': hit('2026-09-25'), '2026-09-26': hit('2026-09-26'), '2026-09-27': hit('2026-09-27') };
  assert.equal(P.big3Streak(days, '2026-09-27'), 3);
  assert.equal(P.big3Streak(days, '2026-09-28'), 3);
  assert.equal(P.big3Streak({}, '2026-09-28'), 0);
});
ok('fill takes ranked candidates into empty slots and skips duplicates', () => {
  const day = P.blankDay('2026-09-28'); day.big3[0] = { ...day.big3[0], t: 'Already set', ref: { type: 'blocker', id: 'BLK-00001' } };
  const r = P.fillEmptySlots(day, [{ t: 'Dup', ref: { type: 'blocker', id: 'BLK-00001' } }, { t: 'Release MWI-0002 Rev B', why: 'PO-20006 waits', ref: { type: 'blocker', id: 'BLK-00002' }, goal: 'OBJ-0001' }, { t: 'Firm PO-20004', ref: { type: 'blocker', id: 'BLK-00003' } }, { t: 'Fourth', ref: { type: 'blocker', id: 'BLK-00004' } }]);
  assert.equal(r.taken.length, 2); assert.equal(r.day.big3[1].t, 'Release MWI-0002 Rev B'); assert.equal(r.day.big3[1].status, 'proposed'); assert.equal(r.day.big3[2].t, 'Firm PO-20004'); assert.equal(P.big3Counts(r.day).set, 3);
});
ok('accept marks the slot accepted; decline clears it and returns the declined item', () => {
  const { day } = P.fillEmptySlots(P.blankDay('2026-09-28'), [{ t: 'One', ref: { type: 'blocker', id: 'B1' } }, { t: 'Two', ref: { type: 'blocker', id: 'B2' } }]);
  assert.equal(P.decide(day, 0, 'accept').slot.status, 'accepted');
  const r = P.decide(day, 1, 'decline'); assert.equal(r.declined.t, 'Two'); assert.equal(day.big3[1].t, '');
  assert.equal(P.decide(day, 2, 'accept').changed, false);
});
ok('done toggles only on a set slot', () => { const d = P.blankDay('2026-09-28'); assert.equal(P.markDone(d, 0, true).changed, false); d.big3[0].t = 'X'; assert.equal(P.markDone(d, 0, true).changed, true); assert.equal(d.big3[0].done, true); });
ok('carry over moves unfinished accepted items into tomorrow as proposals', () => {
  const t = P.blankDay('2026-09-28'); t.big3[0] = { ...t.big3[0], t: 'Done one', done: true, status: 'accepted' }; t.big3[1] = { ...t.big3[1], t: 'Open one', done: false, status: 'accepted', ref: { type: 'blocker', id: 'B9' } };
  const r = P.carryOver(t, '2026-09-29'); assert.equal(r.taken.length, 1); assert.equal(r.day.big3[0].t, 'Open one'); assert.equal(r.day.big3[0].src, 'carried'); assert.match(r.day.big3[0].why, /Carried from 2026-09-28/);
});
ok('review line lists the three slots', () => { const d = P.blankDay('2026-09-28'); d.big3[0].t = 'A'; d.big3[0].done = true; assert.match(P.reviewLine(d, P.blankWeek('2026-W40')), /Daily Big 3: 1\. A \[done\] \| 2\. \(not set\)/); });
console.log(`\nplanner: ${n} checks, ${n - (process.exitCode ? 1 : 0)} pass`);
