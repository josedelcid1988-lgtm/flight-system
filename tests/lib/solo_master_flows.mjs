// Workflows for tests/qa_demo_solo_master.mjs. Each one is driven through the screens by one signed-in person
// (master) and ends with a check that the record reached its final state. `u` is the page helper set the harness
// passes in; engine calls appear only inside u.read for the checks.

// ---------- work order building blocks ----------
async function createOrderFromWI(u, wiKey, { quantity = 1, pedigree = 'Production', subcategory = 'Mfg.', fai } = {}) {
  await u.nav('orders');
  await u.click('[data-action=create]');
  await u.click('[data-action=create-master]', { root: '#dialog[open]' });
  await u.fill('#dialog[open]', { masterWI: wiKey });
  await u.fill('#dialog[open]', { pedigree, quantity: String(quantity), subcategory });
  if (fai !== undefined) {
    const box = u.page.locator('#dialog[open] [name=fai]');
    if (await box.count()) await box.setChecked(fai);
    const waiver = u.page.locator('#dialog[open] [name=faiWaiver]');
    if (!fai && await waiver.count() && await waiver.isVisible()) await waiver.fill('FAI covered on an earlier order (demo walk-through).');
  }
  await u.submitDialog('Create work order');
  const id = await u.read(() => selectedId);
  if (!/^WO-/.test(id || '') || await u.dialogOpen()) throw new Error('work order not created: ' + await u.toast() + ' ' + (await u.dialogText()).slice(0, 300));
  return id;
}

async function issueToKitting(u, id) {
  await u.openOrder(id);
  if ((await u.order(id)).status === 'Draft') {
    if (await u.page.locator('#main [data-action=review-release]').count()) { await u.click('[data-action=review-release]'); if (await u.dialogOpen()) await u.submitDialog(); }
    await u.click('[data-action=advance]');
  }
  // Issuing offers to print the traveler; Later closes the prompt.
  if (await u.dialogOpen()) { const later = u.page.locator('#dialog[open] [data-action=close-dialog]').filter({ hasText: 'Later' }).first(); if (await later.count()) await later.click(); else await u.closeDialog(); }
  await u.settle();
  if ((await u.order(id)).status !== 'Kitting') throw new Error('not in Kitting: ' + await u.toast());
}

async function kitAndStart(u, id) {
  await u.openOrder(id); await u.orderTab('materials'); await u.wait(300);
  const mats = await u.page.locator('#main select[data-material-lot]').evaluateAll(es => es.map(e => e.dataset.materialLot));
  for (const m of mats) {
    const sel = u.page.locator(`#main select[data-material-lot="${m}"]`);
    if (await sel.isDisabled()) continue;
    const v = await sel.evaluate(e => e.value || [...e.options].map(o => o.value).find(Boolean));
    if (!v) throw new Error('no lot in stock for kit line ' + m);
    await sel.selectOption(v); await u.settle();
    const box = u.page.locator(`#main input.material-check[data-material="${m}"]`);
    if (!await box.isChecked()) { await box.click(); await u.settle(); }
  }
  if (!(await u.order(id)).kitFiles?.length) { await u.page.setInputFiles('#main input[type=file][data-scope=kit]', u.kitFile); await u.wait(700); }
  const o = await u.order(id);
  if (!o.materials.every(m => m.ready)) throw new Error('kit lines not confirmed: ' + await u.toast());
  await u.page.locator('#main [data-action=advance]').first().click(); await u.wait(500);
  if ((await u.order(id)).status !== 'Building') throw new Error('build not started: ' + await u.toast());
}

// Buys off the current operation through the operation panel: calibrated tools, ATP test assets, the standard
// inspection acknowledgement, every step (torque value and tool where the step asks), then the buy-off dialog.
async function buyOffCurrent(u, id, note = 'Completed and verified against the work instruction.') {
  await u.openOrder(id); await u.orderTab('operations'); await u.wait(250);
  const opId = await u.read(() => selectedOp);
  const before = (await u.order(id)).operations.find(x => x.id === opId);
  if (!before || before.done) throw new Error('no open operation to buy off');
  const tools = await u.read(() => ({ torque: (MES.CAL_TOOLS.find(t => MES.isTorqueTool(t) && MES.toolCheck(t.tag).ok) || {}).tag, plain: (MES.CAL_TOOLS.find(t => !MES.isTorqueTool(t) && MES.toolCheck(t.tag).ok) || {}).tag }));
  const addTool = async () => { await u.page.fill('#tool-tag', tools.plain); await u.click('[data-action=add-tool]'); };
  if (await u.page.locator(`#main [data-action=source-inspection-record][data-op="${opId}"]`).count()) {
    await u.click(`[data-action=source-inspection-record][data-op="${opId}"]`);
    await u.fill('#dialog[open]', { agency: 'Customer source inspection office', inspector: 'R. Alvarez', reference: 'CSI-2026-0412', notifiedDate: u.today(-2), inspectedDate: u.today(-1) });
    await u.submitDialog('Record inspection');
    if (!(await u.order(id)).operations.find(x => x.id === opId).sourceInspection) throw new Error('source inspection not recorded: ' + await u.toast());
    await u.openOrder(id); await u.orderTab('operations'); await u.wait(250);
  }
  if (await u.page.locator('#tool-tag').isVisible().catch(() => false)) await addTool();
  const asset = u.page.locator('#main [name=assetId]').first();
  if (await asset.isVisible().catch(() => false) && !(await asset.inputValue())) { await asset.fill(tools.plain); await u.settle(); }
  for (const box of await u.page.locator('#main input[name=stdInspection]:not(:checked)').all()) await box.check();
  for (let k = 0; k < 40 && !(await u.dialogOpen()); k++) {
    const sid = await u.read(() => { const e = [...document.querySelectorAll('#main input[data-step-check]')].find(x => !x.checked && x.offsetParent); return e && e.dataset.stepCheck; });
    if (!sid) break;
    if (await u.page.locator('#step-torque-tool').isVisible().catch(() => false)) { await u.page.fill('#step-torque-tool', tools.torque); await u.page.fill('#step-torque-value', '25'); }
    await u.page.locator(`#main input[data-step-check="${sid}"]`).click(); await u.settle();
  }
  if (await u.dialogOpen() && /Log tools/.test(await u.dialogText())) { await u.closeDialog(); await addTool(); }
  if (!(await u.dialogOpen())) {
    if (await u.page.locator('#completion-note').isVisible().catch(() => false)) await u.page.fill('#completion-note', note);
    await u.click('[data-action=buyoff-now]');
  }
  if (!(await u.dialogOpen())) throw new Error('the buy-off dialog did not open: ' + await u.toast());
  const panel = await u.dialogText();
  await u.submitDialog();
  const after = (await u.order(id)).operations.find(x => x.id === opId);
  if (!after.done) throw new Error(`Op ${before.title} not bought off: ` + await u.toast());
  return { title: before.title, classification: before.classification || 'Manufacturing', buyoffType: before.buyoffType, inspection: !!before.inspectionPoint, override: /Master Access override/.test(panel), buyoff: after.buyoff };
}

async function buyOffAll(u, id) {
  const done = [];
  for (let n = 0; n < 30; n++) {
    const o = await u.order(id);
    const next = o.operations.find(x => !x.done);
    if (!next || next.classification === 'Part Conformity') break;
    done.push(await buyOffCurrent(u, id));
  }
  return done;
}

async function sendToQuality(u, id) {
  await u.openOrder(id); await u.orderTab('operations');
  if ((await u.order(id)).status === 'Building') { await u.page.locator('#main [data-action=advance]').first().click(); await u.wait(450); }
  if ((await u.order(id)).status !== 'Quality') throw new Error('not in Quality: ' + await u.toast());
}

async function qualityReviewAndClose(u, id) {
  await u.openOrder(id); await u.orderTab('operations');
  await u.click('[data-action=review]');
  await u.fill('#dialog[open]', { acknowledge: true });
  await u.submitDialog('Close work order');
  const o = await u.order(id);
  if (o.status !== 'Closed') throw new Error('not closed: ' + await u.toast() + ' ' + (await u.dialogText()).slice(0, 200));
}

async function stockOrder(u, id, bin) {
  await u.openOrder(id); await u.orderTab('inventory'); await u.wait(250);
  await u.page.fill('#inv-bin', bin);
  await u.clickText('Move to inventory & generate lot');
  const o = await u.order(id);
  if (!o.inventory?.lotNumber) throw new Error('not stocked: ' + await u.toast());
  return o.inventory.lotNumber;
}

// Adds a single-step operation at the end of the sequence through Add operation (Details, then "No, a single step").
async function addOperation(u, id, fields) {
  await u.openOrder(id); await u.orderTab('operations');
  await u.click('[data-action=seq-add]');
  await u.fill('#dialog[open]', { classification: fields.classification });
  await u.wait(200);
  const last = await u.page.locator('#dialog[open] [name=position] option').evaluateAll(os => os[os.length - 1].value);
  const rest = { position: last, ...fields }; delete rest.classification;
  await u.fill('#dialog[open]', rest);
  const before = (await u.order(id)).operations.length;
  await u.clickText('Next: steps', { root: '#dialog[open]' });
  await u.clickText('No, a single step', { root: '#dialog[open]' });
  await u.wait(300);
  const o = await u.order(id);
  if (o.operations.length !== before + 1) throw new Error('operation not added: ' + await u.toast() + ' ' + (await u.dialogText()).slice(-300));
  await u.closeDialog();
  return o.operations.find(x => x.title === fields.title).id;
}

// QA releases a sequence change from the order page.
async function releaseSequence(u, id) {
  await u.openOrder(id); await u.orderTab('operations');
  if (!await u.read(i => !!MES.pendingSequenceChange(MES.getOrder(state, i)), id)) return false;
  await u.click('[data-action=seq-approve]');
  if (await u.dialogOpen()) await u.submitDialog();
  if (await u.read(i => !!MES.pendingSequenceChange(MES.getOrder(state, i)), id)) throw new Error('sequence change still awaiting QA: ' + await u.toast());
  return true;
}

