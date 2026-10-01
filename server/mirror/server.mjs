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
//   GET  /api/v1/health                 liveness; with the operator token, row counts and last backup
//   GET  /api/v1/verify                 walk the hash chain against the anchored tip; report the first break
//   GET  /api/v1/export?format=json|csv full retention export
//   GET  /api/v1/records?entity=&id=    every record for one entity, oldest first
//
// Two tokens. The write token is the one the app carries (SK_MIRROR.token, readable by anyone who can open
// the page): it can only append. Reading, verifying and exporting need the operator token, which never
// goes into the page. The server listens on loopback only unless the operator states it is behind a
// TLS-terminating reverse proxy, so records and tokens never cross the network in plain HTTP.
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
    // Fail closed: with no tokens the mirror does not start, unless --insecure-no-token (FS_MIRROR_INSECURE_NO_TOKEN=1)
    // is given on loopback for a machine nobody else can reach. token is the operator token (read, verify,
    // export); writeToken is the append-only token the app carries. With no allowed origin, no CORS header is
    // sent, so no other website can call it from a browser; set it to the address the app is served from.
    token: arg('token') ?? env.FS_MIRROR_TOKEN ?? '',
    writeToken: arg('write-token') ?? env.FS_MIRROR_WRITE_TOKEN ?? '',
    allowNoToken: argv.includes('--insecure-no-token') || env.FS_MIRROR_INSECURE_NO_TOKEN === '1',
    // A host other than loopback is refused unless the operator states a TLS-terminating reverse proxy is in front.
    behindTlsProxy: argv.includes('--behind-tls-proxy') || env.FS_MIRROR_BEHIND_TLS_PROXY === '1',
    // The chain tip and row count, kept outside the database so truncation or a changed last row is found.
    anchorPath: arg('anchor') ?? env.FS_MIRROR_ANCHOR ?? '',
    allowOrigin: arg('allow-origin') ?? env.FS_MIRROR_ALLOW_ORIGIN ?? '',
    maxBodyBytes: num(arg('max-body-bytes') ?? env.FS_MIRROR_MAX_BODY_BYTES, 32 * 1024 * 1024),
    backupNow: argv.includes('--backup-now'),
    reanchor: argv.includes('--reanchor'),
  };
}

// ---- database ---------------------------------------------------------------------------------------
export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // A database written before signature manifests joined the chain gains the column; its older rows keep a
  // null value and their links are unchanged.
  const added = !db.prepare('PRAGMA table_info(records)').all().some(c => c.name === 'manifests_sha256');
  if (added) db.exec('ALTER TABLE records ADD COLUMN manifests_sha256 TEXT');
  // The rows written before that are recorded once, so verify accepts a row without manifests_sha256 only there.
  // A database that gained the column before this record existed counts its leading rows without one.
  if (!db.prepare("SELECT 1 FROM mirror_meta WHERE key = 'legacy_through'").get()) {
    const q = added ? 'SELECT COALESCE(MAX(id), 0) n FROM records' : 'SELECT COALESCE((SELECT MIN(id) - 1 FROM records WHERE manifests_sha256 IS NOT NULL), (SELECT MAX(id) FROM records), 0) n';
    db.prepare("INSERT INTO mirror_meta (key, value) VALUES ('legacy_through', ?)").run(String(Number(db.prepare(q).get().n)));
  }
  return db;
}

export const LOOPBACK = host => host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(host));
export const defaultAnchorPath = dbPath => dbPath + '.anchor.json';

// The SHA-256 of a record's signature manifests in the order they were stored. It is a column of the row,
// so it is inside the row's link: a manifest changed, added or removed breaks the chain.
export const manifestSetHash = list => sha256(JSON.stringify(list.map(m => [m.path, m.meaning, m.signer_name ?? m.signerName, m.signer_credential ?? m.signerCredential, m.signed_at ?? m.signedAt, m.algorithm, m.hash])));

