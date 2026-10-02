// FAIR, 8130-9 and AQI signatures use the same stamp validity rule as an operation buy-off (#579). The signer's
// stamp must have reached its issue date, must not have expired, and an additional stamp must have its training
// current. Each signing action is refused, with the workspace unchanged, for a stamp that is expired, not yet
// issued, or paused for training; it still signs with a current stamp, and with one lapsed and one current stamp
// of an allowed type. The engine is the one the server runs, and one refusal is checked over the action route.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';
import { createServer, makeHash } from '../server/server.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const base = JSON.parse(fs.readFileSync(new URL('../tools/demo/seed-curated.json', import.meta.url), 'utf8'));
let checks = 0;
const check = (name, result, detail = '') => { checks += 1; assert.ok(result, `${name}${detail ? ` -> ${detail}` : ''}`); console.log(`ok ${name}`); };

const PIN = '4826';
const day = offset => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const yesterday = day(-1), tomorrow = day(1), lastYear = day(-365), nextYear = day(365);
const now = new Date().toISOString();

// Authority grants as the server stores them: signed by a QA Manager, citing current training.
const grantor = { account: 'grant-qm', name: 'Grace Manager', credentialId: 'ACCT-grant-qm' };
const grant = (username, cap) => {
  const record = { account: username, authority: cap, action: 'granted', by: grantor, at: now, reason: 'Qualified for this authority.', trainingCode: 'ESD' };
  return { ...record, hash: createHash('sha256').update(MES.canonical(record)).digest('hex') };
};
const account = (username, displayName, caps = []) => ({ username, displayName, role: 'qe', grants: Object.fromEntries(caps.map(cap => [cap, grant(username, cap)])) });
const verifier = account('quality', 'Quinn Quality', ['conformity']);
const reviewer = account('demo', 'Dana Reviewer');
const aqi = account('aqi-insp', 'Avery Inspector', ['aqi-sign']);

// The curated workspace, with the 8130-9 AI stamp assigned to the AQI account, ESD training on record for the
// granted accounts, a PIN on every signer's stamp, the FAIR on WO-10004 ready to verify and the conformity
// package on WO-10002 back at Open with its RFC received.
function fresh() {
  const state = structuredClone(base);
  state.stamps.find(s => s.number === 'SKY-0011').account = aqi.username;
  state.trainingRecords = [verifier, aqi].map((a, n) => ({ id: `TRN-${String(n + 1).padStart(5, '0')}`, account: a.username, code: 'ESD', expires: nextYear, recordedAt: now, recordedBy: grantor.name, note: '', qmsRev: '' }));
  for (const who of [verifier, reviewer, aqi]) {
    const stamp = state.stamps.find(s => s.account === who.username);
    const set = host.withAccount(who, () => MES.setStampPin(state, stamp.id, PIN, PIN), state);
    assert.ok(set.ok, `PIN set for ${who.username}: ${JSON.stringify(set)}`);
  }
  for (const c of MES.getOrder(state, 'WO-10004').fair.chars.filter(c => c.ok === null)) Object.assign(c, { result: 'Conforms', inspector: 'Quinn Quality', date: day(0), tool: 'BORE-GAGE-03', ok: true });
  const p = MES.getOrder(state, 'WO-10002').conformity[0];
  Object.assign(p, { status: 'Open', form: null, aqi: null, notified: null, darApproval: null, faa8130_3: null, closed: null });
  ['6.1', '6.3a', '6.3b', '7.2'].forEach(k => delete p.checks[k]);
  return state;
}
const stampOf = (state, who) => state.stamps.find(s => s.account === who.username && s.status === 'Active');
const sign = { pin: PIN };
const form = { section: 'Aircraft', item: 'A', make: 'Skyryse', model: 'R66', basis: 'Parts are in conformity with Master Data List AA-CRT-0001 Rev G' };

