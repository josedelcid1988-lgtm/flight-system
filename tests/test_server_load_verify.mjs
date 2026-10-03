// A shared workspace whose signed content fails verification is not opened. The page recomputes every signature when it
// loads the workspace from the server, as the server does on every write, so a workspace accepted by an older verifier
// or restored with drifted signed content is refused instead of being shown, printed and cached on the device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const curated = () => JSON.parse(readFileSync(new URL('../tools/demo/seed-curated.json', import.meta.url), 'utf8'));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'load-verify-setup-code' });
const port = await server.listenAsync(0, '127.0.0.1');
let checks = 0;
const ok = (label, cond, detail = '') => { checks++; assert.ok(cond, `${label}${detail ? ` -> ${detail}` : ''}`); console.log(`  ok   ${label}`); };

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#sk-login').waitFor({ state: 'visible' });
  await page.locator('#sk-displayname').fill('Load Verify Admin');
  await page.locator('#sk-username').fill('load-verify-admin');
  await page.locator('#sk-password').fill('load-verify-password');
  await page.locator('#sk-confirm').fill('load-verify-password');
  await page.locator('#sk-setup').fill('load-verify-setup-code');
  await page.locator('#sk-login-submit').click();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'synced', null, { timeout: 30000 });

  // A shared workspace whose signatures all verify loads.
  const clean = server.host.MES.upgrade(curated());
  server.host.FlightManeuver.ensure(clean);
  ok('fixture: the curated workspace verifies on the server', server.host.MES.verifyManifests(clean).ok === true);
  const board = clean.maneuver.mrb.find(m => m.decision && m.decision.manifest);
  ok('fixture: the curated workspace holds a decided MRB board', !!board);
  server.store.putDoc('default', JSON.stringify(clean), undefined, 'load-verify');
  await page.reload();
  await page.waitForFunction(id => window.skServer?.sync?.status === 'synced' && typeof state !== 'undefined' && state.maneuver && state.maneuver.mrb.some(m => m.id === id), board.id, { timeout: 30000 });
  ok('a shared workspace whose signatures verify loads', await page.evaluate(id => state.maneuver.mrb.some(m => m.id === id), board.id));

  // The same workspace with a signed MRB decision edited after signing is refused, and nothing is cached on the device.
  const edited = structuredClone(clean);
  edited.maneuver.mrb.find(m => m.id === board.id).decision.note = 'Edited in the database after the decision.';
  server.store.putDoc('default', JSON.stringify(edited), undefined, 'load-verify');
  await page.reload();
  await page.waitForFunction(() => window.skServer?.sync?.status === 'error', null, { timeout: 30000 });
  const sync = await page.evaluate(() => window.skServer.sync.message);
  ok('a shared workspace with a broken signature is not opened, and the reason names the record', /fails verification at .*board decision/.test(sync), sync);
  const cached = await page.evaluate(id => { const raw = localStorage.getItem('skyryse-mes-work-order-v1'); const s = raw ? JSON.parse(raw) : null; const m = s && s.maneuver && s.maneuver.mrb.find(x => x.id === id); return m && m.decision ? m.decision.note : null; }, board.id);
  ok('the edited workspace is not cached on the device', cached !== 'Edited in the database after the decision.', String(cached));
  assert.deepEqual(errors, []);
  await page.close();
  console.log(`server load verify: ${checks} checks passed`);
} finally {
  await browser.close();
  server.close?.();
}