// The chain link of a row: SHA-256 over every column except payload_json itself, whose hash is in it.
// The next row stores this value as its prev_sha256. Rows written before manifests joined the chain have
// manifests_sha256 null and keep their original link.
export const linkHash = row => {
  const fields = [row.id, row.client_write_id, row.store_key, row.entity_type, row.entity_id, row.operation, row.payload_sha256, row.prev_sha256, row.actor, row.credential, row.client_ts, row.server_ts, row.build_version, row.build_sha256, row.client_id];
  if (row.manifests_sha256 !== null && row.manifests_sha256 !== undefined) fields.push(row.manifests_sha256);
  return sha256(JSON.stringify(fields));
};

// ---- chain anchor ------------------------------------------------------------------------------------
// The anchor holds the row count and the chain tip after the last committed batch. Truncating rows from the
// end, or changing the last row (whose link no later row carries), leaves the chain self-consistent but no
// longer equal to the anchor. Keep the anchor on storage the database host cannot rewrite (FS_MIRROR_ANCHOR).
export function chainTip(db) {
  const last = db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 1').get();
  return { records: Number(db.prepare('SELECT COUNT(*) n FROM records').get().n), tip: last ? linkHash(last) : ZERO };
}
export function readAnchor(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return a && Number.isInteger(a.records) && HEX64.test(a.tip || '') ? a : null; } catch { return null; }
}
// Whether the database's row count and tip are still the ones the anchor recorded. Checked before every write
// and every backup, so a database changed outside the server is never re-anchored or copied as if it were good.
// An anchor may carry `pending`: the count and tip of a batch that was about to commit. It is written before
// COMMIT, so a crash between the commit and the final anchor leaves the database equal to `pending`, which is
// recognised as that interrupted, legitimate commit (settleAnchor finalises it) rather than as tampering.
const matchesPending = (now, anchor) => !!(anchor && anchor.pending && now.records === anchor.pending.records && now.tip === anchor.pending.tip);
export function anchorMismatch(db, anchor) {
  if (!anchor) return 'the chain anchor is missing or unreadable';
  const now = chainTip(db);
  if (matchesPending(now, anchor)) return null;
  if (now.records !== anchor.records) return `the database has ${now.records} rows but the anchor records ${anchor.records}`;
  if (now.tip !== anchor.tip) return 'the last row does not match the anchored chain tip';
  return null;
}

// The anchor an export carries: when a commit finished but its final anchor write did not (the anchor still
// names it as pending), the database equals the pending count and tip, which is the state the export holds.
export function exportAnchor(db, anchor) {
  if (!anchor || !anchor.pending) return anchor || null;
  return matchesPending(chainTip(db), anchor) ? { records: anchor.pending.records, tip: anchor.pending.tip, anchoredAt: anchor.anchoredAt, settledFromPending: true } : anchor;
}

// Durable before it returns: the temporary file is flushed before the rename and the directory after it, so a
// pending anchor is on disk before the database commit and a final one before the write is acknowledged.
const putAnchor = (file, a) => {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(a) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  let dfd = null;
  try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); } catch (e) { if (process.platform !== 'win32') throw e; } finally { if (dfd !== null) fs.closeSync(dfd); }
  return a;
};
export function writeAnchor(file, db, when = new Date()) {
  return putAnchor(file, { ...chainTip(db), anchoredAt: when.toISOString() });
}
// Phase one of a write: the anchor keeps the committed count and tip and names the batch about to commit.
export function writePendingAnchor(file, current, pending) {
  return putAnchor(file, { records: current.records, tip: current.tip, anchoredAt: current.anchoredAt, pending: { records: pending.records, tip: pending.tip } });
}
// Finalises an anchor left with `pending` by a crash: if the database equals the pending batch the commit
// happened; if it equals the committed state the batch rolled back. Anything else is left for verify to refuse.
export function settleAnchor(file, db) {
  const a = readAnchor(file);
  if (!a || !a.pending) return a;
  const now = chainTip(db);
  if (matchesPending(now, a)) return writeAnchor(file, db);
  if (now.records === a.records && now.tip === a.tip) return putAnchor(file, { records: a.records, tip: a.tip, anchoredAt: a.anchoredAt });
  return a;
}

