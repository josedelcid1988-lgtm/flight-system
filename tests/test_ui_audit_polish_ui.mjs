import { chromium } from 'playwright';

// UI polish from the Jinx UX audit. Visual and wording changes only; every engine rule is unchanged.
//  - Calibration status pills: In Calibration and Out for Calibration are the neutral pill.open, Quarantined is red
//    (pill.high), Retired is gray (pill.retired). Open audits are pill.open, closed audits pill.closed. React
//    (System QMS records) and the legacy renderQmsRecords markup agree.
//  - The calibration log is a table (entry, tool tag, status, due date, recorded by) with the note in an
//    expandable row beneath each entry.
//  - Every stamp PIN input has an accessible name from its label.
//  - Trace search says it is searching and holds its Search button while the server's archive search is in
//    flight, and says plainly when that search fails. Archived print and export hold their buttons while one runs.
//  - The Hangar open-holds panel counts every held order and links to the full list.
//  - The work order queue footer reads "Work order progress and approval rules are unchanged."
const dir = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : null;
const fixtureUrl = name => dir ? new URL(name, new URL(dir, 'file:///')).href : new URL(`./fixtures/${name}`, import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const fails = [], errors = [];
const check = (name, ok, detail = '') => { if (ok) console.log(`ok   ${name}`); else { fails.push(name); console.log(`FAIL ${name} ${detail}`); } };

const open = async (user = { username: 'admin', role: 'admin', displayName: 'Flight Master' }, fixture = 'demo_qa150_publish.html') => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(u => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ ...u, salt: 'test', hash: 'unused', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', u.username);
    sessionStorage.setItem('sk-boot-seen', '1');
  }, user);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixtureUrl(fixture));
  await page.waitForFunction(() => window.__ready === true);
  return { context, page };
};
const show = (page, view) => page.evaluate(next => { view = next; render(); }, view);

// Readers run in the page against a root element: the React island or a detached node holding the legacy markup.
const readers = `({
  cal: root => [...root.querySelectorAll('tr[data-calibration-entry]')].map(tr => ({ tag: tr.cells[1].querySelector('strong').textContent, pill: [...tr.querySelector('.pill').classList].filter(c => c !== 'pill').join(' ') })),
  audits: root => [...root.querySelectorAll('.qms-record-card')].filter(card => /^AUD/.test(card.querySelector('h3')?.textContent || '')).map(card => ({ id: card.querySelector('h3').textContent.split(' · ')[0], status: card.querySelector('.panel-head > .pill').textContent, pill: [...card.querySelector('.panel-head > .pill').classList].filter(c => c !== 'pill').join(' ') })),
  shape: root => { const table = root.querySelector('table.calibration-table'); return table ? { headers: [...table.querySelectorAll('thead th')].map(th => th.textContent), scoped: [...table.querySelectorAll('thead th')].every(th => th.getAttribute('scope') === 'col'), caption: table.querySelector('caption')?.textContent, notes: [...table.querySelectorAll('tr.calibration-detail-row details.calibration-notes')].map(d => d.textContent) } : null; },
  runTogether: root => /CALLOG-\\d+ · /.test(root.textContent)
})`;
const readAll = (page, legacy) => page.evaluate(([src, legacy]) => {
  const r = Function(`return ${src}`)();
  let root = document.querySelector('#main #flight-react-island');
  if (legacy) { root = document.createElement('div'); root.innerHTML = renderQmsRecords(); }
  return { cal: r.cal(root), audits: r.audits(root), shape: r.shape(root), runTogether: r.runTogether(root) };
}, [readers, legacy]);

