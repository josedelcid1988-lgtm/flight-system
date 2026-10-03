// NetSuite bridge contract (docs/erp/NETSUITE_BRIDGE.md). Part 1 checks a bridge against the contract: the
// reference stub by default, or IT's own bridge with BRIDGE_URL and BRIDGE_TOKEN set. Part 2 drives the
// production page against the stub: with the bridge off nothing is called and Flight Plan shows the snapshot;
// with it on, Flight Plan reads live on-hand, bad rows are dropped, and posting a finished order twice is one
// NetSuite record.
import { createBridge, ROUTES } from '../tools/netsuite-bridge-stub.mjs';
const { chromium } = await import(process.env.FLIGHT_PLAYWRIGHT || 'playwright');
const fixtures = process.env.FS_FIXTURES_DIR ? 'file://' + process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : new URL('./fixtures/', import.meta.url).href;
const FAILS = [], errors = [];
let passed = 0;
const check = (ok, name) => { if (ok) passed++; else FAILS.push(name); };

const TOKEN = 'test-' + 'x'.repeat(24);
const stub = createBridge({ token: TOKEN, allowOrigins: ['null'] });
const addr = await stub.listen(0);
const STUB_URL = `http://127.0.0.1:${addr.port}`;
const target = process.env.BRIDGE_URL || STUB_URL, targetToken = process.env.BRIDGE_URL ? process.env.BRIDGE_TOKEN : TOKEN;
const post = async (path, body, token = targetToken) => {
  const r = await fetch(target + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  // ---- Part 1: the contract ------------------------------------------------------------------------------
  const run = crypto.randomUUID().slice(0, 8);
  for (const route of ROUTES) {
    const r = await post(route, {}, null);
    check(r.status === 401 && typeof r.body?.message === 'string', `${route}: refused without the bearer token`);
  }
  check((await post('/netsuite/item-availability', {}, 'wrong-token-wrong-token')).status === 401, 'a wrong token is refused');
  check((await post('/netsuite/unknown', {})).status === 404, 'an unknown route is refused');

  let r = await post('/netsuite/item-availability', { partNumbers: ['SR-FC-200', 'SR-FC-200', 'NO-SUCH-PART'] });
  check(r.status === 200 && Array.isArray(r.body.items) && Array.isArray(r.body.unknown), 'item-availability answers items and unknown');
  check(r.body.items.every(i => typeof i.partNumber === 'string' && Number.isInteger(i.onHand) && i.onHand >= 0 && !isNaN(Date.parse(i.snapshotAt))), 'item-availability rows carry partNumber, whole onHand and snapshotAt');
  check(r.body.items.filter(i => i.partNumber === 'SR-FC-200').length <= 1, 'item-availability answers a repeated part once');
  check((await post('/netsuite/item-availability', { partNumbers: [] })).status === 400, 'item-availability refuses an empty list');

  r = await post('/netsuite/lot-stock', { partNumber: 'SR-2401' });
  check(r.status === 200 && Array.isArray(r.body.lots) && r.body.lots.every(l => l.lot && Number.isInteger(l.onHand) && 'bin' in l && 'location' in l && 'buildClass' in l && 'conformityStatus' in l), 'lot-stock rows carry lot, onHand, location, bin, build class and conformity');
  check((await post('/netsuite/lot-stock', { partNumber: '' })).status === 400, 'lot-stock refuses a missing part number');

  const writes = {
    '/netsuite/assembly-build': { orderId: 'WO-T' + run, inventory: { netsuite: { payload: { recordType: 'assemblybuild', externalId: `WO-T${run}-LOT-1`, item: 'SR-FC-200', quantity: 1 } } } },
    '/netsuite/purchase-requisition': { externalId: `WO-T${run}-OP-3-PR`, vendor: 'Anodize Co', process: 'Type II anodize', needBy: '2026-10-30' },
    '/netsuite/work-order-issue': { externalId: `WO-T${run}-KIT-1`, workOrder: 'WO-T' + run, lines: [{ partNumber: 'SR-2401', lot: 'LOT-2401-0088', quantity: 2 }] },
    '/netsuite/bin-transfer': { externalId: `BT-T${run}-1`, location: 'HHR', lines: [{ partNumber: 'SR-2401', lot: 'LOT-2401-0088', fromBin: 'A-04-2', toBin: 'A-05-1', quantity: 2 }] }
  };
  for (const [route, body] of Object.entries(writes)) {
    const first = await post(route, body), again = await post(route, body);
    check(first.status === 200 && typeof first.body.reference === 'string' && first.body.reference.length > 0, `${route}: write returns a reference`);
    check(again.status === 200 && again.body.reference === first.body.reference, `${route}: the same externalId again returns the same reference`);
    const changed = JSON.parse(JSON.stringify(body));
    if (changed.lines) changed.lines[0].quantity += 1; else if (changed.vendor) changed.vendor += ' Inc'; else changed.inventory.netsuite.payload.quantity += 1;
    const clash = await post(route, changed);
    check(clash.status === 409 && /already posted/.test(clash.body?.message || ''), `${route}: the same externalId with different content is refused`);
  }
  check((await post('/netsuite/work-order-issue', { externalId: 'X-' + run, workOrder: 'WO-1', lines: [{ partNumber: 'SR-2401', lot: 'L1', quantity: 0 }] })).status === 400, 'work-order-issue refuses a zero quantity');
  check((await post('/netsuite/bin-transfer', { externalId: 'Y-' + run, location: 'HHR', lines: [{ partNumber: 'SR-2401', lot: 'L1', fromBin: 'A', toBin: 'A', quantity: 1 }] })).status === 400, 'bin-transfer refuses the same from and to bin');

  // ---- Part 2: the page against the stub -------------------------------------------------------------------
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    const open = async (bridge) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(cfg => {
        if (!cfg) return;
        let v; Object.defineProperty(window, 'SK_INTEGRATIONS', { configurable: true, get() { return v; }, set(x) { v = Object.assign(x, cfg); } });
      }, bridge);
      await page.goto(fixtures + 'publish.html', { waitUntil: 'domcontentloaded' });
      const password = 'Test-' + crypto.randomUUID();
      for (const [id, value] of Object.entries({ 'sk-displayname': 'Bridge Test', 'sk-username': 'bridge-test', 'sk-password': password, 'sk-confirm': password })) await page.locator('#' + id).fill(value);
      await page.locator('#sk-login-submit').click();
      await page.waitForFunction(() => !document.getElementById('sk-boot'));
      return page;
    };

    // Bridge off (as shipped): the stub hears nothing and Flight Plan reads the snapshot.
    const before = stub.calls.length;
    let page = await open(null);
    await page.waitForTimeout(500);
    const off = await page.evaluate(() => ({ mode: window.SK_INTEGRATIONS.mode, read: FlightPlan.netsuiteRead('SR-FC-200'), snap: FlightPlan.NETSUITE_SNAPSHOT, live: window.SK_ERP_LIVE || null }));
    check(off.mode === 'local' && off.live === null && off.read.snapshotAt === off.snap && !off.read.live, 'bridge off: Flight Plan reads the built-in snapshot');
    check(stub.calls.length === before, 'bridge off: nothing is sent to a bridge');
    await page.close();

    // Bridge on: the signed-in page reads live on-hand.
    page = await open({ mode: 'mcp', endpoint: STUB_URL, token: TOKEN });
    await page.waitForFunction(() => window.SK_ERP_LIVE && window.SK_ERP_LIVE.items && window.SK_ERP_LIVE.items['SR-FC-200'], null, { timeout: 10000 });
    const on = await page.evaluate(() => FlightPlan.netsuiteRead('SR-FC-200'));
    check(on.live === true && on.onHand === 4, 'bridge on: Flight Plan reads live on-hand from the bridge');
    const sent = stub.calls.filter(c => c.route === '/netsuite/item-availability').pop();
    check(sent && sent.actor === 'bridge-test' && typeof sent.build === 'string', 'bridge on: the read carries the signed-in account and the build');
    const unknown = await page.evaluate(() => FlightPlan.netsuiteRead('NO-SUCH-PART-9'));
    check(!unknown.live, 'a part the bridge does not know falls back to the snapshot');

    // Bad rows from a bridge are dropped, never trusted.
    const dropped = await page.evaluate(async () => {
      const real = window.fetch;
      window.fetch = () => Promise.resolve(new Response(JSON.stringify({ items: [{ partNumber: 'SR-FC-200', onHand: -3, snapshotAt: '2026-10-02T00:00:00Z' }, { partNumber: 'SR-HC-050', onHand: 1.5, snapshotAt: 'x' }, { partNumber: 'NOT-ASKED', onHand: 5, snapshotAt: '2026-10-02T00:00:00Z' }] }), { status: 200 }));
      try { const res = await window.skIntegrations.netsuite.refreshAvailability(); return { accepted: res.accepted, read: FlightPlan.netsuiteRead('SR-FC-200') }; } finally { window.fetch = real; }
    });
    check(dropped.accepted === 0 && !dropped.read.live, 'negative, fractional and unrequested rows are dropped');

    // A failed read leaves the snapshot in place and says why.
    const failed = await page.evaluate(async () => {
      const real = window.fetch;
      window.fetch = () => Promise.reject(new Error('bridge unreachable'));
      try { await window.skIntegrations.netsuite.refreshAvailability(); return { error: window.SK_ERP_LIVE.error, read: FlightPlan.netsuiteRead('SR-FC-200') }; } finally { window.fetch = real; }
    });
    check(/unreachable/.test(failed.error || '') && !failed.read.live, 'an unreachable bridge leaves the snapshot in place');

    // Planned orders keep the same stored shape (snapshotAt and onHand only).
    const shape = await page.evaluate(async () => {
      await window.skIntegrations.netsuite.refreshAvailability();
      const read = FlightPlan.netsuiteRead('SR-FC-200');
      return { keys: Object.keys((({ snapshotAt, onHand }) => ({ snapshotAt, onHand }))(read)).join(','), valid: MES.validate(state) };
    });
    check(shape.keys === 'snapshotAt,onHand' && shape.valid, 'the workspace stays valid with live reads');

    // The routes the page offers match the contract.
    const routes = await page.evaluate(() => window.skIntegrations.describe().routes.filter(r => r.startsWith('/netsuite/')));
    check(['/netsuite/item-availability', '/netsuite/lot-stock', '/netsuite/purchase-requisition', '/netsuite/assembly-build'].every(r => routes.includes(r)), 'the page offers the contract read and post routes');
    check(routes.every(r => ROUTES.includes(r)), 'every NetSuite route the page offers is in the contract');
    await page.close();
  } finally {
    await browser.close();
  }
} finally {
  await stub.close();
}
console.log(`test_netsuite_bridge: ${passed} pass, ${FAILS.length} fail${process.env.BRIDGE_URL ? ' (contract checked against ' + process.env.BRIDGE_URL + ')' : ''}`);
console.log('FAILS', JSON.stringify(FAILS));
if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors));
process.exit(FAILS.length || errors.length ? 1 : 0);
