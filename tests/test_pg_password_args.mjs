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
  // Codex 4160965073: libpq allows a URI with no host (a local socket); the password still leaves the argument.
  ['an empty-host socket URI', 'postgresql://flight:secret@/flight', { dbname: 'postgresql://flight@/flight', env: { PGPASSWORD: 'secret' } }],
  // Codex 4160965098: a ?password= after the user info is the one libpq uses.
  ['a URI whose query password overrides its user info', 'postgresql://flight:old@db/flight?password=rotated', { dbname: 'postgresql://flight@db/flight', env: { PGPASSWORD: 'rotated' } }],
  // Codex 4160965088: the other query parameters are kept byte for byte (%20 stays %20, never +).
  ['a URI with percent-encoded options', 'postgresql://flight@db/flight?options=-c%20synchronous_commit%3Doff&password=pw', { dbname: 'postgresql://flight@db/flight?options=-c%20synchronous_commit%3Doff', env: { PGPASSWORD: 'pw' } }],
  ['a multi-host URI', 'postgres://flight:pw@h1:5432,h2/flight', { dbname: 'postgres://flight@h1:5432,h2/flight', env: { PGPASSWORD: 'pw' } }],
  ['keywords with a plain password', 'host=db user=flight password=plain dbname=flight', { dbname: 'host=db user=flight dbname=flight', env: { PGPASSWORD: 'plain' } }],
  ['keywords with a quoted password', "host=db password='it\\'s a pass' dbname=flight", { dbname: 'host=db dbname=flight', env: { PGPASSWORD: "it's a pass" } }],
  // Codex 4160965078: every password assignment leaves the argument, and the last one is the password libpq uses.
  ['keywords with a repeated password', 'password=old host=db password=current dbname=flight', { dbname: 'host=db dbname=flight', env: { PGPASSWORD: 'current' } }],
  ['keywords with no password', 'host=db dbname=flight', { dbname: 'host=db dbname=flight', env: {} }],
  // Codex 4161235788: libpq unescapes a backslash in an unquoted value too, so \\ is one backslash.
  ['keywords with an escaped backslash, unquoted', 'host=db password=pa\\\\ss dbname=flight', { dbname: 'host=db dbname=flight', env: { PGPASSWORD: 'pa\\ss' } }],
  ['keywords with an escaped quote, unquoted', "host=db password=it\\'s", { dbname: 'host=db', env: { PGPASSWORD: "it's" } }],
  // Codex 4161531100: a ' inside an unquoted value is an ordinary character to libpq.
  ['keywords with an apostrophe inside an unquoted password', "password=it's host=db", { dbname: 'host=db', env: { PGPASSWORD: "it's" } }],
  // Codex 4161531104: kept settings are copied exactly, so an escaped trailing space keeps its meaning.
  ['keywords with an escaped trailing space in a kept value', 'dbname=flight\\  password=secret host=db', { dbname: 'dbname=flight\\  host=db', env: { PGPASSWORD: 'secret' } }],
  // Codex 4161531093: libpq's URI has no fragment, so a # is part of the password, wherever the password is.
  ['a URI query password with a #', 'postgresql://flight@db/flight?password=Head#Tail', { dbname: 'postgresql://flight@db/flight', env: { PGPASSWORD: 'Head#Tail' } }],
  ['a URI user-info password with a #', 'postgresql://flight:Head#Tail@db/flight', { dbname: 'postgresql://flight@db/flight', env: { PGPASSWORD: 'Head#Tail' } }],
  // libpq takes the user info up to the first @ before any /, so an unencoded ? stays in the password (Codex 4161235818).
  ['a URI user-info password with an unencoded ?', 'postgresql://flight:Hidden-1?Tail@db/flight', { dbname: 'postgresql://flight@db/flight', env: { PGPASSWORD: 'Hidden-1?Tail' } }],
  // Codex 4161788869: the first @ ends the user info, so a host that starts with @ (an abstract socket) stays the host.
  ['a URI whose host starts with @', 'postgresql://flight:Secret-9@@flight-socket/flight', { dbname: 'postgresql://flight@@flight-socket/flight', env: { PGPASSWORD: 'Secret-9' } }],
  // Codex 4161788877: an @ in a query value is ordinary data.
  ['a URI query password with an @', 'postgresql://flight@db/flight?password=p@q', { dbname: 'postgresql://flight@db/flight', env: { PGPASSWORD: 'p@q' } }],
  // Jinx review 5387290877 (P3): an @ in the database name is ordinary data, with or without user info.
  ['a URI database name with an @', 'postgresql://flight:pw@db/my@db', { dbname: 'postgresql://flight@db/my@db', env: { PGPASSWORD: 'pw' } }],
  ['a URI database name with an @ and no user info', 'postgresql://db/my@db', { dbname: 'postgresql://db/my@db', env: {} }],
  // Codex 4161788875: an empty password is no password to libpq, so the inherited PGPASSWORD is left alone.
  ['a URI with an empty user-info password', 'postgresql://flight:@db/flight', { dbname: 'postgresql://flight@db/flight', env: {} }],
  ['a URI whose empty query password overrides the user info', 'postgresql://flight:old@db/flight?password=', { dbname: 'postgresql://flight@db/flight', env: {} }],
  ['keywords with an empty quoted password', "host=db password=''", { dbname: 'host=db', env: {} }],
  ['an IPv6 host with a port', 'postgresql://flight:pw@[::1]:5432/flight', { dbname: 'postgresql://flight@[::1]:5432/flight', env: { PGPASSWORD: 'pw' } }],
  ['a bare database name', 'flight', { dbname: 'flight', env: {} }],
];
for (const [label, input, want] of cases) {
  const got = pgRestoreTarget(input, {});
  check(`${label}: the password leaves the --dbname argument for PGPASSWORD`, same(got, want), JSON.stringify(got));
}
// Refusals: nothing that may hold the password is ever passed on as it was. The message never repeats the secret.
const refusals = [
  ['a malformed URI escape', 'postgresql://flight:Hidden-1%zz@db/flight', {}, /malformed percent-encoded/],
  ['keyword text libpq cannot read', "host=db password='Hidden-1", {}, /keyword=value settings/],
  // Codex 4160965107: a service file's password overrides PGPASSWORD, so a password beside a service is refused.
  ['a password beside service=', 'host=db service=prod password=Hidden-1', {}, /connection service/],
  ['a URI password beside ?service=', 'postgresql://flight:Hidden-1@db/flight?service=prod', {}, /connection service/],
  ['a password with PGSERVICE set', 'postgresql://flight:Hidden-1@db/flight', { PGSERVICE: 'prod' }, /connection service/],
  // Cursor 4162958234: a secret-bearing setting name in another case is not one libpq reads, so it would reach --dbname
  // as it was; it is refused instead.
  ['a mixed-case URI password parameter', 'postgresql://flight@db/flight?Password=Hidden-1', {}, /in lowercase with no spaces around it/],
  ['an upper-case keyword password', 'host=db PASSWORD=Hidden-1 dbname=flight', {}, /in lowercase with no spaces around it/],
  ['an upper-case URI client key passphrase', 'postgresql://flight@db/flight?SSLPASSWORD=Hidden-1', {}, /in lowercase with no spaces around it/],
  ['a mixed-case keyword service beside a password', 'host=db Service=prod password=Hidden-1', {}, /in lowercase with no spaces around it/],
  // Cursor 4163152933: newer libpq trims ASCII spaces around a URI parameter name, so a spaced name is a real setting.
  ['a URI password name with a leading space', 'postgresql://flight@db/flight?%20password=Hidden-1', {}, /in lowercase with no spaces around it/],
  ['a URI password name with a trailing space', 'postgresql://flight@db/flight?password%20=Hidden-1', {}, /in lowercase with no spaces around it/],
  // Cursor 4163494602: a URI with leading white space has no = and would otherwise pass as a bare database name.
  ['a URI with a leading space', ' postgresql://flight:Hidden-1@db/flight', {}, /something before postgresql/],
  ['a quoted URI', '"postgresql://flight:Hidden-1@db/flight"', {}, /something before postgresql/],
  ['a URI with a leading tab', '\tpostgres://flight:Hidden-1@db/flight', {}, /something before postgresql/],
  ['a URI client key passphrase name with a literal space', 'postgresql://flight@db/flight?sslmode=require& sslpassword=Hidden-1', {}, /in lowercase with no spaces around it/],
  // Codex 4161235803: libpq has no environment variable for sslpassword, so it is refused, with or without a password.
  ['a URI client key passphrase', 'postgresql://flight:pw@db/flight?sslkey=client.key&sslpassword=Hidden-1', {}, /client key passphrase/],
  ['a URI client key passphrase with no password', 'postgresql://flight@db/flight?sslpassword=Hidden-1', {}, /client key passphrase/],
  ['a keyword client key passphrase', 'host=db sslkey=client.key sslpassword=Hidden-1', {}, /client key passphrase/],
  // Codex 4161235818: an unencoded / cuts the user info short (libpq looks for the @ only before the first /), so the
  // password would land in the host or database name; that is refused, not passed on.
  ['user info cut short by an unencoded /', 'postgresql://flight:Hidden-1/Tail@db/flight', {}, /cut-off password/],
  // Codex 4161235811: a NUL cannot go into an environment variable; spawn would quote it, so it is refused first.
  ['a URI password with a NUL', 'postgresql://flight:Hidden-1%00tail@db/flight', {}, /NUL character/],
];
for (const [label, input, env, pattern] of refusals) {
  let error = null;
  try { pgRestoreTarget(input, env); } catch (e) { error = e; }
  check(`${label} is refused with a plain reason that does not repeat the password`, !!error && pattern.test(error.message) && !error.message.includes('Hidden-1'), error?.message);
}
check('a service with no password in the string is passed unchanged', same(pgRestoreTarget('service=prod', { PGSERVICE: 'prod' }), { dbname: 'service=prod', env: {} }));