// ---------- workflows ----------
const workOrder = {
  name: 'wo', title: 'Work order: WI to build, buy-offs, QA send back, close, stock, NetSuite',
  async run(u) {
    const id = await u.step('create a work order from master WI MWI-0004', () => createOrderFromWI(u, 'MWI-0004|A', { quantity: 2, fai: false }));
    await u.step('issue to kitting', () => issueToKitting(u, id));
    await u.step('print the traveler', () => u.expectPrint('traveler', () => u.clickLoc(u.page.locator('#main [data-action=print-traveler]').first())));
    await u.step('print the work order (external)', () => u.expectPrint('work order print, external', () => u.clickLoc(u.page.locator('#main [data-action=print-order]').first())));
    await u.step('print the work order (internal)', () => u.expectPrint('work order print, internal', () => u.clickLoc(u.page.locator('#main [data-action=print-order]').nth(1))));
    await u.step('kit every line, attach the NetSuite kit list, start the build', () => kitAndStart(u, id));
    const ops = await u.step('check off every step and buy off every operation', () => buyOffAll(u, id));
    u.check('manufacturing, tooling and inspection buy-offs all recorded', ops.length >= 6 && ops.some(o => o.inspection), JSON.stringify(ops.map(o => o.title)));
    u.check('every buy-off carries a SHA-256 signature manifest', ops.every(o => /^[a-f0-9]{64}$/.test(o.buyoff?.manifest?.hash || '')), JSON.stringify(ops.map(o => o.buyoff?.manifest?.hash)));
    await u.step('send to Quality', () => sendToQuality(u, id));
    // QA review freezes the order (#542): a change from the work order list is refused with the freeze text and changes
    // nothing; Quality sends it back to Building with a signed rationale, and the order goes to QA again.
    await u.step('in QA review a priority change is refused and changes nothing', async () => {
      await u.nav('orders');
      const control = u.page.locator(`[data-priority-order="${id}"]`).first();
      if (!await control.count()) throw new Error('no priority control for ' + id + ' on the work order list');
      const before = (await u.order(id)).priority, other = before === 'High' ? 'Normal' : 'High';
      await control.selectOption(other); await u.wait(400);
      const after = (await u.order(id)).priority, said = await u.toast();
      if (after !== before || !/in QA review\. Ask Quality to send it back to Building/.test(said)) throw new Error(`priority ${before} -> ${after}; toast: ${said}`);
    });
    await u.step('Quality sends it back to Building with a signed rationale', async () => {
      await u.openOrder(id); await u.orderTab('operations');
      await u.click('[data-action=send-back]');
      if (!(await u.dialogOpen())) throw new Error('the send back dialog did not open: ' + await u.toast());
      await u.fill('#dialog[open]', { rationale: 'Torque stripe missing on the J3 connector. Apply it and resubmit.' });
      await u.submitDialog('Send back to Building');
      const o = await u.order(id), back = (o.sendBacks || []).at(-1);
      if (o.status !== 'Building' || !back) throw new Error(`not sent back: ${o.status}; ` + await u.toast());
      if (!/^[a-f0-9]{64}$/.test(back.manifest?.hash || '')) throw new Error('the send back has no SHA-256 signature manifest: ' + JSON.stringify(back).slice(0, 200));
      const banner = await u.page.locator('#main .send-back-banner').first().textContent().catch(() => '');
      if (!/Sent back by QA: Torque stripe missing on the J3 connector/.test(banner)) throw new Error('no Sent back by QA banner: ' + banner);
    });
    await u.step('send to Quality again after the send back', () => sendToQuality(u, id));
    await u.step('quality review and close', () => qualityReviewAndClose(u, id));
    const lot = await u.step('move to inventory', () => stockOrder(u, id, 'FG-SOLO-01'));
    await u.step('NetSuite payload: mark posted', async () => {
      await u.openOrder(id); await u.orderTab('inventory');
      await u.page.fill('#ns-ref', 'ASMB-004512');
      await u.page.locator('#netsuite-form button[type=submit]').click(); await u.wait(400);
      if (!JSON.stringify(await u.order(id)).includes('ASMB-004512')) throw new Error('NetSuite posting not recorded: ' + await u.toast());
    });
    const o = await u.order(id);
    u.check('work order closed and stocked', o.status === 'Closed' && o.inventory?.lotNumber === lot, o.status);
    return `${id} Closed, stocked ${lot}, ${ops.length} buy-offs`;
  },
};

// The conformity checklist wizard: every open item on a page is answered Yes; the Details page, the Phase 5
// decision and the 8130-9 are filled where they appear. Returns the page title it ended on.
async function confWizardPage(u, phase) {
  const root = '#dialog[open]';
  if (phase !== undefined) { await u.page.locator(`${root} [data-action=conf-page]`).filter({ hasText: phase === 'details' ? 'Details' : `Phase ${phase}` }).first().click(); await u.settle(); }
  const details = u.page.locator(`${root} form[data-form=conf-details], ${root} form:has([name=mdlRev])`).first();
  if (await details.count() && await details.isVisible()) {
    for (const [name, value] of Object.entries({ rfc: 'RFC-0301', mdlRev: 'G', mdlReceived: u.today(-1), staging: 'QA cage A, shelf 1', jira: 'CONF-301' })) {
      const f = details.locator(`[name=${name}]`); if (await f.count() && !(await f.inputValue())) await f.fill(value);
    }
    const save = details.locator('button[type=submit]'); if (await save.count()) { await save.click(); await u.settle(); }
  }
  for (let guard = 0; guard < 20; guard++) {
    const forms = u.page.locator(`${root} form:has(input[type=radio][value=Yes])`);
    let answered = false;
    for (let i = 0; i < await forms.count(); i++) {
      const f = forms.nth(i);
      if (await f.locator('input[type=radio]:checked').count()) continue;
      const yes = f.locator('input[type=radio][value=Yes]');
      if (!(await yes.isEnabled())) continue;
      await yes.click(); await u.settle(); answered = true; break;
    }
    if (!answered) break;
  }
  const nc = u.page.locator(`${root} select[name=nc]`);
  if (await nc.count() && await nc.isVisible() && !(await nc.inputValue())) { await nc.selectOption('No'); await u.clickText('Save decision', { root }); }
  return u.page.locator(`${root} h3, ${root} .conf-phase-title`).first().textContent().catch(() => '');
}
async function openConformityChecklist(u, id) {
  await u.openOrder(id); await u.orderTab('operations');
  await u.click('[data-action=conf-wizard]');
  if (!(await u.dialogOpen())) throw new Error('the conformity checklist did not open: ' + await u.toast());
}

const lru = {
  name: 'lru', title: 'LRU order: ATP assets, source inspection, conformity hold point, 8130-9 and AQI',
  async run(u) {
    const id = await u.step('create a work order from MWI-0001', () => createOrderFromWI(u, 'MWI-0001|A', { fai: false }));
    await u.step('add an ATP operation', () => addOperation(u, id, { classification: 'Acceptance Test Procedure (ATP)', title: 'Acceptance test (ATP-200)', buyoffType: 'Quality', atpRepo: 'https://github.com/skyryse/fcc-atp', atpVersion: '2.4.1', atpSha: 'a1b2c3d4e5f6a7b8' }));
    await u.step('add a source inspection operation', () => addOperation(u, id, { classification: 'Source Inspection', sourceInspectionCode: 'CSI', title: 'Customer source inspection', buyoffType: 'Quality' }));
    await u.step('add the part conformity hold point', () => addOperation(u, id, { classification: 'Part Conformity', title: 'Part conformity review (SOP-860-002)', buyoffType: '8130-9 Authorized Inspector' }));
    await u.step('QA releases the sequence change (same person)', () => releaseSequence(u, id));
    await u.step('issue to kitting, kit and start the build', async () => { await issueToKitting(u, id); await kitAndStart(u, id); });
    const ops = await u.step('buy off every operation up to the conformity hold point (ATP with test assets, source inspection)', () => buyOffAll(u, id));
    const o1 = await u.order(id);
    const atp = o1.operations.find(x => /ATP/.test(x.classification || ''));
    u.check('ATP buy-off records its test assets', atp?.buyoff?.testAssets?.length > 0, JSON.stringify(atp?.buyoff?.testAssets));
    const src = o1.operations.find(x => x.classification === 'Source Inspection');
    u.check('source inspection bought off', src?.done, JSON.stringify(src?.buyoff));
    const sn = o1.serial || (o1.serials || [])[0];
    await u.step('start the LRU conformity package', async () => {
      await u.openOrder(id); await u.orderTab('quality');
      const f = '#main form[data-form=conf-start]';
      await u.fill(f, { jira: 'CONF-301', rfc: 'RFC-0301' });
      await u.page.locator(`${f} button[type=submit]`).click(); await u.wait(450);
      if (!(await u.order(id)).conformity?.length) throw new Error('package not started: ' + await u.toast());
    });
    await u.step('conformity checklist phases 1 to 5', async () => {
      await openConformityChecklist(u, id);
      for (const ph of ['details', 1, 2, 3, 4, 5]) await confWizardPage(u, ph);
    });
    await u.step('complete the 8130-9', async () => {
      await confWizardPage(u, 6);
      await u.clickText('Complete 8130-9', { root: '#dialog[open]' });
      if (!(await u.order(id)).conformity[0].form) throw new Error('8130-9 not completed: ' + await u.toast());
    });
    await u.step('AQI signature by the person who completed the 8130-9', async () => {
      await confWizardPage(u);
      const sign = u.page.locator('#dialog[open] button[type=submit]').filter({ hasText: 'AQI' }).first();
      await sign.click(); await u.wait(450);
      // Production asks the person who completed the form to acknowledge a warning; accept it if it is shown.
      if (await u.page.locator('#dialog[open] [name=selfSignAck]').count()) { await u.fill('#dialog[open]', { selfSignAck: true }); await sign.click(); await u.wait(450); }
      if (!(await u.order(id)).conformity[0].aqi) throw new Error('AQI not signed: ' + await u.toast());
      await confWizardPage(u);
    });
    await u.step('print the 8130-9', () => u.expectPrint('8130-9 print', () => u.clickLoc(u.page.locator('#dialog[open] [data-action=conf-8130-print]').first())));
    await u.closeDialog();
    await u.step('buy off the conformity hold point', () => buyOffCurrent(u, id, 'Package reviewed, 8130-9 signed, LRU tagged.'));
    await u.step('send to Quality, review and close', async () => { await sendToQuality(u, id); await qualityReviewAndClose(u, id); });
    const o = await u.order(id); const pkg = o.conformity[0];
    u.check('8130-9 completed and AQI signed by the same person (demo)', pkg.form && pkg.aqi && pkg.aqi.by.credentialId === (pkg.form.prepared?.by?.credentialId), JSON.stringify([pkg.form?.prepared?.by, pkg.aqi?.by]));
    u.check('LRU order closed', o.status === 'Closed', o.status);
    return `${id} Closed, ${ops.length} buy-offs, 8130-9 ${pkg.status}, S/N ${sn}`;
  },
};

