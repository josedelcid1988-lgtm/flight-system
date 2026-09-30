// #130: superseded calibration entries move out of the live log into the server archive, so the log does not fill up.
// The latest entry for every tool and every entry a live buy-off cites stay in the log. The live log keeps a sealed
// reference to what left it: each archive record lists the archived entries and the hash-chain gaps they leave, and it
// is signed (person, credential, time, SHA-256 manifest). The chain still verifies across the gaps, so removing the
// reference or an entry around it fails validation. Archived entries keep their signatures unchanged in the server
// archive. Only a QA Manager or Master Access account may archive, and only on the shared server. Near the 5,000-entry
// limit the calibration log says what to do next. Every rule is checked with the change it refuses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createHost } from '../server/mes-host.mjs';
import { createServer } from '../server/server.mjs';
import { chromium } from 'playwright';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const host = createHost(indexPath);
const { MES } = host;
const qa = { username: 'qa-manager', displayName: 'Quinn Manager', role: 'qm' };
const tech = { username: 'tech-one', displayName: 'Terry Tech', role: 'tech' };
let checks = 0;
const check = (name, result, detail = '') => { checks += 1; assert.ok(result, `${name}${detail ? `: ${detail}` : ''}`); console.log(`ok ${name}`); };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const canonicalPayload = value => JSON.stringify(value, (key, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val).sort().reduce((o, k) => { o[k] = val[k]; return o; }, {}) : val);
const now = '2026-10-01T19:00:00.000Z';
const tool = { description: 'DIGITAL CALIPER', torque: false, serial: '', calibratedAt: '2026-09-28', expires: '2027-09-28', status: 'In Calibration', location: '', note: 'Lab cert 42' };
const as = (account, state, fn) => host.withAccount(account, fn, state);
const ids = log => log.map(e => e.id);

// A log with superseded entries for three tools and one tool with a single entry:
//   00001 ARC-A recorded      00002 ARC-B recorded (only entry)   00003 ARC-A corrects 00001   00004 ARC-C recorded
//   00005 ARC-A recalibrated  00006 ARC-C retired                 00007 ARC-C returned to service with a reason
//   00008 ARC-T torque tool   00009 ARC-T corrects 00008
const build = () => {
  const s = MES.seed();
  const rec = (tag, extra = {}) => { const r = as(qa, s, () => MES.recordCalibration(s, { ...tool, tag, ...extra })); assert.ok(r.ok, r.message); return r.id; };
  const fix = (id, patch) => { const r = as(qa, s, () => MES.updateCalibration(s, id, patch)); assert.ok(r.ok, r.message); return r.id; };
  const a1 = rec('ARC-A');
  rec('ARC-B');
  fix(a1, { note: 'Lab cert 43' });
  const c1 = rec('ARC-C');
  rec('ARC-A', { note: 'Recalibrated' });
  const c2 = fix(c1, { status: 'Retired', note: 'Dropped and cracked' });
  fix(c2, { status: 'In Calibration', note: 'Retired by mistake, the tool is sound' });
  const t1 = rec('ARC-T', { description: 'TORQUE WRENCH', torque: true });
  fix(t1, { note: 'Lab cert 50' });
  return s;
};

const state = build();
const before = structuredClone(state);
const superseded = ['CALLOG-00001', 'CALLOG-00003', 'CALLOG-00004', 'CALLOG-00006', 'CALLOG-00008'];
const kept = ['CALLOG-00002', 'CALLOG-00005', 'CALLOG-00007', 'CALLOG-00009'];
check('the starting log validates and verifies', MES.validate(state) && MES.verifyManifests(state).ok && state.calibrationLog.length === 9);
check('the archivable entries are the superseded ones: the latest entry per tool is never archivable', typeof MES.calibrationArchivable === 'function' && JSON.stringify(MES.calibrationArchivable(state)) === JSON.stringify(superseded), JSON.stringify(MES.calibrationArchivable?.(state)));

// The refusal path: only configure-qms (QA Manager, Master Access) may archive. Nothing changes on a refusal.
const refused = as(tech, state, () => MES.recordCalibrationArchive(state));
check('a technician is refused, with a plain reason naming who can archive', refused && !refused.ok && /QA Manager or Master Access/.test(refused.message) && !/—/.test(refused.message), refused?.message);
check('the refused archive leaves the log and its head unchanged', canonicalPayload(state.calibrationLog) === canonicalPayload(before.calibrationLog) && canonicalPayload(state.calibrationLogHead) === canonicalPayload(before.calibrationLogHead));