// ---- restorePostgres passes no password in pg_restore's arguments ---------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-pgpass-'));
const log = path.join(dir, 'calls.jsonl');
const fake = path.join(dir, 'pg_restore');
fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), password: process.env.PGPASSWORD ?? null }) + '\\n');\nif (process.argv.includes('--list')) process.stdout.write('1; 2 3 TABLE DATA public workspace flight\\n');\n`, { mode: 0o755 });
const archive = path.join(dir, 'backup.dump');
fs.writeFileSync(archive, 'stand-in archive');
const savedPath = process.env.PATH, savedPassword = process.env.PGPASSWORD, savedService = process.env.PGSERVICE;
process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
delete process.env.PGPASSWORD;
delete process.env.PGSERVICE;
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
  if (savedService !== undefined) process.env.PGSERVICE = savedService;
  fs.rmSync(dir, { recursive: true, force: true });
}

check('spawn errors (which quote the bad value) are replaced with a fixed message in both tools', (fs.readFileSync(new URL('../server/db-postgres.mjs', import.meta.url), 'utf8').match(/catch \{ reject\(new Error\('pg_(dump|restore) could not be started\. Check FLIGHT_DATABASE_URL and the PostgreSQL client tools\.'\)\); return; \}/g) || []).length === 2);

// ---- pg_dump (store.backup) takes the same path ----------------------------------------------------------------
const source = fs.readFileSync(new URL('../server/db-postgres.mjs', import.meta.url), 'utf8');
check('pg_dump is given the --dbname without the password and PGPASSWORD in its environment', /spawn\('pg_dump', \['--format=custom', '--file', destination, '--dbname', target\.dbname\], \{[^}]*env: \{ \.\.\.process\.env, \.\.\.target\.env \}/.test(source));
check('no spawn passes the raw connection string as an argument', !/'--dbname', connectionString/.test(source));

console.log(`FAILS []\n${checks} checks passed`);
