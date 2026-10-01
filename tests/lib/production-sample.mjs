// Test data for the suites that exercise production rules on index.html or tests/fixtures/publish.html.
// Production ships no sample data (issue #247), so a suite that needs released master WIs, a stamp register or
// calibrated tools loads them here as its own test data. The WIs and stamp placeholders are the demo build's
// sample (tools/demo/sample-data.mjs, the same records earlier production builds seeded); the tools are recorded
// through the calibration log, signed by the account the suite is signed in as, with dates around today so they
// never age out. Nothing here changes a production rule: every record still passes MES.validate.
import { fileURLToPath } from 'node:url';
import { createHost } from '../../server/mes-host.mjs';

const demo = createHost(fileURLToPath(new URL('../../demo.html', import.meta.url)));
const fresh = demo.MES.ensureMasterWIs(demo.MES.seed());
export const SAMPLE_WIS = Object.freeze(JSON.parse(JSON.stringify(fresh.masterWIs)));
export const SAMPLE_STAMPS = Object.freeze(JSON.parse(JSON.stringify(fresh.stamps)));
// Plain tools and one torque tool, recorded in the calibration log.
export const SAMPLE_TOOLS = Object.freeze([
  { tag: 'TEST-CAL-001', description: 'DIGITAL CALIPER', torque: 'no', serial: 'TC-001', location: 'Production Floor' },
  { tag: 'TEST-TQ-001', description: 'TORQUE WRENCH', torque: 'yes', serial: 'TQ-001', location: 'Production Floor' },
  { tag: 'TEST-DMM-001', description: 'DIGITAL MULTIMETER', torque: 'no', serial: 'DM-001', location: 'Production Floor' },
]);
const DATA = { wis: SAMPLE_WIS, stamps: SAMPLE_STAMPS, tools: SAMPLE_TOOLS };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Fills a workspace held in an engine host (createHost) with the parts asked for. `account` signs the tool entries
// and must hold configure-qms with a Quality Manager or System Administrator role.
export function loadSample(host, state, { wis = true, stamps = false, tools = false, account = { username: 'test-qa', displayName: 'Test QA Manager', role: 'qm' } } = {}) {
  const { MES } = host;
  if (wis && !(state.masterWIs || []).length) state.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  if (stamps && !(state.stamps || []).length) state.stamps = JSON.parse(JSON.stringify(SAMPLE_STAMPS));
  MES.ensureMasterWIs(state);
  if (tools) for (const t of SAMPLE_TOOLS) {
    if (MES.calibrationStatus(state, t.tag)) continue;
    const r = host.withAccount(account, () => MES.recordCalibration(state, { ...t, calibratedAt: day(-1), expires: day(365), status: 'In Calibration', note: 'Test data' }), state);
    if (!r.ok) throw new Error(`test tool ${t.tag}: ${r.message}`);
  }
  return state;
}

// The same in a page. The signed-in account signs the tool entries; the workspace is saved, so a reload keeps it.
export function loadSampleInPage(page, { wis = true, stamps = false, tools = false } = {}) {
  return page.evaluate(([data, opt]) => {
    if (opt.wis && !(state.masterWIs || []).length) state.masterWIs = structuredClone(data.wis);
    if (opt.stamps && !(state.stamps || []).length) state.stamps = structuredClone(data.stamps);
    MES.ensureMasterWIs(state);
    const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    if (opt.tools) for (const t of data.tools) {
      if (MES.calibrationStatus(state, t.tag)) continue;
      const r = MES.recordCalibration(state, { ...t, calibratedAt: day(-1), expires: day(365), status: 'In Calibration', note: 'Test data' });
      if (!r.ok) throw new Error(`test tool ${t.tag}: ${r.message}`);
    }
    if (!MES.validate(state)) throw new Error('sample test data left the workspace invalid: ' + JSON.stringify(MES.diagnose(state)));
    if (typeof save === 'function') save();
    if (typeof render === 'function') render();
    return true;
  }, [DATA, { wis, stamps, tools }]);
}
