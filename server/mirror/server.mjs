#!/usr/bin/env node
// Flight System persistence mirror. One process, one SQLite file (WAL mode), Node built-ins only.
//
// The app keeps working from the browser's localStorage. After each committed write it posts a record
// here; this server appends it, chains it to the previous row with SHA-256, and keeps it for audit and
// retention. Nothing in the app waits on this server, and the app works with it switched off.
//
//   node server/server.mjs                     start (see README.md for every setting)
//   node server/server.mjs --backup-now        take one backup into the backup directory and exit
//
// Endpoints (JSON, versioned):
//   POST /api/v1/writes                 append a batch of records; idempotent on clientWriteId
//   GET  /api/v1/health                 liveness, row counts, last backup
//   GET  /api/v1/verify                 walk the hash chain; report the first break
//   GET  /api/v1/export?format=json|csv full retention export
//   GET  /api/v1/records?entity=&id=    every record for one entity, oldest first
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const API_VERSION = 'v1';
export const ZERO = '0'.repeat(64);
const SCHEMA = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
const HEX64 = /^[0-9a-f]{64}$/;
const OPERATIONS = ['upsert', 'delete'];
const MAX_BATCH = 500;

export const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// ---- settings: command line first, then environment, then defaults ----------------------------
export function settings(argv = process.argv.slice(2), env = process.env) {
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
  const num = (v, d) => { const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) ? d : n; };
  return {
    host: arg('host') ?? env.FS_MIRROR_HOST ?? '127.0.0.1',
    port: num(arg('port') ?? env.FS_MIRROR_PORT, 8787),
    dbPath: path.resolve(arg('db') ?? env.FS_MIRROR_DB ?? path.join(HERE, 'data', 'mirror.sqlite')),
    backupDir: path.resolve(arg('backup-dir') ?? env.FS_MIRROR_BACKUP_DIR ?? path.join(HERE, 'backups')),
    backupEveryMinutes: num(arg('backup-every-minutes') ?? env.FS_MIRROR_BACKUP_EVERY_MINUTES, 1440),
    backupKeepDays: num(arg('backup-keep-days') ?? env.FS_MIRROR_BACKUP_KEEP_DAYS, 30),
    token: arg('token') ?? env.FS_MIRROR_TOKEN ?? '',
    allowOrigin: arg('allow-origin') ?? env.FS_MIRROR_ALLOW_ORIGIN ?? '*',
    maxBodyBytes: num(arg('max-body-bytes') ?? env.FS_MIRROR_MAX_BODY_BYTES, 32 * 1024 * 1024),
    backupNow: argv.includes('--backup-now'),
  };
}

// ---- database ---------------------------------------------------------------------------------------
export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// The chain link of a row: SHA-256 over every column except payload_json itself, whose hash is in it.
// The next row stores this value as its prev_sha256.
export const linkHash = row => sha256(JSON.stringify([row.id, row.client_write_id, row.store_key, row.entity_type, row.entity_id, row.operation, row.payload_sha256, row.prev_sha256, row.actor, row.credential, row.client_ts, row.server_ts, row.build_version, row.build_sha256, row.client_id]));

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const optStr = (v, max) => v === null || v === undefined || (typeof v === 'string' && v.length <= max);