// AS9102 FAIR, one tab at a time: Form 1 and its index, Form 2, Form 3, then Review and sign.
async function fairTab(u, name) { await u.page.locator('#main button').filter({ hasText: new RegExp('^' + name) }).first().click(); await u.settle(); }
async function fairForm1(u, id) {
  await u.openOrder(id); await u.orderTab('quality');
  if (await u.page.locator('#main [data-action=fair-start]').count()) await u.click('[data-action=fair-start]');
  const f1 = '#main form.fair-form:has([name=supplierCode])';
  await u.fill(f1, { type: 'Full', supplierCode: '8KSY1', sampleSize: '1', comments: 'First article, demo walk-through.' });
  await u.page.locator(`${f1} input[name=reasons]`).first().check();
  await u.page.locator(`${f1} button[type=submit]`).click(); await u.settle();
  const idx = u.page.locator('#main form:has([name=fairId])');
  for (let i = 0; i < await idx.locator('[name=pn]').count(); i++) {
    const pn = await idx.locator('[name=pn]').nth(i).inputValue(), fid = idx.locator('[name=fairId]').nth(i);
    if (pn && !(await fid.inputValue())) await fid.fill('LOT-' + pn.slice(-4) + '-0001');
  }
  await idx.locator('button[type=submit]').click(); await u.settle();
  { const f = (await u.order(id)).fair; if (f?.supplierCode !== '8KSY1' || !f.index?.every(x => x.fairId)) throw new Error('Form 1 not saved: ' + await u.toast()); }
}
async function fairForm2(u, id) {
  await fairTab(u, 'Form 2');
  const f2 = '#main form[data-form=fair-f2]';
  await u.fill(f2, { kind: 'Material', name: 'Aluminum 6061-T6 plate', spec: 'AMS-QQ-A-250/11', supplier: 'Pacific Metals, El Segundo CA', approval: 'Yes', coc: 'COC-44812' });
  await u.page.locator(`${f2} button[type=submit]`).click(); await u.settle();
  if (!(await u.order(id)).fair?.form2?.length) throw new Error('Form 2 line not added: ' + await u.toast());
}
async function fairForm3(u, id) {
  await fairTab(u, 'Form 3');
  const add = '#main form[data-form=fair-add]';
  for (const [ref, requirement] of [['Sheet 1, zone B3', '0.250 ±0.005 in'], ['Sheet 2, note 4', 'Part mark per MIL-STD-130']]) {
    await u.fill(add, { ref, requirement });
    await u.page.locator(`${add} button[type=submit]`).click(); await u.settle();
  }
  for (let guard = 0; guard < 10; guard++) {
    const rows = u.page.locator('#main form[data-form=fair-res]');
    let open = -1;
    for (let k = 0; k < await rows.count(); k++) if (!(await rows.nth(k).locator('[name=result]').inputValue())) { open = k; break; }
    if (open < 0) break;
    const r = rows.nth(open);
    await r.locator('[name=result]').fill(open ? 'Conforms' : '0.2512');
    await r.locator('[name=ok]').selectOption('yes');
    await r.locator('[name=tool]').fill('CAL-022');
    await r.locator('button[type=submit]').click(); await u.settle();
  }
  const chars = (await u.order(id)).fair?.chars || [];
  if (chars.length < 2 || chars.some(c => !c.result)) throw new Error('Form 3 results not recorded: ' + await u.toast());
}
async function fairSign(u, id, form, expect) {
  await fairTab(u, 'Review and sign');
  const f = u.page.locator(`#main form[data-form=${form}]`);
  if (!await f.count()) throw new Error(`no ${form} form; the FAIR is ${(await u.order(id)).fair?.status}`);
  await f.locator('button[type=submit]').click(); await u.wait(450);
  if (!(await u.order(id)).fair?.[expect]) throw new Error(`${form} not recorded: ` + await u.toast());
}

const fai = {
  name: 'fai', title: 'FAI order: AS9102 FAIR Forms 1 to 3, box 22, QA approval',
  async run(u) {
    const id = await u.step('create an FAI work order (first article)', () => createOrderFromWI(u, 'MWI-0003|A', { fai: true }));
    u.check('the order is an FAI order', (await u.read(i => MES.isFaiOrder ? MES.isFaiOrder(MES.getOrder(state, i)) : !!MES.getOrder(state, i).fai?.required, id)), JSON.stringify((await u.order(id)).fai));
    await u.step('issue, kit, build and send to Quality', async () => { await issueToKitting(u, id); await kitAndStart(u, id); await buyOffAll(u, id); await sendToQuality(u, id); });
    await u.step('FAIR Form 1 and the index', () => fairForm1(u, id));
    await u.step('FAIR Form 2 material', () => fairForm2(u, id));
    await u.step('FAIR Form 3 characteristics and results', () => fairForm3(u, id));
    await u.step('verify the FAIR (blocks 20 and 21)', () => fairSign(u, id, 'fair-verify', 'verified'));
    await u.step('the verify message and the box 22 panel tell one person the next step', async () => {
      const msg = await u.toast();
      if (!msg.includes('In this demo the verifier may also sign box 22 next.')) throw new Error('verify message: ' + msg);
      await fairTab(u, 'Review and sign');
      const panel = await u.page.locator('#main form[data-form=fair-review]').locator('xpath=..').innerText();
      if (!panel.includes('(in this demo the verifier may sign)') || !panel.includes('In this demo the verifier may sign it.')) throw new Error('box 22 panel: ' + panel);
      if (/second person|other than the verifier/i.test(panel)) throw new Error('the box 22 panel still asks for a second person: ' + panel);
    });
    await u.step('box 22 review by the same person', () => fairSign(u, id, 'fair-review', 'reviewed'));
    await u.step('Skyryse QA approval', () => fairSign(u, id, 'fair-approve', 'approved'));
    await u.step('print the FAIR', () => u.expectPrint('FAIR print', () => u.clickLoc(u.page.locator('#main [data-action=fair-print]').first())));
    await u.step('quality review and close', () => qualityReviewAndClose(u, id));
    const o = await u.order(id);
    u.check('FAIR approved and the FAI order closed', o.fair?.status === 'Approved' && o.status === 'Closed', `${o.fair?.status} ${o.status}`);
    u.check('the verifier and the box 22 reviewer are the same signed-in person', o.fair?.verified?.by?.credentialId && o.fair.verified.by.credentialId === o.fair?.reviewed?.by?.credentialId, JSON.stringify([o.fair?.verified?.by, o.fair?.reviewed?.by]));
    return `${id} FAIR ${o.fair?.status}, WO ${o.status}`;
  },
};

// ---------- NC tickets, MRB and dispositions ----------
const ticketOf = (u, orderId, tid) => u.read(([o, t]) => { const x = MES.getOrder(state, o).tickets.find(k => k.id === t); return x && JSON.parse(JSON.stringify(x)); }, [orderId, tid]);
async function openTicket(u, orderId, tid) {
  await u.openOrder(orderId); await u.orderTab('quality');
  await u.click(`[data-action=ticket][data-ticket="${tid}"]`);
  if (!(await u.dialogOpen())) throw new Error('ticket ' + tid + ' did not open');
}
async function raiseNC(u, orderId, title, description) {
  await u.openOrder(orderId); await u.orderTab('operations');
  const before = (await u.order(orderId)).tickets.map(t => t.id);
  await u.click('[data-action=create-ticket]:not([disabled])');
  await u.fill('#dialog[open]', { title, description, hold: true });
  await u.submitDialog('Create');
  const t = (await u.order(orderId)).tickets.find(x => !before.includes(x.id));
  if (!t) throw new Error('NC not created: ' + await u.toast());
  return t.id;
}
async function disposition(u, orderId, tid, decision, note) {
  await openTicket(u, orderId, tid);
  await u.fill('#dialog[open] form#ticket-dispo-form', { decision, note });
  await u.submitDialog('Record initial disposition');
  if ((await ticketOf(u, orderId, tid)).dispo?.decision !== decision) throw new Error('disposition not recorded: ' + await u.toast());
}
// Every seat of a board voted Approve by the one signed-in person, from the board screen.
async function voteEverySeat(u, boardId) {
  await openRecord(u, 'mnv-mrb', boardId);
  const seats = await u.read(b => FlightManeuver.seatsOf(FlightManeuver.get(state, 'mrb', b)), boardId);
  for (const seat of seats) {
    if (await u.read(([b, s]) => FlightManeuver.get(state, 'mrb', b).votes.some(v => v.seat === s), [boardId, seat])) continue;
    if (!await u.page.locator('#mnv-vote-form').count()) throw new Error(`no vote form for the ${seat} seat: ` + (await u.page.locator('#main .inline-info').first().textContent().catch(() => '')));
    await u.fill('#mnv-vote-form', { seat, vote: 'Approve', note: `Reviewed for ${seat}; acceptable.` });
    await u.page.locator('#mnv-vote-form button[type=submit]').click(); await u.wait(450);
  }
  const m = await u.read(b => JSON.parse(JSON.stringify(FlightManeuver.get(state, 'mrb', b))), boardId);
  if (m.status === 'Open' && await u.page.locator('#mnv-decide-form').count()) {
    await u.fill('#mnv-decide-form', { note: 'All seats approved.', acknowledge: true });
    await u.page.locator('#mnv-decide-form button[type=submit]').click(); await u.wait(450);
  }
  return u.read(b => JSON.parse(JSON.stringify(FlightManeuver.get(state, 'mrb', b))), boardId);
}
async function moveToMRB(u, orderId, tid) {
  await openTicket(u, orderId, tid);
  await u.click('[data-action=mnv-mrb-new]', { root: '#dialog[open]' });
  await u.submitDialog('Move to MRB');
  const board = await u.read(([o, t]) => FlightManeuver.list(state, 'mrb').find(m => m.orderId === o && m.ticketId === t)?.id, [orderId, tid]);
  if (!board) throw new Error('board not convened: ' + await u.toast());
  return board;
}
async function qaApproveTicket(u, orderId, tid, rationale, { closeOrder = false } = {}) {
  await openTicket(u, orderId, tid);
  const form = '#dialog[open] form#resolve-ticket-form';
  if (!await u.page.locator(form).count()) throw new Error('no Quality approval form on ' + tid + ': ' + (await u.dialogText()).slice(-400));
  await u.fill(form, { defectCode: 'DMG' }); await u.wait(150);
  const sub = await u.page.locator(`${form} [name=subCode] option`).evaluateAll(os => os.map(o => o.value).find(Boolean));
  await u.fill(form, { subCode: sub, resolution: rationale });
  for (const s of await u.page.locator(`${form} input[name=serials]`).all()) await s.check();
  const qty = u.page.locator(`${form} [name=quantity]`); if (await qty.count() && !(await qty.inputValue())) await qty.fill('1');
  if (closeOrder) await u.fill(form, { closeOrder: true });
  await u.fill(form, { acknowledge: true });
  await u.page.locator(`${form} button[type=submit]`).last().click(); await u.wait(500);
  const t = await ticketOf(u, orderId, tid);
  if (!t.resolution && t.status === 'Open' && !t.reworkPlan) throw new Error('Quality approval not recorded: ' + await u.toast());
  return t;
}
// Opens a Flight Maneuver record from its list: the row opens a summary panel and Open full record opens it.
async function openRecord(u, listView, id) {
  await u.nav(listView);
  const row = u.page.locator('#main button.fr-record-link').filter({ hasText: id }).first();
  if (!await row.count()) throw new Error(`${id} is not listed in ${listView}`);
  await row.click(); await u.wait(300);
  const open = u.page.locator('dialog.fr-drawer[open] button.fr-primary').first();
  if (await open.count()) { await open.click(); await u.wait(450); }
}

