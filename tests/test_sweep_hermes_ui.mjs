import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Hermes audit sweep (browser).
// #592: the print note under an operation's Team discussion says what prints, in plain text, in the legacy template and
//       the React work order. It used to render as a lone lock icon. Each check renders the discussion for an open
//       order and for a closed one and reads the note's text.
// #588 (review of PR #605): with the browser clock at 17:30 Pacific (already the next day in UTC), the forms that feed
//       the site-day checks default to the site day: Raise SPR, Create work order and Ad hoc work order. The Edit
//       operation dialog offers only inspection buy-offs for a Source Inspection operation (#590).
const NOTE = 'Internal prints include this discussion. External prints omit all messages and Slack links.';
const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(`${error.message}`));
  page.on('dialog', dialog => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);

  const notes = await page.evaluate(async () => {
    const out = [];
    const pick = [state.orders.find(o => o.status === 'Building'), state.orders.find(o => o.status === 'Closed')].filter(Boolean);
    for (const o of pick) {
      const op = o.operations[0];
      const legacy = document.createElement('div'), react = document.createElement('div');
      document.body.append(legacy, react);
      try {
        legacy.innerHTML = renderDiscussion(o, op);
        window.FlightReact.renderOrder(react, state, MES, o, 'operations', op.id, skCan, 'Baseline');
        await new Promise(done => setTimeout(done, 50));
        for (const [where, host] of [['legacy', legacy], ['React', react]]) {
          const note = host.querySelectorAll('.discussion-print-note');
          out.push({ where, status: o.status, count: note.length, text: note.length ? note[0].textContent.trim() : null, icon: note.length ? !!note[0].querySelector('svg') : null });
        }
      } finally { window.FlightReact.unmount?.(); legacy.remove(); react.remove(); }
    }
    return out;
  });
  assert.equal(notes.length, 4, `legacy and React notes for an open and a closed order: ${JSON.stringify(notes)}`);
  for (const n of notes) {
    assert.equal(n.count, 1, `${n.where} ${n.status}: one print note (${JSON.stringify(n)})`);
    assert.equal(n.text, NOTE, `${n.where} ${n.status}: the print note says what prints, not a lone icon`);
    assert.ok(!/—/.test(n.text), `${n.where} ${n.status}: no em dash in the print note`);
  }
  assert.deepEqual(errors, []);
  console.log(`Discussion print note: ${notes.length} renders (legacy and React, open and closed orders) read "${NOTE}"`);
  await context.close();

  // Pacific evening: 2026-10-01 17:30 PDT is 2026-10-02T00:30Z. Nothing here is saved; the page is discarded.
  const evening = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await evening.addInitScript(() => {
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: '2026-09-01T00:00:00.000Z' }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const late = await evening.newPage(), lateErrors = [];
  late.on('pageerror', error => lateErrors.push(`${error.message}`));
  await late.clock.setFixedTime(new Date('2026-10-02T00:30:00.000Z'));
  await late.goto(fixture);
  await late.waitForFunction(() => window.__ready === true);
  const forms = await late.evaluate(() => {
    const value = selector => document.querySelector(selector)?.value ?? null;
    const close = () => { try { document.getElementById('dialog').close(); } catch (e) {} };
    const out = { siteToday: MES.siteToday(), utcDay: new Date().toISOString().slice(0, 10) };
    const button = document.createElement('button');
    button.dataset.action = 'mnv-spr-new';
    document.body.append(button);
    button.click(); button.remove();
    out.spr = value('#mnv-spr-date'); close();
    createDialog(); out.createStart = value('#new-start'); out.createDue = value('#new-due'); close();
    adhocDialog(); out.adhocStart = value('#adhoc-start'); out.adhocDue = value('#adhoc-due'); close();
    const o = state.orders.find(item => item.status === 'Draft' && item.operations.length);
    const added = MES.addOrderOperation(state, o.id, { classification: 'Source Inspection', sourceInspectionCode: 'CSI', title: 'Customer source inspection', description: 'Inspect before release', buyoffType: 'Quality', steps: 'Inspect parts', position: 0 });
    out.added = added.ok || added.message;
    selectedId = o.id;
    sequenceEditDialog(o.operations[0].id);
    const options = [...document.querySelectorAll('#seq-edit-form select[name="buyoffType"] option')];
    out.offered = options.filter(item => !item.disabled).map(item => item.value);
    close();
    return out;
  });
  assert.equal(forms.siteToday, '2026-10-01', `the page clock is 17:30 Pacific on 2026-10-01 (${JSON.stringify(forms)})`);
  assert.equal(forms.utcDay, '2026-10-02', 'and already 2026-10-02 in UTC');
  assert.equal(forms.spr, '2026-10-01', 'Raise SPR defaults its date to the site day, which the engine accepts');
  assert.equal(forms.createStart, '2026-10-01', 'Create work order defaults its planned start to the site day');
  assert.equal(forms.createDue, '2026-10-08', 'Create work order defaults its planned finish to a week after the site day');
  assert.equal(forms.adhocStart, '2026-10-01', 'Ad hoc work order defaults its planned start to the site day');
  assert.equal(forms.adhocDue, '2026-10-08', 'Ad hoc work order defaults its planned finish to a week after the site day');
  assert.equal(forms.added, true, `a Source Inspection operation is added for the edit dialog check: ${forms.added}`);
  assert.deepEqual(forms.offered.sort(), [...(await late.evaluate(() => MES.INSPECTION_BUYOFF_TYPES))].sort(), `Edit operation offers only inspection buy-offs for Source Inspection: ${forms.offered.join(', ')}`);
  assert.deepEqual(lateErrors, []);
  console.log(`Pacific evening forms: SPR ${forms.spr}, work order ${forms.createStart} to ${forms.createDue}, ad hoc ${forms.adhocStart} to ${forms.adhocDue}; Source Inspection edit offers ${forms.offered.join(', ')}`);
  console.log('FAILS []');
} finally {
  await browser.close();
}
