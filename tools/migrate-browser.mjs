#!/usr/bin/env node
// Dry-run by default. The input is a browser export containing the two Flight System
// localStorage values and, optionally, video blobs from the MESMedia IndexedDB store.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createHost } from '../server/mes-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/i;
const decode = (value, label) => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { throw new Error(`${label} is not valid JSON.`); } }
  if (value && typeof value === 'object') return value;
  throw new Error(`${label} is missing from the browser export.`);
};

export function inspectMigration(input, host = createHost(path.join(ROOT, 'index.html'))) {
  const source = decode(input, 'Browser export');
  const storage = source.storage && typeof source.storage === 'object' ? source.storage : source;
  const rawWorkspace = storage['skyryse-mes-work-order-v1'] ?? source.workspace;
  const rawAuth = storage['skyryse-mes-auth-v1'] ?? source.auth;
  const workspace = decode(rawWorkspace, 'skyryse-mes-work-order-v1');
  const auth = rawAuth === undefined ? { users: [] } : decode(rawAuth, 'skyryse-mes-auth-v1');
  if (!Array.isArray(auth.users)) throw new Error('The browser account export must contain a users array.');
  const state = host.MES.upgrade(structuredClone(workspace));
  if (!state || !host.MES.validate(state)) {
    const detail = host.MES.diagnose(workspace)?.detail;
    throw new Error(`The workspace failed Flight System validation and was not changed.${detail ? ` ${detail}` : ''}`);
  }
  const manifests = host.MES.verifyManifests(state);
  if (!manifests.ok) throw new Error(`Signature manifest verification found ${manifests.failures.length} damaged manifest(s).`);
  const evidence = (state.orders || []).flatMap(order => (order.operations || []).flatMap(operation => (operation.evidence || []).map(item => ({ id: item.id, size: item.size, mimeType: item.mimeType, sha256: item.sha256 || null }))));
  const mediaSource = source.media && typeof source.media === 'object' ? source.media : {};
  const missingMedia = evidence.filter(item => !mediaSource[item.id]).map(({ id, size }) => ({ id, size }));
  const multipleRoles = auth.users.filter(user => Array.isArray(user.roles) && user.roles.length > 1).map(user => user.username);
  let planned = 0;
  try { planned = host.FlightPlan.list(state).length; } catch {}
  const maneuver = state.maneuver && typeof state.maneuver === 'object' ? state.maneuver : {};
  const report = {
    product: 'Flight System',
    valid: true,
    workspaceVersion: state.version,
    records: {
      workOrders: state.orders.length,
      openWorkOrders: state.orders.filter(order => order.status !== 'Closed').length,
      closedWorkOrders: state.orders.filter(order => order.status === 'Closed').length,
      masterWorkInstructions: (state.masterWIs || []).length,
      plannedOrders: planned,
      maneuverRecords: Object.fromEntries(['tickets', 'mrb', 'cars', 'scars', 'sprs', 'fracas', 'escapes', 'pfmea'].map(key => [key, Array.isArray(maneuver[key]) ? maneuver[key].length : 0])),
      evidenceRecords: evidence.length
    },
    accounts: { count: auth.users.length, roles: Object.fromEntries([...new Set(auth.users.flatMap(user => Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role || 'general']))].map(role => [role, auth.users.filter(user => (Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role || 'general']).includes(role)).length])), multipleRoles: multipleRoles },
    manifests: { verified: manifests.checked, legacyUnverifiable: manifests.legacy, complete: manifests.complete },
    evidence: { bytesIncluded: evidence.length - missingMedia.length, missingMedia },
    warnings: [
      ...(manifests.legacy ? [`${manifests.legacy} pre-existing signature manifest(s) have no stored subject and cannot be cryptographically recomputed.`] : []),
      ...(missingMedia.length ? [`${missingMedia.length} IndexedDB recording(s) are absent from the export. Their metadata and signatures will be preserved, but their bytes cannot be migrated.`] : []),
      ...(multipleRoles.length ? [`These accounts carry multiple roles. The server preserves each assigned role: ${multipleRoles.join(', ')}.`] : [])
    ]
  };
  return { report, state, users: auth.users, media: mediaSource };
}