// Each signing action: who signs, how to bring the workspace to the point where it is next, the action itself and
// what a successful signature leaves on the record.
const verified = state => { assert.ok(host.withAccount(verifier, () => MES.verifyFair(state, 'WO-10004', sign), state).ok, 'FAIR verified for the setup'); };
const reviewed = state => { verified(state); assert.ok(host.withAccount(reviewer, () => MES.reviewFair(state, 'WO-10004', sign), state).ok, 'box 22 signed for the setup'); };
const completed = state => { const r = host.withAccount(verifier, () => MES.complete8130_9(state, 'WO-10002', 'FC-200-00001', form, sign), state); assert.ok(r.ok, `8130-9 completed for the setup: ${JSON.stringify(r)}`); const c = host.withAccount(verifier, () => MES.checkConformity(state, 'WO-10002', 'FC-200-00001', '6.1', true), state); assert.ok(c.ok, `Step 6.1 confirmed for the setup: ${JSON.stringify(c)}`); };
const fair = state => MES.getOrder(state, 'WO-10004').fair;
const pkg = state => MES.getOrder(state, 'WO-10002').conformity[0];
const ACTIONS = [
  { name: 'verifyFair (FAIR blocks 20 and 21)', who: verifier, setup: () => {}, act: s => MES.verifyFair(s, 'WO-10004', sign), signed: s => fair(s).verified?.by?.stamp, other: '8130-9 Authorized Inspector' },
  { name: 'reviewFair (FAIR box 22)', who: reviewer, setup: verified, act: s => MES.reviewFair(s, 'WO-10004', sign), signed: s => fair(s).reviewed?.by?.stamp, other: 'Conformity Inspector' },
  { name: 'approveFair (Skyryse QA approval)', who: verifier, setup: reviewed, act: s => MES.approveFair(s, 'WO-10004', sign), signed: s => fair(s).approved?.by?.stamp, other: '8130-9 Authorized Inspector' },
  { name: 'complete8130_9', who: verifier, setup: () => {}, act: s => MES.complete8130_9(s, 'WO-10002', 'FC-200-00001', form, sign), signed: s => pkg(s).form?.prepared?.by?.stamp, other: 'Conformity Inspector' },
  { name: 'aqiSign8130_9', who: aqi, setup: completed, act: s => MES.aqiSign8130_9(s, 'WO-10002', 'FC-200-00001', sign), signed: s => pkg(s).aqi?.by?.stamp, other: null }
];
const LAPSES = [
  { name: 'an expired stamp', apply: st => { st.issued = lastYear; st.expires = yesterday; }, says: new RegExp(`expired on ${yesterday}\\. Requalification must be recorded and the stamp renewed by the QA Manager`) },
  { name: 'a stamp not yet issued', apply: st => { st.issued = tomorrow; }, says: new RegExp(`is not active until ${tomorrow}\\.`) },
  { name: 'an additional stamp paused for training', apply: st => { st.expansionTraining = 'TORQUE'; }, says: /additional stamp issued on TORQUE training that is not on record\. It pauses until the training is current/ }
];

for (const action of ACTIONS) {
  // Happy path: a current stamp signs, and the record carries that stamp.
  {
    const state = fresh(); action.setup(state);
    const stamp = stampOf(state, action.who);
    const r = host.withAccount(action.who, () => action.act(state), state);
    check(`${action.name} signs with a current stamp and records it`, r.ok && action.signed(state)?.number === stamp.number && MES.validate(state), JSON.stringify(r));
  }
  for (const lapse of LAPSES) {
    const state = fresh(); action.setup(state);
    const stamp = stampOf(state, action.who);
    lapse.apply(stamp);
    const before = JSON.stringify(state);
    const r = host.withAccount(action.who, () => action.act(state), state);
    check(`${action.name} is refused for ${lapse.name}, naming the stamp, and the workspace is unchanged`,
      !r.ok && lapse.says.test(r.message) && r.message.includes(`Stamp ${stamp.number}`) && JSON.stringify(state) === before && !action.signed(state), JSON.stringify(r));
  }
  // One lapsed and one current stamp of an allowed type: the current one signs.
  if (action.other) {
    const state = fresh(); action.setup(state);
    const lapsed = stampOf(state, action.who);
    lapsed.issued = lastYear; lapsed.expires = yesterday;
    const current = { ...structuredClone(lapsed), id: 'STP-0099', number: 'SKY-0099', buyoffType: action.other, type: action.other, issued: lastYear, expires: nextYear, history: [] };
    state.stamps.push(current);
    const r = host.withAccount(action.who, () => action.act(state), state);
    check(`${action.name} signs with the current stamp when the signer also holds an expired one`, r.ok && action.signed(state)?.number === 'SKY-0099', JSON.stringify(r));
  }
}

