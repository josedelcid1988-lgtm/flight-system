import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const fixtureDir = process.env.FS_FIXTURES_DIR || new URL('./fixtures/', import.meta.url).pathname;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(`${fixtureDir.replace(/\/?$/, '/') }demo_qa150_publish.html`).href);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const user = document.querySelector('#sk-boot input[name=username]');
    const form = user.closest('form');
    for (const [element, value] of [[user, 'master'], [form.querySelector('input[type=password]'), 'demo1234']]) {
      element.value = value; element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { view = 'qms-config'; render(); });
  assert.equal(await page.locator('form[data-operation-register="source"]').count(), 1, 'QA Manager can open source-inspection configuration');
  assert.equal(await page.locator('form[data-mrb-training-tiers]').count(), 1, 'QA Manager can open the optional MRB training tier settings');
  assert.equal(await page.locator('[data-disposition="Use as is"]').inputValue(), '', 'MRB training tiers start Off');
  await page.locator('[data-qms-add="source"]').click();
  const row = page.locator('form[data-operation-register="source"] .source-code-row').last();
  await row.locator('[name=code]').fill('SKY');
  await row.locator('[name=name]').fill('Skyryse Source Inspection');
  await row.locator('[name=leadDays]').fill('1');
  await row.locator('[name=notificationText]').fill('Notify the Skyryse source inspector.');
  const sourceForm = page.locator('form[data-operation-register="source"]');
  await sourceForm.locator('[name=rationale]').fill('Add the internal source inspection authority.');
  await sourceForm.getByRole('button', { name: 'Save source inspection register' }).click();
  await page.waitForFunction(() => MES.sourceInspectionCodes(state).some(item => item.code === 'SKY'));
  assert.equal(await page.getByText('Add the internal source inspection authority.').count(), 1, 'configuration rationale appears in history');
  await page.evaluate(() => {
    const wi = state.masterWIs.find(item => item.status === 'Draft');
    if (!wi) throw new Error('No draft master WI is available for the Test baseline editor check.');
    selectedWI = { id: wi.id, revision: wi.revision }; view = 'wi'; render();
  });
  const classification = page.locator('[data-wi-op] [name=classification]').first();
  await classification.selectOption({ label: 'Test' });
  const subcode = page.locator('[data-wi-op] [name=operationSubcode]').first();
  await subcode.selectOption('HIL');
  const baseline = page.locator('[data-wi-atp-baseline]').first();
  assert.equal(await baseline.isVisible(), true, 'HIL exposes the approved baseline fields in a master WI');
  assert.equal(await baseline.locator('[name=atpRepo]').getAttribute('required'), '', 'the Test repository field is required');
  await classification.selectOption({ label: 'Inspection' });
  const standardTitle = page.locator('[data-wi-op] [data-wi-step] [name=stepTitle]').first();
  const standardInstruction = page.locator('[data-wi-op] [data-wi-step] [name=instruction]').first();
  assert.equal(await standardTitle.inputValue(), 'Standard inspection', 'Inspection starts with the standard Step A');
  assert.notEqual(await standardTitle.getAttribute('readonly'), null, 'Step A title is read-only in the WI editor');
  assert.notEqual(await standardInstruction.getAttribute('readonly'), null, 'Step A instruction is read-only in the WI editor');
  assert.equal(await page.locator('[data-action=wi-step-remove][data-step="0"]').first().isDisabled(), true, 'Step A cannot be removed in the WI editor');
  assert.equal(await page.locator('[data-action=wi-step-move][data-step="0"][data-dir="1"]').first().isDisabled(), true, 'Step A cannot be moved in the WI editor');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log('source inspection UI: register entry, rationale audit, and no browser errors passed');
} finally { await browser.close(); }
