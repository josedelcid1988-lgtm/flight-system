// Codex P1 findings on #17 (r4127650381, r4127650388): the server runs the engine's derived-state
// initializers inside every commit. FlightPlan.ensure() replaces a whole planned-order list that has one
// damaged entry with five seeded orders, and ensureStamps() replaces a whole stamp register that has one
// damaged entry with seed placeholders, dropping every account assignment. MES.validate() covers neither,
// so an unrelated action used to commit the replacement. The server now refuses the write instead and
// leaves the stored record as it was; a register that is simply missing is still seeded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/server.mjs';
import { createHost } from '../server/mes-host.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${name}`); };
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const SETUP_CODE = 'converge-test-setup-code';
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const handler = server.listeners('request')[0];
const api = async (method, url, { token, body, headers = {} } = {}) => {
  const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  incoming.method = method;
  incoming.url = `/api${url}`;
  incoming.headers = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status, values = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)])); return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  handler(incoming, outgoing);
  await finished;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: outgoing.statusCode, json, etag: outgoing.responseHeaders?.etag || null };
};

try {
  await server.ready;
  const { MES, FlightPlan } = server.host;
  // The curated workspace test_server.mjs also stores: open work orders, a stamp register and planned orders.
  const fixture = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
  assert.ok(fixture, 'the curated fixture has a workspace');
  const base = MES.upgrade(JSON.parse(fixture[1]));
  MES.ensureMasterWIs(base);
  // The fixture ships an empty planned-order list. Production seeds none (issue #247), so the demo engine seeds its
  // sample planned orders (D-39) as this suite's data, so there are orders to lose.
  delete base.plannedOrders;
  createHost(fileURLToPath(new URL('../demo.html', import.meta.url))).FlightPlan.ensure(base);
  // Move closed orders out now, as the first commit would, so the base can be stored again between checks.
  assert.ok(MES.archiveOrders(base).ok, 'the base workspace archives its closed orders');
  assert.ok(MES.validate(base) && base.plannedOrders.length > 2 && base.stamps.length > 2, 'the base workspace has planned orders and a stamp register');

  // A planned-order list with one damaged entry (two orders share an id) and a planner's change on another order.
  const damagedPlan = () => {
    const s = structuredClone(base);
    s.plannedOrders[2].quantity = 77;
    s.plannedOrders[0].id = s.plannedOrders[1].id;
    return s;
  };
  // A stamp register with one malformed entry, and an inspector's account assigned to a real stamp.
  const damagedStamps = () => {
    const s = structuredClone(base);
    s.stamps.find(stamp => stamp.status === 'Active').account = 'inspector-a';
    s.stamps.push({ id: 'not-a-stamp' });
    return s;
  };

  await check('the engine still accepts both damaged registers, so the server must catch them', async () => {
    assert.equal(MES.validate(damagedPlan()), true);
    assert.equal(MES.validate(damagedStamps()), true);
  });

  await check('a damaged planned-order list is refused, not replaced with the seeded schedule', async () => {
    const s = damagedPlan();
    const problem = server.validState(s);
    assert.equal(typeof problem, 'string', 'the write gate names a problem');
    assert.match(problem, /planned order/i);
    assert.ok(s.plannedOrders.some(po => po.quantity === 77), 'the planned orders are left as they were');
  });

  await check('a damaged stamp register is refused, not replaced with seed placeholders', async () => {
    const s = damagedStamps();
    const problem = server.validState(s);
    assert.equal(typeof problem, 'string', 'the write gate names a problem');
    assert.match(problem, /stamp register/i);
    assert.ok(s.stamps.some(stamp => stamp.account === 'inspector-a'), 'the stamp assignments are left as they were');
  });

  await check('a workspace with no planned orders or stamp register yet gets empty ones (no sample, issue #247) and is accepted', async () => {
    const s = structuredClone(base);
    delete s.plannedOrders;
    delete s.stamps;
    assert.equal(server.validState(s), null);
    assert.ok(Array.isArray(s.plannedOrders) && s.plannedOrders.length === 0, 'planned orders created empty on first use');
    assert.ok(Array.isArray(s.stamps) && s.stamps.length === 0, 'stamp register created empty on first use');
  });

  await check('an intact workspace passes the write gate unchanged', async () => {
    const s = structuredClone(base);
    assert.equal(server.validState(s), null);
    assert.equal(JSON.stringify(s.plannedOrders), JSON.stringify(base.plannedOrders));
    assert.equal(JSON.stringify(s.stamps), JSON.stringify(base.stamps));
  });

  const created = await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'admin', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'converge-pass-123') }] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const session = await api('POST', '/auth/session', { body: { username: 'admin', password: 'converge-pass-123' } });
  assert.equal(session.status, 200, JSON.stringify(session.json));
  const token = session.json.token;
  const order = base.orders.find(o => o.status !== 'Closed');
  assert.ok(order, 'the seed has an open work order');

  for (const [label, make, pattern, kept] of [
    ['planned-order list', damagedPlan, /planned order/i, s => s.plannedOrders.some(po => po.quantity === 77)],
    ['stamp register', damagedStamps, /stamp register/i, s => s.stamps.some(stamp => stamp.account === 'inspector-a')]
  ]) {
    await check(`an unrelated action on a stored workspace with a damaged ${label} is refused and the stored copy is unchanged`, async () => {
      const current = server.store.getDoc('default');
      const json = JSON.stringify(make());
      const etag = server.store.putDoc('default', json, current ? current.etag : null, 'converge-test');
      assert.ok(etag, 'the damaged workspace is stored');
      const result = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: [order.id, 'AOG'] }, headers: { 'If-Match': etag } });
      assert.equal(result.status, 422, JSON.stringify(result.json));
      assert.match(result.json.error, pattern);
      const after = server.store.getDoc('default');
      assert.equal(after.etag, etag, 'nothing was committed');
      assert.equal(after.json, json, 'the stored workspace is byte for byte unchanged');
      assert.ok(kept(JSON.parse(after.json)), `the stored ${label} still holds its records`);
    });
  }

  // Codex review of #220 (r4150944125, r4150944131): some actions run the initializer themselves before the
  // write gate sees the state. issueStamp calls ensureStamps first, and addPlannedOrder replaces a planned-order
  // value that is not a list with []. The stored registers are checked before any action runs, so neither can
  // replace them either.
  const wi = base.masterWIs.find(item => item.status === 'Released');
  const need = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  const planInput = { masterWI: `${wi.id}|${wi.revision}`, partNumber: wi.partNumber, revision: MES.partDefinition(wi.partNumber)?.revision, quantity: 1, needDate: need, need, pedigree: 'Production', subcategory: 'Mfg.', aircraft: MES.AIRCRAFT[0], site: MES.SITES[0], source: 'Converge test' };
  const stampInput = { name: 'Converge Inspector', department: 'Quality', buyoffType: base.stamps.find(stamp => stamp.status === 'Active').buyoffType, expires: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) };
  const plainList = () => { const s = structuredClone(base); s.plannedOrders = { damaged: true }; return s; };
  for (const [label, make, action, args, pattern, kept] of [
    ['stamp register', damagedStamps, 'MES.issueStamp', [stampInput], /stamp register/i, s => s.stamps.some(stamp => stamp.account === 'inspector-a')],
    ['planned-order list', plainList, 'FlightPlan.addPlannedOrder', [planInput], /planned order/i, s => s.plannedOrders && s.plannedOrders.damaged === true]
  ]) {
    await check(`${action}, which runs the initializer itself, is refused on a stored damaged ${label} and the stored copy is unchanged`, async () => {
      const current = server.store.getDoc('default');
      const intact = server.store.putDoc('default', JSON.stringify(base), current.etag, 'converge-test');
      const control = await api('POST', `/workspace/actions/${action}`, { token, body: { args }, headers: { 'If-Match': intact } });
      assert.equal(control.status, 200, `the same ${action} succeeds on an intact workspace: ${JSON.stringify(control.json)}`);
      const json = JSON.stringify(make());
      const etag = server.store.putDoc('default', json, control.etag, 'converge-test');
      const result = await api('POST', `/workspace/actions/${action}`, { token, body: { args }, headers: { 'If-Match': etag } });
      assert.equal(result.status, 422, JSON.stringify(result.json));
      assert.match(result.json.error, pattern);
      const after = server.store.getDoc('default');
      assert.equal(after.etag, etag, 'nothing was committed');
      assert.equal(after.json, json, 'the stored workspace is byte for byte unchanged');
      assert.ok(kept(JSON.parse(after.json)), `the stored ${label} still holds its records`);
    });
  }

  // Codex review of #220 (r4151179105): a workspace the server has converged carries planning blockers, and on it
  // MES.upgrade itself throws on a planned-order value that is not a list. That must still be the plain 422 refusal,
  // not an unexpected-failure response.
  await check('a stored, converged workspace whose planned orders are not a list gets the plain refusal, not an unexpected failure', async () => {
    const converged = structuredClone(base);
    MES.syncBlockers(converged);
    converged.plannedOrders = { damaged: true };
    assert.doesNotThrow(() => MES.upgrade(structuredClone(converged)), 'the engine upgrade reads a planned-order value that is not a list as an empty list');
    const current = server.store.getDoc('default');
    const json = JSON.stringify(converged);
    const etag = server.store.putDoc('default', json, current.etag, 'converge-test');
    const result = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: [order.id, 'AOG'] }, headers: { 'If-Match': etag } });
    assert.equal(result.status, 422, JSON.stringify(result.json));
    assert.match(result.json.error, /planned order/i);
    assert.equal(server.store.getDoc('default').json, json, 'the stored workspace is byte for byte unchanged');
  });

  // Codex review of #220 (r4151430888): reads on that stored workspace keep working; they used to see no workspace.
  await check('reads on a stored workspace whose planned orders are not a list still see the workspace', async () => {
    const converged = structuredClone(base);
    MES.syncBlockers(converged);
    converged.plannedOrders = { damaged: true };
    const current = server.store.getDoc('default');
    server.store.putDoc('default', JSON.stringify(converged), current.etag, 'converge-test');
    const governance = await api('GET', '/governance', { token });
    assert.equal(governance.status, 200, JSON.stringify(governance.json));
  });

  // Codex review of #220 (r4151430881): initializing an empty server from such a snapshot gets the plain refusal.
  await check('initializing an empty server from a converged snapshot whose planned orders are not a list is refused with the plain reason', async () => {
    const fresh = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
    const freshHandler = fresh.listeners('request')[0];
    const call = async (method, url, { token: t, body } = {}) => {
      const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      incoming.method = method; incoming.url = `/api${url}`;
      incoming.headers = { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) };
      const chunks = [];
      const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
      outgoing.writeHead = (status) => { outgoing.statusCode = status; return outgoing; };
      const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
      freshHandler(incoming, outgoing);
      await finished;
      const text = Buffer.concat(chunks).toString('utf8');
      return { status: outgoing.statusCode, json: text ? JSON.parse(text) : null };
    };
    try {
      await fresh.ready;
      assert.equal((await call('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'admin', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'converge-pass-123') }] } })).status, 200);
      const freshToken = (await call('POST', '/auth/session', { body: { username: 'admin', password: 'converge-pass-123' } })).json.token;
      const converged = structuredClone(base);
      MES.syncBlockers(converged);
      converged.plannedOrders = { damaged: true };
      const result = await call('PUT', '/workspace', { token: freshToken, body: converged });
      assert.equal(result.status, 422, JSON.stringify(result.json));
      assert.match(result.json.error, /planned order/i);
      assert.ok(!fresh.store.getDoc('default'), 'nothing was stored');
    } finally { await fresh.store.close?.(); }
  });

  await check('the same action on an intact stored workspace is committed', async () => {
    const current = server.store.getDoc('default');
    const etag = server.store.putDoc('default', JSON.stringify(base), current.etag, 'converge-test');
    const result = await api('POST', '/workspace/actions/MES.setPriority', { token, body: { args: [order.id, 'AOG'] }, headers: { 'If-Match': etag } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const stored = JSON.parse(server.store.getDoc('default').json);
    assert.equal(stored.orders.find(o => o.id === order.id).priority, 'AOG');
    assert.equal(JSON.stringify(stored.plannedOrders), JSON.stringify(base.plannedOrders), 'planned orders kept');
  });

  console.log(`server converge: ${checks} checks, all passed`);
  console.log('FAILS []');
} catch (error) {
  console.error(error);
  console.log(`FAILS ["${String(error && error.message || error).replace(/"/g, "'").slice(0, 300)}"]`);
  process.exitCode = 1;
} finally {
  await server.store.close?.();
}
