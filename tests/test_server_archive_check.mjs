// Issue #174 follow-up: the server runs the archive "__proto__" scan once at startup, after it listens, against its
// own store. A clean archive logs one line, a flagged row logs a warning naming the work order and path, a scan error
// logs a warning and the server keeps serving, and the archive rows are unchanged.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, openDbReadOnly } from '../server/db.mjs';
import { createServer } from '../server/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fs-archive-check-'));

const fails = [];
const ok = (what, cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + msg));
  if (!cond) fails.push(what);
};

const order = id => JSON.stringify({ order: { id, status: 'Closed', operations: [{ n: 10, title: 'Assemble' }], tickets: [] }, activity: [] });
function storeWith(name, rows) {
  const file = path.join(TMP, name, 'flight.sqlite');
  fs.mkdirSync(path.dirname(file));
  const store = openDb(file);
  for (const [id, json] of rows) store.putArchived({ id, json, sha256: createHash('sha256').update(json).digest('hex'), schema: 1, keys: { partNumber: 'PN-1', serials: [], lots: [], parts: [], title: id, closedAt: '2026-09-01T00:00:00.000Z' }, by: 'test' });
  store.close();
  return file;
}
// The archive table's row count and a hash of its rows, read without a schema step.
async function archiveFingerprint(file) {
  const reader = openDbReadOnly(file);
  try {
    const hash = createHash('sha256');
    let count = 0;
    for await (const row of reader.archiveRows()) { count += 1; hash.update(`${row.id}\n${row.json}\n`); }
    return `${count}:${hash.digest('hex')}`;
  } finally { reader.close(); }
}

// Starts the real server entry point on a free port and returns its output once the check line shows (or 20 s pass).
function startServer(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER, '--db', file, '--port', '0'], { env: { ...process.env, FLIGHT_DATABASE_URL: '', FLIGHT_DB: '', FLIGHT_HOST: '' } });
    let out = '';
    const timer = setTimeout(() => child.kill(), 20000);
    const take = chunk => { out += chunk; if (/archive __proto__ check/.test(out)) { clearTimeout(timer); setTimeout(() => child.kill(), 200); } };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
}

// ---- a clean archive logs the clean line after the server listens ----
{
  const file = storeWith('clean', [['WO-1001', order('WO-1001')], ['WO-1002', order('WO-1002')]]);
  const before = await archiveFingerprint(file);
  const out = await startServer(file);
  ok('clean: logs the clean line', /archive __proto__ check: 2 rows scanned, 0 flagged/.test(out), out);
  ok('clean: no warning', !/WARNING/.test(out), out);
  ok('clean: logged after the server listens', out.indexOf('listening on') >= 0 && out.indexOf('listening on') < out.indexOf('archive __proto__ check'), out);
  ok('clean: archive rows unchanged', await archiveFingerprint(file) === before, 'changed');
}

// ---- a planted nested own __proto__ key logs a warning naming the work order and the path ----
{
  const tainted = '{"order":{"id":"WO-2002","status":"Closed","operations":[{"n":10,"title":"Assemble"},{"n":20,"__proto__":{"inspected":true}}],"tickets":[]},"activity":[]}';
  const file = storeWith('tainted', [['WO-2001', order('WO-2001')], ['WO-2002', tainted]]);
  const before = await archiveFingerprint(file);
  const out = await startServer(file);
  ok('tainted: warning with the count', /WARNING archive __proto__ check: 2 rows scanned, 1 flagged/.test(out), out);
  ok('tainted: names the work order and the path', /WO-2002 own "__proto__" key at WO-2002\.order\.operations\[1\]/.test(out), out);
  ok('tainted: clean row not named', !/WO-2001 own/.test(out), out);
  ok('tainted: archive rows unchanged', await archiveFingerprint(file) === before, 'changed');
}

// ---- a scan error logs a warning and the server keeps serving ----
{
  const file = path.join(TMP, 'error', 'flight.sqlite');
  const lines = [];
  const original = { log: console.log, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  let server, result, status;
  try {
    server = createServer({ dbPath: file, archiveScanOpen: async () => { throw new Error('archive unavailable for the test'); } });
    const port = await server.listenAsync(0, '127.0.0.1');
    result = await server.archiveCheck;
    status = (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
  } catch (error) {
    lines.push(`threw: ${error.message}`);
  } finally {
    console.log = original.log; console.warn = original.warn;
    await server?.closeAsync().catch(() => {});
  }
  ok('error: check settles without throwing', !!result?.error, JSON.stringify(result));
  ok('error: warning logged', lines.some(l => /WARNING archive __proto__ check could not finish: archive unavailable for the test/.test(l)), lines.join('\n'));
  ok('error: server still answers', status === 200, `status=${status}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails.length ? `FAILS ${JSON.stringify(fails)}` : 'FAILS []');
process.exit(fails.length ? 1 : 0);
