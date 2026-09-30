// The demo seed is captured on a fixed day. On first load the page moves the seed's operational dates
// forward by the days since capture (tools/demo/seed-dates.mjs), so the demo does not age, and it never
// moves a signed or recorded date. This suite checks the function on its own, then opens the demo
// fixtures with the browser clock moved 60 and 400 days ahead and checks the workspace the page writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';
import { rebaseDemoSeed } from '../tools/demo/seed-dates.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'skyryse-mes-work-order-qa100-v1';
const DAY = 86400000;
const read = p => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const SEEDS = { curated: read('tools/demo/seed-curated.json'), qa150: read('tools/demo/seed-qa150.json') };
const FIXTURES = { curated: 'tests/fixtures/demo_publish.html', qa150: 'tests/fixtures/demo_qa150.html' };
// The only paths the rebase may change. Everything else, every signed and recorded field included, stays byte for byte.
const MOVABLE = [
  /^orders\[\d+\]\.(start|due)$/,
  /^orders\[\d+\]\.conformity\[\d+\]\.mdlReceived$/,
  /^plannedOrders\[\d+\]\.needDate$/,
  /^woRequests\[\d+\]\.needBy$/,
  /^maneuver\.cars\[\d+\]\.dueDate$/,
  /^maneuver\.cars\[\d+\]\.actions\[\d+\]\.dueDate$/,
  /^stamps\[\d+\]\.expires$/,
  /^stamps\[\d+\]\.qualifications\[\d+\]\.expires$/,
];
// A CAR whose dates move, and an order whose conformity package MDL date moves, get one history entry appended after their
// existing history (never an edit of an existing entry). Nothing else gains history.
const HISTORY_ENTRY = /^(orders\[\d+\]|maneuver\.cars\[\d+\])\.history\[(\d+)\]$/;
const isDate = p => MOVABLE.some(re => re.test(p));

let checks = 0;
const check = (name, ok, detail = '') => { checks++; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
function changedPaths(a, b, path = '', out = []) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) changedPaths(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
  } else if (a !== b) out.push(path);
  return out;
}
const capturedOn = seed => seed.activity.map(a => a.at.slice(0, 10)).sort().pop();
const get = (obj, p) => p.split(/\.|\[|\]/).filter(Boolean).reduce((v, k) => v?.[k], obj);

