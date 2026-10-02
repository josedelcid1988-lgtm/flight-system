// Flight System server: serves the app, keeps one shared workspace in SQLite or PostgreSQL,
// signs people in with one active session each, and runs the same MES rules as the browser.
// SQLite uses node:sqlite (Node 22.13+); PostgreSQL uses the locked node-postgres pool.
//
//   node server/server.mjs --port 8080 --db data/flight.sqlite
//
// See docs/BACKEND_CONTRACT.md for the interface.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { openDb, openDbReadOnly } from './db.mjs';
import { openPostgres, openPostgresReadOnly } from './db-postgres.mjs';
import { scanArchiveProto } from './archive-proto-scan.mjs';
import { createHost } from './mes-host.mjs';
import { evidenceIdsInWorkspace } from './evidence-refs.mjs';
import { stamp, verify } from '../tools/stamp-build.mjs';

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
const publicAccount = a => ({ username: a.username, displayName: a.displayName, role: a.role, roles: Array.isArray(a.roles) && a.roles.length ? [...a.roles] : [a.role], extraRoles: Array.isArray(a.extraRoles) ? [...a.extraRoles] : [], roleTraining: a.roleTraining && typeof a.roleTraining === 'object' && !Array.isArray(a.roleTraining) ? a.roleTraining : {}, grants: a.grants && typeof a.grants === 'object' && !Array.isArray(a.grants) ? a.grants : {}, grantHistory: Array.isArray(a.grantHistory) ? a.grantHistory : [], supportAccess: a.supportAccess === true, createdAt: a.createdAt, createdBy: a.createdBy, sso: a.sso });
const LOCK_AFTER = 5, LOCK_MS = 5 * 60 * 1000;
export const TRAINING_GATED_ROLE_CAPS = new Set(['inspect-steps', 'mrb-quality', 'mrb-me', 'mrb-eng', 'mrb-cert']);
// The one request body limit, in bytes. It is sized to the largest evidence upload the engine allows
// (MES.MAX_EVIDENCE_BYTES, sent as the raw body with no encoding overhead), and it also caps the workspace
// document. The nginx sample and the IT specification use the same number; tests/test_limits.mjs checks it.
export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_REQUEST_MIB = MAX_REQUEST_BYTES / 1048576;
const tooLarge = () => Object.assign(new Error(`The request is larger than the ${MAX_REQUEST_MIB} MiB limit (${MAX_REQUEST_BYTES} bytes). Send a smaller document or recording: remove large inline files, or trim or re-encode the video.`), { status: 413 });
const EVIDENCE_TYPES = ['video/webm', 'video/mp4', 'video/quicktime'];
const ORPHAN_AUDIT_IDS = 80;
// A multiple of 3, so each chunk base64-encodes on its own without padding in the middle of the stream.
const EXPORT_CHUNK_BYTES = 3 * 1024 * 1024;
// Audit details are stored capped at 4,000 characters; an older entry cut mid-string is reported as truncated, never thrown.
const auditDetail = text => { try { return JSON.parse(text || '{}'); } catch { return { truncated: true }; } };
const EVIDENCE_ID = /^EV-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_RECORD_TYPES = Object.freeze(['work-order', 'fair', '8130-9', 'nc-idr', 'car', 'mrb', 'stamp', 'training', 'pfmea']);
const GRANTED_AUTHORITY_CAPS = Object.freeze(['conformity', 'aqi-sign']);
// Every recording the document names, with where it sits and whether its operation is signed.
const evidenceRefs = state => (state && Array.isArray(state.orders) ? state.orders : []).flatMap(o => (o.operations || []).flatMap(op => (op.evidence || []).map(e => ({ orderId: o.id, opId: op.id, done: !!op.done, signed: !!(op.done && op.buyoff && (op.buyoff.evidenceIds || []).includes(e.id)), e }))));
export function finalizedRecords(state) {
  const out = new Map(), add = (type, id, record) => { if (id && record) out.set(`${type}\0${id}`, { recordType: type, recordId: String(id), record }); };
  for (const order of state?.orders || []) {
    if (order.status === 'Closed') add('work-order', order.id, order);
    if (order.fair?.status === 'Approved' && order.fair.approved?.manifest?.hash) add('fair', order.fair.id || `FAIR-${order.id}`, { orderId: order.id, fair: order.fair });
    for (const packageRecord of order.conformity || []) if (packageRecord.status === 'AQI signed' && packageRecord.aqi?.manifest?.hash) add('8130-9', `${order.id}-${packageRecord.serial}`, { orderId: order.id, package: packageRecord });
    for (const ticket of order.tickets || []) if (ticket.status === 'Resolved' && ticket.dispo) add('nc-idr', ticket.id, { orderId: order.id, ticket });
  }
  const maneuver = state?.maneuver || {};
  for (const ticket of [...(maneuver.ncs || []), ...(Array.isArray(maneuver.__ticketsV2) ? maneuver.__ticketsV2 : [])]) if (ticket.status === 'Resolved' && ticket.dispo) add('nc-idr', ticket.id, ticket);
  for (const car of maneuver.cars || []) if (car.status === 'Closed' && car.effectiveness?.result === 'Effective') add('car', car.id, car);
  for (const mrb of maneuver.mrb || []) if (['Approved', 'Rejected'].includes(mrb.status) && mrb.decision && (mrb.seats || []).length > 0 && (mrb.votes || []).length === mrb.seats.length && (mrb.seats || []).every(seat => (mrb.votes || []).some(vote => vote.seat === seat))) add('mrb', mrb.id, mrb);
  for (const stamp of state?.stamps || []) if (stamp.status === 'Active' && (stamp.history || []).some(row => /\bissued\b/i.test(row.action || ''))) add('stamp', stamp.id, stamp);
  // Flight's current trainingRecords are qualification/expiry entries, not signed training
  // completions. Exporting them at creation would bypass the trainer-signature final step. The
  // signed completion model added in the training phase is recognized here when it carries a
  // trainer signature manifest.
  for (const training of state?.trainingRecords || []) if (training.trainerSignature?.manifest || training.signature?.manifest) add('training', training.id, training);
  for (const pfmea of maneuver.pfmeas || []) if (pfmea.safety?.decision === 'Approve' && pfmea.safety?.manifest) add('pfmea', pfmea.id, pfmea);
  return out;
}

// Clears one named user's lockout with a reason and an audit row. Used by the API and the CLI.
export async function unlockAccount(store, username, reason, by) {
  if (!username) return { status: 400, body: { error: 'Name the account to unlock.' } };
  if (reason.length < 3 || reason.length > 300) return { status: 400, body: { error: 'Give the reason for unlocking (3 to 300 characters), for example how the person was verified.' } };
  const cur = await store.lockout(username);
  if (!(cur.until > Date.now()) && !cur.fails) return { status: 404, body: { error: `${username} is not locked. Nothing to unlock.` } };
  await store.clearLockout(username);
  await store.audit(by, 'unlock', { username, reason, wasLockedUntil: cur.until ? new Date(cur.until).toISOString() : null });
  return { status: 200, body: { username, unlocked: true, by, reason } };
}

// Bind address when none is named: loopback only, so a server started with the defaults is reachable from this
// machine and its reverse proxy, never from the network. --host, FLIGHT_HOST or options.host binds wider.
export const DEFAULT_HOST = '127.0.0.1';
// Session lifetime: minutes without activity and hours since sign-in. Options, then environment, then defaults.
export const SESSION_DEFAULTS = Object.freeze({ idleMinutes: 30, maxHours: 12 });
const positive = (...values) => { for (const v of values) { const n = Number(v); if (v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0) return n; } return null; };

// HTTPS record exports may only send a credential the server operator bound to that destination.
// FLIGHT_EXPORT_CREDENTIALS is JSON: {"FLIGHT_EXPORT_TOKEN": ["https://records.example.com"]}. Request data never
// names an arbitrary environment variable, so no other server secret can be sent anywhere.
export function parseExportCredentials(value) {
  if (value === undefined || value === null || value === '') return {};
  let raw = value;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { throw new Error('FLIGHT_EXPORT_CREDENTIALS must be JSON such as {"FLIGHT_EXPORT_TOKEN": ["https://records.example.com"]}.'); } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FLIGHT_EXPORT_CREDENTIALS must map each server setting name to a list of HTTPS origins.');
  const out = {};
  for (const [name, origins] of Object.entries(raw)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || !Array.isArray(origins) || !origins.length) throw new Error(`FLIGHT_EXPORT_CREDENTIALS: ${name} needs an upper-case setting name and at least one HTTPS origin.`);
    out[name] = origins.map(origin => {
      let u; try { u = new URL(String(origin)); } catch { u = null; }
      if (!u || u.protocol !== 'https:' || u.username || u.password) throw new Error(`FLIGHT_EXPORT_CREDENTIALS: ${name} lists ${origin}, which is not an https origin.`);
      return u.origin;
    });
  }
  return out;
}

// The model adapter names the server setting that holds its key. Only settings the operator lists in
// FLIGHT_MODEL_ADAPTER_SETTINGS (comma-separated) can be named, so a caller cannot use the check to learn which
// other environment variables exist on the server.
export function parseModelAdapterSettings(value) {
  if (value === undefined || value === null || value === '') return [];
  const names = (Array.isArray(value) ? value : String(value).split(',')).map(name => String(name).trim()).filter(Boolean);
  for (const name of names) if (!/^[A-Z_][A-Z0-9_]{1,63}$/.test(name)) throw new Error(`FLIGHT_MODEL_ADAPTER_SETTINGS: ${name} is not an upper-case setting name.`);
  return names;
}

// The committed index.html carries the hash placeholder "unstamped"; a release zip carries the real stamp.
// A checkout is stamped in memory at start, with the same tool and result as a release, so the page served
// and every record it writes carry the build's SHA-256. A stamped file is served as it is only when its stamp
// verifies: a file edited after stamping would record a SHA-256 that does not match the code being served.
export function servedIndex(indexPath) {
  const html = fs.readFileSync(indexPath, 'utf8'), v = verify(html);
  if (v.stamped === 'unstamped') return stamp(html, v.build);
  if (!v.ok) throw new Error(`${indexPath} carries SHA-256 ${v.stamped} but its content computes ${v.actual}: it was changed after stamping. Deploy the release zip again, or run node tools/stamp-build.mjs --clear to serve this checkout.`);
  return html;
}

