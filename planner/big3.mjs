// Datum OS personal planner: the daily big three.
// Absorbed from Cyborg mind.html (see PROVENANCE.md) and rewritten as a pure module:
// no DOM, no storage, no network. index.html inlines a copy of this file in the
// datum-planner block (Phase 4); tests/test_planner.mjs runs it in Node.
//
// A day record: { date: 'YYYY-MM-DD', big3: [slot, slot, slot], win: '', notes: '' }
// A slot: { t: text, done: bool, goal: objective id or '', src: where it came from,
//           ref: { type, id } or null, why: one line, status: 'proposed' | 'accepted' | 'declined' | '' }
// A week record: { id: 'YYYY-Www', big3: [slot, slot, slot], wins: '', friction: '', change: '' }

const SLOT = () => ({ t: '', done: false, goal: '', src: '', ref: null, why: '', status: '' });
const clean = v => String(v ?? '').trim();

export function blankDay(date) {
  return { date, big3: [SLOT(), SLOT(), SLOT()], win: '', notes: '' };
}
export function blankWeek(id) {
  return { id, big3: [SLOT(), SLOT(), SLOT()], wins: '', friction: '', change: '' };
}
export function normalizeDay(day, date) {
  const d = day && typeof day === 'object' ? day : blankDay(date);
  if (!Array.isArray(d.big3)) d.big3 = [SLOT(), SLOT(), SLOT()];
  while (d.big3.length < 3) d.big3.push(SLOT());
  d.big3 = d.big3.slice(0, 3).map(s => ({ ...SLOT(), ...(s && typeof s === 'object' ? s : {}), t: clean(s && s.t), done: !!(s && s.done) }));
  if (!d.date) d.date = date;
  if (typeof d.win !== 'string') d.win = '';
  if (typeof d.notes !== 'string') d.notes = '';
  return d;
}

// ISO week id, Monday based, matching the source planner.
export function weekId(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
export function addDays(dateISO, n) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A day counts as hit when every set slot is done and all three are set (source rule).
export function big3Hit(day) {
  return !!(day && Array.isArray(day.big3) && day.big3.filter(x => x.done && clean(x.t)).length === 3);
}
export function big3Counts(day) {
  const set = (day && day.big3 ? day.big3 : []).filter(x => clean(x.t)).length;
  const done = (day && day.big3 ? day.big3 : []).filter(x => x.done && clean(x.t)).length;
  return { set, done };
}
// Consecutive hit days ending today (or yesterday if today is not yet hit), capped at 400.
export function big3Streak(days, todayISO) {
  let n = 0, cur = todayISO;
  if (!big3Hit(days[cur])) cur = addDays(cur, -1);
  while (big3Hit(days[cur])) { n += 1; cur = addDays(cur, -1); if (n > 400) break; }
  return n;
}

// Fill empty slots from ranked candidates without duplicating a slot already set.
// A candidate: { t, why, goal, src, ref }. Returns the filled day and what was taken.
export function fillEmptySlots(day, candidates) {
  const d = normalizeDay(day, day && day.date);
  const taken = [];
  const have = new Set(d.big3.map(s => (s.ref ? `${s.ref.type}|${s.ref.id}` : `t|${s.t}`)).filter(k => k !== 't|'));
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const key = c.ref ? `${c.ref.type}|${c.ref.id}` : `t|${clean(c.t)}`;
    if (!clean(c.t) || have.has(key)) continue;
    const slot = d.big3.find(s => !clean(s.t));
    if (!slot) break;
    Object.assign(slot, { t: clean(c.t), why: clean(c.why), goal: clean(c.goal), src: clean(c.src) || 'proposed', ref: c.ref ? { ...c.ref } : null, status: 'proposed', done: false });
    have.add(key); taken.push(slot);
  }
  return { day: d, taken };
}
// Accept or decline a proposed slot. Declining clears it so the next fill can propose again,
// and returns the declined item so the caller can record the signal.
export function decide(day, index, decision) {
  const d = normalizeDay(day, day && day.date);
  const slot = d.big3[index];
  if (!slot || !clean(slot.t)) return { day: d, changed: false };
  if (decision === 'accept') { slot.status = 'accepted'; return { day: d, changed: true, slot }; }
  if (decision === 'decline') { const declined = { ...slot }; d.big3[index] = SLOT(); return { day: d, changed: true, declined }; }
  return { day: d, changed: false };
}
export function markDone(day, index, done) {
  const d = normalizeDay(day, day && day.date);
  const slot = d.big3[index];
  if (!slot || !clean(slot.t)) return { day: d, changed: false };
  slot.done = !!done;
  return { day: d, changed: true };
}
// The shutdown ritual: unfinished accepted items carry into tomorrow with their source noted.
export function carryOver(today, tomorrowDate) {
  const t = normalizeDay(today, today && today.date);
  const carried = t.big3.filter(s => clean(s.t) && !s.done && s.status !== 'declined').map(s => ({ ...s, done: false, status: 'proposed', src: 'carried', why: s.why ? `${s.why} (carried from ${t.date})` : `Carried from ${t.date}` }));
  return fillEmptySlots(blankDay(tomorrowDate), carried);
}
// A weekly review line the source planner wrote into its notes.
export function reviewLine(day, week) {
  const line = (slots, label) => `${label}: ${slots.map((b, i) => `${i + 1}. ${b.t || '(not set)'}${b.done ? ' [done]' : ''}${b.goal ? ` (goal:${b.goal})` : ''}`).join(' | ')}`;
  return [line(normalizeDay(day, day && day.date).big3, 'Daily Big 3'), week ? line(week.big3, `Weekly Big 3 (${week.id})`) : ''].filter(Boolean).join('\n');
}
