// Load Flight System's actual rule engines in a Node vm. The server does not
// maintain a second implementation of Flight's gates.
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';

const SCRIPT_RE = /<script(?:\s+id="([^"]*)")?>([\s\S]*?)<\/script>/g;
const ENGINE_MATCHERS = [
  ['mes', body => body.includes('root.MES = MES')],
  ['flightPlan', body => body.includes('root.FlightPlan = FlightPlan')],
  ['flightManeuver', body => body.includes('root.FlightManeuver = FlightManeuver')],
  ['print', body => body.includes('root.MESPrint = MESPrint')]
];

export function extractBlocks(html) {
  const found = {};
  for (const match of html.matchAll(SCRIPT_RE)) {
    for (const [key, test] of ENGINE_MATCHERS) {
      if (!found[key] && test(match[2])) found[key] = match[2];
    }
  }
  const missing = ENGINE_MATCHERS.map(([key]) => key).filter(key => !found[key]);
  if (missing.length) throw new Error(`index.html is missing Flight engine blocks: ${missing.join(', ')}`);

  const roles = html.match(/var ROLES=\[[\s\S]*?\n \];/);
  const everyone = html.match(/var EVERYONE=\[[^\n]*\];/);
  const caps = html.match(/var ROLE_CAPS=\{[\s\S]*?\n \};/);
  const labels = html.match(/var CAP_LABELS=\{[^\n]*\};/);
  if (!roles || !everyone || !caps) throw new Error('index.html is missing the account role table');
  found.roles = `${roles[0]}\n${everyone[0]}\n${caps[0]}\nROLE_CAPS.admin=Array.from(new Set(Object.values(ROLE_CAPS).flat()));\n${labels ? labels[0] : 'var CAP_LABELS={};'}\nwindow.__roles={ROLES:ROLES,ROLE_CAPS:ROLE_CAPS,EVERYONE:EVERYONE,CAP_LABELS:CAP_LABELS};`;
  return found;
}

