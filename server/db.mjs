// Embedded storage: one SQLite file, no dependencies (node:sqlite, Node 22.13 or later).
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (tenant TEXT PRIMARY KEY, json TEXT NOT NULL, etag TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT);
    CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT, sso INTEGER NOT NULL DEFAULT 0, roles TEXT NOT NULL DEFAULT '[]', profile TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, issued_at TEXT NOT NULL, last_seen TEXT NOT NULL);
    -- Failed sign-ins and lockouts survive a restart; only an audited unlock or the lock's end clears them.
    CREATE TABLE IF NOT EXISTS lockouts (username TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, last_failed_at TEXT);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, username TEXT, action TEXT NOT NULL, detail TEXT, prev_hash TEXT, hash TEXT NOT NULL);
    -- Evidence bytes live in the same file as the record, so the one SQLite backup covers both.
    -- Rows are never deleted or rewritten; a superseded recording keeps its bytes and says what replaced it.
    CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, file_name TEXT, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, bytes BLOB NOT NULL, superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT);
    -- Closed work orders moved out of the live document. Same file, same backup. Rows are never deleted.
    CREATE TABLE IF NOT EXISTS archive (order_id TEXT PRIMARY KEY, json TEXT NOT NULL, sha256 TEXT NOT NULL, schema INTEGER NOT NULL, part_number TEXT, serials TEXT NOT NULL, lots TEXT NOT NULL, parts TEXT NOT NULL, title TEXT, closed_at TEXT, archived_at TEXT NOT NULL, archived_by TEXT);
    CREATE TABLE IF NOT EXISTS record_extracts (export_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL DEFAULT 0, record_type TEXT NOT NULL, record_id TEXT NOT NULL, kind TEXT NOT NULL, exported_at TEXT NOT NULL, exported_by TEXT NOT NULL, sha256 TEXT NOT NULL, summary TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS record_extracts_record ON record_extracts (record_type, record_id, exported_at);
    CREATE TRIGGER IF NOT EXISTS record_extracts_no_update BEFORE UPDATE ON record_extracts BEGIN SELECT RAISE(ABORT, 'record extracts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS record_extracts_no_delete BEFORE DELETE ON record_extracts BEGIN SELECT RAISE(ABORT, 'record extracts are append-only'); END;
    CREATE TABLE IF NOT EXISTS record_export_settings (record_type TEXT PRIMARY KEY, enabled INTEGER NOT NULL, destination_kind TEXT NOT NULL, destination TEXT NOT NULL, token_setting TEXT, naming_pattern TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, rationale TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS record_export_jobs (id TEXT PRIMARY KEY, record_type TEXT NOT NULL, record_id TEXT NOT NULL, export_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, destination_kind TEXT NOT NULL, destination TEXT NOT NULL, token_setting TEXT, naming_pattern TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT, UNIQUE(record_type, record_id, sha256));
    CREATE INDEX IF NOT EXISTS record_export_jobs_status ON record_export_jobs (status, created_at);
    CREATE TABLE IF NOT EXISTS record_export_log (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS jira_issue_requests (idempotency_key TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL, project_key TEXT NOT NULL, status TEXT NOT NULL, issue_key TEXT, issue_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS record_export_log_no_update BEFORE UPDATE ON record_export_log BEGIN SELECT RAISE(ABORT, 'record export log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS record_export_log_no_delete BEFORE DELETE ON record_export_log BEGIN SELECT RAISE(ABORT, 'record export log is append-only'); END;
    CREATE TABLE IF NOT EXISTS skill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT, skill TEXT NOT NULL, input TEXT, output TEXT, status TEXT NOT NULL);
  `);
  // One export per finalized version: a reopened and re-finalized record has new content and is exported again. A
  // database made before this keyed jobs on the record alone; rebuild that table once, keeping every job.
  const jobsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_export_jobs'").get()?.sql || '';
  if (/UNIQUE\(record_type, record_id\)/.test(jobsSql)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE record_export_jobs_v2 (id TEXT PRIMARY KEY, record_type TEXT NOT NULL, record_id TEXT NOT NULL, export_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, destination_kind TEXT NOT NULL, destination TEXT NOT NULL, token_setting TEXT, naming_pattern TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT, UNIQUE(record_type, record_id, sha256));
        INSERT INTO record_export_jobs_v2 SELECT id, record_type, record_id, export_id, sha256, payload, status, attempts, destination_kind, destination, token_setting, naming_pattern, created_at, created_by, updated_at, last_error FROM record_export_jobs;
        DROP TABLE record_export_jobs;
        ALTER TABLE record_export_jobs_v2 RENAME TO record_export_jobs;
        CREATE INDEX IF NOT EXISTS record_export_jobs_status ON record_export_jobs (status, created_at);`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const extractColumns = new Set(db.prepare('PRAGMA table_info(record_extracts)').all().map(row => row.name));
  if (!extractColumns.has('sequence')) db.exec('ALTER TABLE record_extracts ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0');
  const accountColumns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name));
  if (!accountColumns.has('roles')) db.exec("ALTER TABLE accounts ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'");
  if (!accountColumns.has('profile')) db.exec("ALTER TABLE accounts ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'");
  // Preserve the single-role schema while migrating existing accounts to an explicit role list.
  db.exec("UPDATE accounts SET roles = json_array(role) WHERE roles IS NULL OR roles = '' OR roles = '[]'");
  // Upgrade a pre-chain Flight audit table once, preserving every original event.
  const auditColumns = new Set(db.prepare('PRAGMA table_info(audit)').all().map(row => row.name));
  if (!auditColumns.has('prev_hash')) db.exec('ALTER TABLE audit ADD COLUMN prev_hash TEXT');
  if (!auditColumns.has('hash')) db.exec('ALTER TABLE audit ADD COLUMN hash TEXT');
  const auditHash = row => createHash('sha256').update(JSON.stringify({ id: row.id, at: row.at, username: row.username, action: row.action, detail: row.detail, prevHash: row.prev_hash || null })).digest('hex');
  let priorAuditHash = null;
  for (const row of db.prepare('SELECT id, at, username, action, detail, prev_hash, hash FROM audit ORDER BY id').all()) {
    if (!row.hash) {
      const prev_hash = row.prev_hash || priorAuditHash;
      const hash = auditHash({ ...row, prev_hash });
      db.prepare('UPDATE audit SET prev_hash = ?, hash = ? WHERE id = ?').run(prev_hash, hash, row.id);
      row.hash = hash; row.prev_hash = prev_hash;
    } else if ((row.prev_hash || null) !== priorAuditHash || auditHash(row) !== row.hash) {
      throw new Error(`Flight System audit chain is invalid at entry ${row.id}. The database was left unchanged.`);
    }
    priorAuditHash = row.hash;
  }
  const now = () => new Date().toISOString();
  const etagFor = (json, revision) => `"${revision}-${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;
  return {
    db,
    // ---- documents ----
    getDoc(tenant = 'default') {
      const row = db.prepare('SELECT json, etag, revision, updated_at, updated_by FROM documents WHERE tenant = ?').get(tenant);
      return row ? { json: row.json, etag: row.etag, revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
    },
    // Whole-document write with optimistic concurrency. Returns the new etag, or null on a mismatch.
    // Runs fn inside one transaction; rolls back if it throws or returns false.
    async transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = await fn(this); if (r === false) { db.exec('ROLLBACK'); return r; } db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async lockAuthority() {},
    putDoc(tenant, json, expectedEtag, by) {
      const cur = this.getDoc(tenant);
      if (cur && expectedEtag !== undefined && expectedEtag !== null && cur.etag !== expectedEtag) return null;
      const revision = (cur ? cur.revision : 0) + 1, etag = etagFor(json, revision);
      db.prepare('INSERT INTO documents (tenant, json, etag, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant) DO UPDATE SET json = excluded.json, etag = excluded.etag, revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by').run(tenant, json, etag, revision, now(), by || null);
      return etag;
    },
    // ---- accounts ----
    accounts() { return db.prepare('SELECT username, display_name, salt, hash, role, roles, profile, created_at, created_by, sso FROM accounts ORDER BY created_at').all().map(r => { let roles, profile; try { roles = JSON.parse(r.roles || '[]'); } catch { roles = []; } try { profile = JSON.parse(r.profile || '{}'); } catch { profile = {}; } if (!Array.isArray(roles) || !roles.length) roles = [r.role]; if (!profile || typeof profile !== 'object' || Array.isArray(profile)) profile = {}; return { ...profile, username: r.username, displayName: r.display_name, salt: r.salt, hash: r.hash, role: r.role, roles, createdAt: r.created_at, createdBy: r.created_by, sso: !!r.sso }; }); },
    account(username) { return this.accounts().find(a => a.username === username) || null; },
    upsertAccount(a) {
      const roles = Array.isArray(a.roles) && a.roles.length ? [...new Set(a.roles)] : [a.role];
      const role = roles.includes(a.role) ? a.role : roles[0];
      const profile = { extraRoles: Array.isArray(a.extraRoles) ? a.extraRoles : [], roleTraining: a.roleTraining && typeof a.roleTraining === 'object' && !Array.isArray(a.roleTraining) ? a.roleTraining : {}, grants: a.grants && typeof a.grants === 'object' && !Array.isArray(a.grants) ? a.grants : {}, grantHistory: Array.isArray(a.grantHistory) ? a.grantHistory : [], supportAccess: a.supportAccess === true };
      db.prepare('INSERT INTO accounts (username, display_name, salt, hash, role, created_at, created_by, sso, roles, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, salt = excluded.salt, hash = excluded.hash, role = excluded.role, sso = excluded.sso, roles = excluded.roles, profile = excluded.profile').run(a.username, a.displayName, a.salt, a.hash, role, a.createdAt || now(), a.createdBy || null, a.sso ? 1 : 0, JSON.stringify(roles), JSON.stringify(profile));
    },
    deleteAccount(username) { db.prepare('DELETE FROM accounts WHERE username = ?').run(username); db.prepare('DELETE FROM sessions WHERE username = ?').run(username); },
    // ---- sessions: one active session per account ----
    openSession(username, when = Date.now()) {
      db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
      const token = randomBytes(24).toString('base64url'), at = new Date(when).toISOString();
      db.prepare('INSERT INTO sessions (token, username, issued_at, last_seen) VALUES (?, ?, ?, ?)').run(token, username, at, at);
      return { token, issuedAt: at };
    },
    // A session ends after idleMs without activity or maxMs after it was issued, whichever comes first.
    // An expired session is deleted and reported as { expired: 'idle' | 'absolute' }. touch: false reads
    // it without counting as activity (the page's heartbeat), so an open tab alone does not keep it alive.
    session(token, { idleMs = Infinity, maxMs = Infinity, touch = true, at = Date.now() } = {}) {
      if (!token) return null;
      const row = db.prepare('SELECT token, username, issued_at, last_seen FROM sessions WHERE token = ?').get(token);
      if (!row) return null;
      const expired = at - Date.parse(row.issued_at) >= maxMs ? 'absolute' : at - Date.parse(row.last_seen) >= idleMs ? 'idle' : null;
      if (expired) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return { expired, username: row.username }; }
      if (touch) db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(new Date(at).toISOString(), token);
      return { token: row.token, username: row.username, issuedAt: row.issued_at, lastSeen: row.last_seen };
    },
    closeSession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); },
    closeSessionsOf(username, exceptToken = null) { return db.prepare('DELETE FROM sessions WHERE username = ? AND token IS NOT ?').run(username, exceptToken).changes; },
    // ---- failed sign-ins and lockouts ----
    lockout(username) { const r = db.prepare('SELECT username, fails, locked_until, last_failed_at FROM lockouts WHERE username = ?').get(username); return r ? { username: r.username, fails: r.fails, until: r.locked_until, lastFailedAt: r.last_failed_at } : { username, fails: 0, until: 0, lastFailedAt: null }; },
    noteFailedSignin(username, limit, lockUntil) { const r = db.prepare('INSERT INTO lockouts (username, fails, locked_until, last_failed_at) VALUES (?, CASE WHEN 1 >= ? THEN 0 ELSE 1 END, CASE WHEN 1 >= ? THEN ? ELSE 0 END, ?) ON CONFLICT(username) DO UPDATE SET fails = CASE WHEN lockouts.fails + 1 >= ? THEN 0 ELSE lockouts.fails + 1 END, locked_until = CASE WHEN lockouts.fails + 1 >= ? THEN ? ELSE lockouts.locked_until END, last_failed_at = excluded.last_failed_at RETURNING fails, locked_until').get(username, limit, limit, lockUntil, now(), limit, limit, lockUntil); return { fails: r.fails, until: r.locked_until, locked: r.locked_until === lockUntil }; },
    setLockout(username, fails, until) { db.prepare('INSERT INTO lockouts (username, fails, locked_until, last_failed_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, last_failed_at = excluded.last_failed_at').run(username, fails, until, now()); },
    clearLockout(username) { return db.prepare('DELETE FROM lockouts WHERE username = ?').run(username).changes > 0; },
    lockouts(at = Date.now()) { return db.prepare('SELECT username, fails, locked_until, last_failed_at FROM lockouts WHERE locked_until > ? ORDER BY locked_until DESC').all(at).map(r => ({ username: r.username, until: new Date(r.locked_until).toISOString(), lastFailedAt: r.last_failed_at })); },
    // ---- archive of closed work orders ----
    archived(id) { const r = db.prepare('SELECT order_id, json, sha256, schema, archived_at, archived_by FROM archive WHERE order_id = ?').get(id); return r ? { id: r.order_id, entry: JSON.parse(r.json), sha256: r.sha256, schema: r.schema, archivedAt: r.archived_at, archivedBy: r.archived_by } : null; },
    archivedSha(id) { const r = db.prepare('SELECT sha256 FROM archive WHERE order_id = ?').get(id); return r ? r.sha256 : null; },
    putArchived(e) { db.prepare('INSERT INTO archive (order_id, json, sha256, schema, part_number, serials, lots, parts, title, closed_at, archived_at, archived_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(e.id, e.json, e.sha256, e.schema, e.keys.partNumber || null, JSON.stringify(e.keys.serials), JSON.stringify(e.keys.lots), JSON.stringify(e.keys.parts), e.keys.title || null, e.keys.closedAt || null, now(), e.by || null); },
    archiveCount() { return db.prepare('SELECT COUNT(*) AS c FROM archive').get().c; },
    // Exact match on an order ID, serial, lot or part (case-insensitive), or a list when the query is empty.
    archiveSearch(query, limit = 200) {
      const q = String(query || '').trim().toUpperCase();
      const rows = q
        ? db.prepare("SELECT order_id, part_number, serials, lots, parts, title, closed_at, archived_at FROM archive WHERE UPPER(order_id) = ? OR EXISTS (SELECT 1 FROM json_each(archive.serials) WHERE UPPER(value) = ?) OR EXISTS (SELECT 1 FROM json_each(archive.lots) WHERE UPPER(value) = ?) OR EXISTS (SELECT 1 FROM json_each(archive.parts) WHERE UPPER(value) = ?) ORDER BY archived_at DESC LIMIT ?").all(q, q, q, q, limit)
        : db.prepare('SELECT order_id, part_number, serials, lots, parts, title, closed_at, archived_at FROM archive ORDER BY archived_at DESC LIMIT ?').all(limit);
      return rows.map(r => ({ orderId: r.order_id, partNumber: r.part_number, serials: JSON.parse(r.serials), lots: JSON.parse(r.lots), parts: JSON.parse(r.parts), title: r.title, closedAt: r.closed_at, archivedAt: r.archived_at, status: 'Closed', source: 'archive' }));
    },
    // Stamped downloads and prints are separate append-only history rows so an archived order stays immutable.
    recordExtract(e) {
      const sequence = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM record_extracts').get().n;
      db.prepare('INSERT INTO record_extracts (export_id, sequence, record_type, record_id, kind, exported_at, exported_by, sha256, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(e.exportId, sequence, e.recordType, e.recordId, e.kind, e.exportedAt || now(), e.exportedBy, e.sha256, JSON.stringify(e.summary || {}));
      return this.extractHistory(e.recordType, e.recordId).find(row => row.exportId === e.exportId);
    },
    extractHistory(recordType, recordId) {
      return db.prepare('SELECT export_id, sequence, record_type, record_id, kind, exported_at, exported_by, sha256, summary FROM record_extracts WHERE record_type = ? AND record_id = ? ORDER BY sequence, exported_at').all(recordType, recordId).map(row => ({ exportId: row.export_id, sequence: row.sequence, recordType: row.record_type, recordId: row.record_id, kind: row.kind, exportedAt: row.exported_at, exportedBy: row.exported_by, sha256: row.sha256, summary: JSON.parse(row.summary) }));
    },
    exportSettings() { return db.prepare('SELECT record_type, enabled, destination_kind, destination, token_setting, naming_pattern, updated_at, updated_by, rationale FROM record_export_settings ORDER BY record_type').all().map(r => ({ recordType: r.record_type, enabled: !!r.enabled, destinationKind: r.destination_kind, destination: r.destination, tokenSetting: r.token_setting, namingPattern: r.naming_pattern, updatedAt: r.updated_at, updatedBy: r.updated_by, rationale: r.rationale })); },
    exportSetting(recordType) { return this.exportSettings().find(row => row.recordType === recordType) || null; },
    jiraIssueRequest(key) { return db.prepare('SELECT * FROM jira_issue_requests WHERE idempotency_key=?').get(key) || null; },
    beginJiraIssueRequest(row) { const result=db.prepare('INSERT OR IGNORE INTO jira_issue_requests (idempotency_key,request_sha256,record_type,record_id,project_key,status,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(row.idempotencyKey,row.requestSha256,row.recordType,row.recordId,row.projectKey,'pending',now(),now(),row.createdBy); return { request:this.jiraIssueRequest(row.idempotencyKey), inserted:result.changes===1 }; },
    completeJiraIssueRequest(key, issue) { const r=db.prepare("UPDATE jira_issue_requests SET status='created',issue_key=?,issue_url=?,updated_at=? WHERE idempotency_key=? AND status='pending'").run(issue.key,issue.url,now(),key); return r.changes===1 ? this.jiraIssueRequest(key) : null; },
    putExportSetting(value) { db.prepare('INSERT INTO record_export_settings (record_type, enabled, destination_kind, destination, token_setting, naming_pattern, updated_at, updated_by, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_type) DO UPDATE SET enabled=excluded.enabled,destination_kind=excluded.destination_kind,destination=excluded.destination,token_setting=excluded.token_setting,naming_pattern=excluded.naming_pattern,updated_at=excluded.updated_at,updated_by=excluded.updated_by,rationale=excluded.rationale').run(value.recordType, value.enabled ? 1 : 0, value.destinationKind, value.destination, value.tokenSetting || null, value.namingPattern, now(), value.updatedBy, value.rationale); return this.exportSetting(value.recordType); },
    queueExportJob(value) { const at = now(); const result = db.prepare('INSERT OR IGNORE INTO record_export_jobs (id,record_type,record_id,export_id,sha256,payload,status,attempts,destination_kind,destination,token_setting,naming_pattern,created_at,created_by,updated_at,last_error) VALUES (?,?,?,?,?,?,\'pending\',0,?,?,?,?,?,?,?,NULL)').run(value.id,value.recordType,value.recordId,value.exportId,value.sha256,value.payload,value.destinationKind,value.destination,value.tokenSetting||null,value.namingPattern,at,value.createdBy,at); return result.changes ? this.exportJob(value.id) : null; },
    exportJob(id) { const r = db.prepare('SELECT * FROM record_export_jobs WHERE id=?').get(id); return r ? { id:r.id, recordType:r.record_type, recordId:r.record_id, exportId:r.export_id, sha256:r.sha256, payload:r.payload, status:r.status, attempts:r.attempts, destinationKind:r.destination_kind, destination:r.destination, tokenSetting:r.token_setting, namingPattern:r.naming_pattern, createdAt:r.created_at, createdBy:r.created_by, updatedAt:r.updated_at, lastError:r.last_error } : null; },
    pendingExportJobs(limit = 100) { return db.prepare("SELECT id FROM record_export_jobs WHERE status='pending' ORDER BY created_at LIMIT ?").all(limit).map(r => this.exportJob(r.id)); },
    exportJobs(limit = 200) { return db.prepare('SELECT id FROM record_export_jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(r => this.exportJob(r.id)); },
    updateExportJob(id, { status, detail = null }) { db.exec('BEGIN IMMEDIATE'); try { const job = this.exportJob(id); if (!job) { db.exec('ROLLBACK'); return null; } const attempts = job.attempts + 1; db.prepare('UPDATE record_export_jobs SET status=?,attempts=?,updated_at=?,last_error=? WHERE id=?').run(status, attempts, now(), detail, id); db.prepare('INSERT INTO record_export_log (job_id,at,attempt,status,detail) VALUES (?,?,?,?,?)').run(id, now(), attempts, status, detail); db.exec('COMMIT'); return this.exportJob(id); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    retryExportJob(id, by) { db.exec('BEGIN IMMEDIATE'); try { const job = this.exportJob(id); if (!job) { db.exec('ROLLBACK'); return null; } db.prepare("UPDATE record_export_jobs SET status='pending',attempts=0,updated_at=?,last_error=NULL WHERE id=?").run(now(), id); db.prepare("INSERT INTO record_export_log (job_id,at,attempt,status,detail) VALUES (?,?,0,'queued',?)").run(now(), id, `Manual retry requested by ${by}.`); db.exec('COMMIT'); return this.exportJob(id); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    exportLog(jobId, limit = 100) { return db.prepare('SELECT job_id,at,attempt,status,detail FROM record_export_log WHERE job_id=? ORDER BY id DESC LIMIT ?').all(jobId,limit); },
    pendingExportCount() { return db.prepare("SELECT COUNT(*) AS c FROM record_export_jobs WHERE status IN ('pending','retrying','failed')").get().c; },
    // ---- evidence ----
    evidenceMeta(id) {
      const r = db.prepare('SELECT id, sha256, size, mime, file_name, uploaded_by, uploaded_at, superseded_by, superseded_at, superseded_reason FROM evidence WHERE id = ?').get(id);
      return r ? { id: r.id, sha256: r.sha256, size: r.size, mime: r.mime, fileName: r.file_name, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, supersededBy: r.superseded_by, supersededAt: r.superseded_at, supersededReason: r.superseded_reason } : null;
    },
    evidenceBytes(id) { const r = db.prepare('SELECT bytes FROM evidence WHERE id = ?').get(id); return r ? Buffer.from(r.bytes) : null; },
    evidenceList() { return db.prepare('SELECT id FROM evidence ORDER BY uploaded_at').all().map(r => this.evidenceMeta(r.id)); },
    putEvidence(e) { db.prepare('INSERT INTO evidence (id, sha256, size, mime, file_name, uploaded_by, uploaded_at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(e.id, e.sha256, e.size, e.mime, e.fileName || null, e.uploadedBy, now(), e.bytes); return this.evidenceMeta(e.id); },
    supersedeEvidence(id, by, reason) { db.prepare('UPDATE evidence SET superseded_by = ?, superseded_at = ?, superseded_reason = ? WHERE id = ? AND superseded_by IS NULL').run(by, now(), reason, id); return this.evidenceMeta(id); },
    // Online backup of the whole file: record, accounts, audit and evidence together.
    backup(dest) { return sqliteBackup(db, dest); },
    // ---- append-only, hash-chained audit and skill runs ----
    audit(username, action, detail) {
      const last = db.prepare('SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1').get();
      const row = { id: (last?.id || 0) + 1, at: now(), username: username || null, action, detail: detail ? JSON.stringify(detail).slice(0, 4000) : null, prev_hash: last?.hash || null };
      row.hash = auditHash(row);
      db.prepare('INSERT INTO audit (id, at, username, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.at, row.username, row.action, row.detail, row.prev_hash, row.hash);
      return { ...row, prevHash: row.prev_hash };
    },
    auditRows(limit = 200) { return db.prepare('SELECT id, at, username, action, detail, prev_hash AS prevHash, hash FROM audit ORDER BY id DESC LIMIT ?').all(limit); },
    verifyAudit() {
      let previous = null, checked = 0;
      for (const row of db.prepare('SELECT id, at, username, action, detail, prev_hash, hash FROM audit ORDER BY id').all()) {
        if ((row.prev_hash || null) !== previous || auditHash(row) !== row.hash) return { ok: false, checked, failedAt: row.id };
        previous = row.hash; checked += 1;
      }
      return { ok: true, checked, head: previous };
    },
    skillRun(username, skill, input, output, status) { db.prepare('INSERT INTO skill_runs (at, username, skill, input, output, status) VALUES (?, ?, ?, ?, ?, ?)').run(now(), username || null, skill, JSON.stringify(input ?? null).slice(0, 20000), JSON.stringify(output ?? null).slice(0, 200000), status); },
    close() { db.close(); }
  };
}