// Optional text is stored as NULL when empty, so the CSV export (where both are an empty cell) still carries every
// value linkHash covers, and the chain can be recomputed from it.
const optional = v => (v === undefined || v === null || v === '' ? null : v);
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
// lastAck, when the app sends it, is the newest row it was told was stored. If that row is not there with that
// clientWriteId, the server lost confirmed rows (it was restored from a backup) and ackCheck says 'missing',
// so the app sends every entity again.
export function ackCheck(db, lastAck) {
  if (!lastAck || typeof lastAck !== 'object') return undefined;
  if (!Number.isInteger(lastAck.id) || lastAck.id < 1 || !str(lastAck.clientWriteId, 200)) return 'missing';
  const row = db.prepare('SELECT client_write_id FROM records WHERE id = ?').get(lastAck.id);
  return row && row.client_write_id === lastAck.clientWriteId ? 'ok' : 'missing';
}

export function appendRecords(db, clientId, records, now = () => new Date().toISOString(), { afterLock, beforeCommit } = {}) {
  if (!str(clientId, 120)) return { ok: false, status: 400, error: { code: 'bad_request', message: 'clientId is required.' } };
  if (!Array.isArray(records) || !records.length) return { ok: false, status: 400, error: { code: 'bad_request', message: 'records must be a non-empty list.' } };
  if (records.length > MAX_BATCH) return { ok: false, status: 413, error: { code: 'too_large', message: `Send at most ${MAX_BATCH} records per request.` } };
  const byId = db.prepare('SELECT id, payload_sha256 FROM records WHERE client_write_id = ?');
  const last = db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO records (client_write_id, store_key, entity_type, entity_id, operation, payload_json, payload_sha256, prev_sha256, actor, credential, client_ts, server_ts, build_version, build_sha256, client_id, manifests_sha256)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const manifest = db.prepare('INSERT INTO signature_manifests (record_id, path, meaning, signer_name, signer_credential, signed_at, algorithm, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const results = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Runs holding the write lock, before anything is appended: a refusal here rolls back and stores nothing.
    const refusal = afterLock ? afterLock() : null;
    if (refusal) { db.exec('ROLLBACK'); return { ok: false, status: 409, refusal, error: { code: 'anchor_mismatch', message: 'The mirror database no longer matches its chain anchor, so no record is stored until the operator investigates. The app keeps the records queued.' } }; }
    for (const r of records) {
      const problem = checkRecord(r);
      if (problem) { results.push({ clientWriteId: r && r.clientWriteId, status: 'rejected', reason: problem }); continue; }
      const seen = byId.get(r.clientWriteId);
      if (seen) { results.push(seen.payload_sha256 === r.payloadSha256 ? { clientWriteId: r.clientWriteId, status: 'duplicate', id: Number(seen.id) } : { clientWriteId: r.clientWriteId, status: 'rejected', reason: 'clientWriteId was already used for a different payload' }); continue; }
      // The manifests in exactly the shape that is stored, so the hash in the link is the hash verify recomputes;
      // any other field a client sends (another spelling of the same name included) is ignored, not hashed.
      const stored = (r.manifests || []).map(m => ({ path: m.path, meaning: m.meaning, signer_name: m.signerName, signer_credential: m.signerCredential, signed_at: m.signedAt, algorithm: m.algorithm, hash: m.hash }));
      const prev = last.get();
      const info = insert.run(r.clientWriteId, r.storeKey, r.entityType, r.entityId, r.operation, r.payloadJson, r.payloadSha256, prev ? linkHash(prev) : ZERO, optional(r.actor), optional(r.credential), optional(r.clientTs), now(), optional(r.buildVersion), optional(r.buildSha256), clientId, manifestSetHash(stored));
      const id = Number(info.lastInsertRowid);
      for (const m of stored) manifest.run(id, m.path, m.meaning, m.signer_name, m.signer_credential, m.signed_at, m.algorithm, m.hash);
      results.push({ clientWriteId: r.clientWriteId, status: 'stored', id });
    }
    // Phase one of the anchor update runs inside the transaction: if it cannot be written, nothing commits.
    if (beforeCommit && results.some(x => x.status === 'stored')) beforeCommit(chainTip(db));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ok: true, results };
}

