// Reference NetSuite bridge for Flight System: the contract in docs/erp/NETSUITE_BRIDGE.md, answered from
// memory instead of NetSuite. IT starts from this file and replaces each handler's body with the NetSuite
// call named beside it; the request checks, idempotency and replies stay as they are. It is also the stand-in
// the contract test (tests/test_netsuite_bridge.mjs) runs against.
//
//   node tools/netsuite-bridge-stub.mjs --port 8787 --token <secret> --allow-origin https://mes.internal
//
// No dependencies. Nothing here holds NetSuite credentials; the real bridge keeps them server-side.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROUTES = Object.freeze([
  '/netsuite/item-availability', '/netsuite/lot-stock', '/netsuite/assembly-build',
  '/netsuite/purchase-requisition', '/netsuite/work-order-issue', '/netsuite/bin-transfer'
]);

const PART_RE = /^[A-Za-z0-9._/-]{1,50}$/;
const LOT_RE = /^[A-Za-z0-9._/-]{1,60}$/;
const BIN_RE = /^[A-Za-z0-9._/-]{1,30}$/;
const EXT_RE = /^[A-Za-z0-9._:/-]{3,120}$/;

// Sample stock the stub answers with. A real bridge reads NetSuite instead.
export const SAMPLE = Object.freeze({
  items: { 'SR-FC-200': 4, 'SR-HC-050': 9, 'SR-CI-110': 0, 'SR-2401': 25 },
  lots: {
    'SR-2401': [
      { lot: 'LOT-2401-0088', onHand: 12, location: 'HHR', bin: 'A-04-2', buildClass: 'Production', conformityStatus: 'Accepted', conformityRef: 'NS-INSP-1001' },
      { lot: 'LOT-2401-0091', onHand: 13, location: 'HHR', bin: 'A-04-3', buildClass: 'Development', conformityStatus: 'Accepted', conformityRef: 'NS-INSP-1002' }
    ]
  }
});