// The inspection capability applies the same rule.
{
  const state = fresh();
  check('a current Quality stamp is a valid inspection stamp', MES.hasValidInspectionStamp(state, verifier.username));
  for (const lapse of LAPSES) {
    const copy = structuredClone(state); lapse.apply(stampOf(copy, verifier));
    check(`${lapse.name} is not a valid inspection stamp`, !MES.hasValidInspectionStamp(copy, verifier.username));
  }
}

// The demo build keeps its stamp relaxation (D-47): an expired stamp still signs there, the production build refuses.
{
  const demo = createHost(fileURLToPath(new URL('../demo.html', import.meta.url)));
  const state = fresh();
  stampOf(state, verifier).issued = lastYear; stampOf(state, verifier).expires = yesterday;
  const r = demo.withAccount(verifier, () => demo.MES.verifyFair(state, 'WO-10004', {}), state);
  check('the demo build still signs the FAIR with an expired stamp (demo deviation), production refuses it', r.ok && fair(state).verified?.by?.stamp?.number === stampOf(state, verifier).number, JSON.stringify(r));
  const none = fresh(); stampOf(none, verifier).status = 'Suspended';
  check('the demo build still refuses an account with no Active stamp of an allowed type', !demo.withAccount(verifier, () => demo.MES.verifyFair(none, 'WO-10004', {}), none).ok);
}

// ---- the same refusal over the server action route: POST /api/workspace/actions/MES.verifyFair ----
{
  const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'inspector-sign-stamp' });
  await server.ready;
  const call = async (method, url, token, body, headers = {}) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); incoming.method = method; incoming.url = url;
    incoming.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    const chunks = [], outgoing = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    outgoing.writeHead = status => { outgoing.statusCode = status; return outgoing; };
    const done = new Promise((resolve, reject) => { outgoing.once('finish', resolve); outgoing.once('error', reject); });
    server.listeners('request')[0](incoming, outgoing); await done;
    const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: outgoing.statusCode, json };
  };
  try {
    await server.store.upsertAccount({ username: verifier.username, displayName: verifier.displayName, salt: '', hash: await makeHash('quality-pass-1'), role: 'qe', roles: ['qe'] });
    const token = (await call('POST', '/api/auth/session', null, { username: verifier.username, password: 'quality-pass-1' })).json.token;
    const doc = async () => server.store.getDoc('default');
    const fairOf = async () => MES.getOrder(JSON.parse((await doc()).json), 'WO-10004').fair;
    const post = async () => call('POST', '/api/workspace/actions/MES.verifyFair', token, { args: ['WO-10004', sign] }, { 'If-Match': (await doc()).etag });
    const state = fresh();
    stampOf(state, verifier).expires = yesterday;
    await server.store.putDoc('default', JSON.stringify(state), null, 'inspector-sign-stamp');
    const before = (await doc()).etag;
    const refused = await post();
    check('over the server an expired stamp cannot verify the FAIR and the workspace is not written',
      refused.status >= 400 && /expired on/.test(refused.json?.error || '') && (await doc()).etag === before && !(await fairOf()).verified, JSON.stringify(refused));
    stampOf(state, verifier).expires = nextYear;
    await server.store.putDoc('default', JSON.stringify(state), before, 'inspector-sign-stamp');
    const signed = await post();
    check('over the server a current stamp verifies the FAIR', signed.status === 200 && (await fairOf()).verified?.by?.stamp?.number === stampOf(state, verifier).number, JSON.stringify(signed));
  } finally { server.store.close(); }
}

console.log(`inspector sign stamp validity: ${checks} checks passed`);
