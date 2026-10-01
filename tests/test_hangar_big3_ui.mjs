// Today's Big Three on the Hangar (Jose, 2026-10-01: "This should be available to everyone on their hangar page.").
// Every signed-in role sees its own planner day near the top of the Hangar, worked with the same engine commands as
// Flight Plan, so the two pages always show the same day. Opening the Hangar does not change the workspace. The panel
// collapses, remembered per person, and stays compact enough that the work queue starts above the fold on a
// 1024 x 768 tablet. Roles with nothing to plan see a plain line instead of an action; escalation stays limited to
// post-notice holders and nobody decides another person's time block.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const fixtures = (process.env.FS_FIXTURES_DIR || new URL('./fixtures/', import.meta.url).pathname).replace(/\/?$/, '/');
const fixture = pathToFileURL(`${fixtures}demo_qa150_publish.html`).href;
const ROLES = ['tech', 'quality', 'mfgeng', 'operations', 'engineering', 'master'];
const FAILS = [];
let checks = 0;
const check = (ok, message) => { checks++; if (!ok) FAILS.push(message); };
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];

async function signIn(context, username, viewport = { width: 1440, height: 900 }) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  page.on('pageerror', error => errors.push(`${username}: ${error.message}`));
  await page.addInitScript(() => { try { sessionStorage.setItem('sk-boot-seen', '1'); } catch {} });
  await page.goto(fixture, { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#sk-boot input[name=username]'), null, { timeout: 90000 });
  await page.evaluate(user => {
    const name = document.querySelector('#sk-boot input[name=username]'), form = name.closest('form');
    for (const [element, value] of [[name, user], [form.querySelector('input[type=password]'), 'demo1234']]) { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, username);
  await page.waitForFunction(user => window.skAuth?.actor?.()?.account === user && window.__ready === true, username, { timeout: 90000 });
  await showHangar(page);
  return page;
}
const showHangar = page => page.evaluate(() => { document.querySelectorAll('.mnv-landing').forEach(item => item.remove()); view = 'home'; render(); window.scrollTo(0, 0); });
const panel = page => page.locator('#flight-react-island [data-big3-variant="hangar"]');
const today = () => new Date().toISOString().slice(0, 10);

try {
  const context = await browser.newContext();

  // 1. Every role has the panel on its Hangar, scoped to its own account, and opening the Hangar changes nothing.
  const capable = {};
  for (const role of ROLES) {
    const page = await signIn(context, role);
    const big3 = panel(page);
    check(await big3.count() === 1, `${role}: the Hangar shows Today's Big Three`);
    const text = await big3.innerText();
    check(/Today's Big Three/.test(text) && text.includes(`Your day · ${role}`), `${role}: the panel names the signed-in account (${text.slice(0, 80)})`);
    const before = await page.evaluate(() => JSON.stringify(state));
    await showHangar(page);
    check(await page.evaluate(prior => JSON.stringify(state) === prior, before), `${role}: opening the Hangar leaves the workspace unchanged`);
    // Codex review on #360: a Hangar render copies only the planner and blockers, never the whole workspace.
    // Validation (maneuverValid) clones once on any page, so compare against Flight Plan, whose panel reads the live state.
    const wholeClones = await page.evaluate(() => { const original = window.structuredClone, count = target => { let whole = 0; window.structuredClone = (value, options) => { if (value === state) whole++; return original(value, options); }; try { view = target; render(); } finally { window.structuredClone = original; } return whole; }; const plan = count('plan'), home = count('home'); return { plan, home }; });
    check(wholeClones.home === wholeClones.plan, `${role}: rendering the Hangar clones the whole workspace no more often than Flight Plan (${JSON.stringify(wholeClones)})`);
    const total = await page.evaluate(() => MES.plannerStatus(structuredClone(state), new Date().toISOString().slice(0, 10)).total);
    capable[role] = total > 0;
    if (total > 0) check(await big3.locator('[data-action="big3-create"]').count() === 1, `${role}: a role with open tasks can set today's Big Three from the Hangar`);
    else {
      check(await big3.locator('[data-action="big3-create"]').count() === 0, `${role}: no Set button when nothing is assigned to the role`);
      check(/No open tasks are assigned to your capabilities\. Your Big Three fills in when a record needs an action your role can take\./.test(text), `${role}: a role with nothing to plan gets a plain line saying what fills its Big Three`);
    }
    await page.close();
  }
  check(capable.quality && capable.mfgeng && capable.master, `Quality, Manufacturing Engineering and Master Access have tasks to plan in the sample: ${JSON.stringify(capable)}`);
  console.log(`roles with tasks to plan: ${JSON.stringify(capable)}`);

  // 2. Quality sets and works the day on the Hangar; Flight Plan shows the same day.
  const quality = await signIn(context, 'quality');
  let big3 = panel(quality);
  await big3.locator('[data-action="big3-create"]').click();
  const day = () => quality.evaluate(date => state.planner.days.quality?.[date], today());
  let saved = await day();
  check(saved && saved.big3.filter(slot => slot.t).length === 3, 'Set on the Hangar stores three proposals for the signed-in account');
  await big3.locator('[data-action="big3-decide"][data-decision="accept"]').first().click();
  saved = await day();
  check(saved.big3[0].status === 'accepted', 'Accept on the Hangar records the decision on the same day');
  const declined = saved.big3[1].t;
  await big3.locator('.big3-slot').nth(1).locator('summary').click();
  await big3.locator('[data-action="big3-decide"][data-index="1"][data-decision="decline"]').click();
  check((await day()).big3[1].t === declined, 'Decline without a reason is refused and the slot stays');
  check(/Give a short reason for declining this task\./.test(await quality.locator('body').innerText()), 'the refusal says what to give');
  check(await big3.locator('.big3-slot').nth(1).locator('details').evaluate(element => element.open), 'the decline controls stay open after the refusal so the reason can be added');
  await quality.locator('#big3-reason-1').fill('Waiting on the supplier certificate');
  await big3.locator('[data-action="big3-decide"][data-index="1"][data-decision="decline"]').click();
  saved = await day();
  check(saved.big3[1].t !== declined, 'Decline with a reason on the Hangar replaces the slot');
  check(await quality.evaluate(date => state.planner.signals.some(signal => signal.username === 'quality' && signal.date === date && signal.decision === 'decline' && /supplier certificate/.test(signal.reason)), today()), 'the decline reason is recorded for the account');
  await big3.locator('.big3-slot').nth(2).locator('summary').click();
  await quality.locator('#big3-start-2').fill('09:00');
  await quality.locator('#big3-end-2').fill('10:00');
  await big3.locator('[data-action="big3-time-propose"][data-index="2"]').click();
  let block = await quality.evaluate(date => state.planner.calendar.blocks.find(item => item.username === 'quality' && item.date === date && item.status === 'Proposed'), today());
  check(!!block && block.start === '09:00' && block.end === '10:00', 'a proposed start time from the Hangar is stored for the account');
  check(await big3.locator('.big3-slot').nth(2).locator('.pill').filter({ hasText: 'Proposed time · 09:00 to 10:00' }).count() === 1, 'the Hangar shows the proposed time on the slot');
  // Codex review on #360: Decline time needs a reason field wired to the engine, which refuses a decline without one.
  const blockStatus = id => quality.evaluate(blockId => state.planner.calendar.blocks.find(item => item.id === blockId)?.status, id);
  await big3.locator('.big3-slot').nth(2).locator('summary').click();
  await big3.locator('[data-action="big3-time-decide"][data-index="2"][data-decision="decline"]').click();
  check(await blockStatus(block.id) === 'Proposed', 'declining a proposed time without a reason is refused');
  check(/Give a short reason for declining the time block\./.test(await quality.locator('body').innerText()), 'the time-decline refusal says what to give');
  await quality.locator('#big3-time-reason-2').fill('Bench is booked then');
  await big3.locator('[data-action="big3-time-decide"][data-index="2"][data-decision="decline"]').click();
  check(await blockStatus(block.id) === 'Declined', 'declining a proposed time with a reason on the Hangar records the decline');
  await big3.locator('.big3-slot').nth(2).locator('summary').click();
  await quality.locator('#big3-start-2').fill('10:00');
  await quality.locator('#big3-end-2').fill('11:00');
  await big3.locator('[data-action="big3-time-propose"][data-index="2"]').click();
  block = await quality.evaluate(date => state.planner.calendar.blocks.find(item => item.username === 'quality' && item.date === date && item.status === 'Proposed'), today());
  check(!!block && block.start === '10:00', 'a new time can be proposed after a declined one');
  check(await big3.locator('[data-action="big3-escalate"]').count() === 0, 'Quality (no post-notice) is not offered escalation on the Hangar');
  const escalation = await quality.evaluate(() => { const before = state.planner.calendar.escalations.length, result = MES.escalateBigThree(state, new Date().toISOString().slice(0, 10), 0, 'Needs QA follow-up'); return { result, unchanged: state.planner.calendar.escalations.length === before }; });
  check(escalation.result.ok === false && /post-notice holder/.test(escalation.result.message) && escalation.unchanged, 'the engine refuses escalation without post-notice and records nothing');
  const hangarTitles = await big3.locator('.big3-slot strong').allInnerTexts();
  check(/1 of 3 accepted/.test(await big3.locator('[data-big3-status]').innerText()), 'the Hangar status counts the accepted task');
  await quality.evaluate(() => { view = 'plan'; render(); });
  const plan = quality.locator('#flight-react-island [data-big3-variant="plan"]');
  check(JSON.stringify(await plan.locator('.big3-slot strong').allInnerTexts()) === JSON.stringify(hangarTitles), `Flight Plan lists the same three tasks as the Hangar (${hangarTitles.join(' | ')})`);
  check(await plan.locator('.big3-slot').first().locator('.pill.accepted').count() === 1, 'Flight Plan shows the task accepted on the Hangar');
  await plan.locator('[data-action="big3-decide"][data-index="1"][data-decision="accept"]').click();
  await showHangar(quality);
  big3 = panel(quality);
  check(/2 of 3 accepted/.test(await big3.locator('[data-big3-status]').innerText()), 'a task accepted on Flight Plan shows as accepted on the Hangar');
  await big3.locator('[data-action="big3-carry"]').click();
  const tomorrow = new Date(`${today()}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  check(await quality.evaluate(date => state.planner.days.quality?.[date]?.big3.filter(slot => slot.src === 'carried').length === 2, tomorrow.toISOString().slice(0, 10)), 'Carry on the Hangar moves both accepted tasks to tomorrow');
  check(await quality.evaluate(() => MES.validate(state)) === true, 'the workspace still validates after the Hangar actions');

  // Codex review on #360: a Hangar left open past midnight UTC must not act on today's slots from yesterday's buttons.
  const staleBefore = await quality.evaluate(() => JSON.stringify(state.planner));
  await big3.locator('[data-action="big3-decide"][data-decision="accept"]').first().evaluate(button => { button.dataset.date = '2000-01-01'; });
  await big3.locator('[data-action="big3-decide"][data-decision="accept"]').first().click();
  check(await quality.evaluate(prior => JSON.stringify(state.planner) === prior, staleBefore), 'a Big Three button drawn for another day changes nothing');
  check(/The day changed\. Today's Big Three is shown now\./.test(await quality.locator('body').innerText()), 'the refusal says the day changed and today is shown');
  check(await panel(quality).locator('[data-action="big3-decide"]').first().getAttribute('data-date') === today(), 'the redrawn panel carries today');

  // Codex review on #360: a saved task whose record was resolved shows as resolved, with no actions offered.
  const resolvedRef = await quality.evaluate(date => { const slot = state.planner.days.quality[date].big3[2], prior = slot.ref.id; slot.ref.id = 'BLK-99999'; view = 'home'; render(); return prior; }, today());
  const resolvedSlot = panel(quality).locator('.big3-slot').nth(2);
  check(/Resolved in the record/.test(await resolvedSlot.innerText()) && await resolvedSlot.locator('[data-action]').count() === 0, 'a task resolved in its record shows as resolved with no Accept, Decline or scheduling');
  // Codex review on #360: the refusal also puts back what reconciling touched (the slot's done flag and note, and the
  // blocker rows with their actor and time), so a later unrelated save cannot keep them.
  const resolvedAccept = await quality.evaluate(date => { const snapshot = () => JSON.stringify({ planner: state.planner, blockers: state.blockers }), before = snapshot(), result = MES.decideBigThree(state, date, 2, 'accept'); return { result, unchanged: snapshot() === before, done: state.planner.days.quality[date].big3[2].done }; }, today());
  check(resolvedAccept.result.ok === false && /resolved in the record/.test(resolvedAccept.result.message), 'the engine refuses to accept a task resolved in its record');
  check(resolvedAccept.unchanged && resolvedAccept.done === false, 'the refused accept leaves the planner day and the blockers exactly as they were');
  const resolvedDecline = await quality.evaluate(date => { const snapshot = () => JSON.stringify({ planner: state.planner, blockers: state.blockers }), before = snapshot(), result = MES.decideBigThree(state, date, 2, 'decline', 'No longer needed'); return { result, unchanged: snapshot() === before }; }, today());
  check(resolvedDecline.result.ok === false && /resolved in the record\. There is nothing to decline\./.test(resolvedDecline.result.message) && resolvedDecline.unchanged, 'a stale Decline on a task resolved in its record is refused, records no signal and changes nothing');
  const legacy = await quality.evaluate(() => { const box = document.createElement('div'); box.innerHTML = renderPlannerBigThree(); const slot = box.querySelectorAll('.big3-slot')[2]; return { dates: [...box.querySelectorAll('[data-action^="big3-"]')].map(button => button.dataset.date), actions: slot?.querySelectorAll('[data-action]').length, text: slot?.textContent || '' }; });
  check(legacy.dates.length > 0 && legacy.dates.every(value => value === today()), `every Big Three button in the page template carries the day it was drawn for (${legacy.dates.join(',')})`);
  check(legacy.actions === 0 && /Resolved in the record/.test(legacy.text), 'the page template also shows a task resolved in its record with no actions');
  await quality.evaluate(([date, prior]) => { state.planner.days.quality[date].big3[2].ref.id = prior; view = 'home'; render(); }, [today(), resolvedRef]);
  big3 = panel(quality);

  // 3. Collapse is remembered per person.
  await big3.locator('.fr-big3-toggle').click();
  check(await big3.locator('.big3-list').count() === 0 && await big3.locator('.fr-big3-toggle').getAttribute('aria-expanded') === 'false', 'Hide collapses the Hangar panel');
  check(await big3.locator('.fr-big3-toggle').getAttribute('aria-controls') === null, 'the collapsed toggle does not point at a panel body that is not on the page');
  check(await quality.evaluate(() => localStorage.getItem('flight-system-big3-hangar-v1:quality')) === 'collapsed', 'the collapsed choice is stored for the signed-in person');
  // A fresh mount reads the choice back from storage, as a reload or the next visit does.
  await quality.evaluate(() => { window.FlightReact.unmount(); view = 'home'; render(); });
  check(await panel(quality).locator('.big3-list').count() === 0, 'the Hangar panel stays collapsed when the Hangar is opened again');
  await panel(quality).locator('.fr-big3-toggle').click();
  check(await panel(quality).locator('.big3-list').count() === 1, 'Show expands the panel again');

  // 4. Each person sees only their own day; nobody decides another person's time block.
  const mfgeng = await signIn(context, 'mfgeng');
  const mine = panel(mfgeng);
  check((await mine.innerText()).includes('Your day · mfgeng') && /Not set for today/.test(await mine.locator('[data-big3-status]').innerText()), "Manufacturing Engineering does not see Quality's day");
  check(await mine.locator('.pill.accepted').count() === 0, 'no task accepted by Quality shows as accepted for Manufacturing Engineering');
  check(await mine.locator('.fr-big3-toggle').getAttribute('aria-expanded') === 'true', "Quality's collapsed choice does not apply to Manufacturing Engineering");
  const blocked = await mfgeng.evaluate(id => { const before = JSON.stringify(state.planner.calendar.blocks); const result = MES.decideBigThreeTimeBlock(state, id, 'accept'); return { result, unchanged: JSON.stringify(state.planner.calendar.blocks) === before }; }, block.id);
  check(blocked.result.ok === false && /Only the person assigned this time block can decide it\./.test(blocked.result.message) && blocked.unchanged, "another account is refused when deciding Quality's time block");
  await mine.locator('[data-action="big3-create"]').click();
  check(await mfgeng.evaluate(date => !!state.planner.days.mfgeng?.[date] && !!state.planner.days.quality?.[date], today()), 'each account keeps its own planner day');
  await mfgeng.close();

  // 5. Browser storage that refuses access does not stop the panel from rendering.
  const blockedStorage = await signIn(context, 'operations');
  await blockedStorage.evaluate(() => {
    const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem, blocked = key => String(key).startsWith('flight-system-big3-hangar-v1');
    window.__restoreStorage = () => { Storage.prototype.getItem = getItem; Storage.prototype.setItem = setItem; };
    Storage.prototype.getItem = function (key) { if (blocked(key)) throw new Error('storage blocked'); return getItem.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (blocked(key)) throw new Error('storage blocked'); return setItem.call(this, key, value); };
    view = 'home'; render();
  });
  const unstoredPanel = panel(blockedStorage);
  const rendered = { panel: await unstoredPanel.count() === 1 };
  await unstoredPanel.locator('.fr-big3-toggle').click();
  rendered.collapsed = await unstoredPanel.locator('.fr-big3-toggle').getAttribute('aria-expanded') === 'false';
  await blockedStorage.evaluate(() => window.__restoreStorage());
  if (process.env.HANGAR_SHOTS) console.log(JSON.stringify(rendered));
  check(rendered.panel && rendered.collapsed, 'the panel renders and still collapses when browser storage refuses access');
  await blockedStorage.close();

  // 6. Tablet fold: with the day set and tasks accepted, the work queue still starts on a 1024 x 768 screen.
  // A fresh page: the other tabs above saved the workspace, and the open tab now carries the changed-in-another-tab
  // notice, which a person would clear by reloading.
  await quality.close();
  const fold = await signIn(context, 'quality');
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await fold.setViewportSize(viewport);
    await showHangar(fold);
    const bottom = await fold.evaluate(() => document.querySelector('#fr-queue-heading').getBoundingClientRect().bottom);
    if (process.env.HANGAR_SHOTS) await fold.screenshot({ path: `${process.env.HANGAR_SHOTS}/fold-${viewport.width}.png` });
    check(bottom < viewport.height, `the work queue heading is above the fold at ${viewport.width} x ${viewport.height} (bottom ${Math.round(bottom)})`);
  }
  await fold.close();
  await context.close();
} finally {
  await browser.close();
}
assert.ok(checks > 0, 'the suite ran its checks');
console.log(`hangar big three: checks ${checks} pass ${checks - FAILS.length} fail ${FAILS.length}`);
console.log(`FAILS ${JSON.stringify(FAILS)}`);
console.log(`errors ${JSON.stringify(errors)}`);
if (FAILS.length || errors.length) process.exitCode = 1;