// One write as the server makes it. The anchor check and, when another connection has committed since the last
// full check (SQLite's data_version, which does not change for this connection's own commits), the full chain walk
// run inside the write transaction, so no other connection can commit between the check and the append. The pending
// anchor is written before COMMIT and the final one after. state.verifiedVersion carries the last fully checked
// data_version between writes; afterCheck exists only so the suite can act while the lock is held.
export function guardedAppend(db, anchorPath, state, clientId, records, { afterCheck } = {}) {
  let anchorNow = null;
  const r = appendRecords(db, clientId, records, undefined, {
    afterLock: () => {
      anchorNow = settleAnchor(anchorPath, db);
      const version = Number(db.prepare('PRAGMA data_version').get().data_version);
      let drift = anchorMismatch(db, anchorNow);
      if (!drift && version !== state.verifiedVersion) { const v = verifyChain(db, { anchor: anchorNow }); if (v.ok) state.verifiedVersion = version; else drift = `the chain is broken at row ${v.firstBreak.id}: ${v.firstBreak.reason}`; }
      if (afterCheck) afterCheck();
      return drift;
    },
    beforeCommit: next => writePendingAnchor(anchorPath, anchorNow, next),
  });
  if (r.ok && r.results.some(x => x.status === 'stored')) writeAnchor(anchorPath, db);
  return r;
}

// Walks every row in id order: the payload must still hash to payload_sha256, the row's signature manifests
// must still hash to manifests_sha256, and prev_sha256 must be the link of the row before (64 zeros for the
// first). With an anchor, the row count and the tip must equal it, so rows removed from the end or a changed
// last row are found too. Reports the first problem.
// The id of the last row written before manifests joined the chain, as recorded in mirror_meta, or null for a
// database that has no such record (a backup taken before it existed: then only the leading-rows rule applies).
function legacyThrough(db) {
  try { const r = db.prepare("SELECT value FROM mirror_meta WHERE key = 'legacy_through'").get(); return r && /^\d+$/.test(r.value) ? Number(r.value) : null; } catch { return null; }
}
export function verifyChain(db, { anchor } = {}) {
  let expected = ZERO, count = 0, previousId = 0, tip = ZERO, legacyRows = 0, covered = false;
  const boundary = legacyThrough(db);
  const manifestsOf = db.prepare('SELECT path, meaning, signer_name, signer_credential, signed_at, algorithm, hash FROM signature_manifests WHERE record_id = ? ORDER BY id');
  for (const row of db.prepare('SELECT * FROM records ORDER BY id').iterate()) {
    count += 1;
    const id = Number(row.id);
    if (sha256(row.payload_json) !== row.payload_sha256) return { ok: false, records: count, firstBreak: { id, reason: 'payload_json no longer matches payload_sha256 (the record was changed after it was written)' } };
    // A row without manifests_sha256 is accepted only among the leading rows written before the column existed,
    // up to the id recorded at migration; anywhere else its manifests would be covered by no hash.
    if (row.manifests_sha256 === null || row.manifests_sha256 === undefined) {
      if (covered || (boundary !== null && id > boundary)) return { ok: false, records: count, firstBreak: { id, reason: 'this row has no manifests_sha256 but was written after signature manifests joined the chain (its manifests are covered by no hash)' } };
      legacyRows += 1;
    } else {
      covered = true;
      if (manifestSetHash(manifestsOf.all(row.id)) !== row.manifests_sha256) return { ok: false, records: count, firstBreak: { id, reason: 'the signature manifests of this row no longer match manifests_sha256 (a manifest was changed, added or removed)' } };
    }
    if (row.prev_sha256 !== expected) return { ok: false, records: count, firstBreak: { id, reason: id !== previousId + 1 ? `row ${previousId + 1} is missing or out of order` : 'prev_sha256 does not match the previous row (a row before it was changed)' } };
    expected = tip = linkHash(row);
    previousId = id;
  }
  const orphan = db.prepare('SELECT m.id FROM signature_manifests m LEFT JOIN records r ON r.id = m.record_id WHERE r.id IS NULL LIMIT 1').get();
  if (orphan) return { ok: false, records: count, firstBreak: { id: null, manifestId: Number(orphan.id), reason: 'a signature manifest points at a record that does not exist' } };
  if (anchor === null) return { ok: false, records: count, firstBreak: { id: null, reason: 'the chain anchor is missing or unreadable, so rows removed from the end cannot be ruled out' }, tip, legacyRows };
  if (anchor && !matchesPending({ records: count, tip }, anchor)) {
    if (count < anchor.records) return { ok: false, records: count, firstBreak: { id: count + 1, reason: `the anchor records ${anchor.records} rows but the database has ${count} (rows were removed from the end)` }, tip, legacyRows };
    if (count > anchor.records) return { ok: false, records: count, firstBreak: { id: anchor.records + 1, reason: `the database has ${count} rows but the anchor records ${anchor.records} (rows were added outside the server, or the anchor was not updated)` }, tip, legacyRows };
    if (tip !== anchor.tip) return { ok: false, records: count, firstBreak: { id: count || null, reason: 'the last row does not match the anchored chain tip (the last row was changed)' }, tip, legacyRows };
  }
  return { ok: true, records: count, firstBreak: null, tip, legacyRows };
}

