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
import { openPostgres, restorePostgres } from '../../server/db-postgres.mjs';

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

  // Back up, then wipe the database completely.
  const archivePath = path.join(workdir, 'flight.dump');
  assert.equal(await sourceStore.backup(archivePath), 0);
  assert.ok(fs.statSync(archivePath).size > 0, 'pg_dump produced a non-empty custom-format archive');
  await sourceStore.close(); sourceStore = null;
  await adminPool.query(`DROP DATABASE "${scratchDatabase}"`);
  await adminPool.query(`CREATE DATABASE "${scratchDatabase}"`);

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
} finally {
  await restoredStore?.close().catch(() => {});
  await sourceStore?.close().catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDatabase}"`).catch(() => {});
  await adminPool.end().catch(() => {});
  fs.rmSync(workdir, { recursive: true, force: true });
}
