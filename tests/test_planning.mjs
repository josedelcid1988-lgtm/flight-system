import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(new URL('../index.html', import.meta.url).pathname);
const fixtureHtml = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const seedMatch = fixtureHtml.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(seedMatch, 'the portable Flight demo fixture contains a workspace');
const state = host.MES.upgrade(JSON.parse(seedMatch[1]));
assert.ok(state, 'the Flight workspace upgrades with planner state');
host.FlightPlan.ensure(state);
host.MES.syncBlockers(state);

const validKinds = new Set(host.MES.PLANNING_BLOCKER_KINDS);
assert.ok(state.blockers.length > 0, 'source records derive actionable blockers');
assert.ok(state.blockers.filter(item => item.status === 'Open').every(item => validKinds.has(item.kind) && item.due && item.owner.cap && Array.isArray(item.owner.exclude)), 'each open blocker carries its kind, owner, due date, and exclusions');
assert.equal(host.MES.validate(state), true, 'planner state and derived blockers pass Flight validation');

const queue = host.MES.bigThree(state);
assert.equal(queue.total, queue.top.length + queue.rest.length, 'the personal priority queue reports its complete count');
assert.ok(queue.top.length <= 3, 'the queue limits the top list to three tasks');

const date = '2026-09-26';
const created = host.MES.createBigThreePlan(state, date);
assert.equal(created.ok, true);
assert.equal(created.day.big3.length, 3);
assert.ok(created.day.big3.every(slot => slot.t && slot.status === 'proposed'), 'open blocker tasks fill the day as proposals');
assert.equal(host.MES.validate(state), true, 'proposed daily tasks persist as valid planner data');
assert.equal(state.planner.calendar.connectors.google, false, 'Google Calendar is off by default');
assert.equal(state.planner.calendar.connectors.outlook, false, 'Outlook is off by default');
assert.equal(state.planner.calendar.connectors.ical, false, 'iCal is off by default');
const block = host.MES.proposeBigThreeTimeBlock(state, date, 0, '09:00', '10:00', 'Coordinate the release review');
assert.equal(block.ok, true, 'a person can propose a bounded time block for a Big Three item');
assert.equal(host.MES.decideBigThreeTimeBlock(state, block.id, 'accept').ok, true, 'the assigned person accepts the proposed time block');
assert.equal(host.MES.icalExport(state, created.username).ok, false, 'calendar export is refused while iCal is off');
assert.equal(host.MES.setPlanningCalendarSync(state, 'ical', true).ok, true, 'QA configuration can enable the iCal file adapter');
assert.equal(host.MES.setPlanningCalendarSync(state, 'google', true).ok, false, 'Google sync is refused because Datum source supplies no live OAuth connector');
const exportedCalendar = host.MES.icalExport(state, created.username);
assert.equal(exportedCalendar.ok, true, 'accepted time blocks export as iCalendar');
assert.match(exportedCalendar.ics, /BEGIN:VCALENDAR[\s\S]*UID:TB-\d{5,8}@flight-system[\s\S]*END:VCALENDAR/);
const imported = host.MES.icalImport(state, created.username, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:busy-review-1\r\nDTSTART:20260926T103000\r\nDTEND:20260926T104500\r\nSUMMARY:External, review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
assert.equal(imported.added, 1, 'iCalendar events import as busy blocks');
assert.equal(host.MES.icalImport(state, created.username, 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:busy-review-1\nDTSTART:20260926T103000\nDTEND:20260926T104500\nEND:VEVENT\nEND:VCALENDAR').added, 0, 're-importing the same event does not duplicate it');
assert.equal(host.MES.proposeBigThreeTimeBlock(state, date, 2, '10:35', '11:05').ok, false, 'imported busy blocks prevent overlapping proposals');
assert.equal(host.MES.validate(state), true, 'iCalendar busy blocks preserve valid planner state');
assert.equal(host.MES.proposeBigThreeTimeBlock(state, date, 1, '09:30', '10:30').ok, false, 'accepted time blocks cannot overlap for the same person');
assert.equal(host.MES.escalateBigThree(state, date, 1, 'Due date is at risk without a QA decision').ok, true, 'a post-notice holder can record an escalation for QA Manager follow-up');
assert.equal(host.MES.validate(state), true, 'time blocks and escalations are validated with the daily plan');

const centers = host.MES.WORK_CENTERS;
assert.equal(centers.length, 12, 'the initial register seeds the requested Nash, Hawthorne, Camarillo, and external centers');
assert.ok(!centers.some(item => item.site === 'MAPLE' || item.site === 'CMA-UNDEFINED'), 'undefined Maple and CMA work centers are not invented');
const draftWI = state.masterWIs.find(wi => wi.status === 'Draft');
if (draftWI) {
  const wiOps = draftWI.operations.map(operation => ({ title: operation.title, description: operation.description,
    buyoffType: operation.buyoffType, standardHours: '1.25', workCenterId: 'NASH-PRODUCTION',
    requiresRecording: operation.requiresRecording, requiresTooling: operation.requiresTooling,
    callouts: operation.callouts || [], training: operation.training || [], steps: operation.steps.map(step => ({ title: step.title, instruction: step.instruction })) }));
  assert.equal(host.MES.saveWIOperations(state, draftWI.id, draftWI.revision, wiOps).ok, true, 'master WI editor saves registered work center and standard hours');
  assert.equal(draftWI.operations[0].standardHours, 1.25, 'standard hours are parsed and stored as a number');
  draftWI.status = 'Unreleased';
  draftWI.drawingReleased = false;
  const cloned = host.MES.addOrder(state, { masterWI: `${draftWI.id}|${draftWI.revision}`, pedigree: 'Development NFF', subcategory: 'Mfg.', quantity: 2, aircraft: host.MES.AIRCRAFT[0], site: 'NASH' });
  assert.equal(cloned.ok, true, 'an Unreleased development-only work instruction remains usable on the allowed NFF path');
  const clonedOp = host.MES.getOrder(state, cloned.id).operations[0];
  assert.equal(clonedOp.workCenterId, 'NASH-PRODUCTION', 'work-order conversion retains the master WI work-center assignment');
  assert.equal(clonedOp.standardHours, 1.25, 'work-order conversion retains the master WI standard hours');
  const receipt = host.MES.postInventoryTransaction(state, { type: 'Receive', partNumber: draftWI.partNumber, lot: 'LOT-NFF-TEST', quantity: 4, buildClass: 'Development NFF', conformityStatus: 'Accepted', conformityRef: 'NS-COC-1', location: 'NASH', netsuiteRef: 'NS-RECEIPT-1' });
  assert.equal(receipt.ok, true, 'inventory receipt records the lot build class, conformity reference and NetSuite receipt reference');
  assert.equal(host.MES.postInventoryTransaction(state, { type: 'Issue', partNumber: draftWI.partNumber, lot: 'LOT-NFF-TEST', quantity: -2, orderId: cloned.id, location: 'NASH' }).ok, true, 'NFF stock can be issued on its allowed Development NFF path');
  const productionOrder = state.orders.find(order => order.pedigree === 'Production');
  if (productionOrder) assert.equal(host.MES.postInventoryTransaction(state, { type: 'Issue', partNumber: draftWI.partNumber, lot: 'LOT-NFF-TEST', quantity: -1, orderId: productionOrder.id, location: 'NASH' }).ok, false, 'Development NFF stock cannot enter Production through the inventory ledger');
  assert.equal(host.MES.inventoryLots(state, draftWI.partNumber).find(lot => lot.lot === 'LOT-NFF-TEST').onHand, 2, 'ledger lot on-hand reflects its receipt and issue');
  assert.equal(host.MES.postInventoryTransaction(state, { type: 'Receive', partNumber: draftWI.partNumber, lot: 'LOT-HELD-TEST', quantity: 1, buildClass: 'Development NFF', conformityStatus: 'Hold', conformityRef: 'NS-HOLD-1', location: 'NASH', netsuiteRef: 'NS-RECEIPT-2' }).ok, true, 'lots on conformity hold can be received and recorded');
  assert.equal(host.MES.availableLotsFromLedger(state, draftWI.partNumber, 'Development NFF').some(item => item.lot === 'LOT-HELD-TEST'), false, 'held lots are excluded from kit availability');
  assert.equal(host.MES.postInventoryTransaction(state, { type: 'Issue', partNumber: draftWI.partNumber, lot: 'LOT-HELD-TEST', quantity: -1, orderId: cloned.id, location: 'NASH' }).ok, false, 'held lots cannot be issued to a work order');
  assert.equal(host.MES.postInventoryTransaction(state, { type: 'Conformity', partNumber: draftWI.partNumber, lot: 'LOT-HELD-TEST', quantity: 0, conformityStatus: 'Accepted', conformityRef: 'NS-COC-2', note: 'NetSuite conformity disposition accepted' }).ok, true, 'a referenced conformity transaction can release a lot from hold');
  assert.equal(host.MES.postInventoryTransaction(state, { type: 'Issue', partNumber: draftWI.partNumber, lot: 'LOT-HELD-TEST', quantity: -1, orderId: cloned.id, location: 'NASH' }).ok, true, 'released lots can be issued within their permitted build class');
}
const assignedOrder = state.orders.find(order => order.status !== 'Closed' && order.operations.length);
assert.ok(assignedOrder, 'fixture has an open order for dispatch coverage');
const dispatchOp = assignedOrder.operations[0];
dispatchOp.workCenterId = centers.find(item => item.id === 'NASH-PRODUCTION').id;
dispatchOp.standardHours = 1.5;
const dispatch = host.MES.workCenterQueue(state, 'NASH-PRODUCTION');
assert.ok(dispatch.some(item => item.workOrderId === assignedOrder.id && item.plannedHours === 1.5 * assignedOrder.quantity), 'dispatch reports standard hours scaled by order quantity');
assert.deepEqual(dispatch.map(item => item.rank), dispatch.map((_, index) => index + 1), 'dispatch queue ranks every assigned open operation');
const otherDispatchOrders = state.orders.filter(order => order.status !== 'Closed' && order.id !== assignedOrder.id).slice(0, 2);
if (otherDispatchOrders.length === 2) {
  otherDispatchOrders[0].operations[0].workCenterId = 'NASH-PRODUCTION';
  otherDispatchOrders[0].operations[0].standardHours = 2;
  otherDispatchOrders[0].priority = 'AOG';
  otherDispatchOrders[0].sensitivity = 'Low';
  otherDispatchOrders[1].operations[0].workCenterId = 'NASH-PRODUCTION';
  otherDispatchOrders[1].operations[0].standardHours = 2;
  otherDispatchOrders[1].priority = 'Normal';
  otherDispatchOrders[1].sensitivity = 'Extra High';
  const ordered = host.MES.workCenterQueue(state, 'NASH-PRODUCTION');
  assert.equal(ordered[0].workOrderId, otherDispatchOrders[0].id, 'AOG leads the dispatch queue');
  assert.equal(ordered[1].workOrderId, otherDispatchOrders[1].id, 'sensitivity orders non-AOG work before due date');
}
const capacity = host.MES.workCenterCapacity(state, 'NASH-PRODUCTION', date);
assert.equal(capacity.availableHours, 8 * capacity.workdays, 'seed capacity is eight hours per workday over the dispatch horizon');
assert.equal(capacity.plannedHours, host.MES.workCenterQueue(state, 'NASH-PRODUCTION').reduce((sum, item) => sum + (item.remainingHours || 0), 0), 'capacity totals remaining standard hours after actual labor');
assert.equal(host.MES.workCenterQueue(state, 'NOT-A-CENTER').length, 0, 'unknown center ids return no dispatch rows');
const savedCenter = dispatchOp.workCenterId;
dispatchOp.workCenterId = 'NOT-A-CENTER';
assert.equal(host.MES.validate(state), false, 'workspace validation rejects an unregistered work-center assignment');
dispatchOp.workCenterId = savedCenter;
const savedHours = dispatchOp.standardHours;
dispatchOp.standardHours = -1;
assert.equal(host.MES.validate(state), false, 'workspace validation rejects negative standard hours');
dispatchOp.standardHours = savedHours;
assert.equal(host.MES.validate(state), true, 'assigned center and standard hour fields pass Flight validation');
const unit = host.MES.EQUIPMENT_UNITS.find(item => item.workCenterId === 'NASH-PRODUCTION');
const capacityBeforeService = host.MES.workCenterCapacity(state, unit.workCenterId, date);
const equipmentArea = host.MES.addEquipmentArea(state, { name: 'Integration bay', site: 'NASH' });
assert.equal(equipmentArea.ok, true, 'organization setup can add a site-scoped equipment area');
const linkedTool = host.MES.CAL_TOOLS[0];
const customUnit = host.MES.addEquipmentUnit(state, { name: 'Bench 4', workCenterId: unit.workCenterId, areaId: equipmentArea.area.id, toolTag: linkedTool?.tag });
assert.equal(customUnit.ok, true, 'organization setup can add a work unit and link its calibrated tool');
assert.equal(host.MES.workCenterCapacity(state, unit.workCenterId, date).availableHours, capacityBeforeService.availableHours * 2, 'an additional unit doubles the work center capacity');
const customService = host.MES.recordMaintenance(state, { assetTag: customUnit.unit.tag, type: 'Repair', description: 'Bench alignment repair' });
assert.equal(customService.ok, true, 'custom work units can receive maintenance orders');
assert.equal(host.MES.workCenterCapacity(state, unit.workCenterId, date).availableHours, capacityBeforeService.availableHours, 'custom unit downtime is reflected in dispatch capacity');
if (linkedTool) assert.equal(host.MES.toolCheck(linkedTool.tag, new Date().toISOString(), state).ok, false, 'a linked tool is unusable while its work unit is under repair');
const savedResourceProfile = state.profile;
state.profile = { ...savedResourceProfile, name: 'Bench Verifier', credentialId: 'BENCH-VERIFIER' };
assert.equal(host.MES.closeMaintenance(state, customService.id, 'Alignment verified and bench returned to service').ok, true, 'custom-unit service also enforces a separate verifier');
state.profile = savedResourceProfile;
const maintenance = host.MES.recordMaintenance(state, { assetTag: unit.tag, type: 'Preventive', description: 'Scheduled monthly service' });
assert.equal(maintenance.ok, true, 'authorized staff can open a maintenance record for a registered unit');
assert.equal(host.MES.recordMaintenance(state, { assetTag: unit.tag, type: 'Repair', description: 'Duplicate open item' }).ok, false, 'only one open maintenance action may hold an asset out of service');
assert.equal(host.MES.workCenterCapacity(state, unit.workCenterId, date).availableHours, capacityBeforeService.availableHours, 'one unavailable unit is removed from total work-center capacity');
const savedProfile = state.profile;
assert.equal(host.MES.closeMaintenance(state, maintenance.id, 'Service inspected and accepted').ok, false, 'the person who opened maintenance cannot verify their own return to service');
state.profile = { ...savedProfile, name: 'Second Verifier', credentialId: 'SECOND-VERIFIER' };
assert.equal(host.MES.closeMaintenance(state, maintenance.id, 'Service inspected and accepted').ok, true, 'a second credential can verify the maintenance result and return the unit to service');
state.profile = savedProfile;
const calibratedTool = host.MES.CAL_TOOLS[0];
if (calibratedTool) {
  const toolService = host.MES.recordMaintenance(state, { assetTag: calibratedTool.tag, type: 'Calibration', description: 'Calibration inspection required' });
  assert.equal(toolService.ok, true, 'calibrated tools can be placed under maintenance control');
  assert.equal(host.MES.toolCheck(calibratedTool.tag, new Date().toISOString(), state).ok, false, 'open tool maintenance prevents use in production operations');
  state.profile = { ...savedProfile, name: 'Tool Verifier', credentialId: 'TOOL-VERIFIER' };
  assert.equal(host.MES.closeMaintenance(state, toolService.id, 'Calibration completed and verified').ok, true, 'a separate verifier returns the calibrated tool to service');
  state.profile = savedProfile;
}
assert.equal(host.MES.validate(state), true, 'equipment maintenance, return-to-service verification and capacity state pass Flight validation');
if (calibratedTool) {
  // Maintenance separation is by person: on the server the stored profile is shared, so the signed-in account decides.
  const opener = { username: 'maint-opener', displayName: 'Maintenance Opener', role: 'qm', roles: ['qm'] };
  const second = { username: 'maint-verifier', displayName: 'Maintenance Verifier', role: 'qm', roles: ['qm'] };
  const opened = host.withAccount(opener, () => host.MES.recordMaintenance(state, { assetTag: calibratedTool.tag, type: 'Calibration', description: 'Account separation check' }), state);
  assert.equal(opened.ok, true, opened.message);
  const openedRecord = state.resources.maintenance.find(item => item.id === opened.id);
  assert.equal(openedRecord.openedBy.credentialId, 'ACCT-maint-opener', 'the opener is the signed-in account');
  state.profile = { ...savedProfile, name: 'Other Credential', credentialId: 'OTHER-CRED' };
  const self = host.withAccount(opener, () => host.MES.closeMaintenance(state, opened.id, 'Verified by the opener'), state);
  assert.equal(self.ok, false, 'the same signed-in person cannot verify their own maintenance, whatever the stored profile says');
  assert.match(self.message, /different person/);
  const verified = host.withAccount(second, () => host.MES.closeMaintenance(state, opened.id, 'Verified by a second person'), state);
  assert.equal(verified.ok, true, verified.message);
  assert.equal(openedRecord.closedBy.credentialId, 'ACCT-maint-verifier', 'the verifier is the signed-in account');
  state.profile = savedProfile;
}
if (calibratedTool) {
  // The server runs the engine with no page-level workspace, so ATP asset checks must use the workspace they are given.
  const atpAt = new Date().toISOString();
  assert.equal(host.MES.atpAssets([{ asset: calibratedTool.tag }], atpAt, state).ok, true, 'a calibrated test asset in service is accepted for an ATP buy-off on the server');
  const atpService = host.MES.recordMaintenance(state, { assetTag: calibratedTool.tag, type: 'Calibration', description: 'ATP asset recheck' });
  assert.equal(atpService.ok, true);
  const refusedAsset = host.MES.atpAssets([{ asset: calibratedTool.tag }], atpAt, state);
  assert.equal(refusedAsset.ok, false, 'a test asset under open maintenance in the given workspace is refused');
  assert.match(refusedAsset.message, /^Test asset /);
  state.profile = { ...savedProfile, name: 'Tool Verifier', credentialId: 'TOOL-VERIFIER' };
  assert.equal(host.MES.closeMaintenance(state, atpService.id, 'Calibration recheck completed').ok, true);
  state.profile = savedProfile;
}
const externalOperation = assignedOrder.operations[0];
externalOperation.classification = host.MES.EXTERNAL_CLASS;
externalOperation.workCenterId = 'HHR-EXT-TEST';
externalOperation.externalPO = { number: 'PO-EXT-2026-01' };
assert.equal(host.MES.recordExternalReceipt(state, assignedOrder.id, externalOperation.id, { erpReceipt: 'ERP-RCV-1001', supplierInspectionLot: 'SUP-LOT-91', receiptConfirmed: true }).ok, true, 'Development external work requires and accepts its simplified ERP receipt confirmation');
assert.equal(externalOperation.externalReceipt.level, 'Simplified', 'Development external receiving does not invoke the Production full inspection');
assert.equal(host.MES.validate(state), true, 'external receipt references pass Flight record validation');
const project = host.MES.createProject(state, { name: 'Datum port verification', lifecycle: 'Development', sensitivity: 'High', startDate: date, dueDate: '2026-10-30', partNumbers: [assignedOrder.partNumber] });
assert.equal(project.ok, true, 'project WBS records carry lifecycle, dates and sensitivity');
const objective = host.MES.addProjectObjective(state, { title: 'Complete Flight handover package', dueDate: '2026-10-30' });
assert.equal(objective.ok, true, 'objectives have dated statuses and accountable authors');
const milestone = host.MES.addProjectMilestone(state, { title: 'External verification ready', projectId: project.id, objectiveId: objective.id, dueDate: '2026-10-02', mustStart: true, workOrderId: assignedOrder.id });
assert.equal(milestone.ok, true, 'project and objective milestones can be dated and tied to a work order');
assert.ok(host.MES.milestoneRisks(state, date).some(item => item.id === milestone.id), 'due-soon must-start milestones enter the Hangar risk list');
assert.equal(host.MES.setProjectSensitivity(state, project.id, 'Extra High').ok, false, 'sensitivity changes require a reason');
assert.equal(host.MES.setProjectSensitivity(state, project.id, 'Extra High', 'Handover commitment is at risk').ok, true, 'project sensitivity can be raised through the governed dial with a reason');
assert.equal(host.MES.setProjectSensitivity(state, project.id, 'Low', 'Reduce risk').ok, false, 'sensitivity overrides cannot lower the current level');
assert.equal(host.MES.linkWorkOrderProject(state, assignedOrder.id, project.id).ok, true, 'work orders can be linked to their owning project');
assert.equal(host.MES.projectLaborRollup(state, project.id).workOrders, 1, 'project labor rollups follow linked work orders');
assert.ok(host.MES.createBigThreePlan(state, '2026-09-27').candidates.some(item => item.kind === 'must-start milestone'), 'must-start milestone work is lifted into the Big Three candidate set');
const sprint = host.MES.createSprint(state, { name: 'Sprint 1', workCenterId: externalOperation.workCenterId, startDate: date, endDate: '2026-10-02', backlog: [{ workOrderId: assignedOrder.id, operationId: externalOperation.id }] });
assert.equal(sprint.ok, true, 'a work-center sprint accepts its estimated backlog within available capacity');
assert.match(sprint.id, /^SPT-\d{4}$/);
assert.equal(host.MES.sprintReport(state, sprint.id).backlog, 1, 'sprint report exposes backlog and capacity');
assert.ok(Array.isArray(host.MES.sprintReport(state, sprint.id).burndown), 'sprint report includes a daily burndown from labor actuals');
assert.equal(host.MES.validate(state), true, 'project WBS, objective, milestone and sprint records pass Flight validation');
const productionExternal = state.orders.find(order => order.pedigree === 'Production' && order.operations.length);
if (productionExternal) {
  const op = productionExternal.operations[0]; op.classification = host.MES.EXTERNAL_CLASS; op.workCenterId = 'CMA-EXT-TEST'; op.externalPO = { number: 'PO-EXT-PROD-01' };
  assert.equal(host.MES.recordExternalReceipt(state, productionExternal.id, op.id, { erpReceipt: 'ERP-RCV-PROD-1', supplierInspectionLot: 'SUP-LOT-PROD-1', inspectionPassed: true }).ok, false, 'Production cannot receive external work without a full inspection reference');
  assert.equal(host.MES.recordExternalReceipt(state, productionExternal.id, op.id, { erpReceipt: 'ERP-RCV-PROD-1', supplierInspectionLot: 'SUP-LOT-PROD-1', inspectionPassed: true, inspectionRef: 'RCV-INSP-01' }).ok, true, 'Production external receipt records ERP receipt, supplier lot and full inspection');
}
{
  // External receiving is an inspection. On the server the stored workspace profile belongs to whoever saved last,
  // so a signed-in account must hold inspection authority itself: Quality role plus a current stamp assigned to it.
  const receiving = state.orders.find(order => order.operations.length && !order.operations.some(op => op.externalReceipt) && order.id !== assignedOrder.id);
  assert.ok(receiving, 'the fixture has another order for the account-bound receiving check');
  const op = receiving.operations[0]; op.classification = host.MES.EXTERNAL_CLASS; op.workCenterId = 'HHR-EXT-TEST'; op.externalPO = { number: 'PO-EXT-ACCT-01' }; op.done = false;
  const input = receiving.pedigree === 'Production' ? { erpReceipt: 'ERP-RCV-ACCT', supplierInspectionLot: 'SUP-LOT-ACCT', inspectionPassed: true, inspectionRef: 'RCV-INSP-ACCT' } : { erpReceipt: 'ERP-RCV-ACCT', supplierInspectionLot: 'SUP-LOT-ACCT', receiptConfirmed: true };
  state.profile = { ...savedProfile, name: 'Stored Quality Profile', role: 'Quality Engineer', credentialId: 'STORED-QA' };
  assert.equal(host.MES.isQAProfile(state.profile), true, 'the stored workspace profile is a Quality profile');
  const general = { username: 'general-user', displayName: 'General User', role: 'general', roles: ['general'] };
  const inspector = { username: 'qe-inspector', displayName: 'QE Inspector', role: 'qe', roles: ['qe'] };
  const manager = { username: 'qa-manager-plan', displayName: 'QA Manager', role: 'qm', roles: ['qm'] };
  const asGeneral = host.withAccount(general, () => host.MES.recordExternalReceipt(state, receiving.id, op.id, input), state);
  assert.equal(asGeneral.ok, false, 'a General account cannot record external receiving even when the stored profile is Quality');
  const unstamped = host.withAccount(inspector, () => host.MES.recordExternalReceipt(state, receiving.id, op.id, input), state);
  assert.equal(unstamped.ok, false, 'a Quality account without an assigned inspection stamp cannot record external receiving');
  assert.match(unstamped.message, /current inspection stamp/);
  assert.equal(op.externalReceipt, undefined, 'refused receipts write nothing');
  const issued = host.withAccount(manager, () => host.MES.issueStamp(state, { name: 'QE Inspector', buyoffType: 'Quality', account: 'qe-inspector', expires: '2099-12-31' }), state);
  assert.equal(issued.ok, true, issued.message);
  const received = host.withAccount(inspector, () => host.MES.recordExternalReceipt(state, receiving.id, op.id, input), state);
  assert.equal(received.ok, true, received.message);
  assert.equal(op.externalReceipt.by.credentialId, 'ACCT-qe-inspector', 'the receipt is attributed to the signed-in inspector, not the stored profile');
  assert.equal(host.MES.validate(state), true, 'the account-attributed receipt passes Flight validation');
  state.profile = savedProfile;
}
{
  // Planning authority on accounts: Operations and QA Manager create work-center sprints; only QA Manager raises project
  // sensitivity. Other roles are refused.
  const account = (username, role) => ({ username, displayName: username, role, roles: [role] });
  const ops = account('ops-planner', 'ops'), qm = account('qa-planner', 'qm'), qe = account('qe-planner', 'qe');
  const workCenterId = host.MES.WORK_CENTERS[0].id;
  const sprint = (who, name) => host.withAccount(who, () => host.MES.createSprint(state, { name, workCenterId, startDate: date, endDate: '2026-10-09', backlog: [] }), state);
  assert.equal(sprint(ops, 'Ops sprint').ok, true, 'Operations can create a work-center sprint');
  assert.equal(sprint(qm, 'QA sprint').ok, true, 'QA Manager can create a work-center sprint');
  const refusedSprint = sprint(qe, 'QE sprint');
  assert.equal(refusedSprint.ok, false, 'a Quality Engineer cannot create a work-center sprint');
  assert.match(refusedSprint.message, /cannot create a work-center sprint/);
  const project = host.withAccount(qm, () => host.MES.createProject(state, { name: 'Sensitivity authority', lifecycle: 'Development', sensitivity: 'Low', startDate: date, dueDate: '2026-11-30', partNumbers: [] }), state);
  assert.equal(project.ok, true, project.message);
  const raise = (who, level) => host.withAccount(who, () => host.MES.setProjectSensitivity(state, project.id, level, 'Customer date moved in'), state);
  assert.equal(raise(ops, 'Medium').ok, false, 'Operations cannot raise project sensitivity');
  assert.equal(raise(qe, 'Medium').ok, false, 'a Quality Engineer cannot raise project sensitivity');
  assert.equal(raise(qm, 'High').ok, true, 'QA Manager can raise project sensitivity');
}
{
  // On the shared server the stored profile can name whoever last selected it; planning records name the signed-in person.
  const savedProfile = state.profile;
  state.profile = { ...savedProfile, name: 'Earlier Manager', role: 'QA Manager', credentialId: 'STORED-EARLIER' };
  const second = { username: 'second-planner', displayName: 'Second Planner', role: 'qm', roles: ['qm'] };
  const as = fn => host.withAccount(second, fn, state);
  const plan = as(() => host.MES.createProject(state, { name: 'Attribution check', lifecycle: 'Development', sensitivity: 'Low', startDate: date, dueDate: '2026-11-30', partNumbers: [] }));
  assert.equal(plan.ok, true, plan.message);
  const goal = as(() => host.MES.addProjectObjective(state, { title: 'Attribution objective', dueDate: '2026-11-30' }));
  const mark = as(() => host.MES.addProjectMilestone(state, { title: 'Attribution milestone', projectId: plan.id, objectiveId: goal.id, dueDate: '2026-11-15' }));
  const find = (list, id) => (Array.isArray(list) ? list : []).find(item => item.id === id);
  const projects = host.MES.ensureProjects(state);
  const credentials = [find(projects.projects, plan.id).by, find(projects.objectives, goal.id).by, find(projects.milestones, mark.id).by].map(by => by && by.credentialId);
  assert.equal(JSON.stringify(credentials), JSON.stringify(Array(3).fill('ACCT-second-planner')), 'project, objective and milestone name the signed-in account, not the stored profile');
  // Flight Plan keeps its own history: planned orders name the signed-in person too.
  const wi = state.masterWIs.find(item => item.status === 'Released');
  const need = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  const planned = as(() => host.FlightPlan.addPlannedOrder(state, { masterWI: `${wi.id}|${wi.revision}`, partNumber: wi.partNumber, revision: host.MES.partDefinition(wi.partNumber)?.revision, quantity: 1, needDate: need, need, pedigree: 'Production', subcategory: 'Mfg.', aircraft: host.MES.AIRCRAFT[0], site: host.MES.SITES[0], source: 'Attribution test' }));
  assert.equal(planned.ok, true, planned.message);
  const po = host.FlightPlan.get(state, planned.id);
  assert.equal(JSON.stringify([po.createdBy.credentialId, po.history.length > 0 && po.history.every(entry => entry.actor.endsWith('ACCT-second-planner'))]), JSON.stringify(['ACCT-second-planner', true]), 'a planned order and its history name the signed-in account');
  // Controlled evidence names the signed-in reviewer on the record itself, not only in its history.
  const evidenceOrder = state.orders.find(order => order.status === 'Building' && order.operations.some(op => !op.done));
  const evidenceOp = evidenceOrder.operations.find(op => !op.done);
  const reviewed = `EV-${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`, rejected = `EV-${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`;
  for (const id of [reviewed, rejected]) assert.equal(host.MES.attachEvidence(state, evidenceOrder.id, evidenceOp.id, { id, fileName: `${id}.webm`, mimeType: 'video/webm', size: 10, source: 'upload', description: 'Attribution evidence.' }).ok, true);
  assert.equal(as(() => host.MES.reviewEvidence(state, evidenceOrder.id, evidenceOp.id, reviewed)).ok, true);
  assert.equal(as(() => host.MES.rejectEvidence(state, evidenceOrder.id, evidenceOp.id, rejected, 'Wrong operation in frame.')).ok, true);
  const byId = id => evidenceOp.evidence.find(item => item.id === id);
  assert.equal(JSON.stringify([byId(reviewed).reviewedBy.credentialId, byId(rejected).rejectedBy.credentialId]), JSON.stringify(['ACCT-second-planner', 'ACCT-second-planner']), 'evidence reviewedBy and rejectedBy name the signed-in account');
  state.profile = savedProfile;
}
{
  // Stocking is the step after QA closure, so a closed order that is ready to stock stays live until it is stocked.
  const closed = state.orders.filter(order => order.status === 'Closed');
  const waiting = closed.find(order => !order.inventory && host.MES.inventoryReadiness(state, order).ready);
  const stocked = closed.find(order => order.inventory);
  assert.ok(waiting && stocked, 'the fixture has a stocked and an unstocked closed order');
  assert.equal(host.MES.archivable(state).includes(waiting.id), false, 'a closed order waiting to be stocked is not archived');
  assert.equal(host.MES.archivable(state).includes(stocked.id), true, 'a stocked closed order is archived');
  const scrapped = structuredClone(waiting); scrapped.id = 'WO-99991'; scrapped.operations = scrapped.operations.map((op, n) => n ? { ...op, done: false } : op);
  assert.equal(host.MES.archivable({ ...state, orders: [scrapped] }).includes('WO-99991'), true, 'a closure that can never be stocked is archived at once');
}
const buildingOrder = state.orders.find(order => order.status === 'Building' && order.operations.some(item => !item.done));
if (buildingOrder) {
  const current = buildingOrder.operations.find(item => !item.done);
  assert.equal(host.MES.clockOnOperation(state, buildingOrder.id, current.id).ok, true, 'an operator can clock on to the current operation');
  assert.equal(host.MES.clockOnOperation(state, buildingOrder.id, current.id).ok, false, 'a person cannot start a second active labor clock');
  current.clock.startedAt = new Date(Date.now() - 120000).toISOString();
  assert.equal(host.MES.clockOffOperation(state, buildingOrder.id, current.id).ok, true, 'the clock owner can record elapsed labor');
  assert.ok(host.MES.laborMinutes(current) >= 2, 'operation actuals roll up recorded minutes');
}
assert.equal(host.MES.validate(state), true, 'labor time records pass Flight validation');
const kitOrder = state.orders.find(order => order.status === 'Kitting');
if (kitOrder) {
  const kitMaterial = kitOrder.materials.find(material => host.MES.availableLotsFromLedger(state, material.partNumber, kitOrder.pedigree).length);
  if (kitMaterial) {
    const lot = host.MES.availableLotsFromLedger(state, kitMaterial.partNumber, kitOrder.pedigree)[0];
    assert.equal(host.MES.setMaterialLot(state, kitOrder.id, kitMaterial.id, lot.lot).ok, true, 'kit selection reads from the combined NetSuite snapshot and inventory ledger');
    const before = lot.onHand;
    assert.equal(host.MES.setMaterial(state, kitOrder.id, kitMaterial.id, true).ok, true, 'kit verification records an inventory issue');
    assert.equal(host.MES.inventoryLots(state, kitMaterial.partNumber).find(item => item.lot === lot.lot).onHand, before - kitMaterial.required, 'kit verification reduces lot on-hand');
    assert.equal(host.MES.setMaterial(state, kitOrder.id, kitMaterial.id, false).ok, true, 'unverifying a kit returns the material to stock');
    assert.equal(host.MES.inventoryLots(state, kitMaterial.partNumber).find(item => item.lot === lot.lot).onHand, before, 'kit unverify reverses its issue');
    // A lot sized exactly to the kit: issuing drops it to zero on-hand, and unverifying must still return it.
    const exactLot = 'LOT-KIT-EXACT', otherOrder = state.orders.find(order => order.id !== kitOrder.id && order.status !== 'Closed');
    assert.equal(host.MES.postInventoryTransaction(state, { type: 'Receive', partNumber: kitMaterial.partNumber, lot: exactLot, quantity: kitMaterial.required, buildClass: lot.buildClass || 'Production', conformityStatus: 'Accepted', conformityRef: 'NS-COC-EXACT', location: kitOrder.site || null, netsuiteRef: 'NS-RECEIPT-EXACT' }).ok, true);
    const onHand = () => host.MES.inventoryLots(state, kitMaterial.partNumber).find(item => item.lot === exactLot)?.onHand || 0;
    assert.equal(host.MES.setMaterialLot(state, kitOrder.id, kitMaterial.id, exactLot).ok, true);
    assert.equal(host.MES.setMaterial(state, kitOrder.id, kitMaterial.id, true).ok, true);
    assert.equal(onHand(), 0, 'the kit issue takes the whole lot');
    assert.equal(host.MES.setMaterial(state, kitOrder.id, kitMaterial.id, false).ok, true);
    assert.equal(onHand(), kitMaterial.required, 'unverifying returns what the order issued even though the lot had reached zero');
    const returned = host.MES.inventoryLots(state, kitMaterial.partNumber).find(item => item.lot === exactLot);
    assert.equal(returned.conformityStatus, 'Accepted', 'a return into a depleted lot keeps its conformity status');
    assert.equal(returned.buildClass, lot.buildClass || 'Production', 'a return into a depleted lot keeps its build class');
    // Another order takes the whole lot after it was chosen: confirming the kit is refused and nothing is issued.
    assert.ok(otherOrder, 'the fixture has a second open order');
    const takeAll = host.MES.postInventoryTransaction(state, { type: 'Issue', partNumber: kitMaterial.partNumber, lot: exactLot, quantity: -kitMaterial.required, orderId: otherOrder.id, location: kitOrder.site || null });
    assert.equal(takeAll.ok, true, takeAll.message);
    const ledgerSize = state.inventoryLedger.transactions.length;
    const unavailable = host.MES.setMaterial(state, kitOrder.id, kitMaterial.id, true);
    assert.equal(unavailable.ok, false, 'a lot that is no longer available cannot be confirmed');
    assert.match(unavailable.message, /is no longer available/);
    assert.equal(kitMaterial.ready, false, 'the refused material stays unconfirmed');
    assert.equal(state.inventoryLedger.transactions.length, ledgerSize, 'a refused confirmation posts no inventory transaction');
    assert.equal(host.MES.setMaterialLot(state, kitOrder.id, kitMaterial.id, lot.lot).ok, true, 'another available lot can be chosen instead');
  }
}
assert.equal(host.MES.validate(state), true, 'inventory ledger, kit transactions and labor records pass Flight validation');

const declinedId = created.day.big3[0].ref.id;
const decline = host.MES.decideBigThree(state, date, 0, 'decline', 'Waiting on the supplier update');
assert.equal(decline.ok, true);
assert.equal(state.planner.signals.at(-1).reason, 'Waiting on the supplier update', 'a decline records its reason');
assert.ok(!decline.day.big3.some(slot => slot.ref?.id === declinedId), 'a declined task is not proposed again on the same day');
const nextIndex = decline.day.big3.findIndex(slot => slot.t);
assert.equal(host.MES.decideBigThree(state, date, nextIndex, 'accept').ok, true, 'the person can accept the next proposal');
const accepted = state.planner.days[state.planner.signals.at(-1).username][date].big3.find(slot => slot.status === 'accepted');
assert.ok(accepted, 'acceptance is kept on the person day');

const carried = host.MES.carryBigThree(state, date);
assert.equal(carried.ok, true);
const tomorrow = '2026-09-27';
assert.ok(state.planner.days[state.planner.signals.at(-1).username][tomorrow].big3.some(slot => slot.src === 'carried' && slot.status === 'proposed'), 'accepted unfinished work carries into tomorrow as a proposal');

const plan = (state.plannedOrders || []).find(item => item.status === 'Planned');
if (plan) {
  const existing = state.blockers.find(item => item.status === 'Open' && item.blocked.id === plan.id);
  if (existing) {
    const cancelled = host.FlightPlan.cancel(state, plan.id, 'Demand withdrawn for planner integration test');
    assert.equal(cancelled.ok, true);
    host.MES.syncBlockers(state);
    assert.equal(state.blockers.find(item => item.id === existing.id).status, 'Void', 'a source cancellation voids its open blocker through re-derivation');
  }
}
assert.equal(host.MES.validate(state), true);
console.log('planning: derived blockers, Big Three, time blocks, work-center capacity, equipment maintenance, external receiving, projects, sensitivity, objectives, milestones, sprints, labor rollups and build-class inventory passed');