export function createServer(options = {}) {
  const indexPath = options.indexPath || path.join(ROOT, 'index.html');
  const dbPath = options.dbPath || process.env.FLIGHT_DB || path.join(ROOT, 'data', 'flight.sqlite');
  const databaseUrl = options.databaseUrl !== undefined ? options.databaseUrl : process.env.FLIGHT_DATABASE_URL || null;
  if (!options.store && !databaseUrl && dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let store = options.store || (databaseUrl ? null : openDb(dbPath));
  let server;
  const storeReady = store ? Promise.resolve(store) : openPostgres(databaseUrl).then(value => { store = value; if (server) server.store = value; return value; });
  const idleMinutes = positive(options.sessionIdleMinutes, process.env.FLIGHT_SESSION_IDLE_MINUTES) || SESSION_DEFAULTS.idleMinutes;
  const maxHours = positive(options.sessionMaxHours, process.env.FLIGHT_SESSION_MAX_HOURS) || SESSION_DEFAULTS.maxHours;
  const lifetime = { idleMs: idleMinutes * 60000, maxMs: maxHours * 3600000 };
  const clock = options.clock || (() => Date.now());
  const host = createHost(indexPath, servedIndex(indexPath));
  // Expanded roles, named grants and new trained accounts all cite a training: it must be an active catalog
  // entry and the person must hold a current record of it on the shared workspace.
  const trainingQualifies = (state, username, code) => !!state && !!code && host.MES.trainingCatalog(state).some(item => item.status === 'Active' && item.code === code) && host.MES.trainingCurrentFor(state, username, code).ok;
  // demo.html relaxes separation of duties, PINs and the stamp gate. It is a training page, not part of the
  // production server: served only when the operator asks (options.serveDemo, FLIGHT_SERVE_DEMO=1 or --serve-demo).
  const serveDemo = options.serveDemo !== undefined ? options.serveDemo === true : process.env.FLIGHT_SERVE_DEMO === '1';
  const jira = options.jira || {};
  const jiraConfig = {
    baseUrl: String(jira.baseUrl || process.env.FLIGHT_JIRA_BASE_URL || '').replace(/\/$/, ''),
    email: String(jira.email || process.env.FLIGHT_JIRA_EMAIL || ''),
    apiToken: String(jira.apiToken || process.env.FLIGHT_JIRA_API_TOKEN || '')
  };
  let jiraConfigured = false;
  try { const u = new URL(jiraConfig.baseUrl); jiraConfigured = !!(jiraConfig.email && jiraConfig.apiToken && u.protocol === 'https:' && /(^|\.)atlassian\.net$/i.test(u.hostname) && !u.username && !u.password && !u.search && !u.hash && (!u.pathname || u.pathname === '/')); } catch {}
  const jiraFetch = options.jiraFetch || globalThis.fetch;
  if (host.MES.MAX_EVIDENCE_BYTES && host.MES.MAX_EVIDENCE_BYTES > MAX_REQUEST_BYTES) throw new Error(`index.html allows ${host.MES.MAX_EVIDENCE_BYTES} byte recordings but the server's request limit is ${MAX_REQUEST_BYTES}. Raise MAX_REQUEST_BYTES and the proxy's client_max_body_size together.`);
  const log = options.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const warn = options.quiet ? () => {} : (...a) => console.warn(new Date().toISOString(), ...a);
  const modelAdapterSettings = parseModelAdapterSettings(options.modelAdapterSettings !== undefined ? options.modelAdapterSettings : process.env.FLIGHT_MODEL_ADAPTER_SETTINGS);
  const exportCredentials = parseExportCredentials(options.exportCredentials !== undefined ? options.exportCredentials : process.env.FLIGHT_EXPORT_CREDENTIALS);
  const exportTargetAllowed = (tokenSetting, destination) => { let origin = null; try { origin = new URL(String(destination)).origin; } catch {} return !!origin && !!tokenSetting && Object.hasOwn(exportCredentials, tokenSetting) && exportCredentials[tokenSetting].includes(origin); };
  // The first account becomes Master Access, so creating it needs a code only the person running the server can
  // see: FLIGHT_BOOTSTRAP_TOKEN when set, otherwise a random code printed in the server console at startup.
  const setupCode = String(options.setupCode !== undefined ? options.setupCode : process.env.FLIGHT_BOOTSTRAP_TOKEN || '').trim() || randomBytes(15).toString('base64url');
  const setupCodeMatches = value => { const given = String(value || '').trim(); if (!given) return false; const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(setupCode).digest(); return timingSafeEqual(a, b); };
  const hashReport = async () => { const out = { current: 0, weak: 0, wrapped: 0, sha256: 0, unknown: 0, sso: 0 }; for (const a of await store.accounts()) { if (a.sso) out.sso += 1; else out[hashKind(a.hash)] += 1; } return out; };
  // No SHA-256-only password hash is left at rest: each is wrapped in scrypt at startup (and on receipt),
  // and replaced with a plain scrypt hash of the password at that person's next sign-in.
  const wrapped = (async () => {
    await storeReady;
    let n = 0;
    for (const a of await store.accounts()) if (!a.sso && hashKind(a.hash) === 'sha256') { await store.upsertAccount({ ...a, hash: await wrapLegacy(a.hash) }); n += 1; }
    if (n) await store.audit(null, 'password-wrap', { accounts: n });
    const r = await hashReport();
    log(`password hashes: ${r.current} current scrypt, ${r.wrapped} legacy wrapped in scrypt (replaced at next sign-in), ${r.weak} below current parameters, ${r.sha256} SHA-256 only`);
    return r;
  })();

  // ---- helpers ----
  const send = (res, status, body, headers = {}) => { const json = body === undefined ? '' : JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(json); };
  // An unexpected failure is logged here with its detail and a reference. The caller gets the reference and a
  // plain next step, never the error text: it can name files, SQL, or engine internals.
  const internalError = (res, req, error, what = 'The server could not complete this request.') => {
    const reference = randomBytes(6).toString('hex').toUpperCase();
    log('error', reference, req.method, req.url, error && error.stack ? error.stack : String(error));
    send(res, 500, { error: `${what} Try again; if it keeps failing, give your administrator reference ${reference}.`, reference });
  };
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
  const sessionOf = async (req, { touch = true } = {}) => {
    const s = await store.session(tokenOf(req), { ...lifetime, touch, at: clock() });
    if (!s) return null;
    if (s.expired) { req.sessionExpired = s.expired; await store.audit(s.username, 'session-expired', { reason: s.expired }); return null; }
    const account = await store.account(s.username); return account ? { ...s, account } : null;
  };
  const noSession = (res, req) => req.sessionExpired
    ? send(res, 401, { error: req.sessionExpired === 'idle' ? `Your session ended after ${idleMinutes} minutes without activity. Sign in again to continue; what you typed on this page is kept.` : `Your session reached its ${maxHours}-hour limit. Sign in again to continue; what you typed on this page is kept.`, code: 'SESSION_EXPIRED', reason: req.sessionExpired })
    : send(res, 401, { error: 'Signed in elsewhere or session expired.', code: 'SESSION_REVOKED' });
  const accountRoles = account => [...new Set([...(Array.isArray(account && account.roles) && account.roles.length ? account.roles : [host.roleOf(account)]), ...(Array.isArray(account && account.extraRoles) ? account.extraRoles : [])])];
  const manages = account => accountRoles(account).some(role => ['qm', 'admin'].includes(role));
  const supervises = account => !manages(account) && accountRoles(account).includes('qs');
  // Lockouts are kept in SQLite, so a restart does not clear a brute-force lockout.
  const lockedFor = async username => { const f = await store.lockout(username); return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; };
  const noteFailure = async username => { const r = await store.noteFailedSignin(username, LOCK_AFTER, Date.now() + LOCK_MS); if (r.locked) await store.audit(username, 'lockout', { minutes: LOCK_MS / 60000 }); return { n: r.fails, until: r.until }; };

  // The document as the engine sees it: upgraded, blockers synced, validated. Returns the state or a problem.
  // registers names a stored stamp register or planned-order list that exists but is damaged. It is read from the
  // stored copy before any engine code runs, because some actions run the initializer themselves (issueStamp calls
  // ensureStamps; addPlannedOrder replaces a value that is not a list), and the write gate would only see the
  // replacement (Codex review of #220). A write path refuses when it is set; reads are unaffected.
  const registerProblem = state => host.MES.stampRegisterProblem?.(state) || host.FlightPlan.plannedOrdersProblem?.(state) || null;
  // A damaged planned-order value can make MES.upgrade itself throw (planning blockers read it as a list); that is
  // reported as the same plain register problem, not an unexpected failure (Codex review of #220).
  const loadState = async () => { const row = await store.getDoc(TENANT); if (!row) return { state: null, etag: null }; const parsed = JSON.parse(row.json); let state; try { state = host.MES.upgrade(structuredClone(parsed)); } catch (e) { const damaged = registerProblem(parsed); if (damaged) return { state: null, etag: row.etag, raw: parsed, registers: damaged, problem: damaged }; throw e; } return { state, etag: row.etag, raw: parsed, registers: state ? registerProblem(state) : null, problem: state ? null : (host.MES.diagnose(parsed) || {}).detail || 'The document does not match the current record format.' }; };
  // Derived-state convergence: the browser engine recomputes these on boot, refresh and render
  // without ever queuing them as commands (planning blockers, assignment auto-close, master WI /
  // plan / maneuver defaults). The server runs them here, inside every commit path, before
  // validation, so the shared record always leaves with the same derived state any device would
  // compute, and a convergence defect fails the write instead of persisting. A stamp register or planned
  // order list that exists but is damaged is refused before its initializer runs: the initializer would replace
  // the whole list with seed records, and MES.validate covers neither, so the loss would commit (Codex #17).
  // Returns a problem, or null.
  const convergeDerivedState = state => {
    const stamps = host.MES.stampRegisterProblem?.(state); if (stamps) return stamps;
    host.MES.ensureMasterWIs?.(state);
    const plan = host.FlightPlan.plannedOrdersProblem?.(state); if (plan) return plan;
    host.FlightPlan.ensure?.(state);
    host.FlightManeuver.ensure?.(state);
    host.MES.syncAssignments?.(state);
    host.MES.syncBlockers?.(state);
    return null;
  };
  const validState = state => { const unconverged = convergeDerivedState(state); if (unconverged) return unconverged; if (Array.isArray(state.orders) && state.orders.filter(order => order.status !== 'Closed').length > 1000) return 'The workspace exceeds the 1,000 open work order limit. Close or archive work before adding more orders.'; if (!host.MES.validate(state)) return (host.MES.diagnose(state) || {}).detail || 'The workspace is invalid.'; const manifested = host.MES.verifyManifests(state); if (!manifested.ok) { const f = manifested.failures[0] || {}; return `A signed record failed verification at ${f.where || 'an unknown record'}: ${f.reason || 'invalid manifest'}.`; } return null; };

  // Evidence integrity on every write, beside the engine's validation. The engine refuses a buy-off
  // without a stored copy and hash and refuses edits to signed evidence (MES.evidenceChanges); the
  // server adds what only it can know: that a server receipt matches bytes it holds, and that a
  // newly signed buy-off names recordings the server stored, not ones kept on one device.
  // A reference is also authority: once a record names a recording, every signed-in account may read it. So a write
  // that adds a new reference (id or copyOf) to a recording the server holds must come from the account that uploaded
  // it, or from a QA Manager or Master Access account. A recording the workspace already names stays usable as before.
  const evidenceProblem = async (prev, next, session) => {
    const changed = host.MES.evidenceChanges ? host.MES.evidenceChanges(prev, next) : null;
    if (changed) return changed;
    if (session && !manages(session.account)) {
      const named = evidenceIdsInWorkspace(prev);
      for (const key of evidenceIdsInWorkspace(next)) {
        if (named.has(key)) continue;
        const row = await store.evidenceMeta(key);
        // The browser uploads a recording before it saves the reference, so an initialized workspace never needs to name
        // one the server does not hold yet. Refusing it closes the window where a reference saved ahead of someone
        // else's in-flight upload would authorize everyone once that upload lands. The first workspace save (prev null)
        // may carry device-only recordings from a browser workspace being imported, so it keeps the stored-row rule.
        if (!row && prev) return `${key} is not on the server yet. Upload the recording from the device that captured it, then attach it.`;
        if (row && row.uploadedBy !== session.username) return `${key} was uploaded by another account. Only the account that uploaded a recording, a QA Manager, or a Master Access account can attach it to a record. Ask the uploader to attach it.`;
      }
    }
    const before = new Set(evidenceRefs(prev).filter(r => r.done).map(r => `${r.orderId}/${r.opId}`));
    for (const r of evidenceRefs(next)) {
      const e = r.e, key = e.copyOf || e.id;
      if (e.stored && e.stored.where === 'server') {
        const row = await store.evidenceMeta(key);
        if (!row) return `${e.id} carries a server receipt but the server holds no recording under ${key}. Upload the recording again, then save.`;
        if (row.sha256 !== e.sha256) return `${e.id} is recorded with SHA-256 ${String(e.sha256).slice(0, 12)} but the server holds ${row.sha256.slice(0, 12)}. Keep the original recording and attach it again under a new ID.`;
      }
      if (r.signed && !before.has(`${r.orderId}/${r.opId}`) && e.sha256 && !(e.stored && e.stored.where === 'server')) return `${e.id} on ${r.orderId} ${r.opId} is stored only on the capturing device. Wait for the upload to the server to finish, then buy off.`;
    }
    return null;
  };

  // Evidence is read under the authority of the record that names it. Every signed-in account reads the live
  // workspace and the archive, so a recording a live operation or an archived order names (directly, or as the
  // stored copy behind another ID) is readable by any session. A recording no record names yet is readable only
  // by the account that uploaded it and by a QA Manager or Master Access account.
  // The set of evidence IDs the live workspace names (each ID and each copyOf), built once per stored document.
  // A cached set is reused only when the stored row has the same ETag and byte-identical JSON text, so a write by
  // any path (a record action, a snapshot, another server process on the same database) forces a rebuild before
  // the next read decision. The string comparison costs far less than JSON.parse; if in doubt, the set is rebuilt.
  const evidenceIdsIn = evidenceIdsInWorkspace;
  let namedEvidenceCache = null;
  const liveEvidenceIds = async () => {
    const doc = await store.getDoc(TENANT);
    if (!doc) { namedEvidenceCache = null; return new Set(); }
    if (namedEvidenceCache && namedEvidenceCache.etag === doc.etag && namedEvidenceCache.json === doc.json) return namedEvidenceCache.ids;
    let parsed = null; try { parsed = JSON.parse(doc.json); } catch { parsed = null; }
    namedEvidenceCache = { etag: doc.etag, json: doc.json, ids: evidenceIdsIn(parsed) };
    return namedEvidenceCache.ids;
  };
  const mayReadEvidence = async (session, row) => {
    if (manages(session.account) || row.uploadedBy === session.username) return true;
    if ((await liveEvidenceIds()).has(row.id)) return true;
    return !!await store.archiveNamesEvidence(row.id);
  };
  const refuseEvidenceRead = async (res, session, row) => {
    await store.audit(session.username, 'evidence-read-refused', { id: row.id });
    send(res, 403, { error: `${row.id} is not attached to a record yet. Until it is saved on an operation, only the account that uploaded it, a QA Manager, or a Master Access account can open it. Ask the uploader to save it on its operation, or ask a QA Manager or Master Access account to open it.` });
  };

  // Whether the calibration archive table holds exactly the entries the workspace's signed archive records name (#130):
  // each stored row matches the SHA-256 it was stored with, and MES.calibrationArchiveHeldProblem checks its record id,
  // summary and the record digest. Run when a workspace initializes the server and when the server starts on a stored
  // workspace, so history left from another workspace or brought back by a partial restore is refused, not served.
  // Returns a plain refusal or null.
  const CALIBRATION_ARCHIVE_SCAN_PAGE = 1000;
  const calibrationArchiveProblem = async (state, from = store) => {
    const named = (state && state.calibrationLogHead && Array.isArray(state.calibrationLogHead.archived) ? state.calibrationLogHead.archived : []).flatMap(record => (record && record.manifest && record.manifest.subject && Array.isArray(record.manifest.subject.entries) ? record.manifest.subject.entries : []).map(summary => summary && summary.id));
    // Read the whole table in pages of CALIBRATION_ARCHIVE_SCAN_PAGE rows, not one query per entry, then check in memory.
    const rows = new Map();
    for (let after = ''; ;) {
      const page = await from.calibrationArchiveRows(after, CALIBRATION_ARCHIVE_SCAN_PAGE);
      for (const row of page) rows.set(row.id, row);
      if (page.length < CALIBRATION_ARCHIVE_SCAN_PAGE) break;
      after = page[page.length - 1].id;
    }
    const held = [];
    for (const id of named) {
      const row = rows.get(id);
      if (!row) continue;
      if (sha256hex(JSON.stringify(row.entry)) !== row.sha256) return `Archived calibration entry ${id} on this server no longer matches the SHA-256 it was stored with. Restore the server database from a good backup. Nothing was saved.`;
      // The indexed tool column is what the listing filters on, so it must be the signed entry's tool.
      if (row.tag !== (row.entry && row.entry.tag)) return `Archived calibration entry ${id} on this server is filed under tool ${row.tag}, but the signed entry is for ${row.entry && row.entry.tag}. Restore the server database from a good backup. Nothing was saved.`;
      held.push({ id, recordId: row.recordId, entry: row.entry });
    }
    const heldProblem = host.MES.calibrationArchiveHeldProblem(state, held);
    if (heldProblem) return heldProblem;
    // Every row in the table must be one the workspace's archive records name: rows from elsewhere are not this history.
    const namedIds = new Set(named), unnamed = [...rows.keys()].filter(id => !namedIds.has(id));
    if (unnamed.length) return `This server's calibration archive holds ${unnamed.length} entr${unnamed.length === 1 ? 'y' : 'ies'} that no archive record in the workspace names, starting with ${unnamed.slice(0, 5).join(', ')}. They belong to other history. Restore the server database that holds this workspace's calibration archive. Nothing was saved.`;
    return null;
  };
  // At startup: a stored workspace that names archived calibration entries must find them intact, or the server refuses
  // to start, as it does for a tampered audit chain.
  const verifyStoredCalibrationArchive = async () => {
    // Read the workspace and the archive in one transaction under the workspace lock, so a write another process
    // commits between the two reads cannot make a consistent database look inconsistent. Nothing is written.
    let problem = null;
    await store.transaction(async tx => {
      await tx.lockDoc(TENANT);
      const row = await tx.getDoc(TENANT);
      if (!row) return false;
      let doc = null; try { doc = JSON.parse(row.json); } catch { return false; }
      problem = await calibrationArchiveProblem(doc, tx);
      return false;
    });
    if (problem) { log('calibration archive check failed:', problem); throw new Error(`The calibration archive does not match the stored workspace, so the server did not start. ${problem}`); }
  };
  // Stores a validated state. Closed work orders nothing live points at move to the archive table in the
  // same transaction as the document write, each validated like a live order first. Archiving happens on
  // close: the write that closes an order (or the next write after it) moves it. Returns { etag, archived }
  // or { problem } or { conflict }. The audit rows for the change (archive rows, and the caller's own entries,
  // whose detail may be a function of the new ETag) are written in the same transaction: a change is never kept
  // without its audit row, and an audit row never names a change that was rolled back.
  const commitState = async (state, expectedEtag, username, audits = []) => {
    const exportState = structuredClone(state);
    const beforeRow = await store.getDoc(TENANT);
    // An initialization (expectedEtag null) that finds a stored workspace lost the race to another request: report the
    // conflict before any comparison against that workspace, so the loser never reads as a calibration or archive refusal.
    if (expectedEtag === null && beforeRow) return { conflict: true };
    const beforeState = beforeRow ? JSON.parse(beforeRow.json) : null;
    const r = host.MES.archiveOrders ? host.MES.archiveOrders(state) : { ok: true, archived: [] };
    if (!r.ok) return { problem: r.message };
    for (const e of r.archived) if (!host.MES.archivedOrderValid(e)) return { problem: `${e.order.id} could not move to the archive: it does not validate as a closed work order. It stays in the live workspace.` };
    const invalid = validState(state); if (invalid) return { problem: invalid };
    // The calibration log is append-only against the stored copy: a write that drops, changes or reorders an entry
    // the server holds is refused, whatever the head in the new document says (#116, #117).
    { const changed = host.MES.calibrationLogChanges(beforeState, state); if (changed) return { problem: changed }; }
    // Superseded calibration entries an archive record in this write moved out of the live log (#130) go to the
    // calibration archive exactly as the stored log held them, in the same transaction as the document write.
    const calibrationRows = host.MES.calibrationArchivedEntries(beforeState, state).map(({ entry, recordId }) => { const json = JSON.stringify(entry); return { id: entry.id, tag: entry.tag, recordId, json, sha256: sha256hex(json), by: username }; });
    const rows = r.archived.map(e => { const json = JSON.stringify({ order: e.order, activity: e.activity }); return { id: e.order.id, json, sha256: sha256hex(json), schema: state.version, keys: e.keys, by: username }; });
    let etag = null, clash = null, initProblem = null, queuedExports = [];
    await store.transaction(async tx => {
      // Take the workspace lock before probing the archive tables, so concurrent writers wait here and the later one sees
      // the rows the earlier one stored (a clash or a changed ETag) instead of failing on a duplicate insert.
      await tx.lockDoc(TENANT);
      if (expectedEtag === null && await tx.getDoc(TENANT)) return false;
      // A workspace that already names archived entries can only start on a server that holds exactly those entries,
      // checked under the lock so the archive cannot change between this check and the write.
      if (!beforeState) { initProblem = await calibrationArchiveProblem(state, tx); if (initProblem) return false; }
      for (const row of rows) { if (await tx.archivedSha(row.id)) { clash = row.id; return false; } await tx.putArchived(row); }
      for (const row of calibrationRows) { if (await tx.calibrationArchived(row.id)) { clash = row.id; return false; } await tx.putCalibrationArchived(row); }
      etag = await tx.putDoc(TENANT, JSON.stringify(state), expectedEtag, username);
      if (!etag) return false;
      queuedExports = await queueNewFinalRecords(beforeState, exportState, username, tx);
      for (const row of rows) await tx.audit(username, 'archive', { orderId: row.id, sha256: row.sha256 });
      // One bounded row per archive record: the audit detail is capped at 4,000 characters, so it carries the record id, the count, the signed digest and a sample of entry ids, not every entry.
      for (const recordId of new Set(calibrationRows.map(row => row.recordId))) { const moved = calibrationRows.filter(row => row.recordId === recordId), record = state.calibrationLogHead.archived.find(x => x.id === recordId); await tx.audit(username, 'calibration-archive', { recordId, count: moved.length, digest: record.manifest.subject.digest, entries: moved.slice(0, 20).map(row => row.id), ...(moved.length > 20 ? { lastEntry: moved[moved.length - 1].id } : {}) }); }
      for (const entry of audits) await tx.audit(username, entry.action, typeof entry.detail === 'function' ? entry.detail(etag) : entry.detail);
      return true;
    });
    if (initProblem) return { problem: initProblem };
    if (clash) return { problem: `${clash} is already in the archive. Reload to continue.` };
    if (!etag) return { conflict: true };
    namedEvidenceCache = null;
    if (queuedExports.length) void drainExports();
    return { etag, archived: rows.map(x => x.id) };
  };
  // A device that has not reloaded may still send an order the server already archived. An unchanged copy
  // is dropped; a changed one is refused, because an archived order is read-only.
  const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
  const dropArchived = async doc => {
    if (!doc || !Array.isArray(doc.orders)) return null;
    const drop = [];
    for (const o of doc.orders) {
      const a = o && typeof o.id === 'string' ? await store.archived(o.id) : null; if (!a) continue;
      if (canon(a.entry.order) !== canon(o)) return `${o.id} is archived and read-only. Reload to continue; open it from the archive to view or print it.`;
      drop.push(o.id);
    }
    if (drop.length) { doc.orders = doc.orders.filter(o => !drop.includes(o.id)); if (Array.isArray(doc.activity)) doc.activity = doc.activity.filter(e => !drop.includes(e.orderId)); }
    return null;
  };

  // ---- page with the server context injected ----
  const page = async session => {
    const row = await store.getDoc(TENANT);
    // Never embed a workspace in a page response. The app fetches it only after sign-in.
    // Nor the account directory: a visitor who has not signed in learns only whether the first account still has
    // to be set up. A signed-in page reads the list from GET /api/auth/accounts with its session.
    const accounts = await store.accounts();
    const ctx = { api: '/api', etag: null, workspace: null, workspaceAvailable: !!row, jiraConfigured, auth: { users: session ? accounts.map(publicAccount) : [], setupRequired: accounts.length === 0 }, account: session ? publicAccount(session.account) : null, served: new Date().toISOString() };
    const script = `<script id="flight-server">window.FLIGHT_SERVER=${JSON.stringify(ctx).replace(/</g, '\\u003c')};</script>`;
    return host.html.replace('<head>', `<head>${script}`);
  };
  // Writes the archive export JSON with each recording's bytes base64-encoded in bounded chunks, one recording at a
  // time and respecting backpressure, so an evidence-heavy archive never has to fit in memory as one object.
  const streamArchiveExport = async (res, head, evidence) => {
    // Under backpressure wait for drain, but settle on close or error too: a cancelled download may never drain.
    const write = text => new Promise((resolve, reject) => {
      if (res.destroyed) { reject(new Error('The client closed the export.')); return; }
      if (res.write(text)) { resolve(); return; }
      const settle = error => { res.off('drain', onDrain); res.off('close', onClose); res.off('error', settle); if (error) reject(error); else resolve(); };
      const onDrain = () => settle(), onClose = () => settle(new Error('The client closed the export.'));
      res.once('drain', onDrain); res.once('close', onClose); res.once('error', settle);
    });
    try {
      await write(`${JSON.stringify(head).slice(0, -1)},"evidence":{`);
      let first = true;
      for (const [key, meta] of Object.entries(evidence)) {
        await write(`${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(meta).slice(0, -1)},"base64":"`);
        first = false;
        const bytes = await store.evidenceBytes(key);
        for (let at = 0; at < bytes.length; at += EXPORT_CHUNK_BYTES) await write(bytes.subarray(at, at + EXPORT_CHUNK_BYTES).toString('base64'));
        await write('"}');
      }
      await write('}}');
      res.end();
    } catch (error) { res.destroy(error); }
  };
  const recordExtract = async (recordId, kind, username, content, summary) => {
    const stamp = { exportId: `EXT-${randomBytes(16).toString('hex').toUpperCase()}`, recordType: 'work-order', recordId, kind, exportedAt: new Date(clock()).toISOString(), exportedBy: username, sha256: sha256hex(JSON.stringify(content)), summary };
    await store.recordExtract(stamp);
    await store.audit(username, 'record-extract', { ...stamp, summary });
    return stamp;
  };
  let exportDrain = null;
  const deliverExport = async job => {
    const payload = job.payload;
    if (job.destinationKind === 'folder') {
      const clean = job.namingPattern.replaceAll('{recordType}', job.recordType).replaceAll('{recordId}', job.recordId).replaceAll('{exportId}', job.exportId).replace(/[^A-Za-z0-9._-]/g, '_');
      const filename = path.basename(clean).slice(0, 200);
      if (!filename || filename === '.' || filename === '..') throw new Error('The naming pattern did not produce a safe file name.');
      await fs.promises.mkdir(job.destination, { recursive: true });
      const full = path.join(job.destination, filename.endsWith('.json') ? filename : `${filename}.json`);
      try {
        const handle = await fs.promises.open(full, 'wx', 0o600);
        try { await handle.writeFile(payload, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await fs.promises.readFile(full, 'utf8') !== payload) throw new Error(`Refused to overwrite existing export file ${filename}.`);
      }
      return `Wrote ${filename}`;
    }
    if (!exportTargetAllowed(job.tokenSetting, job.destination)) throw new Error(`Server setting ${job.tokenSetting || '(missing token setting)'} is not bound to this destination in FLIGHT_EXPORT_CREDENTIALS. Nothing was sent.`);
    const token = process.env[job.tokenSetting] || '';
    if (!token) throw new Error(`Server setting ${job.tokenSetting || '(missing token setting)'} is not configured.`);
    const response = await fetch(job.destination, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': job.exportId, 'X-Record-SHA256': job.sha256 }, body: payload, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTPS destination refused the export with ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return `HTTPS destination accepted ${job.exportId}`;
  };
  const drainExports = () => {
    if (exportDrain) return exportDrain;
    exportDrain = (async () => {
      // Keep taking batches until nothing new is pending: one commit can finalize more records than one batch holds.
      const seen = new Set();
      for (let batch = await store.pendingExportJobs(100); batch.some(job => !seen.has(job.id)); batch = await store.pendingExportJobs(100)) for (const queued of batch.filter(job => !seen.has(job.id))) {
        seen.add(queued.id);
        let job = queued;
        while (job && job.attempts < 3 && job.status === 'pending') {
          try {
            const detail = await deliverExport(job);
            job = await store.updateExportJob(job.id, { status: 'delivered', detail });
          } catch (error) {
            const terminal = job.attempts + 1 >= 3;
            job = await store.updateExportJob(job.id, { status: terminal ? 'failed' : 'pending', detail: error.message });
            if (!terminal) await new Promise(resolve => setTimeout(resolve, 250 * job.attempts));
          }
        }
      }
    })().catch(error => log('record export worker failed', error.message)).finally(() => { exportDrain = null; });
    return exportDrain;
  };
  const queueNewFinalRecords = async (previous, next, username, tx) => {
    const before = finalizedRecords(previous), after = finalizedRecords(next), queued = [];
    for (const [key, item] of after) {
      if (before.has(key)) continue;
      const setting = await tx.exportSetting(item.recordType);
      if (!setting?.enabled) continue;
      const exportId = `EXT-${randomBytes(16).toString('hex').toUpperCase()}`;
      const exportedAt = new Date(clock()).toISOString();
      const content = { recordType: item.recordType, recordId: item.recordId, record: item.record };
      const digest = sha256hex(JSON.stringify(content));
      const summary = { recordType: item.recordType, recordId: item.recordId, status: item.record.status || item.record.fair?.status || 'Final' };
      const body = JSON.stringify({ application: 'Flight System', kind: 'record-export', exportId, exportedAt, exportedBy: username, hashAlgorithm: 'SHA-256', sha256: digest, dataSummary: summary, ...content });
      const job = await tx.queueExportJob({ id: `JOB-${randomBytes(12).toString('hex').toUpperCase()}`, recordType: item.recordType, recordId: item.recordId, exportId, sha256: digest, payload: body, destinationKind: setting.destinationKind, destination: setting.destination, tokenSetting: setting.tokenSetting, namingPattern: setting.namingPattern, createdBy: username });
      if (!job) continue;
      await tx.recordExtract({ exportId, recordType: item.recordType, recordId: item.recordId, kind: 'configured-record-export', exportedAt, exportedBy: username, sha256: digest, summary });
      await tx.audit(username, 'record-export-queued', { recordType: item.recordType, recordId: item.recordId, exportId, sha256: digest });
      queued.push(job.id);
    }
    return queued;
  };
  const htmlText = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const printExtractStamp = stamp => `<footer class="flight-extract-stamp"><strong>Record extract</strong><br>Export ID: ${htmlText(stamp.exportId)} · ${htmlText(stamp.exportedBy)} · ${htmlText(stamp.exportedAt)}<br>SHA-256: ${htmlText(stamp.sha256)}<br>Summary: ${htmlText(JSON.stringify(stamp.summary))}</footer>`;
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
      await storeReady;
      if (p === '/' || p === '/index.html') { const pageSession = await sessionOf(req); res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(await page(pageSession)); return; }
      if (p.startsWith('/assets/') || (p === '/demo.html' && serveDemo) || p === '/favicon.ico') { serveStatic(req, res, p); return; }
      if (!p.startsWith('/api/')) { send(res, 404, { error: 'Not found' }); return; }
      const route = p.slice(4);

      // Liveness for anyone (a load balancer or monitor needs no account); the operating detail only with a session.
      if (route === '/health' && m === 'GET') {
        if (!await sessionOf(req, { touch: false })) { send(res, 200, { ok: true }); return; }
        const row = await store.getDoc(TENANT), accounts = await store.accounts(); send(res, 200, { ok: true, product: 'Flight System', accounts: accounts.length, workspace: !!row, etag: row ? row.etag : null, schema: row ? JSON.parse(row.json).version : null }); return;
      }

      // -- auth --
      if (route === '/auth/session') {
        if (m === 'POST') {
          const body = await readJson(req), username = String(body.username || '').trim().toLowerCase(), password = String(body.password || '');
          const mins = await lockedFor(username); if (mins) { await store.audit(username, 'signin-blocked'); send(res, 423, { error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }); return; }
          await wrapped;
          const a = await store.account(username);
          const good = !!a && !a.sso && await verifyPassword(a, password);
          if (!a) await scryptAsync(password, 'no-such-account', SCRYPT);
          if (!good) { const f = await noteFailure(username); await store.audit(username, 'signin-failed'); send(res, 401, { error: `Incorrect username or password.${f.until > Date.now() ? ' Account locked for 5 minutes.' : ''}` }); return; }
          await store.clearLockout(username);
          if (hashKind(a.hash) !== 'current') { const from = hashKind(a.hash); await store.upsertAccount({ ...a, salt: '', hash: await makeHash(password) }); await store.audit(username, 'password-rehash', { from }); }
          const s = await store.openSession(username, clock()); await store.audit(username, 'signin');
          send(res, 200, { token: s.token, issuedAt: s.issuedAt, account: publicAccount(a) }); return;
        }
        // The heartbeat reads the session without counting as activity.
        if (m === 'GET') { const s = await sessionOf(req, { touch: false }); if (!s) { noSession(res, req); return; } send(res, 200, { account: publicAccount(s.account), issuedAt: s.issuedAt, idleMinutes, maxHours }); return; }
        // Sign-out ends every session the account holds.
        if (m === 'DELETE') { const t = tokenOf(req); if (t) { const s = await store.session(t, { touch: false }); await store.closeSession(t); if (s && s.username) { const n = await store.closeSessionsOf(s.username); await store.audit(s.username, 'signout', { sessionsEnded: n + 1 }); } } res.writeHead(204); res.end(); return; }
      }
      if (route === '/auth/access' && m === 'POST') {
        const session = await sessionOf(req);
        if (!session) { noSession(res, req); return; }
        const body = await readJson(req), action = String(body.action || ''), username = String(body.username || '').trim().toLowerCase();
        let refusal = null, message = '';
        await store.transaction(async tx => {
          await tx.lockAuthority();
          const actor = await tx.account(session.username), target = await tx.account(username);
          const row = await tx.getDoc(TENANT);
          let state = null;
          if (row) {
            const parsed = JSON.parse(row.json);
            state = host.MES.upgrade(structuredClone(parsed));
            if (!state || !host.MES.validate(state)) state = null;
          }
          const keysFor = account => account && state ? host.rolesOf(account, state) : accountRoles(account);
          const isManager = account => keysFor(account).some(role => ['qm', 'admin'].includes(role));
          const isQAManager = account => keysFor(account).includes('qm');
          const isSupervisor = account => !isManager(account) && keysFor(account).includes('qs');
          const fail = (status, error) => { refusal = { status, error }; return false; };
          if (!actor || !target) return fail(404, 'The account was not found. Reload the account list and try again.');
          if (action === 'grant' || action === 'revoke') {
            if (!isQAManager(actor)) return fail(403, 'Only a QA Manager grants or revokes individually granted authorities.');
            if (!GRANTED_AUTHORITY_CAPS.includes(body.cap)) return fail(400, 'That authority is not granted individually.');
            if (target.username === actor.username) return fail(403, 'Nobody grants or revokes their own authority. Another QA Manager must do it.');
            if (isSupervisor(actor) && accountRoles(target).some(role => ['qm', 'admin'].includes(role))) return fail(403, 'A Quality Supervisor cannot change authorities for a QA Manager or Master Access account.');
            const reason = String(body.reason || '').trim();
            if (reason.length < 10 || reason.length > 300) return fail(400, 'Give the reason in 10 to 300 characters.');
            const on = action === 'grant';
            if (on) {
              if (!state) return fail(409, 'The shared workspace is missing or invalid. Current training cannot be verified.');
              const eligible = keysFor(target).some(role => (host.roles.ROLE_CAPS[role] || host.roles.EVERYONE).includes(body.cap));
              if (!eligible) return fail(403, `${target.displayName} has no active role that qualifies for this authority.`);
              const trainingCode = String(body.trainingCode || '').trim().toUpperCase();
              if (!trainingQualifies(state, target.username, trainingCode)) return fail(403, `${target.displayName} has no current ${trainingCode || 'selected'} training record. Record the training first.`);
              if (target.grants?.[body.cap] && !target.grants[body.cap].revokedAt && host.MES.trainingCurrentFor(state, target.username, target.grants[body.cap].trainingCode).ok) { message = 'Already granted.'; return true; }
            } else if (!target.grants?.[body.cap] || target.grants[body.cap].revokedAt) { message = 'Not granted.'; return true; }
            const at = new Date(clock()).toISOString();
            const by = { name: actor.displayName, credentialId: `ACCT-${actor.username}`, account: actor.username };
            const record = { account: target.username, authority: body.cap, action: on ? 'granted' : 'revoked', by, at, reason, ...(on ? { trainingCode: String(body.trainingCode).trim().toUpperCase() } : {}) };
            const hash = sha256hex(host.MES.canonical(record));
            const grants = { ...(target.grants || {}) };
            const grantHistory = [...(Array.isArray(target.grantHistory) ? target.grantHistory : []), { ...record, hash }].slice(-200);
            if (on) grants[body.cap] = { by, at, reason, trainingCode: record.trainingCode, hash };
            else grants[body.cap] = { ...grants[body.cap], revokedAt: at, revokedBy: by, revokeReason: reason };
            await tx.upsertAccount({ ...target, grants, grantHistory });
            await tx.audit(actor.username, on ? 'authority-granted' : 'authority-revoked', { username: target.username, authority: body.cap, reason, trainingCode: on ? record.trainingCode : null, manifest: hash });
            message = `${on ? 'Granted' : 'Revoked'} ${body.cap} ${on ? 'to' : 'from'} ${target.displayName}.`;
          } else if (action === 'roles') {
            if (!isManager(actor) && !isSupervisor(actor)) return fail(403, 'Only a Master Access, QA Manager, or Quality Supervisor account can manage roles.');
            if (!state) return fail(409, 'The shared workspace is missing or invalid. Current training cannot be verified.');
            const before = accountRoles(target), isQS = isSupervisor(actor);
            if (isQS && before.some(role => ['qm', 'admin'].includes(role))) return fail(403, 'A Quality Supervisor cannot change a QA Manager or Master Access account.');
            if (target.username === actor.username) return fail(403, 'Nobody changes their own roles. Another QA Manager, Quality Supervisor, or Master Access account must do it.');
            const list = Array.isArray(body.roles) ? [...new Set(body.roles.map(String))] : [];
            if (!list.length || list.some(role => !host.roles.ROLES.some(item => item.key === role))) return fail(400, 'Choose one or more listed roles.');
            if (isQS && list.some(role => ['qm', 'admin'].includes(role))) return fail(403, 'A Quality Supervisor cannot assign QA Manager or Master Access.');
            const reason = String(body.reason || '').trim();
            if (reason.length < 10 || reason.length > 300) return fail(400, 'Give the reason in 10 to 300 characters.');
            const added = list.slice(1).filter(role => !before.includes(role) || before[0] === role);
            const primaryChanged = before[0] !== list[0];
            const trainingCode = String(body.trainingCode || '').trim().toUpperCase();
            if (added.length || primaryChanged) {
              if (!trainingQualifies(state, target.username, trainingCode)) return fail(403, `${target.displayName} has no current ${trainingCode || 'selected'} training record. Record the training first.`);
            }
            const currentManagerCount = (await tx.accounts()).filter(account => keysFor(account).some(role => ['qm', 'admin'].includes(role))).length;
            if (isManager(target) && !list.some(role => ['qm', 'admin'].includes(role)) && currentManagerCount < 2) return fail(409, 'At least one QA Manager or Master Access account must remain.');
            const at = new Date(clock()).toISOString();
            const roleTraining = {};
            for (const role of list.slice(1)) roleTraining[role] = added.includes(role) ? { code: trainingCode, at, by: actor.username } : (target.roleTraining?.[role] || {});
            await tx.upsertAccount({ ...target, role: list[0], roles: [list[0]], extraRoles: list.slice(1), roleTraining, createdAt: target.createdAt, createdBy: target.createdBy });
            await tx.audit(actor.username, 'role-change', { username: target.username, from: before, to: list, reason, trainingCode: added.length || primaryChanged ? trainingCode : null });
            message = `${target.displayName}: ${list.join(' + ')}.`;
          } else if (action === 'support') {
            if (!keysFor(actor).includes('admin')) return fail(403, 'Only a Master Access account grants or removes Support Access.');
            if (target.username === actor.username) return fail(403, 'A Master Access account cannot grant Support Access to itself.');
            const reason = String(body.reason || '').trim();
            if (reason.length < 10 || reason.length > 500) return fail(400, 'Give the reason in 10 to 500 characters.');
            const supportAccess = body.on === true;
            await tx.upsertAccount({ ...target, supportAccess, createdAt: target.createdAt, createdBy: target.createdBy });
            await tx.audit(actor.username, supportAccess ? 'support-grant' : 'support-revoke', { username: target.username, reason });
            message = `Support Access ${supportAccess ? 'granted to' : 'removed from'} ${target.username}.`;
          } else return fail(400, 'Choose a supported access change.');
          return true;
        });
        if (refusal) { send(res, refusal.status, { error: refusal.error }); return; }
        send(res, 200, { users: (await store.accounts()).map(publicAccount), message }); return;
      }
      if (route === '/auth/accounts') {
        if (m === 'GET') { if (!await sessionOf(req)) { noSession(res, req); return; } send(res, 200, { users: (await store.accounts()).map(publicAccount) }); return; }
        if (m === 'PUT') {
          // Merge: the browser sends its account list; users it knows without a hash keep theirs, new or reset users bring salt and hash.
          const body = await readJson(req), incoming = Array.isArray(body.users) ? body.users : [];
          const existing = await store.accounts(), session = await sessionOf(req);
          const firstRun = existing.length === 0;
          if (!firstRun && !(session && (manages(session.account) || supervises(session.account)))) { send(res, 403, { error: 'Only a Master Access, QA Manager, or Quality Supervisor account can manage accounts.' }); return; }
          if (firstRun && incoming.length !== 1) { send(res, 400, { error: 'The first account is created alone.' }); return; }
          if (firstRun && !setupCodeMatches(body.setupCode)) { await store.audit(null, 'first-account-refused', { reason: 'setup code missing or wrong' }); send(res, 403, { error: 'Enter the setup code shown in the server console when it started. The first account becomes Master Access, so it needs that code.' }); return; }
          await wrapped;
          const { state: accountState } = await loadState();
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
          let refusal = null;
          await store.transaction(async tx => {
            // Same lock as /auth/access, and fresh rows: a concurrent role or grant change must not be overwritten
            // with the authority profile this request read before the transaction.
            await tx.lockAuthority();
            const current = await tx.accounts();
            if (firstRun && current.length) { refusal = { status: 409, error: 'An account was created on this server while you were setting it up. Sign in with it instead.' }; return false; }
            for (const u of incoming) {
              const username = String(u.username || '').trim().toLowerCase();
              if (!/^[a-z0-9._-]{3,40}$/.test(username) || !String(u.displayName || '').trim()) { refusal = { status: 400, error: `Account ${username || '(blank)'}: username is 3 to 40 characters and the name is required.` }; return false; }
              const cur = current.find(x => x.username === username);
              if (cur) {
                const changed = (Object.hasOwn(u, 'role') && u.role !== cur.role) ||
                  (Object.hasOwn(u, 'roles') && JSON.stringify(u.roles) !== JSON.stringify(cur.roles)) ||
                  (Object.hasOwn(u, 'extraRoles') && JSON.stringify(u.extraRoles) !== JSON.stringify(cur.extraRoles || [])) ||
                  (Object.hasOwn(u, 'roleTraining') && JSON.stringify(u.roleTraining) !== JSON.stringify(cur.roleTraining || {})) ||
                  (Object.hasOwn(u, 'grants') && JSON.stringify(u.grants) !== JSON.stringify(cur.grants || {})) ||
                  (Object.hasOwn(u, 'grantHistory') && JSON.stringify(u.grantHistory) !== JSON.stringify(cur.grantHistory || [])) ||
                  (Object.hasOwn(u, 'supportAccess') && (u.supportAccess === true) !== (cur.supportAccess === true));
                if (changed) { refusal = { status: 403, error: `Account ${username}: access changes must use the server-authorized access route.` }; return false; }
              } else if ((Array.isArray(u.roles) && u.roles.length > 1) || (Array.isArray(u.extraRoles) && u.extraRoles.length) || (u.roleTraining && Object.keys(u.roleTraining).length) || (u.grants && Object.keys(u.grants).length) || (Array.isArray(u.grantHistory) && u.grantHistory.length) || u.supportAccess === true) {
                refusal = { status: 403, error: `Account ${username}: new accounts cannot bring client-supplied expanded access, grants, or Support Access.` }; return false;
              }
              let roles;
              if (firstRun) roles = ['admin'];
              else if (Array.isArray(u.roles)) {
                roles = [...new Set(u.roles.map(value => String(value)))];
                if (!roles.length || roles.some(value => !host.roles.ROLES.some(r => r.key === value))) { refusal = { status: 400, error: `Account ${username}: choose one or more listed roles.` }; return false; }
              } else if (cur && u.role === cur.role) roles = accountRoles(cur);
              else if (host.roles.ROLES.some(r => r.key === u.role)) roles = [u.role];
              else roles = cur ? accountRoles(cur) : ['general'];
              const role = firstRun ? 'admin' : (roles.includes(u.role) ? u.role : (cur && roles.includes(cur.role) ? cur.role : roles[0]));
              const hasHash = prepared.has(u);
              const requiresTraining = !firstRun && !cur && roles.some(key => (host.roles.ROLE_CAPS[key] || host.roles.EVERYONE).some(cap => TRAINING_GATED_ROLE_CAPS.has(cap)));
              if (requiresTraining) {
                const trainingCode = String(u.trainingCode || '').trim().toUpperCase();
                if (!trainingQualifies(accountState, username, trainingCode)) {
                  refusal = { status: 403, error: `Account ${username}: a role with inspection or MRB authority requires a current training record. Create the account without that role, record training, then assign the role.` }; return false;
                }
              }
              if (!firstRun && supervises(session.account)) {
                const protectedTarget = cur && accountRoles(cur).some(value => ['qm', 'admin'].includes(value));
                if (protectedTarget) {
                  const unchanged = role === cur.role && JSON.stringify(roles) === JSON.stringify(accountRoles(cur)) && String(u.displayName).trim() === cur.displayName && (!hasHash || prepared.get(u) === cur.hash) && JSON.stringify(u.grants || cur.grants || {}) === JSON.stringify(cur.grants || {}) && JSON.stringify(u.grantHistory || cur.grantHistory || []) === JSON.stringify(cur.grantHistory || []) && (Object.hasOwn(u, 'supportAccess') ? u.supportAccess === true : cur.supportAccess === true) === (cur.supportAccess === true);
                  if (!unchanged) { refusal = { status: 403, error: `A Quality Supervisor cannot change a QA Manager or Master Access account (${username}).` }; return false; }
                  continue;
                }
                if (roles.some(value => ['qm', 'admin'].includes(value))) { refusal = { status: 403, error: `A Quality Supervisor cannot assign QA Manager or Master Access (${username}).` }; return false; }
                if (cur && username === session.username && (role !== cur.role || JSON.stringify(accountRoles(cur)) !== JSON.stringify(roles))) { refusal = { status: 403, error: 'A Quality Supervisor cannot change their own roles.' }; return false; }
              }
              if (!cur && !hasHash) { refusal = { status: 400, error: `Account ${username} needs a password.` }; return false; }
              const newHash = hasHash ? prepared.get(u) : null;
              await tx.upsertAccount({ username, displayName: String(u.displayName).trim().slice(0, 60), salt: hasHash ? (newHash.startsWith('scrypt-sha256$') ? u.salt : '') : cur.salt, hash: hasHash ? newHash : cur.hash, role, roles, extraRoles: cur?.extraRoles || [], roleTraining: cur?.roleTraining || {}, grants: cur?.grants || {}, grantHistory: cur?.grantHistory || [], supportAccess: cur?.supportAccess === true, createdAt: cur ? cur.createdAt : new Date().toISOString(), createdBy: cur ? cur.createdBy : (session ? session.username : username), sso: !!u.sso });
              if (cur && hasHash && cur.hash !== newHash && u.hash !== cur.hash) { await tx.audit(session ? session.username : username, 'password-reset', { username }); passwordChanged.push(username); }
              if (cur && (cur.role !== role || JSON.stringify(accountRoles(cur)) !== JSON.stringify(roles))) await tx.audit(session.username, 'role-change', { username, from: accountRoles(cur), to: roles });
              if (!cur) await tx.audit(session ? session.username : username, 'account-create', { username, role, roles, trainingCode: requiresTraining ? String(u.trainingCode).trim().toUpperCase() : null });
            }
            // Refuse to demote the last manager.
            if (!(await tx.accounts()).some(manages)) { refusal = { status: 409, error: 'At least one QA Manager or Master Access account must remain.' }; return false; }
            return true;
          });
          if (refusal) { send(res, refusal.status, { error: refusal.error }); return; }
          // A password change ends that person's sessions everywhere, except the session that made the change.
          for (const u of passwordChanged) { const ended = await store.closeSessionsOf(u, session ? session.token : null); if (ended) await store.audit(session ? session.username : u, 'sessions-revoked', { username: u, reason: 'password change', sessions: ended }); }
          send(res, 200, { users: (await store.accounts()).map(publicAccount) }); return;
        }
      }

      // Everything below needs a session.
      const session = await sessionOf(req);
      if (!session) { noSession(res, req); return; }

      // Jira credentials stay on the server. The caller names a Flight record, never an issue
      // payload; the canonical issue fields are rebuilt from the shared workspace.
      if (route === '/jira/issue' && m === 'POST') {
        if (!jiraConfigured) { send(res, 503, { error: 'The server Jira connector is not configured with an HTTPS Atlassian Cloud URL and service credentials.' }); return; }
        let jiraUrl;
        try { jiraUrl = new URL(jiraConfig.baseUrl); } catch { send(res, 503, { error: 'The server Jira connector URL is invalid.' }); return; }
        if (jiraUrl.protocol !== 'https:' || !/(^|\.)atlassian\.net$/i.test(jiraUrl.hostname) || jiraUrl.username || jiraUrl.password || jiraUrl.search || jiraUrl.hash || (jiraUrl.pathname && jiraUrl.pathname !== '/')) { send(res, 503, { error: 'The server Jira connector must use an HTTPS Atlassian Cloud address without a path.' }); return; }
        const body = await readJson(req), recordType = String(body.recordType || '').toUpperCase(), recordId = String(body.recordId || '').trim();
        if (!['ECR', 'SPR', 'SCAR'].includes(recordType) || !/^[A-Z0-9-]{3,40}$/.test(recordId)) { send(res, 400, { error: 'Choose a supported Flight Jira record and its record ID.' }); return; }
        const loaded = await loadState();
        if (!loaded.state && !loaded.problem) { send(res, 404, { error: 'The shared workspace is not initialized.' }); return; }
        if (loaded.problem) { send(res, 422, { error: `The shared workspace cannot be used: ${loaded.problem}` }); return; }
        if (loaded.registers) { send(res, 422, { error: `The shared workspace cannot be used: ${loaded.registers}` }); return; }
        const state = loaded.state;
        let record, issue, capability, linkAction;
        if (recordType === 'ECR') {
          record = (state.ecrRequests || []).find(item => item.id === recordId);
          if (!record || record.type !== 'design') { send(res, 404, { error: 'Design ECR not found.' }); return; }
          capability = ['edit-wi', 'approve-wo']; linkAction = () => host.MES.linkECRJira(state, record.id, issue.key, issue.url);
          issue = { project: record.jira?.project || process.env.FLIGHT_JIRA_PROJECT_ECR || '', issueType: record.jira?.issueType || 'Engineering Change Request', summary: record.jira?.summary || record.title, description: record.jira?.description || record.description };
          if (record.jira?.key) { send(res, 200, { ok: true, duplicate: true, issue: { key: record.jira.key, url: record.jira.url || null }, etag: loaded.etag }); return; }
        } else if (recordType === 'SPR') {
          record = (state.maneuver?.sprs || []).find(item => item.id === recordId);
          if (!record) { send(res, 404, { error: 'Problem report not found.' }); return; }
          capability = ['raise-nc']; linkAction = () => host.FlightManeuver.linkSPRJira(state, record.id, issue.key, issue.url);
          try { issue = JSON.parse(record.payload || '{}'); } catch { send(res, 422, { error: 'The problem report Jira payload is invalid.' }); return; }
          if (record.jira?.key) { send(res, 200, { ok: true, duplicate: true, issue: { key: record.jira.key, url: record.jira.url || null }, etag: loaded.etag }); return; }
        } else {
          record = (state.maneuver?.cars || []).find(item => item.id === recordId);
          if (!record?.scar) { send(res, 404, { error: 'Supplier corrective action not found.' }); return; }
          capability = ['dispo-nc']; linkAction = () => host.FlightManeuver.linkSCARJira(state, record.id, issue.key, issue.url);
          try { issue = JSON.parse(record.scar.payload || '{}'); } catch { send(res, 422, { error: 'The supplier corrective action Jira payload is invalid.' }); return; }
          if (record.scar.jira?.key) { send(res, 200, { ok: true, duplicate: true, issue: { key: record.scar.jira.key, url: record.scar.jira.url || null }, etag: loaded.etag }); return; }
        }
        const submittedByCaller = recordType === 'ECR' && record.requestedBy?.credentialId === `ACCT-${session.username}`;
        if (!submittedByCaller && !host.capsOf(session.account, state).some(cap => capability.includes(cap))) { await store.audit(session.username, 'jira-issue-refused', { recordType, recordId, reason: 'role capability' }); send(res, 403, { error: 'Your role cannot send this record to Jira.' }); return; }
        const project = String(issue.project || '').trim().toUpperCase(), issueType = String(issue.issueType || '').trim(), summary = String(issue.summary || '').trim(), description = String(issue.description || '').trim();
        if (!/^[A-Z][A-Z0-9]{1,9}$/.test(project) || !issueType || issueType.length > 80 || !summary || summary.length > 255 || !description || description.length > 10000) { send(res, 422, { error: 'The Flight record needs a Jira project, issue type, summary, and description before it can be sent.' }); return; }
        const requestSha256 = sha256hex(JSON.stringify({ recordType, recordId, project, issueType, summary, description }));
        const idempotencyKey = `flight-${recordType.toLowerCase()}-${recordId.toLowerCase()}`;
        const row = await store.jiraIssueRequest(idempotencyKey);
        if (row && row.request_sha256 !== requestSha256) { send(res, 409, { error: 'This Flight record already has a Jira request with different content. Reconcile the existing request before changing or resending it.', code: 'JIRA_IDEMPOTENCY_CONFLICT' }); return; }
        let saved = row;
        if (!saved) {
          const begun = await store.beginJiraIssueRequest({ idempotencyKey, requestSha256, recordType, recordId, projectKey: project, createdBy: session.username });
          saved = begun.request;
          if (!begun.inserted) {
            if (saved.request_sha256 !== requestSha256) { send(res, 409, { error: 'A Jira request for this Flight record was started with different content. Reconcile it before changing or resending.', code: 'JIRA_IDEMPOTENCY_CONFLICT' }); return; }
            if (saved.status !== 'created') { send(res, 409, { error: 'A Jira request is already in progress or has an uncertain result. Check Jira for the Flight record label before retrying; a second issue will not be created.', code: 'JIRA_RESULT_UNKNOWN' }); return; }
          }
        }
        if (saved.status === 'pending' && row) { send(res, 409, { error: 'A Jira request has an uncertain result. Check Jira for the Flight record label before retrying; a second issue will not be created.', code: 'JIRA_RESULT_UNKNOWN' }); return; }
        if (saved.status === 'pending' && !row) {
          const label = `flight-mes-${recordType.toLowerCase()}-${recordId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
          const toAdf = value => ({ type: 'doc', version: 1, content: String(value).split(/\r?\n/).filter(Boolean).map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
          const fields = { project: { key: project }, issuetype: { name: issueType }, summary, description: toAdf(description), labels: [label] };
          let remote;
          try {
            remote = await jiraFetch(`${jiraUrl.origin}/rest/api/3/issue`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${jiraConfig.email}:${jiraConfig.apiToken}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ fields }), signal: AbortSignal.timeout(15000) });
          } catch {
            await store.audit(session.username, 'jira-issue-uncertain', { recordType, recordId, idempotencyKey });
            send(res, 502, { error: 'Jira did not confirm the result. Check Jira for the Flight record label before retrying; Flight will not send a second create request.', code: 'JIRA_RESULT_UNKNOWN' }); return;
          }
          // 400, 401, 403, 404 and 422 mean Jira refused the request and created nothing, so the record can be sent again
          // once the configuration is fixed. Timeouts, 5xx and 429 stay uncertain: Jira may have created the issue.
          if ([400, 401, 403, 404, 422].includes(remote.status)) {
            let detail = ''; try { detail = String((await remote.text()) || '').slice(0, 300); } catch {}
            await store.releaseJiraIssueRequest(idempotencyKey);
            await store.audit(session.username, 'jira-issue-rejected', { recordType, recordId, idempotencyKey, responseStatus: remote.status });
            send(res, 502, { error: `Jira refused the request (${remote.status}) and created no issue. Check the Jira project, issue type and connector account, then send it again.${detail ? ` Jira said: ${detail}` : ''}`, code: 'JIRA_REJECTED' }); return;
          }
          if (!remote.ok) {
            await store.audit(session.username, 'jira-issue-uncertain', { recordType, recordId, idempotencyKey, responseStatus: remote.status });
            send(res, 502, { error: 'Jira did not confirm issue creation. Check Jira for the Flight record label before retrying; Flight will not send a second create request.', code: 'JIRA_RESULT_UNKNOWN' }); return;
          }
          let created;
          try { created = await remote.json(); } catch { created = null; }
          if (!created || !/^[A-Z][A-Z0-9]+-\d+$/.test(String(created.key || ''))) {
            await store.audit(session.username, 'jira-issue-uncertain', { recordType, recordId, idempotencyKey, responseStatus: remote.status, reason: 'invalid success response' });
            send(res, 502, { error: 'Jira returned an unrecognized success response. Check Jira for the Flight record label; Flight will not send a second create request.', code: 'JIRA_RESULT_UNKNOWN' }); return;
          }
          const issueUrl = `${jiraUrl.origin}/browse/${created.key}`;
          saved = await store.completeJiraIssueRequest(idempotencyKey, { key: created.key, url: issueUrl });
          if (!saved) { send(res, 409, { error: 'Jira created the issue, but Flight could not finalize its idempotency record. Keep the Jira key and ask an administrator to reconcile it.', code: 'JIRA_RECONCILIATION_REQUIRED' }); return; }
          await store.audit(session.username, 'jira-issue-created', { recordType, recordId, issueKey: created.key, idempotencyKey });
        }
        issue = { key: saved.issue_key, url: saved.issue_url };
        const linked = host.withAccount(session.account, linkAction, state);
        if (!linked?.ok) { await store.audit(session.username, 'jira-link-refused', { recordType, recordId, issueKey: issue.key, reason: linked?.message || 'engine refusal' }); send(res, 422, { error: `Jira issue ${issue.key} exists, but Flight refused the record link: ${linked?.message || 'reload and reconcile the record'}`, code: 'JIRA_RECONCILIATION_REQUIRED' }); return; }
        const done = await commitState(state, loaded.etag, session.username, [{ action: 'jira-issue-linked', detail: { recordType, recordId, issueKey: issue.key } }]);
        if (done.problem) { send(res, 422, { error: `Jira issue ${issue.key} exists, but Flight could not save its record link: ${done.problem}`, code: 'JIRA_RECONCILIATION_REQUIRED' }); return; }
        if (done.conflict) { send(res, 409, { error: `Jira issue ${issue.key} exists, but the workspace changed before Flight could save the link. Retry this request to finish reconciliation.`, code: 'JIRA_RECONCILIATION_REQUIRED' }); return; }
        send(res, 200, { ok: true, issue, message: linked.message, etag: done.etag }); return;
      }

      // -- workspace --
      if (route === '/workspace' && m === 'GET') { const row = await store.getDoc(TENANT); if (!row) { send(res, 404, { error: 'No workspace yet.' }); return; } res.writeHead(200, { 'Content-Type': MIME['.json'], ETag: row.etag, 'Cache-Control': 'no-store' }); res.end(row.json); return; }
      if (route === '/workspace' && m === 'PUT') {
        // Snapshot replacement is permitted exactly once, to initialize an empty server or apply
        // a preflighted migration. Existing shared records can only change through MES actions.
        // This closes the authorization bypass where a manager could replace records wholesale.
        const currentWorkspace = await store.getDoc(TENANT);
        // Every refused snapshot write is audited with its status, so the audit shows refusal patterns
        // (a stale client, a client without If-Match, an unreadable body, an invalid initialization), not only the 403s.
        const auditRefusal = async (status, reason, extra = {}) => { await store.audit(session.username, 'workspace-put-refused', { status, reason: String(reason).slice(0, 500), ...extra }); };
        let doc;
        try { doc = await readJson(req); } catch (e) { if (e.status === 400 || e.status === 413) await auditRefusal(e.status, e.status === 413 ? 'request body over the size limit' : 'request body is not JSON'); throw e; }
        const ifMatch = req.headers['if-match'] || null;
        if (!manages(session.account)) { await auditRefusal(403, currentWorkspace ? 'initialized workspace is action-only' : 'only QA Manager or Master Access may initialize'); send(res, 403, { error: currentWorkspace ? 'The shared workspace is initialized and cannot be replaced as a snapshot. Use a server-authorized record action or the approved migration procedure.' : 'Only QA Manager or Master Access can initialize the shared workspace.' }); return; }
        if (currentWorkspace) {
          if (!ifMatch) { await auditRefusal(428, 'missing If-Match', { etag: currentWorkspace.etag }); send(res, 428, { error: 'Include the current workspace ETag in If-Match.' }); return; }
          if (currentWorkspace.etag !== ifMatch) { await auditRefusal(409, 'stale If-Match', { etag: currentWorkspace.etag }); res.writeHead(409, { 'Content-Type': MIME['.json'], ETag: currentWorkspace.etag }); res.end(JSON.stringify({ error: 'The workspace changed on another device. Reload to continue.', etag: currentWorkspace.etag })); return; }
          if (canon(doc) === canon(JSON.parse(currentWorkspace.json))) { await store.audit(session.username, 'workspace-snapshot-noop', { etag: currentWorkspace.etag }); res.writeHead(204, { ETag: currentWorkspace.etag }); res.end(); return; }
          const stored = JSON.parse(currentWorkspace.json);
          const changedKeys = [...new Set([...Object.keys(doc || {}), ...Object.keys(stored || {})])].filter(key => canon(doc?.[key]) !== canon(stored?.[key]));
          await auditRefusal(403, 'initialized workspace is action-only', { etag: currentWorkspace.etag, changedKeys }); send(res, 403, { error: 'The shared workspace is initialized and cannot be replaced as a snapshot. Use a server-authorized record action or the approved migration procedure.' }); return;
        }
        { const stale = await dropArchived(doc); if (stale) { await auditRefusal(409, stale, { code: 'ARCHIVED' }); send(res, 409, { error: stale, code: 'ARCHIVED' }); return; } }
        const state = host.MES.upgrade(structuredClone(doc));
        if (!state) { const error = (host.MES.diagnose(doc) || {}).detail || 'The document does not match the current record format.'; await auditRefusal(422, error); send(res, 422, { error }); return; }
        { const unconverged = convergeDerivedState(state); if (unconverged) { await auditRefusal(422, unconverged); send(res, 422, { error: unconverged }); return; } }
        const accountProfile = host.withAccount(session.account, () => host.MES.profileOptions(state)?.[0], state);
        if (accountProfile) state.profile = { name: accountProfile.name, role: accountProfile.role, credentialId: accountProfile.credentialId };
        // The server was empty when this request began. Initialization commits only while it is still empty: a
        // workspace another request initialized meanwhile is never replaced, whatever ETag this request presents.
        const cur = await store.getDoc(TENANT);
        if (cur) { await auditRefusal(409, 'workspace initialized by another request', { etag: cur.etag }); res.writeHead(409, { 'Content-Type': MIME['.json'], ETag: cur.etag }); res.end(JSON.stringify({ error: 'The shared workspace was initialized by another request. Reload to continue.', etag: cur.etag })); return; }
        const problem = validState(state); if (problem) { await auditRefusal(422, problem); send(res, 422, { error: problem }); return; }
        { const bad = await evidenceProblem(null, state, session); if (bad) { await store.audit(session.username, 'evidence-refused', { message: bad }); send(res, 422, { error: bad }); return; } }
        const done = await commitState(state, null, session.username, [{ action: 'workspace-initialize', detail: etag => ({ etag }) }]);
        if (done.problem) { await auditRefusal(422, done.problem); send(res, 422, { error: done.problem }); return; }
        if (done.conflict) { await auditRefusal(409, 'workspace initialized by another request'); send(res, 409, { error: 'The shared workspace was initialized by another request. Reload to continue.' }); return; }
        res.writeHead(204, { ETag: done.etag, ...(done.archived.length ? { 'X-Flight-Archived': done.archived.join(',') } : {}) }); res.end(); return;
      }
      // -- actions: run an engine function server-side with the session's authority --
      const action = /^\/workspace\/actions\/([A-Za-z0-9_.]+)$/.exec(route);
      if (action && m === 'POST') {
        // Every refusal on this route is audited, as PUT /workspace refusals are (#582): the action name, the status and
        // a reason. The request arguments are never recorded; they can carry record content or a probe's payload.
        const auditRefusal = async (status, reason, extra = {}) => { await store.audit(session.username, 'action-refused', { action: action[1].slice(0, 120), status, reason: String(reason).slice(0, 500), ...extra }); };
        const fn = host.resolveAction(action[1]);
        if (!fn) { await auditRefusal(404, 'no such action'); send(res, 404, { error: `No action named ${action[1]}.` }); return; }
        let body; try { body = await readJson(req); } catch (e) { if (e.status === 400 || e.status === 413) await auditRefusal(e.status, e.status === 413 ? 'request body over the size limit' : 'request body is not JSON'); throw e; }
        const args = Array.isArray(body.args) ? body.args : [];
        if (action[1] === 'MES.configureModelAdapter' && args[0]?.enabled === true) {
          const settingName = String(args[0]?.settingName || '');
          // One answer for a setting that is not listed and one that is listed but empty: the check reveals nothing
          // about other environment variables.
          // The audit names the setting only when it is shaped like an environment variable name, never its value.
          if (!modelAdapterSettings.includes(settingName) || !String(process.env[settingName] || '').trim()) { await auditRefusal(422, 'model adapter setting not configured', { settingName: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(settingName) ? settingName : '(not a setting name)' }); send(res, 422, { error: 'The named server environment setting is not configured for the model adapter. Ask the server operator to set it and list it in FLIGHT_MODEL_ADAPTER_SETTINGS. The model adapter remains off.' }); return; }
          args.push(true); // This flag is derived by the server, never accepted from the client.
        }
        const { state, etag, problem, raw, registers } = await loadState();
        if (!state) { await auditRefusal(problem ? 422 : 404, problem || 'no workspace yet'); send(res, problem ? 422 : 404, { error: problem || 'No workspace yet.' }); return; }
        if (registers) { await auditRefusal(422, registers); send(res, 422, { error: registers }); return; }
        const ifMatch = req.headers['if-match'] || null;
        if (!ifMatch) { await auditRefusal(428, 'missing If-Match', { etag }); send(res, 428, { error: 'Include the current workspace ETag in If-Match before running an action.' }); return; }
        if (ifMatch && ifMatch !== etag) { await auditRefusal(409, 'stale If-Match', { etag }); send(res, 409, { error: 'The workspace changed on another device. Reload to continue.', etag }); return; }
        let result;
        try { result = host.withAccount(session.account, () => fn(state, ...args), state); } catch (e) { internalError(res, req, e, 'The action could not run. Nothing was saved.'); return; }
        if (!result || result.ok === false) { await auditRefusal(403, 'refused by the engine', { message: String(result && result.message || '').slice(0, 500) }); send(res, 403, { error: result ? result.message : 'Refused.', result }); return; }
        const invalid = validState(state); if (invalid) { await auditRefusal(422, `would leave the workspace invalid: ${invalid}`); send(res, 422, { error: `The action would leave the workspace invalid: ${invalid}` }); return; }
        { const bad = await evidenceProblem(raw, state, session); if (bad) { await store.audit(session.username, 'evidence-refused', { action: action[1], status: 422, message: bad }); send(res, 422, { error: bad }); return; } }
        const done = await commitState(state, etag, session.username, [{ action: 'action', detail: { action: action[1], message: result.message } }]);
        if (done.problem) { await auditRefusal(422, `would leave the workspace invalid: ${done.problem}`); send(res, 422, { error: `The action would leave the workspace invalid: ${done.problem}` }); return; }
        if (done.conflict) { await auditRefusal(409, 'workspace changed while the action ran'); send(res, 409, { error: 'The workspace changed while the action ran. Try again.' }); return; }
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
        if (claimed && claimed !== sha256) { await store.audit(session.username, 'evidence-hash-mismatch', { id: ev[1], claimed, sha256 }); send(res, 422, { error: `The upload arrived with SHA-256 ${sha256.slice(0, 12)} but was sent as ${claimed.slice(0, 12)}. The recording changed in transit; upload it again.` }); return; }
        const existing = await store.evidenceMeta(ev[1]);
        if (existing) {
          if (existing.sha256 === sha256) { send(res, 200, existing); return; }
          send(res, 409, { error: `${ev[1]} is already stored with SHA-256 ${existing.sha256.slice(0, 12)}. Stored evidence does not change; attach the new recording under a new ID.` }); return;
        }
        let fileName = String(req.headers['x-evidence-name'] || '').slice(0, 180);
        try { fileName = decodeURIComponent(fileName); } catch {}
        fileName = fileName.slice(0, 180) || null;
        // The stored recording and its audit row are one transaction.
        let row = null;
        await store.transaction(async tx => { row = await tx.putEvidence({ id: ev[1], sha256, size: bytes.length, mime, fileName, uploadedBy: session.username, bytes }); await tx.audit(session.username, 'evidence-upload', { id: ev[1], sha256, size: bytes.length, mime }); return true; });
        send(res, 201, row); return;
      }
      if (ev && ev[2] === '/meta' && m === 'GET') { const row = await store.evidenceMeta(ev[1]); if (!row) { send(res, 404, { error: `The server holds no recording ${ev[1]}. Upload it from the device that captured it.` }); return; } if (!await mayReadEvidence(session, row)) { await refuseEvidenceRead(res, session, row); return; } send(res, 200, row); return; }
      if (ev && !ev[2] && m === 'GET') {
        const row = await store.evidenceMeta(ev[1]); if (!row) { send(res, 404, { error: `The server holds no recording ${ev[1]}. Upload it from the device that captured it.` }); return; }
        if (!await mayReadEvidence(session, row)) { await refuseEvidenceRead(res, session, row); return; }
        const bytes = await store.evidenceBytes(ev[1]);
        res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': bytes.length, 'X-Evidence-Sha256': row.sha256, 'Cache-Control': 'private, no-store' }); res.end(bytes); return;
      }
      if (ev && ev[2] === '/supersede' && m === 'POST') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can supersede evidence.' }); return; }
        const body = await readJson(req), by = String(body.by || ''), reason = String(body.reason || '').trim();
        const row = await store.evidenceMeta(ev[1]);
        if (!row) { send(res, 404, { error: `The server holds no recording ${ev[1]}.` }); return; }
        if (row.supersededBy) { send(res, 409, { error: `${ev[1]} was already superseded by ${row.supersededBy}.` }); return; }
        if (!EVIDENCE_ID.test(by) || by === ev[1] || !await store.evidenceMeta(by)) { send(res, 400, { error: 'Upload the replacement recording first, then name its EV ID in "by".' }); return; }
        if (reason.length < 3 || reason.length > 300) { send(res, 400, { error: 'Give the reason for superseding (3 to 300 characters).' }); return; }
        const out = await store.supersedeEvidence(ev[1], by, reason);
        // The update applies only while the row is unsuperseded; a request that lost that race changes nothing and is not audited.
        if (!out) { const now = await store.evidenceMeta(ev[1]); send(res, 409, { error: `${ev[1]} was already superseded by ${now?.supersededBy || 'another recording'}.` }); return; }
        await store.audit(session.username, 'evidence-supersede', { id: ev[1], by, reason });
        send(res, 200, out); return;
      }
      if (route === '/evidence/report' && m === 'GET') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read the evidence report.' }); return; }
        const { state } = await loadState(), refs = evidenceRefs(state), rows = await store.evidenceList();
        const named = new Set(refs.map(r => r.e.copyOf || r.e.id));
        send(res, 200, {
          stored: rows.length,
          missing: (await Promise.all(refs.map(async r => ({ ref: r, meta: await store.evidenceMeta(r.e.copyOf || r.e.id) })))).filter(row => !row.meta).map(({ ref: r }) => ({ id: r.e.id, orderId: r.orderId, opId: r.opId, signed: r.signed })),
          unreferenced: rows.filter(r => !named.has(r.id)).map(r => ({ id: r.id, sha256: r.sha256, uploadedBy: r.uploadedBy, uploadedAt: r.uploadedAt })),
          orphansReported: (await store.auditRows(1000)).filter(r => r.action === 'evidence-orphans').map(r => ({ at: r.at, username: r.username, detail: auditDetail(r.detail) }))
        }); return;
      }
      if (route === '/evidence/orphans' && m === 'POST') {
        // A browser that migrated its local recordings reports what it holds that no record names.
        const body = await readJson(req), ids = (Array.isArray(body.ids) ? body.ids : []).filter(id => EVIDENCE_ID.test(String(id))).slice(0, 500);
        // Audit details are capped at 4,000 characters, so the entry keeps the count and the first IDs, which always fit.
        await store.audit(session.username, 'evidence-orphans', { count: ids.length, ids: ids.slice(0, ORPHAN_AUDIT_IDS), more: Math.max(0, ids.length - ORPHAN_AUDIT_IDS), uploaded: Number(body.uploaded) || 0 });
        send(res, 200, { recorded: ids.length }); return;
      }

      // A list limit reaches the database only as a whole number from 1 to 1,000: SQLite reads a negative LIMIT as
      // unlimited and PostgreSQL refuses one, so anything else (missing, zero, negative, fractional) reads the fallback.
      const pageLimit = (raw, fallback) => { const n = Number(raw); return Number.isInteger(n) && n >= 1 ? Math.min(1000, n) : fallback; };
      // -- archive: closed work orders out of the live document, read-only --
      if (route === '/archive' && m === 'GET') { const orders = await store.archiveSearch(url.searchParams.get('q') || '', pageLimit(url.searchParams.get('limit'), 200)), total = await store.archiveCount(); send(res, 200, { orders, total }); return; }
      if (route === '/trace' && m === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) { send(res, 400, { error: 'Give a serial number, lot or part number to trace.' }); return; }
        const { state } = await loadState();
        // Live orders through the engine's own trace search (serial, lot, tool, WI, change), then the archive.
        const found = state && host.MES.traceSearch ? host.MES.traceSearch(state, q) : null;
        const live = found && Array.isArray(found.orders) ? found.orders.map(o => ({ ...(host.MES.traceKeys ? host.MES.traceKeys(state, host.MES.getOrder(state, o.id) || o) : { orderId: o.id }), why: o.why, source: 'live' })) : [];
        send(res, 200, { query: q, results: [...live, ...await store.archiveSearch(q, 1000)] }); return;
      }
      // -- calibration archive: superseded calibration entries out of the live log, read-only (#130) --
      // A page of 1 to 1,000 entries; anything else reads the default 500 (pageLimit, above).
      // Pages in entry id order: after names the last entry id of the previous page, and next is the cursor for the
      // following page, or null at the end.
      if (route === '/calibration-archive' && m === 'GET') {
        const after = url.searchParams.get('after') || '';
        if (after && !/^CALLOG-\d{5}$/.test(after)) { send(res, 400, { error: 'The after cursor is a calibration entry id such as CALLOG-00042, from the next value of the previous page.' }); return; }
        const limit = pageLimit(url.searchParams.get('limit'), 500);
        const entries = await store.calibrationArchiveList(url.searchParams.get('tag') || '', limit, after);
        send(res, 200, { entries, next: entries.length === limit ? entries[entries.length - 1].id : null, readOnly: true }); return;
      }
      const calArc = /^\/calibration-archive\/(CALLOG-\d{5})$/.exec(route);
      if (calArc && m === 'GET') {
        const a = await store.calibrationArchived(calArc[1]);
        if (!a) { send(res, 404, { error: `${calArc[1]} is not in the calibration archive. An entry that was never archived is in the live calibration log under System QMS records.` }); return; }
        send(res, 200, { entry: a.entry, sha256: a.sha256, recordId: a.recordId, archivedAt: a.archivedAt, archivedBy: a.archivedBy, readOnly: true }); return;
      }
      const arc = /^\/archive\/(WO-[A-Za-z0-9-]+)(\/print|\/export)?$/.exec(route);
      if (arc && m === 'GET') {
        const a = await store.archived(arc[1]);
        if (!a) { send(res, 404, { error: `${arc[1]} is not in the archive. Search by serial, lot or part to find it.` }); return; }
        if (!arc[2]) { send(res, 200, { ...a.entry, sha256: a.sha256, schema: a.schema, archivedAt: a.archivedAt, archivedBy: a.archivedBy, readOnly: true, extractHistory: await store.extractHistory('work-order', a.id) }); return; }
        if (arc[2] === '/print') {
          const mode = url.searchParams.get('mode') === 'external' ? 'external' : 'internal';
          let html; try { html = host.MESPrint.document(a.entry.order, mode); } catch (e) { internalError(res, req, e, 'The record could not be printed.'); return; }
          const summary = { orderId: a.id, partNumber: a.entry.order.partNumber, status: a.entry.order.status, operationCount: (a.entry.order.operations || []).length, closedAt: a.entry.order.closure && a.entry.order.closure.at || null };
          const stamp = await recordExtract(a.id, 'print', session.username, { order: a.entry.order, activity: a.entry.activity, archiveSha256: a.sha256, mode }, summary);
          html = html.replace('</body>', `${printExtractStamp(stamp)}</body>`);
          await store.audit(session.username, 'archive-print', { orderId: a.id, mode });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(html); return;
        }
        // Export: the order with its signatures and history, its activity, and the bytes of its evidence. The extract
        // hash covers each recording's stored metadata, including its SHA-256, so the bytes are bound to the stamped
        // extract without holding every recording in memory: they are streamed one at a time as base64.
        const evidence = {};
        for (const op of a.entry.order.operations || []) for (const e of [...(op.evidence || []), ...(op.quarantinedEvidence || [])]) {
          const key = e.copyOf || e.id, meta = await store.evidenceMeta(key); if (!meta || evidence[key]) continue;
          evidence[key] = meta;
        }
        const summary = { orderId: a.id, partNumber: a.entry.order.partNumber, status: a.entry.order.status, operationCount: (a.entry.order.operations || []).length, activityCount: (a.entry.activity || []).length, evidenceCount: Object.keys(evidence).length, closedAt: a.entry.order.closure && a.entry.order.closure.at || null };
        const content = { order: a.entry.order, activity: a.entry.activity, evidence, archiveSha256: a.sha256, archivedAt: a.archivedAt, archivedBy: a.archivedBy, schema: a.schema };
        const stamp = await recordExtract(a.id, 'json-download', session.username, content, summary);
        await store.audit(session.username, 'archive-export', { orderId: a.id, exportId: stamp.exportId, sha256: stamp.sha256 });
        const head = { application: 'Flight System', kind: 'archived-work-order', exportId: stamp.exportId, exportedAt: stamp.exportedAt, exportedBy: stamp.exportedBy, hashAlgorithm: 'SHA-256', extractSha256: stamp.sha256, extractHashCovers: 'order, activity, evidence metadata including each recording SHA-256, archiveSha256, archivedAt, archivedBy, schema', dataSummary: summary, ...content, evidence: undefined };
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Disposition': `attachment; filename="${a.id}-archive.json"`, 'Cache-Control': 'no-store' });
        await streamArchiveExport(res, head, evidence);
        return;
      }

      // -- read-only reports the engine already computes --
      if (route === '/governance' && m === 'GET') { const { state } = await loadState(); if (!state) { send(res, 404, { error: 'No workspace yet.' }); return; } const r = host.withAccount(session.account, () => host.MES.governanceExport ? host.MES.governanceExport(state) : { ok: false, message: 'Not in this build.' }, state); if (!r.ok) { send(res, 403, { error: r.message }); return; } await store.audit(session.username, 'governance-export', {}); send(res, 200, r.document); return; }
      if (route === '/b2mml' && m === 'GET') { const { state } = await loadState(); if (!state) { send(res, 404, { error: 'No workspace yet.' }); return; } send(res, 200, host.withAccount(session.account, () => host.MES.b2mml ? host.MES.b2mml(state) : { error: 'Not in this build.' }, state)); return; }
      if (route === '/big-three' && m === 'GET') { const { state } = await loadState(); if (!state) { send(res, 404, { error: 'No workspace yet.' }); return; } send(res, 200, host.withAccount(session.account, () => host.MES.bigThree(state), state)); return; }
      // -- configured final-record delivery. Secret values remain server environment variables; the
      // workspace stores only the setting name. A job is snapshotted in the same transaction as the
      // final record and the delivery worker starts only after that transaction commits.
      if (route === '/record-exports/status' && m === 'GET') { send(res, 200, { outstanding: await store.pendingExportCount() }); return; }
      if (route === '/record-exports/settings') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can configure record exports.' }); return; }
        if (m === 'GET') { send(res, 200, { recordTypes: EXPORT_RECORD_TYPES, settings: await store.exportSettings() }); return; }
        if (m === 'PUT') {
          const body = await readJson(req), recordType = String(body.recordType || ''), enabled = body.enabled;
          const destinationKind = String(body.destinationKind || ''), destination = String(body.destination || '').trim();
          const tokenSetting = String(body.tokenSetting || '').trim() || null, namingPattern = String(body.namingPattern || '').trim(), rationale = String(body.rationale || '').trim();
          if (!EXPORT_RECORD_TYPES.includes(recordType)) { send(res, 400, { error: `Choose a supported record type: ${EXPORT_RECORD_TYPES.join(', ')}.` }); return; }
          if (typeof enabled !== 'boolean' || !['folder', 'https'].includes(destinationKind) || !destination || destination.length > 1000) { send(res, 400, { error: 'Choose on or off, a folder or HTTPS destination, and a destination value.' }); return; }
          if (destinationKind === 'folder' && !path.isAbsolute(destination)) { send(res, 400, { error: 'Folder destinations must be absolute paths on the server.' }); return; }
          if (destinationKind === 'https') { try { const u = new URL(destination); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(); } catch { send(res, 400, { error: 'HTTPS destinations need an https URL without embedded credentials, query parameters or fragments.' }); return; } }
          if ((destinationKind === 'https' && (!tokenSetting || !/^[A-Z][A-Z0-9_]{0,63}$/.test(tokenSetting))) || (destinationKind === 'folder' && tokenSetting)) { send(res, 400, { error: 'HTTPS destinations require a server setting name such as FLIGHT_EXPORT_TOKEN. Folder destinations do not use a token.' }); return; }
          if (destinationKind === 'https' && !exportTargetAllowed(tokenSetting, destination)) { send(res, 400, { error: `The server operator has not bound ${tokenSetting} to ${new URL(destination).origin}. Ask them to add it to FLIGHT_EXPORT_CREDENTIALS on the server; only a bound setting is ever sent.` }); return; }
          if (namingPattern.length > 160 || !namingPattern.includes('{exportId}') || !namingPattern.includes('{recordId}') || /[\\/]/.test(namingPattern.replaceAll('{recordType}', '').replaceAll('{recordId}', '').replaceAll('{exportId}', ''))) { send(res, 400, { error: 'The naming pattern must include {recordId} and {exportId}, may include {recordType}, and cannot contain path separators.' }); return; }
          if (rationale.length < 3 || rationale.length > 500) { send(res, 400, { error: 'Enter a change rationale from 3 to 500 characters.' }); return; }
          const oldValue = await store.exportSetting(recordType);
          const setting = { recordType, enabled, destinationKind, destination, tokenSetting, namingPattern, updatedBy: session.username, rationale };
          let saved;
          await store.transaction(async tx => { saved = await tx.putExportSetting(setting); await tx.audit(session.username, 'record-export-setting', { recordType, oldValue, newValue: saved, rationale }); return true; });
          send(res, 200, { setting: saved }); return;
        }
      }
      if (route === '/record-exports/jobs' && m === 'GET') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read record export delivery logs.' }); return; }
        const jobs = await store.exportJobs(200);
        send(res, 200, { jobs: await Promise.all(jobs.map(async job => ({ ...job, payload: undefined, history: await store.exportLog(job.id, 100) }))) }); return;
      }
      const exportRetry = /^\/record-exports\/jobs\/(JOB-[A-F0-9]+)\/retry$/.exec(route);
      if (exportRetry && m === 'POST') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can retry record exports.' }); return; }
        const current = await store.exportJob(exportRetry[1]);
        if (!current) { send(res, 404, { error: 'Record export job not found.' }); return; }
        if (current.status !== 'failed') { send(res, 409, { error: `This export is ${current.status}; only a failed delivery can be retried.` }); return; }
        const job = await store.retryExportJob(current.id, session.username);
        if (!job) { send(res, 409, { error: 'This export changed before the retry could be queued. Reload the delivery history and try again.' }); return; }
        void drainExports();
        send(res, 202, { id: job.id, status: job.status, exportId: job.exportId }); return;
      }
      // -- lockouts: listed and cleared by a manager, one named user at a time, with a reason, audited --
      if (route === '/auth/lockouts' && m === 'GET') { if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can see lockouts.' }); return; } send(res, 200, { lockouts: await store.lockouts() }); return; }
      if (route === '/auth/unlock' && m === 'POST') {
        if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can unlock an account.' }); return; }
        const body = await readJson(req), username = String(body.username || '').trim().toLowerCase(), reason = String(body.reason || '').trim();
        const r = await unlockAccount(store, username, reason, session.username);
        send(res, r.status, r.body); return;
      }
      if (route === '/auth/hash-report' && m === 'GET') { if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read the password hash report.' }); return; } await wrapped; send(res, 200, { params: SCRYPT, ...await hashReport() }); return; }
      if (route === '/audit' && m === 'GET') { if (!manages(session.account)) { send(res, 403, { error: 'Only a Master Access or QA Manager account can read the audit log.' }); return; } send(res, 200, { rows: await store.auditRows(Number(url.searchParams.get('limit')) || 200) }); return; }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e.status === 413) { send(res, 413, { error: e.message, limit: MAX_REQUEST_BYTES }, { Connection: 'close' }); return; }
      if (e.status === 400) { send(res, 400, { error: e.message }); return; }
      internalError(res, req, e);
    }
  }

  // Issue #174: once per start, after the server listens, the archive "__proto__" scan (the one
  // tools/scan-archive-proto.mjs runs) reads this server's own store through a separate read-only connection and logs
  // one line. It never writes, and a failure is a warning: the server keeps serving. A store handed in as
  // options.store or an in-memory database has no second connection to open, so it is not checked.
  const archiveScanOpen = options.archiveScanOpen || (options.store || (!databaseUrl && dbPath === ':memory:') ? null : () => databaseUrl ? openPostgresReadOnly(databaseUrl) : openDbReadOnly(dbPath, { live: true }));
  // The connection string can carry a password, so neither it nor the password appears in a log line.
  const redact = text => { let out = String(text); if (databaseUrl) { out = out.split(databaseUrl).join('[connection string]'); try { const pw = decodeURIComponent(new URL(databaseUrl).password || ''); if (pw) out = out.split(pw).join('[password]'); } catch {} } return out; };
  const checkArchive = async () => {
    if (!archiveScanOpen) return { skipped: true };
    try {
      const reader = await archiveScanOpen();
      let result;
      try { result = await scanArchiveProto(host.MES, reader); } finally { await reader.close(); }
      const { scanned, flagged, unreadable } = result;
      const counts = `${scanned} row${scanned === 1 ? '' : 's'} scanned, ${flagged.length} flagged`;
      if (!flagged.length && !unreadable.length) { log(`archive __proto__ check: ${counts}`); return result; }
      const named = [...flagged.map(f => `${f.id} own "__proto__" key at ${f.at}`), ...unreadable.map(id => `${id} not checked, its stored JSON does not parse`)].join('; ');
      warn(`WARNING archive __proto__ check: ${counts}${unreadable.length ? `, ${unreadable.length} unreadable` : ''}: ${named}.${flagged.length ? ' Content under that key is outside the record\'s signatures.' : ''} Send this line to the QA Manager; nothing was changed.`);
      return result;
    } catch (error) {
      const message = redact(error && error.message ? error.message : error);
      warn(`WARNING archive __proto__ check could not finish: ${message}. Nothing was changed and the server keeps running. Run node tools/scan-archive-proto.mjs to check the archive.`);
      return { error: message };
    }
  };

  server = http.createServer((req, res) => { handle(req, res); });
  server.store = store; server.host = host; server.validState = validState; server.ready = storeReady.then(async () => { await wrapped; await verifyStoredCalibrationArchive(); void drainExports(); });
  // Bind address: 127.0.0.1 unless options.host, FLIGHT_HOST or --host names another.
  // Once listening, the archive check starts on a later turn of the event loop, so startup does not wait for it.
  server.listenAsync = async (port, host = options.host || process.env.FLIGHT_HOST || DEFAULT_HOST) => {
    await server.ready;
    const bound = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); }); });
    server.archiveCheck ||= new Promise(resolve => setImmediate(resolve)).then(checkArchive);
    return bound;
  };
  // The code to show in the server console, or null once the first account exists.
  server.firstRunSetupCode = async () => { await storeReady; return (await store.accounts()).length ? null : setupCode; };
  server.closeAsync = async () => { await wrapped.catch(() => {}); await server.archiveCheck; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await exportDrain?.catch(() => {}); await store.close(); };
  return server;
}

// The store a command line names: --db picks SQLite; otherwise --database-url or FLIGHT_DATABASE_URL picks
// PostgreSQL; otherwise FLIGHT_DB or data/flight.sqlite. Operator tools use this so they open the same store.
export function storeSettings(arg, env = process.env) {
  const dbOverride = arg('db', null);
  return {
    dbPath: dbOverride || env.FLIGHT_DB || path.join(ROOT, 'data', 'flight.sqlite'),
    databaseUrl: arg('database-url', dbOverride ? null : env.FLIGHT_DATABASE_URL || null)
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const { dbPath, databaseUrl } = storeSettings(arg);
  const openCliStore = async () => databaseUrl ? openPostgres(databaseUrl) : openDb(dbPath);
  const backupTo = arg('backup', null), restoreFrom = arg('restore', null), unlockUser = arg('unlock', null);
  if (unlockUser) {
    // node server/server.mjs --db data/datum.sqlite --unlock <username> --reason "..." --by <your name>
    const store = await openCliStore();
    const by = String(arg('by', '') || '').trim();
    const r = by.length < 2 ? { status: 400, body: { error: 'Say who is unlocking with --by <name>. It goes in the audit trail.' } } : await unlockAccount(store, String(unlockUser).trim().toLowerCase(), String(arg('reason', '') || '').trim(), `cli:${by}`);
    await store.close();
    if (r.status === 200) console.log(`Unlocked ${r.body.username}. Recorded in the audit trail.`); else { console.error(r.body.error); process.exit(1); }
  } else if (backupTo) {
    // Online backup of the whole database (record, accounts, audit, evidence) while the service runs.
    const store = await openCliStore();
    try { const pages = await store.backup(backupTo), count = (await store.evidenceList()).length; await store.close(); console.log(`${databaseUrl ? 'PostgreSQL dump' : 'Backup'} written to ${backupTo}${databaseUrl ? '' : ` (${pages} pages, ${count} evidence items)`}.`); }
    catch (e) { console.error(`Backup failed: ${e.message}`); await store.close(); process.exit(1); }
  } else if (restoreFrom) {
    // Offline restore of a pg_dump custom-format archive into the PostgreSQL target.
    // Stop the server first when restoring into its database.
    if (!databaseUrl) { console.error('Restore targets PostgreSQL only: pass --database-url <connection string>.'); process.exit(1); }
    const { restorePostgres } = await import('./db-postgres.mjs');
    try { await restorePostgres(databaseUrl, restoreFrom); console.log(`Restored ${restoreFrom} into the PostgreSQL database. Every session in the backup was ended, so everyone signs in again. Start the server normally; it verifies the audit chain on startup and refuses a tampered restore.`); }
    catch (e) { console.error(`Restore failed: ${e.message} The restore runs as one transaction, so it left the database unchanged.`); process.exit(1); }
  } else {
  const host = arg('host', process.env.FLIGHT_HOST || DEFAULT_HOST);
  const server = createServer({ dbPath, databaseUrl, host, ...(process.argv.includes('--serve-demo') ? { serveDemo: true } : {}) });
  server.listenAsync(Number(arg('port', process.env.PORT || 8080)), host).then(port => {
    const a = server.address();
    console.log(`Flight System server listening on ${a.address}:${port} (${a.address === '127.0.0.1' || a.address === '::1' ? 'loopback only: this machine and its reverse proxy' : 'bound as --host or FLIGHT_HOST asked: allow it only behind a firewall or on a trusted network'}) (db ${server.store.db.location ? server.store.db.location() : 'sqlite'})`);
    server.firstRunSetupCode().then(code => { if (code) console.log(`First-run setup code: ${code}\nEnter it on the Set up Master Access screen to create the first account. It is not needed again once that account exists.`); }).catch(() => {});
  }, e => { console.error(`Flight System server could not listen on ${host}: ${e.message}. Check --host names an address on this machine and the port is free.`); process.exit(1); });
  }
}
