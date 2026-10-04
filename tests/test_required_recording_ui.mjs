// Issue #541: an operation that requires a recording shows the evidence section on any work order, not only on
// Installation orders, so it can be recorded or uploaded, reviewed and then bought off. On other orders the section
// says Operation evidence and the dialogs name the order's own pedigree and subcategory. Buy-off without a saved,
// reviewed recording is still refused. Runs on the demo seed's WO-10009 (subcategory Mfg.), Op 030.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const FIXTURES = process.env.FS_FIXTURES_DIR ? 'file://' + process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : new URL('./fixtures/', import.meta.url).href;
const ORDER = 'WO-10009', OP = 'op-030';
// WO-10009 is not an Installation order, so the refusal says "a recording", matching the Operation evidence heading.
// The stamp prompt checks the buy-off prerequisites first (#334) and refuses inside the prompt with its own wording;
// the operation form's refusal is kept for a buy-off that reaches it.
const REFUSAL = /^(Save and review a recording before buying off this operation\.|Not ready to buy off\. Attach and review the operation recording\.)$/;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];

// Signs in to the demo fixture and brings WO-10009 to Building with Op 030 current, through the engine's own
// release, kitting and buy-off paths, then opens Op 030 with every step checked.
async function openOperation() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(FIXTURES + 'demo_publish.html');
  await page.locator('input[name=username]').fill('demo');
  await page.locator('input[name=password]').fill('demo1234');
  await page.locator('#sk-boot form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => !document.getElementById('sk-boot'));
  const setup = await page.evaluate(({ id, opId }) => {
    const refused = [], check = (what, result) => { if (!result.ok) refused.push(`${what}: ${result.message}`); };
    const start = MES.getOrder(state, id);
    const before = { subcategory: start.subcategory, requiresRecording: start.operations.find(op => op.id === opId).requiresRecording };
    check('release', MES.approveRelease(state, id));
    for (const m of MES.getOrder(state, id).materials) {
      check('lot', MES.setMaterialLot(state, id, m.id, MES.availableLots(m.partNumber, start.pedigree)[0]?.lot));
      check('material', MES.setMaterial(state, id, m.id, true));
    }
    check('kit list', MES.addKitFile(state, id, { name: 'kit-list.csv', type: 'text/csv', size: 10 }));
    check('advance', MES.advance(state, id));
    const order = MES.getOrder(state, id), now = new Date().toISOString();
    for (const op of order.operations.slice(0, order.operations.findIndex(op => op.id === opId))) {
      op.steps.forEach(step => check('step', MES.setStepCheck(state, id, op.id, step.id, true, {})));
      check(op.id, MES.completeOperation(state, id, op.id, 'Required recording test setup', { noTools: true }));
    }
    const torqueTool = MES.CAL_TOOLS.map(tool => MES.toolCheck(tool.tag, now, state)).find(c => c.ok && MES.isTorqueTool(c.tool));
    const op = order.operations.find(op => op.id === opId);
    op.steps.forEach(step => check('step', MES.setStepCheck(state, id, opId, step.id, true, step.recordsTorque ? { tool: torqueTool?.tool.tag, value: 12, unit: MES.TORQUE_UNITS[0] } : {})));
    if (!save()) refused.push('save');
    view = 'order'; selectedId = id; selectedOp = opId; tab = 'operations'; render();
    return { before, refused, status: order.status, current: order.operations.find(item => !item.done)?.id };
  }, { id: ORDER, opId: OP });
  assert.deepEqual(setup.refused, [], 'the setup goes through the engine without a refusal');
  assert.equal(setup.before.subcategory, 'Mfg.', 'WO-10009 is not an Installation work order');
  assert.equal(setup.before.requiresRecording, true, 'Op 030 requires a recording');
  assert.equal(setup.status, 'Building');
  assert.equal(setup.current, OP, 'Op 030 is the current operation');
  return { context, page };
}