try {
  // ---- calibration pills, calibration table, audit pills ---------------------------------------------------------
  {
    const { context, page } = await open();
    const seeded = await page.evaluate(() => {
      const t = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), [y, m, d] = t.split('-'), due = `${+y + 1}-${m}-${d}`;
      const out = [];
      for (const [tag, status] of [['POL-01', 'In Calibration'], ['POL-02', 'Out for Calibration'], ['POL-03', 'Quarantined'], ['POL-04', 'Retired']])
        out.push(MES.recordCalibration(state, { tag, description: 'DIGITAL CALIPER', torque: 'no', serial: `SN-${tag}`, calibratedAt: t, expires: due, status, location: 'Production Floor', note: `Note for ${tag}` }));
      out.push(MES.openAudit(state, { scope: 'Receiving process audit', findings: ['Receiving log missing two entries'] }));
      return out.map(r => r.ok ? true : r.message);
    });
    check('the calibration entries and the audit used for the display checks are recorded', seeded.every(r => r === true), JSON.stringify(seeded));
    // A closed audit is added for display only (never saved) so its pill can be read.
    await page.evaluate(() => { state.audits.push({ id: 'AUD-POLISH-CLOSED', scope: 'Closed display audit', status: 'Closed', openedAt: new Date().toISOString(), openedBy: { name: 'Display' }, findings: [] }); });
    await show(page, 'qms-records');
    check('System QMS records renders through React', await page.locator('#main #flight-react-island').count() === 1);
    const react = await readAll(page, false), legacy = await readAll(page, true);
    const expected = { 'POL-01': 'open', 'POL-02': 'open', 'POL-03': 'high', 'POL-04': 'retired' };
    for (const [label, got] of [['React', react], ['legacy', legacy]]) {
      for (const [tag, cls] of Object.entries(expected)) {
        const row = got.cal.find(r => r.tag === tag);
        check(`${label}: calibration status for ${tag} uses pill.${cls}`, row && row.pill === cls, JSON.stringify(row));
      }
      const openAudit = got.audits.find(a => a.status === 'Open'), closedAudit = got.audits.find(a => a.id === 'AUD-POLISH-CLOSED');
      check(`${label}: an open audit uses the neutral pill.open, not red`, openAudit && openAudit.pill === 'open', JSON.stringify(got.audits));
      check(`${label}: a closed audit keeps pill.closed`, closedAudit && closedAudit.pill === 'closed', JSON.stringify(closedAudit));
      check(`${label}: the calibration log is a table with entry, tool tag, status, due date and recorded by columns`, got.shape && JSON.stringify(got.shape.headers) === JSON.stringify(['Entry', 'Tool tag', 'Status', 'Due date', 'Recorded by']) && got.shape.scoped && got.shape.caption === 'Calibration log entries', JSON.stringify(got.shape));
      check(`${label}: each entry's note sits in an expandable row`, got.shape && got.shape.notes.some(text => text.includes('Note for POL-04')), JSON.stringify(got.shape?.notes?.slice(0, 2)));
      check(`${label}: the calibration log no longer renders as one run-together line per entry`, !got.runTogether);
    }
    check('React and legacy list the same calibration entries with the same pills', JSON.stringify(react.cal) === JSON.stringify(legacy.cal), `${JSON.stringify(react.cal)} vs ${JSON.stringify(legacy.cal)}`);
    const notes = page.locator('#main tr.calibration-detail-row details.calibration-notes').first();
    await notes.locator('summary').click();
    check('opening a calibration entry shows its note and signature', await notes.evaluate(d => d.open) && /SHA-256/.test(await notes.innerText()));
    // Pill styles: draft is the neutral blue of pill.open; retired is muted gray, unlike open, high and closed.
    const styles = await page.evaluate(() => {
      const paint = cls => { const el = document.createElement('span'); el.className = `pill ${cls}`; document.body.append(el); const s = getComputedStyle(el); const out = `${s.color}|${s.backgroundColor}`; el.remove(); return out; };
      return { open: paint('open'), draft: paint('draft'), retired: paint('retired'), high: paint('high'), closed: paint('closed') };
    });
    check('.pill.draft has the neutral blue style of .pill.open', styles.draft === styles.open, JSON.stringify(styles));
    check('.pill.retired is its own muted style, not blue, red or green', new Set([styles.retired, styles.open, styles.high, styles.closed]).size === 4, JSON.stringify(styles));
    await context.close();
  }

  // ---- stamp PIN inputs have an accessible name -----------------------------------------------------------------
  {
    const { context, page } = await open({ username: 'quinn', role: 'qe', displayName: 'Quinn Inspector' }, 'demo_publish.html');
    const legacy = await page.evaluate(() => {
      const root = document.createElement('div');
      root.innerHTML = ['fair-verify-pin', 'fair-review-pin', 'fair-approve-pin', 'conf-aqi-pin', 'conf-8130-pin'].map(id => fairPin('Your stamp PIN', id)).join('');
      document.body.append(root);
      const out = [...root.querySelectorAll('input[name="pin"]')].map(input => ({ id: input.id, labels: [...(input.labels || [])].map(l => l.textContent) }));
      root.remove();
      return { master: !!MES.masterAccess(), out };
    });
    check('the PIN check runs as an ordinary Quality account', !legacy.master);
    check('legacy FAIR and conformity PIN inputs each have a label tied to them', legacy.out.length === 5 && legacy.out.every(i => i.id && i.labels.length === 1 && i.labels[0] === 'Your stamp PIN'), JSON.stringify(legacy.out));
    // React: the FAIR tab of an order whose FAIR is still open renders the verify form with the PIN field.
    const target = await page.evaluate(() => { const o = state.orders.find(x => x.fair && x.fair.status === 'Open'); return o ? o.id : null; });
    check('the fixture has an order with an open FAIR', !!target);
    if (target) {
      await page.evaluate(id => { selectedId = id; view = 'order'; tab = 'quality'; render(); }, target);
      // The signatures sit on the FAIR's last page.
      const pages = page.locator('#fair-panel [role="tab"]');
      if (await pages.count()) await pages.last().click();
      const pins = await page.evaluate(() => [...document.querySelectorAll('#main input[name="pin"]:not([type="hidden"])')].map(input => ({ id: input.id, labels: [...(input.labels || [])].map(l => l.textContent.trim()) })));
      check('React FAIR PIN inputs each have a label tied to them', pins.length > 0 && pins.every(p => p.id && p.labels.length === 1), JSON.stringify(pins));
      check('the React FAIR PIN is found by its label', await page.getByLabel('Your stamp PIN').count() >= 1);
    }
    // The execution tab stamp number and PIN fields, as rendered for this account.
    const exec = await page.evaluate(() => {
      const o = state.orders.find(x => x.status === 'Building' && x.operations.some(op => !op.done));
      if (!o) return null;
      selectedId = o.id; view = 'order'; tab = 'execution'; selectedOp = o.operations.find(op => !op.done).id; render();
      return [...document.querySelectorAll('#main input[name="pin"]:not([type="hidden"]), #main input[name="stampNumber"]')].map(input => ({ id: input.id, labels: [...(input.labels || [])].map(l => l.textContent.trim()) }));
    });
    check('execution tab stamp number and PIN inputs have a label tied to them', exec && exec.every(i => i.labels.length > 0), JSON.stringify(exec));
    await context.close();
  }

  // ---- trace search and archived print/export busy state ---------------------------------------------------------
  {
    const { context, page } = await open();
    await page.evaluate(() => {
      window.__traceCalls = [];
      window.skServer = Object.assign(window.skServer || {}, { active: true, token: () => 'test', context: { api: '/api' }, api: path => new Promise((resolve, reject) => { window.__traceCalls.push({ path, resolve, reject }); }) });
      traceQuery = ''; view = 'trace'; render();
    });
    const search = page.getByRole('textbox', { name: 'Traceability search' });
    const submit = page.locator('.fr-trace form button[type="submit"]');
    // Settle every pending archive search the same way until the busy line clears. A re-render can leave an earlier
    // request abandoned beside the live one; settling all of them avoids racing the debounce.
    const settle = async (kind, payload) => {
      for (let i = 0; i < 40; i++) {
        await page.evaluate(([k, p]) => window.__traceCalls.forEach(c => { if (!c.done) { c.done = true; k === 'reject' ? c.reject(new Error(p)) : c.resolve(p); } }), [kind, payload]);
        if (!(await page.locator('[data-trace-busy]').count())) return;
        await page.waitForTimeout(100);
      }
    };
    await search.fill('FC-200-00001');
    await page.locator('[data-trace-busy]').waitFor();
    check('trace search says it is searching while the server request is in flight', /Searching archived work orders/.test(await page.locator('[data-trace-busy]').innerText()) && await page.locator('[data-trace-busy]').getAttribute('role') === 'status');
    check('the Search button is disabled while the server request is in flight', await submit.isDisabled() && /Searching/.test(await submit.innerText()));
    // Enter still searches while the button waits (a disabled submit button blocks implicit form submission).
    await search.press('Enter');
    check('Enter searches while the server request is in flight', await page.evaluate(() => traceQuery) === 'FC-200-00001');
    await page.waitForFunction(() => window.__traceCalls.length > 0);
    await settle('resolve', { ok: true, status: 200, json: { results: [{ source: 'archive', orderId: 'WO-ARCH-1', title: 'Archived assembly', partNumber: 'SR-1', serials: ['FC-200-00001'], lots: [], closedAt: '2026-01-02' }] } });
    await page.locator('[data-trace-busy]').waitFor({ state: 'detached' });
    check('the Search button is enabled again when the search succeeds', await submit.isEnabled() && (await submit.innerText()).trim() === 'Search');
    check('archived matches are listed after the search', /WO-ARCH-1/.test(await page.locator('.fr-trace').innerText()));
    // Archived print and export hold their buttons while one request runs.
    await page.evaluate(() => { window.__fetch = window.fetch; window.fetch = (...args) => new Promise((resolve, reject) => { window.__archiveFetch = { args, resolve, reject }; }); });
    const exportButton = page.getByRole('button', { name: 'Export archived WO-ARCH-1' }), printButton = page.getByRole('button', { name: 'Print archived WO-ARCH-1' });
    await exportButton.click();
    await page.locator('[data-archive-busy]').waitFor();
    check('archived export says it is preparing the export', /Preparing the export for WO-ARCH-1/.test(await page.locator('[data-archive-busy]').innerText()));
    check('archived print and export are disabled while the export runs', await exportButton.isDisabled() && await printButton.isDisabled());
    await page.evaluate(() => window.__archiveFetch.reject(new Error('offline')));
    await page.locator('[data-archive-busy]').waitFor({ state: 'detached' });
    check('archived print and export are enabled again after a failure', await exportButton.isEnabled() && await printButton.isEnabled());
    check('the export failure is shown plainly', /WO-ARCH-1 could not be opened because the server did not answer/.test(await page.locator('.fr-trace').innerText()));
    // The busy line and a later failure stay visible when the search changes to one with no archived matches.
    await exportButton.click();
    await page.locator('[data-archive-busy]').waitFor();
    await search.fill('NO-ARCHIVE-MATCH');
    await settle('resolve', { ok: true, status: 200, json: { results: [] } });
    check('the archive busy line stays visible after the search changes to one with no archived matches', await page.locator('[data-archive-busy]').count() === 1 && await page.getByRole('button', { name: 'Export archived WO-ARCH-1' }).count() === 0);
    await page.evaluate(() => window.__archiveFetch.reject(new Error('offline')));
    await page.locator('[data-archive-busy]').waitFor({ state: 'detached' });
    check('the archive failure still shows after the search changed', /WO-ARCH-1 could not be opened because the server did not answer/.test(await page.locator('[data-archive-note]').innerText()));
    await page.evaluate(() => { window.fetch = window.__fetch; });
    // A server search that fails re-enables Search and says what happened.
    await search.fill('FC-200-00002');
    await page.locator('[data-trace-busy]').waitFor();
    check('a new search is busy again', await submit.isDisabled());
    await settle('reject', 'offline');
    await page.locator('[data-trace-error]').waitFor();
    check('a failed server search re-enables Search', await submit.isEnabled());
    check('a failed server search says so plainly and keeps the live results', /Archived work orders could not be searched because the server did not answer\. Live results are shown\./.test(await page.locator('[data-trace-error]').innerText()));
    await search.fill('FC-200-00003');
    await page.locator('[data-trace-busy]').waitFor();
    await settle('resolve', { ok: false, status: 503, json: {} });
    await page.locator('[data-trace-error]', { hasText: '(503)' }).waitFor();
    const unavailable = await page.locator('[data-trace-error]').innerText();
    check('a refused server search names the status and re-enables Search', /could not be searched \(503\)/.test(unavailable) && await submit.isEnabled());
    check('a server failure says to search again later, not to sign in', /Search again in a few minutes/.test(unavailable) && !/Sign in again/.test(unavailable), unavailable);
    await search.fill('FC-200-00004');
    await page.locator('[data-trace-busy]').waitFor();
    await settle('resolve', { ok: false, status: 401, json: {} });
    await page.locator('[data-trace-error]', { hasText: '(401)' }).waitFor();
    check('an expired session says to sign in again', /Sign in again, then search again\./.test(await page.locator('[data-trace-error]').innerText()));
    await context.close();
  }

  // ---- Hangar holds link and queue footer -----------------------------------------------------------------------
  {
    const { context, page } = await open();
    // Filters left on All work orders (column filter, aircraft, flagged, WI) must not hide held orders from View all holds.
    await page.evaluate(() => { skTable.state('orders').filters.Pedigree = ['No such pedigree']; aircraftFilter = MES.AIRCRAFT[0]; flaggedOnly = true; });
    check('the stale column filter is in place before the link is used', await page.evaluate(() => skTable.selected('orders', 'Pedigree').length === 1));
    await show(page, 'home');
    const holds = page.locator('.fr-holds');
    const held = await page.evaluate(() => state.orders.filter(o => o.status !== 'Closed' && (MES.blockingTickets(o).length || MES.sourceInspectionHolds(state, o).length)).length);
    const shown = await holds.locator('.fr-hold-row').count();
    check('the fixture has more than four held orders', held > 4, String(held));
    check('the Hangar holds panel shows at most four held orders', shown === Math.min(4, held), `${shown} of ${held}`);
    check('the holds count names every held order, not only the four shown', Number(await holds.locator('.fr-count').innerText()) === held, `${await holds.locator('.fr-count').innerText()} vs ${held}`);
    const link = holds.getByRole('button', { name: /View all holds/ });
    check('the holds panel offers View all holds with the total', await link.count() === 1 && (await link.innerText()).includes(`(${held})`));
    await link.click();
    await page.locator('body[data-view="orders"]').waitFor();
    check('View all holds opens All work orders filtered to On hold', await page.getByRole('combobox', { name: 'Work order status' }).inputValue() === 'On hold');
    // The list holds exactly the orders the Hangar counted: blocking tickets or pending source inspections on an open
    // order. An order held only by a source inspection is listed; an engineering-change order with no hold is not.
    const expectedIds = await page.evaluate(() => state.orders.filter(o => !['Closed', 'Cancelled', 'Scrapped'].includes(o.status) && (MES.blockingTickets(o).length || MES.sourceInspectionHolds(state, o).length)).map(o => o.id).sort());
    const listedIds = (await page.locator('.fr-order-table tbody tr[data-order-row]').evaluateAll(list => list.map(r => r.dataset.orderRow))).sort();
    check('the On hold list shows exactly the orders the Hangar counted', JSON.stringify(listedIds) === JSON.stringify(expectedIds) && listedIds.length === held, `${listedIds.length} listed vs ${expectedIds.length} expected`);
    const footer = await page.locator('.fr-queue footer').innerText();
    check('the work order queue footer says progress and approval rules are unchanged', footer.includes('Work order progress and approval rules are unchanged.'), footer);
    check('the old footer wording is gone', !/existing MES command gates/.test(await page.content()));
    // An order held only by a pending source inspection is counted on the Hangar and listed under On hold.
    const sourceOnly = await page.evaluate(() => {
      const o = state.orders.find(x => !['Closed', 'Cancelled', 'Scrapped'].includes(x.status) && !MES.blockingTickets(x).length && !MES.sourceInspectionHolds(state, x).length && !MES.engineeringChange(x));
      const original = MES.sourceInspectionHolds;
      MES.sourceInspectionHolds = (s, order) => order && order.id === o.id ? [{ id: 'SI-TEST', status: 'Pending', title: 'Source inspection pending at the supplier' }] : original(s, order);
      view = 'orders'; render();
      return o.id;
    });
    const sourceRow = page.locator(`.fr-order-table tbody tr[data-order-row="${sourceOnly}"]`);
    check('an order held only by a source inspection is listed under On hold', await sourceRow.count() === 1);
    check('that row shows it is on hold and why', /On hold/.test(await sourceRow.innerText()) && /Source inspection pending at the supplier/.test(await sourceRow.locator('[data-hold-reason]').innerText()) && /hold-row/.test(await sourceRow.getAttribute('class')));
    // Navigation without a status still clears the filter.
    await page.evaluate(() => { const b = document.createElement('button'); b.dataset.action = 'nav'; b.dataset.view = 'orders'; document.body.append(b); b.click(); b.remove(); });
    check('ordinary navigation to All work orders shows every status', await page.getByRole('combobox', { name: 'Work order status' }).inputValue() === 'All');
    // With no held orders the panel says so and offers no link.
    await page.evaluate(() => { MES.blockingTickets = () => []; MES.sourceInspectionHolds = () => []; view = 'home'; render(); });
    check('with no holds the panel says so and offers no View all holds', await page.locator('.fr-no-holds').count() === 1 && await page.locator('.fr-holds-all').count() === 0);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log('page errors', JSON.stringify(errors));
console.log('FAILS', JSON.stringify(fails));
if (fails.length || errors.length) process.exitCode = 1;
