// #584: a PostgreSQL password never goes on the server's command line, where anyone who can list processes reads it
// for the life of the process. FLIGHT_DATABASE_URL is the way to give one; --database-url is accepted only without a
// password, and one that carries a password (in the user info, a ?password= parameter or a keyword setting, or another
// secret libpq reads only from the string) is refused before anything connects, with a message that names the
// environment variable and never repeats the string. The operator docs give no command that repeats the URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATABASE_URL_PASSWORD_REFUSAL, connectionStringHasPassword, storeSettings } from '../server/server.mjs';

const fails = [];
let checks = 0;
const ok = (name, pass, detail = '') => { checks += 1; if (pass) console.log(`ok ${name}`); else { fails.push(name); console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); } };
const argsOf = values => (name, fallback) => Object.hasOwn(values, name) ? values[name] : fallback;
const SECRET = 'Not-A-Real-Secret-7';

// ---- what counts as a password ------------------------------------------------------------------------------------
const withPassword = [
  `postgres://flight:${SECRET}@db/flight`,
  `postgresql://flight:${SECRET}@db:5432/flight?sslmode=require`,
  `postgresql://flight:${SECRET}@[::1]:5432/flight`,
  // An unescaped @ in the user name: the Node client takes the user info to the last @, so the password is after it.
  `postgresql://flight@example.com:${SECRET}@db/flight`,
  `postgresql://flight:${SECRET}@h1:5432,h2/flight`,
  `postgresql://flight@db/flight?password=${SECRET}`,
  `postgresql://flight@db/flight?sslmode=require&Password=${SECRET}`,
  `postgresql://flight@db/flight?sslpassword=${SECRET}`,
  `postgresql://flight@db/flight?oauth_client_secret=${SECRET}`,
  // An unencoded / cuts the user info short; libpq would read the rest of the password as a port.
  `postgresql://flight:${SECRET.slice(0, 4)}/${SECRET.slice(4)}@db/flight`,
  // The same with a numeric first part, which would otherwise read as a host and port (Codex review).
  'postgresql://flight:123/456@db/flight',
  `host=db user=flight password=${SECRET} dbname=flight`,
  `host=db password='${SECRET} with spaces'`,
  `host=db sslpassword=${SECRET}`,
  `host=db scram_client_key=${SECRET}`,
  `host=db user=flight password = ${SECRET} dbname=flight`,
  `host=db password =${SECRET}`,
  `host=db password= '${SECRET}'`,
  // Not a postgresql:// URI to libpq, but the Node client reads any such string as a URL relative to postgres://base,
  // so a percent-encoded password key in its query still sets the password (Codex review).
  `postgresql:/flight?%70assword=${SECRET}`,
  `postgresql:/flight?password=${SECRET}`,
  `postgresql:flight?sslpassword=${SECRET}`
];
const withoutPassword = [
  'postgresql://flight@db/flight',
  'postgresql://flight@db:5432/flight?sslmode=require',
  'postgresql://db/flight',
  'postgresql://[::1]:5432/flight',
  'postgresql://flight:@db/flight',
  'postgresql://db/my@db',
  'postgresql:///flight?host=%2Frun%2Fpostgresql',
  'host=db user=flight dbname=flight',
  "host=db password=''",
  'flight',
  'postgresql:/flight',
  'postgresql:/flight?sslmode=require',
  'postgresql:/flight?%70assword='
];
for (const url of withPassword) ok(`a password is found in ${url.replace(SECRET, '<secret>').replace(SECRET.slice(4), '<secret>')}`, connectionStringHasPassword(url) === true);
for (const url of withoutPassword) ok(`no password is found in ${url}`, connectionStringHasPassword(url) === false);

