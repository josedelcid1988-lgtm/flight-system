// #234: the PostgreSQL password never reaches pg_restore or pg_dump as a command-line argument, where anyone who can
// read the process table sees it while the tool runs. pgRestoreTarget splits a connection string into the --dbname
// argument without its password and a PGPASSWORD value for the child's own environment, for both connection string
// forms. restorePostgres is run against a stand-in pg_restore on PATH that records what it was given, so no database
// or PostgreSQL client tools are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pgRestoreTarget, restorePostgres } from '../server/db-postgres.mjs';

let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the split, for each connection string form --------------------------------------------------------------
const cases = [
  ['a URI with a password', 'postgresql://flight:s3cr%40t@db:5432/flight', { dbname: 'postgresql://flight@db:5432/flight', env: { PGPASSWORD: 's3cr@t' } }],
  ['a postgres:// URI with a password', 'postgres://flight:pw@db/flight?sslmode=require', { dbname: 'postgres://flight@db/flight?sslmode=require', env: { PGPASSWORD: 'pw' } }],
  ['a URI with the password in its query', 'postgresql://flight@db/flight?password=pw&sslmode=require', { dbname: 'postgresql://flight@db/flight?sslmode=require', env: { PGPASSWORD: 'pw' } }],
  ['a URI with no password', 'postgresql://flight@db/flight', { dbname: 'postgresql://flight@db/flight', env: {} }],
  ['keywords with a plain password', 'host=db user=flight password=plain dbname=flight', { dbname: 'host=db user=flight  dbname=flight', env: { PGPASSWORD: 'plain' } }],
  ['keywords with a quoted password', "host=db password='it\\'s a pass' dbname=flight", { dbname: 'host=db  dbname=flight', env: { PGPASSWORD: "it's a pass" } }],
  ['keywords with no password', 'host=db dbname=flight', { dbname: 'host=db dbname=flight', env: {} }],
];
for (const [label, input, want] of cases) {
  const got = pgRestoreTarget(input);
  check(`${label}: the password leaves the --dbname argument for PGPASSWORD`, same(got, want), JSON.stringify(got));
}

// ---- restorePostgres passes no password in pg_restore's arguments ---------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-pgpass-'));
const log = path.join(dir, 'calls.jsonl');
const fake = path.join(dir, 'pg_restore');
fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), password: process.env.PGPASSWORD ?? null }) + '\\n');\nif (process.argv.includes('--list')) process.stdout.write('1; 2 3 TABLE DATA public workspace flight\\n');\n`, { mode: 0o755 });
const archive = path.join(dir, 'backup.dump');
fs.writeFileSync(archive, 'stand-in archive');
const savedPath = process.env.PATH, savedPassword = process.env.PGPASSWORD;
process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
delete process.env.PGPASSWORD;
try {
  const secret = 'Do-not-print-9';
  assert.equal(await restorePostgres(`postgresql://flight:${secret}@db:5432/flight`, archive, { clean: true }), 0);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const restore = calls.find(call => call.args.includes('--single-transaction'));
  check('restorePostgres ran pg_restore for the list and the restore', calls.length === 2 && !!restore, JSON.stringify(calls));
  check('no pg_restore argument carries the password', calls.every(call => call.args.every(arg => !arg.includes(secret))), JSON.stringify(calls.map(c => c.args)));
  check('the restore names the database without the password', restore.args[restore.args.indexOf('--dbname') + 1] === 'postgresql://flight@db:5432/flight', JSON.stringify(restore.args));
  check('the restore receives the password in PGPASSWORD', restore.password === secret);
} finally {
  process.env.PATH = savedPath;
  if (savedPassword === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = savedPassword;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- pg_dump (store.backup) takes the same path ----------------------------------------------------------------
const source = fs.readFileSync(new URL('../server/db-postgres.mjs', import.meta.url), 'utf8');
check('pg_dump is given the --dbname without the password and PGPASSWORD in its environment', /spawn\('pg_dump', \['--format=custom', '--file', destination, '--dbname', target\.dbname\], \{[^}]*env: \{ \.\.\.process\.env, \.\.\.target\.env \}/.test(source));
check('no spawn passes the raw connection string as an argument', !/'--dbname', connectionString/.test(source));

console.log(`FAILS []\n${checks} checks passed`);