const withManifests = db => {
  const q = db.prepare('SELECT path, meaning, signer_name, signer_credential, signed_at, algorithm, hash FROM signature_manifests WHERE record_id = ? ORDER BY id');
  return row => ({ ...row, id: Number(row.id), manifests: q.all(row.id) });
};

export function recordsFor(db, entity, id) {
  return db.prepare('SELECT * FROM records WHERE entity_type = ? AND entity_id = ? ORDER BY id').all(entity, id).map(withManifests(db));
}

// manifests_sha256 is part of each row's link, so the chain can be recomputed from the CSV alone.
const CSV_COLUMNS = ['id', 'client_write_id', 'store_key', 'entity_type', 'entity_id', 'operation', 'payload_sha256', 'prev_sha256', 'actor', 'credential', 'client_ts', 'server_ts', 'build_version', 'build_sha256', 'client_id', 'manifests_sha256', 'payload_json'];
const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportAll(db, format = 'json', anchor) {
  const rows = db.prepare('SELECT * FROM records ORDER BY id').all();
  if (format === 'csv') {
    // The anchor travels in the file: chain_anchor_records and chain_anchor_tip are filled on the last row only
    // (and on a lone row when the database is empty), so a removed suffix or a rewritten last row is visible
    // from the CSV alone. They are not part of any row's link.
    const cols = [...CSV_COLUMNS, 'chain_anchor_records', 'chain_anchor_tip'];
    const a = anchor || null, tail = r => ({ ...r, chain_anchor_records: a ? a.records : '', chain_anchor_tip: a ? a.tip : '' });
    const body = rows.length ? rows.map((r, i) => i === rows.length - 1 ? tail(r) : r) : (a ? [tail({})] : []);
    return [cols.join(','), ...body.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
  }
  const add = withManifests(db);
  return { exportedAt: new Date().toISOString(), api: API_VERSION, anchor: anchor || null, verify: verifyChain(db, anchor === undefined ? {} : { anchor }), records: rows.map(add) };
}

// ---- backups ---------------------------------------------------------------------------------------
const BACKUP_RE = /^flight-system-mirror-(\d{4}-\d{2}-\d{2})T(\d{6})Z\.sqlite$/;
// The copy is written with its own anchor (<backup>.anchor.json), taken from the same database state:
// the server is single threaded and no write runs between the two. The database is first checked in full
// against its trusted live anchor; a database that no longer matches it is never copied, so a backup cannot
// carry a fresh anchor for a truncated or rewritten chain.
// Another connection can commit between that check and VACUUM INTO, so the copy itself is checked against the
// same trusted anchor, and its own anchor is written from the copy, never from the live database. A copy that does
// not match is removed and the backup refused. beforeCopy exists only so the suite can commit in that window.
export function backupNow(db, dir, when = new Date(), { anchor, beforeCopy } = {}) {
  const trusted = anchor === undefined ? null : anchor;
  const refuse = reason => new Error(`backup refused: the database does not match its chain anchor (${reason}). Investigate before backing up; see Restore procedure in server/mirror/README.md.`);
  const v = verifyChain(db, { anchor: trusted });
  if (!v.ok) throw refuse(v.firstBreak.reason);
  fs.mkdirSync(dir, { recursive: true });
  const iso = when.toISOString();
  const name = `flight-system-mirror-${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, '')}Z.sqlite`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.rmSync(file);
  if (beforeCopy) beforeCopy();
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(file);
  try {
    const cv = verifyChain(copy, { anchor: trusted });
    if (!cv.ok) { copy.close(); fs.rmSync(file, { force: true }); throw refuse(`the copy taken: ${cv.firstBreak.reason}`); }
    writeAnchor(defaultAnchorPath(file), copy, when);
  } finally { try { copy.close(); } catch { /* closed above */ } }
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
    if (day < cutoff || keptDays.has(day)) { fs.rmSync(path.join(dir, f)); fs.rmSync(path.join(dir, defaultAnchorPath(f)), { force: true }); removed.push(f); } else keptDays.add(day);
  }
  return removed;
}

