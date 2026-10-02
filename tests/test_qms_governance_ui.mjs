import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const fixtureDir = process.env.FS_FIXTURES_DIR ? `file://${process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/')}` : new URL('./fixtures/', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: [
      { username: 'qa', displayName: 'Quinn Manager', salt: 'test', hash: 'unused', role: 'qm', createdAt: new Date().toISOString() },
      { username: 'engineer', displayName: 'Riley Engineer', salt: 'test', hash: 'unused', role: 'qe', createdAt: new Date().toISOString() }
    ] }));
    sessionStorage.setItem('skyryse-mes-session-v1', 'qa');
    sessionStorage.setItem('sk-boot-seen', '1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('publish.html', fixtureDir).href);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { view = 'qms-records'; render(); });
  await page.getByRole('heading', { name: 'AI governance' }).waitFor();
  assert.match(await page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'AI governance' }) }).innerText(), /Model adapter: Off/);
  await page.locator('[data-ai-model-config] [name=enabled]').selectOption('true');
  await page.locator('[data-ai-model-config] [name=provider]').fill('approved-model');
  await page.locator('[data-ai-model-config] [name=settingName]').fill('MODEL_API_KEY');
  await page.locator('[data-ai-model-config] [name=rationale]').fill('Approved configuration for test evidence.');
  await page.locator('[data-ai-model-config] button[type=submit]').click();
  await page.locator('[data-ai-model-error]').getByText(/server has not confirmed/i).waitFor();
  assert.equal(await page.evaluate(() => state.modelAdapter.enabled), false);
  const sourceNC = await page.evaluate(() => FlightManeuver.raiseNC(state, { title: 'Fit interference reported', description: 'Inspection recorded fit interference on the received part.', partNumber: 'PN-GOV-1', revision: 'A', sourceType: 'PO line', sourcePo: 'PO-GOV-1', sourceLine: '1', foundAt: 'Receiving inspection', quantity: 1, pedigree: 'Production' }));
  assert.equal(sourceNC.ok, true);
  await page.locator('[data-flight-skill-run] [name=skill]').selectOption('five-why');
  await page.locator('[data-flight-skill-run] [name=input]').fill(JSON.stringify({ targetRefs: [sourceNC.id] }));
  await page.locator('[data-flight-skill-run] [name=reason]').fill('Review the reported fit interference evidence.');
  await page.locator('[data-flight-skill-run] button[type=submit]').click();
  await page.getByText(/5-Why draft AID-0001 created/i).waitFor();
  // Codex review on #621: the run form hands the parsed object itself to MES.runSkill, so the engine measures it before
  // anything copies it; a flat input with 200,000 keys is refused with the budget message and no draft is added.
  { const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 200000 }, (_, i) => [`k${i}`, i])));
    await page.evaluate(text => {
      window.__watchedText = text; window.__parsedInput = null; window.__passedSame = null;
      const parse = JSON.parse; JSON.parse = function (t, ...rest) { const value = parse.call(this, t, ...rest); if (t === window.__watchedText) window.__parsedInput = value; return value; };
      const run = MES.runSkill; MES.runSkill = function (st, input, ...rest) { if (window.__parsedInput) window.__passedSame = input === window.__parsedInput; return run.call(this, st, input, ...rest); };
    }, wide);
    const draftsBefore = await page.evaluate(() => (state.aiSkillDrafts || []).length);
    await page.locator('[data-flight-skill-run] [name=input]').fill(wide);
    await page.locator('[data-flight-skill-run] [name=reason]').fill('A run input wider than the value budget.');
    await page.locator('[data-flight-skill-run] button[type=submit]').click();
    await page.locator('[data-flight-skill-error]').getByText(/Keep it under 50 KB/).waitFor();
    assert.equal(await page.evaluate(() => window.__passedSame), true, 'the form passes the parsed object itself, not a copy');
    assert.equal(await page.evaluate(() => (state.aiSkillDrafts || []).length), draftsBefore, 'no draft is added');
    await page.locator('[data-flight-skill-run] [name=input]').fill(''); }
  await page.locator('[data-flight-skill-review="AID-0001"]').click();
  await page.getByText(/AID-0001 reviewed/i).waitFor();
  await page.evaluate(() => { sessionStorage.setItem('skyryse-mes-session-v1', 'engineer'); window.dispatchEvent(new Event('sk-auth')); view='qms-records'; render(); });
  const blocked = await page.evaluate(() => MES.acceptSkillDraft(state, 'AID-0001', 'Attempt scaffold acceptance.'));
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /confirm\] scaffold/i);
  await page.evaluate(() => { sessionStorage.setItem('skyryse-mes-session-v1', 'qa'); window.dispatchEvent(new Event('sk-auth')); view='qms-records'; render(); });
  const download = page.waitForEvent('download');
  await page.locator('[data-ai-governance-export]').click();
  assert.match((await download).suggestedFilename(), /^flight-system-iso42001-/);
  assert.equal(await page.evaluate(() => MES.verifyAIActionLog(state).ok && MES.verifyManifests(state).ok), true);
  await page.evaluate(() => {
    sessionStorage.setItem('skyryse-mes-session-v1', 'engineer');
    window.dispatchEvent(new Event('sk-auth'));
    view = 'qms-records'; render();
  });
  await page.getByRole('heading', { name: 'AI governance' }).waitFor();
  assert.equal(await page.locator('[data-ai-model-config]').count(), 0);
  assert.equal(await page.locator('[data-flight-skill-trigger]').count(), 0);
  assert.equal(await page.locator('[data-ai-governance-export]').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('AI governance UI keeps the adapter off without server confirmation, verifies evidence downloads and hides configuration from non-QMS users.');
} finally { await browser.close(); }