// The QA Manager archives: the superseded entries leave the live log, the workspace stays valid and the chain verifies.
const archived = as(qa, state, () => MES.recordCalibrationArchive(state));
check('a QA Manager archives the superseded entries', archived.ok && archived.id === 'CALARC-0001' && archived.count === 5, JSON.stringify(archived));
check('the live log keeps the latest entry for every tool, in order', JSON.stringify(ids(state.calibrationLog)) === JSON.stringify(kept));
check('the workspace validates after the archive', MES.validate(state), MES.diagnose(state)?.detail);
check('the calibration chain verifies across the archived gaps', MES.calibrationChainProblem(state) === null, JSON.stringify(MES.calibrationChainProblem(state)));
check('every signature in the workspace verifies after the archive', MES.verifyManifests(state).ok, JSON.stringify(MES.verifyManifests(state).failures));
check('the entries left in the log are unchanged, signatures included', state.calibrationLog.every(e => canonicalPayload(e) === canonicalPayload(before.calibrationLog.find(x => x.id === e.id))));
check('the head counts the live log', state.calibrationLogHead.count === 4 && state.calibrationLogHead.hash === MES.calibrationEntryHash(state.calibrationLog[3]));
const record = state.calibrationLogHead.archived?.[0];
const m = record?.manifest;
check('the head carries one signed archive record', Array.isArray(state.calibrationLogHead.archived) && state.calibrationLogHead.archived.length === 1 && record.id === 'CALARC-0001');
check('the archive record names the person, their credential and the time, with a SHA-256 manifest', m && m.meaning === 'Calibration entries archived' && m.signer.name === 'Quinn Manager' && typeof m.signer.credentialId === 'string' && m.signer.credentialId.length > 0 && m.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(m.hash) && !Number.isNaN(Date.parse(m.at)) && m.subject.by === `${m.signer.name} · ${m.signer.credentialId}`);
check('the archive record lists the archived entries by id and tool', JSON.stringify(m.subject.entries.map(e => e.id)) === JSON.stringify(superseded) && m.subject.entries.every(e => e.tag === before.calibrationLog.find(x => x.id === e.id).tag) && m.subject.count === 5);
check('the archive record carries one SHA-256 over the archived entries exactly as they were signed', m.subject.digest === sha256(canonicalPayload(before.calibrationLog.filter(e => superseded.includes(e.id)))));
check('each archive summary is what MES.calibrationArchiveSummary gives for the archived entry', m.subject.entries.every(s => canonicalPayload(s) === canonicalPayload(MES.calibrationArchiveSummary(before.calibrationLog.find(e => e.id === s.id)))));
check('the archive reports how many entries the log holds now, in plain text', /5 superseded calibration entries/.test(archived.message) && /4 entries/.test(archived.message) && !/—/.test(archived.message), archived.message);

// Point of use does not change: the latest entry for each tool decides, as before.
for (const tag of ['ARC-A', 'ARC-B', 'ARC-C', 'ARC-T']) check(`${tag} reads the same at point of use after the archive`, JSON.stringify(MES.toolCheck(tag, now, state)) === JSON.stringify(MES.toolCheck(tag, now, before)));
check('the returned-to-service tool stays usable and its current entry is still the reinstatement', MES.toolCheck('ARC-C', now, state).ok && MES.calibrationStatus(state, 'ARC-C').id === 'CALLOG-00007');

// The history rules still hold after the archive, against what was archived.
const torqueDrop = as(qa, state, () => MES.recordCalibration(state, { ...tool, tag: 'ARC-T', description: 'TORQUE WRENCH', torque: false }));
check('a torque tool stays one after its earlier entries are archived', !torqueDrop.ok && /torque tool and stays one/.test(torqueDrop.message));
const nextId = as(qa, state, () => MES.recordCalibration(state, { ...tool, tag: 'ARC-D' }));
check('new entry numbers keep rising after an archive', nextId.ok && nextId.id === 'CALLOG-00010' && MES.validate(state));
const corrected = as(qa, state, () => MES.updateCalibration(state, 'CALLOG-00005', { note: 'Lab cert 44' }));
check('the current entry of a tool with archived history is corrected as before', corrected.ok && MES.validate(state) && MES.verifyManifests(state).ok);

