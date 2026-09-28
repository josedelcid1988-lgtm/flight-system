import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyMigration, inspectMigration } from '../tools/migrate-browser.mjs';
import { createHost } from '../server/mes-host.mjs';
import { createServer } from '../server/server.mjs';
import { createHash, randomUUID } from 'node:crypto';

const host = createHost(new URL('../index.html', import.meta.url).pathname);
const html = fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
const match = html.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/);
assert.ok(match, 'curated Flight fixture includes a workspace');
const fixture = JSON.parse(match[1]);
const signedCount = host.MES.verifyManifests(fixture).legacy;
const payload = {
  storage: {
    'skyryse-mes-work-order-v1': JSON.stringify(fixture),
    'skyryse-mes-auth-v1': JSON.stringify({ users: [
      { username: 'flight-admin', displayName: 'Flight Admin', role: 'admin', salt: 'legacy-salt', hash: 'a'.repeat(64) },
      { username: 'combined-user', displayName: 'Combined user', roles: ['technician', 'operator'], salt: 'legacy-salt', hash: 'b'.repeat(64) }
    ] })
  }
};
const migration = inspectMigration(payload, host);
assert.equal(migration.report.valid, true);
assert.equal(migration.report.records.workOrders, fixture.orders.length);
assert.equal(migration.report.records.masterWorkInstructions, fixture.masterWIs.length);
assert.equal(migration.report.manifests.legacyUnverifiable, signedCount);
assert.equal(migration.report.accounts.multipleRoles[0], 'combined-user');
assert.equal(JSON.stringify(migration.users.find(user => user.username === 'combined-user').roles), JSON.stringify(['technician']), 'a new account is created with its first role only');
assert.equal(JSON.stringify(migration.roleFollowUps.map(item => item.roles)), JSON.stringify([['technician', 'operator']]), 'its other roles are added afterwards through the role-change route');
assert.ok(migration.report.accounts.needsTraining.includes('combined-user'), 'an added role needs a current training record');
assert.match(migration.report.warnings.join(' '), /server preserves each assigned role/);
assert.equal(host.MES.validate(migration.state), true);
assert.equal(host.MES.verifyManifests(migration.state).ok, true);
assert.throws(() => inspectMigration({ workspace: '{broken' }, host), /not valid JSON/);
assert.throws(() => inspectMigration({ workspace: { version: -4 } }, host), /failed Flight System validation/);
const incomplete = structuredClone(migration);
incomplete.report.evidence.missingMedia = [{ id: 'EV-missing-recording', size: 42 }];
await assert.rejects(() => applyMigration(incomplete, {}), /42|linked recording/);
assert.equal(incomplete.users.length, migration.users.length, 'media preflight refuses before account import');