// A short real WebM made in the page, so the upload goes through the same video check as a user's file.
async function webmClip(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 120 }), g = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' }), chunks = [];
    recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
    let frame = 0; const timer = setInterval(() => { g.fillStyle = frame++ % 2 ? '#24634e' : '#a63724'; g.fillRect(0, 0, 160, 120); }, 60);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(100); await new Promise(resolve => setTimeout(resolve, 900)); recorder.stop(); await stopped; clearInterval(timer);
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let text = ''; bytes.forEach(byte => { text += String.fromCharCode(byte); }); return btoa(text);
  });
  return { name: 'op-030-assembly.webm', mimeType: 'video/webm', buffer: Buffer.from(base64, 'base64') };
}

async function attemptBuyoff(page) {
  await page.locator('#operation-form .task-actions [data-action="buyoff-now"]').click();
  await page.locator('#step-stamp-form').waitFor({ state: 'attached' });
  await page.evaluate(() => { const form = document.getElementById('step-stamp-form'); if (form.elements.stampNumber) form.elements.stampNumber.value = 'DEMO'; form.requestSubmit(); });
  const errorText = () => (document.getElementById('step-stamp-error')?.textContent || '').trim() || (document.getElementById('operation-error')?.textContent || '').trim();
  await page.waitForFunction(({ id, opId, read }) => MES.getOrder(state, id).operations.find(op => op.id === opId).done || new Function('return (' + read + ')()')(), { id: ORDER, opId: OP, read: errorText.toString() });
  const result = await page.evaluate(({ id, opId, read }) => ({ done: MES.getOrder(state, id).operations.find(op => op.id === opId).done, error: new Function('return (' + read + ')()')() }), { id: ORDER, opId: OP, read: errorText.toString() });
  // A refusal leaves the prompt open with the stamp number kept; close it before the next step.
  if (!result.done) { await page.evaluate(() => document.querySelector('dialog[open] [data-action="close-dialog"]')?.click()); await page.locator('#step-stamp-form').waitFor({ state: 'detached' }).catch(() => {}); }
  return result;
}

async function uploadClip(page) {
  await page.locator('#evidence-file').setInputFiles(await webmClip(page));
  await page.locator('#save-media:not([disabled])').waitFor();
  // The dialog names this order's own pedigree and subcategory, not a fixed Development / Installation line.
  assert.equal(await page.locator('#dialog-title').textContent(), 'Link operation recording');
  assert.match(await page.locator('#dialog .media-context').textContent(), /Development \/ Mfg\. · Record assembly completion/);
  assert.doesNotMatch(await page.locator('#dialog').textContent(), /Development \/ Installation/);
  await page.locator('#media-description').fill('Assembly completed per WI; witness marks applied and visible.');
  await page.locator('#save-media').click();
  await page.waitForFunction(({ id, opId }) => MES.getOrder(state, id).operations.find(op => op.id === opId).evidence.length === 1, { id: ORDER, opId: OP });
  await page.locator('#dialog').waitFor({ state: 'hidden' });
}

