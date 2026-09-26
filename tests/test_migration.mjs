import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectMigration } from '../tools/migrate-browser.mjs';
import { createHost } from '../server/mes-host.mjs';

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
assert.deepEqual(migration.users.find(user => user.username === 'combined-user').roles, ['technician', 'operator']);
assert.match(migration.report.warnings.join(' '), /server preserves each assigned role/);
assert.equal(host.MES.validate(migration.state), true);
assert.equal(host.MES.verifyManifests(migration.state).ok, true);
assert.throws(() => inspectMigration({ workspace: '{broken' }, host), /not valid JSON/);
assert.throws(() => inspectMigration({ workspace: { version: -4 } }, host), /failed Flight System validation/);
console.log('migration: 12 checks, all passed');
