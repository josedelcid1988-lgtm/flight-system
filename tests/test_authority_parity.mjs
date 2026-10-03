// Authority cross-check (RFC #594, step 1). "What may this account do" is answered in four places: the browser's
// window.skAuth in index.html, the server's engine host (server/mes-host.mjs rolesOf, trainingCurrent, grantValid,
// capsOf), the server's own route gates in server/server.mjs (accountRoles, manages) and the test helper
// tests/lib/roles.mjs. This suite builds one set of accounts and workspaces, asks the browser and the server the
// same questions, and fails on any answer that differs: role by role, capability by capability, the manager route
// gate, Support Access, and the inspector signature against the inspection stamp gate.
//
// Disagreements already reported and not yet fixed are listed in KNOWN with their issue. A listed disagreement
// keeps the suite green and is printed; a listed one that no longer happens fails ("now agrees, remove it from
// KNOWN"), so the list cannot go stale. Nothing is skipped.
//
// The second half pins today's behavior at the boundaries (RFC step 5 subset): capabilities per role, extra roles
// pausing and resuming on training, grant hash tamper, self-grant refusal text, reason length bands, and the
// sign-in lockout (5 failures, 5 minutes, cleared on success, storage key skyryse-mes-lockout-v1) on both sides,
// with the clock moved by the test instead of waiting.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';
import { createServer, makeHash } from '../server/server.mjs';
import { assignTestRoles } from './lib/roles.mjs';

const TESTS = decodeURI(new URL('.', import.meta.url).pathname);
const ROOT = path.resolve(TESTS, '..');
const FIXTURES = process.env.FS_FIXTURES_DIR ? process.env.FS_FIXTURES_DIR.replace(/\/?$/, '/') : TESTS + 'fixtures/';
const PROD = 'file://' + FIXTURES + 'publish.html';
const AUTH = 'skyryse-mes-auth-v1', SESSION = 'skyryse-mes-session-v1', LOCKOUT = 'skyryse-mes-lockout-v1';
const PASSWORD = 'parity-pass-123', PIN = '4821', FAIR_ORDER = 'WO-10004';

let pass = 0;
const fails = [], errors = [];
const ok = (what, cond, detail = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + detail)); if (cond) pass += 1; else fails.push(what); };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const pacificDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const day = offset => pacificDay(Date.now() + offset * 86400000);

// ---------------------------------------------------------------- known disagreements
// Each entry names one fixture, one question and the exact answers it gives today (browser or first rule, server or
// second rule). A different disagreement on the same question is not masked. Remove an entry in the pull request
// that fixes its issue.
const KNOWN = [
  { issue: 580, fixture: 'extra-qm-lapsed', check: 'manager route GET /audit', browser: 'false', server: 'true' },
  { issue: 580, fixture: 'extra-qm-missing-record', check: 'manager route GET /audit', browser: 'false', server: 'true' },
  { issue: 580, fixture: 'extra-qm-no-role-training', check: 'manager route GET /audit', browser: 'false', server: 'true' },
  // The same #580 gap seen inside the server: its engine host pauses the role, its route gate does not.
  { issue: 580, fixture: 'extra-qm-lapsed', check: 'manager route (server host roleOf vs route)', browser: 'false', server: 'true' },
  { issue: 580, fixture: 'extra-qm-missing-record', check: 'manager route (server host roleOf vs route)', browser: 'false', server: 'true' },
  { issue: 580, fixture: 'extra-qm-no-role-training', check: 'manager route (server host roleOf vs route)', browser: 'false', server: 'true' }
];
const knownKey = (fixture, check) => `${fixture} | ${check}`;
ok('KNOWN has no repeated entry', new Set(KNOWN.map(k => knownKey(k.fixture, k.check))).size === KNOWN.length);