// ---- the function on its own ------------------------------------------------------------------
for (const [name, seed] of Object.entries(SEEDS)) {
  const captured = capturedOn(seed);
  check(`${name}: a clock on or before the capture day moves nothing`, changedPaths(seed, rebaseDemoSeed(seed, captured)).length === 0 && changedPaths(seed, rebaseDemoSeed(seed, addDays(captured, -30))).length === 0);
  const before = JSON.stringify(seed);
  for (const ahead of [60, 400]) {
    const day = addDays(today, ahead), gap = Math.round((Date.parse(day) - Date.parse(captured)) / DAY);
    const out = rebaseDemoSeed(seed, day), changed = changedPaths(seed, out);
    const dates = changed.filter(isDate), entries = changed.filter(p => !isDate(p));
    check(`${name} +${ahead}d: the seed object itself is not modified`, JSON.stringify(seed) === before);
    check(`${name} +${ahead}d: only operational dates move, plus one appended history entry per moved record`, dates.length > 0 && entries.every(p => { const m = HISTORY_ENTRY.exec(p); return m && Number(m[2]) === get(seed, `${m[1]}.history`).length; }), entries.filter(p => !HISTORY_ENTRY.test(p)).join(', '));
    check(`${name} +${ahead}d: every moved date moves by exactly the days since capture (${gap})`, dates.every(p => addDays(get(seed, p), gap) === get(out, p)));
    const owners = [...new Set(dates.map(p => /^(orders\[\d+\]|plannedOrders\[\d+\]|maneuver\.cars\[\d+\]|stamps\[\d+\]|woRequests\[\d+\])/.exec(p)[1]))];
    const needsEntry = owner => owner.startsWith('maneuver.cars') || dates.some(p => p.startsWith(`${owner}.conformity`));
    check(`${name} +${ahead}d: records whose history text would disagree get exactly one Demo build entry naming every old and new date; others get none`, owners.every(owner => {
      const history = get(seed, `${owner}.history`); if (!Array.isArray(history)) return true;
      const added = get(out, `${owner}.history`).slice(history.length);
      if (!needsEntry(owner)) return added.length === 0;
      if (added.length !== 1) return false;
      const entry = added[0], by = entry.actor || entry.by;
      return /^Demo build|^demo build$/.test(by) && entry.at === `${day}T00:00:00.000Z` && dates.filter(p => p.startsWith(`${owner}.`)).every(p => entry.action.includes(`${get(seed, p)} to ${get(out, p)}`)) && !/\u2014/.test(entry.action);
    }));
    const openCars = (seed.maneuver?.cars || []).map((c, i) => [c, out.maneuver.cars[i]]).filter(([c]) => c.status !== 'Closed' && c.status !== 'Cancelled');
    check(`${name} +${ahead}d: an open CAR's latest history states the due date it now carries`, openCars.every(([c, r]) => r.history.at(-1).action.includes(`Due date ${c.dueDate} to ${r.dueDate}`)));
    // Refusal paths: records that are signed, closed or completed keep their dates.
    const closed = seed.orders.filter(o => o.status === 'Closed');
    check(`${name} +${ahead}d: closed orders keep their start and due dates`, closed.length > 0 && closed.every(o => { const r = out.orders.find(x => x.id === o.id); return r.due === o.due && r.start === o.start; }));
    const locked = seed.orders.flatMap(o => (o.conformity || []).filter(p => p.form).map(p => [o.id, p]));
    check(`${name} +${ahead}d: a package with a completed 8130-9 keeps its MDL date (the form locks the package data)`, locked.every(([id, p]) => out.orders.find(o => o.id === id).conformity.find(x => x.serial === p.serial).mdlReceived === p.mdlReceived));
    const doneActions = (seed.maneuver?.cars || []).flatMap((c, i) => (c.actions || []).map((a, j) => [i, j, a]).filter(([, , a]) => a.completedAt));
    check(`${name} +${ahead}d: completed CAR actions and closed CARs keep their due dates`, doneActions.every(([i, j, a]) => out.maneuver.cars[i].actions[j].dueDate === a.dueDate) && (seed.maneuver?.cars || []).every((c, i) => c.status !== 'Closed' || out.maneuver.cars[i].dueDate === c.dueDate));
    check(`${name} +${ahead}d: stamp issue dates and stamp history do not move`, seed.stamps.every((s, i) => out.stamps[i].issued === s.issued && JSON.stringify(out.stamps[i].history) === JSON.stringify(s.history)));
  }
}

// ---- engines accept the moved seed and its signatures still verify ------------------------------
const engines = { production: createHost(`${ROOT}index.html`).MES, demo: createHost(`${ROOT}demo.html`).MES };
for (const ahead of [60, 400]) {
  const day = addDays(today, ahead);
  for (const [engine, MES] of Object.entries(engines)) {
    for (const [name, seed] of Object.entries(SEEDS)) {
      if (engine === 'production' && name === 'qa150') continue; // 150 orders exceed the production limit of 100; the demo raises it (D-11)
      const state = MES.upgrade(rebaseDemoSeed(seed, day));
      check(`${engine} engine, ${name} +${ahead}d: the moved seed validates`, !!state && MES.validate(state) === true, (state && MES.diagnose(state)?.detail) || 'upgrade refused');
      const v = MES.verifyManifests(state), v0 = MES.verifyManifests(MES.upgrade(structuredClone(seed)));
      check(`${engine} engine, ${name} +${ahead}d: every signature manifest still verifies, the same ones as the seed as captured`, v.ok === true && v.failures.length === 0 && v.checked === v0.checked && v.recomputed === v0.recomputed, JSON.stringify(v.failures.slice(0, 2)));
    }
  }
}