const ncMrb = {
  name: 'nc', title: 'NC to MRB: every seat voted, each disposition, QA approval by the author',
  async run(u) {
    const a = await u.step('create and start a Production order for the NCs', async () => { const id = await createOrderFromWI(u, 'MWI-0005|A', { fai: false }); await issueToKitting(u, id); await kitAndStart(u, id); return id; });
    const out = [];
    // Use as is on Production goes to the MRB; every seat voted by master; QA approval by the disposition author.
    {
      const t = await u.step('raise an NC with a hold (Use as is case)', () => raiseNC(u, a, 'Scratch on mounting face', '0.5 in scratch outside functional surfaces.'));
      await u.step('ME disposition Use as is', () => disposition(u, a, t, 'Use as is', 'Cosmetic only, outside functional surfaces.'));
      const board = await u.step('move to MRB', () => moveToMRB(u, a, t));
      const m = await u.step('vote every MRB seat as master', () => voteEverySeat(u, board));
      u.check(`${board} approved with every seat voted by one person`, m.status === 'Approved' && m.votes.length === m.seats.length && m.votes.every(v => v.by.credentialId === m.votes[0].by.credentialId), JSON.stringify({ status: m.status, votes: m.votes.map(v => v.seat) }));
      await u.step('QA approval of Use as is by the disposition author', () => qaApproveTicket(u, a, t, 'MRB approved; cosmetic only.'));
      const r = await ticketOf(u, a, t); u.check('Use as is NC resolved', r.status === 'Resolved', r.status); out.push(`Use as is ${r.status}`);
    }
    for (const [decision, title] of [['Return to supplier', 'Bent pins on the supplier connector'], ['Rework', 'Wrong washer installed'], ['Repair', 'Thread damaged on tapped hole 4']]) {
      const t = await u.step(`raise an NC (${decision} case)`, () => raiseNC(u, a, title, `${title}, found at the bench.`));
      await u.step(`ME disposition ${decision}`, () => disposition(u, a, t, decision, `${decision}: engineering rationale recorded.`));
      await openTicket(u, a, t);
      if (await u.page.locator('#dialog[open] [data-action=mnv-mrb-new]').count()) {
        const board = await u.step(`move the ${decision} NC to MRB`, () => moveToMRB(u, a, t));
        const m = await u.step(`vote every seat on ${board}`, () => voteEverySeat(u, board));
        u.check(`${board} approved`, m.status === 'Approved', m.status);
      }
      await u.step(`QA approval of ${decision} by the disposition author`, () => qaApproveTicket(u, a, t, `${decision} approved by Quality.`));
      if (decision === 'Rework' || decision === 'Repair') {
        await u.step(`add the ${decision.toLowerCase()} operation linked to the NC`, () => addOperation(u, a, { classification: decision, ticketId: t, title: `${decision} for ${t}`, buyoffType: 'Technician' }));
        await u.step('QA releases the sequence (same person)', () => releaseSequence(u, a));
      }
      const r = await ticketOf(u, a, t); u.check(`${decision} NC approved`, ['Resolved', 'Closed'].includes(r.status) || r.reworkPlan, r.status + ' ' + JSON.stringify(r.reworkPlan || null)); out.push(`${decision} ${r.status}`);
    }
    await u.step('finish the build (rework and repair operations included), close the order', async () => { await buyOffAll(u, a); await sendToQuality(u, a); await qualityReviewAndClose(u, a); });
    const o = await u.order(a);
    u.check('every NC on the order closed and the order closed', o.status === 'Closed' && o.tickets.every(t => t.status !== 'Open'), JSON.stringify(o.tickets.map(t => t.id + ':' + t.status)));
    // Scrap closes the work order as Scrap in the same QA approval.
    const b = await u.step('create and start a second order (Scrap case)', async () => { const id = await createOrderFromWI(u, 'MWI-0008|A', { fai: false }); await issueToKitting(u, id); await kitAndStart(u, id); return id; });
    const ts = await u.step('raise an NC (Scrap case)', () => raiseNC(u, b, 'Housing cracked', 'Crack at boss 3 after press fit.'));
    await u.step('ME disposition Scrap', () => disposition(u, b, ts, 'Scrap', 'Crack beyond repair limits.'));
    await openTicket(u, b, ts);
    if (await u.page.locator('#dialog[open] [data-action=mnv-mrb-new]').count()) { const board = await u.step('move the Scrap NC to MRB', () => moveToMRB(u, b, ts)); await u.step(`vote every seat on ${board}`, () => voteEverySeat(u, board)); }
    await u.step('QA approves Scrap and closes the order as Scrap', () => qaApproveTicket(u, b, ts, 'Scrap approved; housing cracked.', { closeOrder: true }));
    const ob = await u.order(b);
    u.check('order closed as Scrap with the NC linked', ob.status === 'Closed' && ob.closedAs === 'Scrap', `${ob.status} ${ob.closedAs}`);
    out.push(`Scrap ${ob.status} as ${ob.closedAs}`);
    // Use for Dev needs a QA Manager approval and downgrades the order to Development.
    const c = await u.step('create and start a third order (Use for Dev case)', async () => { const id = await createOrderFromWI(u, 'MWI-0007|A', { fai: false }); await issueToKitting(u, id); await kitAndStart(u, id); return id; });
    const td = await u.step('raise an NC (Use for Dev case)', () => raiseNC(u, c, 'Bore oversize', 'Bore 0.503 in, max 0.501 in.'));
    await u.step('ME disposition Use for Dev', () => disposition(u, c, td, 'Use for Dev', 'Usable for development testing only.'));
    await u.step('QA Manager approval of Use for Dev by the disposition author', () => qaApproveTicket(u, c, td, 'Approved for development use.'));
    const oc = await u.order(c);
    u.check('Use for Dev resolved and the order downgraded to Development', oc.pedigree === 'Development' && oc.tickets.find(t => t.id === td).status === 'Resolved', `${oc.pedigree} ${oc.tickets.find(t => t.id === td).status}`);
    out.push(`Use for Dev -> ${oc.pedigree}`);
    return out.join(', ');
  },
};

// ---------- corrective action (CAR, with a SCAR for a supplier cause) ----------
const carOf = (u, id) => u.read(i => JSON.parse(JSON.stringify(FlightManeuver.get(state, 'cars', i))), id);
async function submitForm(u, form, fields) {
  await u.fill(form, fields);
  await u.page.locator(`${form} button[type=submit]`).first().click(); await u.wait(450);
}
async function openCar(u, id) { await openRecord(u, 'mnv-cars', id); if ((await u.read(() => view)) !== 'mnv-car') throw new Error(id + ' did not open'); }
async function raiseCar(u, title, description) {
  await u.nav('mnv-cars');
  await u.click('[data-action=mnv-car-new]');
  await u.fill('#dialog[open]', { title, description, sourceType: 'Observation', severity: 'Major', ownerAccount: 'master', dueDate: u.today(30) });
  await u.submitDialog('Raise');
  const id = await u.read(() => mnvSel.car);
  if (!/^CAR-/.test(id || '')) throw new Error('CAR not raised: ' + await u.toast());
  return id;
}
async function carToClosure(u, id, { supplier } = {}) {
  await openCar(u, id);
  await u.step('containment', () => submitForm(u, '#mnv-containment-form', { note: '100% re-inspection of open orders; suspect stock quarantined.' }));
  await u.step('root cause: 5 Why and fishbone', () => submitForm(u, '#mnv-rootcause-form', { why1: 'Backshell not torqued', why2: 'The step did not state the torque value', why3: 'The WI template had no torque field', fishMethod: 'WI missing the torque unit', category: supplier ? 'Material' : 'Method', ...(supplier ? { supplier } : {}), statement: supplier ? 'The supplier formed the bracket in the wrong temper.' : 'The WI did not state the torque unit and value.' }));
  if (supplier) {
    await u.step('SCAR: record the Jira key', async () => {
      await u.click('[data-action=mnv-scar-jira]');
      const root = (await u.dialogOpen()) ? '#dialog[open]' : '#main';
      const key = u.page.locator(`${root} [name=key], ${root} [name=jiraKey]`).first();
      await key.fill('SCAR-41');
      const url = u.page.locator(`${root} [name=url], ${root} [name=jiraUrl]`).first(); if (await url.count()) await url.fill('https://skyryse.atlassian.net/browse/SCAR-41');
      await u.page.locator(`${root} form:has([name=key]) button[type=submit], ${root} form:has([name=jiraKey]) button[type=submit]`).first().click(); await u.wait(450);
      if (!JSON.stringify((await carOf(u, id)).scar || {}).includes('SCAR-41')) throw new Error('SCAR Jira key not recorded: ' + await u.toast());
    });
    await u.step('SCAR: close it', async () => {
      await openCar(u, id);
      await u.click('[data-action=mnv-scar-close]');
      const root = (await u.dialogOpen()) ? '#dialog[open]' : '#main';
      const note = u.page.locator(`${root} form:has(textarea) textarea`).first(); if (await note.count()) await note.fill('Supplier corrected the temper; first article verified.');
      if (await u.dialogOpen()) await u.submitDialog();
    });
    await openCar(u, id);
  }
  await u.step('add a corrective action', () => submitForm(u, '#mnv-action-form', { description: 'Add the torque value and unit to the WI step.', owner: 'Master Access', dueDate: u.today(14) }));
  await u.step('mark the action done', async () => { const f = await u.page.locator('#main form[id^=mnv-action-done]').first().getAttribute('id'); await submitForm(u, '#' + f, { evidence: 'MCR incorporated into the master WI.' }); });
  await u.step('Quality verification by the root cause author', () => submitForm(u, '#mnv-verify-form', { note: 'Verified on five orders.' }));
  await u.step('effectiveness check', () => submitForm(u, '#mnv-effect-form', { checkDate: u.today(0), result: 'Effective', note: 'No recurrence in five orders.' }));
  await u.step('close and sign', () => submitForm(u, '#mnv-close-form', { note: 'Closed after an effective check.', acknowledge: true }));
  return carOf(u, id);
}

const car = {
  name: 'car', title: 'CAR and SCAR: containment, root cause, actions, verification, closure',
  async run(u) {
    const id = await u.step('raise a CAR', () => raiseCar(u, 'Torque escapes on backshells', 'Repeat backshell torque escapes across three orders.'));
    const c = await carToClosure(u, id);
    u.check(`${id} closed by the one person who raised it, found the root cause and verified it`, c.status === 'Closed', c.status);
    await u.step('print the CAR', () => u.expectPrint('CAR print', () => u.clickLoc(u.page.locator('#main [data-action=mnv-print]').first())));
    const s = await u.step('raise a supplier CAR', () => raiseCar(u, 'Bracket cracks from one lot', 'Cracked brackets found at receiving from one supplier lot.'));
    const sc = await carToClosure(u, s, { supplier: 'Acme Metals' });
    u.check(`${s} with its SCAR closed`, sc.status === 'Closed', sc.status + ' ' + JSON.stringify(sc.scar));
    return `${id} ${c.status}; ${s} ${sc.status} with SCAR`;
  },
};

