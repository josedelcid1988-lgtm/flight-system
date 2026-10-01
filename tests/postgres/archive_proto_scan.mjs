// Issue #174 on PostgreSQL: tools/scan-archive-proto.mjs reads the archive in a read-only transaction, reports an
// own "__proto__" key with its record id and path, and changes nothing; the server's startup check runs the same scan
// against its own PostgreSQL store and logs the result. Runs in scratch databases it creates and drops, as
// backup_restore.mjs does, so it cannot disturb other PostgreSQL tests. Skips with a reason when there is no
// PostgreSQL to talk to.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPostgres, openPostgresReadOnly } from '../../server/db-postgres.mjs';

const connectionString = process.env.FLIGHT_DATABASE_URL;
if (!connectionString) {
  console.log('SKIP PostgreSQL archive "__proto__" scan: FLIGHT_DATABASE_URL is not set.');
  process.exit(0);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'tools', 'scan-archive-proto.mjs');
const SERVER = path.join(ROOT, 'server', 'server.mjs');
const tag = randomUUID().replaceAll('-', '');
const urlFor = name => { const url = new URL(connectionString); url.pathname = `/${name}`; return url.href; };
const seeded = `flight_scan_${tag}`, empty = `flight_scan_empty_${tag}`, clean = `flight_scan_clean_${tag}`;
const { Pool } = await import('pg');
const adminPool = new Pool({ connectionString: urlFor('postgres') });
// The connection string goes in through the environment, as an operator would set it, and never on the command line.
const scan = url => spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { ...process.env, FLIGHT_DATABASE_URL: url, FLIGHT_DB: '' } });
const put = (store, id, json) => store.putArchived({ id, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 82, keys: { partNumber: 'PN-1', serials: [], lots: [], parts: [], title: id, closedAt: '2026-09-01T00:00:00.000Z' }, by: 'scan-test' });
// Every table's rows, hashed, plus the table list: a changed row or a created table both show.
const fingerprint = async url => {
  const pool = new Pool({ connectionString: url });
  try {
    const tables = (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name')).rows.map(r => r.table_name);
    const rows = {};
    for (const t of tables) rows[t] = (await pool.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0].h;
    return JSON.stringify({ tables, rows });
  } finally { await pool.end(); }
};

// The archive table alone: its row count and a checksum of every row, in order.
const archiveState = async url => {
  const pool = new Pool({ connectionString: url });
  try {
    const { n, h } = (await pool.query("SELECT count(*)::int AS n, md5(coalesce(string_agg(order_id || E'\\n' || json, E'\\n' ORDER BY order_id), '')) AS h FROM archive")).rows[0];
    return { count: n, checksum: h };
  } finally { await pool.end(); }
};
const password = decodeURIComponent(new URL(connectionString).password || '');
// Neither the connection string nor its password may appear in what a scan or the server prints.
const noCredentials = (text, url, what) => {
  assert.ok(!text.includes(url) && !text.includes(connectionString), `${what}: connection string not printed`);
  assert.ok(!password || !text.includes(password), `${what}: password not printed`);
};
// Starts the real server entry point against a PostgreSQL store and returns its output once the check line shows.
const startServer = url => new Promise(resolve => {
  const child = spawn(process.execPath, [SERVER, '--port', '0'], { env: { ...process.env, FLIGHT_DATABASE_URL: url, FLIGHT_DB: '', FLIGHT_HOST: '' } });
  let out = '';
  const timer = setTimeout(() => child.kill(), 30000);
  const take = chunk => { out += chunk; if (/archive __proto__ check/.test(out)) { clearTimeout(timer); setTimeout(() => child.kill(), 200); } };
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.on('exit', () => { clearTimeout(timer); resolve(out); });
});

let store = null;
try {
  await adminPool.query(`CREATE DATABASE "${seeded}"`);
  await adminPool.query(`CREATE DATABASE "${empty}"`);
  store = await openPostgres(urlFor(seeded));
  await put(store, 'WO-PG-1', JSON.stringify({ order: { id: 'WO-PG-1', status: 'Closed', operations: [], tickets: [] }, note: 'text "__proto__": only' }));

  let before = await fingerprint(urlFor(seeded));
  let archiveBefore = await archiveState(urlFor(seeded));
  let run = scan(urlFor(seeded));
  assert.equal(run.status, 0, `clean archive exits 0: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /Rows scanned: 1\b/);
  assert.match(run.stdout, /Rows flagged: 0\b/);
  assert.doesNotMatch(run.stdout, /FLAGGED/);
  assert.equal(await fingerprint(urlFor(seeded)), before, 'clean scan changes nothing');
  assert.deepEqual(await archiveState(urlFor(seeded)), archiveBefore, 'clean scan: archive row count and checksum unchanged');
  assert.equal(archiveBefore.count, 1);
  noCredentials(run.stdout + run.stderr, urlFor(seeded), 'clean scan');
  console.log('ok PostgreSQL clean archive reports 0 and changes nothing');

  await put(store, 'WO-PG-2', '{"order":{"id":"WO-PG-2","status":"Closed","operations":[{"n":10,"__proto__":{"inspected":true}}],"tickets":[]}}');
  before = await fingerprint(urlFor(seeded));
  archiveBefore = await archiveState(urlFor(seeded));
  run = scan(urlFor(seeded));
  assert.equal(run.status, 1, `flagged archive exits 1: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /Rows scanned: 2\b/);
  assert.match(run.stdout, /Rows flagged: 1\b/);
  assert.match(run.stdout, /FLAGGED WO-PG-2 own "__proto__" key at WO-PG-2\.order\.operations\[0\]\n/);
  assert.doesNotMatch(run.stdout, /FLAGGED WO-PG-1/);
  assert.equal(await fingerprint(urlFor(seeded)), before, 'flagging scan changes nothing');
  assert.deepEqual(await archiveState(urlFor(seeded)), archiveBefore, 'flagging scan: archive row count and checksum unchanged');
  assert.equal(archiveBefore.count, 2);
  noCredentials(run.stdout + run.stderr, urlFor(seeded), 'flagging scan');
  console.log('ok PostgreSQL row with an own __proto__ key reported with its path, nothing changed');

  // No schema step: a database without the Flight tables stays without them, and the scan says it could not finish.
  before = await fingerprint(urlFor(empty));
  run = scan(urlFor(empty));
  assert.equal(run.status, 2, `database without an archive exits 2: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /Scan could not finish/);
  assert.equal(await fingerprint(urlFor(empty)), before, 'no table created');
  noCredentials(run.stdout + run.stderr, urlFor(empty), 'failed scan');
  console.log('ok PostgreSQL scan runs no schema step and creates nothing');

  // Paging keeps every row, in order, inside the one snapshot.
  const reader = await openPostgresReadOnly(urlFor(seeded));
  try {
    const rows = [];
    for await (const row of reader.archiveRows(1)) rows.push(row.id);
    assert.deepEqual(rows, ['WO-PG-1', 'WO-PG-2'], 'pages of one row still read every row in order');
  } finally { await reader.close(); }
  // The session setting the scan connects with makes PostgreSQL refuse a write.
  const probe = new Pool({ connectionString: urlFor(seeded), options: '-c default_transaction_read_only=on' });
  try { await assert.rejects(probe.query("DELETE FROM archive WHERE order_id = 'WO-PG-1'"), /read-only transaction/); } finally { await probe.end(); }
  console.log('ok PostgreSQL read-only session setting refuses a write');

  // The server's startup check on PostgreSQL: a clean store logs the clean line, a planted row logs a warning naming
  // the work order and path, the archive rows are unchanged, and no credential is printed.
  await adminPool.query(`CREATE DATABASE "${clean}"`);
  const cleanStore = await openPostgres(urlFor(clean));
  try { await put(cleanStore, 'WO-PG-9', JSON.stringify({ order: { id: 'WO-PG-9', status: 'Closed', operations: [], tickets: [] } })); } finally { await cleanStore.close(); }
  archiveBefore = await archiveState(urlFor(clean));
  let out = await startServer(urlFor(clean));
  assert.match(out, /archive __proto__ check: 1 row scanned, 0 flagged/, out);
  assert.doesNotMatch(out, /WARNING/, out);
  assert.ok(out.indexOf('listening on') >= 0 && out.indexOf('listening on') < out.indexOf('archive __proto__ check'), `check logged after the server listens: ${out}`);
  assert.deepEqual(await archiveState(urlFor(clean)), archiveBefore, 'startup check on a clean store: archive unchanged');
  noCredentials(out, urlFor(clean), 'server start, clean store');
  console.log('ok PostgreSQL server start logs the clean archive check line');

  await store.close(); store = null;
  archiveBefore = await archiveState(urlFor(seeded));
  out = await startServer(urlFor(seeded));
  assert.match(out, /WARNING archive __proto__ check: 2 rows scanned, 1 flagged: WO-PG-2 own "__proto__" key at WO-PG-2\.order\.operations\[0\]/, out);
  assert.doesNotMatch(out, /WO-PG-1 own/, out);
  assert.deepEqual(await archiveState(urlFor(seeded)), archiveBefore, 'startup check on a flagged store: archive unchanged');
  noCredentials(out, urlFor(seeded), 'server start, flagged store');
  console.log('ok PostgreSQL server start warns with the flagged work order and path, nothing changed');
} finally {
  await store?.close().catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${seeded}"`).catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${empty}"`).catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${clean}"`).catch(() => {});
  await adminPool.end().catch(() => {});
}
