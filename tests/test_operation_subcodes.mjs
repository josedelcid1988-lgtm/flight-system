import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(new URL('../index.html', import.meta.url).pathname);
const fixture = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const match = fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(match);
const state = host.MES.upgrade(JSON.parse(match[1]));
const qm = { username: 'qa-manager', displayName: 'QA Manager', role: 'qm' };
const invalid = host.withAccount(qm, () => host.MES.saveOperationSubcodes(state, 'conformity', [{ code: 'BAD', name: 'Missing SOP', reference: '' }], 'Test invalid configuration.'), state);
assert.equal(invalid.ok, false, 'Conformity sub-codes require a valid SOP reference');
const saved = host.withAccount(qm, () => host.MES.saveOperationSubcodes(state, 'conformity', [
  { code: 'PARTS', name: 'Parts Conformity', reference: 'SOP-860-002' },
  { code: 'SETUP', name: 'Test Setup Conformity', reference: 'SOP-860-003' },
  { code: 'INSTALL', name: 'Installation Conformity', reference: 'SOP-860-004' },
  { code: 'LOCAL', name: 'Local Verification', reference: 'SOP-860-005' }
], 'Add organization-specific conformity review.'), state);
assert.equal(saved.ok, true, saved.message);
assert.equal(host.MES.conformitySubcodes(state).find(item => item.code === 'LOCAL').reference, 'SOP-860-005');
assert.equal(host.MES.sourceInspectionWorkspaceValid(state), true, 'configuration history and registers validate');

const order = state.orders.find(item => item.status === 'Draft' && item.operations.length);
assert.ok(order, 'fixture contains a draft order');
const common = { title: 'Configure sub-coded operation', description: 'Exercise the registered operation sub-code.', buyoffType: 'Engineering', steps: 'Record the result', position: 0 };
const noCode = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.addOrderOperation(state, order.id, { ...common, classification: 'Test' }), state);
assert.equal(noCode.ok, false, 'Test operations require a registered sub-code');
const testAdded = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.addOrderOperation(state, order.id, { ...common, classification: 'Test', operationSubcode: 'HIL' }), state);
assert.equal(testAdded.ok, false, 'SIL and HIL also require an HTTPS software baseline');
const linkedTest = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.addOrderOperation(state, order.id, { ...common, classification: 'Test', operationSubcode: 'HIL', atpRepo: 'https://git.example.test/flight/hil', atpVersion: 'v3.2.1', atpSha: 'a'.repeat(40) }), state);
assert.equal(linkedTest.ok, true, linkedTest.message);
const testOperation = order.operations.find(item => item.id === linkedTest.opId) || order.operations.find(item => item.classification === 'Test');
assert.equal(testOperation.topLevelType, 'Test');
assert.equal(testOperation.subCode, 'HIL');
assert.equal(host.MES.isTestOperation(testOperation), true, 'SIL and HIL use the calibrated test-asset gate');
assert.equal(testOperation.atp.baseline.version, 'v3.2.1', 'HIL captures the approved software baseline');

const wiState = host.MES.upgrade(JSON.parse(match[1]));
const draftWI = wiState.masterWIs.find(item => item.status === 'Draft');
assert.ok(draftWI, 'fixture contains a draft master WI');
const wiOperation = { title: 'HIL verification', description: 'Verify hardware integration.', classification: 'Test', operationSubcode: 'HIL', buyoffType: 'Engineering', steps: [{ title: 'Run test', instruction: 'Record the result.' }] };
const missingWIBaseline = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.saveWIOperations(wiState, draftWI.id, draftWI.revision, [wiOperation]), wiState);
assert.equal(missingWIBaseline.ok, false, 'Test sub-codes cannot be planned in a WI without a baseline');
const withWIBaseline = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.saveWIOperations(wiState, draftWI.id, draftWI.revision, [{ ...wiOperation, atpRepo: 'https://git.example.test/flight/hil', atpVersion: 'v3.2.1', atpSha: 'b'.repeat(40) }]), wiState);
assert.equal(withWIBaseline.ok, true, withWIBaseline.message);
assert.equal(draftWI.operations[0].atp.baseline.version, 'v3.2.1', 'master WI preserves the approved test baseline');

const inspectionWI = host.MES.upgrade(JSON.parse(match[1]));
const inspectionDraft = inspectionWI.masterWIs.find(item => item.status === 'Draft');
const inspectionOp = { title: 'Final inspection', description: 'Inspect completed work.', classification: 'Inspection', buyoffType: 'Quality', steps: [{ title: 'Attacker supplied title', instruction: 'Attacker supplied instruction.' }, { title: 'Measure features', instruction: 'Record results.' }] };
const savedInspection = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.saveWIOperations(inspectionWI, inspectionDraft.id, inspectionDraft.revision, [inspectionOp]), inspectionWI);
assert.equal(savedInspection.ok, true, savedInspection.message);
assert.equal(inspectionDraft.operations[0].steps[0].id, 'inspection-step-A');
assert.equal(inspectionDraft.operations[0].steps[0].title, host.MES.STD_INSPECTION.title, 'inspection Step A is restored from the controlled standard');
assert.equal(inspectionDraft.operations[0].steps[0].instruction, host.MES.STD_INSPECTION.text);
assert.equal(inspectionDraft.operations[0].steps[0].locked, true);
assert.equal(inspectionDraft.operations[0].steps[1].title, 'Attacker supplied title', 'supplied content remains as Step B');
const resavedInspection = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.saveWIOperations(inspectionWI, inspectionDraft.id, inspectionDraft.revision, [{ ...inspectionOp, steps: [{ title: host.MES.STD_INSPECTION.title, instruction: host.MES.STD_INSPECTION.text }, { title: 'Measure features', instruction: 'Record results.' }] }]), inspectionWI);
assert.equal(resavedInspection.ok, true, resavedInspection.message);
assert.equal(inspectionDraft.operations[0].steps.length, 2, 'resaving a WI does not duplicate standard Step A');
assert.equal(inspectionDraft.operations[0].steps.filter(step => step.title === host.MES.STD_INSPECTION.title && step.instruction === host.MES.STD_INSPECTION.text).length, 1);
const imageAttempt = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.setWIStepImage(inspectionWI, inspectionDraft.id, inspectionDraft.revision, inspectionDraft.operations[0].id, 'inspection-step-A', { dataUrl: 'data:image/png;base64,AAAA', caption: '', name: '' }), inspectionWI);
assert.equal(imageAttempt.ok, false, 'the standard Step A cannot be edited through image APIs');

const conformityAdded = host.withAccount({ username: 'admin', displayName: 'Master', role: 'admin' }, () => host.MES.addOrderOperation(state, order.id, { ...common, classification: 'Conformity', operationSubcode: 'PARTS', buyoffType: 'Conformity Inspector', title: 'Parts conformity' }), state);
assert.equal(conformityAdded.ok, true, conformityAdded.message);
const partsOperation = order.operations.find(item => item.id === conformityAdded.operation?.id) || order.operations.find(item => item.classification === 'Conformity');
assert.equal(partsOperation.topLevelType, 'Conformity');
assert.equal(partsOperation.subCode, 'PARTS');
assert.equal(host.MES.isPartsConformityOperation(partsOperation), true, 'Parts Conformity retains the existing package gate');
assert.equal(host.MES.validate(state), true, 'registered sub-coded operation changes preserve a valid workspace');

console.log('operation sub-code rules pass');
