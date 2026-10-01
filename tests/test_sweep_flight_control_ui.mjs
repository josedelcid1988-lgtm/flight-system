import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

// Flight Control sweep (browser): the page-side behavior changes in the claude/sweep-flight-control bundle.
// #477: the conformity package print labels the DAR line "DAR review (not yet signed)" until the DAR approves, so a
//       review date cannot be read as a signature date; after approval the line is the signature, as before.
// #410: the React order view opens the FAIR form the page selected ("Go to the FAIR" and the form tabs set it), not
//       always Form 1.
// #197 and #196: the React and legacy QMS records views print the same calibration archive note, built once by the
//       engine, and the note does not claim a closed work order's buy-off holds an entry in the live log.
const fixture = new URL('./fixtures/demo_publish.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let checks = 0;
const FAILS = [];
const check = (name, ok, detail = '') => { checks += 1; if (!ok) FAILS.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`${ok ? 'ok' : 'FAIL'} ${name}`); };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);

  // ---- #477 ------------------------------------------------------------------------------------------------------
  const dar = await page.evaluate(() => {
    const o = state.orders.find(x => Array.isArray(x.conformity) && x.conformity.length);
    if (!o) return null;
    const rows = p => { const doc = new DOMParser().parseFromString(confCoverHtml(o, p), 'text/html'); return [...doc.querySelectorAll('table')[0].querySelectorAll('tr')].map(tr => [tr.querySelector('th')?.textContent || '', tr.querySelector('td')?.textContent || '']); };
    const base = structuredClone(o.conformity[0]);
    const unsigned = { ...base, darName: 'Dana Reviewer', darDate: '2026-09-30' }; delete unsigned.darApproval;
    const empty = { ...base, darName: '', darDate: '' }; delete empty.darApproval;
    const signed = { ...base, darName: 'Dana Reviewer', darDate: '2026-09-30', darApproval: { name: 'Dana Reviewer', designation: 'DAR-F-1234', date: '2026-10-01' } };
    return { unsigned: rows(unsigned), empty: rows(empty), signed: rows(signed) };
  });
  check('the fixture has an order with a conformity package', !!dar);
  if (dar) {
    const find = (list, label) => list.find(r => r[0] === label);
    check('before DAR approval the line is labeled as a review, not yet signed', !!find(dar.unsigned, 'DAR review (not yet signed)') && !find(dar.unsigned, 'DAR'), JSON.stringify(dar.unsigned));
    check('the unsigned line shows the reviewer and review date', find(dar.unsigned, 'DAR review (not yet signed)')?.[1] === 'Dana Reviewer · 2026-09-30', JSON.stringify(find(dar.unsigned, 'DAR review (not yet signed)')));
    check('with no review recorded the unsigned line says so', find(dar.empty, 'DAR review (not yet signed)')?.[1] === 'Not recorded', JSON.stringify(find(dar.empty, 'DAR review (not yet signed)')));
    check('after DAR approval the line is the signature under DAR', find(dar.signed, 'DAR')?.[1] === 'Dana Reviewer (DAR-F-1234) · 2026-10-01' && !find(dar.signed, 'DAR review (not yet signed)'), JSON.stringify(dar.signed));
  }

  // ---- #410 ------------------------------------------------------------------------------------------------------
  const fair = await page.evaluate(() => {
    const o = state.orders.find(x => x.fair && Array.isArray(x.fair.chars));
    if (!o) return null;
    const host = document.createElement('div'); host.hidden = true; document.body.append(host);
    const shown = () => ({ tab: host.querySelector('.fair-pages [role=tab][aria-selected="true"]')?.dataset.fairPage || null, visible: [...host.querySelectorAll('.fair-page')].filter(pg => !pg.hidden).map(pg => pg.id) });
    try {
      window.FlightReact.renderOrder(host, state, MES, o, 'quality', null, skCan, null, '3');
      const three = shown();
      window.FlightReact.renderOrder(host, state, MES, o, 'quality', null, skCan, null, 'sign');
      const sign = shown();
      window.FlightReact.renderOrder(host, state, MES, o, 'quality', null, skCan, null, '1');
      const one = shown();
      return { three, sign, one };
    } finally { window.FlightReact.unmount(); host.remove(); }
  });
  check('the fixture has an order with a FAIR', !!fair);
  if (fair) {
    check('the React order view opens Form 3 when the page selected it', fair.three.tab === '3' && JSON.stringify(fair.three.visible) === '["fair-page-3"]', JSON.stringify(fair.three));
    check('the React order view opens Review and sign when the page selected it', fair.sign.tab === 'sign' && JSON.stringify(fair.sign.visible) === '["fair-page-sign"]', JSON.stringify(fair.sign));
    check('the React order view returns to Form 1 when the page selects it', fair.one.tab === '1' && JSON.stringify(fair.one.visible) === '["fair-page-1"]', JSON.stringify(fair.one));
  }
  const routed = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes("window.FlightReact.renderOrder($('#flight-react-island'),state,MES,_ord,tab,selectedOp,skCan,selectedRev,fairPage)");
  check('the page passes its selected FAIR form to the React order view', routed);

  // ---- #197 and #196 ---------------------------------------------------------------------------------------------
  const note = await page.evaluate(() => {
    const prior = Object.getOwnPropertyDescriptor(window, 'flightServerHost');
    window.flightServerHost = true; // the archive block shows only where the shared server keeps archived entries
    const legacy = document.createElement('div'), react = document.createElement('div');
    legacy.hidden = react.hidden = true; document.body.append(legacy, react);
    try {
      legacy.innerHTML = renderQmsRecords();
      window.FlightReact.renderQmsRecords(react, state, MES);
      const text = el => el.querySelector('.calibration-archive p')?.textContent ?? null;
      return { legacy: text(legacy), react: text(react), engine: MES.calibrationCapacity(state).archiveNote };
    } finally {
      window.FlightReact.unmount(); legacy.remove(); react.remove();
      if (prior) Object.defineProperty(window, 'flightServerHost', prior); else delete window.flightServerHost;
    }
  });
  check('both QMS records views show the calibration archive note', !!note.legacy && !!note.react, JSON.stringify(note));
  check('the React and legacy views print the same archive note, the one the engine builds', note.legacy === note.react && note.react === note.engine, JSON.stringify(note));
  check('the archive note says a closed work order entry opens from the server archive', /closed work order can move; it keeps its signature and opens by its ID from the server archive/.test(note.react || ''), note.react);

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
console.log(`FAILS ${JSON.stringify(FAILS)}\n${checks} checks`);
if (FAILS.length) process.exit(1);