export function createHost(indexPath, html = fs.readFileSync(indexPath, 'utf8')) {
  const blocks = extractBlocks(html);
  const sandbox = { console, TextEncoder, TextDecoder, structuredClone, crypto: webcrypto, setTimeout, clearTimeout, URL };
  // MES.buildStamp() reads the build meta tags from the page. The server has no page, so it answers those two
  // lookups from the HTML it serves, and records written by server actions carry the same stamp as the page.
  const meta = name => (html.match(new RegExp(`<meta name="${name}" content="([^"]*)">`)) || [])[1] || '';
  sandbox.document = { querySelector: selector => { const name = (String(selector).match(/^meta\[name="(fs-build|fs-build-sha256)"\]$/) || [])[1]; return name ? { getAttribute: () => meta(name) } : null; } };
  sandbox.window = sandbox;
  // The engine archives superseded calibration entries only where an archive store exists (#130): here, the server's
  // host. A browser page without the server refuses the archive.
  sandbox.flightServerHost = true;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const key of ['roles', 'mes', 'flightPlan', 'flightManeuver', 'print']) {
    vm.runInContext(blocks[key], context, { filename: `index.html#${key}` });
  }
  const { MES, FlightPlan, FlightManeuver, MESPrint, __roles: roles } = sandbox;
  const rolesOf = (account, state, at) => {
    const primary = roles.ROLES.some(role => role.key === (account && account.role)) ? account.role : 'general';
    const standard = (Array.isArray(account && account.roles) ? account.roles : [primary]).filter(key => roles.ROLES.some(role => role.key === key));
    const valid = [...new Set([primary, ...standard])];
    for (const key of (Array.isArray(account && account.extraRoles) ? account.extraRoles : [])) {
      if (!roles.ROLES.some(role => role.key === key) || valid.includes(key)) continue;
      const code = account.roleTraining && account.roleTraining[key] && account.roleTraining[key].code;
      if (trainingCurrent(state, account, code, at)) valid.push(key);
    }
    return valid;
  };
  // `at` is an ISO instant; left out, every check reads the current time. The access review passes the one instant it reports.
  const trainingCurrent = (state, account, code, at) => {
    if (!state || !account || !code || typeof MES.trainingCurrentFor !== 'function') return false;
    try { return MES.trainingCurrentFor(state, account.username, code, at).ok === true; } catch { return false; }
  };
  const grantedCaps = ['conformity', 'aqi-sign'];
  const grantValid = (account, cap, grant) => {
    if (!account || !grant || grant.revokedAt || !grant.by || grant.by.account === account.username ||
        grant.by.credentialId !== `ACCT-${grant.by.account}` || !String(grant.by.name || '').trim() ||
        !Number.isFinite(Date.parse(grant.at || '')) || String(grant.reason || '').trim().length < 10 || !grant.trainingCode ||
        !/^[0-9a-f]{64}$/.test(String(grant.hash || ''))) return false;
    const record = { account: account.username, authority: cap, action: 'granted', by: grant.by, at: grant.at, reason: grant.reason, trainingCode: grant.trainingCode };
    const expected = createHash('sha256').update(MES.canonical(record)).digest('hex');
    return grant.hash === expected;
  };
  const roleOf = (account, state) => { const assigned = rolesOf(account, state); return assigned.includes('admin') ? 'admin' : assigned.includes('qm') ? 'qm' : assigned.includes('qs') ? 'qs' : assigned[0]; };
  const capsOf = (account, state, at) => {
    const stamped = typeof MES.hasValidInspectionStamp === 'function' && MES.hasValidInspectionStamp(state, account && account.username, at);
    const assigned = rolesOf(account, state, at);
    const held = new Set(assigned.flatMap(key => roles.ROLE_CAPS[key] || roles.EVERYONE).filter(cap => !grantedCaps.includes(cap) && (cap !== 'inspect-steps' || stamped)));
    for (const cap of grantedCaps) {
      const grant = account && account.grants && account.grants[cap];
      const eligible = assigned.some(key => (roles.ROLE_CAPS[key] || roles.EVERYONE).includes(cap));
      if (eligible && grantValid(account, cap, grant) && trainingCurrent(state, account, grant.trainingCode, at)) held.add(cap);
    }
    return [...held];
  };
  const shimFor = (account, state) => account ? {
    ROLES: roles.ROLES,
    can: cap => capsOf(account, state).includes(cap),
    roleCan: (role, cap) => (Array.isArray(role) ? role : [role]).some(key => (roles.ROLE_CAPS[key] || roles.EVERYONE).includes(cap)),
    role: () => roleOf(account, state),
    user: () => ({ username: account.username, displayName: account.displayName, role: roleOf(account, state), roles: rolesOf(account, state), supportAccess: account.supportAccess === true }),
    users: () => [],
    actor: () => {
      const role = roles.ROLES.find(item => item.key === roleOf(account, state));
      return { name: account.displayName, role: role ? role.profileRole : 'General user', roles: rolesOf(account, state), credentialId: `ACCT-${account.username}`, account: account.username, accountRole: roleOf(account, state), supportAccess: account.supportAccess === true };
    }
    ,
    supportAccess: () => account.supportAccess === true
  } : null;
  function withAccount(account, fn, state) {
    const before = sandbox.skAuth;
    sandbox.skAuth = shimFor(account, state);
    try { return fn(); } finally { sandbox.skAuth = before; }
  }
  function resolve(name) {
    const [namespace, functionName] = String(name).includes('.') ? String(name).split('.', 2) : ['MES', String(name)];
    const owners = { MES, FlightPlan, FlightManeuver };
    const owner = owners[namespace];
    return owner && typeof owner[functionName] === 'function' && !functionName.startsWith('_') ? owner[functionName] : null;
  }
  // The HTTP action route is a mutation boundary. Only engine functions that the browser
  // classifies as commands may be invoked there; getters, migration helpers and signature
  // primitives must never become remotely callable just because they are exported on MES.
  const actionName = /^(?:run|add|update|remove|delete|create|complete|close|issue|approve|reject|sign|mark|assign|advance|resolve|disposition|request|release|record|submit|start|stop|review|accept|return|void|reopen|split|move|link|verify|raise|cancel|withdraw|incorporate|peer|roll|set|save|store|open|finish|grant|revoke|capture|attach|detach|quarantine|repair|replace|send|change|configure|stamp|buyoff|log|tick|decide|vote|reset|publish|apply|import|reinspect|firm|convert|carry|propose|escalate|select|clock|aqi|post|acknowledge|edit|revise|ping|push|ical|check|notify|qa|note)/i;
  const actionExact = new Set(['containNC', 'effectivenessCheck', 'pfmeaSafetyBuyoff', 'pruneExpiredNotices']);
  const actionExclude = new Set(['repair','signManifest','verifyManifests','verifyAIActionLog','stampCheck','stampRegister','stampRegisterProblem','stampRegisterCsv','stampCredential','stampHolderFor','ticketAttachments','openProcessECRs','syncAssignments','buyoffCredential','ensure','seedDemoRecords','icalExport','openMaintenanceFor',
    // Internal record writers: each runs only inside the gated command that owns it (runSkill, a buy-off
    // override, the browser-only demo notice), so calling one directly would fabricate that record.
    'recordAIAction','logSupport','noteDemoBypassRemoved',
    // The release step of the PFMEA Safety Team buy-off: reached only through FlightManeuver.pfmeaSafetyBuyoff.
    'releaseWIFromPfmea',
    // Sets an unreadable work order aside. Only MES.repair calls it, while a workspace opens; as a remote action it
    // would let any signed-in account remove a live work order from the register.
    'quarantineOrder',
    // Rolls a work order revision for the approval that owns the change (sequence change, engineering change).
    'rollWorkOrderRevision']);

  // The reviewed commands, by namespace. The prefix rule above only proposes; a function is callable remotely
  // only when it is named here too, so a new engine export is refused until someone reviews it and adds it (the
  // page's serverMutatorAllow must carry the same list; tests/test_server.mjs compares them, and
  // tests/test_server_security.mjs fails while any command-like function is neither listed nor excluded).
  const actionAllow = new Set([
    'MES.addSavedView', 'MES.removeSavedView',
    'MES.recordCalibration', 'MES.importCalibrations', 'MES.updateCalibration', 'MES.recordCalibrationArchive',
    'MES.addAttachment', 'MES.addTicketAttachment', 'MES.removeTicketAttachment', 'MES.removeAttachment',
    'MES.logAogBroadcast', 'MES.resolveAog', 'MES.setSchedule', 'MES.editOrderOperation', 'MES.setWIStepImage',
    'MES.selectProfile', 'MES.assignSerial', 'MES.voidSerial', 'MES.moveToInventory', 'MES.markNetSuitePosted',
    'MES.addKitFile', 'MES.linkOpToTicket', 'MES.saveReworkTemplate', 'MES.removeReworkTemplate',
    'MES.saveOpAsReworkTemplate', 'MES.approveReworkTemplate', 'MES.addStandardRework', 'MES.setWIDrawing',
    'MES.releaseUnreleasedWI', 'MES.rejectInspection', 'MES.logTravelerPrint', 'MES.saveFairHeader',
    'MES.setFairIndex', 'MES.addFairForm2', 'MES.setFairTest', 'MES.addFairChar', 'MES.updateFairChar',
    'MES.verifyFair', 'MES.approveFair', 'MES.reopenFair', 'MES.startConformity', 'MES.saveConformity',
    'MES.checkConformity', 'MES.complete8130_9', 'MES.void8130_9', 'MES.aqiSign8130_9', 'MES.notifyCertification',
    'MES.addDarFinding', 'MES.acceptDarFinding', 'MES.recordDarApproval', 'MES.record8130_3', 'MES.closeConformity',
    'MES.issueFromOrder', 'MES.returnIssuedOrder', 'MES.qaReviewMasterWI', 'MES.setImpactDecision', 'MES.linkECO', 'MES.setWICriticalSafety', 'MES.addPfmeaRow', 'MES.updatePfmeaRow',
    'MES.setStampPin', 'MES.setMsdsBook', 'MES.tickFodItem', 'MES.removeKitFile', 'MES.addMasterWI', 'MES.importMasterWIs',
    'MES.updateMasterWI', 'MES.saveWIOperations', 'MES.releaseMasterWI', 'MES.reviseMasterWI', 'MES.setStepCheck',
    'MES.pushATPSoftware', 'MES.reviewATPPush', 'MES.linkATPSoftware', 'MES.addPurchaseOrder',
    'MES.requestOrderClosure', 'MES.postNotice', 'MES.acknowledgeNotice', 'MES.updateNotice',
    'MES.pruneExpiredNotices', 'MES.requestWorkOrder', 'MES.decideWORequest', 'MES.submitECRRequest',
    'MES.reviewFeedbackECR', 'MES.linkECRJira', 'MES.incorporateECRs', 'MES.decideOrderClosure', 'MES.assignWork',
    'MES.completeAssignment', 'MES.pingAssignment', 'MES.addOrderOperation', 'MES.removeOrderOperation',
    'MES.approveSequenceChange', 'MES.setMaterialLot', 'MES.releaseApproval', 'MES.approveRelease', 'MES.approveECR',
    'MES.approveEngineeringChange', 'MES.advance', 'MES.setMaterial', 'MES.setPriority', 'MES.completeOperation',
    'MES.closeOrder', 'MES.sendBackToBuilding', 'MES.addOrder', 'MES.importWorkOrders', 'MES.addAdhocOrder', 'MES.splitOrder', 'MES.splitRequestOrder',
    'MES.requestPedigreeChange', 'MES.approvePedigreeChange', 'MES.peerReviewMasterWI', 'MES.dispositionTicket',
    'MES.addNote', 'MES.createTicket', 'MES.resolveTicket', 'MES.returnDisposition', 'MES.closeSplitRequest',
    'MES.rejectEngineeringChange', 'MES.rejectSequenceChange', 'MES.rejectPedigreeChange', 'MES.returnRelease',
    'MES.returnMasterWI', 'MES.withdrawClosure', 'MES.closeECRRequest', 'MES.updateProfile', 'MES.attachEvidence',
    'MES.reviewEvidence', 'MES.rejectEvidence', 'MES.removeEvidence', 'MES.issueStamp', 'MES.updateStamp',
    'MES.addMessage', 'MES.setSlackThread', 'MES.createBigThreePlan', 'MES.decideBigThree', 'MES.carryBigThree',
    'MES.proposeBigThreeTimeBlock', 'MES.decideBigThreeTimeBlock', 'MES.escalateBigThree',
    'MES.setPlanningCalendarSync', 'MES.icalImport', 'MES.openAudit', 'MES.closeAuditFinding', 'MES.closeAudit',
    'MES.issueCertification', 'MES.approveSupplier', 'MES.storeQualityValue', 'MES.recordQualityVerdict',
    'MES.createControlledDocument', 'MES.startControlledDocumentRevision', 'MES.reviewControlledDocument',
    'MES.releaseControlledDocument', 'MES.configureModelAdapter', 'MES.setForm3Plan', 'MES.setSkillTrigger',
    'MES.runSkill', 'MES.reviewSkillDraft', 'MES.updateSkillDraft', 'MES.acceptSkillDraft', 'MES.addEquipmentArea',
    'MES.addEquipmentUnit', 'MES.createProject', 'MES.addProjectObjective', 'MES.addProjectMilestone',
    'MES.setProjectSensitivity', 'MES.linkWorkOrderProject', 'MES.createSprint', 'MES.recordMaintenance',
    'MES.closeMaintenance', 'MES.recordExternalReceipt', 'MES.clockOnOperation', 'MES.clockOffOperation',
    'MES.postInventoryTransaction', 'MES.submitEngineeringChange', 'MES.reviewFair', 'MES.recordTraining',
    'MES.saveTraining', 'MES.importStamps', 'MES.recordSupportAccess', 'MES.saveSourceInspectionCodes',
    'MES.saveOperationSubcodes', 'MES.saveMrbTrainingTiers', 'MES.recordSourceInspection',
    'FlightPlan.addPlannedOrder', 'FlightPlan.firm', 'FlightPlan.cancel', 'FlightPlan.convert',
    'FlightManeuver.raiseCAR', 'FlightManeuver.recordContainment', 'FlightManeuver.recordRootCause',
    'FlightManeuver.addAction', 'FlightManeuver.completeAction', 'FlightManeuver.verifyCAR',
    'FlightManeuver.effectivenessCheck', 'FlightManeuver.closeCAR', 'FlightManeuver.cancelCAR',
    'FlightManeuver.openMRB', 'FlightManeuver.voteMRB', 'FlightManeuver.decideMRB', 'FlightManeuver.linkCAR',
    'FlightManeuver.addRecordFile', 'FlightManeuver.removeRecordFile', 'FlightManeuver.raiseNC',
    'FlightManeuver.dispositionNC', 'FlightManeuver.containNC', 'FlightManeuver.approveNC',
    'FlightManeuver.linkReworkOrder', 'FlightManeuver.raiseSPR', 'FlightManeuver.linkSPRJira',
    'FlightManeuver.closeSPR', 'FlightManeuver.requestSCAR', 'FlightManeuver.linkSCARJira',
    'FlightManeuver.closeSCAR', 'FlightManeuver.openPFMEA', 'FlightManeuver.setPfmeaScope',
    'FlightManeuver.addPfmeaMode', 'FlightManeuver.removePfmeaMode', 'FlightManeuver.markOpNoRisk',
    'FlightManeuver.completePfmeaAnalysis', 'FlightManeuver.setPfmeaAction', 'FlightManeuver.closePfmeaAction',
    'FlightManeuver.completePfmeaActions', 'FlightManeuver.pfmeaSafetyBuyoff'
  ]);
  function resolveAction(name) {
    const text = String(name), qualified = text.includes('.') ? text : `MES.${text}`;
    const [namespace, functionName, extra] = qualified.split('.');
    if (extra !== undefined || !actionAllow.has(qualified)) return null;
    if (!(actionName.test(functionName) || actionExact.has(functionName)) || actionExclude.has(functionName)) return null;
    const owner = { MES, FlightPlan, FlightManeuver }[namespace];
    return owner && Object.hasOwn(owner, functionName) ? resolve(qualified) : null;
  }
  return { MES, FlightPlan, FlightManeuver, MESPrint, roles, withAccount, resolve, resolveAction, actionAllow, actionPattern: actionName, actionExact, actionExclude, html, capsOf, roleOf, rolesOf };
}