try {
  // Case 1: the section shows on a non-Installation order, and buy-off is refused with no clip and with an unreviewed clip.
  {
    const { context, page } = await openOperation();
    const section = page.locator('section.installation-evidence');
    await section.waitFor();
    assert.equal(await section.locator('#media-heading').textContent(), 'Operation evidence', 'a non-Installation order says Operation evidence');
    assert.match(await section.textContent(), /Recording required/, 'the section says a recording is required');
    assert.match(await section.textContent(), /Buy-off needs at least one saved, reviewed recording\./);
    assert.equal(await section.locator('[data-action="record-media"]').isVisible(), true, 'Record video is offered');
    assert.equal(await section.locator('[data-action="upload-media"]').isVisible(), true, 'Upload recording is offered');

    let attempt = await attemptBuyoff(page);
    assert.equal(attempt.done, false, 'buy-off with no recording is refused');
    assert.match(attempt.error, REFUSAL, 'the refusal says what to do next');

    await uploadClip(page);
    assert.match(await section.textContent(), /Awaiting review/, 'the saved clip waits for review');
    attempt = await attemptBuyoff(page);
    assert.equal(attempt.done, false, 'buy-off with a saved but unreviewed recording is refused');
    assert.match(attempt.error, REFUSAL);
    const engine = await page.evaluate(({ id, opId }) => { const copy = structuredClone(state); return MES.completeOperation(copy, id, opId, 'Engine refusal check', {}); }, { id: ORDER, opId: OP });
    assert.equal(engine.ok, false, 'the engine also refuses the buy-off without a reviewed recording');
    assert.equal(engine.message, 'Attach and review at least one video before this operation can be bought off.');
    assert.equal(await page.evaluate(({ id, opId }) => MES.getOrder(state, id).operations.find(op => op.id === opId).buyoff ?? null, { id: ORDER, opId: OP }), null, 'no buy-off record is written');
    await context.close();
  }

  // Case 2: upload, review, then buy off. The buy-off record carries the reviewed clip.
  {
    const { context, page } = await openOperation();
    await uploadClip(page);
    await page.locator('section.installation-evidence [data-action="review-media"]').click();
    await page.locator('#confirm-media-review:not([disabled])').waitFor();
    assert.equal(await page.locator('#dialog-title').textContent(), 'Review operation evidence');
    assert.match(await page.locator('#dialog .media-context').textContent(), /Development \/ Mfg\./);
    await page.locator('#media-review-form input[name=acknowledge]').check();
    await page.locator('#confirm-media-review').click();
    await page.waitForFunction(({ id, opId }) => MES.getOrder(state, id).operations.find(op => op.id === opId).evidence[0].reviewedAt, { id: ORDER, opId: OP });
    await page.locator('#dialog').waitFor({ state: 'hidden' });
    assert.match(await page.locator('section.installation-evidence').textContent(), /Reviewed/);

    const attempt = await attemptBuyoff(page);
    assert.equal(attempt.done, true, `buy-off succeeds once a recording is reviewed: ${attempt.error}`);
    const record = await page.evaluate(({ id, opId }) => {
      const op = MES.getOrder(state, id).operations.find(op => op.id === opId), b = op.buyoff || {};
      return { evidence: op.evidence.map(e => ({ id: e.id, reviewed: !!e.reviewedAt })), buyoff: b, valid: MES.validate(state) };
    }, { id: ORDER, opId: OP });
    assert.equal(record.evidence.length, 1);
    assert.equal(record.evidence[0].reviewed, true);
    const b = record.buyoff;
    assert.equal(Boolean(b.name && b.credentialId && b.at), true, 'the buy-off records the person, credential and time');
    assert.match(JSON.stringify(b.manifest || {}), /[0-9a-f]{64}/, 'the buy-off carries a SHA-256 signature manifest');
    assert.deepEqual(b.evidenceIds, [record.evidence[0].id], 'the buy-off names the reviewed clip');
    assert.equal(record.valid, true, 'the workspace is valid after the buy-off');
    await page.evaluate(opId => { selectedOp = opId; render(); }, OP);
    assert.match(await page.locator('section.installation-evidence').textContent(), /Evidence is locked after buy-off\./, 'the section stays visible and locked after buy-off');
    await context.close();
  }

  // A Technician (operate-steps, not operate) sees both ways to add the required recording, on the demo's real
  // tech pilot account, which keeps its production role.
  {
    const { context, page } = await openOperation();
    const switched = await page.evaluate(async opId => {
      const result = await window.skAuth.switchAccount('tech', 'demo1234');
      selectedOp = opId; render();
      return { ok: result.ok, role: document.body.dataset.role, operate: document.body.getAttribute('data-can-operate'), steps: document.body.getAttribute('data-can-operate-steps') };
    }, OP);
    assert.deepEqual(switched, { ok: true, role: 'technician', operate: 'no', steps: 'yes' }, 'the tech account is a Technician with operate-steps and without operate');
    const section = page.locator('section.installation-evidence');
    await section.waitFor();
    assert.equal(await section.locator('[data-action="record-media"]').isVisible(), true, 'a Technician sees Record video');
    assert.equal(await section.locator('[data-action="upload-media"]').isVisible(), true, 'a Technician sees Upload recording');
    await context.close();
  }

  // A Quality inspector (inspect-steps, not operate-steps) adds the recording on an inspection operation, which it
  // buys off, and is told who adds it on a Technician operation. Uses the demo's real quality pilot account.
  {
    const { context, page } = await openOperation();
    const quality = await page.evaluate(async ({ id, opId }) => {
      const result = await window.skAuth.switchAccount('quality', 'demo1234');
      selectedOp = opId; render();
      const o = MES.getOrder(state, id), technicianOp = o.operations.find(op => op.id === opId);
      const section = document.querySelector('section.installation-evidence');
      // Unsaved copy with the earlier operations done and the next inspection operation requiring a recording.
      const copy = structuredClone(o), at = copy.operations.findIndex(op => MES.isInspectionOp(op));
      copy.operations.forEach((op, i) => { if (i < at) op.done = true; });
      const inspection = copy.operations[at]; inspection.requiresRecording = true;
      const box = document.createElement('div'); box.innerHTML = renderMediaEvidence(copy, inspection);
      return {
        ok: result.ok, role: document.body.dataset.role,
        steps: document.body.getAttribute('data-can-operate-steps'), inspect: document.body.getAttribute('data-can-inspect-steps'),
        technicianOp: { allowed: mediaCaptureAllowed(technicianOp), record: !!section?.querySelector('[data-action="record-media"]'), upload: !!section?.querySelector('[data-action="upload-media"]'), text: section?.textContent || '' },
        inspectionOp: { found: at >= 0, allowed: mediaCaptureAllowed(inspection), record: !!box.querySelector('[data-action="record-media"]'), upload: !!box.querySelector('[data-action="upload-media"]'), text: box.textContent }
      };
    }, { id: ORDER, opId: OP });
    assert.deepEqual([quality.ok, quality.role, quality.steps, quality.inspect], [true, 'qe', 'no', 'yes'], 'the quality account holds inspect-steps and not operate-steps');
    assert.deepEqual([quality.technicianOp.allowed, quality.technicianOp.record, quality.technicianOp.upload], [false, false, false], 'Quality cannot add a recording to a Technician operation');
    assert.match(quality.technicianOp.text, /Your role cannot add a recording to this operation\. A Technician working this operation adds it\./);
    assert.equal(quality.inspectionOp.found, true, 'WO-10009 carries an inspection operation');
    assert.deepEqual([quality.inspectionOp.allowed, quality.inspectionOp.record, quality.inspectionOp.upload], [true, true, true], 'Quality adds the recording on an inspection operation');
    assert.doesNotMatch(quality.inspectionOp.text, /Your role cannot add a recording/);
    // The dialog refuses too, not only the hidden buttons.
    const refused = await page.evaluate(opId => { mediaEditor(opId, 'upload'); return document.getElementById('dialog').open; }, OP);
    assert.equal(refused, false, 'the recording dialog does not open for a role that cannot add a recording');
    await context.close();
  }

  // Installation orders keep the Installation wording, with their own pedigree in the dialog context.
  {
    const { context, page } = await openOperation();
    // The small demo seed has no Installation order, so render an unsaved copy of WO-10009 marked Installation.
    const installation = await page.evaluate(id => {
      const o = { ...structuredClone(MES.getOrder(state, id)), subcategory: 'Installation' };
      const op = o.operations.find(item => !item.done), box = document.createElement('div');
      box.innerHTML = renderMediaEvidence(o, op) || '';
      return { pedigree: o.pedigree, heading: box.querySelector('#media-heading')?.textContent, context: mediaContext(o, op).replace(/<[^>]+>/g, ' ') };
    }, ORDER);
    assert.equal(installation.heading, 'Installation evidence');
    assert.match(installation.context, new RegExp(`${installation.pedigree} / Installation · `));
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log('required recording UI: the section shows on a non-Installation order; buy-off needs a reviewed recording');
  console.log('errors', JSON.stringify(errors), 'FAILS []');
} finally {
  await browser.close();
}
