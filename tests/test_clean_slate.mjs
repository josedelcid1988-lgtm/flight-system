// Issue #247, go-live clean slate. The owner's decision: the demo keeps its sample data; production starts with
// none. This suite checks the three sides of that:
//   1. a new production workspace holds no sample work orders, WIs, planned orders, Flight Maneuver records,
//      stamps, standard rework drafts, calibrated tools, NetSuite stock or default person, validates, and can be
//      used (records are added through the normal paths), and its screens show plain empty states without errors;
//   2. the demo build still carries every sample, through the numbered deviations D-37 to D-39;
//   3. a workspace saved by the v82 production engine before the clean slate (tests/fixtures/
//      workspace_v82_before_clean_slate.json, written once by that engine at commit e2e2bc3, with the sample WIs,
//      placeholder stamps, the Morgan Lee profile, sample planned orders with a NetSuite read, and calibration
//      entries, a work unit and a maintenance record that name tools of the old snapshot) loads unchanged.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';
import { SAMPLE_WIS } from './lib/production-sample.mjs';

const here = rel => fileURLToPath(new URL(rel, import.meta.url));
const read = rel => fs.readFileSync(here(rel), 'utf8');
let checks = 0;
const FAILS = [];
const check = (name, ok, detail = '') => { checks += 1; if (ok) console.log(`ok ${name}`); else { FAILS.push(name); console.log(`not ok ${name}${detail ? `: ${detail}` : ''}`); } };
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
const me = { username: 'me-lee', displayName: 'Robin Engineer', role: 'me' };
const admin = { username: 'go-live', displayName: 'Go Live', role: 'admin' };
const now = '2026-10-01T19:00:00.000Z';

// The load path the page runs on a workspace (index.html: state=FlightPlan.ensure(MES.ensureMasterWIs(...))),
// plus the Flight Maneuver register and the standard rework library, which are created on first use.
const load = (host, state) => { const { MES, FlightPlan, FlightManeuver } = host; FlightManeuver.ensure(FlightPlan.ensure(MES.ensureMasterWIs(state))); MES.reworkLibrary(state); return state; };