function checkRecord(r) {
  if (!r || typeof r !== 'object') return 'record is not an object';
  if (!str(r.clientWriteId, 200)) return 'clientWriteId is required';
  if (!str(r.storeKey, 100)) return 'storeKey is required';
  if (!str(r.entityType, 60) || !str(r.entityId, 200)) return 'entityType and entityId are required';
  if (!OPERATIONS.includes(r.operation)) return `operation must be ${OPERATIONS.join(' or ')}`;
  if (typeof r.payloadJson !== 'string') return 'payloadJson must be the JSON text of the entity';
  try { JSON.parse(r.payloadJson); } catch { return 'payloadJson is not valid JSON'; }
  if (!HEX64.test(r.payloadSha256 || '')) return 'payloadSha256 must be 64 hex characters';
  if (sha256(r.payloadJson) !== r.payloadSha256) return 'payloadSha256 does not match payloadJson';
  if (!optStr(r.actor, 200) || !optStr(r.credential, 100)) return 'actor or credential is malformed';
  if (!str(r.clientTs, 40) || !Number.isFinite(Date.parse(r.clientTs))) return 'clientTs must be an ISO timestamp';
  if (!str(r.buildVersion, 40) || !str(r.buildSha256, 80)) return 'buildVersion and buildSha256 are required';
  if (r.manifests !== undefined && (!Array.isArray(r.manifests) || r.manifests.length > 500)) return 'manifests must be a list';
  for (const m of r.manifests || []) {
    if (!m || !str(m.path, 400) || !str(m.meaning, 200) || !str(m.signerName, 120) || !str(m.signerCredential, 100) || !str(m.signedAt, 40) || m.algorithm !== 'SHA-256' || !HEX64.test(m.hash || '')) return 'a signature manifest is malformed';
  }
  return null;
}