// ---- HTTP ------------------------------------------------------------------------------------------
// Every reason the mirror will not start with these settings, or null.
export function startRefusal(cfg) {
  if (cfg.allowNoToken) {
    if (!LOOPBACK(cfg.host)) return `--insecure-no-token runs the mirror open and is allowed only on loopback (127.0.0.1); ${cfg.host} was given. Set FS_MIRROR_TOKEN and FS_MIRROR_WRITE_TOKEN instead.`;
    return null;
  }
  if (!cfg.token) return 'The mirror needs an operator token before it starts: set FS_MIRROR_TOKEN (or --token). It reads, verifies and exports and never goes into the page. For a machine nobody else can reach, --insecure-no-token runs it open on loopback.';
  if (!cfg.writeToken) return 'The mirror needs a separate write token before it starts: set FS_MIRROR_WRITE_TOKEN (or --write-token) and put that value, not the operator token, in SK_MIRROR.token. Anyone who can open the page can read SK_MIRROR.token, so it may only append records.';
  if (cfg.writeToken === cfg.token) return 'FS_MIRROR_WRITE_TOKEN must differ from FS_MIRROR_TOKEN: the write token is readable in the page, the operator token reads and exports every record.';
  if (cfg.token.length < 16 || cfg.writeToken.length < 16) return 'FS_MIRROR_TOKEN and FS_MIRROR_WRITE_TOKEN must each be at least 16 characters (use a long random value).';
  if (!LOOPBACK(cfg.host) && !cfg.behindTlsProxy) return `The mirror speaks plain HTTP and listens on loopback only. To serve other machines, put it behind a TLS-terminating reverse proxy on this host (the proxy listens on https and forwards to 127.0.0.1), or, if the proxy is elsewhere on a trusted segment, set FS_MIRROR_BEHIND_TLS_PROXY=1 (--behind-tls-proxy) to bind ${cfg.host}.`;
  return null;
}

