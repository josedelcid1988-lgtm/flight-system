// Today's Big Three cards open the record they name (Jose, 2026-10-02: clicking a card takes you straight to the item).
// The card title is a real button with an accessible name. It routes by the blocker's unblock type and id: a work
// order opens on the tab that holds the pending action (Build and the sequence change, Kit, the QA release, the
// closure request), an NC opens its work order's Quality tab on that ticket, a planned order opens in Flight Plan and
// a master WI opens at its revision. Accept, Decline and Schedule stay separate and do not navigate. A record that is
// gone gets a plain notice instead of navigation. Opening a record writes nothing.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const fixtures = (process.env.FS_FIXTURES_DIR || new URL('./fixtures/', import.meta.url).pathname).replace(/\/?$/, '/');
const fixture = pathToFileURL(`${fixtures}demo_qa150_publish.html`).href;
const FAILS = [];
let checks = 0;
const check = (ok, message) => { checks++; if (!ok) FAILS.push(message); };
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];

async function signIn(context, username) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
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
  return page;
}

// Test setup only: point a planned order at a Draft WI revision (wi-release) and another at a revision that is not in
// the library (re-plan), so every blocker kind has a record. Nothing is saved; the cards read the in-memory workspace.
// Accept and Decline save through the engine, so the page that checks them is left unseeded (seed = false).
const seedKinds = (page, seed = true) => page.evaluate(seedPlans => {
  const draft = (state.masterWIs || []).find(wi => wi.status === 'Draft');
  const planned = state.plannedOrders.filter(po => po.status === 'Planned');
  if (seedPlans && draft) Object.assign(planned[0], { masterWI: { ...planned[0].masterWI, id: draft.id, revision: draft.revision, title: draft.title }, configuration: { ...planned[0].configuration, partNumber: draft.partNumber, partRevision: draft.partRevision } });
  if (seedPlans) planned[1].masterWI = { ...planned[1].masterWI, revision: 'ZZ' };
  MES.syncBlockers(state);
  const byKind = {};
  for (const row of state.blockers.filter(item => item.status === 'Open')) if (!byKind[row.kind]) byKind[row.kind] = { id: row.id, unblock: row.unblock, blocked: row.blocked };
  return byKind;
}, seed);

// Plants today's Big Three for the signed-in account with the named blockers, as Set today's Big Three would.
const plantDay = (page, ids, target = 'home') => page.evaluate(([blockerIds, where]) => {
  const date = new Date().toISOString().slice(0, 10), username = window.skAuth.actor().account;
  MES.plannerStatus(state, date);
  const rows = blockerIds.map(id => state.blockers.find(row => row.id === id));
  const slot = row => row ? { t: row.unblock.action, done: false, why: `Normal · due ${row.due}`, ref: { type: 'blocker', id: row.id }, goal: '', src: 'blocker', status: 'proposed' } : { t: '', done: false, why: '', ref: null, goal: '', src: '', status: '' };
  state.planner.days[username] = { ...(state.planner.days[username] || {}), [date]: { date, big3: [0, 1, 2].map(index => slot(rows[index])), win: '', notes: '' } };
  document.querySelectorAll('.mnv-landing').forEach(item => item.remove());
  view = where; render(); window.scrollTo(0, 0);
}, [ids, target]);

const where = page => page.evaluate(() => {
  const active = document.activeElement;
  return { view, selectedId, tab, wi: selectedWI && `${selectedWI.id}|${selectedWI.revision}`, active: active ? { tag: active.tagName, className: String(active.className || ''), ticket: active.dataset?.ticket || '', plan: active.dataset?.planRow || '', action: active.dataset?.action || '', openDetails: !!active.closest('details')?.open } : null };
});
const hangarCard = (page, index = 0) => page.locator('#flight-react-island [data-big3-variant="hangar"] .big3-slot').nth(index);
const snapshot = page => page.evaluate(() => ({ memory: JSON.stringify(state), stored: localStorage.getItem('skyryse-mes-work-order-v1') }));

