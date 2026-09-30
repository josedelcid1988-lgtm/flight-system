// Issue #174 on PostgreSQL: tools/scan-archive-proto.mjs reads the archive in a read-only transaction, reports an
// own "__proto__" key with its record id and path, and changes nothing. Runs in scratch databases it creates and
// drops, as backup_restore.mjs does. Skips with a reason when there is no PostgreSQL to talk to.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPostgres, openPostgresReadOnly } from '../../server/db-postgres.mjs';

const connectionString = process.env.FLIGHT_DATABASE_URL;
if (!connectionString) {
  console.log('SKIP PostgreSQL archive "__proto__" scan: FLIGHT_DATABASE_URL is not set.');
  process.exit(0);
}

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'scan-archive-proto.mjs');
const tag = randomUUID().replaceAll('-', '');
const urlFor = name => { const url = new URL(connectionString); url.pathname = `/${name}`; return url.href; };
const seeded = `flight_scan_${tag}`, empty = `flight_scan_empty_${tag}`;
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

let store = null;
try {
  await adminPool.query(`CREATE DATABASE "${seeded}"`);
  await adminPool.query(`CREATE DATABASE "${empty}"`);
  store = await openPostgres(urlFor(seeded));
  await put(store, 'WO-PG-1', JSON.stringify({ order: { id: 'WO-PG-1', status: 'Closed', operations: [], tickets: [] }, note: 'text "__proto__": only' }));

  let before = await fingerprint(urlFor(seeded));
  let run = scan(urlFor(seeded));
  assert.equal(run.status, 0, `clean archive exits 0: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /Rows scanned: 1\b/);
  assert.match(run.stdout, /Rows flagged: 0\b/);
  assert.equal(await fingerprint(urlFor(seeded)), before, 'clean scan changes nothing');
  console.log('ok PostgreSQL clean archive reports 0 and changes nothing');

  await put(store, 'WO-PG-2', '{"order":{"id":"WO-PG-2","status":"Closed","operations":[{"n":10,"__proto__":{"inspected":true}}],"tickets":[]}}');
  before = await fingerprint(urlFor(seeded));
  run = scan(urlFor(seeded));
  assert.equal(run.status, 1, `flagged archive exits 1: ${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /Rows scanned: 2\b/);
  assert.match(run.stdout, /FLAGGED WO-PG-2 own "__proto__" key at WO-PG-2\.order\.operations\[0\]\n/);
  assert.doesNotMatch(run.stdout, /FLAGGED WO-PG-1/);
  assert.equal(await fingerprint(urlFor(seeded)), before, 'flagging scan changes nothing');
  const password = decodeURIComponent(new URL(connectionString).password || '');
  assert.ok(!password || !(run.stdout + run.stderr).includes(password), 'no password printed');
  console.log('ok PostgreSQL row with an own __proto__ key reported with its path, nothing changed');

  // No schema step: a database without the Flight tables stays without them, and the scan says it could not finish.
  before = await fingerprint(urlFor(empty));
  run = scan(urlFor(empty));
  assert.equal(run.status, 2, `database without an archive exits 2: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /Scan could not finish/);
  assert.equal(await fingerprint(urlFor(empty)), before, 'no table created');
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
} finally {
  await store?.close().catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${seeded}"`).catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${empty}"`).catch(() => {});
  await adminPool.end().catch(() => {});
}