// A second archive picks up the newly superseded entry, next to an earlier gap, and the chain still verifies.
const second = as(qa, state, () => MES.recordCalibrationArchive(state));
check('a second archive moves the newly superseded entry', second.ok && second.id === 'CALARC-0002' && second.count === 1 && !state.calibrationLog.some(e => e.id === 'CALLOG-00005'));
check('the workspace validates after an archive next to an earlier one', MES.validate(state) && MES.calibrationChainProblem(state) === null && MES.verifyManifests(state).ok, MES.diagnose(state)?.detail);
const nothing = as(qa, state, () => MES.recordCalibrationArchive(state));
check('with nothing superseded left, the archive is refused and says why', !nothing.ok && /No superseded calibration entries/.test(nothing.message) && state.calibrationLogHead.archived.length === 2, nothing.message);

// Removing the sealed reference, or any part of it, fails validation with a plain reason.
const noSeal = structuredClone(state);
delete noSeal.calibrationLogHead.archived;
check('removing the archive reference from the head fails validation', !MES.validate(noSeal));
check('diagnose says an entry or an archive record was removed and what to do', /archive record was removed|does not link to/.test(MES.diagnose(noSeal)?.detail || '') && /Restore the workspace/.test(MES.diagnose(noSeal)?.detail || '') && !/\u2014/.test(MES.diagnose(noSeal)?.detail || ''), MES.diagnose(noSeal)?.detail);
check('the chain names the broken link when the archive reference is removed', /does not link to|entries before it were removed/.test(MES.calibrationChainProblem(noSeal)?.detail || ''), MES.calibrationChainProblem(noSeal)?.detail);
const oneRecordGone = structuredClone(state);
oneRecordGone.calibrationLogHead.archived.shift();
check('removing one archive record fails validation', !MES.validate(oneRecordGone));
const summaryChanged = structuredClone(state);
summaryChanged.calibrationLogHead.archived[0].manifest.subject.entries[0].status = 'Retired';
check('changing an archived entry summary breaks the archive record signature', !MES.validate(summaryChanged));
const gapChanged = structuredClone(state);
gapChanged.calibrationLogHead.archived[0].manifest.subject.gaps.pop();
gapChanged.calibrationLogHead.archived[0].manifest.hash = MES.sha256(MES.canonical(gapChanged.calibrationLogHead.archived[0].manifest.subject));
check('a re-signed record that drops a gap still fails the chain', !MES.validate(gapChanged));
const survivorGone = structuredClone(state);
survivorGone.calibrationLog.splice(1, 1);
check('removing a live entry next to an archived gap fails validation', !MES.validate(survivorGone));
const restored = structuredClone(state);
restored.calibrationLog.unshift(structuredClone(before.calibrationLog[0]));
check('an archived entry put back into the live log fails validation', !MES.validate(restored));
const tail = structuredClone(state);
tail.calibrationLog.pop();
check('a truncated tail still fails validation after an archive', !MES.validate(tail));
const unsigned = structuredClone(state);
unsigned.calibrationLogHead.archived[1].manifest.signer.role = 'Technician';
unsigned.calibrationLogHead.archived[1].manifest.subject.signerRole = 'Technician';
unsigned.calibrationLogHead.archived[1].manifest.hash = MES.sha256(MES.canonical(unsigned.calibrationLogHead.archived[1].manifest.subject));
check('an archive record signed by a role without calibration authority fails validation', !MES.validate(unsigned));

// A superseded entry that a live buy-off cites stays in the log.
{
  const fixture = readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8');
  const ref = MES.upgrade(JSON.parse(fixture.match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]));
  const order = ref.orders.find(o => o.status !== 'Closed' && o.operations.some(op => op.buyoff && Array.isArray(op.buyoff.tools) && op.buyoff.tools.length));
  const op = order.operations.find(x => x.buyoff && Array.isArray(x.buyoff.tools) && x.buyoff.tools.length), tag = op.buyoff.tools[0].tag;
  const cited = as(qa, ref, () => MES.recordCalibration(ref, { ...tool, tag, description: op.buyoff.tools[0].description, torque: undefined }));
  op.buyoff.tools[0] = { ...op.buyoff.tools[0], source: 'Calibration log', calibrationEntry: cited.id };
  op.buyoff.at = new Date(Date.parse(ref.calibrationLog.find(e => e.id === cited.id).recordedAt) + 60000).toISOString();
  const newer = as(qa, ref, () => MES.recordCalibration(ref, { ...tool, tag, description: op.buyoff.tools[0].description, torque: undefined, note: 'Recalibrated' }));
  check('the cited entry is superseded by a newer calibration and the workspace validates', cited.ok && newer.ok && MES.validate(ref), MES.diagnose(ref)?.detail);
  check('an entry a live buy-off cites is not archivable', !MES.calibrationArchivable(ref).includes(cited.id));
  const skip = as(qa, ref, () => MES.recordCalibrationArchive(ref));
  check('an archive with only a cited superseded entry is refused and the cited entry stays', !skip.ok && ref.calibrationLog.some(e => e.id === cited.id) && MES.validate(ref), skip.message);
}

