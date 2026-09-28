import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(new URL('../index.html', import.meta.url).pathname);
const fixture = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const match = fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(match, 'fixture has a workspace seed');
const state = host.MES.upgrade(JSON.parse(match[1]));
assert.ok(state.masterWIs.every(wi => wi.operations.every(operation => operation.topLevelType)), 'master WI operations migrate to top-level types');
assert.ok(state.orders.filter(item => item.status !== 'Closed').every(item => item.operations.every(operation => operation.topLevelType)), 'open work orders migrate to top-level types');
assert.equal(JSON.stringify(host.MES.operationType('Part Conformity')), JSON.stringify({ topLevelType: 'Conformity', subCode: 'PARTS' }), 'legacy part conformity maps to the Parts Conformity sub-code');
assert.equal(JSON.stringify(host.MES.operationType('Software Integration Lab (SIL)')), JSON.stringify({ topLevelType: 'Test', subCode: 'SIL' }), 'legacy SIL maps to the Test sub-code');
const order = state.orders.find(item => item.status === 'Draft' && item.operations.length);
assert.ok(order, 'fixture includes a draft order');
const wiState = host.MES.upgrade(JSON.parse(match[1]));
const sourceWI = wiState.masterWIs.find(item => item.status === 'Draft');
assert.ok(sourceWI, 'fixture includes a draft master WI');
const sourceWIInput = sourceWI.operations.map((item, index) => ({
  title: item.title, description: item.description,
  classification: index === 0 ? 'Source Inspection' : (item.classification || 'Manufacturing'),
  sourceInspectionCode: index === 0 ? 'CSI' : '',
  buyoffType: index === 0 ? 'Quality' : item.buyoffType,
  standardHours: item.standardHours ?? '', workCenterId: item.workCenterId || null,
  inspectionPoint: index === 0 || item.inspectionPoint, requiresTooling: item.requiresTooling,
  requiresRecording: item.requiresRecording, callouts: item.callouts || [], training: item.training || [],
  steps: item.steps.map(step => ({ title: step.title, instruction: step.instruction }))
}));
assert.equal(host.MES.saveWIOperations(wiState, sourceWI.id, sourceWI.revision, sourceWIInput).ok, true, 'master WI editor accepts registered source-inspection planning');
sourceWI.status = 'Unreleased'; sourceWI.drawingReleased = false;
const clone = host.MES.addOrder(wiState, { masterWI: `${sourceWI.id}|${sourceWI.revision}`, pedigree: 'Development NFF', subcategory: 'Mfg.', quantity: 1, aircraft: host.MES.AIRCRAFT[0], site: 'NASH' });
assert.equal(clone.ok, true, clone.message);
assert.equal(host.MES.getOrder(wiState, clone.id).operations[0].sourceInspectionPlan.code, 'CSI', 'work-order conversion preserves source-inspection sub-code and notice rules');
const admin = { username: 'source-inspector', displayName: 'Source Inspector', role: 'admin' };
const sourceOp = {
  title: 'Customer source inspection', description: 'Inspect before release', classification: 'Source Inspection',
  sourceInspectionCode: 'CSI', buyoffType: 'Quality', steps: ['Inspect parts'].join('\n'), position: 0
};

const missingCode = host.withAccount(admin, () => host.MES.addOrderOperation(state, order.id, { ...sourceOp, sourceInspectionCode: '' }), state);
assert.equal(missingCode.ok, false, 'source inspection cannot be created without a registered sub-code');
const added = host.withAccount(admin, () => host.MES.addOrderOperation(state, order.id, sourceOp), state);
assert.equal(added.ok, true, added.message);
const operation = order.operations[0];
assert.equal(operation.sourceInspectionPlan.code, 'CSI');
assert.equal(host.MES.sourceInspectionHolds(state, order).length, 1, 'an unrecorded inspection creates a visible hold');

const noAuthority = host.withAccount({ username: 'worker', displayName: 'Worker', role: 'general' }, () => host.MES.recordSourceInspection(state, order.id, operation.id, {
  agency: 'Customer', inspector: 'Inspector One', reference: 'CSI-123', notifiedDate: '2026-09-20', inspectedDate: '2026-09-21'
}), { username: 'worker', displayName: 'Worker', role: 'general' }, state);
assert.equal(noAuthority.ok, false, 'recording requires current inspection authority');