// End to end against a real server: a removed (quarantined) recording and an account whose role carries inspection
// authority, backed only by a training record in the migrated workspace.
{
  const state = host.MES.upgrade(structuredClone(fixture));
  const order = state.orders.find(item => item.status === 'Building' && item.operations.some(op => !op.done));
  const op = order.operations.find(item => !item.done);
  const bytes = Buffer.from('quarantined recording bytes for the migration test');
  const evidenceId = `EV-${randomUUID()}`;
  assert.equal(host.MES.attachEvidence(state, order.id, op.id, { id: evidenceId, fileName: 'removed-take.webm', mimeType: 'video/webm', size: bytes.length, source: 'upload', description: 'A take that was removed from the operation.' }).ok, true);
  assert.equal(host.MES.removeEvidence(state, order.id, op.id, evidenceId, 'Wrong operation recorded.').ok, true);
  assert.ok(op.quarantinedEvidence.some(item => item.id === evidenceId), 'the recording is quarantined, not deleted');
  const code = host.MES.trainingCatalog(state).find(item => item.status === 'Active').code;
  state.trainingRecords = [...(state.trainingRecords || []), { id: 'TRN-90002', account: 'migrated-combined', code, expires: '2099-12-31', recordedAt: new Date().toISOString(), recordedBy: 'Browser QA · ACCT-browser-qa', note: 'Migrated qualification.', qmsRev: '' }, { id: 'TRN-90001', account: 'migrated-inspector', code, expires: '2099-12-31', recordedAt: new Date().toISOString(), recordedBy: 'Browser QA · ACCT-browser-qa', note: 'Migrated qualification.', qmsRev: '' }];
  assert.equal(host.MES.validate(state), true, host.MES.diagnose(state)?.detail);
  const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
  const source = { storage: { 'skyryse-mes-work-order-v1': JSON.stringify(state), 'skyryse-mes-auth-v1': JSON.stringify({ users: [
    { username: 'migrated-inspector', displayName: 'Migrated Inspector', role: 'qe', salt: 'mi-salt', hash: sha('mi-salt', 'inspector-pass-123') },
    { username: 'migrated-combined', displayName: 'Migrated Combined', roles: ['technician', 'qe'], extraRoles: ['qe'], roleTraining: { qe: { code } }, grants: { conformity: { at: '2026-01-01T00:00:00Z', by: 'someone' } }, supportAccess: true, salt: 'mc-salt', hash: sha('mc-salt', 'combined-pass-123') }
  ] }) }, media: { [evidenceId]: { base64: bytes.toString('base64'), mimeType: 'video/webm', fileName: 'removed-take.webm' } } };
  const planned = inspectMigration(source, host);
  assert.equal(planned.report.records.evidenceRecords >= 1, true);
  assert.equal(planned.report.evidence.missingMedia.length, 0, 'the dry run counts the quarantined recording and finds its bytes');
  assert.equal(planned.report.accounts.needsTraining.length, 0, 'the inspector cites a current training record');
  const combinedImport = planned.users.find(user => user.username === 'migrated-combined');
  assert.equal(JSON.stringify([combinedImport.roles, combinedImport.extraRoles, combinedImport.grants, combinedImport.supportAccess]), JSON.stringify([['technician'], undefined, undefined, undefined]), 'no authority arrives with the new account');
  assert.equal(JSON.stringify(planned.report.accounts.manualAfterMigration), JSON.stringify(['migrated-combined: grant conformity again', 'migrated-combined: grant Support Access again']), 'grants and Support Access are listed for a manager to grant again');
  const withoutBytes = inspectMigration({ ...source, media: {} }, host);
  assert.ok(withoutBytes.report.evidence.missingMedia.some(item => item.id === evidenceId), 'a quarantined recording without bytes is reported missing');
  const untrained = inspectMigration({ storage: { ...source.storage, 'skyryse-mes-auth-v1': JSON.stringify({ users: [{ username: 'untrained-qe', displayName: 'Untrained', role: 'qe', salt: 's', hash: sha('s', 'untrained-pass-1') }] }) }, media: source.media }, host);
  assert.equal(JSON.stringify(untrained.report.accounts.needsTraining), JSON.stringify(['untrained-qe']), 'the dry run names accounts the server would refuse');
  await assert.rejects(() => applyMigration(untrained, {}), /untrained-qe/);

  const server = createServer({ dbPath: ':memory:', host: '127.0.0.1', quiet: true, setupCode: 'migration-setup-code' });
  try {
    const port = await server.listenAsync(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}/api`;
    const bootstrap = await fetch(`${base}/auth/accounts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupCode: 'migration-setup-code', users: [{ username: 'migration-admin', displayName: 'Migration Admin', role: 'admin', salt: 'ma', hash: sha('ma', 'migration-admin-1') }] }) });
    assert.equal(bootstrap.status, 200);
    const result = await applyMigration(planned, { FLIGHT_MIGRATION_URL: base, FLIGHT_MIGRATION_USERNAME: 'migration-admin', FLIGHT_MIGRATION_PASSWORD: 'migration-admin-1' });
    assert.equal(result.status, 'applied');
    assert.ok(await server.store.evidenceMeta(evidenceId), 'the quarantined recording bytes are on the server');
    assert.equal(server.host.rolesOf(await server.store.account('migrated-inspector'))[0], 'qe', 'the trained inspector account is created with its role');
    const combinedAccount = await server.store.account('migrated-combined');
    assert.equal(JSON.stringify([combinedAccount.role, combinedAccount.extraRoles, combinedAccount.roleTraining.qe.code]), JSON.stringify(['technician', ['qe'], code]), 'the multi-role account ends with all its roles, the added one citing current training');
    assert.equal(result.rolesAdded, 1);
    assert.equal(result.rolesNotApplied.length, 0);
    assert.equal(JSON.stringify([combinedAccount.grants || {}, combinedAccount.supportAccess || false]), JSON.stringify([{}, false]), 'grants and Support Access are not copied');
  } finally { await server.closeAsync(); }
}
console.log('migration: dry run, quarantined recordings, trained and multi-role account import and end-to-end apply passed');
