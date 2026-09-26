// Flight System server: serves index.html and its assets, keeps one shared workspace per tenant in
// SQLite, signs people in with one active session each, and runs the same MES rules the browser
// runs. No dependencies beyond Node 22.13 or later.
//
//   node server/server.mjs --port 8080 --db data/flight.sqlite
//
// See docs/BACKEND_CONTRACT.md for the interface.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { openDb } from './db.mjs';
import { createHost } from './mes-host.mjs';

process.on('warning', w => { if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return; console.warn(w); });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT = 'default';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };
const sha256hex = text => createHash('sha256').update(text).digest('hex');
// Passwords: scrypt with a 16-byte random salt, parameters stored inside the hash string so they can be
// raised later: scrypt$N=32768,r=8,p=1$<salt hex>$<hash hex>. This is the same form the engine's
// MES.secretHash writes in the browser, so a hash made on either side verifies on the other.
// Two older forms are still read: a legacy SHA-256 of salt:password (64 hex), and the same wrapped in
// scrypt at startup (scrypt-sha256$...). A successful sign-in replaces either with a current hash.
export const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1 });
const scryptAsync = (secret, salt, { N, r, p }) => new Promise((resolve, reject) => scryptCb(secret, salt, 32, { N, r, p, maxmem: 256 * N * r + 16 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
const HASH_RE = /^(scrypt|scrypt-sha256)\$N=(\d+),r=(\d+),p=(\d+)\$([0-9a-f]{32,128})\$([0-9a-f]{64})$/;
const parseHash = stored => { const m = HASH_RE.exec(String(stored || '')); if (!m) return null; const h = { kind: m[1], N: +m[2], r: +m[3], p: +m[4], salt: m[5], hash: m[6] }; return h.N >= 2 && h.N <= 1048576 && (h.N & (h.N - 1)) === 0 && h.r >= 1 && h.r <= 32 && h.p >= 1 && h.p <= 16 ? h : null; };
const sameHex = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
export const hashKind = stored => { const h = parseHash(stored); if (h) return h.kind === 'scrypt' && h.N >= SCRYPT.N && h.r >= SCRYPT.r && h.p >= SCRYPT.p ? 'current' : h.kind === 'scrypt' ? 'weak' : 'wrapped'; return /^[0-9a-f]{64}$/.test(String(stored || '')) ? 'sha256' : 'unknown'; };
export async function makeHash(password, params = SCRYPT) { const salt = randomBytes(16); return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('hex')}$${(await scryptAsync(password, salt, params)).toString('hex')}`; }
async function wrapLegacy(hex) { const salt = randomBytes(16); return `scrypt-sha256$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('hex')}$${(await scryptAsync(hex, salt, SCRYPT)).toString('hex')}`; }
async function verifyPassword(account, password) {
  const h = parseHash(account.hash);
  if (h && h.kind === 'scrypt') return sameHex((await scryptAsync(password, Buffer.from(h.salt, 'hex'), h)).toString('hex'), h.hash);
  if (h) return sameHex((await scryptAsync(sha256hex(`${account.salt}:${password}`), Buffer.from(h.salt, 'hex'), h)).toString('hex'), h.hash);
  if (/^[0-9a-f]{64}$/.test(String(account.hash || ''))) { await scryptAsync('x', 'equalize-timing', SCRYPT); return sameHex(sha256hex(`${account.salt}:${password}`), account.hash); }
  await scryptAsync(String(password), 'no-such-hash', SCRYPT); return false;
}
const publicAccount = a => ({ username: a.username, displayName: a.displayName, role: a.role, roles: Array.isArray(a.roles) && a.roles.length ? [...a.roles] : [a.role], createdAt: a.createdAt, createdBy: a.createdBy, sso: a.sso });
const LOCK_AFTER = 5, LOCK_MS = 5 * 60 * 1000;
// The one request body limit, in bytes. It is sized to the largest evidence upload the engine allows
// (MES.MAX_EVIDENCE_BYTES, sent as the raw body with no encoding overhead), and it also caps the workspace
// document. The nginx sample and the IT specification use the same number; tests/test_limits.mjs checks it.
export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_REQUEST_MIB = MAX_REQUEST_BYTES / 1048576;
const tooLarge = () => Object.assign(new Error(`The request is larger than the ${MAX_REQUEST_MIB} MiB limit (${MAX_REQUEST_BYTES} bytes). Send a smaller document or recording: remove large inline files, or trim or re-encode the video.`), { status: 413 });
const EVIDENCE_TYPES = ['video/webm', 'video/mp4', 'video/quicktime'];
const EVIDENCE_ID = /^EV-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every recording the document names, with where it sits and whether its operation is signed.
const evidenceRefs = state => (state && Array.isArray(state.orders) ? state.orders : []).flatMap(o => (o.operations || []).flatMap(op => (op.evidence || []).map(e => ({ orderId: o.id, opId: op.id, done: !!op.done, signed: !!(op.done && op.buyoff && (op.buyoff.evidenceIds || []).includes(e.id)), e }))));

// Clears one named user's lockout with a reason and an audit row. Used by the API and the CLI.
export function unlockAccount(store, username, reason, by) {
  if (!username) return { status: 400, body: { error: 'Name the account to unlock.' } };
  if (reason.length < 3 || reason.length > 300) return { status: 400, body: { error: 'Give the reason for unlocking (3 to 300 characters), for example how the person was verified.' } };
  const cur = store.lockout(username);
  if (!(cur.until > Date.now()) && !cur.fails) return { status: 404, body: { error: `${username} is not locked. Nothing to unlock.` } };
  store.clearLockout(username);
  store.audit(by, 'unlock', { username, reason, wasLockedUntil: cur.until ? new Date(cur.until).toISOString() : null });
  return { status: 200, body: { username, unlocked: true, by, reason } };
}

// Session lifetime: minutes without activity and hours since sign-in. Options, then environment, then defaults.
export const DEFAULT_HOST = '0.0.0.0';
export const SESSION_DEFAULTS = Object.freeze({ idleMinutes: 30, maxHours: 12 });
const positive = (...values) => { for (const v of values) { const n = Number(v); if (v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0) return n; } return null; };

export function createServer(options = {}) {
  const indexPath = options.indexPath || path.join(ROOT, 'index.html');
  const dbPath = options.dbPath || process.env.FLIGHT_DB || path.join(ROOT, 'data', 'flight.sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = openDb(dbPath);
  const idleMinutes = positive(options.sessionIdleMinutes, process.env.FLIGHT_SESSION_IDLE_MINUTES) || SESSION_DEFAULTS.idleMinutes;
  const maxHours = positive(options.sessionMaxHours, process.env.FLIGHT_SESSION_MAX_HOURS) || SESSION_DEFAULTS.maxHours;
  const lifetime = { idleMs: idleMinutes * 60000, maxMs: maxHours * 3600000 };
  const clock = options.clock || (() => Date.now());
  const host = createHost(indexPath);
  if (host.MES.MAX_EVIDENCE_BYTES && host.MES.MAX_EVIDENCE_BYTES > MAX_REQUEST_BYTES) throw new Error(`index.html allows ${host.MES.MAX_EVIDENCE_BYTES} byte recordings but the server's request limit is ${MAX_REQUEST_BYTES}. Raise MAX_REQUEST_BYTES and the proxy's client_max_body_size together.`);
  const log = options.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const hashReport = () => { const out = { current: 0, weak: 0, wrapped: 0, sha256: 0, unknown: 0, sso: 0 }; for (const a of store.accounts()) { if (a.sso) out.sso += 1; else out[hashKind(a.hash)] += 1; } return out; };
  // No SHA-256-only password hash is left at rest: each is wrapped in scrypt at startup (and on receipt),
  // and replaced with a plain scrypt hash of the password at that person's next sign-in.
  const wrapped = (async () => {
    let n = 0;
    for (const a of store.accounts()) if (!a.sso && hashKind(a.hash) === 'sha256') { store.upsertAccount({ ...a, hash: await wrapLegacy(a.hash) }); n += 1; }
    if (n) store.audit(null, 'password-wrap', { accounts: n });
    const r = hashReport();
    log(`password hashes: ${r.current} current scrypt, ${r.wrapped} legacy wrapped in scrypt (replaced at next sign-in), ${r.weak} below current parameters, ${r.sha256} SHA-256 only`);
    return r;
  })();

  // ---- helpers ----
  const send = (res, status, body, headers = {}) => { const json = body === undefined ? '' : JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(json); };
  // Bodies are counted in bytes against MAX_REQUEST_BYTES; a declared Content-Length over it is refused before reading.
  const readBody = req => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) { reject(tooLarge()); req.resume(); return; }
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > MAX_REQUEST_BYTES) { over = true; reject(tooLarge()); req.resume(); return; } chunks.push(c); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); }); req.on('error', reject);
  });
  const readJson = req => readBody(req).then(buf => { try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { throw Object.assign(new Error('The request body is not JSON. Send the document as JSON.'), { status: 400 }); } });
  const tokenOf = req => { const h = req.headers.authorization || ''; const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1].trim() : null; };
  // The session behind the request, or null. An expired one is audited once and remembered on the request so the
  // refusal can say why.
  const sessionOf = (req, { touch = true } = {}) => {
    const s = store.session(tokenOf(req), { ...lifetime, touch, at: clock() });
    if (!s) return null;
    if (s.expired) { req.sessionExpired = s.expired; store.audit(s.username, 'session-expired', { reason: s.expired }); return null; }
    const account = store.account(s.username); return account ? { ...s, account } : null;
  };
  const noSession = (res, req) => req.sessionExpired
    ? send(res, 401, { error: req.sessionExpired === 'idle' ? `Your session ended after ${idleMinutes} minutes without activity. Sign in again to continue; what you typed on this page is kept.` : `Your session reached its ${maxHours}-hour limit. Sign in again to continue; what you typed on this page is kept.`, code: 'SESSION_EXPIRED', reason: req.sessionExpired })
    : send(res, 401, { error: 'Signed in elsewhere or session expired.', code: 'SESSION_REVOKED' });
  const accountRoles = account => Array.isArray(account && account.roles) && account.roles.length ? account.roles : [host.roleOf(account)];
  const manages = account => accountRoles(account).some(role => ['qm', 'admin'].includes(role));
  // Lockouts are kept in SQLite, so a restart does not clear a brute-force lockout.
  const lockedFor = username => { const f = store.lockout(username); return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; };
  const noteFailure = username => { const f = store.lockout(username); let n = f.fails + 1, until = f.until; if (n >= LOCK_AFTER) { until = Date.now() + LOCK_MS; n = 0; store.audit(username, 'lockout', { minutes: LOCK_MS / 60000 }); } store.setLockout(username, n, until); return { n, until }; };

  // The document as the engine sees it: upgraded, blockers synced, validated. Returns the state or a problem.
  const loadState = () => { const row = store.getDoc(TENANT); if (!row) return { state: null, etag: null }; const parsed = JSON.parse(row.json); const state = host.MES.upgrade(structuredClone(parsed)); return { state, etag: row.etag, raw: parsed, problem: state ? null : (host.MES.diagnose(parsed) || {}).detail || 'The document does not match the current record format.' }; };
  const validState = state => { host.MES.syncBlockers?.(state); if (Array.isArray(state.orders) && state.orders.filter(order => order.status !== 'Closed').length > 1000) return 'The workspace exceeds the 1,000 open work order limit. Close or archive work before adding more orders.'; if (host.MES.validate(state)) return null; return (host.MES.diagnose(state) || {}).detail || 'The workspace is invalid.'; };

  // Evidence integrity on every write, beside the engine's validation. The engine refuses a buy-off
  // without a stored copy and hash and refuses edits to signed evidence (MES.evidenceChanges); the
  // server adds what only it can know: that a server receipt matches bytes it holds, and that a
  // newly signed buy-off names recordings the server stored, not ones kept on one device.
  const evidenceProblem = (prev, next) => {
    const changed = host.MES.evidenceChanges ? host.MES.evidenceChanges(prev, next) : null;
    if (changed) return changed;
    const before = new Set(evidenceRefs(prev).filter(r => r.done).map(r => `${r.orderId}/${r.opId}`));
    for (const r of evidenceRefs(next)) {
      const e = r.e, key = e.copyOf || e.id;
      if (e.stored && e.stored.where === 'server') {
        const row = store.evidenceMeta(key);
        if (!row) return `${e.id} carries a server receipt but the server holds no recording under ${key}. Upload the recording again, then save.`;
        if (row.sha256 !== e.sha256) return `${e.id} is recorded with SHA-256 ${String(e.sha256).slice(0, 12)} but the server holds ${row.sha256.slice(0, 12)}. Keep the original recording and attach it again under a new ID.`;
      }
      if (r.signed && !before.has(`${r.orderId}/${r.opId}`) && e.sha256 && !(e.stored && e.stored.where === 'server')) return `${e.id} on ${r.orderId} ${r.opId} is stored only on the capturing device. Wait for the upload to the server to finish, then buy off.`;
    }
    return null;
  };

  // Stores a validated state. Closed work orders nothing live points at move to the archive table in the
  // same transaction as the document write, each validated like a live order first. Archiving happens on
  // close: the write that closes an order (or the next write after it) moves it. Returns { etag, archived }
  // or { problem } or { conflict }.
  const commitState = (state, expectedEtag, username) => {
    const r = host.MES.archiveOrders ? host.MES.archiveOrders(state) : { ok: true, archived: [] };
    if (!r.ok) return { problem: r.message };
    for (const e of r.archived) if (!host.MES.archivedOrderValid(e)) return { problem: `${e.order.id} could not move to the archive: it does not validate as a closed work order. It stays in the live workspace.` };
    const invalid = validState(state); if (invalid) return { problem: invalid };
    const rows = r.archived.map(e => { const json = JSON.stringify({ order: e.order, activity: e.activity }); return { id: e.order.id, json, sha256: sha256hex(json), schema: state.version, keys: e.keys, by: username }; });
    let etag = null, clash = null;
    store.transaction(() => {
      for (const row of rows) { if (store.archivedSha(row.id)) { clash = row.id; return false; } store.putArchived(row); }
      etag = store.putDoc(TENANT, JSON.stringify(state), expectedEtag, username);
      return etag ? true : false;
    });
    if (clash) return { problem: `${clash} is already in the archive. Reload to continue.` };
    if (!etag) return { conflict: true };
    for (const row of rows) store.audit(username, 'archive', { orderId: row.id, sha256: row.sha256 });
    return { etag, archived: rows.map(x => x.id) };
  };
  // A device that has not reloaded may still send an order the server already archived. An unchanged copy
  // is dropped; a changed one is refused, because an archived order is read-only.
  const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
  const dropArchived = doc => {
    if (!doc || !Array.isArray(doc.orders)) return null;
    const drop = [];
    for (const o of doc.orders) {
      const a = o && typeof o.id === 'string' ? store.archived(o.id) : null; if (!a) continue;
      if (canon(a.entry.order) !== canon(o)) return `${o.id} is archived and read-only. Reload to continue; open it from the archive to view or print it.`;
      drop.push(o.id);
    }
    if (drop.length) { doc.orders = doc.orders.filter(o => !drop.includes(o.id)); if (Array.isArray(doc.activity)) doc.activity = doc.activity.filter(e => !drop.includes(e.orderId)); }
    return null;
  };

  // ---- page with the server context injected ----
  const page = session => {
    const row = store.getDoc(TENANT);
    // Never embed a workspace in a page response. The app fetches it only after sign-in.
    const ctx = { api: '/api', etag: null, workspace: null, workspaceAvailable: !!row, auth: { users: store.accounts().map(publicAccount) }, account: session ? publicAccount(session.account) : null, served: new Date().toISOString() };
    const script = `<script id="flight-server">window.FLIGHT_SERVER=${JSON.stringify(ctx).replace(/</g, '\\u003c')};</script>`;
    return host.html.replace('<head>', `<head>${script}`);
  };
  const serveStatic = (req, res, rel) => {
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { send(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  };

  // ---- routes ----
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, m = req.method;
    try {
      if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(page(sessionOf(req))); return; }
      if (p.startsWith('/assets/') || p === '/demo.html' || p === '/favicon.ico') { serveStatic(req, res, p); return; }
      if (!p.startsWith('/api/')) { send(res, 404, { error: 'Not found' }); return; }
      const route = p.slice(4);

      if (route === '/health' && m === 'GET') { const row = store.getDoc(TENANT); send(res, 200, { ok: true, product: 'Flight System', accounts: store.accounts().length, workspace: !!row, etag: row ? row.etag : null, schema: row ? JSON.parse(row.json).version : null }); return; }

      // -- auth --
      if (route === '/auth/session') {
        if (m === 'POST') {
          const body = await readJson(req), username = String(body.username || '').trim().toLowerCase(), password = String(body.password || '');
          const mins = lockedFor(username); if (mins) { store.audit(username, 'signin-blocked'); send(res, 423, { error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }); return; }
          await wrapped;
          const a = store.account(username);
          const good = !!a && !a.sso && await verifyPassword(a, password);
          if (!a) await scryptAsync(password, 'no-such-account', SCRYPT);
          if (!good) { const f = noteFailure(username); store.audit(username, 'signin-failed'); send(res, 401, { error: `Incorrect username or password.${f.until > Date.now() ? ' Account locked for 5 minutes.' : ''}` }); return; }
          store.clearLockout(username);
          if (hashKind(a.hash) !== 'current') { const from = hashKind(a.hash); store.upsertAccount({ ...a, salt: '', hash: await makeHash(password) }); store.audit(username, 'password-rehash', { from }); }
          const s = store.openSession(username, clock()); store.audit(username, 'signin');
          send(res, 200, { token: s.token, issuedAt: s.issuedAt, account: publicAccount(a) }); return;
        }
        // The heartbeat reads the session without counting as activity.
        if (m === 'GET') { const s = sessionOf(req, { touch: false }); if (!s) { noSession(res, req); return; } send(res, 200, { account: publicAccount(s.account), issuedAt: s.issuedAt, idleMinutes, maxHours }); return; }
        // Sign-out ends every session the account holds.
        if (m === 'DELETE') { const t = tokenOf(req); if (t) { const s = store.session(t, { touch: false }); store.closeSession(t); if (s && s.username) { const n = store.closeSessionsOf(s.username); store.audit(s.username, 'signout', { sessionsEnded: n + 1 }); } } res.writeHead(204); res.end(); return; }
      }
      if (route === '/auth/accounts') {
        if (m === 'GET') { if (!sessionOf(req)) { noSession(res, req); return; } send(res, 200, { users: store.accounts().map(publicAccount) }); return; }
        if (m === 'PUT') {
          // Merge: the browser sends its account list; users it knows without a hash keep theirs, new or reset users bring salt and hash.
          const body = await readJson(req), incoming = Array.isArray(body.users) ? body.users : [];
          const existing = store.accounts(), session = sessionOf(req);
          const firstRun = existing.length === 0;
          if (!firstRun && !(session && manages(session.account))) { send(res, 403, { error: 'Only a Master Access or QA Manager account can manage accounts.' }); return; }
          if (firstRun && incoming.length !== 1) { send(res, 400, { error: 'The first account is created alone.' }); return; }
          await wrapped;
          // Hash before the transaction: new hashes are scrypt from the page; a legacy SHA-256 from an older page is wrapped.
          const prepared = new Map();
          for (const u of incoming) {
            const kind = hashKind(u.hash);
            if (kind === 'current') prepared.set(u, String(u.hash));
            else if (kind === 'sha256' && typeof u.salt === 'string') prepared.set(u, await wrapLegacy(String(u.hash)));
            else if (typeof u.password === 'string' && u.password.length >= 8) prepared.set(u, await makeHash(u.password));
            else if (u.hash !== undefined && u.hash !== null && u.hash !== '') { send(res, 400, { error: `Account ${String(u.username || '')}: the password hash must be scrypt with N of at least ${SCRYPT.N}, r ${SCRYPT.r}, p ${SCRYPT.p}. Set the password again from a current page.` }); return; }
          }
          const passwordChanged = [];
          store.db.exec('BEGIN');
          const refuse = (status, error) => { store.db.exec('ROLLBACK'); send(res, status, { error }); };
          for (const u of incoming) {
            const username = String(u.username || '').trim().toLowerCase();
            if (!/^[a-z0-9._-]{3,40}$/.test(username) || !String(u.displayName || '').trim()) { refuse(400, `Account ${username || '(blank)'}: username is 3 to 40 characters and the name is required.`); return; }
            const cur = existing.find(x => x.username === username);
            let roles;
            if (firstRun) roles = ['admin'];
            else if (Array.isArray(u.roles)) {
              roles = [...new Set(u.roles.map(value => String(value)))];
              if (!roles.length || roles.some(value => !host.roles.ROLES.some(r => r.key === value))) { refuse(400, `Account ${username}: choose one or more listed roles.`); return; }
            } else if (cur && u.role === cur.role) roles = accountRoles(cur);
            else if (host.roles.ROLES.some(r => r.key === u.role)) roles = [u.role];
            else roles = cur ? accountRoles(cur) : ['general'];
            const role = firstRun ? 'admin' : (roles.includes(u.role) ? u.role : (cur && roles.includes(cur.role) ? cur.role : roles[0]));
            const hasHash = prepared.has(u);
            if (!cur && !hasHash) { refuse(400, `Account ${username} needs a password.`); return; }
            const newHash = hasHash ? prepared.get(u) : null;
            store.upsertAccount({ username, displayName: String(u.displayName).trim().slice(0, 60), salt: hasHash ? (newHash.startsWith('scrypt-sha256$') ? u.salt : '') : cur.salt, hash: hasHash ? newHash : cur.hash, role, roles, createdAt: cur ? cur.createdAt : new Date().toISOString(), createdBy: cur ? cur.createdBy : (session ? session.username : username), sso: !!u.sso });
            if (cur && hasHash && cur.hash !== newHash && u.hash !== cur.hash) { store.audit(session ? session.username : username, 'password-reset', { username }); passwordChanged.push(username); }
            if (cur && (cur.role !== role || JSON.stringify(accountRoles(cur)) !== JSON.stringify(roles))) store.audit(session.username, 'role-change', { username, from: accountRoles(cur), to: roles });
            if (!cur) store.audit(session ? session.username : username, 'account-create', { username, role, roles });
          }
          // Refuse to demote the last manager.
          if (!store.accounts().some(manages)) { refuse(409, 'At least one QA Manager or Master Access account must remain.'); return; }
          store.db.exec('COMMIT');
          // A password change ends that person's sessions everywhere, except the session that made the change.
          for (const u of passwordChanged) { const ended = store.closeSessionsOf(u, session ? session.token : null); if (ended) store.audit(session ? session.username : u, 'sessions-revoked', { username: u, reason: 'password change', sessions: ended }); }
          send(res, 200, { users: store.accounts().map(publicAccount) }); return;
        }
      }

      // Everything below needs a session.
      const session = sessionOf(req);
      if (!session) { noSession(res, req); return; }

      // -- workspace --
      if (route === '/workspace' && m === 'GET') { const row = store.getDoc(TENANT); if (!row) { send(res, 404, { error: 'No workspace yet.' }); return; } res.writeHead(200, { 'Content-Type': MIME['.json'], ETag: row.etag, 'Cache-Control': 'no-store' }); res.end(row.json); return; }
      if (route === '/workspace' && m === 'PUT') {
        const doc = await readJson(req), ifMatch = req.headers['if-match'] || null;
        { const stale = dropArchived(doc); if (stale) { send(res, 409, { error: stale, code: 'ARCHIVED' }); return; } }
        const state = host.MES.upgrade(structuredClone(doc));
        if (!state) { send(res, 422, { error: (host.MES.diagnose(doc) || {}).detail || 'The document does not match the current record format.' }); return; }
        const cur = store.getDoc(TENANT);
        if (cur && !ifMatch) { send(res, 428, { error: 'Include the current workspace ETag in If-Match before saving.' }); return; }
        // Archive counters only move forward: a device that has not seen the latest archiving cannot lower them.
        if (cur && state.archive) { const was = JSON.parse(cur.json).archive; if (was) { for (const k of ['orders', 'lastOrderNumber', 'lastTicketNumber']) state.archive[k] = Math.max(Number(state.archive[k]) || 0, Number(was[k]) || 0); if (was.lastArchivedAt && (!state.archive.lastArchivedAt || was.lastArchivedAt > state.archive.lastArchivedAt)) state.archive.lastArchivedAt = was.lastArchivedAt; } }
        const problem = validState(state); if (problem) { send(res, 422, { error: problem }); return; }
        { const bad = evidenceProblem(cur ? JSON.parse(cur.json) : null, state); if (bad) { store.audit(session.username, 'evidence-refused', { message: bad }); send(res, 422, { error: bad }); return; } }
        if (cur && ifMatch && cur.etag !== ifMatch) { res.writeHead(409, { 'Content-Type': MIME['.json'], ETag: cur.etag }); res.end(JSON.stringify({ error: 'The workspace changed on another device. Reload to continue.', etag: cur.etag, current: JSON.parse(cur.json) })); return; }
        const done = commitState(state, cur ? cur.etag : null, session.username);
        if (done.problem) { send(res, 422, { error: done.problem }); return; }
        if (done.conflict) { send(res, 409, { error: 'The workspace changed on another device. Reload to continue.' }); return; }
        store.audit(session.username, 'workspace-put', { etag: done.etag });
        res.writeHead(204, { ETag: done.etag, ...(done.archived.length ? { 'X-Flight-Archived': done.archived.join(',') } : {}) }); res.end(); return;
      }
      // -- actions: run an engine function server-side with the session's authority --
      const action = /^\/workspace\/actions\/([A-Za-z0-9_.]+)$/.exec(route);
      if (action && m === 'POST') {
        const fn = host.resolve(action[1]);
        if (!fn) { send(res, 404, { error: `No action named ${action[1]}.` }); return; }
        const body = await readJson(req), args = Array.isArray(body.args) ? body.args : [];
        const { state, etag, problem, raw } = loadState();
        if (!state) { send(res, problem ? 422 : 404, { error: problem || 'No workspace yet.' }); return; }
        const ifMatch = req.headers['if-match'] || null;
        if (!ifMatch) { send(res, 428, { error: 'Include the current workspace ETag in If-Match before running an action.' }); return; }
        if (ifMatch && ifMatch !== etag) { send(res, 409, { error: 'The workspace changed on another device. Reload to continue.', etag }); return; }
        let result;
        try { result = host.withAccount(session.account, () => fn(state, ...args)); } catch (e) { send(res, 500, { error: `The action failed: ${e.message}` }); return; }
        if (!result || result.ok === false) { store.audit(session.username, 'action-refused', { action: action[1], message: result && result.message }); send(res, 403, { error: result ? result.message : 'Refused.', result }); return; }
        const invalid = validState(state); if (invalid) { send(res, 422, { error: `The action would leave the workspace invalid: ${invalid}` }); return; }
        { const bad = evidenceProblem(raw, state); if (bad) { store.audit(session.username, 'evidence-refused', { action: action[1], message: bad }); send(res, 422, { error: bad }); return; } }
        const done = commitState(state, etag, session.username);
        if (done.problem) { send(res, 422, { error: `The action would leave the workspace invalid: ${done.problem}` }); return; }
        if (done.conflict) { send(res, 409, { error: 'The workspace changed while the action ran. Try again.' }); return; }
        store.audit(session.username, 'action', { action: action[1], message: result.message });
        res.writeHead(200, { 'Content-Type': MIME['.json'], ETag: done.etag, ...(done.archived.length ? { 'X-Flight-Archived': done.archived.join(',') } : {}) }); res.end(JSON.stringify({ result, etag: done.etag, archived: done.archived })); return;
      }
      // -- evidence: bytes in SQLite, addressed by the EV ID the record carries, checked by SHA-256 --
      const ev = /^\/evidence\/(EV-[A-Za-z0-9-]+)(\/meta|\/supersede)?$/.exec(route);
      if (ev && !EVIDENCE_ID.test(ev[1])) { send(res, 400, { error: `${ev[1]} is not an evidence ID. Evidence IDs look like EV- followed by a UUID.` }); return; }
      if (ev && !ev[2] && m === 'POST') {
        if (host.rolesOf(session.account).every(role => role === 'general')) { send(res, 403, { error: 'A General User cannot upload evidence. Ask a technician or quality account to attach the recording.' }); return; }
        const mime = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (!EVIDENCE_TYPES.includes(mime)) { send(res, 415, { error: `Evidence must be a WebM, MP4 or MOV video (got ${mime || 'no type'}). Choose a video recording and upload it again.` }); return; }
        const bytes = await readBody(req);
        if (!bytes.length) { send(res, 400, { error: 'The upload is empty. Choose the recording again and upload it.' }); return; }
        const sha256 = createHash('sha256').update(bytes).digest('hex'), claimed = String(req.headers['x-evidence-sha256'] || '').toLowerCase();
        if (claimed && claimed !== sha256) { store.audit(session.username, 'evidence-hash-mismatch', { id: ev[1], claimed, sha256 }); send(res, 422, { error: `The upload arrived with SHA-256 ${sha256.slice(0, 12)} but was sent as ${claimed.slice(0, 12)}. The recording changed in transit; upload it again.` }); return; }
        const existing = store.evidenceMeta(ev[1]);
        if (existing) {
          if (existing.sha256 === sha256) { send(res, 200, existing); return; }
          send(res, 409, { error: `${ev[1]} is already stored with SHA-256 ${existing.sha256.slice(0, 12)}. Stored evidence does not change; attach the new recording under a new ID.` }); return;
        }
        let fileName = String(req.headers['x-evidence-name'] || '').slice(0, 180);
        try { fileName = decodeURIComponent(fileName); } catch {}
        fileName = fileName.slice(0, 180) || null;
        const row = store.putEvidence({ id: ev[1], sha256, size: bytes.length, mime, fileName, uploadedBy: session.username, bytes });
        store.audit(session.username, 'evidence-upload', { id: ev[1], sha256, size: bytes.length, mime });
        send(res, 201, row); return;
      }
      if (ev && ev[2] === '/meta' && m === 'GET') { const row = store.evidenceMeta(ev[1]); if (!row) { send(res, 404, { error: `The server holds no recording ${ev[1]}. Upload it from the device that captured it.` }); return; } send(res, 200, row); return; }
      if (ev && !ev[2] && m === 'GET') {
        const row = store.evidenceMeta(ev[1]); if (!row) { send(res, 404, { error: `The server holds no recording ${ev[1]}. Upload it from the device that captured it.` }); return; }
        const bytes = store.evidenceBytes(ev[1]);
        res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': bytes.length, 'X-Evidence-Sha256': row.sha256, 'Cache-Control': 'private, no-store' }); res.end(bytes); return;
      }
      if (ev && ev[2] === '/supersede' && m === 'POST') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can supersede evidence.' }); return; }
        const body = await readJson(req), by = String(body.by || ''), reason = String(body.reason || '').trim();
        const row = store.evidenceMeta(ev[1]);
        if (!row) { send(res, 404, { error: `The server holds no recording ${ev[1]}.` }); return; }
        if (row.supersededBy) { send(res, 409, { error: `${ev[1]} was already superseded by ${row.supersededBy}.` }); return; }
        if (!EVIDENCE_ID.test(by) || by === ev[1] || !store.evidenceMeta(by)) { send(res, 400, { error: 'Upload the replacement recording first, then name its EV ID in "by".' }); return; }
        if (reason.length < 3 || reason.length > 300) { send(res, 400, { error: 'Give the reason for superseding (3 to 300 characters).' }); return; }
        const out = store.supersedeEvidence(ev[1], by, reason);
        store.audit(session.username, 'evidence-supersede', { id: ev[1], by, reason });
        send(res, 200, out); return;
      }
      if (route === '/evidence/report' && m === 'GET') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read the evidence report.' }); return; }
        const { state } = loadState(), refs = evidenceRefs(state), rows = store.evidenceList();
        const named = new Set(refs.map(r => r.e.copyOf || r.e.id));
        send(res, 200, {
          stored: rows.length,
          missing: refs.filter(r => !store.evidenceMeta(r.e.copyOf || r.e.id)).map(r => ({ id: r.e.id, orderId: r.orderId, opId: r.opId, signed: r.signed })),
          unreferenced: rows.filter(r => !named.has(r.id)).map(r => ({ id: r.id, sha256: r.sha256, uploadedBy: r.uploadedBy, uploadedAt: r.uploadedAt })),
          orphansReported: store.auditRows(1000).filter(r => r.action === 'evidence-orphans').map(r => ({ at: r.at, username: r.username, detail: JSON.parse(r.detail || '{}') }))
        }); return;
      }
      if (route === '/evidence/orphans' && m === 'POST') {
        // A browser that migrated its local recordings reports what it holds that no record names.
        const body = await readJson(req), ids = (Array.isArray(body.ids) ? body.ids : []).filter(id => EVIDENCE_ID.test(String(id))).slice(0, 500);
        store.audit(session.username, 'evidence-orphans', { ids, uploaded: Number(body.uploaded) || 0 });
        send(res, 200, { recorded: ids.length }); return;
      }

      // -- archive: closed work orders out of the live document, read-only --
      if (route === '/archive' && m === 'GET') { send(res, 200, { orders: store.archiveSearch(url.searchParams.get('q') || '', Math.min(1000, Number(url.searchParams.get('limit')) || 200)), total: store.archiveCount() }); return; }
      if (route === '/trace' && m === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) { send(res, 400, { error: 'Give a serial number, lot or part number to trace.' }); return; }
        const { state } = loadState();
        // Live orders through the engine's own trace search (serial, lot, tool, WI, change), then the archive.
        const found = state && host.MES.traceSearch ? host.MES.traceSearch(state, q) : null;
        const live = found && Array.isArray(found.orders) ? found.orders.map(o => ({ ...(host.MES.traceKeys ? host.MES.traceKeys(state, host.MES.getOrder(state, o.id) || o) : { orderId: o.id }), why: o.why, source: 'live' })) : [];
        send(res, 200, { query: q, results: [...live, ...store.archiveSearch(q, 1000)] }); return;
      }
      const arc = /^\/archive\/(WO-[A-Za-z0-9-]+)(\/print|\/export)?$/.exec(route);
      if (arc && m === 'GET') {
        const a = store.archived(arc[1]);
        if (!a) { send(res, 404, { error: `${arc[1]} is not in the archive. Search by serial, lot or part to find it.` }); return; }
        if (!arc[2]) { send(res, 200, { ...a.entry, sha256: a.sha256, schema: a.schema, archivedAt: a.archivedAt, archivedBy: a.archivedBy, readOnly: true }); return; }
        if (arc[2] === '/print') {
          const mode = url.searchParams.get('mode') === 'external' ? 'external' : 'internal';
          let html; try { html = host.MESPrint.document(a.entry.order, mode); } catch (e) { send(res, 500, { error: `The record could not be printed: ${e.message}` }); return; }
          store.audit(session.username, 'archive-print', { orderId: a.id, mode });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(html); return;
        }
        // Export: the order with its signatures and history, its activity, and the bytes of its evidence.
        const evidence = {};
        for (const op of a.entry.order.operations || []) for (const e of [...(op.evidence || []), ...(op.quarantinedEvidence || [])]) {
          const key = e.copyOf || e.id, meta = store.evidenceMeta(key); if (!meta || evidence[key]) continue;
          evidence[key] = { ...meta, base64: store.evidenceBytes(key).toString('base64') };
        }
        store.audit(session.username, 'archive-export', { orderId: a.id });
        const body = JSON.stringify({ application: 'Flight System', kind: 'archived-work-order', exportedAt: new Date().toISOString(), exportedBy: session.username, sha256: a.sha256, archivedAt: a.archivedAt, archivedBy: a.archivedBy, schema: a.schema, order: a.entry.order, activity: a.entry.activity, evidence });
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Disposition': `attachment; filename="${a.id}-archive.json"`, 'Cache-Control': 'no-store' }); res.end(body); return;
      }

      // -- read-only reports the engine already computes --
      if (route === '/governance' && m === 'GET') { const { state } = loadState(); if (!state) { send(res, 404, { error: 'No workspace yet.' }); return; } const r = host.withAccount(session.account, () => host.MES.governanceExport ? host.MES.governanceExport(state) : { ok: false, message: 'Not in this build.' }); if (!r.ok) { send(res, 403, { error: r.message }); return; } store.audit(session.username, 'governance-export', {}); send(res, 200, r.document); return; }
      if (route === '/b2mml' && m === 'GET') { const { state } = loadState(); if (!state) { send(res, 404, { error: 'No workspace yet.' }); return; } send(res, 200, host.withAccount(session.account, () => host.MES.b2mml ? host.MES.b2mml(state) : { error: 'Not in this build.' })); return; }
      if (route === '/big-three' && m === 'GET') { const { state } = loadState(); if (!state) { send(res, 404, { error: 'No workspace yet.' }); return; } send(res, 200, host.withAccount(session.account, () => host.MES.bigThree(state))); return; }
      // -- lockouts: listed and cleared by a manager, one named user at a time, with a reason, audited --
      if (route === '/auth/lockouts' && m === 'GET') { if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can see lockouts.' }); return; } send(res, 200, { lockouts: store.lockouts() }); return; }
      if (route === '/auth/unlock' && m === 'POST') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can unlock an account.' }); return; }
        const body = await readJson(req), username = String(body.username || '').trim().toLowerCase(), reason = String(body.reason || '').trim();
        const r = unlockAccount(store, username, reason, session.username);
        send(res, r.status, r.body); return;
      }
      if (route === '/auth/hash-report' && m === 'GET') { if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read the password hash report.' }); return; } await wrapped; send(res, 200, { params: SCRYPT, ...hashReport() }); return; }
      if (route === '/audit' && m === 'GET') { if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read the audit log.' }); return; } send(res, 200, { rows: store.auditRows(Number(url.searchParams.get('limit')) || 200) }); return; }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e.status === 413) { send(res, 413, { error: e.message, limit: MAX_REQUEST_BYTES }, { Connection: 'close' }); return; }
      if (e.status === 400) { send(res, 400, { error: e.message }); return; }
      log('error', m, p, e.message);
      send(res, 500, { error: e.message });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.store = store; server.host = host; server.ready = wrapped;
  // Bind address: behind a reverse proxy, bind 127.0.0.1 so only that proxy can connect.
  server.listenAsync = (port, host = options.host || process.env.FLIGHT_HOST || DEFAULT_HOST) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); }); });
  server.closeAsync = () => new Promise(resolve => server.close(() => { store.close(); resolve(); }));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const backupTo = arg('backup', null), unlockUser = arg('unlock', null);
  if (unlockUser) {
    // node server/server.mjs --db data/datum.sqlite --unlock <username> --reason "..." --by <your name>
    const store = openDb(arg('db', process.env.FLIGHT_DB || path.join(ROOT, 'data', 'flight.sqlite')));
    const by = String(arg('by', '') || '').trim();
    const r = by.length < 2 ? { status: 400, body: { error: 'Say who is unlocking with --by <name>. It goes in the audit trail.' } } : unlockAccount(store, String(unlockUser).trim().toLowerCase(), String(arg('reason', '') || '').trim(), `cli:${by}`);
    store.close();
    if (r.status === 200) console.log(`Unlocked ${r.body.username}. Recorded in the audit trail.`); else { console.error(r.body.error); process.exit(1); }
  } else if (backupTo) {
    // Online backup of the whole database (record, accounts, audit, evidence) while the service runs.
    const store = openDb(arg('db', process.env.FLIGHT_DB || path.join(ROOT, 'data', 'flight.sqlite')));
    store.backup(backupTo).then(pages => { console.log(`Backup written to ${backupTo} (${pages} pages, ${store.evidenceList().length} evidence items).`); store.close(); }, e => { console.error(`Backup failed: ${e.message}`); process.exit(1); });
  } else {
  const host = arg('host', process.env.FLIGHT_HOST || DEFAULT_HOST);
  const server = createServer({ dbPath: arg('db', process.env.FLIGHT_DB || path.join(ROOT, 'data', 'flight.sqlite')), host });
  server.listenAsync(Number(arg('port', process.env.PORT || 8080)), host).then(port => {
    const a = server.address();
    console.log(`Flight System server listening on ${a.address}:${port} (${a.address === '127.0.0.1' || a.address === '::1' ? 'loopback only: this machine and its reverse proxy' : 'all interfaces: bind 127.0.0.1 with --host behind a reverse proxy'}) (db ${server.store.db.location ? server.store.db.location() : 'sqlite'})`);
  }, e => { console.error(`Flight System server could not listen on ${host}: ${e.message}. Check --host names an address on this machine and the port is free.`); process.exit(1); });
  }
}