// ---- 1. production: a new workspace is empty, valid and usable --------------------------------------------------
const prod = createHost(here('../index.html'));
{
  const { MES, FlightPlan } = prod;
  const state = load(prod, MES.seed());
  const mv = state.maneuver;
  check('a new production workspace has no work orders', state.orders.length === 0);
  check('a new production workspace has no master WIs', Array.isArray(state.masterWIs) && state.masterWIs.length === 0);
  check('a new production workspace has no planned orders', Array.isArray(state.plannedOrders) && state.plannedOrders.length === 0);
  check('a new production workspace has no Flight Maneuver records', ['ncs', 'cars', 'mrb', 'sprs', 'pfmeas'].every(k => Array.isArray(mv[k]) && mv[k].length === 0));
  check('a new production workspace has an empty stamp register (no placeholders, no role credentials)', Array.isArray(state.stamps) && state.stamps.length === 0);
  check('a new production workspace has no standard rework drafts', Array.isArray(state.reworkLibrary) && state.reworkLibrary.length === 0);
  check('a new production workspace has no calibration log entries', !(state.calibrationLog || []).length);
  check('the device profile names no person before sign-in', state.profile.name === 'Not signed in' && state.profile.credentialId === 'NOT-SIGNED-IN');
  check('production ships no Calibrated Tool Log snapshot', MES.CAL_TOOLS.length === 0 && MES.CAL_SNAPSHOT === '' && MES.calibratedToolChecks(state, now).length === 0);
  check('production ships no NetSuite stock', Object.keys(MES.NETSUITE_STOCK).length === 0 && MES.NETSUITE_SNAPSHOT === '' && MES.availableLots('SR-2401').length === 0 && FlightPlan.netsuiteRead('SR-FC-200') === null);
  const f = FlightPlan.forecast(state);
  check('production ships no MRP forecast tables', Object.keys(FlightPlan.DEMO_MBOM).length === 0 && FlightPlan.DEMO_COMPONENT_LOTS.length === 0 && FlightPlan.DEMO_PARTS.length === 0 && ['explosion', 'leadTime', 'fair', 'shelfLife', 'designChanges'].every(k => f[k].length === 0));
  check('the credential list offers no sample person', !JSON.stringify(MES.profileOptions(state)).includes('Morgan Lee'));
  check('the new workspace validates', MES.validate(state) === true, JSON.stringify(MES.diagnose(state)));
  check('diagnose finds nothing wrong', MES.diagnose(state) === null);
  check('every signature manifest verifies', MES.verifyManifests(state).ok === true);
  const again = JSON.stringify(state);
  load(prod, state);
  check('loading the new workspace again changes nothing (no seed appears later)', JSON.stringify(state) === again);

  // Usable with empty data: records arrive through the normal, signed paths.
  const cal = prod.withAccount(qa, () => MES.recordCalibration(state, { tag: 'GL-001', description: 'DIGITAL CALIPER', torque: 'no', serial: 'SN-1', calibratedAt: '2026-09-30', expires: '2027-09-30', status: 'In Calibration', location: 'Production Floor', note: 'Go-live load' }), state);
  check('a QA Manager records the first calibrated tool', cal.ok && MES.toolCheck('GL-001', now, state).ok === true, cal.message);
  const stamp = prod.withAccount(qa, () => MES.issueStamp(state, { name: 'Pat Rivera', buyoffType: 'Quality', account: 'priv', expires: '2027-12-31' }), state);
  check('a QA Manager issues the first stamp, numbered SKY-0000', stamp.ok && state.stamps.length === 1 && state.stamps[0].number === 'SKY-0000', stamp.message);
  const part = MES.PART_CATALOG[0];
  const wiCsv = ['wi,partNumber,partRevision,title,operation,operationTitle,operationSummary,buyoffType,stepTitle,instruction', `1,${part.partNumber},${part.revisions[0]},First WI,10,Prepare,Prepare parts,Technician,Clean,Wipe each part with IPA`].join('\n');
  const wi = prod.withAccount(me, () => MES.importMasterWIs(state, wiCsv), state);
  check('Manufacturing Engineering imports the first master WI as a Draft', wi.ok && state.masterWIs.length === 1 && state.masterWIs[0].status === 'Draft', wi.message);
  check('the workspace still validates after the first records', MES.validate(state) === true && MES.verifyManifests(state).ok === true, JSON.stringify(MES.diagnose(state)));
  const po = prod.withAccount(admin, () => FlightPlan.addPlannedOrder(state, { masterWI: `${state.masterWIs[0].id}|A`, pedigree: 'Production', subcategory: 'Mfg.', aircraft: MES.AIRCRAFT[0], site: null, quantity: 1, needDate: '2026-12-01' }), state);
  // Kit lines come from the released WI's operation BOM (Codex review on #331); a WI without a BOM starts empty.
  const bomState = load(prod, MES.seed());
  bomState.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const bomWi = bomState.masterWIs.find(w => w.status === 'Released');
  bomWi.operations[0].materials = [{ partNumber: 'BOM-001', name: 'Bracket', required: 2 }];
  const fromWi = prod.withAccount(admin, () => MES.addOrder(bomState, { masterWI: `${bomWi.id}|${bomWi.revision}`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), bomState);
  const bomOrder = fromWi.ok ? MES.getOrder(bomState, fromWi.id) : null;
  check('a work order from a WI with an operation BOM starts its kit with those lines, unverified', !!bomOrder && bomOrder.materials.length === 1 && bomOrder.materials[0].partNumber === 'BOM-001' && bomOrder.materials[0].required === 2 && bomOrder.materials[0].ready === false && MES.validate(bomState) === true, fromWi.message);
  const advanced = prod.withAccount(admin, () => { const o = MES.getOrder(bomState, fromWi.id); if (MES.requiresReleaseQA(o)) o.release = { status: 'Approved', name: 'QA Peer', role: 'Quality Engineer', credentialId: 'ACCT-qapeer', at: new Date().toISOString(), note: 'test' }; MES.advance(bomState, fromWi.id); o.kitFiles = [{ id: 'f1', name: 'kit.pdf' }]; return MES.advance(bomState, fromWi.id); }, bomState);
  check('Building stays refused until that BOM line is kitted with a verified lot', !advanced.ok && /Confirm all materials/.test(advanced.message || '') && MES.getOrder(bomState, fromWi.id).status === 'Kitting', advanced.message);
  const adhoc = prod.withAccount(admin, () => MES.addAdhocOrder(state, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], partNumber: 'GL-PART-001', title: 'First production order', revision: 'A' }), state);
  const first = adhoc.ok ? MES.getOrder(state, adhoc.id) : null;
  check('a production work order starts with an empty kit, not the sample kit lines, and validates', !!first && Array.isArray(first.materials) && first.materials.length === 0 && MES.validate(state) === true, adhoc.message);
  check('a planned order is refused until a WI is released, with a plain reason', !po.ok && typeof po.message === 'string' && po.message.length > 0, po && po.message);
}

