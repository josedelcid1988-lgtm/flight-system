import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Flight Control sweep (browser): the page-side behavior changes in the claude/sweep-flight-control bundle.
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
    localStorage.setItem('skyryse-mes-demo-auth-v1', JSON.stringify({ users: [{ username: 'admin', displayName: 'Flight Master', salt: 'test', hash: 'unused', role: 'admin', createdAt: new Date().toISOString() }] }));
    sessionStorage.setItem('skyryse-mes-demo-session-v1', 'admin');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.goto(fixture);
  await page.waitForFunction(() => window.__ready === true);

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