// ---------- stock NC (outside a work order), escape ----------
const ncRecord = (u, id) => u.read(i => JSON.parse(JSON.stringify(FlightManeuver.get(state, 'ncs', i))), id);
async function raiseStockNC(u, fields) {
  await u.nav('mnv-intake');
  await u.click('[data-action=mnv-nc-new]');
  const { escapedFrom, ...rest } = fields;
  await u.fill('#dialog[open]', rest);
  if (escapedFrom) { await u.wait(150); await u.fill('#dialog[open]', { escapedFrom }); }
  await u.submitDialog('Raise');
  const id = await u.read(() => mnvSel.nc);
  if (!/^NC-/.test(id || '') || await u.dialogOpen()) throw new Error('stock NC not raised: ' + await u.toast() + ' ' + (await u.dialogText()).slice(0, 300));
  return id;
}
async function stockNcToApproval(u, id, decision) {
  await openRecord(u, 'mnv-intake', id);
  // Containment is asked for an escape; other stock NCs go straight to the disposition.
  if (await u.page.locator('#mnv-nc-contain-form').count()) await u.step(`${id}: containment`, () => submitForm(u, '#mnv-nc-contain-form', { note: 'Lot quarantined in the MRB cage; stock checked for more units.' }));
  await u.step(`${id}: ME disposition ${decision}`, () => submitForm(u, '#mnv-nc-dispo-form', { decision, note: `${decision}: engineering rationale recorded.` }));
  if (await u.page.locator('#main [data-action=mnv-mrb-new]').count()) {
    const board = await u.step(`${id}: move to MRB`, async () => {
      await u.click('[data-action=mnv-mrb-new]');
      await u.submitDialog('Move to MRB');
      const b = await u.read(i => FlightManeuver.list(state, 'mrb').find(m => m.ticketId === i)?.id, id);
      if (!b) throw new Error('board not convened: ' + await u.toast());
      return b;
    });
    const m = await u.step(`${board}: every seat voted by master`, () => voteEverySeat(u, board));
    u.check(`${board} approved`, m.status === 'Approved', m.status);
    await openRecord(u, 'mnv-intake', id);
  }
  await u.step(`${id}: Quality approval by the disposition author`, async () => {
    const form = '#mnv-nc-approve-form';
    if (!await u.page.locator(form).count()) throw new Error('no Quality approval form: ' + (await u.page.locator('#main').innerText()).slice(0, 400));
    await u.fill(form, { defectCode: 'FIN' }); await u.wait(150);
    const sub = await u.page.locator(`${form} [name=subCode] option`).evaluateAll(os => os.map(o => o.value).find(Boolean));
    await submitForm(u, form, { subCode: sub, quantity: '1', note: `${decision} approved by Quality.` });
  });
  return ncRecord(u, id);
}

const stockNc = {
  name: 'stocknc', title: 'Stock NC and escape: containment, disposition, MRB, approval',
  async run(u) {
    const out = [];
    const a = await u.step('raise a stock NC from a PO line, recorded as an escape', () => raiseStockNC(u, { foundAt: 'Receiving inspection', title: 'Anodize color mismatch', partNumber: 'SR-IH-040', revision: 'A', sourceType: 'PO line', sourcePo: 'PO4411', sourceLine: '3', quantity: '1', pedigree: 'Production', description: 'Shade differs from the approved sample.', escaped: 'yes' }));
    const ra = await stockNcToApproval(u, a, 'Use as is');
    u.check(`${a} recorded as an escape and approved`, !!ra.escape?.from && ra.status !== 'Open' && !!ra.containment, ra.status + ' ' + JSON.stringify(ra.escape));
    out.push(`${a} Use as is ${ra.status} (escape)`);
    const b = await u.step('raise a stock NC from a lot (Return to supplier)', () => raiseStockNC(u, { foundAt: 'Stock', title: 'Wrong plating on the lot', partNumber: 'SR-IH-040', revision: 'A', sourceType: 'Lot', lot: 'LOT-0040-0001', quantity: '1', pedigree: 'Production', description: 'Cadmium plating where zinc-nickel is called out.', escaped: 'no' }));
    const rb = await stockNcToApproval(u, b, 'Return to supplier');
    out.push(`${b} Return to supplier ${rb.status}`);
    const c = await u.step('raise a stock NC (Scrap)', () => raiseStockNC(u, { foundAt: 'Stock', title: 'Dropped unit', partNumber: 'SR-IH-040', revision: 'A', sourceType: 'PO line', sourcePo: 'PO4412', sourceLine: '1', quantity: '1', pedigree: 'Production', description: 'Unit dropped in stores; housing cracked.', escaped: 'no' }));
    const rc = await stockNcToApproval(u, c, 'Scrap');
    out.push(`${c} Scrap ${rc.status}`);
    for (const r of [ra, rb, rc]) u.check(`${r.id} approved`, r.status !== 'Open' || r.approval || r.approved, r.status);
    return out.join(', ');
  },
};

// ---------- SPR (the FRACAS failure report) ----------
const spr = {
  name: 'spr', title: 'SPR (FRACAS failure report)',
  async run(u) {
    const id = await u.step('raise an SPR', async () => {
      await u.nav('mnv-spr');
      await u.click('[data-action=mnv-spr-new]');
      await u.fill('#dialog[open]', { title: 'HIL watchdog timeout', foundAt: 'HIL', occurred: u.today(-1), partNumber: 'SR-FC-200', serial: 'FC-200-00003', defectCode: 'WIRE' });
      await u.wait(150);
      const sub = await u.page.locator('#dialog[open] [name=subCode] option').evaluateAll(os => os.map(o => o.value).find(Boolean));
      await u.fill('#dialog[open]', { subCode: sub, description: 'Watchdog timeout at 40 min on the HIL rig.' });
      await u.submitDialog('Raise SPR');
      const s = await u.read(() => FlightManeuver.list(state, 'sprs').find(x => x.title === 'HIL watchdog timeout')?.id);
      if (!s) throw new Error('SPR not raised: ' + await u.toast());
      return s;
    });
    // The Problem Reports list opens each SPR in a drawer; its Jira steps (Record Jira key, then Close from Jira) run
    // from there, as a person would reach them.
    const fromDrawer = async (action) => {
      await u.nav('mnv-spr');
      await u.clickText(id, { root: '#main', tag: '.fr-record-link' });
      await u.click(`[data-action=${action}][data-id="${id}"]`, { root: 'dialog.fr-drawer[open]' });
      if (!(await u.dialogOpen())) throw new Error(`${action} did not open its form for ${id}`);
    };
    await u.step('record the Jira key from the Problem Reports drawer', async () => {
      await fromDrawer('mnv-spr-jira');
      await u.fill('#dialog[open]', { key: 'SPR-901' });
      await u.submitDialog('Record key');
      const s = await u.read(i => FlightManeuver.get(state, 'sprs', i).status, id);
      if (s !== 'In Jira') throw new Error(`${id} is ${s} after recording the Jira key: ` + await u.toast());
    });
    await u.step('close the SPR from Jira', async () => {
      await fromDrawer('mnv-spr-close');
      await u.fill('#dialog[open]', { note: 'Jira SPR-901 closed: watchdog timeout traced to a loose harness connector, reseated and retested.' });
      await u.submitDialog('Close SPR');
      const s = await u.read(i => FlightManeuver.get(state, 'sprs', i).status, id);
      if (s !== 'Closed') throw new Error(`${id} is ${s} after closing from Jira: ` + await u.toast());
    });
    await u.expectValid('the SPR workflow');
    const s = await u.read(i => FlightManeuver.get(state, 'sprs', i).status, id);
    return `${id} ${s} (Jira key SPR-901 recorded and closed from Jira)`;
  },
};

// ---------- change requests ----------
const ecrOf = (u, id) => u.read(i => JSON.parse(JSON.stringify((state.ecrRequests || []).find(e => e.id === i))), id);
async function openEcr(u, id) {
  await u.nav('mnv-changes');
  await u.click(`[data-action=ecr-open][data-id="${id}"]`);
  if (!(await u.dialogOpen())) throw new Error(id + ' did not open');
}
const changes = {
  name: 'changes', title: 'Change requests: design ECR, Jira key, ECO released',
  async run(u) {
    const ecr = await u.step('submit a design ECR', async () => {
      await u.nav('mnv-changes');
      await u.page.locator('#main [data-action=ecr-new]').filter({ hasText: 'ECR' }).first().click(); await u.settle();
      await u.fill('#dialog[open]', { partNumber: 'SR-FC-200', title: 'Add strain relief to J3', description: 'Add a strain relief boot to J3.', reason: 'Repeat damage at J3.' });
      await u.submitDialog('Submit ECR');
      const id = await u.read(() => state.ecrRequests.find(e => e.title === 'Add strain relief to J3')?.id);
      if (!id) throw new Error('ECR not created: ' + await u.toast());
      return id;
    });
    await u.step('record the Jira key', async () => {
      await openEcr(u, ecr);
      await u.click(`[data-action=ecr-jira][data-id="${ecr}"]`, { root: '#dialog[open]' });
      const key = u.page.locator('#dialog[open] input[name=key], #dialog[open] input[name=jiraKey]').first();
      if (!await key.count()) throw new Error('no Jira key field: ' + (await u.dialogText()).slice(0, 300));
      await key.fill('ECR-301');
      const url = u.page.locator('#dialog[open] input[name=url], #dialog[open] input[name=jiraUrl]').first(); if (await url.count()) await url.fill('https://skyryse.atlassian.net/browse/ECR-301');
      await u.submitDialog();
      if (!JSON.stringify(await ecrOf(u, ecr)).includes('ECR-301')) throw new Error('Jira key not recorded: ' + await u.toast());
    });
    await u.step('record the ECO from PDM (closes the ECR)', async () => {
      await openEcr(u, ecr);
      await u.click(`[data-action=ecr-eco][data-id="${ecr}"]`, { root: '#dialog[open]' });
      const eco = u.page.locator('#dialog[open] #ecr-eco-form input[name=number]').first();
      if (!await eco.count()) throw new Error('no ECO field: ' + (await u.dialogText()).slice(0, 300));
      await eco.fill('ECO-3201');
      await u.submitDialog();
    });
    const e = await ecrOf(u, ecr);
    u.check(`${ecr} reached ECO released`, e.status === 'ECO released' && e.eco?.number === 'ECO-3201', e.status);
    return `${ecr} ${e.status}`;
  },
};

