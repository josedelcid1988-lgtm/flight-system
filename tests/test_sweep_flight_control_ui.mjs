import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

// Flight Control sweep (browser): the page-side behavior changes in the claude/sweep-flight-control bundle.
// #410: the React order view opens the FAIR form the page selected ("Go to the FAIR" and the form tabs set it), not
//       always Form 1. Production still routes work order detail to the legacy view (TESTING.md), so "Go to the FAIR"
//       is also driven through the page's own renderer and must open the chosen form there.
// #197 and #196: the React and legacy QMS records views print the same calibration archive note, built once by the
//       engine, and the note says only work orders already moved to the server archive stop holding their entries.
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
  // The production path: the page renders the order through its own renderer, and "Go to the FAIR" picks the form.
  const viaPage = await page.evaluate(async () => {
    const o = state.orders.find(x => x.fair && Array.isArray(x.fair.chars));
    if (!o) return null;
    selectedId = o.id; view = 'order'; tab = 'quality'; render();
    const go = async k => {
      const b = document.createElement('button'); b.dataset.action = 'goto-fair'; b.dataset.fairPage = k; document.body.append(b); b.click(); b.remove();
      await new Promise(r => setTimeout(r, 100));
      const main = document.querySelector('#main');
      return { tab: main.querySelector('.fair-pages [role=tab][aria-selected="true"]')?.dataset.fairPage || null, visible: [...main.querySelectorAll('.fair-page')].filter(pg => !pg.hidden).map(pg => pg.id) };
    };
    return { three: await go('3'), sign: await go('sign'), one: await go('1') };
  });
  check('through the page renderer, Go to the FAIR opens Form 3', viaPage && viaPage.three.tab === '3' && JSON.stringify(viaPage.three.visible) === '["fair-page-3"]', JSON.stringify(viaPage));
  check('through the page renderer, Go to the FAIR opens Review and sign', viaPage && viaPage.sign.tab === 'sign' && JSON.stringify(viaPage.sign.visible) === '["fair-page-sign"]', JSON.stringify(viaPage));
  check('through the page renderer, Go to the FAIR returns to Form 1', viaPage && viaPage.one.tab === '1' && JSON.stringify(viaPage.one.visible) === '["fair-page-1"]', JSON.stringify(viaPage));
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
  check('the archive note says only an entry cited by archived work orders alone can move', /cited only by work orders already moved to the server archive can move; it keeps its signature and opens by its ID from the server archive/.test(note.react || ''), note.react);

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
console.log(`FAILS ${JSON.stringify(FAILS)}\n${checks} checks`);
if (FAILS.length) process.exit(1);