// Refusal paths for the rules this change touches.
{
  const { MES } = prod;
  const legacy = JSON.parse(read('fixtures/workspace_v82_before_clean_slate.json'));
  legacy.masterWIs = [];
  check('an empty WI library is refused once a work order cites a master WI, with a plain reason', MES.validate(legacy) === false && /Master WI library is empty, but work orders, planned orders or PFMEAs in this workspace cite master WIs/.test((MES.diagnose(legacy) || {}).detail || ''));
  // A PFMEA names a WI revision too (Codex review on #331): emptying the library under it is refused as well.
  const withPfmea = load(prod, MES.seed());
  withPfmea.masterWIs = JSON.parse(JSON.stringify(SAMPLE_WIS));
  const draft = withPfmea.masterWIs.find(w => w.status === 'Draft');
  const opened = prod.withAccount(admin, () => prod.FlightManeuver.openPFMEA(withPfmea, draft.id, draft.revision), withPfmea);
  check('a PFMEA is opened on a WI revision for the check', opened.ok && MES.validate(withPfmea) === true, opened.message);
  withPfmea.masterWIs = [];
  check('an empty WI library is refused while a PFMEA cites a master WI', MES.validate(withPfmea) === false && /PFMEAs in this workspace cite master WIs/.test((MES.diagnose(withPfmea) || {}).detail || ''));
  // A workspace saved before the WI library existed (no masterWIs key, orders with no WI link) gets an empty library.
  // Earlier builds invented sample released WIs and linked its orders to them; production does not invent records.
  const preLibrary = JSON.parse(read('fixtures/workspace_v82_before_clean_slate.json'));
  delete preLibrary.masterWIs; delete preLibrary.plannedOrders; preLibrary.orders.forEach(o => { delete o.masterWI; });
  const preOrders = JSON.stringify(preLibrary.orders);
  load(prod, preLibrary);
  check('a workspace saved before the WI library loads with an empty library, its orders untouched and not linked to invented WIs', Array.isArray(preLibrary.masterWIs) && preLibrary.masterWIs.length === 0 && JSON.stringify(preLibrary.orders) === preOrders && MES.validate(preLibrary) === true, JSON.stringify(MES.diagnose(preLibrary)));
  const fresh = load(prod, MES.seed());
  const old = MES.toolCheck('DMM-08', now, fresh);
  check('a tool of the old snapshot cannot be used until the calibration log records it', !old.ok && /no entry in the calibration log/.test(old.message) && /2026-09-15/.test(old.message), old.message);
  const atp = MES.atpAssets([{ asset: 'DMM-08', description: 'Bench meter', noCal: true }], now, fresh);
  check('an ATP buy-off cannot list a tool of the old snapshot as not calibration-controlled', !atp.ok && /calibration log/.test(atp.message), atp.message);
  const declassify = prod.withAccount(qa, () => MES.recordCalibration(fresh, { tag: 'NONE-174', description: 'TORQUE SCREWDRIVER', torque: 'no', serial: 'TQ', calibratedAt: '2026-09-30', expires: '2027-03-30', status: 'In Calibration', location: 'Production Floor', note: 'x' }), fresh);
  check('a torque tool of the old snapshot stays a torque tool', !declassify.ok && /torque tool and stays one/.test(declassify.message), declassify.message);
  const undated = prod.withAccount(qa, () => MES.recordCalibration(fresh, { tag: 'CAL-022', description: 'DIGITAL CALIPER', serial: 'S', calibratedAt: '', expires: '', status: 'Retired', location: 'Production Floor', note: 'x' }), fresh);
  check('a tool of the old snapshot cannot be retired without its calibration dates', !undated.ok && /calibration dates on record/.test(undated.message), undated.message);
}

