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
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
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

  // #35 review: System QMS records renders through React, so the calibration log and its record form must be in the
  // React view, not only in the legacy markup it replaces. A QA Manager records a calibration from that screen.
  await show('qms-records');
  const island = page.locator('#main #flight-react-island');
  const calForm = island.locator('form[data-qms-record="calibration"]');
  assert.equal(await calForm.count(), 1, 'the React QMS records view has the calibration record form');
  assert.deepEqual(await calForm.locator('[name]').evaluateAll(els => els.map(e => e.name)), ['tag', 'description', 'torque', 'serial', 'calibratedAt', 'expires', 'status', 'location', 'note'], 'the React calibration form carries every field the engine records');
  assert.match(await island.innerText(), /record it as Retired/, 'the React calibration panel says Retired is how a tool leaves service');
  const calToday = await page.evaluate(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
  const [calY, calM, calD] = calToday.split('-').map(Number), calDue = `${calY + 1}-${String(calM).padStart(2, '0')}-${String(calD).padStart(2, '0')}`;
  await calForm.locator('[name="tag"]').fill('UI-CAL-01');
  await calForm.locator('[name="description"]').fill('DIGITAL CALIPER');
  await calForm.locator('[name="torque"]').selectOption('no');
  await calForm.locator('[name="calibratedAt"]').fill(calToday);
  await calForm.locator('[name="expires"]').fill(calDue);
  await calForm.locator('[name="note"]').fill('Lab cert 12');
  await calForm.locator('button[type="submit"]').click();
  await page.waitForFunction(() => (state.calibrationLog || []).some(e => e.tag === 'UI-CAL-01'));
  assert.match(await page.locator('#main #flight-react-island').innerText(), /UI-CAL-01 · DIGITAL CALIPER · due/, 'the recorded calibration is listed in the React calibration log');
  assert.deepEqual(errors, [], 'recording a calibration from the React view raises no page errors');
  // #35 review (Codex 4133296954): the current entry for each tag has a correction form that appends a signed
  // correction through MES.updateCalibration; superseded entries do not offer one.
  const calId = await page.evaluate(() => state.calibrationLog.find(e => e.tag === 'UI-CAL-01').id);
  const fixForm = page.locator(`#main #flight-react-island form[data-qms-calibration-correct="${calId}"]`);
  assert.equal(await fixForm.count(), 1, 'the current calibration entry has a correction form in the React view');
  await fixForm.locator('xpath=ancestor::details').locator('summary').click();
  assert.equal(await fixForm.locator('[name="description"]').inputValue(), 'DIGITAL CALIPER', 'the correction form starts from the current entry');
  await fixForm.locator('[name="status"]').selectOption('Quarantined');
  await fixForm.locator('[name="note"]').fill('Failed daily check');
  await fixForm.locator('button[type="submit"]').click();
  await page.waitForFunction(id => (state.calibrationLog || []).some(e => e.supersedes === id), calId);
  const fixed = await page.evaluate(id => { const e = state.calibrationLog.find(x => x.supersedes === id); return { status: e.status, note: e.note, current: MES.calibrationStatus(state, 'UI-CAL-01').id === e.id }; }, calId);
  assert.deepEqual(fixed, { status: 'Quarantined', note: 'Failed daily check', current: true }, 'the correction is appended as the current entry');
  assert.equal(await page.locator(`#main #flight-react-island form[data-qms-calibration-correct="${calId}"]`).count(), 0, 'the superseded entry no longer offers a correction form');
  assert.deepEqual(errors, [], 'correcting a calibration from the React view raises no page errors');
  // #120: the date fields are optional in the form, so a tool that was never calibrated can be retired with both dates
  // blank. The engine still refuses blank dates on every other status.
  const undatedForm = page.locator('#main #flight-react-island form[data-qms-record="calibration"]');
  assert.deepEqual(await undatedForm.locator('[name="calibratedAt"], [name="expires"]').evaluateAll(els => els.map(e => e.required)), [false, false], 'the calibration dates are not browser-required, so a Retired entry can leave them blank');
  assert.match(await island.innerText(), /leaves them blank/, 'the React calibration panel says when the dates may be blank');
  await undatedForm.locator('[name="tag"]').fill('SR0077');
  await undatedForm.locator('[name="description"]').fill('LOAD CELL');
  await undatedForm.locator('[name="torque"]').selectOption('no');
  await undatedForm.locator('[name="status"]').selectOption('Retired');
  await undatedForm.locator('[name="note"]').fill('Never calibrated; scrapped');
  await undatedForm.locator('button[type="submit"]').click();
  await page.waitForFunction(() => (state.calibrationLog || []).some(e => e.tag === 'SR0077'));
  assert.deepEqual(await page.evaluate(() => { const e = state.calibrationLog.find(x => x.tag === 'SR0077'); return { status: e.status, calibratedAt: e.calibratedAt, expires: e.expires, valid: MES.validate(state) }; }), { status: 'Retired', calibratedAt: '', expires: '', valid: true }, 'the undated Retired entry is recorded and the workspace validates');
  assert.match(await page.locator('#main #flight-react-island').innerText(), /SR0077 · LOAD CELL · no calibration dates/, 'the React log shows an undated Retired entry without a due date');
  assert.deepEqual(errors, [], 'retiring a never-calibrated tool from the React view raises no page errors');

  const report = await show('trace-report', "traceQuery = 'FC-200-00001';");
  assert.equal(report.react, true);
  assert.doesNotMatch(report.text, /Search a serial or lot first/, 'the trace report receives the searched serial');
  assert.match(report.text, /FC-200-00001/);
  assert.match(report.text, /\d{1,2}:\d{2}\s?[AP]M/, 'buy-off and event times keep the hour and minute, as the legacy report did');

  for (const name of ['wis', 'mnv-board', 'qms-config', 'support-log']) {
    const shown = await show(name);
    assert.equal(shown.react, false, `${name} stays on the legacy view in this build`);
  }
  // The Flight Maneuver detail views stay on legacy, but their React version is bundled and reads its formatting helpers
  // from window.FlightManeuverUI.helpers. Rendered directly, each one renders without page errors, so routing them to
  // React later cannot crash on a missing export.
  const helpers = await page.evaluate(() => Object.fromEntries(['dt', 'historyList', 'mrbProposalNote'].map(k => [k, typeof window.FlightManeuverUI.helpers?.[k]])));
  assert.deepEqual(helpers, { dt: 'function', historyList: 'function', mrbProposalNote: 'function' }, 'Flight Maneuver exports the helpers its React detail views use');
  for (const name of ['mnv-board', 'mnv-nc', 'mnv-pfmea', 'mnv-pfmea-detail', 'mnv-changes', 'mnv-metrics', 'mnv-feedback']) {
    const before = errors.length;
    const thrown = await page.evaluate(async next => {
      const host = document.createElement('div'); host.hidden = true; document.body.appendChild(host);
      try { window.FlightReact.renderManeuverDetail(host, state, MES, window.FlightManeuver, window.FlightManeuverUI.sel, skCan, window.FlightManeuverUI.helpers, next); await new Promise(done => setTimeout(done, 50)); return null; }
      catch (error) { return error.message; }
      finally { window.FlightReact.unmount?.(); host.remove(); }
    }, name);
    assert.equal(thrown, null, `${name}: the React detail view renders without throwing`);
    assert.deepEqual(errors.slice(before), [], `${name}: the React detail view renders without page errors`);
  }
  // With a record open, each detail view shows its history as a real disclosure list, never as escaped markup text.
  const opened = await page.evaluate(async () => {
    const FM = window.FlightManeuver, out = {};
    const ids = { board: FM.list(state, 'mrb')[0]?.id, nc: FM.list(state, 'ncs')[0]?.id, pfmea: FM.list(state, 'pfmeas')[0]?.id };
    for (const [next, key] of [['mnv-board', 'board'], ['mnv-nc', 'nc'], ['mnv-pfmea-detail', 'pfmea']]) {
      const host = document.createElement('div'); host.hidden = true; document.body.appendChild(host);
      try {
        window.FlightReact.renderManeuverDetail(host, state, MES, FM, { ...window.FlightManeuverUI.sel, [key]: ids[key] }, skCan, window.FlightManeuverUI.helpers, next);
        await new Promise(done => setTimeout(done, 50));
        out[next] = { id: ids[key], history: !!host.querySelector('details.resolve-details ol.mnv-history'), escaped: /<details|<ol|<li/.test(host.textContent) };
      } finally { window.FlightReact.unmount?.(); host.remove(); }
    }
    return out;
  });
  for (const [name, shown] of Object.entries(opened)) {
    assert.ok(shown.id, `${name}: the fixture has a record to open`);
    assert.deepEqual({ history: shown.history, escaped: shown.escaped }, { history: true, escaped: false }, `${name}: the record history renders as a list, not escaped markup`);
  }
  assert.deepEqual(errors, []);
  await show('home');
  const orderView = await show('order', 'selectedId = state.orders[0].id; tab = "operations"; selectedOp = null;');
  assert.equal(orderView.react, false, 'work order detail stays on the legacy view in this build');
  assert.deepEqual(errors, []);

  // At phone width the header Help button is hidden, so React screens keep the page footer and its Help button.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['home', 'plan-home']) {
    await show(name);
    const helpButton = page.locator('#main .app-footer [data-action="help"]');
    await helpButton.scrollIntoViewIfNeeded();
    assert.equal(await helpButton.isVisible(), true, `${name} shows Help on a phone`);
    await helpButton.click();
    await page.waitForFunction(() => document.querySelector('#dialog')?.open && /Using Flight System/.test(document.querySelector('#dialog-title')?.textContent || ''));
    await page.evaluate(() => document.querySelector('#dialog').close());
  }
  assert.deepEqual(errors, []);
  console.log('React screens UI: plan home, QMS records and trace report render correctly; WI, Maneuver details, QMS configuration, support log and work order detail stay legacy; Help is reachable on a phone');
} finally {
  await browser.close();
}
