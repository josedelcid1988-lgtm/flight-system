// Issue #174: the one-time, read-only scan of stored archive rows for an own "__proto__" key.
// Runs the real tools/scan-archive-proto.mjs entry point against SQLite stores built here with the server's
// own store module, and checks the report, the exit codes, and that the store files are byte for byte unchanged.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'scan-archive-proto.mjs');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fs-archive-proto-scan-'));

const fails = [];
const ok = (what, cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + msg));
  if (!cond) fails.push(what);
};

// Rows go in through the server's own putArchived, the way the archive route stores them, with the JSON text
// written as given so a row can hold what a server before #168 would have accepted.
const order = (id, extra = {}) => ({ order: { id, status: 'Closed', operations: [{ n: 10, title: 'Assemble' }], tickets: [] }, activity: [], ...extra });
function storeWith(name, rows) {
  const file = path.join(TMP, name, 'flight.sqlite');
  fs.mkdirSync(path.dirname(file));
  const store = openDb(file);
  for (const [id, json] of rows) store.putArchived({ id, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: 'PN-1', serials: [], lots: [], parts: [], title: id, closedAt: '2026-09-01T00:00:00.000Z' }, by: 'test' });
  store.close();
  return file;
}
// Every file in the store's folder with its SHA-256, so a created -wal or -shm file counts as a change too.
const snapshot = file => JSON.stringify(Object.fromEntries(fs.readdirSync(path.dirname(file)).sort().map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(path.dirname(file), f))).digest('hex')])));
const scan = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, FLIGHT_DATABASE_URL: '', FLIGHT_DB: '' } });

// ---- a clean archive reports nothing and exits 0 ----
{
  // A string value that mentions "__proto__" is text, not a key, and is not flagged.
  const file = storeWith('clean', [['WO-1001', JSON.stringify(order('WO-1001'))], ['WO-1002', JSON.stringify(order('WO-1002', { note: 'the text "__proto__": is only text' }))]]);
  const before = snapshot(file);
  const run = scan('--db', file);
  ok('clean: exits 0', run.status === 0, `status=${run.status} ${run.stderr.slice(0, 200)}`);
  ok('clean: reports 2 rows scanned', /Rows scanned: 2\b/.test(run.stdout), run.stdout);
  ok('clean: reports 0 rows flagged', /Rows flagged: 0\b/.test(run.stdout), run.stdout);
  ok('clean: no row listed', !/FLAGGED/.test(run.stdout), run.stdout);
  ok('clean: store files unchanged', snapshot(file) === before, `${before} -> ${snapshot(file)}`);
}

// ---- a nested own __proto__ key is reported with its record id and path, and exits 1 ----
{
  const tainted = '{"order":{"id":"WO-2002","status":"Closed","operations":[{"n":10,"title":"Assemble"},{"n":20,"__proto__":{"inspected":true}}],"tickets":[]},"activity":[]}';
  const file = storeWith('tainted', [['WO-2001', JSON.stringify(order('WO-2001'))], ['WO-2002', tainted], ['WO-2003', JSON.stringify(order('WO-2003'))]]);
  const before = snapshot(file);
  const run = scan('--db', file);
  ok('tainted: exits 1', run.status === 1, `status=${run.status} ${run.stderr.slice(0, 200)}`);
  ok('tainted: reports 3 rows scanned', /Rows scanned: 3\b/.test(run.stdout), run.stdout);
  ok('tainted: reports 1 row flagged', /Rows flagged: 1\b/.test(run.stdout), run.stdout);
  ok('tainted: names the record and the path', /FLAGGED WO-2002 .*WO-2002\.order\.operations\[1\]/.test(run.stdout), run.stdout);
  ok('tainted: clean rows are not listed', !/FLAGGED WO-2001|FLAGGED WO-2003/.test(run.stdout), run.stdout);
  ok('tainted: store files unchanged', snapshot(file) === before, `${before} -> ${snapshot(file)}`);
}

// ---- 5000 levels of nesting are scanned without a stack overflow ----
{
  const depth = 5000;
  const deep = `{"order":{"id":"WO-3001","status":"Closed","operations":[],"tickets":[]},"detail":${'{"a":'.repeat(depth)}{"__proto__":{"x":1}}${'}'.repeat(depth)}}`;
  const file = storeWith('deep', [['WO-3001', deep]]);
  const before = snapshot(file);
  const run = scan('--db', file);
  ok('deep: exits 1, not 2', run.status === 1, `status=${run.status} ${(run.stderr || run.stdout).slice(0, 300)}`);
  ok('deep: flagged with the full path', run.stdout.includes(`FLAGGED WO-3001 own "__proto__" key at WO-3001.detail${'.a'.repeat(depth)}\n`), run.stdout.slice(0, 300));
  ok('deep: store files unchanged', snapshot(file) === before, 'changed');
}