export function createMirror(options = {}) {
  const cfg = { ...settings([], {}), ...options };
  const refusal = startRefusal(cfg);
  if (refusal) throw new Error(refusal);
  const anchorPath = cfg.anchorPath ? path.resolve(cfg.anchorPath) : defaultAnchorPath(cfg.dbPath);
  // Only a database file this start creates gets a fresh anchor. An existing file with no anchor is refused even
  // with no rows: it may have been emptied, or its anchor (on separate storage) may not be mounted.
  const existed = fs.existsSync(cfg.dbPath);
  const db = openDatabase(cfg.dbPath);
  if (!fs.existsSync(anchorPath)) {
    const rows = Number(db.prepare('SELECT COUNT(*) n FROM records').get().n);
    if (existed) { db.close(); throw new Error(`The chain anchor ${anchorPath} is missing for the existing database ${cfg.dbPath} (${rows} records). If the anchor is kept on separate storage, make sure it is mounted. Otherwise check the chain, then write the anchor: node server/mirror/server.mjs --reanchor --db ${cfg.dbPath}${cfg.anchorPath ? ` --anchor ${anchorPath}` : ''}. After a restore, copy the backup's .anchor.json into place with it.`); }
    writeAnchor(anchorPath, db);
  } else {
    // An anchor that no longer matches means rows were removed or the last row changed while the server was
    // down. Starting would let the next write overwrite the anchor and hide that, so the server refuses.
    const v = verifyChain(db, { anchor: settleAnchor(anchorPath, db) });
    if (!v.ok) { db.close(); throw new Error(`The mirror database does not match its chain anchor ${anchorPath}: ${v.firstBreak.reason}. The server does not start, so no write can overwrite the anchor. Compare it with the latest good backup (node server/mirror/restore-test.mjs <backup> --against ${cfg.dbPath}); only after the cause is recorded, restore a backup or run --reanchor.`); }
  }
  const bearer = req => String(req.headers.authorization || '');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  // The operator token reads everything; the write token (in the page) can only append.
  const operator = req => cfg.allowNoToken || (!!cfg.token && same(bearer(req), `Bearer ${cfg.token}`));
  const writer = req => operator(req) || (!!cfg.writeToken && same(bearer(req), `Bearer ${cfg.writeToken}`));
  let lastBackup = null;
  const guard = { verifiedVersion: null };
  const send = (res, status, body, type = 'application/json') => {
    const cors = cfg.allowOrigin ? { 'access-control-allow-origin': cfg.allowOrigin, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' } : {};
    res.writeHead(status, { 'content-type': type === 'application/json' ? 'application/json; charset=utf-8' : type, ...cors, 'cache-control': 'no-store' });
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
      if (req.method === 'POST' && url.pathname === `/api/${API_VERSION}/writes`) {
        if (!writer(req)) return fail(res, 401, 'unauthorized', 'Send the write token as Authorization: Bearer <token>.');
        let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return e.status === 413 ? fail(res, 413, 'too_large', `Request body over ${cfg.maxBodyBytes} bytes.`) : fail(res, 400, 'bad_request', 'Body is not valid JSON.'); }
        // A probe: no records, only the newest row the app was told was stored. It stores nothing and is answered
        // with ackCheck alone, so a device with nothing queued still finds out the mirror was restored.
        if (body && Array.isArray(body.records) && body.records.length === 0) {
          if (!str(body.clientId, 120) || !body.lastAck) return fail(res, 400, 'bad_request', 'A post with no records must give clientId and lastAck.');
          return send(res, 200, { ok: true, results: [], ackCheck: ackCheck(db, body.lastAck) });
        }
        const check = ackCheck(db, body && body.lastAck);
        const r = guardedAppend(db, anchorPath, guard, body && body.clientId, body && body.records);
        if (r.refusal) console.error(`write refused: ${r.refusal}`);
        return r.ok ? send(res, 200, { ok: true, results: r.results, ...(check ? { ackCheck: check } : {}) }) : send(res, r.status, { ok: false, error: r.error });
      }
      if (url.pathname !== `/api/${API_VERSION}/health` && !operator(req)) return fail(res, 401, 'unauthorized', writer(req) ? 'The write token can only append records. Reading, verifying and exporting need the operator token.' : 'Send the operator token as Authorization: Bearer <token>.');
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Use GET, or POST for /api/v1/writes.');
      if (url.pathname === `/api/${API_VERSION}/health`) {
        // Without the token, liveness only: the counts, write times and backup location are for the operator.
        if (!operator(req)) return send(res, 200, { ok: true, api: API_VERSION });
        const c = db.prepare('SELECT COUNT(*) n, MAX(server_ts) last FROM records').get();
        const m = db.prepare('SELECT COUNT(*) n FROM signature_manifests').get();
        return send(res, 200, { ok: true, api: API_VERSION, records: Number(c.n), manifests: Number(m.n), lastWriteAt: c.last || null, backup: { dir: cfg.backupDir, lastFile: lastBackup, everyMinutes: cfg.backupEveryMinutes, keepDays: cfg.backupKeepDays } });
      }
      if (url.pathname === `/api/${API_VERSION}/verify`) { const anchor = readAnchor(anchorPath); const v = verifyChain(db, { anchor }); return send(res, 200, { ok: true, chainIntact: v.ok, records: v.records, firstBreak: v.firstBreak, tip: v.tip || null, anchor, legacyRows: v.legacyRows ?? 0 }); }
      if (url.pathname === `/api/${API_VERSION}/export`) {
        const format = url.searchParams.get('format') || 'json';
        if (!['json', 'csv'].includes(format)) return fail(res, 400, 'bad_request', 'format is json or csv.');
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader('content-disposition', `attachment; filename="flight-system-mirror-${day}.${format}"`);
        return format === 'csv' ? send(res, 200, exportAll(db, 'csv', exportAnchor(db, readAnchor(anchorPath))), 'text/csv; charset=utf-8') : send(res, 200, { ok: true, ...exportAll(db, 'json', exportAnchor(db, readAnchor(anchorPath))) });
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
  const runBackup = () => { lastBackup = backupNow(db, cfg.backupDir, new Date(), { anchor: readAnchor(anchorPath) }); pruneBackups(cfg.backupDir, cfg.backupKeepDays); return lastBackup; };
  return {
    server, db, cfg, anchorPath,
    verify: () => verifyChain(db, { anchor: readAnchor(anchorPath) }),
    listen() { return new Promise(resolve => server.listen(cfg.port, cfg.host, () => { const a = server.address(); if (cfg.backupEveryMinutes > 0) timer = setInterval(() => { try { runBackup(); } catch (e) { console.error('backup failed:', e.message); } }, cfg.backupEveryMinutes * 60000); resolve(a); })); },
    backup: runBackup,
    close() { if (timer) clearInterval(timer); return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => { try { db.close(); } catch { /* already closed */ } resolve(); }); }); },
  };
}

