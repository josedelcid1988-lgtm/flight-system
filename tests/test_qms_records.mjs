import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const state = MES.seed();
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
const reviewer = { username: 'quality-reviewer', displayName: 'Riley Reviewer', role: 'qe' };
const run = (account, fn) => host.withAccount(account, fn, state);
let checks = 0;
const check = (name, result) => { checks += 1; assert.ok(result, name); console.log(`ok ${name}`); };

check('new Flight workspaces include empty system quality registers', ['audits', 'certifications', 'supplierApprovals', 'qualityValues', 'qualityVerdicts'].every(key => Array.isArray(state[key])));
const old = structuredClone(state);
for (const key of ['audits', 'certifications', 'supplierApprovals', 'qualityValues', 'qualityVerdicts']) delete old[key];
const upgraded = MES.upgrade(old);
check('a valid existing workspace upgrades with empty system quality registers', !!upgraded && ['audits', 'certifications', 'supplierApprovals', 'qualityValues', 'qualityVerdicts'].every(key => Array.isArray(upgraded[key])) && MES.validate(upgraded));

const opened = run(qa, () => MES.openAudit(state, { scope: 'Internal process audit', findings: ['Record sample was short.'] }));
check('a person opens an audit with named findings', opened.ok && opened.id === 'AUD-0001' && MES.validate(state));
const auditId = opened.id;
const selfClose = run(qa, () => MES.closeAuditFinding(state, auditId, 'F-1'));
check('the finding author cannot close their own finding', !selfClose.ok && /different person/.test(selfClose.message));
const agentClose = run(qa, () => MES.closeAuditFinding(state, auditId, 'F-1', { agent: true }));
check('an agent cannot sign an audit finding closed', !agentClose.ok && /agent cannot close/.test(agentClose.message));
const closedFinding = run(reviewer, () => MES.closeAuditFinding(state, auditId, 'F-1'));
check('a different person closes the finding with a signed manifest', closedFinding.ok && state.audits[0].findings[0].manifest.algorithm === 'SHA-256' && MES.verifyManifests(state).ok);
const selfAuditClose = run(qa, () => MES.closeAudit(state, auditId));
check('the audit author cannot close the audit', !selfAuditClose.ok && /different person/.test(selfAuditClose.message));
const closedAudit = run(reviewer, () => MES.closeAudit(state, auditId));
check('a second person closes the audit with a signed manifest', closedAudit.ok && state.audits[0].status === 'Closed' && MES.validate(state) && MES.verifyManifests(state).ok);

check('an agent cannot issue a certification', !run(qa, () => MES.issueCertification(state, { statement: 'Process audit complete.', agent: true })).ok);
const certification = run(qa, () => MES.issueCertification(state, { statement: 'Process audit complete for this period.' }));
check('a person signs a certification and its manifest', certification.ok && state.certifications[0].manifest.signer.credentialId === 'ACCT-qa-manager' && MES.validate(state));
check('an agent cannot approve a supplier', !run(qa, () => MES.approveSupplier(state, { supplier: 'North Rivet', agent: true })).ok);
const supplier = run(qa, () => MES.approveSupplier(state, { supplier: 'North Rivet' }));
check('supplier approval is a signed decision', supplier.ok && state.supplierApprovals[0].decision === 'Approved' && MES.validate(state));

check('a quality verdict cannot cite an unstored value', !run(qa, () => MES.recordQualityVerdict(state, { kind: 'gage', valueId: 'QV-0099', verdict: 'accept' })).ok);
const gage = run(qa, () => MES.storeQualityValue(state, { kind: 'gage', value: 12.5, name: 'caliper study' }));
const capability = run(qa, () => MES.storeQualityValue(state, { kind: 'capability', value: 1.27, name: 'slot' }));
const sampling = run(qa, () => MES.storeQualityValue(state, { kind: 'sampling', value: 0.95, name: 'lot plan' }));
const verdicts = [gage, capability, sampling].map((value, i) => run(reviewer, () => MES.recordQualityVerdict(state, { kind: ['gage', 'capability', 'sampling'][i], valueId: value.id, verdict: 'accept' })));
check('quality verdicts cite stored values and carry signatures', verdicts.every(item => item.ok) && state.qualityVerdicts.length === 3 && MES.validate(state) && MES.verifyManifests(state).ok);
const tampered = structuredClone(state);
tampered.qualityVerdicts[0].value = 999;
check('changing a quality verdict away from its stored source value invalidates state and manifest verification', !MES.validate(tampered) && !MES.verifyManifests(tampered).ok);
console.log(`qms_records: ${checks} checks, all passed`);