// Entries recorded before the chain existed carry no link, so they stay in the log; the chained ones archive.
{
  const legacy = build();
  legacy.calibrationLog.slice(0, 4).forEach(e => { delete e.previousHash; });
  legacy.calibrationLog[4].previousHash = MES.calibrationEntryHash(legacy.calibrationLog[3]);
  for (let i = 5; i < legacy.calibrationLog.length; i += 1) legacy.calibrationLog[i].previousHash = MES.calibrationEntryHash(legacy.calibrationLog[i - 1]);
  const log = legacy.calibrationLog;
  legacy.calibrationLogHead = { count: log.length, hash: MES.calibrationEntryHash(log[log.length - 1]), legacyCount: 4, sealedAt: now, legacyHash: MES.calibrationLegacyHash(log.slice(0, 4)) };
  check('a partly legacy log validates', MES.validate(legacy), MES.diagnose(legacy)?.detail);
  check('unlinked legacy entries are not archivable', JSON.stringify(MES.calibrationArchivable(legacy)) === JSON.stringify(['CALLOG-00006', 'CALLOG-00008']), JSON.stringify(MES.calibrationArchivable(legacy)));
  const r = as(qa, legacy, () => MES.recordCalibrationArchive(legacy));
  check('the chained superseded entries of a partly legacy log archive and it still validates', r.ok && r.count === 2 && MES.validate(legacy) && MES.verifyManifests(legacy).ok, MES.diagnose(legacy)?.detail);
}

// The capacity warning: within 10% of the 5,000-entry limit, the calibration log says what to do next.
check('the log limit and warning point are exported', MES.CALIBRATION_LOG_LIMIT === 5000 && MES.calibrationCapacity(before).near === false && MES.calibrationCapacity(before).count === 9);
const nearState = MES.seed();
as(qa, nearState, () => { for (let i = 0; i < 4500; i += 1) { const r = MES.recordCalibration(nearState, { ...tool, tag: `NEAR-${String(i % 50).padStart(3, '0')}`, note: `Lab cert ${i}` }); if (!r.ok) throw new Error(r.message); } });
check('4,500 entries is within 10% of the limit', MES.calibrationCapacity(nearState).near === true && MES.calibrationCapacity(nearState).count === 4500 && MES.validate(nearState));
const nearText = MES.calibrationCapacity(nearState).message;
check('the warning says how full the log is and what to do next, in plain text', /4,500 of 5,000/.test(nearText) && /archive superseded entries/i.test(nearText) && !/—/.test(nearText), nearText);
check('4,499 entries is not yet near the limit', MES.calibrationCapacity({ ...nearState, calibrationLog: nearState.calibrationLog.slice(0, 4499) }).near === false);
const full = structuredClone(before);
while (full.calibrationLog.length < 5000) full.calibrationLog.push({ id: `FILLER-${full.calibrationLog.length}` });
const fullRefusal = as(qa, full, () => MES.recordCalibration(full, { ...tool, tag: 'FULL-001' }));
check('the full-log refusal now tells a QA Manager to archive superseded entries', !fullRefusal.ok && /5,000/.test(fullRefusal.message) && /archive superseded entries/i.test(fullRefusal.message) && !/cannot be removed or archived/.test(fullRefusal.message), fullRefusal.message);

