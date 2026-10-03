// The training floor demo, end to end: a real server process started as Jose would start it
// (node server/server.mjs --training --db <file>), the first account made with the setup code the server prints,
// and every person on their own computer, played here by a separate browser context with its own session. The
// production build runs with every gate on. Each person signs in through the sign-in screen and acts through the
// same engine calls the buttons make; each change goes to the server as an authorized action.
//
// The scene: Master Access (Jose) makes a second QA Manager, who records training and issues stamps (nobody does
// their own). Manufacturing Engineering imports a master WI, the second QA Manager peer reviews it and Quality
// releases it. A work order is built: the technician buys off an operation with stamp and PIN, a nonconformance is
// raised and walked through MRB with a different person in each seat, Quality inspects, and the FAIR is verified by
// one person and signed in box 22 by another. Each person sees the others' changes after a refresh, every
// self-approval is refused (in the page and by the server), and the shared workspace validates at the end.
//
//   node tests/qa_training_multiuser.mjs            one run
//   TRAINING_RUNS=3 node tests/qa_training_multiuser.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Math.max(1, Number(process.env.TRAINING_RUNS || 1));
const MARK = 'TRAINING, NOT THE RECORD';
const PIN = '4826', EXPIRES = '2030-12-31', TRAINING = 'ESD';
const fails = [], errors = [];
let checks = 0, run = 0;
const ok = (name, cond, detail = '') => { checks += 1; console.log(`${cond ? 'ok  ' : 'FAIL'} [run ${run}] ${name}${cond ? '' : ` -> ${String(detail).slice(0, 400)}`}`); if (!cond) fails.push(`run ${run}: ${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); return cond; };
const host = createHost(path.join(ROOT, 'index.html'));

// ---- the server, as the setup guide starts it -----------------------------------------------------------------
async function startServer(db) {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.mjs'), '--training', '--host', '127.0.0.1', '--port', '0', '--db', db], { cwd: ROOT, env: { ...process.env, FLIGHT_TRAINING: '', FLIGHT_BOOTSTRAP_TOKEN: '', FLIGHT_DATABASE_URL: '' } });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  for (const until = Date.now() + 30000; !/First-run setup code: \S+/.test(out) && Date.now() < until;) await new Promise(r => setTimeout(r, 100));
  const port = (out.match(/listening on [^\s]+:(\d+)/) || [])[1], code = (out.match(/First-run setup code: (\S+)/) || [])[1];
  if (!port || !code) { await stop(child); throw new Error(`The training server did not start: ${out}`); }
  return { child, base: `http://127.0.0.1:${port}`, code, out: () => out };
}

// ---- one person on one computer ---------------------------------------------------------------------------------
const ready = () => window.skServer?.sync?.status === 'synced' && typeof serverWorkspaceReady !== 'undefined' && serverWorkspaceReady && !document.getElementById('sk-boot');
async function signIn(browser, base, username, password, setup) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${username}: ${error.message}`));
  await page.goto(`${base}/`);
  await page.locator('#sk-login').waitFor({ state: 'visible', timeout: 20000 });
  const fields = setup ? { 'sk-displayname': setup.displayName, 'sk-username': username, 'sk-password': password, 'sk-confirm': password, 'sk-setup': setup.code } : { 'sk-username': username, 'sk-password': password };
  for (const [id, value] of Object.entries(fields)) await page.locator(`#${id}`).fill(value);
  await page.locator('#sk-login-submit').click();
  await page.waitForFunction(ready, null, { timeout: 20000 });
  const who = { username, context, page };
  ok(`${username} signs in on their own session`, await page.evaluate(() => window.skAuth.user()?.username) === username);
  return who;
}
// A refresh: the person reloads the page and reads the shared workspace again.
async function refresh(who) {
  await who.page.reload();
  await who.page.waitForFunction(ready, null, { timeout: 20000 });
}
const token = who => who.page.evaluate(() => window.skServer.token());
// Runs one engine call in the person's page the way a button does (applyResult saves it and sends it to the server),
// then waits until the server has answered. The person refreshes first: a change sent from a page older than the
// shared workspace is refused by the server as changed on another device (see the conflict check in the scene).
// stamp: select the person's own stamp credential first, as Your credentials does before a buy-off.
async function act(who, label, fn, arg, { refuse = false, stamp = false, fresh = true, conflict = false } = {}) {
  if (fresh) await refresh(who);
  const result = await who.page.evaluate(async ({ src, arg, stamp }) => {
    const settle = async () => {
      for (let i = 0; i < 400 && (serverActionQueue.length || serverActionPending); i++) await new Promise(r => setTimeout(r, 50));
      await serverActionChain.catch(() => {});
      return { ...window.skServer.sync };
    };
    if (stamp) {
      const option = MES.profileOptions(state).find(item => item.buyoffType);
      if (!option) return { ok: false, message: 'No stamp credential is listed for this account.' };
      if (state.profile?.credentialId !== option.credentialId) {
        const chosen = MES.selectProfile(state, option.id);
        if (!chosen.ok || !save()) return { ok: false, message: chosen.message || 'The credential was not saved.' };
        const sync = await settle(); if (sync.status !== 'synced') return { ok: false, message: `Selecting the stamp was not confirmed: ${sync.message}` };
      }
    }
    let r;
    try { r = (0, eval)(`(${src})`)(arg); } catch (error) { return { ok: false, message: `EXCEPTION ${error.message}` }; }
    if (!r || r.ok === false) return { ...(r || {}), ok: false, refusedInPage: true };
    if (!applyResult(r)) return { ok: false, message: 'The page did not save the change.' };
    const sync = await settle();
    return { ...r, ok: sync.status === 'synced', sync };
  }, { src: fn.toString(), arg, stamp });
  if (conflict) ok(`${who.username}: ${label} is refused as changed on another device, and the page reloads the shared copy`, result.ok === false && result.sync?.status === 'conflict' && /changed on another device/.test(result.sync?.message || ''), JSON.stringify(result));
  else if (refuse) ok(`${who.username} is refused: ${label}`, result.ok === false, JSON.stringify(result));
  else ok(`${who.username}: ${label}`, result.ok === true, `${result.message} ${JSON.stringify(result.sync || {})}`);
  return result;
}
const look = (who, fn, arg) => who.page.evaluate(({ src, arg }) => (0, eval)(`(${src})`)(arg), { src: fn.toString(), arg });
async function api(base, tok, method, route, body, headers = {}) {
  const res = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, etag: res.headers.get('etag') };
}
// The server refuses a raw request that the page would refuse: the action runs under the caller's own authority.
async function serverRefuses(base, who, label, action, args) {
  const tok = await token(who), ws = await api(base, tok, 'GET', '/workspace');
  const r = await api(base, tok, 'POST', `/workspace/actions/${action}`, { args }, { 'If-Match': ws.etag });
  ok(`the server refuses ${who.username}: ${label}`, r.status === 403 && !!r.json?.error, `${r.status} ${JSON.stringify(r.json)}`);
  const after = await api(base, tok, 'GET', '/workspace');
  ok(`nothing changed after the refused request (${label})`, after.etag === ws.etag, `${ws.etag} -> ${after.etag}`);
}
async function createAccount(manager, user, { refuse = false } = {}) {
  const r = await manager.page.evaluate(async user => { const x = await window.skServer.api('/auth/accounts', { method: 'PUT', body: { users: [user] } }); return { status: x.status, json: x.json }; }, user);
  if (refuse) ok(`${manager.username} is refused: create ${user.username} as ${user.role} without current training`, r.status === 403 && /training/.test(r.json?.error || ''), JSON.stringify(r));
  else ok(`${manager.username} creates ${user.username} (${user.role})`, r.status === 200, JSON.stringify(r));
}