const request = async (base, route, { method = 'GET', token, body, raw = false, headers = {} } = {}) => {
  const response = await fetch(base + route, { method, headers: { ...(raw ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, etag: response.headers.get('etag') };
};

async function applyMigration(migration, env = process.env) {
  const base = String(env.FLIGHT_MIGRATION_URL || '').replace(/\/$/, '');
  const username = String(env.FLIGHT_MIGRATION_USERNAME || '');
  const password = String(env.FLIGHT_MIGRATION_PASSWORD || '');
  if (!base || !username || !password) throw new Error('Set FLIGHT_MIGRATION_URL, FLIGHT_MIGRATION_USERNAME and FLIGHT_MIGRATION_PASSWORD to apply a migration.');
  const signedIn = await request(base, '/auth/session', { method: 'POST', body: { username, password } });
  if (signedIn.status !== 200 || !signedIn.json?.token) throw new Error(signedIn.json?.error || 'Could not sign in to the Flight System server.');
  const token = signedIn.json.token;
  const current = await request(base, '/workspace', { token });
  if (current.status === 200) throw new Error('The server already has a workspace. This tool will not overwrite it. Back it up and choose an approved merge path first.');
  if (current.status !== 404) throw new Error(current.json?.error || 'Could not read the target workspace.');

  const accountResult = await request(base, '/auth/accounts', { method: 'PUT', token, body: { users: migration.users } });
  if (accountResult.status !== 200) throw new Error(`Workspace is still unchanged. Account import failed: ${accountResult.json?.error || accountResult.status}`);

  for (const [id, item] of Object.entries(migration.media)) {
    const evidence = migration.state.orders.flatMap(order => (order.operations || []).flatMap(operation => operation.evidence || [])).find(entry => entry.id === id);
    if (!evidence) continue;
    const encoded = typeof item === 'string' ? item : item.base64;
    if (typeof encoded !== 'string') throw new Error(`Media ${id} must contain base64 bytes.`);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length !== evidence.size) throw new Error(`Media ${id} has ${bytes.length} bytes, expected ${evidence.size}.`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (evidence.sha256 && evidence.sha256 !== sha256) throw new Error(`Media ${id} does not match its recorded SHA-256.`);
    const mime = item.mimeType || evidence.mimeType;
    const fileName = encodeURIComponent(item.fileName || evidence.fileName || 'recording');
    const uploaded = await request(base, `/evidence/${encodeURIComponent(id)}`, { method: 'POST', token, raw: true, body: bytes, headers: { 'Content-Type': mime, 'X-Evidence-Sha256': sha256, 'X-Evidence-Name': fileName } });
    if (![200, 201].includes(uploaded.status) || uploaded.json?.sha256 !== sha256) throw new Error(`Media ${id} upload failed: ${uploaded.json?.error || uploaded.status}.`);
    evidence.sha256 = sha256;
    evidence.stored = { where: 'server', at: uploaded.json.uploadedAt, sha256 };
  }

  if (!migration.state || !migration.report.valid) throw new Error('The workspace did not pass the dry-run checks.');
  const afterManifestCheck = createHost(path.join(ROOT, 'index.html')).MES.verifyManifests(migration.state);
  if (!afterManifestCheck.ok) throw new Error(`Workspace manifest verification failed after media migration (${afterManifestCheck.failures.length} invalid manifest(s)).`);
  const saved = await request(base, '/workspace', { method: 'PUT', token, body: migration.state, headers: current.etag ? { 'If-Match': current.etag } : {} });
  if (saved.status !== 204) throw new Error(`Account import completed, but workspace migration failed: ${saved.json?.error || saved.status}.`);
  return { status: 'applied', etag: saved.etag, accountsImported: migration.users.length, evidenceUploaded: Object.keys(migration.media).length };
}

function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) {
      console.log('Usage: node tools/migrate-browser.mjs --input browser-export.json [--dry-run | --apply]');
      process.exit(0);
    }
    const inputPath = arg('--input');
    if (!inputPath) throw new Error('Provide --input with a browser storage export JSON file.');
    const migration = inspectMigration(fs.readFileSync(inputPath, 'utf8'));
    if (process.argv.includes('--apply')) console.log(JSON.stringify({ report: migration.report, result: await applyMigration(migration) }, null, 2));
    else console.log(JSON.stringify({ mode: 'dry-run', report: migration.report }, null, 2));
  } catch (error) {
    console.error(`Migration refused: ${error.message}`);
    process.exitCode = 1;
  }
}
