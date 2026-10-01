// Work-center sprint dates are bounded: real calendar dates between 2000-01-01 and 2099-12-31, at most 92 days long.
// A sprint outside the bound is refused when it is created (engine and server action), fails validation and is named
// by diagnose when it is already stored, and the sprint report never walks more than the bound.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createHost } from '../server/mes-host.mjs';
import { createServer } from '../server/server.mjs';

const FAILS = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`ok ${name}`); } catch (error) { FAILS.push(`${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
};
const fixtureHtml = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const seed = () => JSON.parse(fixtureHtml.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const host = createHost(new URL('../index.html', import.meta.url).pathname);
const ops = { username: 'ops-planner', displayName: 'Ops Planner', role: 'ops', roles: ['ops'] };
const workCenterId = host.MES.WORK_CENTERS[0].id;
const fresh = () => { const state = host.MES.upgrade(seed()); host.MES.ensureProjects(state); return state; };
const create = (state, startDate, endDate) => host.withAccount(ops, () => host.MES.createSprint(state, { name: 'Bounded sprint', workCenterId, startDate, endDate, backlog: [] }), state);
const storedSprint = (startDate, endDate) => ({ id: 'SPT-0901', name: 'Stored sprint', workCenterId, startDate, endDate, capacityHours: 0, backlog: [], by: { name: 'Ops Planner', role: 'Operations Manager', credentialId: 'ACCT-ops-planner' }, at: '2026-10-01T00:00:00.000Z' });

await check('a normal two-week sprint is created and reported', async () => {
  const state = fresh();
  const made = create(state, '2026-10-05', '2026-10-16');
  assert.equal(made.ok, true, made.message);
  const report = host.MES.sprintReport(state, made.id);
  assert.equal(report.burndown.length, 10, 'ten workdays in a two-week sprint');
  assert.equal(host.MES.validate(state), true);
});

await check('a sprint of exactly 92 days is allowed; 93 days is refused with what to do', async () => {
  const state = fresh();
  const quarter = create(state, '2026-10-01', '2026-12-31');
  assert.equal(quarter.ok, true, quarter.message);
  const before = JSON.stringify(state.projectPlan);
  const refused = create(state, '2026-10-01', '2027-01-01');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /at most 92 days; this one covers 93\. Split it into shorter sprints\./);
  assert.equal(JSON.stringify(state.projectPlan), before, 'a refused sprint changes nothing');
});

await check('the reported 0000-01-01 to 9999-12-31 range is refused quickly', async () => {
  const state = fresh();
  const started = Date.now();
  const refused = create(state, '0000-01-01', '9999-12-31');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /Sprint dates must fall between 2000-01-01 and 2099-12-31\./);
  assert.ok(Date.now() - started < 500, 'refusal does not walk the range');
  assert.equal(state.projectPlan.sprints.length, 0);
});

await check('invalid and reversed dates are refused with a plain reason', async () => {
  const state = fresh();
  for (const [start, end] of [['2026-02-30', '2026-03-05'], ['2026-10-01', 'next week'], ['', '2026-10-05'], ['2026-13-01', '2026-13-05']]) {
    const refused = create(state, start, end);
    assert.equal(refused.ok, false, `${start} to ${end}`);
    assert.match(refused.message, /Enter the sprint start and end as real calendar dates\./);
  }
  const reversed = create(state, '2026-10-10', '2026-10-01');
  assert.equal(reversed.ok, false);
  assert.match(reversed.message, /end date is before its start date/);
  assert.equal(state.projectPlan.sprints.length, 0);
});

await check('a stored out-of-bound sprint fails validation and diagnose names it', async () => {
  for (const [start, end] of [['0000-01-01', '9999-12-31'], ['2026-01-01', '2026-12-31'], ['1999-12-31', '2000-01-10']]) {
    const state = fresh();
    state.projectPlan.sprints.push(storedSprint(start, end));
    assert.equal(host.MES.validate(state), false, `${start} to ${end} must not validate`);
    const issue = host.MES.diagnose(state);
    assert.ok(issue, 'diagnose reports the stored sprint');
    assert.equal(issue.where, 'SPT-0901');
    assert.match(issue.detail, new RegExp(`Sprint SPT-0901 runs ${start} to ${end}\\.`));
  }
  const state = fresh();
  state.projectPlan.sprints.push(storedSprint('2026-10-05', '2026-10-16'));
  assert.equal(host.MES.validate(state), true, 'a stored sprint inside the bound still validates');
  assert.equal(host.MES.diagnose(state), null);
});

await check('the sprint report is bounded even for a stored out-of-bound sprint', async () => {
  const state = fresh();
  state.projectPlan.sprints.push(storedSprint('0000-01-01', '9999-12-31'));
  const started = Date.now();
  const report = host.MES.sprintReport(state, 'SPT-0901');
  assert.ok(report.burndown.length <= 92, `burndown has ${report.burndown.length} rows`);
  assert.ok(Date.now() - started < 500, 'the report does not walk the stored range');
});

// Cross-version: a workspace saved by the release before the bound may hold a sprint that was valid then (any real
// dates, end on or after start). Upgrade moves such a sprint, unchanged, to projectPlan.retiredSprints with a reason,
// so the workspace loads and stays writable; sprints inside the bound stay where they are.
const plainJson = value => JSON.parse(JSON.stringify(value));
const legacyWorkspace = (base = seed()) => {
  const state = base; state.projectPlan = { projects: [], objectives: [], milestones: [], sprints: [
    { ...storedSprint('2026-10-01', '2027-01-01'), id: 'SPT-0001', name: 'Legacy 93 days' },
    { ...storedSprint('0000-01-01', '9999-12-31'), id: 'SPT-0002', name: 'Legacy forever' },
    { ...storedSprint('2026-10-05', '2026-10-16'), id: 'SPT-0003', name: 'Legacy two weeks' }] };
  return state;
};

await check('upgrade retires a legacy out-of-bound sprint unchanged and the workspace validates', async () => {
  const raw = legacyWorkspace();
  const originals = structuredClone(raw.projectPlan.sprints);
  const state = host.MES.upgrade(structuredClone(raw));
  assert.ok(state, 'the legacy workspace upgrades');
  assert.equal(host.MES.validate(state), true, host.MES.diagnose(state)?.detail);
  assert.deepEqual(plainJson(state.projectPlan.sprints.map(row => row.id)), ['SPT-0003'], 'the sprint inside the bound stays');
  assert.deepEqual(plainJson(state.projectPlan.retiredSprints.map(row => row.id)), ['SPT-0001', 'SPT-0002']);
  for (const row of state.projectPlan.retiredSprints) {
    const { retiredReason, retiredAt, ...kept } = row;
    assert.deepEqual(plainJson(kept), originals.find(item => item.id === row.id), `${row.id} keeps every original field`);
    assert.match(retiredReason, /^Retired on upgrade: Sprint .+ Create a new sprint of at most 92 days for this work\.$/);
    assert.ok(!Number.isNaN(Date.parse(retiredAt)));
  }
  const again = host.MES.upgrade(structuredClone(state));
  assert.deepEqual(plainJson(again.projectPlan), plainJson(state.projectPlan), 'a second upgrade changes nothing');
  assert.equal(host.MES.sprintReport(state, 'SPT-0002'), null, 'a retired sprint is not reported');
  const next = create(state, '2026-11-02', '2026-11-13');
  assert.equal(next.ok, true, next.message);
  assert.equal(next.id, 'SPT-0004', 'a new sprint never reuses a retired sprint id');
  assert.equal(host.MES.validate(state), true);
});

await check('upgrade keeps every valid legacy sprint, however many there are', async () => {
  // The previous release capped neither the sprint list nor its length, so 501 long sprints were a valid workspace.
  const raw = seed();
  raw.projectPlan = { projects: [], objectives: [], milestones: [], sprints: Array.from({ length: 501 }, (_, i) => ({ ...storedSprint('2026-01-01', '2026-12-31'), id: `SPT-${String(i + 1).padStart(4, '0')}` })) };
  const state = host.MES.upgrade(raw);
  assert.equal(state.projectPlan.retiredSprints.length, 501);
  assert.equal(host.MES.validate(state), true, host.MES.diagnose(state)?.detail);
});

await check('upgrade retires only a legacy sprint that was valid before the bound', async () => {
  // A row that was malformed in any other way stays where it is and still fails validation; the range alone never
  // turns an invalid row into an accepted retired record.
  for (const [what, change] of [
    ['negative capacity', row => { row.capacityHours = -5; }],
    ['a backlog that is not a list', row => { row.backlog = 'all of it'; }],
    ['an invalid recorder', row => { row.by = { name: '' }; }],
    ['an invalid time', row => { row.at = 'yesterday'; }],
    ['an unregistered work center', row => { row.workCenterId = 'NOWHERE'; }]
  ]) {
    const raw = seed(); const row = { ...storedSprint('2026-01-01', '2026-12-31'), id: 'SPT-0001' }; change(row);
    raw.projectPlan = { projects: [], objectives: [], milestones: [], sprints: [row] };
    const state = host.MES.upgrade(raw);
    assert.equal((state.projectPlan.retiredSprints || []).length, 0, `${what}: not retired`);
    assert.equal(host.MES.validate(state), false, `${what}: still invalid`);
  }
  const state = host.MES.upgrade(legacyWorkspace());
  const forged = structuredClone(state); forged.projectPlan.retiredSprints[0].capacityHours = -5;
  assert.equal(host.MES.validate(forged), false, 'a retired record still carries a valid sprint shape');
  const noBacklog = structuredClone(state); delete noBacklog.projectPlan.retiredSprints[0].backlog;
  assert.equal(host.MES.validate(noBacklog), false, 'a retired record keeps its backlog');
});

await check('a retired sprint record is validated', async () => {
  const state = host.MES.upgrade(legacyWorkspace());
  const tampered = structuredClone(state); tampered.projectPlan.retiredSprints[0].retiredReason = '';
  assert.equal(host.MES.validate(tampered), false, 'a retired sprint needs its reason');
  const duplicate = structuredClone(state); duplicate.projectPlan.retiredSprints[0].id = 'SPT-0003';
  assert.equal(host.MES.validate(duplicate), false, 'a retired sprint cannot share an id with a live sprint');
  const bad = structuredClone(state); bad.projectPlan.retiredSprints[0].endDate = '2026-02-30';
  assert.equal(host.MES.validate(bad), false, 'a retired sprint keeps real calendar dates');
});

// Server path: the same refusals through the authenticated action API and the initial workspace PUT.
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const SETUP_CODE = 'sprint-bounds-setup-code';
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const handler = server.listeners('request')[0];
const api = async (method, path, { token, body, headers = {} } = {}) => {
  const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  incoming.method = method; incoming.url = `/api${path}`;
  incoming.headers = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = (status, values = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)])); return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  handler(incoming, outgoing); await finished;
  const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: outgoing.statusCode, json, etag: outgoing.responseHeaders?.etag || null };
};
try {
  await check('server never stores an out-of-bound sprint as a live sprint', async () => {
    assert.equal((await api('PUT', '/auth/accounts', { body: { setupCode: SETUP_CODE, users: [{ username: 'one', displayName: 'Flight Admin', role: 'general', salt: 'salt', hash: sha('salt', 'flight-pass-123') }] } })).status, 200);
    const admin = (await api('POST', '/auth/session', { body: { username: 'one', password: 'flight-pass-123' } })).json.token;
    // A workspace PUT is upgraded before validation, so an uploaded out-of-bound sprint is kept only as a retired record.
    const bad = fresh(); bad.projectPlan.sprints.push(storedSprint('0000-01-01', '9999-12-31'));
    const put = await api('PUT', '/workspace', { token: admin, body: bad });
    assert.ok([200, 204].includes(put.status), `status ${put.status} ${JSON.stringify(put.json)}`);
    const stored = JSON.parse((await server.store.getDoc('default')).json);
    assert.equal(stored.projectPlan.sprints.length, 0, 'no live sprint is stored');
    assert.deepEqual(stored.projectPlan.retiredSprints.map(row => [row.id, row.startDate, row.endDate]), [['SPT-0901', '0000-01-01', '9999-12-31']]);
    assert.equal(server.host.MES.sprintReport(server.host.MES.upgrade(stored), 'SPT-0901'), null, 'a retired sprint is never reported');
  });
  await check('server: a workspace stored by the previous release with a legacy sprint stays writable', async () => {
    // Simulate the previous release's stored document by writing it to the store directly, past today's validation.
    const before = await server.store.getDoc('default');
    const legacy = legacyWorkspace(JSON.parse(before.json));
    const etag = await server.store.putDoc('default', JSON.stringify(legacy), before.etag, 'previous-release');
    assert.ok(etag);
    await server.store.upsertAccount({ username: 'ops-legacy', displayName: 'Ops Legacy', role: 'ops', salt: 's3', hash: sha('s3', 'ops-legacy-1234'), createdBy: 'one' });
    const token = (await api('POST', '/auth/session', { body: { username: 'ops-legacy', password: 'ops-legacy-1234' } })).json.token;
    const loaded = await api('GET', '/workspace', { token });
    assert.equal(loaded.status, 200);
    const made = await api('POST', '/workspace/actions/MES.createSprint', { token, body: { args: [{ name: 'After upgrade', workCenterId, startDate: '2026-11-02', endDate: '2026-11-13', backlog: [] }] }, headers: { 'If-Match': etag } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const stored = JSON.parse((await server.store.getDoc('default')).json);
    assert.deepEqual(stored.projectPlan.retiredSprints.map(row => row.id), ['SPT-0001', 'SPT-0002'], 'the legacy sprints are kept as retired records');
    assert.deepEqual(stored.projectPlan.sprints.map(row => row.id), ['SPT-0003', 'SPT-0004']);
    assert.equal(server.host.MES.validate(server.host.MES.upgrade(stored)), true);
  });
  await check('server action refuses an out-of-bound sprint and accepts a normal one', async () => {
    await server.store.upsertAccount({ username: 'ops-planner', displayName: 'Ops Planner', role: 'ops', salt: 's2', hash: sha('s2', 'ops-pass-1234'), createdBy: 'one' });
    const token = (await api('POST', '/auth/session', { body: { username: 'ops-planner', password: 'ops-pass-1234' } })).json.token;
    assert.ok(token);
    const before = await server.store.getDoc('default');
    const refused = await api('POST', '/workspace/actions/MES.createSprint', { token, body: { args: [{ name: 'Forever', workCenterId, startDate: '0000-01-01', endDate: '9999-12-31', backlog: [] }] }, headers: { 'If-Match': before.etag } });
    assert.ok(refused.status >= 400 && refused.status < 500, `status ${refused.status}`);
    assert.match(refused.json.error, /Sprint dates must fall between 2000-01-01 and 2099-12-31\./);
    assert.equal((await server.store.getDoc('default')).etag, before.etag, 'the refused action stores nothing');
    const long = await api('POST', '/workspace/actions/MES.createSprint', { token, body: { args: [{ name: 'Half year', workCenterId, startDate: '2026-10-01', endDate: '2027-03-31', backlog: [] }] }, headers: { 'If-Match': before.etag } });
    assert.ok(long.status >= 400 && long.status < 500, `status ${long.status}`);
    assert.match(long.json.error, /at most 92 days/);
    const made = await api('POST', '/workspace/actions/MES.createSprint', { token, body: { args: [{ name: 'Two weeks', workCenterId, startDate: '2026-10-05', endDate: '2026-10-16', backlog: [] }] }, headers: { 'If-Match': before.etag } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const stored = JSON.parse((await server.store.getDoc('default')).json);
    assert.equal(stored.projectPlan.sprints.at(-1).endDate, '2026-10-16');
  });
} finally {
  server.close?.(); server.store?.close?.();
}

console.log('FAILS', JSON.stringify(FAILS));
if (FAILS.length) process.exitCode = 1;