try {
  const context = await browser.newContext();
  const page = await signIn(context, 'master');
  const kinds = await seedKinds(page);
  const expected = ['sequence-release', 'kit', 'qa-release', 'closure-approval', 'nc-disposition', 'nc-approval', 'po-release', 'create-wo', 're-plan', 'wi-release'];
  check(expected.every(kind => kinds[kind]), `the sample has an open blocker of every kind (${Object.keys(kinds).join(', ')})`);
  const ownerOf = ticketId => page.evaluate(id => state.orders.find(order => order.tickets.some(ticket => ticket.id === id))?.id, ticketId);

  // 1. Each kind opens the right record and tab from the Hangar card, and writes nothing.
  for (const kind of expected.filter(item => kinds[item])) {
    const blocker = kinds[kind];
    await plantDay(page, [blocker.id]);
    const button = hangarCard(page).locator('button.big3-open');
    check(await button.count() === 1, `${kind}: the card title is a button`);
    const name = await button.getAttribute('aria-label');
    const visible = (await button.innerText()).trim();
    check(!!name && name.startsWith(visible) && /\. Opens /.test(name), `${kind}: the accessible name starts with the visible title and says what opens (${name})`);
    check(await button.getAttribute('data-target-id') === blocker.unblock.id && await button.getAttribute('data-target-type') === blocker.unblock.type, `${kind}: the title points at the record the blocker names`);
    const before = await snapshot(page);
    await button.click();
    const at = await where(page);
    const after = await snapshot(page);
    check(after.memory === before.memory && after.stored === before.stored, `${kind}: opening the record changes nothing in the workspace or browser storage`);
    const id = blocker.unblock.id, seen = JSON.stringify(at);
    if (kind === 'sequence-release') check(at.view === 'order' && at.selectedId === id && at.tab === 'operations' && at.active?.tag === 'SUMMARY' && /seq-pending-title/.test(at.active.className) && at.active.openDetails, `sequence-release: opens ${id} on Build, focused on the open pending sequence change (${seen})`);
    if (kind === 'kit') check(at.view === 'order' && at.selectedId === id && at.tab === 'materials', `kit: opens ${id} on the Kit tab (${seen})`);
    if (kind === 'qa-release') check(at.view === 'order' && at.selectedId === id && at.tab === 'operations' && (at.active?.action === 'review-release' || /release-summary/.test(at.active?.className || '')), `qa-release: opens ${id} at the QA release approval (${seen})`);
    if (kind === 'closure-approval') check(at.view === 'order' && at.selectedId === id && /closure-pending/.test(at.active?.className || ''), `closure-approval: opens ${id} at the closure request (${seen})`);
    if (kind.startsWith('nc-')) { const owner = await ownerOf(id); check(at.view === 'order' && at.selectedId === owner && at.tab === 'quality' && at.active?.ticket === id, `${kind}: opens ${owner} on the Quality tab focused on ${id} (${seen})`); }
    if (['po-release', 'create-wo', 're-plan'].includes(kind)) check(at.view === 'plan' && at.active?.plan === id, `${kind}: opens planned order ${id} in Flight Plan, focused on its row (${seen})`);
    if (kind === 'wi-release') check(at.view === 'wi' && at.wi === `${id}|${blocker.unblock.revision}`, `wi-release: opens master WI ${id} Rev ${blocker.unblock.revision} (${seen})`);
  }

  // 2. Keyboard: Enter on the focused title opens the record.
  await plantDay(page, [kinds.kit.id]);
  await hangarCard(page).locator('button.big3-open').focus();
  await page.keyboard.press('Enter');
  let at = await where(page);
  check(at.view === 'order' && at.selectedId === kinds.kit.unblock.id && at.tab === 'materials', `Enter on a card title opens the record (${JSON.stringify(at)})`);

  // 3. Accept, Decline and Schedule stay separate buttons and never navigate.
  const worker = await signIn(context, 'master');
  const plain = await seedKinds(worker, false);
  await plantDay(worker, [plain.kit.id, plain['po-release'].id, plain['nc-disposition'].id]);
  const card = hangarCard(worker);
  check(await card.locator('button.big3-open [data-action]').count() === 0 && await card.locator('[data-action^="big3-"] .big3-open').count() === 0, 'the title button and the decision buttons are not nested in each other');
  await card.locator('[data-action="big3-decide"][data-decision="accept"]').click();
  at = await where(worker);
  check(at.view === 'home', `Accept does not navigate (${JSON.stringify(at)})`);
  check(await worker.evaluate(() => state.planner.days.master[new Date().toISOString().slice(0, 10)].big3[0].status) === 'accepted', 'Accept still records the decision');
  await hangarCard(worker, 1).locator('summary').click();
  await hangarCard(worker, 1).locator('[data-action="big3-decide"][data-decision="decline"]').click();
  check((await where(worker)).view === 'home', 'Decline (refused without a reason) does not navigate');
  await worker.locator('#big3-start-1').fill('09:00');
  await worker.locator('#big3-end-1').fill('10:00');
  await hangarCard(worker, 1).locator('[data-action="big3-time-propose"]').click();
  check((await where(worker)).view === 'home', 'Propose time does not navigate');

  await worker.close();

  // 4. The Flight Plan card and the page template route the same way.
  await plantDay(page, [kinds['nc-approval'].id, kinds['po-release'].id], 'plan');
  await page.locator('#flight-react-island input[aria-label="Search planned orders"]').fill('no planned order matches this');
  await page.locator('#flight-react-island [data-big3-variant="plan"] .big3-slot').nth(1).locator('button.big3-open').click();
  at = await where(page);
  check(at.view === 'plan' && at.active?.plan === kinds['po-release'].unblock.id, `the Flight Plan card opens the planned order even when the board was filtered to hide it (${JSON.stringify(at)})`);
  await page.locator('#flight-react-island [data-big3-variant="plan"] .big3-slot').nth(0).locator('button.big3-open').click();
  at = await where(page);
  check(at.view === 'order' && at.tab === 'quality' && at.active?.ticket === kinds['nc-approval'].unblock.id, `the Flight Plan card opens the NC on the Quality tab (${JSON.stringify(at)})`);
  await plantDay(page, [kinds['closure-approval']?.id || kinds.kit.id]);
  const legacy = await page.evaluate(() => { const box = document.createElement('div'); box.id = 'legacy-big3'; box.innerHTML = renderPlannerBigThree(); document.querySelector('#main').prepend(box); const button = box.querySelector('button.big3-open'); return { label: button?.getAttribute('aria-label') || '', id: button?.dataset.targetId || '', action: button?.dataset.action || '', dated: !!button?.hasAttribute('data-date') }; });
  check(legacy.action === 'open-big3-record' && /\. Opens /.test(legacy.label) && !legacy.dated, `the page template title is the same link, with no day stamp (${JSON.stringify(legacy)})`);
  await page.locator('#legacy-big3 button.big3-open').click();
  at = await where(page);
  check(at.view === 'order' && at.selectedId === legacy.id, `the page template title opens the record (${JSON.stringify(at)})`);

  // 5. A record that is gone gets a plain notice instead of navigation, and nothing changes.
  const removals = [
    ['po-release', 'state.plannedOrders = state.plannedOrders.filter(po => po.id !== id)', /^Planned order \S+ is no longer in this workspace, so it cannot be opened\./],
    ['kit', 'state.orders = state.orders.filter(order => order.id !== id)', /^Work order \S+ is no longer in this workspace, so it cannot be opened\./],
    ['nc-disposition', 'for (const order of state.orders) order.tickets = order.tickets.filter(ticket => ticket.id !== id)', /^NC \S+ is no longer in this workspace, so it cannot be opened\./]
  ];
  for (const [kind, removal, words] of removals) {
    await plantDay(page, [kinds[kind].id]);
    await page.evaluate(([id, code]) => { new Function('id', code)(id); }, [kinds[kind].unblock.id, removal]);
    const before = await snapshot(page);
    await hangarCard(page).locator('button.big3-open').click();
    at = await where(page);
    const notice = (await page.locator('#toast p').innerText()).trim();
    check(at.view === 'home' && await page.locator('#toast').isVisible() && words.test(notice), `${kind}: a removed record shows a plain notice and does not navigate (${notice} ${JSON.stringify(at)})`);
    check(!notice.includes('—'), `${kind}: the notice has no em dash`);
    const after = await snapshot(page);
    check(after.memory === before.memory && after.stored === before.stored, `${kind}: the missing-record notice changes nothing`);
  }
  await page.close();
} finally {
  await browser.close();
}
console.log(`checks ${checks} pass ${checks - FAILS.length} fail ${FAILS.length}`);
console.log('FAILS', JSON.stringify(FAILS));
console.log('page errors', JSON.stringify(errors));
process.exitCode = FAILS.length ? 1 : 0;