// The exported helpers are read-only, and the archive action is a reviewed server command.
for (const name of ['calibrationArchivable', 'calibrationArchiveSummary', 'calibrationArchivedEntries', 'calibrationCapacity']) check(`MES.${name} is exported and not remotely callable`, typeof MES[name] === 'function' && host.resolveAction(`MES.${name}`) === null);
check('MES.recordCalibrationArchive is a reviewed server command', typeof host.resolveAction('MES.recordCalibrationArchive') === 'function');
{
  const s = structuredClone(before);
  as(qa, s, () => MES.recordCalibrationArchive(s));
  check('the server write gate accepts an archive that lists exactly the removed entries', MES.calibrationLogChanges(before, s) === null, MES.calibrationLogChanges(before, s));
  const moved = MES.calibrationArchivedEntries(before, s);
  check('the server takes the archived entries from its stored copy, unchanged, with their record id', JSON.stringify(moved.map(x => x.entry.id)) === JSON.stringify(superseded) && moved.every(x => x.recordId === 'CALARC-0001' && canonicalPayload(x.entry) === canonicalPayload(before.calibrationLog.find(e => e.id === x.entry.id))));
  const forged = structuredClone(s);
  forged.calibrationLogHead.archived[0].manifest.subject.entries[1] = { ...forged.calibrationLogHead.archived[0].manifest.subject.entries[1], status: 'Quarantined' };
  check('the server write gate refuses an archive record whose summary does not match the stored entry', /archive/.test(MES.calibrationLogChanges(before, forged) || ''), MES.calibrationLogChanges(before, forged));
  const rewritten = structuredClone(s);
  rewritten.calibrationLogHead.archived = [];
  check('the server write gate refuses a write that drops an archive record it holds', /archive record/.test(MES.calibrationLogChanges(s, rewritten) || ''), MES.calibrationLogChanges(s, rewritten));
}

