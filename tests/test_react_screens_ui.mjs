import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// The React screens routed in this build render without page errors and keep the behavior of the legacy views they
// replace. Views not yet ready for React (WI library and detail, Flight Maneuver record details) stay on legacy.
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

  for (const name of ['plan-home', 'qms-config', 'qms-records', 'support-log']) {
    const shown = await show(name);
    assert.equal(shown.react, true, `${name} renders through React`);
    assert.ok(shown.text.length > 40, `${name} shows its content`);
    assert.deepEqual(errors, [], `${name} renders without page errors`);
  }

  const report = await show('trace-report', "traceQuery = 'FC-200-00001';");
  assert.equal(report.react, true);
  assert.doesNotMatch(report.text, /Search a serial or lot first/, 'the trace report receives the searched serial');
  assert.match(report.text, /FC-200-00001/);

  // The revision selector is owned by the page; the React record tab follows it instead of snapping back.
  const orderId = await page.evaluate(() => (state.orders.find(order => MES.revisionEntries(order).length > 1) || {}).id || null);
  assert.ok(orderId, 'the fixture has a work order with more than one revision');
  await show('order', `selectedId = ${JSON.stringify(orderId)}; tab = 'record'; selectedOp = null;`);
  const select = page.locator('[data-rev-select]');
  await select.waitFor();
  const options = await select.locator('option').evaluateAll(list => list.map(option => option.value));
  assert.ok(options.length > 1);
  const chosen = options[options.length - 1];
  await select.selectOption(chosen);
  await page.waitForFunction(value => selectedRev === value, chosen);
  assert.equal(await page.locator('[data-rev-select]').inputValue(), chosen, 'the chosen revision stays selected after the page re-renders');

  for (const name of ['wis', 'mnv-board']) {
    const shown = await show(name);
    assert.equal(shown.react, false, `${name} stays on the legacy view in this build`);
  }
  assert.deepEqual(errors, []);
  console.log('React screens UI: plan home, QMS configuration and records, support log, trace report and work order revision render correctly; WI and Maneuver details stay legacy');
} finally {
  await browser.close();
}