// ---- a running server: rows still in the -wal file are scanned, and the database and -wal bytes do not change ----
{
  const file = storeWith('live', [['WO-5001', JSON.stringify(order('WO-5001'))]]);
  const live = openDb(file);
  live.putArchived({ id: 'WO-5002', json: '{"order":{"id":"WO-5002","status":"Closed","operations":[],"tickets":[{"__proto__":{}}]}}', sha256: 'f'.repeat(64), schema: 1, keys: { serials: [], lots: [], parts: [] }, by: 'test' });
  const files = () => JSON.parse(snapshot(file));
  const before = files();
  const run = scan('--db', file);
  const after = files();
  live.close();
  ok('live: -wal file present during the scan', 'flight.sqlite-wal' in before, Object.keys(before).join(','));
  ok('live: row only in the -wal is flagged', run.status === 1 && /Rows scanned: 2\b/.test(run.stdout) && /FLAGGED WO-5002 .*WO-5002\.order\.tickets\[0\]/.test(run.stdout), `status=${run.status} ${run.stdout}${run.stderr}`);
  ok('live: database and -wal bytes unchanged', before['flight.sqlite'] === after['flight.sqlite'] && before['flight.sqlite-wal'] === after['flight.sqlite-wal'], JSON.stringify({ before, after }));
}

// ---- a row whose JSON does not parse is an error (exit 2): the scan could not check it ----
{
  const file = storeWith('unreadable', [['WO-4001', JSON.stringify(order('WO-4001'))], ['WO-4002', '{"order":']]);
  const before = snapshot(file);
  const run = scan('--db', file);
  ok('unreadable: exits 2', run.status === 2, `status=${run.status}`);
  ok('unreadable: names the row it could not read', /UNREADABLE WO-4002/.test(run.stdout), run.stdout + run.stderr);
  ok('unreadable: store files unchanged', snapshot(file) === before, 'changed');
}

// ---- a missing store is an error (exit 2) and is not created ----
{
  const file = path.join(TMP, 'missing', 'flight.sqlite');
  const run = scan('--db', file);
  ok('missing: exits 2', run.status === 2, `status=${run.status}`);
  ok('missing: says what is wrong', /could not finish/i.test(run.stderr), run.stderr);
  ok('missing: no file or folder created', !fs.existsSync(path.dirname(file)), 'created');
}

// ---- a store without an archive table is an error (exit 2), and gets no table ----
{
  const file = path.join(TMP, 'other', 'flight.sqlite');
  fs.mkdirSync(path.dirname(file));
  const db = new DatabaseSync(file); db.exec('CREATE TABLE unrelated (id TEXT)'); db.close();
  const before = snapshot(file);
  const run = scan('--db', file);
  ok('no archive table: exits 2', run.status === 2, `status=${run.status}`);
  ok('no archive table: store files unchanged', snapshot(file) === before, 'changed');
}

// ---- an unreachable PostgreSQL store is an error (exit 2), and the connection string is never printed ----
{
  const run = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { ...process.env, FLIGHT_DATABASE_URL: 'postgresql://scanuser:not-a-real-secret@127.0.0.1:1/none', FLIGHT_DB: '' } });
  ok('postgres unreachable: exits 2', run.status === 2, `status=${run.status}`);
  ok('postgres: connection string not printed', !/not-a-real-secret/.test(run.stdout + run.stderr), run.stdout + run.stderr);
}
// ---- a --database-url that carries a password is refused before anything connects (#584) ----
{
  const run = scan('--database-url', 'postgresql://scanuser:not-a-real-secret@127.0.0.1:1/none');
  ok('postgres password on the command line: exits 2', run.status === 2, `status=${run.status}`);
  ok('postgres password on the command line: refused with the environment variable named', /carries a password/.test(run.stderr) && /FLIGHT_DATABASE_URL/.test(run.stderr) && !/Store:/.test(run.stdout), run.stdout + run.stderr);
  ok('postgres password on the command line: connection string not printed', !/not-a-real-secret/.test(run.stdout + run.stderr), run.stdout + run.stderr);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `FAILS ${JSON.stringify(fails)}` : 'archive proto scan: all checks passed');
process.exit(fails.length ? 1 : 0);