// ---- storeSettings: the refusal and the accepted forms ----------------------------------------------------------
for (const url of withPassword) {
  let error = null;
  try { storeSettings(argsOf({ 'database-url': url }), {}); } catch (e) { error = e; }
  ok(`--database-url carrying a password is refused (${withPassword.indexOf(url) + 1})`, !!error && error.code === 'DATABASE_URL_PASSWORD' && error.message === DATABASE_URL_PASSWORD_REFUSAL);
  ok(`the refusal never repeats the connection string (${withPassword.indexOf(url) + 1})`, !!error && !error.message.includes(SECRET) && !error.message.includes(SECRET.slice(4)) && !error.message.includes('flight@'));
}
ok('the refusal names FLIGHT_DATABASE_URL and says nothing was started', /FLIGHT_DATABASE_URL/.test(DATABASE_URL_PASSWORD_REFUSAL) && /did not start/.test(DATABASE_URL_PASSWORD_REFUSAL));
ok('--database-url without a password is accepted', storeSettings(argsOf({ 'database-url': 'postgresql://flight@db/flight' }), { FLIGHT_DATABASE_URL: 'postgresql://other@db/other' }).databaseUrl === 'postgresql://flight@db/flight');
{
  let error = null;
  try { storeSettings(argsOf({}), {}, ['node', 'server.mjs', `--database-url=postgresql://flight:${SECRET}@db/flight`]); } catch (e) { error = e; }
  ok('--database-url=<url> carrying a password is refused too', !!error && error.code === 'DATABASE_URL_PASSWORD' && !error.message.includes(SECRET));
  for (const [label, argv] of [
    ['a passwordless --database-url first and a second one with a password', ['--database-url', 'postgresql://flight@db/flight', `--database-url=postgresql://flight:${SECRET}@db/flight`]],
    ['two --database-url= forms, the second with a password', ['--database-url=postgresql://flight@db/flight', `--database-url=postgresql://flight:${SECRET}@db/flight`]],
    ['two --database-url <url> forms, the second with a password', ['--database-url', 'postgresql://flight@db/flight', '--database-url', `postgresql://flight:${SECRET}@db/flight`]]
  ]) {
    let refused = null;
    try { storeSettings(name => name === 'database-url' ? 'postgresql://flight@db/flight' : null, {}, ['node', 'server.mjs', ...argv]); } catch (e) { refused = e; }
    ok(`every --database-url is checked: ${label} is refused`, !!refused && refused.code === 'DATABASE_URL_PASSWORD' && !refused.message.includes(SECRET));
  }
  ok('--database-url=<url> without a password is read', storeSettings(argsOf({}), {}, ['node', 'server.mjs', '--database-url=postgresql://flight@db/flight']).databaseUrl === 'postgresql://flight@db/flight');
}
ok('FLIGHT_DATABASE_URL with a password is accepted (the environment is not the process list)', storeSettings(argsOf({}), { FLIGHT_DATABASE_URL: `postgresql://flight:${SECRET}@db/flight` }).databaseUrl === `postgresql://flight:${SECRET}@db/flight`);
ok('--db still picks SQLite over FLIGHT_DATABASE_URL', (s => s.databaseUrl === null && s.dbPath === 'x.sqlite')(storeSettings(argsOf({ db: 'x.sqlite' }), { FLIGHT_DATABASE_URL: 'postgresql://flight@db/flight' })));
ok('with nothing named, FLIGHT_DB or the default SQLite file', storeSettings(argsOf({}), { FLIGHT_DB: 'y.sqlite' }).dbPath === 'y.sqlite' && storeSettings(argsOf({}), {}).databaseUrl === null);

// ---- the server command line: refused before anything runs -----------------------------------------------------
const SERVER = new URL('../server/server.mjs', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-dburl-'));
try {
  const env = { ...process.env, FLIGHT_DATABASE_URL: '', FLIGHT_DB: path.join(tmp, 'unused.sqlite') };
  for (const [label, extra] of [['--backup', ['--backup', path.join(tmp, 'out.dump')]], ['--restore', ['--restore', path.join(tmp, 'in.dump')]], ['--unlock', ['--unlock', 'someone', '--by', 'tester', '--reason', 'test']], ['the server itself', ['--port', '0']]]) {
    const run = spawnSync(process.execPath, ['--no-warnings', SERVER, '--database-url', `postgresql://flight:${SECRET}@127.0.0.1:1/flight`, ...extra], { encoding: 'utf8', env, timeout: 60000 });
    const out = `${run.stdout}${run.stderr}`;
    ok(`${label} with a password in --database-url exits 1 with the refusal`, run.status === 1 && out.includes(DATABASE_URL_PASSWORD_REFUSAL), `status ${run.status} ${out}`);
    ok(`${label}: the password is never printed`, !out.includes(SECRET), out);
    ok(`${label}: nothing was written`, fs.readdirSync(tmp).length === 0, JSON.stringify(fs.readdirSync(tmp)));
  }
  const restore = spawnSync(process.execPath, ['--no-warnings', SERVER, '--restore', path.join(tmp, 'in.dump')], { encoding: 'utf8', env, timeout: 60000 });
  ok('a restore with no PostgreSQL named says to set FLIGHT_DATABASE_URL', restore.status === 1 && /set FLIGHT_DATABASE_URL/.test(restore.stderr), restore.stderr);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// ---- the operator docs never repeat the URL on the command line --------------------------------------------------
const ROOT = new URL('..', import.meta.url).pathname;
const docs = ['README.md', 'server/README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];
const repeating = docs.filter(f => /--database-url\s+["']?\$\{?FLIGHT_DATABASE_URL/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
ok('no operator doc passes "$FLIGHT_DATABASE_URL" to --database-url', repeating.length === 0, JSON.stringify(repeating));
const backupDoc = fs.readFileSync(path.join(ROOT, 'docs/POSTGRES-BACKUP-RESTORE.md'), 'utf8'), serverReadme = fs.readFileSync(path.join(ROOT, 'server/README.md'), 'utf8');
ok('the backup and restore commands rely on FLIGHT_DATABASE_URL', /node server\/server\.mjs --backup /.test(backupDoc) && /node server\/server\.mjs --restore /.test(backupDoc) && /node server\/server\.mjs --backup /.test(serverReadme) && /node server\/server\.mjs --restore /.test(serverReadme));

console.log(`FAILS ${JSON.stringify(fails)}`);
console.log(`database url: checks ${checks} pass ${checks - fails.length} fail ${fails.length}`);
process.exit(fails.length ? 1 : 0);