// ---------- master WI: author, peer review, release; Form 3 plan; PFMEA with the Safety Team buy-off ----------
const wiOf = (u, id, rev) => u.read(([i, r]) => JSON.parse(JSON.stringify(MES.findWI(state, i, r))), [id, rev]);
async function openWI(u, id, rev) {
  await u.nav('wis');
  const b = u.page.locator(`#main [data-action=wi-open]`).filter({ hasText: `${id} · Rev ${rev}` }).first();
  if (await b.count()) await b.click(); else await u.click(`[data-action=wi-open][data-id="${id}"]`);
  await u.wait(450);
  const at = await u.read(() => [view, selectedWI && selectedWI.id, selectedWI && selectedWI.revision]);
  if (at[0] !== 'wi' || at[1] !== id) throw new Error(`${id} Rev ${rev} did not open`);
  if (at[2] !== rev) { const r = u.page.locator('#main button').filter({ hasText: new RegExp(`^Rev ${rev}`) }).first(); if (await r.count()) { await r.click(); await u.wait(400); } }
}
async function openPfmea(u, id) {
  await u.nav('mnv-pfmea');
  const b = u.page.locator(`#main [data-action=mnv-open-pfmea][data-id="${id}"]`).first();
  if (await b.count()) { await b.click(); await u.wait(450); return; }
  await openRecord(u, 'mnv-pfmea', id);
}
const pfmeaOf = (u, id) => u.read(i => JSON.parse(JSON.stringify((state.maneuver.pfmeas || []).find(x => x.id === i))), id);

const wi = {
  name: 'wi', title: 'Master WI: author, peer review, release, Form 3 plan, PFMEA Safety Team buy-off',
  async run(u) {
    const w = await u.step('author a new master WI', async () => {
      await u.nav('wis');
      await u.click('[data-action=wi-create]');
      await u.fill('#dialog[open]', { partNumber: 'SR-HC-050' }); await u.wait(150);
      await u.fill('#dialog[open]', { drawingStatus: 'released', title: 'Harness set, solo walk-through WI' });
      await u.submitDialog('Create draft');
      const s = await u.read(() => selectedWI && { ...selectedWI });
      if (!s?.id) throw new Error('WI not created: ' + await u.toast());
      return s;
    });
    await u.step('write the operation and its step', async () => {
      const of = '#main #wi-ops-form';
      await u.page.fill(`${of} [name=title]`, 'Route and tie the harness');
      await u.page.fill(`${of} [name=description]`, 'Route the harness per the drawing and tie at each station.');
      await u.page.fill(`${of} [name=stepTitle]`, 'Route the harness');
      await u.page.fill(`${of} [name=instruction]`, 'Route the harness along the drawing path and tie every 6 in.');
      await u.page.locator(`${of} [name=instruction]`).blur(); await u.wait(400);
      const op = (await wiOf(u, w.id, w.revision)).operations[0];
      if (op.title !== 'Route and tie the harness' || !/every 6 in/.test(op.steps?.[0]?.instruction || '')) throw new Error('operation not saved: ' + JSON.stringify(op).slice(0, 200));
    });
    await u.step('mark it a critical safety part', async () => { await u.page.check('#wi-critical-safety'); await u.wait(400); });
    await u.step('record the drawing ECO', () => submitForm(u, '#wi-drawing-form', { eco: 'ECO-3101' }));
    await u.step('save the AS9102 Form 3 plan', async () => {
      await submitForm(u, '#main form:has([name=characteristics])', { characteristics: JSON.stringify([{ balloon: 1, characteristic: 'Tie spacing', requirement: '6 in max' }]) });
      if (!JSON.stringify(await wiOf(u, w.id, w.revision)).includes('Tie spacing')) throw new Error('Form 3 plan not saved: ' + await u.toast());
    });
    await u.step('ME peer review by the author', async () => { await u.click('[data-action=wi-peer-review]'); if (await u.dialogOpen()) await u.submitDialog(); });
    const pf = await u.step('QA review by the author moves it to PFMEA', async () => {
      await u.click('[data-action=wi-qa-pfmea]');
      const id = await u.read(([i, r]) => (state.maneuver.pfmeas || []).find(x => x.wiId === i && x.wiRevision === r)?.id, [w.id, w.revision]);
      if (!id) throw new Error('no PFMEA opened: ' + await u.toast());
      await u.closeDialog();
      return id;
    });
    await u.step('PFMEA scope and team', async () => { await openPfmea(u, pf); await submitForm(u, '#pfm-scope-form', { team: 'Master Access (ME, QA), Safety Team representative', boundaries: 'Harness routing and tie-down.' }); });
    await u.step('PFMEA failure mode', () => submitForm(u, '#pfm-mode-form', { mode: 'Tie missed at a station', effect: 'Chafe on the harness', cause: 'Spacing not checked', controls: 'Visual check at the inspection point', s: '8', o: '4', d: '5' }));
    await u.step('PFMEA analysis complete', () => u.click('[data-action=mnv-pfmea-analysis-done]'));
    await u.step('PFMEA action on the high-risk row', async () => {
      const f = '#' + await u.page.locator('#main form[id^=pfm-action-form]').first().getAttribute('id');
      await submitForm(u, f, { action: 'Add a tie-spacing gauge check', owner: 'Master Access', due: u.today(14) });
      const c = '#' + await u.page.locator('#main form[id^=pfm-close-form]').first().getAttribute('id');
      await submitForm(u, c, { evidence: 'Gauge check added to the WI step.', s: '8', o: '2', d: '3' });
    });
    await u.step('send to the Safety Team', () => u.click('[data-action=mnv-pfmea-actions-done]'));
    await u.step('Safety Team buy-off by the same person', () => submitForm(u, '#pfm-safety-form', { decision: 'Approve', note: 'Controls adequate for every failure mode.' }));
    const p = await pfmeaOf(u, pf), rel = await wiOf(u, w.id, w.revision);
    u.check(`${pf} approved by the Safety Team and ${w.id} released`, p.status === 'Approved' && rel.status === 'Released', `${p.status} ${rel.status}`);
    u.check('the WI author also peer-reviewed and released it (demo)', rel.status === 'Released', rel.status);
    // A released WI revised to take in an MCR, then peer reviewed and released by the same person.
    const mcr = await u.step('raise an MCR on MWI-0009', async () => {
      await u.nav('mnv-changes');
      await u.page.locator('#main [data-action=ecr-new]').filter({ hasText: 'MCR' }).first().click(); await u.settle();
      await u.fill('#dialog[open]', { wi: 'MWI-0009|A' }); await u.wait(200);
      const op = await u.page.locator('#dialog[open] [name=opId] option').evaluateAll(os => os.map(o => o.value).find(Boolean));
      await u.fill('#dialog[open]', { opId: op, title: 'State the torque unit', description: 'Add in-lb to step B.', reason: 'Floor query.' });
      await u.submitDialog('Raise MCR');
      const id = await u.read(() => state.ecrRequests.find(e => e.title === 'State the torque unit' && e.wiId === 'MWI-0009')?.id);
      if (!id) throw new Error('MCR not raised: ' + await u.toast());
      return id;
    });
    const rev = await u.step(`revise MWI-0009 and incorporate ${mcr}`, async () => {
      await openWI(u, 'MWI-0009', 'A');
      await u.click('[data-action=wi-revise]');
      const box = u.page.locator(`#dialog[open] input[name=incorporate][value="${mcr}"]`);
      if (!await box.count()) throw new Error(`${mcr} is not offered in the Revise dialog`);
      await box.check();
      await u.submitDialog('Start Rev');
      const d = await u.read(() => state.masterWIs.find(x => x.id === 'MWI-0009' && x.status === 'Draft')?.revision);
      if (!d) throw new Error('no draft revision: ' + await u.toast());
      return d;
    });
    await u.step('record the release ECO, peer review and release by the same person', async () => {
      await openWI(u, 'MWI-0009', rev);
      await submitForm(u, '#wi-drawing-form', { eco: 'ECO-3102' });
      await u.click('[data-action=wi-peer-review]'); if (await u.dialogOpen()) await u.submitDialog();
      await u.click('[data-action=wi-release]'); if (await u.dialogOpen()) await u.submitDialog();
      const s = (await wiOf(u, 'MWI-0009', rev)).status;
      if (s !== 'Released') throw new Error('MWI-0009 Rev ' + rev + ' is ' + s + ': ' + await u.toast());
    });
    const m = await ecrOf(u, mcr);
    u.check(`${mcr} closed as incorporated when Rev ${rev} was released`, /incorporated/i.test(m.status), m.status);
    return `${w.id} Released via ${pf}; MWI-0009 Rev ${rev} Released with ${mcr}`;
  },
};

// ---------- changes to an open work order: engineering change, split, pedigree, closure ----------
async function reviewEngineering(u, id) {
  for (let i = 0; i < 3; i++) {
    await u.openOrder(id); await u.orderTab('record');
    const action = await u.read(() => [...document.querySelectorAll('#main [data-action=review-ecr],#main [data-action=review-engineering]')].map(b => b.dataset.action)[0]);
    if (!action) break;
    await u.click(`[data-action=${action}]`);
    await u.fill('#dialog[open]', { acknowledge: true });
    await u.page.locator('#dialog[open] form button[type=submit]').filter({ hasNotText: /Reject|Return/ }).last().click(); await u.wait(450);
  }
  if (await u.read(i => !!MES.engineeringChange(MES.getOrder(state, i)), id)) throw new Error('engineering change still pending: ' + await u.toast());
}

