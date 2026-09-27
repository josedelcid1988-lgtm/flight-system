import assert from 'node:assert/strict';
import { createHost } from '../server/mes-host.mjs';
import { fileURLToPath } from 'node:url';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const state = MES.seed();
const qa = { username: 'governance-qa', displayName: 'Quinn Quality', role: 'qm' };
const master = { username: 'governance-master', displayName: 'Morgan Master', role: 'admin' };
const qe = { username: 'governance-qe', displayName: 'Riley Engineer', role: 'qe' };
const run = (account, fn) => host.withAccount(account, fn, state);
let checks = 0;
function check(name, value) { checks += 1; assert.ok(value, name); console.log(`ok ${name}`); }

check('new and upgraded workspaces initialize the AI governance registers with the model adapter off', !state.modelAdapter.enabled && state.modelAdapter.provider === '' && state.modelAdapterHistory.length === 0 && state.aiActionLog.length === 0 && MES.aiGovernanceValid(state) && MES.upgrade(MES.seed()).aiActionLog.length === 0);
check('a non-QMS account cannot configure the model adapter', !run(qe, () => MES.configureModelAdapter(state, { enabled: true, provider: 'approved-model', settingName: 'MODEL_API_KEY', rationale: 'Approved model for QMS drafts.' })).ok);
check('enabling requires a rationale, provider and server setting name', !run(qa, () => MES.configureModelAdapter(state, { enabled: true, provider: '', settingName: '', rationale: 'Enable it.' })).ok && !run(qa, () => MES.configureModelAdapter(state, { enabled: true, provider: 'approved-model', settingName: 'MODEL_API_KEY', rationale: 'short' })).ok);
const localEnable = run(qa, () => MES.configureModelAdapter(state, { enabled: true, provider: 'approved-model', settingName: 'MODEL_API_KEY', rationale: 'Approved model for validated quality drafts.' }));
const configured = run(qa, () => MES.configureModelAdapter(state, { enabled: true, provider: 'approved-model', settingName: 'MODEL_API_KEY', secret: 'must-not-persist', rationale: 'Approved model for validated quality drafts.' }, true));
check('browser-only enabling is refused; server-confirmed config stores no secret value', !localEnable.ok && configured.ok && state.modelAdapter.enabled && state.modelAdapter.serverConfigured && state.modelAdapter.provider === 'approved-model' && state.modelAdapter.settingName === 'MODEL_API_KEY' && !JSON.stringify(state.modelAdapter).includes('must-not-persist') && MES.aiGovernanceValid(state) && MES.verifyManifests(state).ok);
check('model runs are refused while the adapter is off and are not written to the action log', (() => { run(qa, () => MES.configureModelAdapter(state, { enabled: false, rationale: 'Disable until validation is renewed.' })); const before = state.aiActionLog.length; const result = run(qe, () => MES.recordAIAction(state, { skill: 'five-why', version: '1.0', method: 'model', input: { ncId: 'NC-1001' }, output: { draft: 'cause' }, reason: 'Analyze an NC.', targetRefs: ['NC-1001'] })); return !result.ok && state.aiActionLog.length === before; })());
const deterministic = run(qe, () => MES.recordAIAction(state, { skill: 'fishbone', version: '1.0', method: 'deterministic', input: { ncId: 'NC-1001', evidence: ['EV-1'] }, output: { hypotheses: ['review fit'] }, reason: 'Organize the cited evidence.', targetRefs: ['NC-1001', 'EV-1'], triggerId: 'trigger-01' }));
check('a deterministic QMS action stores hashes and a chain predecessor without raw input or output', deterministic.ok && state.aiActionLog[0].id === 'AI-0001' && state.aiActionLog[0].previousHash === null && state.aiActionLog[0].inputHash && state.aiActionLog[0].outputHash && !JSON.stringify(state.aiActionLog).includes('review fit') && !JSON.stringify(state.aiActionLog).includes('hypotheses') && MES.verifyAIActionLog(state).ok && MES.verifyManifests(state).ok);
const repeated = run(qe, () => MES.recordAIAction(state, { skill: 'fishbone', version: '1.0', method: 'deterministic', input: { ncId: 'NC-1001', evidence: ['EV-1'] }, output: { hypotheses: ['changed output'] }, reason: 'Replay the same trigger.', targetRefs: ['NC-1001', 'EV-1'], triggerId: 'trigger-01' }));
check('replaying the same skill trigger and input writes no duplicate action', repeated.ok && repeated.duplicate && state.aiActionLog.length === 1);
const next = run(qe, () => MES.recordAIAction(state, { skill: 'spc', version: '1.0', input: { part: 'P-1', series: [1, 2, 3] }, output: { status: 'provisional' }, reason: 'Review a provisional series.', targetRefs: ['P-1'] }));
check('a second action links to the previous action hash', next.ok && state.aiActionLog[1].previousHash === state.aiActionLog[0].hash && MES.verifyAIActionLog(state).count === 2 && MES.aiGovernanceValid(state));
check('only QA Manager and Master Access can export ISO governance evidence', !run(qe, () => MES.governanceExport(state)).ok && run(qa, () => MES.governanceExport(state)).document.standard === 'ISO/IEC 42001:2023');
const exported = run(master, () => MES.governanceExport(state));
const exportCopy = structuredClone(exported.document); const exportHash = exportCopy.manifest.hash; delete exportCopy.manifest;
check('the evidence export has a verifying SHA-256 manifest and includes the risk register and action chain', exported.ok && MES.sha256(MES.canonical(exportCopy)) === exportHash && exported.document.planning.riskRegister.length >= 6 && exported.document.operation.actionLog.length === 2 && exported.document.performance.actionLogVerification.ok && MES.verifyManifests(state).ok);
const tampered = structuredClone(state); tampered.aiActionLog[0].outputHash = '0'.repeat(64);
check('tampering with an AI action invalidates the workspace and chain verification', !MES.validate(tampered) && !MES.verifyAIActionLog(tampered).ok && !MES.verifyManifests(tampered).ok);
const broken = structuredClone(state); broken.aiActionLog[1].previousHash = 'f'.repeat(64);
check('changing an action predecessor breaks chain verification', !MES.verifyAIActionLog(broken).ok);
console.log(`qms_governance: ${checks} checks, all passed`);
