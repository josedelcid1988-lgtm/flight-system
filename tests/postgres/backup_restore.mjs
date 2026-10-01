// PostgreSQL backup/restore round-trip: back up a live database with pg_dump,
// wipe it, restore with restorePostgres(), then verify data and audit-chain
// integrity on the restored copy. Skips with a reason when there is no
// PostgreSQL to talk to instead of faking a pass.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPostgres, restorePostgres, restoreListWithoutSessions } from '../../server/db-postgres.mjs';

const skipReasons = [];
const connectionString = process.env.FLIGHT_DATABASE_URL;
if (!connectionString) skipReasons.push('FLIGHT_DATABASE_URL is not set');
const toolAvailable = tool => new Promise(resolve => {
  const child = spawn(tool, ['--version'], { stdio: 'ignore' });
  child.once('error', () => resolve(false));
  child.once('exit', code => resolve(code === 0));
});
if (!await toolAvailable('pg_dump')) skipReasons.push('pg_dump is not installed');
if (!await toolAvailable('pg_restore')) skipReasons.push('pg_restore is not installed');
if (skipReasons.length) {
  console.log(`SKIP PostgreSQL backup/restore round-trip: ${skipReasons.join('; ')}.`);
  process.exit(0);
}

const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const tag = randomUUID().replaceAll('-', '');
const scratchDatabase = `flight_backup_${tag}`;
const adminUrl = new URL(connectionString);
adminUrl.pathname = '/postgres';
const scratchUrl = new URL(connectionString);
scratchUrl.pathname = `/${scratchDatabase}`;
const { Pool } = await import('pg');
const adminPool = new Pool({ connectionString: adminUrl.href });
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-pg-backup-'));
let sourceStore = null, restoredStore = null;
try {
  await adminPool.query(`CREATE DATABASE "${scratchDatabase}"`);
  sourceStore = await openPostgres(scratchUrl.href);

  // Seed: account authority, a workspace document, an audit entry, an archive row.
  await sourceStore.upsertAccount({ username: 'br-admin', displayName: 'Backup Admin', salt: 'br-salt', hash: sha('br-salt', 'br-password-123'), role: 'admin' });
  const docValue = JSON.stringify({ orders: [{ id: 'WO-BR-1', status: 'Building' }] });
  const etag = await sourceStore.putDoc('default', docValue, null, 'br-admin');
  assert.ok(etag, 'seed document stored');
  await sourceStore.audit('br-admin', 'backup-test-seed', { note: 'seeded for round-trip' });
  const archiveJson = JSON.stringify({ id: 'WO-BR-1', status: 'Closed' });
  await sourceStore.putArchived({
    id: 'WO-BR-1', json: archiveJson, sha256: createHash('sha256').update(archiveJson).digest('hex'), schema: 82,
    keys: { partNumber: 'PN-BR', serials: ['SN-1'], lots: ['LOT-1'], parts: ['PN-BR'], title: 'Backup widget', closedAt: '2026-09-28T00:00:00.000Z' },
    by: 'br-admin'
  });
  const expectedAccount = await sourceStore.account('br-admin');
  const expectedDoc = await sourceStore.getDoc('default');
  const expectedAudit = await sourceStore.verifyAudit();
  const expectedArchive = await sourceStore.archived('WO-BR-1');
  assert.ok(expectedAudit.ok, 'source audit chain verifies before backup');

  // A session open when the backup is taken: a restore must not bring it back (Codex #16 r4127638817).
  const backedUpSession = await sourceStore.openSession('br-admin');
  assert.ok(await sourceStore.session(backedUpSession.token), 'the session is live before the backup');

  // Back up, then wipe the database completely.
  const archivePath = path.join(workdir, 'flight.dump');
  assert.equal(await sourceStore.backup(archivePath), 0);
  assert.ok(fs.statSync(archivePath).size > 0, 'pg_dump produced a non-empty custom-format archive');
  await sourceStore.close(); sourceStore = null;
  await adminPool.query(`DROP DATABASE "${scratchDatabase}"`);
  await adminPool.query(`CREATE DATABASE "${scratchDatabase}"`);

  // The session rows never enter the restore: the restore list leaves out the sessions table's data and keeps
  // everything else, so the one-transaction restore creates the table empty (Codex review of #228, r4151311015).
  const fullList = await new Promise((resolve, reject) => { let out = ''; const c = spawn('pg_restore', ['-l', archivePath]); c.stdout.on('data', d => { out += d; }); c.once('error', reject); c.once('exit', code => code === 0 ? resolve(out) : reject(new Error(`pg_restore -l exited ${code}`))); });
  const filtered = await restoreListWithoutSessions(archivePath);
  const dataLine = /^\d+;.*\bTABLE DATA \S+ sessions\b/m;
  assert.match(fullList, dataLine, 'the archive holds the sessions table data');
  assert.doesNotMatch(filtered, dataLine, 'the restore list leaves out the sessions table data');
  assert.match(filtered, /\bTABLE \S+ sessions\b/, 'the restore list still creates the sessions table');
  assert.equal(filtered.split('\n').filter(line => /^\d+;/.test(line)).length, fullList.split('\n').filter(line => /^\d+;/.test(line)).length - 1, 'only the sessions data entry is left out');
  console.log('ok the restore list leaves out session rows and keeps everything else');

  // Restore into the empty database with the new restorePostgres() flow, then
  // open it: openPostgres() verifies the audit chain on startup.
  assert.equal(await restorePostgres(scratchUrl.href, archivePath), 0);
  restoredStore = await openPostgres(scratchUrl.href);
  const gotAccount = await restoredStore.account('br-admin');
  assert.equal(gotAccount.displayName, expectedAccount.displayName);
  assert.equal(gotAccount.hash, expectedAccount.hash);
  assert.deepEqual(gotAccount.roles, expectedAccount.roles);
  const gotDoc = await restoredStore.getDoc('default');
  assert.equal(gotDoc.json, expectedDoc.json);
  assert.equal(gotDoc.etag, expectedDoc.etag);
  const gotArchive = await restoredStore.archived('WO-BR-1');
  assert.equal(gotArchive.sha256, expectedArchive.sha256);
  assert.equal(gotArchive.entry.status, 'Closed');
  const chain = await restoredStore.verifyAudit();
  assert.ok(chain.ok, 'restored audit chain verifies');
  assert.equal(chain.checked, expectedAudit.checked);
  assert.equal(chain.head, expectedAudit.head);
  console.log('ok PostgreSQL backup round-trips account, document, archive, and audit chain');
  assert.equal(await restoredStore.session(backedUpSession.token), null, 'a session token from before the backup does not authenticate after the restore');
  assert.equal(Number((await restoredStore._query('SELECT COUNT(*) AS n FROM sessions')).rows[0].n), 0, 'the restore leaves no session rows');
  console.log('ok a restore ends every session that was in the backup');

  // A tampered restore refuses startup, same as the SQLite target.
  await restoredStore._query('ALTER TABLE audit DISABLE TRIGGER USER');
  await restoredStore._query(`UPDATE audit SET detail='{"tampered":true}' WHERE id=(SELECT MIN(id) FROM audit)`);
  await restoredStore.close(); restoredStore = null;
  await assert.rejects(openPostgres(scratchUrl.href), /audit chain is invalid at entry/);
  console.log('ok a tampered restore refuses startup');

  // Replace-in-place restore over the tampered database recovers it.
  assert.equal(await restorePostgres(scratchUrl.href, archivePath, { clean: true }), 0);
  restoredStore = await openPostgres(scratchUrl.href);
  assert.ok((await restoredStore.verifyAudit()).ok, 'audit chain verifies after clean restore');
  assert.equal((await restoredStore.account('br-admin')).displayName, 'Backup Admin');
  console.log('ok restore with { clean: true } replaces the database in place');

  // A clean restore that fails partway leaves the database as it was (Codex #16 r4127638807). An object
  // outside the archive that depends on the documents table makes pg_restore --clean fail on DROP TABLE
  // documents. pg_restore drops tables in reverse name order, so by then it has already dropped later
  // tables such as lockouts; outside one transaction those drops stay committed and the lockout is lost.
  await restoredStore.upsertAccount({ username: 'after-backup', displayName: 'After Backup', salt: 'ab-salt', hash: sha('ab-salt', 'ab-password-123'), role: 'admin' });
  await restoredStore.noteFailedSignin('locked-user', 1, Date.now() + 60 * 60 * 1000);
  assert.ok((await restoredStore.lockout('locked-user')).until > Date.now(), 'a lockout is recorded before the failing restore');
  const auditBefore = await restoredStore.verifyAudit();
  await restoredStore._query('CREATE VIEW restore_blocker AS SELECT tenant FROM documents');
  await restoredStore.close(); restoredStore = null;
  await assert.rejects(restorePostgres(scratchUrl.href, archivePath, { clean: true }), /pg_restore failed/);
  restoredStore = await openPostgres(scratchUrl.href);
  assert.ok((await restoredStore.lockout('locked-user')).until > Date.now(), 'a failed clean restore keeps tables it had already dropped, such as the lockouts');
  assert.equal((await restoredStore.account('after-backup'))?.displayName, 'After Backup', 'a failed clean restore keeps the accounts table and its rows');
  assert.equal((await restoredStore.getDoc('default'))?.etag, expectedDoc.etag, 'a failed clean restore keeps the workspace');
  assert.ok((await restoredStore.archived('WO-BR-1'))?.sha256, 'a failed clean restore keeps the archive');
  const auditAfter = await restoredStore.verifyAudit();
  assert.ok(auditAfter.ok && auditAfter.checked >= auditBefore.checked && auditAfter.head, 'a failed clean restore keeps the audit chain');
  console.log('ok a clean restore that fails partway changes nothing');
} finally {
  await restoredStore?.close().catch(() => {});
  await sourceStore?.close().catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDatabase}"`).catch(() => {});
  await adminPool.end().catch(() => {});
  fs.rmSync(workdir, { recursive: true, force: true });
}