const orderChanges = {
  name: 'orderchg', title: 'Open work order: engineering change, split, pedigree change, closure',
  async run(u) {
    const id = await u.step('create a Production order for three units', () => createOrderFromWI(u, 'MWI-0002|A', { quantity: 3, fai: false }));
    // Split runs before the engineering change: splitting an order whose engineering change was applied leaves an
    // invalid workspace and save() sets the parent order aside (production bug, reported separately).
    const child = await u.step('split one unit onto a new order', async () => {
      await u.openOrder(id);
      await u.click('[data-action=split-order]');
      await u.fill('#dialog[open]', { quantity: '1' });
      await u.submitDialog('Create split order');
      const c = await u.read(i => state.orders.find(o => o.id !== i && o.id.startsWith(i))?.id, id);
      if (!c) throw new Error('no split order: ' + await u.toast());
      return c;
    });
    u.check(`${id} keeps 2 units and ${child} has 1`, (await u.order(id))?.quantity === 2 && (await u.order(child))?.quantity === 1, `${(await u.order(id))?.quantity}/${(await u.order(child))?.quantity}`);
    await u.step('propose an engineering change (quantity 2 to 3)', async () => {
      await u.openOrder(id);
      await u.click('[data-action=engineering-change]');
      await u.click('[data-action=ecr-wo-edit]', { root: '#dialog[open]' });
      await u.fill('#dialog[open]', { quantity: '3', reason: 'Customer added one unit.' });
      await u.submitDialog('Submit');
      if (!await u.read(i => !!MES.engineeringChange(MES.getOrder(state, i)), id)) throw new Error('no engineering change pending: ' + await u.toast());
    });
    await u.step('ECR approval and QA re-release by the requester', () => reviewEngineering(u, id));
    u.check('the engineering change applied (quantity 3)', (await u.order(id)).quantity === 3, (await u.order(id)).quantity);
    await u.step('request a pedigree change to Development', async () => {
      await u.openOrder(id);
      await u.click('[data-action=pedigree-change]');
      await u.fill('#dialog[open]', { pedigree: 'Development', reason: 'Units reassigned to the test fleet.' });
      await u.submitDialog('Request change');
      if (!(await u.order(id)).pedigreeChange) throw new Error('no pedigree change requested: ' + await u.toast());
    });
    await u.step('approve the pedigree change (both approvals by the requester)', async () => {
      for (let i = 0; i < 3 && (await u.order(id)).pedigreeChange; i++) {
        await u.openOrder(id);
        for (const t of ['record', 'operations']) { if (await u.page.locator('#main [data-action=pedigree-approve]').count()) break; await u.orderTab(t); }
        await u.click('[data-action=pedigree-approve]');
        if (await u.dialogOpen()) { if (await u.page.locator('#dialog[open] [name=acknowledge]').count()) await u.fill('#dialog[open]', { acknowledge: true }); await u.submitDialog(); }
        if (i === 0 && (await u.order(id)).pedigreeChange) {
          // D-56: after the first approval the demo tells one person they may give the second, not to find another discipline.
          const said = await u.toast(), panel = await u.page.locator('#main').innerText().catch(() => '');
          u.check('after the first pedigree approval the demo does not send the solo user to another discipline', !/different discipline/i.test(said + panel) && /in this demo the same person may give it/.test(said), said);
        }
      }
      const o = await u.order(id);
      if (o.pedigreeChange || o.pedigree !== 'Development') throw new Error(`pedigree is ${o.pedigree}, change ${JSON.stringify(o.pedigreeChange)}: ` + await u.toast());
    });
    await u.step(`request closure of ${child} as Obsolete`, async () => {
      await u.openOrder(child);
      await u.click('[data-action=closure-request]');
      await u.fill('#dialog[open]', { reason: 'Obsolete', note: 'Demand reduced by one unit.' });
      await u.submitDialog('Request closure');
      if (!(await u.order(child)).closureRequest) throw new Error('no closure requested: ' + await u.toast());
    });
    await u.step('approve the closure (requester)', async () => {
      await u.openOrder(child);
      for (const t of ['record', 'operations']) { if (await u.page.locator('#main [data-action=closure-decide]').count()) break; await u.orderTab(t); }
      const review = u.page.locator('#main [data-action=closure-decide]').first();
      if (!await review.count()) throw new Error('no Review closure control for the requester: ' + (await u.page.locator('#main .closure-pending').innerText().catch(() => '')).slice(0, 200));
      // D-57: the banner next to Review closure does not tell the requester to find a different person.
      const banner = await u.page.locator('#main').innerText().catch(() => '');
      u.check('the pending closure banner gives the requester the solo next step', !/approval from a different person/i.test(banner) && /in this demo the requester may review it/.test(banner), banner.slice(0, 200));
      await review.click(); await u.settle();
      if (await u.dialogOpen()) { if (await u.page.locator('#dialog[open] [name=acknowledge]').count()) await u.fill('#dialog[open]', { acknowledge: true }); const note = u.page.locator('#dialog[open] textarea').first(); if (await note.count()) await note.fill('Approved: demand reduced.'); await u.submitDialog(); }
      const o = await u.order(child);
      if (o.status !== 'Closed') throw new Error(`${child} is ${o.status}: ` + await u.toast());
    });
    const o = await u.order(id), c = await u.order(child);
    return `${id} qty ${o.quantity} ${o.pedigree}; ${child} ${c.status} as ${c.closedAs}`;
  },
};

// ---------- Flight Plan: planned order to work order, kanban, Today's Big Three ----------
const plannedOf = (u, id) => u.read(i => JSON.parse(JSON.stringify((state.plannedOrders || []).find(x => x.id === i))), id);
async function answerDialog(u, defaults = {}) {
  if (!(await u.dialogOpen())) return;
  for (const [name, value] of Object.entries(defaults)) if (await u.page.locator(`#dialog[open] [name="${name}"]`).count()) await u.fill('#dialog[open]', { [name]: value });
  for (const t of await u.page.locator('#dialog[open] textarea[required], #dialog[open] input[required]:not([type=checkbox]):not([type=radio])').all()) if (!(await t.inputValue())) await t.fill('Recorded in the demo walk-through.');
  for (const c of await u.page.locator('#dialog[open] input[type=checkbox][required]').all()) await c.check();
  await u.submitDialog();
}
const plan = {
  name: 'plan', title: "Flight Plan: planned order to work order, kanban, Big Three, maintenance",
  async run(u) {
    const id = await u.step('plan an order from master WI MWI-0004', async () => {
      await u.nav('plan');
      await u.click('[data-action=plan-create]');
      await u.fill('#dialog[open]', { masterWI: 'MWI-0004|A' }); await u.wait(150);
      await u.fill('#dialog[open]', { quantity: '2', needDate: u.today(20), pedigree: 'Production', subcategory: 'Mfg.' });
      await u.submitDialog('Plan order');
      const p = await u.read(() => (state.plannedOrders || []).slice(-1)[0]?.id);
      if (!p) throw new Error('no planned order: ' + await u.toast());
      return p;
    });
    await u.step('kanban: firm the planned order', async () => {
      await u.nav('plan-kanban');
      await u.click(`[data-action=plan-firm][data-plan="${id}"]`);
      await answerDialog(u, { shortage: 'NetSuite shows 0 on hand; purchasing notified.' });
      const p = await plannedOf(u, id);
      if (p.status === 'Planned') throw new Error('still Planned: ' + await u.toast());
    });
    const wo = await u.step('kanban: convert to a Flight Control work order', async () => {
      await u.nav('plan-kanban');
      const conv = u.page.locator(`#main [data-action=plan-convert][data-plan="${id}"]`).first();
      if (!await conv.count()) throw new Error(`no Convert control; ${id} is ${(await plannedOf(u, id)).status}`);
      await conv.click(); await u.settle();
      await answerDialog(u);
      const p = await plannedOf(u, id);
      if (p.status !== 'Converted' || !p.workOrder?.id) throw new Error(`not converted (${p.status}): ` + await u.toast());
      return p.workOrder.id;
    });
    u.check(`${wo} exists as a draft work order`, (await u.order(wo))?.status === 'Draft', (await u.order(wo))?.status);
    await u.step("set today's Big Three", async () => {
      await u.nav('plan');
      if (await u.page.locator('#main [data-action=big3-create]').count()) await u.click('[data-action=big3-create]');
      if (!await u.page.locator('#main [data-action=big3-decide][data-decision=accept]').count()) throw new Error('no Big Three tasks to accept: ' + await u.toast());
    });
    await u.step('accept every Big Three task', async () => {
      for (let i = 0; i < 3; i++) { const a = u.page.locator('#main [data-action=big3-decide][data-decision=accept]').first(); if (!await a.count()) break; await a.click(); await u.settle(); }
      const slots = await u.read(() => { const d = new Date().toISOString().slice(0, 10), me = skAuth.user().username; return state.planner.days[me][d].big3.filter(s => s.t).map(s => s.status); });
      if (!slots.length || slots.some(s => s !== 'accepted')) throw new Error('not all accepted: ' + slots.join(','));
    });
    await u.step('carry the accepted tasks to tomorrow', async () => {
      await u.click('[data-action=big3-carry]');
      await answerDialog(u);
      const carried = await u.read(() => { const t = new Date(Date.now() + 86400000).toISOString().slice(0, 10), me = skAuth.user().username; return (state.planner.days[me][t]?.big3 || []).filter(s => s.t).length; });
      if (!carried) throw new Error('nothing carried to tomorrow: ' + await u.toast());
    });
    const mnt = await u.step('take a tool out of service for maintenance', async () => {
      await u.nav('plan');
      const box = u.page.locator('#main details.fr-equipment-setup');
      if (!(await box.evaluate(d => d.open))) { await box.locator('summary').click(); await u.settle(); }
      const f = box.locator('form').filter({ has: u.page.locator('[name=assetTag]') }).first();
      await f.locator('[name=description]').fill('Torque check drifted; sent for adjustment.');
      const before = await u.read(() => (state.resources?.maintenance || []).length);
      await f.locator('button[type=submit]').click(); await u.wait(450);
      const m = await u.read(() => (state.resources?.maintenance || []).slice(-1)[0]);
      if ((await u.read(() => (state.resources?.maintenance || []).length)) !== before + 1 || m.status !== 'Open') throw new Error('maintenance not opened: ' + await u.toast());
      return m.id;
    });
    await u.step('verify and return it to service (the person who opened it)', async () => {
      const box = u.page.locator('#main details.fr-equipment-setup');
      if (!(await box.evaluate(d => d.open))) { await box.locator('summary').click(); await u.settle(); }
      const f = box.locator('form').filter({ hasText: mnt }).first();
      await f.locator('[name=result]').fill('Adjusted and verified against the reference standard.');
      await f.locator('button[type=submit]').click(); await u.wait(450);
      const m = await u.read(i => (state.resources?.maintenance || []).find(x => x.id === i), mnt);
      if (m?.status !== 'Closed') throw new Error(`${mnt} is ${m?.status}: ` + await u.toast());
    });
    return `${id} converted to ${wo}; Big Three accepted and carried; ${mnt} opened and closed by one person`;
  },
};