// ---- the page, first opened with the clock moved forward -----------------------------------------
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    for (const ahead of [60, 400]) {
      const day = addDays(today, ahead);
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name} +${ahead}d: ${e.message}`));
      await page.clock.setFixedTime(new Date(`${day}T15:00:00Z`));
      // Keep the first workspace the page writes, before the app or the overlay touch it.
      await page.addInitScript(key => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === key && window.__firstSeedWrite === undefined) window.__firstSeedWrite = v; return set.call(this, k, v); }; }, KEY);
      await page.goto(pathToFileURL(`${ROOT}${fixture}`).href);
      await page.waitForFunction(() => window.__firstSeedWrite !== undefined && typeof window.MES === 'object');
      const result = await page.evaluate(() => {
        const written = JSON.parse(window.__firstSeedWrite), state = MES.upgrade(structuredClone(written)), pageDay = new Date().toISOString().slice(0, 10);
        const gaps = state.orders.flatMap(o => (o.conformity || []).filter(p => !p.form).flatMap(p => MES.confGaps(state, o, p, 'prepare').filter(g => /Step 1\.1: the MDL copy is/.test(g)).map(g => `${o.id} ${p.serial}: ${g}`)));
        const openPackages = state.orders.reduce((n, o) => n + (o.conformity || []).filter(p => !p.form).length, 0);
        const expired = state.stamps.filter(s => s.status === 'Active' && (s.expires < pageDay || (s.qualifications || []).some(q => q.expires < pageDay))).map(s => s.number);
        const manifests = MES.verifyManifests(state);
        // Control: the seed as captured, not moved, does show the out-of-date MDL copy at this clock, so the gap check above can fail.
        const raw = MES.upgrade(structuredClone(window.__DEMO_SEED));
        const rawGaps = raw.orders.flatMap(o => (o.conformity || []).filter(p => !p.form).flatMap(p => MES.confGaps(raw, o, p, 'prepare').filter(g => /Step 1\.1: the MDL copy is/.test(g))));
        return { written, pageDay, valid: MES.validate(state) === true, detail: (MES.diagnose(state) || {}).detail || '', gaps, rawGaps: rawGaps.length, openPackages, expired, manifests: { ok: manifests.ok, failures: manifests.failures.length } };
      });
      check(`${name} page +${ahead}d: the browser clock is the moved day`, result.pageDay === day, result.pageDay);
      check(`${name} page +${ahead}d: the first-load workspace is the seed moved to that day`, JSON.stringify(result.written) === JSON.stringify(rebaseDemoSeed(SEEDS[name], `${day}T15:00:00.000Z`)));
      check(`${name} page +${ahead}d: the first-load workspace validates`, result.valid, result.detail);
      check(`${name} page +${ahead}d: every signature manifest verifies`, result.manifests.ok === true && result.manifests.failures === 0, JSON.stringify(result.manifests));
      check(`${name} page +${ahead}d: no package with an open 8130-9 shows an out-of-date MDL copy`, result.gaps.length === 0, result.gaps.join(' | '));
      if (name === 'curated') {
        check(`${name} page +${ahead}d: the curated set still has an open conformity package to walk`, result.openPackages > 0);
        check(`${name} page +${ahead}d: control: the seed as captured shows the out-of-date MDL copy at this clock`, result.rawGaps > 0);
      }
      check(`${name} page +${ahead}d: no active stamp or stamp qualification has expired`, result.expired.length === 0, result.expired.join(', '));
      await context.close();
    }
  }
} finally {
  await browser.close();
}
check('the demo pages opened without page errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks} fail 0`);