async function main() {
  const cfg = settings();
  if (cfg.reanchor) {
    // Writes the anchor for the database as it is now, after checking its chain. Run it once for a database
    // written before anchors existed; after a restore, copy the backup's own .anchor.json instead.
    const db = openDatabase(cfg.dbPath);
    const v = verifyChain(db);
    if (!v.ok) { console.error(`not anchored: the chain is broken at row ${v.firstBreak.id}: ${v.firstBreak.reason}`); db.close(); process.exit(1); }
    const file = cfg.anchorPath ? path.resolve(cfg.anchorPath) : defaultAnchorPath(cfg.dbPath);
    const a = writeAnchor(file, db); db.close();
    console.log(`anchor written: ${file} (${a.records} records, tip ${a.tip})`); return;
  }
  if (cfg.backupNow) {
    const db = openDatabase(cfg.dbPath);
    const anchorFile = cfg.anchorPath ? path.resolve(cfg.anchorPath) : defaultAnchorPath(cfg.dbPath);
    let file; try { file = backupNow(db, cfg.backupDir, new Date(), { anchor: fs.existsSync(anchorFile) ? readAnchor(anchorFile) : null }); } catch (e) { console.error(e.message); db.close(); process.exit(1); }
    const removed = pruneBackups(cfg.backupDir, cfg.backupKeepDays);
    console.log(`backup written: ${file}${removed.length ? `; removed ${removed.length} old copies` : ''}`);
    db.close(); return;
  }
  const mirror = createMirror(cfg);
  const a = await mirror.listen();
  console.log(`Flight System mirror listening on http://${a.address}:${a.port} (database ${cfg.dbPath}; anchor ${mirror.anchorPath}; backups to ${cfg.backupDir} every ${cfg.backupEveryMinutes} minutes, ${cfg.backupKeepDays} days kept${cfg.token ? '; operator and write tokens required' : '; NO TOKEN, loopback only: anyone on this machine can write and read'}${cfg.allowOrigin ? `; browser origin ${cfg.allowOrigin}` : '; no browser origin allowed'}${LOOPBACK(cfg.host) ? '' : '; behind a TLS proxy'})`);
  const stop = () => mirror.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e && e.message ? e.message : e); process.exit(1); });