// ---------- System QMS records: calibration entry, audit and finding, controlled document ----------
const qmsForm = (u, field) => u.page.locator('#main form').filter({ has: u.page.locator(`[name=${field}]`) }).first();
const qms = {
  name: 'qms', title: 'System QMS records: calibration entry, audit, controlled document',
  async run(u) {
    await u.nav('qms-records');
    const before = await u.read(() => (state.calibrationLog || []).length);
    await u.step('sign a calibration entry', async () => {
      const f = qmsForm(u, 'calibratedAt');
      await f.locator('[name=tag]').fill('SOLO-CAL-01'); await f.locator('[name=description]').fill('Digital torque wrench');
      await f.locator('[name=torque]').selectOption({ index: 1 });
      await f.locator('[name=serial]').fill('TW-55821'); await f.locator('[name=calibratedAt]').fill(u.today(-1)); await f.locator('[name=expires]').fill(u.today(364));
      await f.locator('[name=location]').fill('HHR tool crib'); await f.locator('[name=note]').fill('Calibrated by the outside lab; certificate on file.');
      await f.locator('button[type=submit]').click(); await u.wait(500);
      const after = await u.read(() => (state.calibrationLog || []).length);
      if (after !== before + 1) throw new Error('calibration entry not recorded: ' + await u.toast());
    });
    const entry = await u.read(() => JSON.parse(JSON.stringify((state.calibrationLog || []).slice(-1)[0])));
    u.check('the calibration entry is signed by master with a SHA-256 hash', JSON.stringify(entry).includes('ACCT-master') && /"[a-f0-9]{64}"/.test(JSON.stringify(entry)), JSON.stringify(entry).slice(0, 400));
    await u.step('open an audit with a finding', async () => {
      const f = qmsForm(u, 'scope');
      // D-59: the help text under the form does not tell the writer another person must close the finding.
      const help = await f.innerText().catch(() => '');
      u.check('the audit form tells the solo writer they may close the finding', !/A different person signs/.test(help) && /may also sign it closed/.test(help), help.slice(-200));
      await f.locator('[name=scope]').fill('Receiving inspection process audit');
      await f.locator('[name=findings]').fill('One bin label missing in receiving.');
      await f.locator('button[type=submit]').click(); await u.wait(450);
      if (!(await u.read(() => (state.audits || []).length))) throw new Error('audit not opened: ' + await u.toast());
    });
    await u.step('close the finding (its writer)', async () => { await u.clickText('Sign finding closed'); });
    await u.step('close the audit (its writer)', async () => { await u.clickText('Sign audit closed'); });
    const audit = await u.read(() => JSON.parse(JSON.stringify(state.audits.slice(-1)[0])));
    u.check(`${audit.id} and its finding closed by the person who opened them`, audit.status === 'Closed' && audit.findings.every(f => f.status === 'Closed'), audit.status);
    await u.step('author a controlled document', async () => {
      const f = qmsForm(u, 'documentNumber');
      await f.locator('[name=documentNumber]').fill('SOP-999-001'); await f.locator('[name=title]').fill('Solo walk-through procedure');
      await f.locator('[name=file]').setInputFiles(u.kitFile);
      await f.locator('button[type=submit]').click(); await u.wait(700);
      if (!(await u.read(() => (state.controlledDocuments || state.documents || []).length))) throw new Error('document not authored: ' + await u.toast());
    });
    await u.step('review the document (its author)', () => u.clickText('Sign review'));
    await u.step('release the document (author and reviewer)', () => u.clickText('Sign release'));
    const doc = await u.read(() => JSON.parse(JSON.stringify((state.controlledDocuments || state.documents || []).slice(-1)[0])));
    u.check(`${doc.documentNumber} released by the one person who wrote and reviewed it`, doc.status === 'Released', doc.status);
    return `calibration ${entry?.id || entry?.tag || 'recorded'}; ${audit.id} ${audit.status}; ${doc.documentNumber} ${doc.status}`;
  },
};

// ---------- Access and credentials: master acting on another account ----------
const admin = {
  name: 'admin', title: 'Admin: create an account, roles, training, stamp',
  async run(u) {
    const user = 'solo-inspector';
    // Accounts, roles, training and stamps are managed on the Admin page, one tab each (#332). Its collapsed sections are
    // opened so every form in the tab can be filled.
    const openAdmin = async tab => {
      await u.closeDialog(); await u.click('[data-admin-nav]', { root: 'body' }); await u.settle();
      await u.page.locator(`[data-admin-tab="${tab}"]`).click(); await u.settle();
      const P = `#admin-panel-${tab}`;
      if (!(await u.page.locator(P).count())) throw new Error('the Admin ' + tab + ' tab did not open');
      await u.page.evaluate(P => document.querySelectorAll(P + ' details').forEach(d => { d.open = true; }), P);
      return P;
    };
    await u.step('create an account', async () => {
      const A = await openAdmin('accounts');
      await u.fill(`${A} form[data-access-add]`, { displayName: 'Solo Inspector', username: user, password: 'demo1234' });
      const role = u.page.locator(`${A} form[data-access-add] [name=role]`);
      if (await role.count()) await role.selectOption({ label: 'Quality' }).catch(() => role.selectOption('qe'));
      await u.page.locator(`${A} form[data-access-add] button[type=submit]`).click(); await u.wait(450);
      if (!(await u.read(n => skAuth.users().some(x => x.username === n), user))) throw new Error('account not created: ' + await u.toast() + ' ' + (await u.page.locator(`${A} .access-add-error, ${A} [role=alert]`).allTextContents()).join('/'));
    });
    await u.step('record training for the new account', async () => {
      const f = `${await openAdmin('training')} form#training-record-form`;
      await u.fill(f, { account: user }); await u.wait(150);
      const code = await u.page.locator(`${f} [name=code] option`).evaluateAll(os => (os.find(o => o.value === 'ESD') || os.find(o => o.value))?.value);
      await u.fill(f, { code, expires: u.today(365), note: 'Classroom and practical, demo walk-through.' });
      await u.page.locator(`${f} button[type=submit]`).click(); await u.wait(450);
      if (!(await u.read(n => (state.trainingRecords || []).some(r => r.account === n), user))) throw new Error('training not recorded: ' + await u.toast());
    });
    await u.step('change its primary role and add a second role', async () => {
      let A = await openAdmin('accounts');
      const sel = u.page.locator(`${A} select[data-role-user="${user}"]`);
      if (!await sel.count()) throw new Error('no role control for ' + user);
      await sel.selectOption({ label: 'Quality Supervisor' }); await u.wait(450);
      if (await u.dialogOpen()) await answerDialog(u);
      const now = await u.read(n => skAuth.users().find(x => x.username === n), user);
      if (now.role !== 'qs') throw new Error('primary role not changed: ' + now.role + ' ' + await u.toast());
      A = await openAdmin('accounts');
      await u.page.locator(`${A} [data-roles-user="${user}"]`).click(); await u.settle();
      const form = `${A} form[data-access-change][data-kind=roles][data-user="${user}"]`;
      await u.page.locator(`${form} input[name=roles][value=qe]`).check();
      await u.page.locator(`${form} [name=reason]`).fill('Also performs Quality Engineering reviews, per the training record.');
      const tc = u.page.locator(`${form} [name=trainingCode]`);
      if (await tc.count()) await tc.selectOption(await tc.locator('option').evaluateAll(os => (os.find(o => o.value === 'ESD') || os.find(o => o.value))?.value));
      await u.page.locator(`${form} button[type=submit]`).click(); await u.wait(450);
      const after = await u.read(n => skAuth.users().find(x => x.username === n), user);
      if (!JSON.stringify(after).includes('"qe"')) throw new Error('second role not recorded: ' + (await u.page.locator(`${form} .access-add-error`).textContent().catch(() => '')) + ' ' + JSON.stringify(after.roles) + ' ' + await u.toast());
    });
    await u.step('issue a stamp to the new account', async () => {
      const f = `${await openAdmin('stamps')} form#stamp-issue-form`;
      const num = u.page.locator(`${f} [name=number]`); if (!(await num.inputValue())) await num.fill('SKY-0901');
      await u.fill(f, { name: 'Solo Inspector', buyoffType: 'Quality', account: user, expires: u.today(365) });
      await u.page.locator(`${f} button[type=submit]`).click(); await u.wait(450);
      if (!(await u.read(n => (state.stamps || []).some(s => s.account === n || s.holder?.account === n), user))) throw new Error('stamp not issued: ' + await u.toast());
    });
    await u.closeDialog();
    const a = await u.read(n => ({ user: skAuth.users().find(x => x.username === n), training: (state.trainingRecords || []).filter(r => r.account === n).length, stamps: (state.stamps || []).filter(s => s.account === n).length }), user);
    return `${user}: roles ${(a.user?.roles || [a.user?.role]).join('/')}, ${a.training} training record, ${a.stamps} stamp`;
  },
};

// ---------- pilot counterpart ----------
export async function pilotCounterpart(u) {
  u.setExpectRefusals(true);
  let order, tid;
  try {
    // tech: raises an NC on the floor, but cannot disposition or approve it (Technician role).
    await u.signIn('tech');
    order = await u.read(() => state.orders.find(o => o.status === 'Building' && !MES.blockingTickets(o).length && o.operations.some(x => !x.done))?.id);
    tid = await u.step('tech raises an NC on a building order', () => raiseNC(u, order, 'Pilot check: connector scuffed', 'Raised by the tech pilot seat.'));
    await openTicket(u, order, tid);
    u.check('tech is not offered the ME disposition form on their own NC', !(await u.page.locator('#dialog[open] form#ticket-dispo-form').count()), 'the disposition form is shown to tech');
    await u.closeDialog();
    const techTry = await u.read(([o, t]) => MES.dispositionTicket(structuredClone(state), o, t, { decision: 'Use as is', note: 'Self-approval attempt.' }), [order, tid]);
    u.check('the engine refuses tech recording the disposition', techTry.ok === false, JSON.stringify(techTry));
    await u.drainRefusals('tech disposition attempt');
    u.check('the refusal collector captured that refusal', u.allRefusals().some(r => r.user === 'tech' && r.text === techTry.message), JSON.stringify(u.allRefusals().slice(-3)));
    const techCaps = await u.read(() => ({ dispo: skAuth.can('dispo-nc'), approve: skAuth.can('approve-nc'), approveWo: skAuth.can('approve-wo') }));
    u.check('tech keeps the Technician role: no disposition or approval capability', !techCaps.dispo && !techCaps.approve && !techCaps.approveWo, JSON.stringify(techCaps));
    // quality: cannot write the ME disposition it would then approve, and holds only the Quality MRB seat.
    await u.signIn('quality');
    await openTicket(u, order, tid);
    u.check('quality is not offered the ME disposition form', !(await u.page.locator('#dialog[open] form#ticket-dispo-form').count()), 'the disposition form is shown to quality');
    await u.closeDialog();
    const qTry = await u.read(([o, t]) => MES.dispositionTicket(structuredClone(state), o, t, { decision: 'Use as is', note: 'Self-approval attempt.' }), [order, tid]);
    u.check('the engine refuses quality recording the disposition it would approve', qTry.ok === false, JSON.stringify(qTry));
    await u.drainRefusals('quality disposition attempt');
    // A same-person refusal shown on screen is caught: production wording the solo run must never meet.
    await u.read(() => notify('The person who requested the closure can’t approve or reject it.'));
    await u.drainRefusals('collector self-check');
    const self = u.allRefusals().filter(r => r.step === 'collector self-check');
    u.check('a same-person refusal shown in a toast is collected and recognised', self.length === 1 && u.needsAnotherPerson(self[0].text), JSON.stringify(self));
    const seats = await u.read(() => FlightManeuver.seatsForAccount());
    u.check('quality holds only the Quality MRB seat, so it cannot decide a board alone', JSON.stringify(seats) === JSON.stringify(['Quality']), JSON.stringify(seats));
  } finally {
    u.setExpectRefusals(false);
    await u.signIn('master');
  }
  // The same NC, as master: the disposition form is offered (the demo full-access account).
  await openTicket(u, order, tid);
  u.check('master is offered the disposition form on the same NC', await u.page.locator('#dialog[open] form#ticket-dispo-form').count() > 0, (await u.dialogText()).slice(0, 200));
  await u.closeDialog();
  return `${tid} on ${order}: tech and quality refused, master offered the form`;
}

export const FLOWS = [workOrder, lru, fai, ncMrb, car, stockNc, spr, changes, wi, orderChanges, plan, qms, admin];
