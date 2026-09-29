import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// The React screens routed in this build render without page errors and keep the behavior of the legacy views they
// replace. Views not yet ready for React stay on legacy: WI library and detail, Flight Maneuver record details, QMS
// configuration (record export settings), the support log (filters) and work order detail (buy-off prompt).
const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(`${error.message}`));
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);
  const show = async (name, setup = '') => {
    await page.evaluate(([next, code]) => { Function(code)(); view = next; render(); }, [name, setup]);
    return page.evaluate(() => ({ react: !!document.querySelector('#main #flight-react-island'), text: (document.querySelector('#main')?.innerText || '').trim() }));
  };

  for (const name of ['plan-home', 'qms-records']) {
    const shown = await show(name);
    assert.equal(shown.react, true, `${name} renders through React`);
    assert.ok(shown.text.length > 40, `${name} shows its content`);
    assert.deepEqual(errors, [], `${name} renders without page errors`);
  }

  const report = await show('trace-report', "traceQuery = 'FC-200-00001';");
  assert.equal(report.react, true);
  assert.doesNotMatch(report.text, /Search a serial or lot first/, 'the trace report receives the searched serial');
  assert.match(report.text, /FC-200-00001/);

  for (const name of ['wis', 'mnv-board', 'qms-config', 'support-log']) {
    const shown = await show(name);
    assert.equal(shown.react, false, `${name} stays on the legacy view in this build`);
  }
  const orderView = await show('order', 'selectedId = state.orders[0].id; tab = "operations"; selectedOp = null;');
  assert.equal(orderView.react, false, 'work order detail stays on the legacy view in this build');
  assert.deepEqual(errors, []);
  console.log('React screens UI: plan home, QMS records and trace report render correctly; WI, Maneuver details, QMS configuration, support log and work order detail stay legacy');
} finally {
  await browser.close();
}
