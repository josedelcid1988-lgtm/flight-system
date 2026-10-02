import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Hermes audit sweep (browser), #592: the print note under an operation's Team discussion says what prints, in plain
// text, in the legacy template and the React work order. It used to render as a lone lock icon. Each check renders the
// discussion for an open order and for a closed one and reads the note's text.
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
  console.log('FAILS []');
} finally {
  await browser.close();
}
