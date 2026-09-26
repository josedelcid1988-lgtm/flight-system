// Embedded storage: one SQLite file, no dependencies (node:sqlite, Node 22.13 or later).
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (tenant TEXT PRIMARY KEY, json TEXT NOT NULL, etag TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT);
    CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT, sso INTEGER NOT NULL DEFAULT 0, roles TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, issued_at TEXT NOT NULL, last_seen TEXT NOT NULL);
    -- Failed sign-ins and lockouts survive a restart; only an audited unlock or the lock's end clears them.
    CREATE TABLE IF NOT EXISTS lockouts (username TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, last_failed_at TEXT);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, username TEXT, action TEXT NOT NULL, detail TEXT, prev_hash TEXT, hash TEXT NOT NULL);
    -- Evidence bytes live in the same file as the record, so the one SQLite backup covers both.
    -- Rows are never deleted or rewritten; a superseded recording keeps its bytes and says what replaced it.
    CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, file_name TEXT, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, bytes BLOB NOT NULL, superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT);
    -- Closed work orders moved out of the live document. Same file, same backup. Rows are never deleted.
    CREATE TABLE IF NOT EXISTS archive (order_id TEXT PRIMARY KEY, json TEXT NOT NULL, sha256 TEXT NOT NULL, schema INTEGER NOT NULL, part_number TEXT, serials TEXT NOT NULL, lots TEXT NOT NULL, parts TEXT NOT NULL, title TEXT, closed_at TEXT, archived_at TEXT NOT NULL, archived_by TEXT);
    CREATE TABLE IF NOT EXISTS skill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT, skill TEXT NOT NULL, input TEXT, output TEXT, status TEXT NOT NULL);
  `);
  const accountColumns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name));
  if (!accountColumns.has('roles')) db.exec("ALTER TABLE accounts ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'");
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
    transaction(fn) { db.exec('BEGIN'); try { const r = fn(); if (r === false) { db.exec('ROLLBACK'); return r; } db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    putDoc(tenant, json, expectedEtag, by) {
      const cur = this.getDoc(tenant);
      if (cur && expectedEtag !== undefined && expectedEtag !== null && cur.etag !== expectedEtag) return null;
      const revision = (cur ? cur.revision : 0) + 1, etag = etagFor(json, revision);
      db.prepare('INSERT INTO documents (tenant, json, etag, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant) DO UPDATE SET json = excluded.json, etag = excluded.etag, revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by').run(tenant, json, etag, revision, now(), by || null);
      return etag;
    },
    // ---- accounts ----
    accounts() { return db.prepare('SELECT username, display_name, salt, hash, role, roles, created_at, created_by, sso FROM accounts ORDER BY created_at').all().map(r => { let roles; try { roles = JSON.parse(r.roles || '[]'); } catch { roles = []; } if (!Array.isArray(roles) || !roles.length) roles = [r.role]; return { username: r.username, displayName: r.display_name, salt: r.salt, hash: r.hash, role: r.role, roles, createdAt: r.created_at, createdBy: r.created_by, sso: !!r.sso }; }); },
    account(username) { return this.accounts().find(a => a.username === username) || null; },
    upsertAccount(a) {
      const roles = Array.isArray(a.roles) && a.roles.length ? [...new Set(a.roles)] : [a.role];
      const role = roles.includes(a.role) ? a.role : roles[0];
      db.prepare('INSERT INTO accounts (username, display_name, salt, hash, role, created_at, created_by, sso, roles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, salt = excluded.salt, hash = excluded.hash, role = excluded.role, sso = excluded.sso, roles = excluded.roles').run(a.username, a.displayName, a.salt, a.hash, role, a.createdAt || now(), a.createdBy || null, a.sso ? 1 : 0, JSON.stringify(roles));
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