class Refusal extends Error { constructor(status, message) { super(message); this.status = status; } }
const need = (ok, message, status = 400) => { if (!ok) throw new Refusal(status, message); };
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function createBridge({ token, allowOrigins = [], sample = SAMPLE, now = () => new Date().toISOString() } = {}) {
  if (!token || token.length < 16) throw new Error('Start the bridge with --token of 16 characters or more.');
  const written = new Map(); // externalId -> { route, reference, fingerprint }
  const calls = [];
  let seq = 0;

  // Writes are idempotent on externalId: the same request again returns the first reference and writes nothing.
  // The same externalId with different content is refused, so a changed record is never silently dropped.
  function upsert(route, externalId, body, prefix) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ route, ...body, actor: undefined, build: undefined })).digest('hex');
    const prior = written.get(externalId);
    if (prior) {
      need(prior.route === route && prior.fingerprint === fingerprint, `Refused: ${externalId} was already posted with different content. Look it up in NetSuite before posting again.`, 409);
      return { reference: prior.reference, duplicate: true };
    }
    const reference = `${prefix}-${String(++seq).padStart(6, '0')}`;
    written.set(externalId, { route, reference, fingerprint });
    return { reference, duplicate: false };
  }

  const handlers = {
    // NetSuite: SuiteQL over item and inventory balance (quantity on hand by item).
    '/netsuite/item-availability'(b) {
      need(Array.isArray(b.partNumbers) && b.partNumbers.length >= 1 && b.partNumbers.length <= 500 && b.partNumbers.every(p => typeof p === 'string' && PART_RE.test(p)), 'Send partNumbers: 1 to 500 part numbers.');
      const at = now(), items = [], unknown = [];
      for (const p of [...new Set(b.partNumbers)]) (Object.hasOwn(sample.items, p) ? items.push({ partNumber: p, onHand: sample.items[p], snapshotAt: at }) : unknown.push(p));
      return { items, unknown };
    },
    // NetSuite: SuiteQL over inventory number, inventory balance and bin, with the lot's inventory status.
    '/netsuite/lot-stock'(b) {
      need(typeof b.partNumber === 'string' && PART_RE.test(b.partNumber), 'Send one partNumber.');
      const at = now();
      return { partNumber: b.partNumber, snapshotAt: at, lots: (sample.lots[b.partNumber] || []).map(l => ({ ...l })) };
    },
    // NetSuite: Assembly Build (REST record service), upsert on externalId, inventory detail per lot or serial.
    '/netsuite/assembly-build'(b) {
      const p = b.inventory && b.inventory.netsuite && b.inventory.netsuite.payload;
      need(typeof b.orderId === 'string' && p && typeof p.externalId === 'string' && EXT_RE.test(p.externalId), 'Send orderId and inventory.netsuite.payload with its externalId.');
      need(p.recordType === 'assemblybuild' && typeof p.item === 'string' && int(p.quantity, 1, 100000), 'The payload must be an assemblybuild with an item and a whole quantity.');
      return upsert('assembly-build', p.externalId, { payload: p }, 'ASMB');
    },
    // NetSuite: Purchase Requisition (REST record service), upsert on externalId.
    '/netsuite/purchase-requisition'(b) {
      need(typeof b.externalId === 'string' && EXT_RE.test(b.externalId), 'Send an externalId.');
      need(typeof b.vendor === 'string' && b.vendor.trim() && typeof b.process === 'string' && b.process.trim(), 'Send the vendor and the process.');
      return upsert('purchase-requisition', b.externalId, b, 'PREQ');
    },
    // NetSuite: Work Order Issue (component issue to the work order), one line per lot, upsert on externalId.
    '/netsuite/work-order-issue'(b) {
      need(typeof b.externalId === 'string' && EXT_RE.test(b.externalId) && typeof b.workOrder === 'string', 'Send externalId and workOrder.');
      need(Array.isArray(b.lines) && b.lines.length >= 1 && b.lines.length <= 200 && b.lines.every(l => typeof l.partNumber === 'string' && PART_RE.test(l.partNumber) && typeof l.lot === 'string' && LOT_RE.test(l.lot) && int(l.quantity, -100000, 100000) && l.quantity !== 0), 'Send 1 to 200 lines, each with partNumber, lot and a non-zero whole quantity (negative returns stock).');
      return upsert('work-order-issue', b.externalId, b, 'WOI');
    },
    // NetSuite: Bin Transfer, upsert on externalId.
    '/netsuite/bin-transfer'(b) {
      need(typeof b.externalId === 'string' && EXT_RE.test(b.externalId) && typeof b.location === 'string' && b.location.trim(), 'Send externalId and location.');
      need(Array.isArray(b.lines) && b.lines.length >= 1 && b.lines.length <= 200 && b.lines.every(l => typeof l.partNumber === 'string' && PART_RE.test(l.partNumber) && typeof l.lot === 'string' && LOT_RE.test(l.lot) && typeof l.fromBin === 'string' && BIN_RE.test(l.fromBin) && typeof l.toBin === 'string' && BIN_RE.test(l.toBin) && l.fromBin !== l.toBin && int(l.quantity, 1, 100000)), 'Send 1 to 200 lines, each with partNumber, lot, fromBin, a different toBin and a positive whole quantity.');
      return upsert('bin-transfer', b.externalId, b, 'BINT');
    }
  };

  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const authorized = req => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), tokenHash);
  };

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = origin && allowOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' } : {};
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(cors['Access-Control-Allow-Origin'] ? 204 : 403, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' }); res.end(); return; }
    const route = new URL(req.url, 'http://bridge').pathname;
    if (req.method !== 'POST' || !handlers[route]) { send(404, { message: 'Unknown route.' }); return; }
    if (!authorized(req)) { send(401, { message: 'The bridge refused the request: missing or wrong bearer token.' }); return; }
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1_000_000) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { send(400, { message: 'The body is not JSON.' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { send(400, { message: 'The body must be a JSON object.' }); return; }
      try {
        const out = handlers[route](body);
        calls.push({ route, actor: body.actor ? body.actor.account || body.actor.name || null : null, build: body.build || null, at: now(), reference: out.reference || null });
        send(200, out);
      } catch (e) {
        if (e instanceof Refusal) send(e.status, { message: e.message });
        else send(500, { message: 'The bridge failed. Nothing was written.' });
      }
    });
  });

  return {
    server, calls, written,
    listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opt = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
  const bridge = createBridge({ token: opt('token') || process.env.FLIGHT_BRIDGE_TOKEN, allowOrigins: (opt('allow-origin') || '').split(',').filter(Boolean) });
  const addr = await bridge.listen(Number(opt('port') || 8787), opt('host') || '127.0.0.1');
  console.log(`NetSuite bridge stub on http://${addr.address}:${addr.port} (sample data, nothing reaches NetSuite)`);
}