// The production file carries no sample record. Format hints in input placeholders are not records.
{
  const html = read('../index.html');
  for (const [what, text] of [['the sample person', 'Morgan Lee'], ['a sample NetSuite lot', 'LOT-2401-0088'], ['a sample component lot', 'LOT-DEMO-'], ['a sample tool serial', '150151267'], ['a sample bill of materials', 'DEMO drive motor'], ['a sample planned order', 'Demand withdrawn (DEMO).'], ['a sample master WI history', 'Released by QA.'], ['a sample rework draft', 'Re-torque fastener(s) to drawing value'], ['a sample stamp holder', "'Quality inspector', 'Quality'"]]) {
    check(`index.html does not carry ${what}`, !html.includes(text));
  }
  check('the production fixture is a copy of index.html', read('fixtures/publish.html') === html.replace(/((?:src|href)=")assets\//g, '$1../../assets/'));
}

// ---- 2. the demo keeps every sample ---------------------------------------------------------------------------------
{
  const demoHtml = read('../demo.html');
  const demo = createHost(here('../demo.html'));
  const { MES, FlightPlan } = demo;
  check('the demo marks each sample deviation', ['DEMO D-37', 'DEMO D-38: sample data', 'DEMO D-39: sample data'].every(m => demoHtml.includes(m)));
  check('the demo carries the sample tool snapshot', MES.CAL_TOOLS.length === JSON.parse(read('../tools/demo/cal-snapshot.json')).tools.length && MES.CAL_TOOLS.length > 300 && MES.CAL_SNAPSHOT !== '');
  check('the demo carries the sample NetSuite lots', MES.availableLots('SR-2401').some(l => l.lot === 'LOT-2401-0088') && MES.NETSUITE_SNAPSHOT !== '');
  check('the demo carries the sample MRP tables', Object.keys(FlightPlan.DEMO_MBOM).length > 0 && FlightPlan.DEMO_COMPONENT_LOTS.length > 0);
  const demoState = load(demo, MES.seed());
  const demoOrder = demo.withAccount(admin, () => MES.addAdhocOrder(demoState, { pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], partNumber: 'DEMO-PART-001', title: 'Demo order', revision: 'A' }), demoState);
  check('a demo work order starts with the three sample kit lines', demoOrder.ok && MES.getOrder(demoState, demoOrder.id).materials.map(m => m.partNumber).join() === 'SR-2401,SR-2402,SR-2403', demoOrder.message);
  const reset = load(demo, MES.seed());
  check('a reset demo workspace starts with the sample WIs, planned orders, stamps and rework drafts', reset.masterWIs.some(w => w.status === 'Released') && reset.plannedOrders.length > 0 && reset.stamps.some(s => s.number === 'SKY-0000') && reset.reworkLibrary.length === 6, `${reset.masterWIs.length} ${reset.plannedOrders.length} ${reset.stamps.length} ${reset.reworkLibrary.length}`);
  check('a reset demo workspace validates', MES.validate(reset) === true, JSON.stringify(MES.diagnose(reset)));
  for (const fixture of ['fixtures/demo_publish.html', 'fixtures/demo_qa150.html', 'fixtures/demo_qa150_publish.html']) {
    const text = read(fixture);
    check(`${fixture} keeps its sample workspace and sample tools`, text.includes('window.__DEMO_SEED={') && text.includes('DEMO D-37') && text.includes('LOT-2401-0088'));
  }
  const curated = JSON.parse(read('../tools/demo/seed-curated.json'));
  check('the curated demo seed still holds its sample records', curated.orders.length > 0 && curated.masterWIs.length > 0 && curated.stamps.length > 0);
}

// ---- 3. a workspace saved before the clean slate loads unchanged ------------------------------------------------------
{
  const { MES, FlightPlan } = prod;
  const text = read('fixtures/workspace_v82_before_clean_slate.json');
  const state = JSON.parse(text), before = JSON.stringify(state);
  check('the saved workspace validates under the clean-slate engine', MES.validate(state) === true, JSON.stringify(MES.diagnose(state)));
  check('diagnose finds nothing wrong in it', MES.diagnose(state) === null);
  check('every signature manifest in it verifies', MES.verifyManifests(state).ok === true);
  check('the server finds nothing to refuse in its registers', MES.stampRegisterProblem(state) === null && FlightPlan.plannedOrdersProblem(state) === null);
  load(prod, state);
  check('loading it changes nothing: no record is removed, added or rewritten', JSON.stringify(state) === before);
  check('it keeps its sample WIs, stamps, rework drafts, planned orders and profile', state.masterWIs.length === 11 && state.stamps.length === 13 && state.reworkLibrary.length === 6 && state.plannedOrders.length === 6 && state.profile.name === 'Morgan Lee');
  check('its planned orders keep the NetSuite read they recorded', state.plannedOrders.every(po => po.netsuite && po.netsuite.snapshotAt === '2026-09-15 15:13'));
  const tq = MES.toolCheck('NONE-174', now, state), cal = MES.toolCheck('CAL-022', now, state), log = MES.toolCheck('LOG-001', now, state);
  check('its calibration entries for tools of the old snapshot still work at point of use', tq.ok && cal.ok && log.ok, [tq, cal, log].map(r => r.message).join(' | '));
  check('a torque tool of the old snapshot recorded with no torque answer is still a torque tool', tq.ok && tq.tool.torqueTool === true && cal.tool.torqueTool === false);
  check('its work unit and maintenance record on old snapshot tags still validate', state.resources.units.some(u => u.toolTag === 'DMM-08') && state.resources.maintenance.some(m => m.assetTag === 'PS-007'));
  check('a trace search for an old snapshot tag is still a tool search', MES.traceSearch(state, 'DMM-08').kind === 'tool');
}

// ---- the production screens on a new workspace -----------------------------------------------------------------------
{
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(new URL('fixtures/publish.html', import.meta.url).href);
    const password = 'Test-' + crypto.randomUUID();
    await page.locator('#sk-displayname').fill('Go Live');
    await page.locator('#sk-username').fill('go-live');
    await page.locator('#sk-password').fill(password);
    await page.locator('#sk-confirm').fill(password);
    await page.locator('#sk-login-submit').click();
    await page.waitForFunction(() => !document.getElementById('sk-boot'));
    const counts = await page.evaluate(() => ({ orders: state.orders.length, wis: state.masterWIs.length, stamps: state.stamps.length, planned: FlightPlan.list(state).length, valid: MES.validate(state) }));
    check('the production page opens a new workspace with nothing in it, and it validates', counts.orders === 0 && counts.wis === 0 && counts.stamps === 0 && counts.planned === 0 && counts.valid === true, JSON.stringify(counts));
    const show = async v => { await page.evaluate(v => document.querySelector(`[data-view="${v}"]`).click(), v); await page.waitForTimeout(250); return page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' ')); };
    for (const v of ['home', 'orders', 'plan-home', 'plan-kanban', 'plan-forecast', 'mnv-home', 'mnv-intake', 'mnv-mrb', 'mnv-cars', 'mnv-spr', 'mnv-pfmea', 'mnv-metrics', 'serials', 'trace', 'activity']) await show(v);
    check('every Flight Control, Flight Plan and Flight Maneuver screen opens without a page error', errors.length === 0, errors.join(' | '));
    check('the empty Master WI library says how to start', /No master WIs yet Start one with New master WI, or import WIs from a CSV/.test(await show('wis')));
    check('the empty standard rework library says how to start', /No standard rework operations yet/.test(await show('wis')));
    check('the empty calibration log says how to load tools', /No calibrations recorded\. Record each calibrated tool above or import the calibration log as a CSV/.test(await show('qms-records')));
    await page.evaluate(() => document.querySelector('[data-view="plan-home"]').click());
    await page.getByRole('button', { name: 'Plan from master WI' }).first().click();
    check('planning with no released WI says what to do next', /No master WI is released yet\. Write one on the Master WI library or import WIs from a CSV/.test(await page.locator('#dialog').innerText()));
    await page.evaluate(() => document.getElementById('dialog').close());
    await page.getByRole('button', { name: 'Your credentials', exact: true }).click();
    check('the empty stamp register says how to load stamps', /No stamps issued\. Issue a stamp to each named person below, or import the current register from a CSV/.test(await page.locator('#dialog').innerText()));
    check('no page error on any screen', errors.length === 0, errors.join(' | '));
  } finally { await browser.close(); }
  console.log('errors ' + JSON.stringify(errors));
}

console.log(`checks ${checks} pass ${checks - FAILS.length} fail ${FAILS.length}`);
console.log('FAILS ' + JSON.stringify(FAILS));
if (FAILS.length) process.exit(1);