const invalidPlan = structuredClone(state);
invalidPlan.orders.find(item => item.id === order.id).operations.find(item => item.id === operation.id).sourceInspectionPlan.leadDays = -1;
assert.equal(host.MES.sourceInspectionWorkspaceValid(invalidPlan), false, 'invalid source-inspection notice rules invalidate the workspace');

const dcmaState = host.MES.upgrade(JSON.parse(match[1]));
const dcmaOrder = dcmaState.orders.find(item => item.id === order.id);
const dcmaAdded = host.withAccount(admin, () => host.MES.addOrderOperation(dcmaState, dcmaOrder.id, { ...sourceOp, sourceInspectionCode: 'DCMA', title: 'DCMA source inspection', position: 0 }), dcmaState);
assert.equal(dcmaAdded.ok, true);
const dcma = dcmaOrder.operations[0];
const tooLittleNotice = host.withAccount(admin, () => host.MES.recordSourceInspection(dcmaState, dcmaOrder.id, dcma.id, {
  agency: 'DCMA', inspector: 'Inspector Two', reference: 'DCMA-123', notifiedDate: '2026-09-24', inspectedDate: '2026-09-26'
}), dcmaState);
assert.equal(tooLittleNotice.ok, false, 'DCMA records require three calendar days notice');
const qm = { username: 'qa-manager', displayName: 'QA Manager', role: 'qm' };
const changedRegister = host.MES.sourceInspectionCodes(dcmaState).map(item => item.code === 'CSI' ? { ...item, leadDays: 2 } : { ...item });
const configChange = host.withAccount(qm, () => host.MES.saveSourceInspectionCodes(dcmaState, changedRegister, 'Add the customer notice rule.'), dcmaState);
assert.equal(configChange.ok, true, 'QA Manager can update the source register with a reason');
assert.equal(host.MES.sourceInspectionCodes(dcmaState).find(item => item.code === 'CSI').leadDays, 2, 'new work uses the saved sub-code settings');
assert.equal(host.MES.sourceInspectionWorkspaceValid(dcmaState), true, 'existing WI snapshots remain valid after register changes');
const deniedConfig = host.withAccount({ username: 'worker', displayName: 'Worker', role: 'general' }, () => host.MES.saveSourceInspectionCodes(dcmaState, changedRegister, 'Try to edit.'), dcmaState);
assert.equal(deniedConfig.ok, false, 'ordinary users cannot change QMS registers');
const inspector = { username: 'inspector', displayName: 'Independent Inspector', role: 'qe', grants: { 'inspect-steps': { trainingCode: 'ESD' } } };
assert.equal(host.withAccount(qm, () => host.MES.recordTraining(dcmaState, { account: inspector.username, code: 'ESD', expires: '2031-12-31' }), dcmaState).ok, true, 'QA Manager records the inspector training');
assert.equal(host.withAccount(inspector, () => host.capsOf(inspector, dcmaState).includes('inspect-steps'), dcmaState), false, 'inspection role remains inactive without an assigned stamp');
const inspectionStamp = host.withAccount(qm, () => host.MES.issueStamp(dcmaState, { name: inspector.displayName, buyoffType: 'Quality', account: inspector.username, expires: '2031-12-31' }), dcmaState);
assert.equal(inspectionStamp.ok, true, inspectionStamp.message);
assert.equal(host.withAccount(inspector, () => host.capsOf(inspector, dcmaState).includes('inspect-steps'), dcmaState), true, 'QA Manager assigns the current Quality stamp required for inspection');
const recorded = host.withAccount(inspector, () => host.MES.recordSourceInspection(dcmaState, dcmaOrder.id, dcma.id, {
  agency: 'DCMA', inspector: 'Inspector Two', reference: 'DCMA-124', notifiedDate: '2026-09-23', inspectedDate: '2026-09-26'
}), dcmaState);
assert.equal(recorded.ok, true, recorded.message);
assert.equal(host.MES.sourceInspectionHolds(dcmaState, dcmaOrder).length, 0, 'recording the DCMA inspection removes its hold');
assert.equal(host.MES.sourceInspectionWorkspaceValid(dcmaState), true, 'the source record manifest verifies');
assert.equal(host.withAccount(inspector, () => host.MES.recordSourceInspection(dcmaState, dcmaOrder.id, dcma.id, {
  agency: 'DCMA', inspector: 'Inspector Two', reference: 'DCMA-125', notifiedDate: '2026-09-23', inspectedDate: '2026-09-26'
}), dcmaState).ok, false, 'a source inspection cannot be recorded twice');

console.log('source inspection rules pass');
