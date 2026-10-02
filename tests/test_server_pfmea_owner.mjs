// The PFMEA action owner is an account. On the authenticated server, FlightManeuver.setPfmeaAction resolves the chosen
// owner against the tenant's account list (passed to the host as the account directory), exactly as the page does, so a
// direct action call cannot record an owner that is not a real account or leave the owner account out.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createHost } from '../server/mes-host.mjs';
import { createServer, makeHash } from '../server/server.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver } = host;
let checks = 0;
const check = (name, ok, detail = '') => { checks += 1; assert.ok(ok, `${name} ${detail}`); console.log(`ok ${name}`); };
const acct = (username, displayName, role) => ({ username, displayName, role });
const me = acct('srv-me', 'Morgan Engineer', 'me'), qm = acct('srv-qm', 'Parker Manager', 'qm');
const directory = [me, qm];

const base = () => {
  const state = MES.seed();
  MES.ensureMasterWIs(state); FlightManeuver.ensure(state);
  const wi = state.masterWIs.find(w => Array.isArray(w.operations) && w.operations.length);
  const by = { name: me.displayName, role: 'Manufacturing Engineer', credentialId: `ACCT-${me.username}`, account: me.username };
  const at = new Date().toISOString();
  state.maneuver.pfmeas = [{ id: 'PFM-901', wiId: wi.id, wiRevision: wi.revision, partNumber: wi.partNumber, title: wi.title, status: 'Analysis', scope: { team: 'ME, QA, Safety Team', boundaries: '', by, at }, rows: [{ id: 'FM-1', opId: wi.operations[0].id, mode: 'Wrong kit issued', effect: 'Non-conforming part', cause: 'Label not checked', controls: 'Kit list', s: 9, o: 3, d: 4, rpn: 108, action: '', owner: '', due: null, done: null, by, at }], reviewed: {}, analysisDone: null, actionsDone: null, safety: null, returns: [], openedBy: by, openedAt: at, attachments: [], history: [], contributors: [by.credentialId], contributorsComplete: true }];
  return state;
};
const assign = (input, dir = directory) => { const state = base(); const r = host.withAccount(me, () => FlightManeuver.setPfmeaAction(state, 'PFM-901', 'FM-1', input), state, dir); const row = state.maneuver.pfmeas[0].rows[0]; return { r, row, valid: MES.validate(state) }; };

const okCase = assign({ action: 'Add a kit label scan', ownerAccount: 'srv-qm', due: '2026-12-01' });
check('the server records an owner chosen from the tenant account list, with that account and its name', okCase.r.ok === true && okCase.row.ownerBy && okCase.row.ownerBy.credentialId === 'ACCT-srv-qm' && okCase.row.owner === 'Parker Manager' && okCase.valid === true, JSON.stringify(okCase));
const unknown = assign({ action: 'Add a kit label scan', ownerAccount: 'not-an-account', owner: 'Somebody', due: '2026-12-01' });
check('the server refuses an owner account that is not in the tenant account list, and records nothing', unknown.r.ok === false && /account list/.test(unknown.r.message) && unknown.row.action === '' && !unknown.row.ownerBy, JSON.stringify(unknown.r));
const missing = assign({ action: 'Add a kit label scan', owner: 'Parker Manager', due: '2026-12-01' });
check('the server refuses an action whose owner is free text with no account', missing.r.ok === false && /account list/.test(missing.r.message) && missing.row.action === '', JSON.stringify(missing.r));

// ---- the same over the authenticated action route: POST /api/workspace/actions/FlightManeuver.setPfmeaAction ----
{
  const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'pfmea-owner' });
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
    for (const a of directory) await server.store.upsertAccount({ username: a.username, displayName: a.displayName, salt: '', hash: await makeHash(`${a.username}-pass-1`), role: a.role, roles: [a.role] });
    await server.store.putDoc('default', JSON.stringify(base()), null, 'pfmea-owner');
    const token = (await call('POST', '/api/auth/session', null, { username: me.username, password: `${me.username}-pass-1` })).json.token;
    const row = async () => JSON.parse((await server.store.getDoc('default')).json).maneuver.pfmeas[0].rows[0];
    const post = async input => call('POST', '/api/workspace/actions/FlightManeuver.setPfmeaAction', token, { args: ['PFM-901', 'FM-1', input] }, { 'If-Match': (await server.store.getDoc('default')).etag });
    const bad = await post({ action: 'Add a kit label scan', ownerAccount: 'not-an-account', owner: 'Somebody', due: '2026-12-01' });
    check('over the server an owner account outside the tenant account list is refused (403) and nothing is written', bad.status === 403 && /account list/.test(bad.json.error) && (await row()).action === '', JSON.stringify(bad));
    const none = await post({ action: 'Add a kit label scan', owner: 'Parker Manager', due: '2026-12-01' });
    check('over the server a free-text owner without an account is refused (403)', none.status === 403 && /account list/.test(none.json.error), JSON.stringify(none));
    const good = await post({ action: 'Add a kit label scan', ownerAccount: 'srv-qm', owner: 'Parker Manager', due: '2026-12-01' });
    const saved = await row();
    check('over the server an owner chosen from the tenant account list is recorded with that account', good.status === 200 && saved.ownerBy && saved.ownerBy.credentialId === 'ACCT-srv-qm' && saved.owner === 'Parker Manager', JSON.stringify([good.status, saved]));
  } finally { server.store.close(); }
}
console.log(`${checks} checks passed`);
