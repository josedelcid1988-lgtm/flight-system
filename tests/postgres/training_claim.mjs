// Training mode on PostgreSQL. A training server claims only a new, empty database, by writing the training
// designation as audit row 1 in one transaction that holds the workspace lock and the audit lock. Every audit writer
// takes the audit lock before it reads the chain head, so an audit row that is being written while the claim checks
// the database (a failed sign-in on a production server, say) either lands first, and the training server refuses
// to start, or waits until the designation is row 1. The designation is never row 2. A training server never opens
// or changes a database that already holds production records, and a production server refuses a training database.
// Runs in scratch databases it creates and drops, as backup_restore.mjs does. Skips with a reason when there is no
// PostgreSQL to talk to.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from '../../server/server.mjs';
import { openPostgres } from '../../server/db-postgres.mjs';

const connectionString = process.env.FLIGHT_DATABASE_URL;
if (!connectionString) {
  console.log('SKIP PostgreSQL training claim: FLIGHT_DATABASE_URL is not set.');
  process.exit(0);
}

const tag = randomUUID().replaceAll('-', '');
const urlFor = name => { const url = new URL(connectionString); url.pathname = `/${name}`; return url.href; };
const names = { race: `flight_train_race_${tag}`, fresh: `flight_train_fresh_${tag}`, production: `flight_train_prod_${tag}` };
const { Pool } = await import('pg');
const adminPool = new Pool({ connectionString: urlFor('postgres') });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
const auditActions = async url => {
  const pool = new Pool({ connectionString: url });
  try { return (await pool.query('SELECT id, action FROM audit ORDER BY id')).rows.map(r => `${r.id}:${r.action}`); } finally { await pool.end(); }
};
// Starts a server and returns no refusal when it is ready, or the reason it refused to start. A refused server's
// store is closed; a started one is returned for the caller to close.
const start = async (url, training) => {
  const server = createServer({ databaseUrl: url, training, quiet: true, setupCode: `claim-${tag}` });
  try { await server.ready; return { server, refusal: null }; }
  catch (error) { await sleep(300); await server.store?.close().catch(() => {}); return { server: null, refusal: error.message }; }
};

let store = null;
try {
  for (const name of Object.values(names)) await adminPool.query(`CREATE DATABASE "${name}"`);

  // 1. An audit row is being written (its transaction holds the audit lock and has inserted row 1, not yet committed)
  // when a training server starts its claim. The claim must wait for that row and then refuse: it may not read an
  // empty chain and then append its designation as row 2.
  store = await openPostgres(urlFor(names.race));
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const writer = store.transaction(async tx => { await tx.audit(null, 'sign-in-failed', { username: 'nobody' }); await gate; return true; });
  await sleep(300);
  const claim = start(urlFor(names.race), true);
  await sleep(1200);
  release();
  await writer;
  const raced = await claim;
  await raced.server?.store.close();
  const racedRows = await auditActions(urlFor(names.race));
  assert.ok(raced.refusal && /already holds records/.test(raced.refusal), `the training claim waits for the audit row being written and then refuses: ${raced.refusal}`);
  assert.deepEqual(racedRows, ['1:sign-in-failed'], `no training designation is written as a later row: ${racedRows}`);
  console.log('ok PostgreSQL: an audit row written during the training claim lands first and the training server refuses to start');

  // 2. A training server claims a new database as row 1; later audit rows follow it, and a production server refuses it.
  const claimed = await start(urlFor(names.fresh), true);
  assert.equal(claimed.refusal, null, `a training server claims a new database: ${claimed.refusal}`);
  await claimed.server.store.audit(null, 'sign-in-failed', { username: 'nobody' });
  const freshRows = await auditActions(urlFor(names.fresh));
  assert.deepEqual(freshRows, ['1:training-database', '2:sign-in-failed'], `the designation is row 1: ${freshRows}`);
  await claimed.server.store.close();
  const productionOnTraining = await start(urlFor(names.fresh), false);
  assert.ok(productionOnTraining.refusal && /created for a training server/.test(productionOnTraining.refusal), `a production server refuses a training database: ${productionOnTraining.refusal}`);
  console.log('ok PostgreSQL: a training server designates a new database as row 1, and a production server refuses it');

  // 3. A training server never opens or changes a production database: not its accounts, not its legacy password
  // hashes, not its audit chain.
  await store.close();
  store = await openPostgres(urlFor(names.production));
  await store.upsertAccount({ username: 'legacy', displayName: 'Legacy Account', salt: 'legacy-salt', hash: createHash('sha256').update('legacy-salt:legacy-password-1').digest('hex'), role: 'tech' });
  await store.close(); store = null;
  const before = await fingerprint(urlFor(names.production));
  const trainingOnProduction = await start(urlFor(names.production), true);
  await sleep(1500);
  assert.ok(trainingOnProduction.refusal && /already holds records/.test(trainingOnProduction.refusal), `a training server refuses a production database: ${trainingOnProduction.refusal}`);
  assert.equal(await fingerprint(urlFor(names.production)), before, 'the refused production database is unchanged: no designation, no password-wrap, no account change');
  console.log('ok PostgreSQL: a training server refuses a production database and leaves it unchanged');
} finally {
  await store?.close().catch(() => {});
  for (const name of Object.values(names)) await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  await adminPool.end().catch(() => {});
}