// ---------------------------------------------------------------- the server engine host and the base workspace
const host = createHost(path.join(ROOT, 'index.html'));
const { MES } = host;
const ROLE_KEYS = host.roles.ROLES.map(role => role.key);
const ALL_CAPS = [...new Set(Object.values(host.roles.ROLE_CAPS).flat())].sort();
const base = MES.upgrade(structuredClone(JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/demo/seed-curated.json'), 'utf8'))));
// The curated FAIR on WO-10004 has two characteristics without results. Filling them makes box 20 reachable,
// so the signature probe reaches the stamp check instead of stopping at the FAIR review.
for (const ch of base.orders.find(order => order.id === FAIR_ORDER).fair.chars) if (!ch.result) Object.assign(ch, { result: '2.751', inspector: 'Master Access', date: day(-1), tool: 'CAL-01', ok: true });
ok('the base workspace (curated demo seed) validates', MES.validate(base), JSON.stringify(MES.diagnose ? MES.diagnose(base) : null));

const account = (username, role, more = {}) => ({ username, displayName: `Parity ${username}`, role, roles: [role], ...more });
const GRANTOR = account('fx-grantor', 'qm');
const OTHER = account('fx-other', 'qe');
const asGrantor = (state, fn) => host.withAccount(GRANTOR, () => fn(state), state);
const recordTraining = (state, username, code, expires) => {
  const r = asGrantor(state, s => MES.recordTraining(s, { account: username, code, expires: day(400), note: 'parity fixture' }));
  if (!r.ok) throw new Error(`training for ${username}: ${r.message}`);
  if (expires < day(1)) lapse(state.trainingRecords.find(rec => rec.id === r.id), expires);
};
// A lapsed record stands for an older imported record whose expiry has passed. The engine refuses to record an
// expiry in the past, and a signed record binds its expiry, so the fixture keeps it as an unsigned imported row.
function lapse(rec, expires) { rec.expires = expires; delete rec.trainerSignature; }
const grantFor = (username, cap, { by = GRANTOR, trainingCode = 'ESD', reason = 'Qualified by current recorded training.' } = {}) => {
  const who = { name: by.displayName, credentialId: `ACCT-${by.username}`, account: by.username }, at = new Date().toISOString();
  return { by: who, at, reason, trainingCode, hash: sha256(MES.canonical({ account: username, authority: cap, action: 'granted', by: who, at, reason, trainingCode })) };
};
// Give the subject the curated Quality stamp SKY-0002 with a PIN, then apply the variant. Its dates are set from
// today, not taken from the seed, so the active fixtures stay active whatever day the suite runs.
const giveStamp = (state, subject, patch = {}) => {
  const stamp = state.stamps.find(s => s.number === 'SKY-0002');
  Object.assign(stamp, { account: subject.username, issued: day(-30), expires: day(400), qualifications: (stamp.qualifications || []).map(q => ({ ...q, expires: day(400) })) });
  const pin = host.withAccount(subject, () => MES.setStampPin(state, stamp.id, PIN, PIN), state);
  if (!pin.ok) throw new Error(`stamp PIN for ${subject.username}: ${pin.message}`);
  Object.assign(stamp, patch);
};

// ---------------------------------------------------------------- fixtures
const fixtures = [];
const fx = (id, role, more = {}, build = () => {}) => {
  const subject = account(id, role, more);
  const state = structuredClone(base);
  build(state, subject);
  fixtures.push({ id, subject, state });
};
for (const role of ROLE_KEYS) fx(`role-${role}`, role);
fx('role-unknown', 'pilot');
// Inspection stamp variants (Quality role). SKY-0002 is issued and expires in the seed; the variant changes one fact.
for (const role of ['qe', 'qs', 'qm', 'admin']) fx(`stamp-active-${role}`, role, {}, (s, u) => giveStamp(s, u));
fx('stamp-expired', 'qe', {}, (s, u) => giveStamp(s, u, { expires: day(-30) }));
fx('stamp-not-yet-issued', 'qe', {}, (s, u) => giveStamp(s, u, { issued: day(30) }));
fx('stamp-suspended', 'qe', {}, (s, u) => giveStamp(s, u, { status: 'Suspended' }));
fx('stamp-retired', 'qe', {}, (s, u) => giveStamp(s, u, { status: 'Retired' }));
fx('stamp-other-account', 'qe', {}, s => giveStamp(s, OTHER));
fx('stamp-technician-type', 'qe', {}, (s, u) => giveStamp(s, u, { buyoffType: 'Technician', type: 'Production' }));
fx('stamp-expansion-current', 'qe', {}, (s, u) => { recordTraining(s, u.username, 'FOD', day(400)); giveStamp(s, u, { expansionTraining: 'FOD' }); });
fx('stamp-expansion-lapsed', 'qe', {}, (s, u) => { recordTraining(s, u.username, 'FOD', day(-2)); giveStamp(s, u, { expansionTraining: 'FOD' }); });
// Extra roles: active only while the training cited for them is current.
const extra = (role, code = 'ESD') => ({ extraRoles: [role], roleTraining: { [role]: { code, at: new Date().toISOString(), by: GRANTOR.username } } });
for (const role of ['qm', 'qs', 'qe', 'me']) {
  fx(`extra-${role}-current`, role === 'qe' ? 'technician' : 'qe', extra(role), (s, u) => recordTraining(s, u.username, 'ESD', day(400)));
  fx(`extra-${role}-lapsed`, role === 'qe' ? 'technician' : 'qe', extra(role), (s, u) => recordTraining(s, u.username, 'ESD', day(-1)));
}
fx('extra-qm-missing-record', 'qe', extra('qm'));
fx('extra-qm-no-role-training', 'qe', { extraRoles: ['qm'] }, (s, u) => recordTraining(s, u.username, 'ESD', day(400)));
fx('extra-unknown-role', 'qe', extra('pilot'), (s, u) => recordTraining(s, u.username, 'ESD', day(400)));
fx('extra-repeats-primary', 'qe', extra('qe'), (s, u) => recordTraining(s, u.username, 'ESD', day(400)));
// Signed grants for conformity and the AQI signature.
const granted = (id, role, cap, grantOptions = {}, trainingExpires = day(400), tamper = g => g) =>
  fx(id, role, { grants: { [cap]: tamper(grantFor(id, cap, grantOptions)) } }, (s, u) => recordTraining(s, u.username, 'ESD', trainingExpires));
granted('grant-conformity-valid', 'qe', 'conformity');
granted('grant-aqi-valid', 'qe', 'aqi-sign');
granted('grant-tampered-hash', 'qe', 'conformity', {}, day(400), g => ({ ...g, hash: g.hash.replace(/^./, c => (c === '0' ? '1' : '0')) }));
granted('grant-tampered-reason', 'qe', 'conformity', {}, day(400), g => ({ ...g, reason: g.reason + ' Edited after signing.' }));
granted('grant-self', 'qe', 'conformity', { by: account('grant-self', 'qe') });
granted('grant-bad-credential', 'qe', 'conformity', {}, day(400), g => ({ ...g, by: { ...g.by, credentialId: 'ACCT-someone-else' } }));
granted('grant-short-reason', 'qe', 'conformity', { reason: 'Too short' });
granted('grant-training-lapsed', 'qe', 'aqi-sign', {}, day(-1));
granted('grant-ineligible-role', 'technician', 'conformity');
granted('grant-revoked', 'qe', 'conformity', {}, day(400), g => ({ ...g, revokedAt: new Date().toISOString(), revokedBy: g.by, revokeReason: 'Revoked for the parity fixture.' }));
// Support Access is an account flag; it changes no role or capability.
fx('support-on', 'qe', { supportAccess: true });
fx('support-off', 'qe', { supportAccess: false });
fx('support-on-admin', 'admin', { supportAccess: true });

for (const f of fixtures) ok(`fixture ${f.id}: the workspace validates`, MES.validate(f.state), JSON.stringify(MES.diagnose ? MES.diagnose(f.state) : null).slice(0, 300));

// ---------------------------------------------------------------- the server, in process
const SETUP_CODE = 'authority-parity-setup';
const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: SETUP_CODE });
const requestHandler = server.listeners('request')[0];
const api = async (method, route, { token, body } = {}) => {
  const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(incoming, { method, url: '/api' + route, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const chunks = [];
  const outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
  const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
  requestHandler(incoming, outgoing);
  await finished;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: outgoing.statusCode, json };
};
const hash = await makeHash(PASSWORD);
const storeAccount = acc => server.store.upsertAccount({ ...acc, salt: '', hash, createdAt: new Date().toISOString(), createdBy: 'parity test' });
for (const acc of [GRANTOR, OTHER, ...fixtures.map(f => f.subject)]) await storeAccount(acc);
// The server holds one workspace for every account. Each fixture's subject has its own username, so one workspace
// carries every fixture's training records and a route gate that reads training sees the same records the browser
// and the engine host saw. Records are renumbered to stay unique; the renumbered copies are kept as unsigned
// imported rows (the signature binds the id), which count the same for training currency.
const serverWorkspace = structuredClone(base);
serverWorkspace.trainingRecords = fixtures.flatMap(f => (f.state.trainingRecords || []).filter(rec => rec.account === f.subject.username))
  .map((rec, i) => { const copy = { ...rec, id: `TRN-${String(i + 1).padStart(5, '0')}` }; delete copy.trainerSignature; return copy; });
ok('the server workspace with every fixture\'s training records validates', MES.validate(serverWorkspace), JSON.stringify(MES.diagnose ? MES.diagnose(serverWorkspace) : null));
ok('the server workspace is stored before the questions are asked', !!(await server.store.putDoc('default', JSON.stringify(serverWorkspace), null, 'parity test')));
for (const f of fixtures.filter(f => f.subject.extraRoles)) ok(`server workspace: ${f.id} reads the same roles as its own fixture`, JSON.stringify(host.rolesOf(f.subject, serverWorkspace)) === JSON.stringify(host.rolesOf(f.subject, f.state)));
const signIn = async username => { const r = await api('POST', '/auth/session', { body: { username, password: PASSWORD } }); if (r.status !== 200) throw new Error(`server sign-in ${username}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };

// ---------------------------------------------------------------- the browser
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
const browserUsers = [GRANTOR, OTHER, ...fixtures.map(f => f.subject)].map(acc => ({ ...acc, salt: '00', hash: sha256(`00:${PASSWORD}`), createdAt: new Date().toISOString(), createdBy: 'parity test' }));
await page.goto(PROD);
await page.evaluate(([AUTH, users]) => localStorage.setItem(AUTH, JSON.stringify({ users })), [AUTH, browserUsers]);
await page.reload();
await page.waitForFunction(() => window.skAuth && window.MES && typeof state !== 'undefined');

// ---------------------------------------------------------------- the questions, asked of each side
const signatureProbe = (fn, state) => { const r = fn(structuredClone(state)); return { ok: r.ok === true, message: r.message || '' }; };
const serverHostAnswers = f => {
  const { subject, state } = f;
  const caps = host.capsOf(subject, state);
  return {
    roles: [...host.rolesOf(subject, state)].sort(), role: host.roleOf(subject, state), caps,
    stampGate: MES.hasValidInspectionStamp(state, subject.username),
    signature: host.withAccount(subject, () => signatureProbe(s => MES.verifyFair(s, FAIR_ORDER, { pin: PIN }), state), state),
    approves: caps.includes('approve-wo')
  };
};
const browserAnswers = f => page.evaluate(([SESSION, username, fx, ORDER, PIN, ALL_CAPS]) => {
  state = fx;
  sessionStorage.setItem(SESSION, username);
  const caps = ALL_CAPS.filter(cap => skAuth.can(cap));
  const r = MES.verifyFair(structuredClone(fx), ORDER, { pin: PIN });
  return {
    roles: [...skAuth.rolesOf(username)].sort(), role: skAuth.role(), caps,
    stampGate: MES.hasValidInspectionStamp(fx, username),
    signature: { ok: r.ok === true, message: r.message || '' },
    approves: caps.includes('approve-wo'), supportAccess: skAuth.actor().supportAccess === true
  };
}, [SESSION, f.subject.username, f.state, FAIR_ORDER, PIN, ALL_CAPS]);
const serverRouteAnswers = async f => {
  const session = await signIn(f.subject.username);
  return { audit: (await api('GET', '/audit?limit=1', { token: session.token })).status, supportAccess: session.account.supportAccess === true };
};

const rows = [];
const compare = (fixture, check, browserValue, serverValue) => {
  const b = JSON.stringify(browserValue), s = JSON.stringify(serverValue);
  rows.push({ fixture, check, agree: b === s, browser: b, server: s });
};
for (const f of fixtures) {
  const b = await browserAnswers(f), h = serverHostAnswers(f), r = await serverRouteAnswers(f);
  compare(f.id, 'roles', b.roles, h.roles);
  compare(f.id, 'administering role', b.role, h.role);
  for (const cap of ALL_CAPS) compare(f.id, `cap ${cap}`, b.caps.includes(cap), h.caps.includes(cap));
  // The browser and the server host both read the account's administering role; the server's routes use manages().
  compare(f.id, 'manager route GET /audit', ['qm', 'admin'].includes(b.role), r.audit === 200);
  compare(f.id, 'manager route (server host roleOf vs route)', ['qm', 'admin'].includes(h.role), r.audit === 200);
  compare(f.id, 'Support Access flag', b.supportAccess, r.supportAccess);
  compare(f.id, 'FAIR box 20 signature', b.signature, h.signature);
  // One engine, two stamp rules: an account whose Quality stamp may not inspect may not sign the FAIR either.
  // Asked only of accounts the FAIR gate admits (approve-wo); for anyone else the role refusal answers first.
  // Master Access signs through its recorded override without a stamp (AGENTS.md), so it is not asked.
  if (b.approves && b.role !== 'admin') compare(f.id, 'browser: FAIR box 20 signature vs inspection stamp gate', b.signature.ok, b.stampGate);
  if (h.approves && h.role !== 'admin') compare(f.id, 'server host: FAIR box 20 signature vs inspection stamp gate', h.signature.ok, h.stampGate);
  f.answers = { browser: b, host: h, route: r };
}

// The probes must be able to say yes as well as no, or a broken probe would agree with itself.
const byId = Object.fromEntries(fixtures.map(f => [f.id, f.answers]));
ok('probe control: a current Quality stamp holder signs FAIR box 20 on both sides', byId['stamp-active-qe'].browser.signature.ok && byId['stamp-active-qe'].host.signature.ok, JSON.stringify([byId['stamp-active-qe'].browser.signature, byId['stamp-active-qe'].host.signature]));
ok('probe control: a suspended stamp is refused the signature on both sides', !byId['stamp-suspended'].browser.signature.ok && !byId['stamp-suspended'].host.signature.ok);
ok('probe control: a QA Manager reads GET /audit and a Quality account does not', byId['role-qm'].route.audit === 200 && byId['role-qe'].route.audit === 403, JSON.stringify([byId['role-qm'].route, byId['role-qe'].route]));
ok('probe control: Master Access signs FAIR box 20 through its override, with no stamp, on both sides', byId['role-admin'].browser.signature.ok && byId['role-admin'].host.signature.ok && !byId['role-admin'].host.stampGate);
ok('probe control: Support Access reads true when set', byId['support-on'].browser.supportAccess && byId['support-on'].route.supportAccess);

// ---------------------------------------------------------------- verdict on the cross-check
const disagreements = rows.filter(row => !row.agree);
const knownKeys = new Map(KNOWN.map(k => [knownKey(k.fixture, k.check), k]));
console.log(`\nauthority cross-check: ${fixtures.length} fixtures, ${rows.length} questions, ${disagreements.length} disagreements`);
if (disagreements.length) {
  console.log('  fixture | question | browser (or first rule) | server (or second rule) | status');
  for (const row of disagreements) { const k = knownKeys.get(knownKey(row.fixture, row.check)); console.log(`  ${row.fixture} | ${row.check} | ${row.browser} | ${row.server} | ${k ? `known, #${k.issue}` : 'NEW'}`); }
}
for (const row of disagreements) {
  const k = knownKeys.get(knownKey(row.fixture, row.check));
  const same = k && k.browser === row.browser && k.server === row.server;
  ok(`${row.fixture}: ${row.check} agrees${same ? ` (known disagreement #${k.issue})` : ''}`, same, k ? `browser ${row.browser}, server ${row.server}; KNOWN #${k.issue} expects browser ${k.browser}, server ${k.server}` : `browser ${row.browser}, server ${row.server}; not in KNOWN`);
}
for (const k of KNOWN) {
  const row = rows.find(r => r.fixture === k.fixture && r.check === k.check);
  ok(`KNOWN #${k.issue} ${k.fixture} | ${k.check} still disagrees`, row && !row.agree, row ? `now agrees, remove it from KNOWN (#${k.issue})` : 'no such fixture or question; fix or remove the KNOWN entry');
}
ok('every fixture asked every capability on both sides', rows.filter(r => r.check.startsWith('cap ')).length === fixtures.length * ALL_CAPS.length);

// ---------------------------------------------------------------- the test helper (tests/lib/roles.mjs)
// Other suites add roles through assignTestRoles. The account and workspace it leaves must read the same on both sides.
{
  await page.evaluate(([AUTH, SESSION, users, fx]) => { localStorage.setItem(AUTH, JSON.stringify({ users })); state = fx; sessionStorage.setItem(SESSION, users[0].username); }, [AUTH, SESSION, browserUsers, base]);
  const assigned = await assignTestRoles(page, { 'role-technician': ['qe'] });
  const after = await page.evaluate(([AUTH, username]) => ({ account: JSON.parse(localStorage.getItem(AUTH)).users.find(u => u.username === username), state, roles: skAuth.rolesOf(username), caps: skAuth.users().find(u => u.username === username).caps }), [AUTH, 'role-technician']);
  ok('tests/lib/roles.mjs: assignTestRoles adds the role', assigned === true && after.roles.includes('qe'), JSON.stringify([assigned, after.roles]));
  ok('tests/lib/roles.mjs: the server host reads the same roles from the account it leaves', JSON.stringify([...after.roles].sort()) === JSON.stringify([...host.rolesOf(after.account, after.state)].sort()), JSON.stringify([after.roles, host.rolesOf(after.account, after.state)]));
  ok('tests/lib/roles.mjs: the server host reads the same capabilities', JSON.stringify([...after.caps].sort()) === JSON.stringify([...host.capsOf(after.account, after.state)].sort()), JSON.stringify([after.caps, host.capsOf(after.account, after.state)]));
  await page.evaluate(([AUTH, users]) => localStorage.setItem(AUTH, JSON.stringify({ users })), [AUTH, browserUsers]);
}

// ---------------------------------------------------------------- boundary: capabilities per role (pinned)
// Today's capabilities for each primary role, with a current assigned Quality stamp and no grants. Conformity and
// aqi-sign never come from a role alone. A change here is a rule change and needs its own review.
const PINNED_CAPS = {
  admin: 'accept-software adjust-wo approve-nc approve-pedigree approve-wi approve-wo assign-work configure-org configure-qms configure-training create-wo dispo-nc edit-wi inspect-steps manage-access mrb-cert mrb-eng mrb-me mrb-quality operate operate-steps peer-review-wi plan-order post-notice push-software raise-nc request-pedigree safety-buyoff set-sensitivity split submit-ecr view',
  general: 'raise-nc submit-ecr view',
  technician: 'operate-steps raise-nc submit-ecr view',
  operator: 'approve-pedigree operate operate-steps raise-nc request-pedigree split submit-ecr view',
  ops: 'adjust-wo approve-pedigree assign-work configure-org configure-training create-wo dispo-nc edit-wi operate operate-steps plan-order post-notice raise-nc request-pedigree split submit-ecr view',
  me: 'adjust-wo approve-pedigree assign-work create-wo dispo-nc edit-wi mrb-me operate operate-steps peer-review-wi push-software raise-nc request-pedigree split submit-ecr view',
  swe: 'accept-software mrb-eng push-software raise-nc submit-ecr view',
  qe: 'approve-nc approve-pedigree approve-wi approve-wo assign-work inspect-steps mrb-quality raise-nc request-pedigree submit-ecr view',
  safety: 'raise-nc safety-buyoff submit-ecr view',
  cert: 'mrb-cert raise-nc submit-ecr view',
  qs: 'approve-nc approve-pedigree approve-wi approve-wo assign-work configure-org configure-training inspect-steps manage-access mrb-quality post-notice raise-nc request-pedigree submit-ecr view',
  qm: 'accept-software adjust-wo approve-nc approve-pedigree approve-wi approve-wo assign-work configure-org configure-qms configure-training create-wo dispo-nc edit-wi inspect-steps manage-access mrb-eng mrb-me mrb-quality operate operate-steps peer-review-wi plan-order post-notice push-software raise-nc request-pedigree safety-buyoff set-sensitivity split submit-ecr view'
};
ok('the pinned table covers every role', JSON.stringify(Object.keys(PINNED_CAPS).sort()) === JSON.stringify([...ROLE_KEYS].sort()), JSON.stringify(ROLE_KEYS));
for (const role of ROLE_KEYS) {
  const subject = account(`pin-${role}`, role), state = structuredClone(base);
  giveStamp(state, subject);
  const serverCaps = [...host.capsOf(subject, state)].sort().join(' ');
  const browserCaps = await page.evaluate(([AUTH, SESSION, users, subject, fx, ALL_CAPS]) => {
    localStorage.setItem(AUTH, JSON.stringify({ users: [...users, { ...subject, salt: '00', hash: '00' }] }));
    state = fx; sessionStorage.setItem(SESSION, subject.username);
    return ALL_CAPS.filter(cap => skAuth.can(cap)).sort().join(' ');
  }, [AUTH, SESSION, browserUsers, subject, state, ALL_CAPS]);
  ok(`${role}: capabilities are the pinned set on the server host`, serverCaps === PINNED_CAPS[role], serverCaps);
  ok(`${role}: capabilities are the pinned set in the browser`, browserCaps === PINNED_CAPS[role], browserCaps);
}
await page.evaluate(([AUTH, users]) => localStorage.setItem(AUTH, JSON.stringify({ users })), [AUTH, browserUsers]);

// ---------------------------------------------------------------- boundary: an extra role pauses and resumes on training
{
  const subject = account('pause-resume', 'qe', extra('qm'));
  const current = structuredClone(base); recordTraining(current, subject.username, 'ESD', day(400));
  const lapsed = structuredClone(current); lapsed.trainingRecords.forEach(rec => { if (rec.account === subject.username) lapse(rec, day(-1)); });
  const resumed = structuredClone(lapsed); recordTraining(resumed, subject.username, 'ESD', day(400));
  const browserRoles = async fx => page.evaluate(([AUTH, SESSION, users, subject, fx]) => {
    localStorage.setItem(AUTH, JSON.stringify({ users: [...users, { ...subject, salt: '00', hash: '00' }] }));
    state = fx; sessionStorage.setItem(SESSION, subject.username);
    return { active: skAuth.rolesOf(subject.username), all: skAuth.rolesOf(subject.username, true), approves: skAuth.can('manage-access') };
  }, [AUTH, SESSION, browserUsers, subject, fx]);
  const steps = [['current', current, true], ['lapsed', lapsed, false], ['resumed', resumed, true]];
  for (const [name, fx, active] of steps) {
    const b = await browserRoles(fx), s = host.rolesOf(subject, fx);
    ok(`extra role, training ${name}: QA Manager is ${active ? 'active' : 'paused'} in the browser`, b.active.includes('qm') === active && b.approves === active, JSON.stringify(b));
    ok(`extra role, training ${name}: QA Manager is ${active ? 'active' : 'paused'} on the server host`, s.includes('qm') === active && host.capsOf(subject, fx).includes('manage-access') === active, JSON.stringify(s));
    ok(`extra role, training ${name}: the paused role is kept on the account, not revoked`, b.all.includes('qm'), JSON.stringify(b.all));
  }
  await page.evaluate(([AUTH, users]) => localStorage.setItem(AUTH, JSON.stringify({ users })), [AUTH, browserUsers]);
}

// ---------------------------------------------------------------- boundary: grant hash tamper
{
  const valid = byId['grant-conformity-valid'], tampered = byId['grant-tampered-hash'], edited = byId['grant-tampered-reason'];
  ok('a signed conformity grant with current training is held on both sides', valid.browser.caps.includes('conformity') && valid.host.caps.includes('conformity'));
  ok('a grant whose hash was changed is refused on both sides', !tampered.browser.caps.includes('conformity') && !tampered.host.caps.includes('conformity'));
  ok('a grant whose reason was edited after signing is refused on both sides', !edited.browser.caps.includes('conformity') && !edited.host.caps.includes('conformity'));
  ok('a self-signed grant is refused on both sides', !byId['grant-self'].browser.caps.includes('conformity') && !byId['grant-self'].host.caps.includes('conformity'));
}

// ---------------------------------------------------------------- boundary: self-grant and reason bands, exact text
const SELF_GRANT = 'Nobody grants or revokes their own authority. Another QA Manager must do it.';
const SELF_ROLES = 'Nobody changes their own roles. Another QA Manager, Quality Supervisor, or Master Access account must do it.';
const SELF_SUPPORT = 'A Master Access account cannot grant Support Access to itself.';
const GRANT_REASON_BROWSER = 'Give the reason in 10 to 300 characters. It is kept with the grant.';
const ROLES_REASON_BROWSER = 'Give the reason in 10 to 300 characters. It is kept in this device\'s security log.';
const SUPPORT_REASON = 'Give the reason in 10 to 500 characters.';
const GRANT_REASON_SERVER = 'Give the reason in 10 to 300 characters.';
const reasonOf = n => 'r'.repeat(n);
const MASTER = account('fx-master', 'admin');
const TARGET = account('fx-target', 'qe');
{
  const users = [...browserUsers, ...[MASTER, TARGET].map(acc => ({ ...acc, salt: '00', hash: '00' }))];
  const asBrowser = (who, fn, args) => page.evaluate(([AUTH, SESSION, users, who, fx, fnText, args]) => {
    localStorage.setItem(AUTH, JSON.stringify({ users })); state = fx; sessionStorage.setItem(SESSION, who);
    return (0, eval)(fnText)(...args);
  }, [AUTH, SESSION, users, who, base, fn.toString(), args]);
  const setGrant = (who, target, reason) => asBrowser(who, (t, r) => skAuth.setGrant(t, 'conformity', false, r, ''), [target, reason]);
  const setRoles = (who, target, reason) => asBrowser(who, (t, r) => skAuth.setRoles(t, ['qe'], r, ''), [target, reason]);
  const setSupport = (who, target, reason) => asBrowser(who, (t, r) => skAuth.setSupportAccess(t, false, r), [target, reason]);
  const refusedWith = (result, text) => result.ok === false && result.message === text;
  const selfGrantResult = await asBrowser(GRANTOR.username, u => skAuth.setGrant(u, 'conformity', true, 'Granting myself on purpose.', 'ESD'), [GRANTOR.username]);
  ok('browser: granting your own authority is refused with today\'s text', refusedWith(selfGrantResult, SELF_GRANT), JSON.stringify(selfGrantResult));
  const selfRolesResult = await setRoles(GRANTOR.username, GRANTOR.username, 'Changing my own roles on purpose.');
  ok('browser: changing your own roles is refused with today\'s text', refusedWith(selfRolesResult, SELF_ROLES), JSON.stringify(selfRolesResult));
  const selfSupportResult = await asBrowser(MASTER.username, u => skAuth.setSupportAccess(u, true, 'Granting myself support.'), [MASTER.username]);
  ok('browser: Master Access granting itself Support Access is refused with today\'s text', refusedWith(selfSupportResult, SELF_SUPPORT), JSON.stringify(selfSupportResult));
  for (const [n, refused] of [[9, true], [10, false], [300, false], [301, true]]) {
    const g = await setGrant(GRANTOR.username, TARGET.username, reasonOf(n));
    ok(`browser: a grant reason of ${n} characters is ${refused ? 'refused' : 'accepted'}`, refused ? !g.ok && g.message === GRANT_REASON_BROWSER : g.ok === true, JSON.stringify(g));
    const r = await setRoles(GRANTOR.username, TARGET.username, reasonOf(n));
    ok(`browser: a role change reason of ${n} characters is ${refused ? 'refused' : 'accepted'}`, refused ? !r.ok && r.message === ROLES_REASON_BROWSER : r.ok === true, JSON.stringify(r));
  }
  for (const [n, refused] of [[9, true], [10, false], [500, false], [501, true]]) {
    const s = await setSupport(MASTER.username, TARGET.username, reasonOf(n));
    ok(`browser: a Support Access reason of ${n} characters is ${refused ? 'refused' : 'accepted'}`, refused ? !s.ok && s.message === SUPPORT_REASON : s.ok === true, JSON.stringify(s));
  }
  await page.evaluate(([AUTH, users]) => localStorage.setItem(AUTH, JSON.stringify({ users })), [AUTH, browserUsers]);

  await storeAccount(MASTER); await storeAccount(TARGET);
  const qm = (await signIn(GRANTOR.username)).token, master = (await signIn(MASTER.username)).token;
  const access = (token, body) => api('POST', '/auth/access', { token, body });
  const selfGrant = await access(qm, { action: 'grant', username: GRANTOR.username, cap: 'conformity', reason: 'Granting myself on purpose.', trainingCode: 'ESD' });
  ok('server: granting your own authority is refused 403 with today\'s text', selfGrant.status === 403 && selfGrant.json.error === SELF_GRANT, JSON.stringify(selfGrant));
  const selfSupport = await access(master, { action: 'support', username: MASTER.username, on: true, reason: 'Granting myself support.' });
  ok('server: Master Access granting itself Support Access is refused 403 with today\'s text', selfSupport.status === 403 && selfSupport.json.error === SELF_SUPPORT, JSON.stringify(selfSupport));
  const selfRoles = await access(qm, { action: 'roles', username: GRANTOR.username, roles: ['qm'], reason: 'Changing my own roles on purpose.' });
  ok('server: changing your own roles is refused 403 with today\'s text', selfRoles.status === 403 && selfRoles.json.error === SELF_ROLES, JSON.stringify(selfRoles));
  for (const [n, refused] of [[9, true], [10, false], [300, false], [301, true]]) {
    const r = await access(qm, { action: 'roles', username: TARGET.username, roles: ['qe'], reason: reasonOf(n) });
    ok(`server: a role change reason of ${n} characters is ${refused ? 'refused' : 'accepted'}`, refused ? r.status === 400 && r.json.error === GRANT_REASON_SERVER : r.status === 200, JSON.stringify(r));
  }
  for (const [n, refused] of [[9, true], [10, false], [300, false], [301, true]]) {
    const r = await access(qm, { action: 'revoke', username: TARGET.username, cap: 'conformity', reason: reasonOf(n) });
    ok(`server: a grant reason of ${n} characters is ${refused ? 'refused' : 'accepted'}`, refused ? r.status === 400 && r.json.error === GRANT_REASON_SERVER : r.status === 200 && r.json.message === 'Not granted.', JSON.stringify(r));
  }
  for (const [n, refused] of [[9, true], [10, false], [500, false], [501, true]]) {
    const r = await access(master, { action: 'support', username: TARGET.username, on: false, reason: reasonOf(n) });
    ok(`server: a Support Access reason of ${n} characters is ${refused ? 'refused' : 'accepted'}`, refused ? r.status === 400 && r.json.error === SUPPORT_REASON : r.status === 200, JSON.stringify(r));
  }
}

// ---------------------------------------------------------------- boundary: sign-in lockout, browser
// The page's clock is fixed by the test and moved forward; no waiting for five minutes.
{
  const T0 = Date.parse('2030-03-04T17:00:00Z');
  const lockPage = await context.newPage();
  lockPage.on('pageerror', e => errors.push(e.message));
  await lockPage.clock.setFixedTime(T0);
  await lockPage.goto(PROD);
  await lockPage.evaluate(([AUTH, LOCKOUT, users]) => { localStorage.setItem(AUTH, JSON.stringify({ users })); localStorage.removeItem(LOCKOUT); sessionStorage.clear(); }, [AUTH, LOCKOUT, browserUsers]);
  await lockPage.reload();
  await lockPage.waitForSelector('#sk-username');
  const attempt = async (username, password) => lockPage.evaluate(async ([username, password, SESSION]) => {
    const err = document.getElementById('sk-login-error'); err.textContent = '';
    document.getElementById('sk-username').value = username; document.getElementById('sk-password').value = password;
    document.getElementById('sk-login-submit').disabled = false;
    document.getElementById('sk-username').closest('form').requestSubmit();
    for (let i = 0; i < 200 && !err.textContent && sessionStorage.getItem(SESSION) !== username; i += 1) await new Promise(r => requestAnimationFrame(r));
    const signedIn = sessionStorage.getItem(SESSION) === username;
    if (signedIn) sessionStorage.removeItem(SESSION);
    return { signedIn, message: err.textContent };
  }, [username, password, SESSION]);
  const lockRow = username => lockPage.evaluate(([LOCKOUT, username]) => (JSON.parse(localStorage.getItem(LOCKOUT) || '{}'))[username] || null, [LOCKOUT, username]);
  const who = 'role-technician';
  for (let i = 1; i <= 4; i += 1) await attempt(who, 'wrong-password');
  ok('browser: four failed sign-ins do not lock the account', JSON.stringify(await lockRow(who)) === JSON.stringify({ fails: 4, until: 0 }), JSON.stringify(await lockRow(who)));
  const fifth = await attempt(who, 'wrong-password');
  ok('browser: the fifth failed sign-in locks the account for 5 minutes', fifth.message === 'Incorrect password. Account locked for 5 minutes.' && JSON.stringify(await lockRow(who)) === JSON.stringify({ fails: 0, until: T0 + 5 * 60000 }), JSON.stringify([fifth, await lockRow(who)]));
  const blocked = await attempt(who, PASSWORD);
  ok('browser: the right password is refused while locked', !blocked.signedIn && blocked.message === 'Too many failed attempts. Try again in 5 minutes.', JSON.stringify(blocked));
  await lockPage.clock.setFixedTime(T0 + 5 * 60000 - 1000);
  const stillLocked = await attempt(who, PASSWORD);
  ok('browser: still locked one second before the 5 minutes end', !stillLocked.signedIn && stillLocked.message === 'Too many failed attempts. Try again in 1 minute.', JSON.stringify(stillLocked));
  await lockPage.clock.setFixedTime(T0 + 5 * 60000);
  const after = await attempt(who, PASSWORD);
  ok('browser: the right password signs in once the 5 minutes end, and the lockout is cleared', after.signedIn && JSON.stringify(await lockRow(who)) === JSON.stringify({ fails: 0, until: 0 }), JSON.stringify([after, await lockRow(who)]));
  const other = 'role-operator';
  for (let i = 1; i <= 4; i += 1) await attempt(other, 'wrong-password');
  const success = await attempt(other, PASSWORD);
  ok('browser: a successful sign-in clears earlier failures', success.signedIn && JSON.stringify(await lockRow(other)) === JSON.stringify({ fails: 0, until: 0 }), JSON.stringify(await lockRow(other)));
  ok('browser: failures are kept under the storage key skyryse-mes-lockout-v1', await lockPage.evaluate(LOCKOUT => Object.keys(localStorage).filter(k => /lockout/.test(k)).join() === LOCKOUT && !!localStorage.getItem(LOCKOUT), LOCKOUT));
  const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('index.html keeps the lockout policy LOCK_KEY skyryse-mes-lockout-v1, 5 failures, 5 minutes', source.includes("var LOCK_KEY='skyryse-mes-lockout-v1',LOCK_AFTER=5,LOCK_MINUTES=5;"));
  await lockPage.close();
}

// ---------------------------------------------------------------- boundary: sign-in lockout, server
// The server's lockout reads Date.now(); the test replaces it for this block and restores it.
{
  const realNow = Date.now;
  let now = Date.parse('2030-03-04T17:00:00Z');
  Date.now = () => now;
  try {
    const who = 'role-technician', signin = password => api('POST', '/auth/session', { body: { username: who, password } });
    for (let i = 1; i <= 4; i += 1) await signin('wrong-password');
    ok('server: four failed sign-ins do not lock the account', (await server.store.lockout(who)).fails === 4 && (await server.store.lockout(who)).until === 0, JSON.stringify(await server.store.lockout(who)));
    const fifth = await signin('wrong-password');
    ok('server: the fifth failed sign-in locks the account for 5 minutes', fifth.status === 401 && fifth.json.error === 'Incorrect username or password. Account locked for 5 minutes.' && (await server.store.lockout(who)).until === now + 5 * 60000, JSON.stringify([fifth, await server.store.lockout(who)]));
    const locked = await signin(PASSWORD);
    ok('server: the right password is refused 423 while locked', locked.status === 423 && locked.json.error === 'Too many failed attempts. Try again in 5 minutes.', JSON.stringify(locked));
    now += 5 * 60000 - 1000;
    const late = await signin(PASSWORD);
    ok('server: still locked one second before the 5 minutes end', late.status === 423 && late.json.error === 'Too many failed attempts. Try again in 1 minute.', JSON.stringify(late));
    now += 1000;
    const open = await signin(PASSWORD);
    ok('server: the right password signs in once the 5 minutes end, and the lockout is cleared', open.status === 200 && (await server.store.lockout(who)).fails === 0 && (await server.store.lockout(who)).until === 0, JSON.stringify([open.status, await server.store.lockout(who)]));
    const other = 'role-operator';
    for (let i = 1; i <= 4; i += 1) await api('POST', '/auth/session', { body: { username: other, password: 'wrong-password' } });
    const success = await api('POST', '/auth/session', { body: { username: other, password: PASSWORD } });
    ok('server: a successful sign-in clears earlier failures', success.status === 200 && (await server.store.lockout(other)).fails === 0, JSON.stringify(await server.store.lockout(other)));
  } finally { Date.now = realNow; }
}

await browser.close();
server.close?.();
console.log(`\nchecks ${pass + fails.length} pass ${pass} fail ${fails.length} skip 0`);
console.log('FAILS ' + JSON.stringify(fails));
console.log('errors ' + JSON.stringify(errors));
// A browser page error fails the suite on its own too, not only through the suite runner's reading of this line.
process.exit(fails.length || errors.length ? 1 : 0);