// Gives a person a role through the server's access route, as Accounts and roles does, citing their training.
async function setRole(manager, username, role, { refuse = false, self = false } = {}) {
  const r = await manager.page.evaluate(async a => { const x = await window.skServer.api('/auth/access', { method: 'POST', body: { action: 'roles', username: a.username, roles: [a.role], reason: 'Training floor demo role assignment.', trainingCode: a.code } }); return { status: x.status, json: x.json }; }, { username, role, code: TRAINING });
  if (refuse) ok(`${manager.username} is refused: give ${username} the ${role} role${self ? ' (own account)' : ' without current training'}`, r.status === 403 && (self ? /own roles/ : /training/).test(r.json?.error || ''), JSON.stringify(r));
  else ok(`${manager.username} gives ${username} the ${role} role, citing the training`, r.status === 200, JSON.stringify(r));
}
// Stops the server process and waits until it has exited, so its database files are closed before they are removed.
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
}

async function scene(browser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-training-floor-'));
  const people = [], seat = {};
  let server = null;
  try {
    server = await startServer(path.join(dir, 'training.sqlite'));
    const { base } = server;
    const pw = name => `Training-${name}-pass1`;
    // ---- first account: Master Access, with the setup code from the console ----
    const jose = await signIn(browser, base, 'jose', pw('jose'), { displayName: 'Jose Del Cid', code: server.code }); people.push(jose);
    ok('the first account is Master Access', await look(jose, () => window.skAuth.role()) === 'admin');
    ok('the console printed the training mode line', /Training mode: every page, print and download is marked TRAINING, NOT THE RECORD/.test(server.out()));
    // The setup guide's order, the only one the screens allow (Record a training lists existing accounts): add the
    // person as General, record their training, then give the role in Accounts and roles, citing the training. A role
    // with inspection or MRB authority is refused without a current training record.
    await createAccount(jose, { username: 'qm2', displayName: 'Riley Second QA Manager', role: 'qm', roles: ['qm'], password: pw('qm2'), trainingCode: TRAINING }, { refuse: true });
    await createAccount(jose, { username: 'qm2', displayName: 'Riley Second QA Manager', role: 'general', roles: ['general'], password: pw('qm2') });
    await setRole(jose, 'qm2', 'qm', { refuse: true });
    await act(jose, 'record ESD training for the second QA Manager', a => MES.recordTraining(state, { account: 'qm2', code: a.code, expires: a.expires, note: 'Training floor demo' }), { code: TRAINING, expires: EXPIRES });
    await act(jose, 'record his own training', a => MES.recordTraining(state, { account: 'jose', code: a.code, expires: a.expires }), { code: TRAINING, expires: EXPIRES }, { refuse: true });
    await act(jose, 'issue a stamp to his own account', a => MES.issueStamp(state, { name: 'Jose Del Cid', buyoffType: 'Quality', account: 'jose', expires: a }), EXPIRES, { refuse: true });
    await setRole(jose, 'qm2', 'qm');
    const qm2 = await signIn(browser, base, 'qm2', pw('qm2')); people.push(qm2);
    ok('the second QA Manager holds the QA Manager role', await look(qm2, () => window.skAuth.role()) === 'qm');
    await setRole(qm2, 'qm2', 'admin', { refuse: true, self: true });
    // ---- everyone else: accounts by Jose, training by the second QA Manager, roles by Jose ----
    const users = [
      { username: 'mfgeng', displayName: 'Morgan Training Engineer', role: 'me' },
      { username: 'quality', displayName: 'Quinn Training Inspector', role: 'qe' },
      { username: 'engineering', displayName: 'Erin Training Engineer', role: 'swe' },
      { username: 'cert', displayName: 'Casey Training Certification', role: 'cert' },
      { username: 'tech', displayName: 'Taylor Training Technician', role: 'technician' },
      { username: 'ops1', displayName: 'Owen Training Operations', role: 'operator' }
    ];
    const gated = new Set(['me', 'qe', 'swe', 'cert']);
    for (const user of users) await createAccount(jose, { ...user, role: gated.has(user.role) ? 'general' : user.role, roles: [gated.has(user.role) ? 'general' : user.role], password: pw(user.username) });
    for (const account of ['jose', 'mfgeng', 'quality', 'engineering', 'cert', 'tech']) await act(qm2, `record ESD training for ${account}`, a => MES.recordTraining(state, { account: a.account, code: a.code, expires: a.expires, note: 'Training floor demo' }), { account, code: TRAINING, expires: EXPIRES });
    await act(qm2, 'record her own training', a => MES.recordTraining(state, { account: 'qm2', code: a.code, expires: a.expires }), { code: TRAINING, expires: EXPIRES }, { refuse: true });
    await serverRefuses(base, qm2, 'record her own training', 'MES.recordTraining', [{ account: 'qm2', code: TRAINING, expires: EXPIRES }]);
    for (const user of users.filter(u => gated.has(u.role))) await setRole(jose, user.username, user.role);
    const stamps = {};
    for (const [account, name, buyoffType] of [['tech', 'Taylor Training Technician', 'Technician'], ['quality', 'Quinn Training Inspector', 'Quality'], ['jose', 'Jose Del Cid', 'Quality']]) {
      const r = await act(qm2, `issue a ${buyoffType} stamp to ${account}`, a => MES.issueStamp(state, a), { name, buyoffType, account, expires: EXPIRES });
      stamps[account] = r.id;
    }
    await refresh(jose);
    ok('Jose sees the stamp the second QA Manager issued him', await look(jose, () => state.stamps.some(s => s.account === 'jose' && s.status === 'Active' && s.buyoffType === 'Quality')));
    await act(jose, 'set his stamp PIN', a => MES.setStampPin(state, a.id, a.pin, a.pin), { id: stamps.jose, pin: PIN });
    for (const username of ['mfgeng', 'quality', 'engineering', 'cert', 'tech', 'ops1']) { seat[username] = await signIn(browser, base, username, pw(username)); people.push(seat[username]); }
    for (const username of ['tech', 'quality']) await act(seat[username], 'set my stamp PIN', a => MES.setStampPin(state, a.id, a.pin, a.pin), { id: stamps[username], pin: PIN });
    await serverRefuses(base, seat.tech, 'issue himself a Quality stamp', 'MES.issueStamp', [{ name: 'Taylor Training Technician', buyoffType: 'Quality', account: 'tech', expires: EXPIRES }]);
    ok('the technician holds no inspection authority', await look(seat.tech, () => !window.skAuth.can('inspect-steps')));
    ok('Quality holds inspection with an assigned Quality stamp', await look(seat.quality, () => window.skAuth.can('inspect-steps')));

    // ---- the sample data in samples/training, imported through the importers on this server ----
    const sample = name => fs.readFileSync(path.join(ROOT, 'samples/training', name), 'utf8');
    const cal = await act(qm2, 'import samples/training/calibration.csv', text => MES.importCalibrations(state, text), sample('calibration.csv'));
    ok('every training tool is in the calibration log', (cal.ids || []).length === 20, JSON.stringify(cal.ids));
    const sampleWis = (await act(seat.mfgeng, 'import samples/training/master_wis.csv', text => MES.importMasterWIs(state, text), sample('master_wis.csv'))).ids || [];
    ok('the sample WIs get the numbers work_orders.csv names', sampleWis.join() === 'MWI-0011,MWI-0012,MWI-0013,MWI-0014,MWI-0015', sampleWis.join());
    await act(seat.mfgeng, 'import samples/training/work_orders.csv while its WIs are drafts', text => MES.importWorkOrders(state, text), sample('work_orders.csv'), { refuse: true });
    await act(qm2, 'peer review the five sample WIs', ids => { let r; for (const id of ids) { r = MES.peerReviewMasterWI(state, id, 'A'); if (!r.ok) return r; } return r; }, sampleWis);
    await act(seat.quality, 'release the five sample WIs', ids => { let r; for (const id of ids) { r = MES.releaseMasterWI(state, id, 'A', { eco: 'ECO-1001' }); if (!r.ok) return r; } return r; }, sampleWis);
    const sampleOrders = (await act(seat.mfgeng, 'import samples/training/work_orders.csv', text => MES.importWorkOrders(state, text), sample('work_orders.csv'))).ids || [];
    ok('all 30 sample work orders were imported', sampleOrders.length === 30, sampleOrders.join());
    await refresh(seat.ops1);
    ok('Operations sees the 30 sample work orders after a refresh', await look(seat.ops1, ids => ids.every(id => MES.getOrder(state, id)?.status === 'Draft'), sampleOrders));

    // ---- master WI: authored by ME, peer reviewed by the second QA Manager, released by Quality ----
    const part = host.MES.PART_CATALOG[0];
    const csv = ['wi,partNumber,partRevision,title,operation,operationTitle,operationSummary,buyoffType,classification,stepTitle,instruction,requiresTooling,recordsTorque',
      `TRN-A,${part.partNumber},${part.revisions[0]},Training Part A assembly,10,Assemble,Assemble Training Part A,Technician,,Fit halves,Fit the two halves and seat the alignment pins,No,No`,
      `TRN-A,${part.partNumber},${part.revisions[0]},Training Part A assembly,20,Final inspection,Inspect Training Part A,Quality,Inspection,Visual,Check for damage and missing hardware,No,No`].join('\n');
    const imported = await act(seat.mfgeng, 'import the training master WI', text => MES.importMasterWIs(state, text), csv);
    const wi = imported.ids && imported.ids[0];
    await act(seat.mfgeng, 'peer review his own WI', id => MES.peerReviewMasterWI(state, id, 'A'), wi, { refuse: true });
    await refresh(qm2);
    ok('the second QA Manager sees the imported WI as a Draft after a refresh', await look(qm2, id => state.masterWIs.some(w => w.id === id && w.status === 'Draft'), wi));
    await act(qm2, 'peer review the WI', id => MES.peerReviewMasterWI(state, id, 'A'), wi);
    await act(qm2, 'release the WI she peer reviewed', id => MES.releaseMasterWI(state, id, 'A', { eco: 'ECO-1001' }), wi, { refuse: true });
    await refresh(seat.quality);
    await act(seat.quality, 'release the WI', id => MES.releaseMasterWI(state, id, 'A', { eco: 'ECO-1001' }), wi);

    // ---- the work order: created by ME, kitted by Operations ----
    await refresh(seat.mfgeng);
    const wo = (await act(seat.mfgeng, 'create the training work order', id => MES.addOrder(state, { masterWI: `${id}|A`, pedigree: 'Production', subcategory: 'Mfg.', quantity: 1, aircraft: MES.AIRCRAFT[0], site: MES.SITES[0] }), wi)).id;
    // A page opened before the order existed does not show it until the person refreshes, and a change sent from it
    // is refused because the shared workspace moved on: the page reloads the shared copy and the person repeats it.
    ok('a page that has not been refreshed does not show the new order yet', await look(seat.ops1, id => !MES.getOrder(state, id), wo));
    await act(qm2, 'record training from a page that is not current', a => MES.recordTraining(state, { account: 'ops1', code: a.code, expires: a.expires, note: 'Training floor demo' }), { code: TRAINING, expires: EXPIRES }, { fresh: false, conflict: true });
    ok('after the conflict the page holds the current shared copy, new order included', await look(qm2, id => !!MES.getOrder(state, id) && !state.trainingRecords.some(r => r.account === 'ops1'), wo));
    await act(qm2, 'repeat the change on the reloaded page', a => MES.recordTraining(state, { account: 'ops1', code: a.code, expires: a.expires, note: 'Training floor demo' }), { code: TRAINING, expires: EXPIRES }, { fresh: false });
    await refresh(seat.ops1);
    ok('Operations sees the new order after a refresh', await look(seat.ops1, id => !!MES.getOrder(state, id), wo));
    await act(seat.ops1, 'issue the order to kitting', id => MES.getOrder(state, id).status === 'Draft' ? MES.advance(state, id) : { ok: true, message: 'already issued' }, wo);
    await act(seat.ops1, 'kit every material line', id => { const o = MES.getOrder(state, id); for (const m of o.materials) { const lot = MES.availableLotsFromLedger(state, m.partNumber, o.pedigree)[0]; let r = MES.setMaterialLot(state, id, m.id, lot ? lot.lot : 'LOT-TRN-0001'); if (!r.ok) return r; r = MES.setMaterial(state, id, m.id, true); if (!r.ok) return r; } return MES.addKitFile(state, id, { name: 'Training kit list.pdf', type: 'application/pdf', size: 2048 }); }, wo);
    await act(seat.ops1, 'start the build', id => MES.advance(state, id), wo);

    // ---- the technician buys off with stamp and PIN; Quality sees it ----
    await refresh(seat.tech);
    ok('the technician sees the order in Building after a refresh', await look(seat.tech, id => MES.getOrder(state, id)?.status === 'Building', wo));
    // The traveler opens once the server confirms its print record; the page written to the print window is marked.
    const printed = await look(seat.tech, async id => { const wins = []; window.open = () => { const d = { html: '', open() { this.html = ''; }, write(h) { this.html += h; }, close() {}, querySelector() { return null; } }; wins.push(d); return { opener: 1, document: d, focus() {}, print() {}, close() {} }; }; await printTraveler(id, true); return wins.map(w => w.html); }, wo);
    ok('the technician prints the traveler, and it carries TRAINING, NOT THE RECORD', printed.length === 1 && printed[0].includes(MARK) && /Traveler|traveler/.test(printed[0]), `${printed.length} prints: ${String(printed[0]).slice(0, 200)}`);
    await act(seat.tech, 'check off the assembly steps', id => { const o = MES.getOrder(state, id), op = o.operations[0]; let r = { ok: true }; for (const s of op.steps) { r = MES.setStepCheck(state, id, op.id, s.id, true); if (!r.ok) return r; } return r; }, wo, { stamp: true });
    await act(seat.tech, 'buy off with a wrong PIN', a => { const o = MES.getOrder(state, a.wo), stamp = state.stamps.find(s => s.account === 'tech'); return MES.completeOperation(state, a.wo, o.operations[0].id, 'Assembled per the WI.', { stampNumber: stamp.number, pin: '1397' }); }, { wo }, { refuse: true, stamp: true });
    await act(seat.tech, 'buy off operation 10 with stamp and PIN', a => { const o = MES.getOrder(state, a.wo), stamp = state.stamps.find(s => s.account === 'tech'); return MES.completeOperation(state, a.wo, o.operations[0].id, 'Assembled per the WI.', { stampNumber: stamp.number, pin: a.pin }); }, { wo, pin: PIN }, { stamp: true });
    await act(seat.tech, 'inspect his own work', a => { const o = MES.getOrder(state, a.wo), stamp = state.stamps.find(s => s.account === 'tech'); return MES.completeOperation(state, a.wo, o.operations[1].id, 'x', { stampNumber: stamp.number, pin: a.pin, standardInspection: true }); }, { wo, pin: PIN }, { refuse: true, stamp: true });
    {
      const live = (await api(base, await token(seat.tech), 'GET', '/workspace')).json;
      const techStamp = live.stamps.find(s => s.account === 'tech');
      await serverRefuses(base, seat.tech, 'buy off the inspection of his own work', 'MES.completeOperation', [wo, live.orders.find(o => o.id === wo).operations[1].id, 'x', { stampNumber: techStamp.number, pin: PIN, standardInspection: true }]);
    }
    await refresh(seat.quality);
    const seen = await look(seat.quality, id => { const op = MES.getOrder(state, id).operations[0]; return { done: op.done, account: op.buyoff?.account, stamp: op.buyoff?.stamp?.buyoffType, signed: /^[0-9a-f]{64}$/.test(op.buyoff?.manifest?.hash || '') }; }, wo);
    ok('Quality sees the technician\'s signed buy-off after a refresh', seen.done && seen.account === 'tech' && seen.stamp === 'Technician' && seen.signed, JSON.stringify(seen));

    // ---- a nonconformance through MRB, one person per seat ----
    const nc = (await act(seat.tech, 'raise an NC with a hold on the inspection operation', id => { const o = MES.getOrder(state, id); return MES.createTicket(state, id, o.operations[1].id, { type: 'NC', title: 'Scratch on Training Part A face', description: 'Light scratch found before final inspection.', hold: true }); }, wo)).id;
    await refresh(seat.mfgeng);
    await act(seat.mfgeng, 'record the ME disposition Use as is', a => MES.dispositionTicket(state, a.wo, a.nc, { decision: 'Use as is', note: 'Cosmetic only, outside functional surfaces.' }), { wo, nc });
    await refresh(seat.quality);
    await act(seat.quality, 'approve the disposition before the MRB decides', a => MES.resolveTicket(state, a.wo, a.nc, 'Approved.', { defectCode: MES.DEFECT_CODES[0].code, subCode: MES.DEFECT_CODES[0].subs[0].code, quantity: 1, serials: [] }), { wo, nc }, { refuse: true });
    const mrb = (await act(seat.mfgeng, 'convene the MRB', a => FlightManeuver.openMRB(state, a.wo, a.nc, 'Cosmetic scratch on Training Part A, justification attached.'), { wo, nc })).id;
    await act(seat.mfgeng, 'vote the Quality seat', id => FlightManeuver.voteMRB(state, id, 'Quality', 'Approve', 'x'), mrb, { refuse: true });
    await refresh(qm2);
    await act(qm2, 'vote the Quality seat', id => FlightManeuver.voteMRB(state, id, 'Quality', 'Approve', 'Agreed, cosmetic only.'), mrb);
    await act(qm2, 'vote a second seat on the same board', id => FlightManeuver.voteMRB(state, id, 'Engineering', 'Approve', 'x'), mrb, { refuse: true });
    await refresh(seat.mfgeng);
    await act(seat.mfgeng, 'vote the Manufacturing Engineering seat', id => FlightManeuver.voteMRB(state, id, 'Manufacturing Engineering', 'Approve', 'Cosmetic only.'), mrb);
    await refresh(seat.engineering);
    await act(seat.engineering, 'vote the Engineering seat', id => FlightManeuver.voteMRB(state, id, 'Engineering', 'Approve', 'No structural concern.'), mrb);
    await refresh(seat.cert);
    const seats = await look(seat.cert, id => FlightManeuver.get(state, 'mrb', id).seats, mrb);
    if (seats.includes('Certification')) await act(seat.cert, 'vote the Certification seat', id => FlightManeuver.voteMRB(state, id, 'Certification', 'Approve', 'No certification impact.'), mrb);
    await refresh(seat.quality);
    const board = await look(seat.quality, id => { const m = FlightManeuver.get(state, 'mrb', id); return { status: m.status, voters: m.votes.map(v => v.by.account || v.by.credentialId) }; }, mrb);
    ok('the board decided with a different person in every seat', board.status === 'Approved' && new Set(board.voters).size === board.voters.length && board.voters.length === seats.length, JSON.stringify(board));
    await act(seat.quality, 'approve the NC disposition', a => MES.resolveTicket(state, a.wo, a.nc, 'Approved use as is after the MRB.', { defectCode: MES.DEFECT_CODES[0].code, subCode: MES.DEFECT_CODES[0].subs[0].code, quantity: 1, serials: [] }), { wo, nc });

    // ---- Quality inspects, Operations hands to Quality ----
    await act(seat.quality, 'check off the inspection steps', id => { const o = MES.getOrder(state, id), op = o.operations[1]; let r = { ok: true }; for (const s of op.steps) { r = MES.setStepCheck(state, id, op.id, s.id, true); if (!r.ok) return r; } return r; }, wo, { stamp: true });
    await act(seat.quality, 'buy off the inspection with stamp and PIN', a => { const o = MES.getOrder(state, a.wo), stamp = state.stamps.find(s => s.account === 'quality'); return MES.completeOperation(state, a.wo, o.operations[1].id, 'Inspected, no damage beyond the MRB decision.', { stampNumber: stamp.number, pin: a.pin, standardInspection: true }); }, { wo, pin: PIN }, { stamp: true });
    await refresh(seat.ops1);
    await act(seat.ops1, 'hand the order to Quality', id => MES.advance(state, id), wo);

    // ---- FAIR: verified by one person, box 22 by another ----
    await refresh(seat.quality);
    await act(seat.quality, 'fill the FAIR forms', id => {
      let r = MES.saveFairHeader(state, id, {}); if (!r.ok) return r;
      r = MES.saveFairHeader(state, id, { type: 'Full', reasons: ['New part (first production)'], supplierCode: 'TRN01', po: '', sampleSize: '1', comments: 'Training first article.' }); if (!r.ok) return r;
      const o = MES.getOrder(state, id);
      r = MES.setFairIndex(state, id, o.fair.index.map(x => ({ ...x, fairId: x.fairId || `LOT-${x.pn.slice(-3)}-0001` }))); if (!r.ok) return r;
      r = MES.addFairForm2(state, id, { kind: 'Material', name: 'Training aluminum plate', spec: 'AMS-QQ-A-250/11', code: '', supplier: 'Training Metals', approval: 'Yes', coc: 'COC-TRN-0001' }); if (!r.ok) return r;
      for (let i = 0; i < o.fair.tests.length; i++) { r = MES.setFairTest(state, id, i, { report: `ATR-TRN-${i + 1}` }); if (!r.ok) return r; }
      return MES.addFairChar(state, id, { no: '1', ref: 'Sht 1 B3', designator: 'Key', requirement: '0.250 +/-0.005 in', result: '0.2512', ok: 'yes', tool: 'CMM-01' });
    }, wo);
    await act(seat.quality, 'verify the FAIR (blocks 20 and 21) with stamp and PIN', a => MES.verifyFair(state, a.wo, { pin: a.pin }), { wo, pin: PIN });
    await act(seat.quality, 'sign box 22 on the FAIR he verified', a => MES.reviewFair(state, a.wo, { pin: a.pin }), { wo, pin: PIN }, { refuse: true });
    await serverRefuses(base, seat.quality, 'sign box 22 on the FAIR he verified', 'MES.reviewFair', [wo, { pin: PIN }]);
    await refresh(jose);
    ok('Jose sees the verified FAIR after a refresh', await look(jose, id => MES.getOrder(state, id).fair?.status === 'Verified', wo));
    await act(jose, 'sign box 22 with his own stamp and PIN', a => MES.reviewFair(state, a.wo, { pin: a.pin }), { wo, pin: PIN });
    await refresh(seat.quality);
    await act(seat.quality, 'give the Skyryse QA approval', a => MES.approveFair(state, a.wo, { pin: a.pin }), { wo, pin: PIN });
    await act(seat.quality, 'close the order', id => MES.closeOrder(state, id), wo);

    // ---- every person sees the result; every page and print is marked training ----
    for (const who of people) {
      await refresh(who);
      const view = await look(who, id => { const o = MES.getOrder(state, id); const b = document.querySelector('.training-banner'); return { status: o?.status, fair: o?.fair?.status, verifier: o?.fair?.verified?.by?.credentialId, reviewer: o?.fair?.reviewed?.by?.credentialId, banner: !!b && b.textContent === 'TRAINING, NOT THE RECORD' && b.getBoundingClientRect().height > 0, title: document.title }; }, wo);
      ok(`${who.username} sees the closed order and its FAIR signed by two people, on a page marked training`, view.status === 'Closed' && view.fair === 'Approved' && view.verifier === 'ACCT-quality' && view.reviewer === 'ACCT-jose' && view.banner && /^Training · /.test(view.title), JSON.stringify(view));
    }

    // ---- the shared workspace on the server ----
    const ws = await api(base, await token(jose), 'GET', '/workspace');
    const state = host.MES.upgrade(ws.json);
    ok('the shared workspace validates', !!state && host.MES.validate(state) === true, JSON.stringify(host.MES.diagnose(ws.json)));
    const manifests = host.MES.verifyManifests(state);
    ok('every signature manifest in the shared workspace verifies', manifests && manifests.ok !== false && !(manifests.failures || []).length, JSON.stringify(manifests).slice(0, 300));
    const audit = await api(base, await token(jose), 'GET', '/audit?limit=1000');
    const rows = Array.isArray(audit.json?.rows) ? audit.json.rows : Array.isArray(audit.json) ? audit.json : [];
    const refused = rows.filter(row => row.action === 'action-refused').length;
    ok('the server recorded each refused request in the audit trail', audit.status === 200 && refused >= 3, `${audit.status} refused rows ${refused}`);
  } finally {
    for (const who of people) await who.context.close().catch(() => {});
    await stop(server && server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  for (run = 1; run <= RUNS; run++) {
    try { await scene(browser); } catch (error) { ok('the scene ran to the end', false, error.stack || error.message); }
  }
} finally { await browser.close(); }
ok('no page errors', errors.length === 0, errors.join(' | '));
console.log(`checks ${checks} pass ${checks - fails.length} fail ${fails.length}`);
console.log('errors', JSON.stringify(errors), 'FAILS', JSON.stringify(fails));
process.exit(fails.length ? 1 : 0);