// Server: the archive runs as a server action, the archived entries are stored unchanged and can be read back.
const hashPw = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
const makeServer = () => {
  const server = createServer({ dbPath: ':memory:', quiet: true, indexPath, setupCode: 'archive-setup' });
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
const account = (username, displayName, role) => ({ username, displayName, role, salt: 's', hash: hashPw('s', 'arc-pass-123') });
const signIn = async (call, username) => (await call('POST', '/api/auth/session', { body: { username, password: 'arc-pass-123' } })).json.token;
// The first account is Master Access (configure-qms, signs as System Administrator); it then adds a technician.
const setUpAccounts = async call => {
  const first = await call('PUT', '/api/auth/accounts', { body: { setupCode: 'archive-setup', users: [account('arc-admin', 'Avery Admin', 'general')] } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const token = await signIn(call, 'arc-admin');
  const users = (await call('GET', '/api/auth/accounts', { token })).json.users.map(u => ({ ...u }));
  const added = await call('PUT', '/api/auth/accounts', { token, body: { users: [...users, account('arc-tech', 'Terry Tech', 'tech')] } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
};
{
  const { server, call } = makeServer();
  await server.ready;
  try {
    await setUpAccounts(call);
    const qmToken = await signIn(call, 'arc-admin'), techToken = await signIn(call, 'arc-tech');
    const put = await call('PUT', '/api/workspace', { token: qmToken, body: before });
    check('the server initializes from the log with superseded entries', put.status === 204, JSON.stringify(put.json));
    let etag = put.etag;
    const techTry = await call('POST', '/api/workspace/actions/MES.recordCalibrationArchive', { token: techToken, etag, body: { args: [] } });
    check('the server refuses the archive for a technician and nothing changes', techTry.status === 403 && /QA Manager or Master Access/.test(techTry.json?.error || '') && JSON.parse(server.store.getDoc('default').json).calibrationLog.length === 9, JSON.stringify(techTry.json));
    const done = await call('POST', '/api/workspace/actions/MES.recordCalibrationArchive', { token: qmToken, etag, body: { args: [] } });
    check('the server archives the superseded entries for a Master Access account', done.status === 200 && done.json.result.ok && done.json.result.count === 5, JSON.stringify(done.json));
    etag = done.json.etag;
    const stored = JSON.parse(server.store.getDoc('default').json);
    check('the stored workspace holds the live log and the archive record, and validates', JSON.stringify(ids(stored.calibrationLog)) === JSON.stringify(kept) && stored.calibrationLogHead.archived.length === 1 && MES.validate(MES.upgrade(structuredClone(stored))));
    const rows = superseded.map(id => server.store.calibrationArchived(id));
    check('each archived entry is stored once, unchanged with its signature, with its SHA-256', rows.every((row, i) => row && canonicalPayload(row.entry) === canonicalPayload(before.calibrationLog.find(e => e.id === superseded[i])) && row.sha256 === sha256(JSON.stringify(row.entry)) && row.recordId === 'CALARC-0001' && row.archivedBy === 'arc-admin'));
    const one = await call('GET', '/api/calibration-archive/CALLOG-00001', { token: techToken });
    check('any signed-in account reads an archived entry, read-only', one.status === 200 && one.json.entry.id === 'CALLOG-00001' && one.json.entry.calibrationSignature.manifest.hash === before.calibrationLog[0].calibrationSignature.manifest.hash && one.json.readOnly === true, JSON.stringify(one.json));
    check('the calibration archive is not readable without a session', (await call('GET', '/api/calibration-archive/CALLOG-00001')).status === 401 && (await call('GET', '/api/calibration-archive')).status === 401);
    const byTag = await call('GET', '/api/calibration-archive?tag=ARC-A', { token: techToken });
    check('the archive lists the archived entries for a tool', byTag.status === 200 && JSON.stringify(byTag.json.entries.map(e => e.id).sort()) === JSON.stringify(['CALLOG-00001', 'CALLOG-00003']), JSON.stringify(byTag.json));
    const missing = await call('GET', '/api/calibration-archive/CALLOG-00002', { token: techToken });
    check('an entry still in the live log is not in the archive, and the answer says where to look', missing.status === 404 && /live calibration log/.test(missing.json?.error || ''), JSON.stringify(missing.json));
    const audit = server.store.db.prepare("SELECT action, detail FROM audit WHERE action = 'calibration-archive'").all();
    check('the archive writes an audit row naming the record', audit.length === 1 && /CALARC-0001/.test(audit[0].detail), JSON.stringify(audit));
    let threw = false;
    try { server.store.putCalibrationArchived({ id: 'CALLOG-00001', tag: 'ARC-A', recordId: 'CALARC-0009', json: '{}', sha256: 'x', by: 'someone' }); } catch { threw = true; }
    check('an archived calibration entry cannot be written twice', threw);
  } finally { server.store.close(); }
}
{
  // A workspace that names archived entries the server does not hold is refused at initialization.
  const { server, call } = makeServer();
  await server.ready;
  try {
    await setUpAccounts(call);
    const token = await signIn(call, 'arc-admin');
    const moved = structuredClone(before);
    as(qa, moved, () => MES.recordCalibrationArchive(moved));
    const init = await call('PUT', '/api/workspace', { token, body: moved });
    check('the server refuses to initialize from a workspace whose archived calibration entries it does not hold', init.status === 422 && /archived calibration entr/.test(init.json?.error || '') && !server.store.getDoc('default'), JSON.stringify(init.json));
  } finally { server.store.close(); }
}

// Standalone (browser storage only): there is no archive store, so the archive is refused and the warning says so.
{
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
    // A log this size is larger than browser storage allows once every manifest carries the build stamp, so it is put
    // into the open page's workspace directly rather than through localStorage. That is also why archiving needs the
    // server: a standalone workspace reaches the browser storage limit before the calibration log limit.
    await page.evaluate(raw => { const near = JSON.parse(raw); state.calibrationLog = near.calibrationLog; state.calibrationLogHead = near.calibrationLogHead; view = 'qms-records'; render(); }, JSON.stringify({ calibrationLog: nearState.calibrationLog, calibrationLogHead: nearState.calibrationLogHead }));
    check('standalone: the page holds the near-limit log and it validates', await page.evaluate(() => state.calibrationLog.length === 4500 && MES.validate(state)));
    const warning = page.locator('#main [data-calibration-capacity]');
    await warning.waitFor({ state: 'visible', timeout: 15000 });
    const text = await warning.innerText();
    check('standalone: the calibration log warns near the limit, with the count and what to do next', /4,500 of 5,000/.test(text) && /server/.test(text) && !/—/.test(text), text);
    check('standalone: no archive button is offered without the shared server', await page.locator('#main [data-calibration-archive]').count() === 0);
    const tried = await page.evaluate(() => { const count = state.calibrationLog.length; const r = MES.recordCalibrationArchive(state); return { ok: r.ok, message: r.message, same: state.calibrationLog.length === count }; });
    check('standalone: the engine refuses the archive and says it needs the shared server', !tried.ok && tried.same && /shared Flight System server/.test(tried.message) && !/—/.test(tried.message), tried.message);
    check('standalone: the archive pages raised no page errors', errors.length === 0, errors.join('; '));
  } finally { await browser.close(); }
}

console.log(`calibration archive: ${checks} checks, all passed`);