// Appends a batch in one transaction. Each record is accepted, recognised as a duplicate of one
// already stored (same clientWriteId and payload: idempotent retry), or rejected with a reason.
export function appendRecords(db, clientId, records, now = () => new Date().toISOString()) {
  if (!str(clientId, 120)) return { ok: false, status: 400, error: { code: 'bad_request', message: 'clientId is required.' } };
  if (!Array.isArray(records) || !records.length) return { ok: false, status: 400, error: { code: 'bad_request', message: 'records must be a non-empty list.' } };
  if (records.length > MAX_BATCH) return { ok: false, status: 413, error: { code: 'too_large', message: `Send at most ${MAX_BATCH} records per request.` } };
  const byId = db.prepare('SELECT id, payload_sha256 FROM records WHERE client_write_id = ?');
  const last = db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO records (client_write_id, store_key, entity_type, entity_id, operation, payload_json, payload_sha256, prev_sha256, actor, credential, client_ts, server_ts, build_version, build_sha256, client_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const manifest = db.prepare('INSERT INTO signature_manifests (record_id, path, meaning, signer_name, signer_credential, signed_at, algorithm, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const results = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of records) {
      const problem = checkRecord(r);
      if (problem) { results.push({ clientWriteId: r && r.clientWriteId, status: 'rejected', reason: problem }); continue; }
      const seen = byId.get(r.clientWriteId);
      if (seen) { results.push(seen.payload_sha256 === r.payloadSha256 ? { clientWriteId: r.clientWriteId, status: 'duplicate', id: Number(seen.id) } : { clientWriteId: r.clientWriteId, status: 'rejected', reason: 'clientWriteId was already used for a different payload' }); continue; }
      const prev = last.get();
      const info = insert.run(r.clientWriteId, r.storeKey, r.entityType, r.entityId, r.operation, r.payloadJson, r.payloadSha256, prev ? linkHash(prev) : ZERO, r.actor ?? null, r.credential ?? null, r.clientTs, now(), r.buildVersion, r.buildSha256, clientId);
      const id = Number(info.lastInsertRowid);
      for (const m of r.manifests || []) manifest.run(id, m.path, m.meaning, m.signerName, m.signerCredential, m.signedAt, m.algorithm, m.hash);
      results.push({ clientWriteId: r.clientWriteId, status: 'stored', id });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ok: true, results };
}

// Walks every row in id order: the payload must still hash to payload_sha256 and prev_sha256 must be the
// link of the row before (64 zeros for the first). Reports the first row where either fails.
export function verifyChain(db) {
  let expected = ZERO, count = 0, previousId = 0, tip = ZERO;
  for (const row of db.prepare('SELECT * FROM records ORDER BY id').iterate()) {
    count += 1;
    const id = Number(row.id);
    if (sha256(row.payload_json) !== row.payload_sha256) return { ok: false, records: count, firstBreak: { id, reason: 'payload_json no longer matches payload_sha256 (the record was changed after it was written)' } };
    if (row.prev_sha256 !== expected) return { ok: false, records: count, firstBreak: { id, reason: id !== previousId + 1 ? `row ${previousId + 1} is missing or out of order` : 'prev_sha256 does not match the previous row (a row before it was changed)' } };
    expected = tip = linkHash(row);
    previousId = id;
  }
  const orphan = db.prepare('SELECT m.id FROM signature_manifests m LEFT JOIN records r ON r.id = m.record_id WHERE r.id IS NULL LIMIT 1').get();
  if (orphan) return { ok: false, records: count, firstBreak: { id: null, manifestId: Number(orphan.id), reason: 'a signature manifest points at a record that does not exist' } };
  return { ok: true, records: count, firstBreak: null, tip };
}

const withManifests = db => {
  const q = db.prepare('SELECT path, meaning, signer_name, signer_credential, signed_at, algorithm, hash FROM signature_manifests WHERE record_id = ? ORDER BY id');
  return row => ({ ...row, id: Number(row.id), manifests: q.all(row.id) });
};

export function recordsFor(db, entity, id) {
  return db.prepare('SELECT * FROM records WHERE entity_type = ? AND entity_id = ? ORDER BY id').all(entity, id).map(withManifests(db));
}

const CSV_COLUMNS = ['id', 'client_write_id', 'store_key', 'entity_type', 'entity_id', 'operation', 'payload_sha256', 'prev_sha256', 'actor', 'credential', 'client_ts', 'server_ts', 'build_version', 'build_sha256', 'client_id', 'payload_json'];
const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportAll(db, format = 'json') {
  const rows = db.prepare('SELECT * FROM records ORDER BY id').all();
  if (format === 'csv') return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
  const add = withManifests(db);
  return { exportedAt: new Date().toISOString(), api: API_VERSION, verify: verifyChain(db), records: rows.map(add) };
}

// ---- backups ---------------------------------------------------------------------------------------
const BACKUP_RE = /^flight-system-mirror-(\d{4}-\d{2}-\d{2})T(\d{6})Z\.sqlite$/;
export function backupNow(db, dir, when = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const iso = when.toISOString();
  const name = `flight-system-mirror-${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, '')}Z.sqlite`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}
// Keeps the newest copy of each day for keepDays days and removes the rest.
export function pruneBackups(dir, keepDays, now = new Date()) {
  if (!fs.existsSync(dir)) return [];
  const cutoff = new Date(now.getTime() - keepDays * 86400000).toISOString().slice(0, 10);
  const files = fs.readdirSync(dir).filter(f => BACKUP_RE.test(f)).sort().reverse();
  const keptDays = new Set(), removed = [];
  for (const f of files) {
    const day = f.match(BACKUP_RE)[1];
    if (day < cutoff || keptDays.has(day)) { fs.rmSync(path.join(dir, f)); removed.push(f); } else keptDays.add(day);
  }
  return removed;
}

// ---- HTTP ------------------------------------------------------------------------------------------
export function createMirror(options = {}) {
  const cfg = { ...settings([], {}), ...options };
  const db = openDatabase(cfg.dbPath);
  let lastBackup = null;
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type === 'application/json' ? 'application/json; charset=utf-8' : type, 'access-control-allow-origin': cfg.allowOrigin, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > cfg.maxBodyBytes) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://mirror');
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (cfg.token && url.pathname !== `/api/${API_VERSION}/health` && req.headers.authorization !== `Bearer ${cfg.token}`) return fail(res, 401, 'unauthorized', 'Send the mirror token as Authorization: Bearer <token>.');
      if (req.method === 'POST' && url.pathname === `/api/${API_VERSION}/writes`) {
        let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return e.status === 413 ? fail(res, 413, 'too_large', `Request body over ${cfg.maxBodyBytes} bytes.`) : fail(res, 400, 'bad_request', 'Body is not valid JSON.'); }
        const r = appendRecords(db, body && body.clientId, body && body.records);
        return r.ok ? send(res, 200, { ok: true, results: r.results }) : send(res, r.status, { ok: false, error: r.error });
      }
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Use GET, or POST for /api/v1/writes.');
      if (url.pathname === `/api/${API_VERSION}/health`) {
        const c = db.prepare('SELECT COUNT(*) n, MAX(server_ts) last FROM records').get();
        const m = db.prepare('SELECT COUNT(*) n FROM signature_manifests').get();
        return send(res, 200, { ok: true, api: API_VERSION, records: Number(c.n), manifests: Number(m.n), lastWriteAt: c.last || null, backup: { dir: cfg.backupDir, lastFile: lastBackup, everyMinutes: cfg.backupEveryMinutes, keepDays: cfg.backupKeepDays } });
      }
      if (url.pathname === `/api/${API_VERSION}/verify`) { const v = verifyChain(db); return send(res, 200, { ok: true, chainIntact: v.ok, records: v.records, firstBreak: v.firstBreak, tip: v.tip || null }); }
      if (url.pathname === `/api/${API_VERSION}/export`) {
        const format = url.searchParams.get('format') || 'json';
        if (!['json', 'csv'].includes(format)) return fail(res, 400, 'bad_request', 'format is json or csv.');
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader('content-disposition', `attachment; filename="flight-system-mirror-${day}.${format}"`);
        return format === 'csv' ? send(res, 200, exportAll(db, 'csv'), 'text/csv; charset=utf-8') : send(res, 200, { ok: true, ...exportAll(db, 'json') });
      }
      if (url.pathname === `/api/${API_VERSION}/records`) {
        const entity = url.searchParams.get('entity'), id = url.searchParams.get('id');
        if (!entity || !id) return fail(res, 400, 'bad_request', 'Give both entity and id, for example ?entity=order&id=WO-10001.');
        return send(res, 200, { ok: true, entity, id, records: recordsFor(db, entity, id) });
      }
      return fail(res, 404, 'not_found', `No such endpoint. The API is under /api/${API_VERSION}/.`);
    } catch (error) {
      console.error(error);
      return fail(res, 500, 'server_error', 'The mirror could not complete the request. The app keeps the record locally and retries.');
    }
  });
  let timer = null;
  const runBackup = () => { lastBackup = backupNow(db, cfg.backupDir); pruneBackups(cfg.backupDir, cfg.backupKeepDays); return lastBackup; };
  return {
    server, db, cfg,
    listen() { return new Promise(resolve => server.listen(cfg.port, cfg.host, () => { const a = server.address(); if (cfg.backupEveryMinutes > 0) timer = setInterval(() => { try { runBackup(); } catch (e) { console.error('backup failed:', e.message); } }, cfg.backupEveryMinutes * 60000); resolve(a); })); },
    backup: runBackup,
    close() { if (timer) clearInterval(timer); return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => { try { db.close(); } catch { /* already closed */ } resolve(); }); }); },
  };
}

async function main() {
  const cfg = settings();
  if (cfg.backupNow) {
    const db = openDatabase(cfg.dbPath);
    const file = backupNow(db, cfg.backupDir); const removed = pruneBackups(cfg.backupDir, cfg.backupKeepDays);
    console.log(`backup written: ${file}${removed.length ? `; removed ${removed.length} old copies` : ''}`);
    db.close(); return;
  }
  const mirror = createMirror(cfg);
  const a = await mirror.listen();
  console.log(`Flight System mirror listening on http://${a.address}:${a.port} (database ${cfg.dbPath}; backups to ${cfg.backupDir} every ${cfg.backupEveryMinutes} minutes, ${cfg.backupKeepDays} days kept${cfg.token ? '; token required' : ''})`);
  const stop = () => mirror.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
