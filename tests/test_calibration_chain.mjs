// The hash-chained calibration log (#116, #117): each entry links to the one before it, the workspace keeps a
// head (entry count and last hash), and the server keeps the stored log append-only. Every rule is checked with
// the change it refuses. Scope: this catches a truncated file, a bad import or a stale copy; the hashes are
// unkeyed SHA-256, so someone who recomputes every hash and the head is not stopped by it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createHost } from '../server/mes-host.mjs';
import { createServer } from '../server/server.mjs';
import { chromium } from 'playwright';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const host = createHost(indexPath);
const { MES } = host;
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
let checks = 0;
const check = (name, result, detail = '') => { checks += 1; assert.ok(result, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const now = '2026-10-01T19:00:00.000Z';
const tool = { description: 'DIGITAL CALIPER', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: 'Lab cert 42' };
const as = (state, fn) => host.withAccount(qa, fn, state);
const relinkHead = ws => { const log = ws.calibrationLog; ws.calibrationLogHead = { ...ws.calibrationLogHead, count: log.length, hash: log.length ? MES.calibrationEntryHash(log[log.length - 1]) : null }; };

// A normal record and correction pass, and the chain is additive to the signatures.
const state = MES.seed();
const first = as(state, () => MES.recordCalibration(state, { ...tool, tag: 'CHAIN-A' }));
const other = as(state, () => MES.recordCalibration(state, { ...tool, tag: 'CHAIN-B' }));
const retired = as(state, () => MES.updateCalibration(state, first.id, { status: 'Retired', note: 'Dropped and cracked' }));
check('a normal record and correction pass validation and manifest verification', first.ok && other.ok && retired.ok && MES.validate(state) && MES.verifyManifests(state).ok);
check('the first entry opens the chain and each later entry links to the one before it', state.calibrationLog[0].previousHash === null && state.calibrationLog.slice(1).every((e, i) => e.previousHash === MES.calibrationEntryHash(state.calibrationLog[i])));
check('the head records the entry count and the hash of the last entry', state.calibrationLogHead.count === 3 && state.calibrationLogHead.hash === MES.calibrationEntryHash(state.calibrationLog[2]) && state.calibrationLogHead.legacyCount === 0);
check('the chain link is not part of the signed subject, so manifests are computed as before', state.calibrationLog.every(e => !Object.hasOwn(e.calibrationSignature.manifest.subject, 'previousHash')));
check('the retired tool is refused at point of use', !MES.toolCheck('CHAIN-A', now, state).ok);

// #116: dropping the final Retired row must not bring the tool back.
const truncated = structuredClone(state);
truncated.calibrationLog.pop();
check('#116 a truncated log fails validation', !MES.validate(truncated));
const truncDiag = MES.diagnose(truncated);
check('diagnose names the head and says the latest entry is missing and what to do', truncDiag?.where === 'calibrationLogHead' && /head records 3/.test(truncDiag.detail) && /latest entry is missing/.test(truncDiag.detail) && /Restore the workspace/.test(truncDiag.detail), truncDiag?.detail);
check('#116 the diagnose text has no em dash', !/—/.test(truncDiag.detail));
const truncUpgraded = MES.upgrade(structuredClone(truncated));
check('#116 upgrading a truncated log does not reseal it, so the retired tool cannot come back by truncation', !truncUpgraded || !MES.validate(truncUpgraded));
const headless = structuredClone(truncated);
delete headless.calibrationLogHead;
const headlessUp = MES.upgrade(structuredClone(headless));
check('a truncated import that also lost its head is not resealed on upgrade', !headlessUp || (headlessUp.calibrationLogHead === undefined && !MES.validate(headlessUp)));
check('diagnose says a linked log without a head cannot rule out missing entries', /no recorded head/.test(MES.diagnose(headless)?.detail || ''));
const emptied = structuredClone(state);
emptied.calibrationLog = [];
check('emptying the whole log is detected by the head', !MES.validate(emptied) && /latest 3 entries are missing/.test(MES.diagnose(emptied)?.detail || ''));

// A removed middle entry breaks the link, even when the head is rewritten to match.
const middle = structuredClone(state);
middle.calibrationLog.splice(1, 1);
relinkHead(middle);
check('a removed middle entry fails validation even with a matching head', !MES.validate(middle));
check('diagnose names the entry whose link broke', MES.diagnose(middle)?.where === state.calibrationLog[2].id && /does not link to/.test(MES.diagnose(middle)?.detail || ''));
const firstGone = structuredClone(state);
firstGone.calibrationLog.shift();
relinkHead(firstGone);
check('a removed first entry fails validation and the chain says the entries before it were removed', !MES.validate(firstGone) && /entries before it were removed/.test(MES.calibrationChainProblem(firstGone)?.detail || ''));
const swapped = structuredClone(state);
swapped.calibrationLog[2] = { ...swapped.calibrationLog[2], note: 'changed after signing' };
check('a changed last entry fails validation', !MES.validate(swapped));
const extra = structuredClone(state), extraRow = structuredClone(state.calibrationLog[1]);
delete extraRow.previousHash;
extraRow.id = 'CALLOG-00009';
extra.calibrationLog.push(extraRow);
check('an unlinked entry after linked entries fails validation', !MES.validate(extra) && /no link to the entry before it/.test(MES.calibrationChainProblem(extra)?.detail || ''));
const badHead = structuredClone(state);
badHead.calibrationLogHead = { count: 3, hash: 'not-a-hash', legacyCount: 0 };
check('a malformed head fails validation', !MES.validate(badHead) && /head is malformed/.test(MES.diagnose(badHead)?.detail || ''));

// A log recorded before the chain existed still loads: upgrade seals it once, and the chain starts after it.
const legacy = structuredClone(state);
legacy.calibrationLog.forEach(e => { delete e.previousHash; });
delete legacy.calibrationLogHead;
const sealed = MES.upgrade(structuredClone(legacy));
check('a legacy log loads, is sealed once on upgrade and validates', !!sealed && sealed.calibrationLogHead.legacyCount === 3 && sealed.calibrationLogHead.count === 3 && typeof sealed.calibrationLogHead.sealedAt === 'string' && MES.validate(sealed) && MES.verifyManifests(sealed).ok);
const sealedAt = sealed.calibrationLogHead.sealedAt;
const next = as(sealed, () => MES.recordCalibration(sealed, { ...tool, tag: 'CHAIN-C' }));
check('the chain starts at the first new entry after a sealed legacy log', next.ok && sealed.calibrationLog[3].previousHash === MES.calibrationEntryHash(sealed.calibrationLog[2]) && sealed.calibrationLogHead.count === 4 && sealed.calibrationLogHead.sealedAt === sealedAt && MES.validate(sealed));
check('a sealed legacy log keeps its retirement', !MES.toolCheck('CHAIN-A', now, sealed).ok);
const legacyGone = structuredClone(sealed);
legacyGone.calibrationLog.splice(1, 1);
legacyGone.calibrationLog[2].previousHash = MES.calibrationEntryHash(legacyGone.calibrationLog[1]);
relinkHead(legacyGone);
check('a removed legacy entry is detected against the sealed legacy count', !MES.validate(legacyGone) && /before the chain/.test(MES.diagnose(legacyGone)?.detail || ''));
check('the seal carries one hash over every entry recorded before the chain', /^[0-9a-f]{64}$/.test(sealed.calibrationLogHead.legacyHash) && sealed.calibrationLogHead.legacyHash === MES.calibrationLegacyHash(sealed.calibrationLog.slice(0, 3)));
// Every legacy entry is covered by the seal, not only the last one (Codex review on #149).
const legacyResigned = structuredClone(sealed);
legacyResigned.calibrationLog[0].calibrationSignature.manifest.signer.role = 'Technician';
check('a changed signature manifest on an early legacy entry is detected', !MES.validate(legacyResigned) && /no longer matches the seal/.test(MES.calibrationChainProblem(legacyResigned)?.detail || ''));
const legacyNoDigest = structuredClone(sealed);
delete legacyNoDigest.calibrationLogHead.legacyHash;
check('a sealed head without its legacy hash is malformed', !MES.validate(legacyNoDigest) && /head is malformed/.test(MES.calibrationChainProblem(legacyNoDigest)?.detail || ''));
check('an empty log needs no head', MES.validate(MES.seed()) && MES.seed().calibrationLogHead === undefined);

// The exported helpers are read-only: none is remotely callable.
for (const name of ['calibrationChainProblem', 'calibrationEntryHash', 'calibrationLegacyHash', 'calibrationLogChanges']) check(`MES.${name} is exported and not remotely callable`, typeof MES[name] === 'function' && host.resolveAction(`MES.${name}`) === null);
check('calibrationLogChanges accepts an appended log', MES.calibrationLogChanges(truncated, state) === null);
check('calibrationLogChanges refuses a dropped tail with a plain reason', /remove calibration entry CALLOG-00003/.test(MES.calibrationLogChanges(state, truncated) || '') && /append-only/.test(MES.calibrationLogChanges(state, truncated)));
check('calibrationLogChanges refuses a changed entry', /alter or move calibration entry CALLOG-00003/.test(MES.calibrationLogChanges(state, swapped) || ''));

// The hash covers the whole entry, the signature manifest included: canonical drops nested manifest keys, so a
// changed signer role or build on an earlier entry must still break the link (Codex review on #149).
const reSigned = structuredClone(state);
reSigned.calibrationLog[0].calibrationSignature.manifest.signer.role = 'Technician';
check('a changed signature manifest on an earlier entry breaks the link to it', MES.calibrationChainProblem(reSigned)?.id === state.calibrationLog[1].id);
const reBuilt = structuredClone(state);
reBuilt.calibrationLog[2].calibrationSignature.manifest.build = 'v00';
check('a changed signature manifest on the last entry no longer matches the head', MES.calibrationChainProblem(reBuilt)?.id === 'calibrationLogHead');
check('calibrationLogChanges refuses a change to a stored entry\'s signature manifest', /alter or move calibration entry CALLOG-00001/.test(MES.calibrationLogChanges(state, reSigned) || ''));

// Server: a bad import is refused at initialization, and the write gate keeps the stored log append-only.
const sha = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const makeServer = () => {
  const server = createServer({ dbPath: ':memory:', quiet: true, indexPath, setupCode: 'chain-setup' });
  const handler = server.listeners('request')[0];
  const call = async (method, url, { token, body, etag } = {}) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    incoming.method = method; incoming.url = url;
    incoming.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(etag ? { 'if-match': etag } : {}) };
    const chunks = [], outgoing = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    outgoing.writeHead = (status, headers = {}) => { outgoing.statusCode = status; outgoing.etag = headers.ETag || headers.etag || null; return outgoing; };
    const finished = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
    handler(incoming, outgoing);
    await finished;
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: outgoing.statusCode, json, etag: outgoing.etag };
  };
  return { server, call };
};
const signIn = async call => {
  const created = await call('PUT', '/api/auth/accounts', { body: { setupCode: 'chain-setup', users: [{ username: 'chain-admin', displayName: 'Chain Admin', role: 'general', salt: 's', hash: sha('s', 'chain-pass-123') }] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  return (await call('POST', '/api/auth/session', { body: { username: 'chain-admin', password: 'chain-pass-123' } })).json.token;
};
{
  const { server, call } = makeServer();
  await server.ready;
  try {
    const token = await signIn(call);
    const refused = await call('PUT', '/api/workspace', { token, body: truncated });
    check('the server refuses to initialize from a truncated calibration log, with the plain reason', refused.status === 422 && /latest entry is missing/.test(refused.json?.error || ''), JSON.stringify(refused.json));
    const put = await call('PUT', '/api/workspace', { token, body: state });
    check('the server initializes from an intact chained log', put.status === 204, JSON.stringify(put.json));
    let etag = put.etag;
    const recorded = await call('POST', '/api/workspace/actions/MES.recordCalibration', { token, etag, body: { args: [{ ...tool, tag: 'CHAIN-D' }] } });
    check('a normal record through the server extends the chain', recorded.status === 200 && recorded.json.result.ok, JSON.stringify(recorded.json));
    etag = recorded.json.etag;
    const stored = JSON.parse(server.store.getDoc('default').json);
    check('the stored workspace carries the moved head', stored.calibrationLogHead.count === 4 && MES.validate(MES.upgrade(structuredClone(stored))));
    // An engine action that drops the tail and rewrites the head passes MES.validate; the server write gate still
    // refuses it because the stored log is the anchor.
    const original = server.host.MES.addSavedView;
    server.host.MES.addSavedView = ws => { ws.calibrationLog.pop(); relinkHead(ws); return { ok: true, message: 'dropped the last calibration entry' }; };
    let gated;
    try { gated = await call('POST', '/api/workspace/actions/MES.addSavedView', { token, etag, body: { args: [] } }); } finally { server.host.MES.addSavedView = original; }
    check('the server write gate refuses a write that drops a stored calibration entry', gated.status === 422 && /remove calibration entry/.test(gated.json?.error || '') && /append-only/.test(gated.json.error), JSON.stringify(gated.json));
    check('the refused write leaves the stored log unchanged', JSON.parse(server.store.getDoc('default').json).calibrationLog.length === 4 && server.store.getDoc('default').etag === etag);
  } finally { server.store.close(); }
}

// Standalone: a legacy log is sealed on the first load and the seal is written back to browser storage at once, so a
// log shortened before the next save is not resealed as found (Codex review on #149).
{
  const saved = structuredClone(legacy);
  saved.masterWIs = MES.ensureMasterWIs(structuredClone(saved)).masterWIs;
  host.FlightManeuver.ensure(saved);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('./fixtures/publish.html', import.meta.url).href);
    await page.locator('#sk-login').waitFor({ state: 'visible' });
    await page.locator('#sk-displayname').fill('QA Administrator');
    await page.locator('#sk-username').fill('qa-admin');
    await page.locator('#sk-password').fill('qa-admin-pass');
    await page.locator('#sk-confirm').fill('qa-admin-pass');
    await page.locator('#sk-login-submit').click();
    await page.locator('#sk-boot').waitFor({ state: 'hidden', timeout: 15000 });
    await page.evaluate(raw => localStorage.setItem('skyryse-mes-work-order-v1', raw), JSON.stringify(saved));
    await page.reload();
    await page.waitForFunction(() => typeof state === 'object' && Array.isArray(state.calibrationLog) && state.calibrationLog.length === 3, null, { timeout: 15000 });
    // The restored session binds the signed-in credential and saves shortly after load. Wait for that save, or it can
    // land after the shortened copy below is written and put the full log back before the reload (#171).
    await page.waitForFunction(() => { const bound = MES.profileOptionFor(state.profile, state); return !!bound && bound.role === state.profile.role && localStorage.getItem('skyryse-mes-work-order-v1') === JSON.stringify(state); }, null, { timeout: 15000 });
    const stored =await page.evaluate(() => JSON.parse(localStorage.getItem('skyryse-mes-work-order-v1')));
    check('standalone: the first load writes the legacy seal back to browser storage', stored.calibrationLogHead?.legacyCount === 3 && stored.calibrationLogHead?.count === 3 && typeof stored.calibrationLogHead?.sealedAt === 'string' && stored.calibrationLog.length === 3, JSON.stringify(stored.calibrationLogHead));
    const shortened = { ...stored, calibrationLog: stored.calibrationLog.slice(0, 2) };
    await page.evaluate(raw => localStorage.setItem('skyryse-mes-work-order-v1', raw), JSON.stringify(shortened));
    await page.reload();
    await page.locator('.storage-failure h1').waitFor({ state: 'visible', timeout: 15000 });
    check('standalone: a log shortened after the seal was written is refused on the next load', /latest entry is missing/.test(await page.locator('.storage-failure').innerText()));
    // If browser storage refuses the one-time seal (quota), the workspace is not opened and the stored copy is untouched.
    await page.evaluate(raw => localStorage.setItem('skyryse-mes-work-order-v1', raw), JSON.stringify(saved));
    await page.close();
    const full = await context.newPage();
    full.on('pageerror', error => errors.push(error.message));
    await full.addInitScript(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === 'skyryse-mes-work-order-v1' && String(value).includes('calibrationLogHead')) throw new DOMException('quota', 'QuotaExceededError'); return set.call(this, key, value); }; });
    await full.goto(new URL('./fixtures/publish.html', import.meta.url).href);
    // The new tab opens on the sign-in screen, so the alert is read from the page rather than waited for as visible.
    await full.waitForFunction(() => /browser storage refused to save it/.test(document.querySelector('#storage-alert')?.textContent || ''), null, { timeout: 15000 });
    check('standalone: a seal that browser storage refuses stops the load with a plain reason', await full.evaluate(() => { const box = document.querySelector('#storage-alert'); return !box.hidden && /Free browser storage, then try again/.test(box.textContent) && !/\u2014/.test(box.textContent); }));
    check('standalone: the refused seal leaves the stored copy unchanged', await full.evaluate(raw => localStorage.getItem('skyryse-mes-work-order-v1') === raw, JSON.stringify(saved)));
    await full.close();
    check('standalone: the chain pages raised no page errors', errors.length === 0, errors.join('; '));
  } finally { await browser.close(); }
}

console.log(`calibration chain: ${checks} checks, all passed`);
