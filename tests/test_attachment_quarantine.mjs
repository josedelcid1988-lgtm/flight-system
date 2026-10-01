// Removing a file from a record never erases it (Jinx UX audit, must-fix 3). Like a removed recording, a removed
// operation attachment, kit list, NC ticket file or quality record file needs a written reason, leaves the live list,
// and is kept in quarantine on its record with who removed it, when, why and a SHA-256 signature manifest that also
// covers the stored content. The rule holds in the engine, over the server action route and in the page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHost } from '../server/mes-host.mjs';
import { createServer, makeHash } from '../server/server.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES, FlightManeuver } = host;
const account = (role, name) => ({ username: `quar-${role}`, displayName: name, role });
const general = account('general', 'Gale General');
const technician = account('technician', 'Terry Tech');
const operator = account('operator', 'Owen Operator');
const me = account('me', 'Morgan Engineer');
const qe = account('qe', 'Quinn Quality');
const qm = account('qm', 'Quincy Manager');
let checks = 0;
const check = (name, result) => { checks += 1; assert.ok(result, name); console.log(`ok ${name}`); };
const curated = () => JSON.parse(fs.readFileSync(new URL('./fixtures/demo_publish.html', import.meta.url), 'utf8').match(/window\.__DEMO_SEED=(\{[\s\S]*?\});/)[1]);
const photo = { name: 'torque-setup.png', type: 'image/png', size: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const REASON = 'Attached to the wrong operation.';

// One holder per surface: how to add a file, how to remove it, and where its live and quarantined files live.
function surfaces(state) {
  const order = state.orders.find(o => o.status === 'Building' && o.operations.some(op => !op.done) && o.tickets.some(t => t.status === 'Open'));
  const op = order.operations.find(item => !item.done);
  const ticket = order.tickets.find(t => t.status === 'Open');
  const kitOrder = state.orders.find(o => ['Kitting', 'Building'].includes(o.status));
  FlightManeuver.ensure(state);
  const raised = host.withAccount(qm, () => FlightManeuver.raiseNC(state, { sourceType: 'Serial number', type: 'NC', title: 'Scratched housing', description: 'Scratch on the housing face.', partNumber: 'SR-IH-040', revision: 'A', serial: 'IH-040-AQ1', quantity: 1, foundAt: 'Stock', pedigree: 'Production', escaped: 'no' }), state);
  const nc = FlightManeuver.get(state, 'ncs', raised.id);
  return [
    { label: 'operation attachment', adder: technician, remover: technician,
      add: () => MES.addAttachment(state, order.id, op.id, photo), remove: (id, reason) => MES.removeAttachment(state, order.id, op.id, id, reason),
      live: () => op.attachments || [], quarantined: () => op.quarantinedAttachments || [], history: () => order.history },
    { label: 'kit list', adder: operator, remover: operator,
      add: () => MES.addKitFile(state, kitOrder.id, photo), remove: (id, reason) => MES.removeKitFile(state, kitOrder.id, id, reason),
      live: () => kitOrder.kitFiles || [], quarantined: () => kitOrder.quarantinedKitFiles || [], history: () => kitOrder.history },
    { label: 'NC ticket file', adder: technician, remover: me,
      add: () => MES.addTicketAttachment(state, order.id, ticket.id, photo), remove: (id, reason) => MES.removeTicketAttachment(state, order.id, ticket.id, id, reason),
      live: () => ticket.attachments || [], quarantined: () => ticket.quarantinedAttachments || [], history: () => order.history },
    { label: 'quality record file', adder: technician, remover: qe,
      add: () => FlightManeuver.addRecordFile(state, 'ncs', nc.id, photo), remove: (id, reason) => FlightManeuver.removeRecordFile(state, 'ncs', nc.id, id, reason),
      live: () => nc.attachments || [], quarantined: () => nc.quarantinedAttachments || [], history: () => nc.history }
  ];
}

// ---- engine: refusals change nothing; a reasoned removal quarantines, audits and signs ----
{
  const state = curated();
  check('a saved workspace without quarantine fields loads and validates unchanged', MES.validate(structuredClone(state)) && MES.verifyManifests(state).ok);
  const run = (who, fn) => host.withAccount(who, fn, state);
  for (const s of surfaces(state)) {
    check(`a ${s.label} is attached for the quarantine checks`, run(s.adder, s.add).ok);
    const file = s.live().at(-1);
    for (const reason of [undefined, '', '   ', 'no', 123, { text: 'Attached in error.' }, ['Attached in error.']]) {
      const before = JSON.stringify(state);
      const result = run(s.remover, () => s.remove(file.id, reason));
      check(`a ${s.label} is not removed without a reason (${JSON.stringify(reason)}) and nothing changes`, result.ok === false && /Give the reason for removing/.test(result.message) && JSON.stringify(state) === before);
    }
    const before = JSON.stringify(state);
    const denied = run(general, () => s.remove(file.id, REASON));
    check(`a General User cannot remove a ${s.label}, is told why, and nothing changes`, denied.ok === false && /Your role cannot/.test(denied.message) && JSON.stringify(state) === before);
    const result = run(s.remover, () => s.remove(file.id, REASON));
    check(`a ${s.label} is removed with a reason`, result.ok && /kept in quarantine on the record/.test(result.message));
    check(`the removed ${s.label} leaves the live list`, !s.live().some(f => f.id === file.id));
    const kept = s.quarantined().find(f => f.id === file.id);
    check(`the removed ${s.label} is kept in quarantine with its content`, !!kept && kept.dataUrl === photo.dataUrl && kept.name === photo.name);
    check(`the quarantined ${s.label} records who, when and why`, kept.removeReason === REASON && Number.isFinite(Date.parse(kept.removedAt)) && !!kept.removedBy.name && !!kept.removedBy.credentialId);
    check(`the quarantined ${s.label} carries a SHA-256 manifest over the removal and the content`, kept.manifest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(kept.manifest.hash) && kept.manifest.subject.fileId === file.id && kept.manifest.subject.removeReason === REASON && /^[0-9a-f]{64}$/.test(kept.manifest.subject.contentSha256) && kept.manifest.signer.credentialId === kept.removedBy.credentialId);
    check(`the ${s.label} removal is in the record history with the reason`, JSON.stringify(s.history()).includes(REASON));
    const next = run(s.adder, s.add);
    check(`a new ${s.label} after a removal gets a new ID, never the quarantined one, and the workspace stays valid`, next.ok && s.live().at(-1).id !== file.id && !s.quarantined().some(f => f.id === s.live().at(-1).id) && MES.validate(state));
    const again = run(s.remover, () => s.remove(file.id, REASON));
    check(`a quarantined ${s.label} cannot be removed a second time`, again.ok === false && s.quarantined().filter(f => f.id === file.id).length === 1);
  }
  check('the workspace validates after every removal', MES.validate(state));
  // A quarantine entry with no removal record, or a malformed one, is not a valid workspace.
  const malformed = structuredClone(state), mOp = malformed.orders.flatMap(o => o.operations).find(x => (x.quarantinedAttachments || []).length);
  delete mOp.quarantinedAttachments[0].removeReason;
  check('a quarantined file without its removal reason fails validation', !MES.validate(malformed));
  const notList = structuredClone(state); notList.orders.find(o => o.quarantinedKitFiles).quarantinedKitFiles = 'gone';
  check('a quarantine that is not a list fails validation', !MES.validate(notList));
  const badRec = structuredClone(state); badRec.maneuver.ncs.find(t => (t.quarantinedAttachments || []).length).quarantinedAttachments[0].removedAt = 'yesterday';
  check('a quality record quarantine entry with a bad removal time fails validation', !MES.validate(badRec));
  // The removal details shown on an entry are bound to its signed manifest: editing any of them is caught.
  for (const [field, change] of [['removeReason', f => { f.removeReason = 'A friendlier reason.'; }], ['removedBy', f => { f.removedBy = { ...f.removedBy, name: 'Someone Else' }; }], ['removedAt', f => { f.removedAt = new Date(Date.parse(f.removedAt) - 86400000).toISOString(); }], ['name', f => { f.name = 'renamed.png'; }], ['manifest', f => { delete f.manifest; }]]) {
    const forged = structuredClone(state), entry = forged.orders.flatMap(o => o.operations).find(x => (x.quarantinedAttachments || []).length).quarantinedAttachments[0];
    change(entry);
    const verify = MES.verifyManifests(forged);
    check(`a quarantine entry whose ${field} was changed after signing fails validation and manifest verification`, !MES.validate(forged) && !verify.ok && verify.failures.some(f => /signed removal record/.test(f.reason)));
  }
  // A quality record file may be larger than an operation file; it keeps its size in quarantine.
  {
    const big = structuredClone(state), bigNc = FlightManeuver.get(big, 'ncs', big.maneuver.ncs.find(t => t.status === 'Open').id);
    const large = { name: 'large-scan.png', type: 'image/png', size: 450000, dataUrl: `data:image/png;base64,${'A'.repeat(500000)}` };
    big.orders.forEach(o => { o.operations.forEach(x => { x.attachments = []; delete x.quarantinedAttachments; }); delete o.quarantinedKitFiles; o.tickets.forEach(t => delete t.quarantinedAttachments); });
    Object.values(big.maneuver).forEach(list => Array.isArray(list) && list.forEach(r => { if (r) delete r.quarantinedAttachments; }));
    const added = host.withAccount(technician, () => FlightManeuver.addRecordFile(big, 'ncs', bigNc.id, large), big);
    const removed = added.ok && host.withAccount(qe, () => FlightManeuver.removeRecordFile(big, 'ncs', bigNc.id, bigNc.attachments.at(-1).id, REASON), big);
    check('a large quality record file is quarantined and the workspace stays valid', added.ok && removed.ok && MES.validate(big) && MES.verifyManifests(big).ok);
  }
  // Quarantined files count toward the workspace limit for every file adder, quality records and kit lists included.
  {
    const heavy = structuredClone(state), hNc = heavy.maneuver.ncs.find(t => t.status === 'Open');
    const filler = { ...hNc.quarantinedAttachments[0], dataUrl: `data:image/png;base64,${'B'.repeat(890000)}` };
    hNc.quarantinedAttachments = [0, 1, 2, 3].map(i => ({ ...filler, id: `${filler.id}-H${i}`, manifest: { ...filler.manifest, subject: { ...filler.manifest.subject, fileId: `${filler.id}-H${i}` } } }));
    const big = { name: 'more.png', type: 'image/png', size: 200000, dataUrl: `data:image/png;base64,${'C'.repeat(250000)}` };
    const kitOrder = heavy.orders.find(o => ['Kitting', 'Building'].includes(o.status));
    const kit = host.withAccount(operator, () => MES.addKitFile(heavy, kitOrder.id, big), heavy);
    const rec = host.withAccount(technician, () => FlightManeuver.addRecordFile(heavy, 'ncs', hNc.id, big), heavy);
    check('a kit list is refused when quarantined files fill the workspace limit, with what to do', kit.ok === false && /near its attachment limit, and removed files stay in quarantine/.test(kit.message));
    check('a quality record file is refused when quarantined files fill the workspace limit, with what to do', rec.ok === false && /near its attachment limit/.test(rec.message));
    check('a file logged by name only is still accepted at the limit', host.withAccount(operator, () => MES.addKitFile(heavy, kitOrder.id, { name: 'kit-by-name.pdf', type: 'application/pdf', size: 10 }), heavy).ok);
  }
  // Quarantine is capped per record, with a plain refusal once full.
  {
    const full = structuredClone(state), fOrder = full.orders.find(o => o.operations.some(x => (x.quarantinedAttachments || []).length)), fOp = fOrder.operations.find(x => (x.quarantinedAttachments || []).length);
    const sample = fOp.quarantinedAttachments[0];
    fOp.quarantinedAttachments = Array.from({ length: 50 }, (_, i) => ({ ...sample, id: `${sample.id}-Q${i}`, manifest: { ...sample.manifest, subject: { ...sample.manifest.subject, fileId: `${sample.id}-Q${i}` } } }));
    check('a full quarantine still validates', MES.validate(full));
    host.withAccount(technician, () => MES.addAttachment(full, fOrder.id, fOp.id, { name: 'one-more.txt', type: 'text/plain', size: 4 }), full);
    const fileId = fOp.attachments.at(-1).id, before = JSON.stringify(full);
    const refused = host.withAccount(technician, () => MES.removeAttachment(full, fOrder.id, fOp.id, fileId, REASON), full);
    check('a removal into a full quarantine is refused with what to do, and nothing changes', refused.ok === false && /holds 50 removed files in quarantine\. Ask a QA Manager/.test(refused.message) && JSON.stringify(full) === before);
  }
  // Splitting an order does not copy removal records onto the new order; they stay where the file was removed.
  {
    const split = structuredClone(state), qmUser = { username: 'quar-qm', displayName: 'Quincy Manager', role: 'qm' };
    const parent = split.orders.find(o => ['Draft', 'Kitting'].includes(o.status) && o.quantity >= 2 && !o.splitFrom);
    check('a splittable order is found for the split check', !!parent);
    const op = parent.operations[0], opBefore = (op.quarantinedAttachments || []).length, kitBefore = (parent.quarantinedKitFiles || []).length;
    const files = host.withAccount(qmUser, () => [MES.addAttachment(split, parent.id, op.id, photo), MES.addKitFile(split, parent.id, photo)], split);
    const removed = files.every(r => r.ok) && host.withAccount(qmUser, () => [MES.removeAttachment(split, parent.id, op.id, op.attachments.at(-1).id, REASON), MES.removeKitFile(split, parent.id, parent.kitFiles.at(-1).id, REASON)], split);
    check('the parent order has quarantined files before the split', removed && removed.every(r => r.ok) && op.quarantinedAttachments.length === opBefore + 1 && parent.quarantinedKitFiles.length === kitBefore + 1);
    const result = host.withAccount(qmUser, () => MES.splitOrder(split, parent.id, 1), split);
    const child = split.orders.find(o => o.splitFrom === parent.id);
    check('a split order carries no quarantined files from its parent, and the parent keeps them', result.ok && !!child && child.quarantinedKitFiles === undefined && child.operations.every(x => x.quarantinedAttachments === undefined) && op.quarantinedAttachments.length === opBefore + 1 && parent.quarantinedKitFiles.length === kitBefore + 1 && MES.validate(split) && MES.verifyManifests(split).ok);
  }
  const verified = MES.verifyManifests(state);
  check('every removal manifest verifies', verified.ok && verified.recomputed > 0);
  const tampered = structuredClone(state), op = tampered.orders.flatMap(o => o.operations).find(x => (x.quarantinedAttachments || []).length);
  op.quarantinedAttachments[0].dataUrl = 'data:image/png;base64,AAAA';
  check('a quarantined file whose content changed fails manifest verification', MES.verifyManifests(tampered).failures.some(f => /quarantined file content does not match/.test(f.reason)));
  const edited = structuredClone(state), edOp = edited.orders.flatMap(o => o.operations).find(x => (x.quarantinedAttachments || []).length);
  edOp.quarantinedAttachments[0].manifest.subject.removeReason = 'Changed later.';
  check('a removal record edited after signing fails manifest verification', !MES.verifyManifests(edited).ok);
}

// ---- server: POST /api/workspace/actions refuses a reasonless or unauthorized removal and quarantines a reasoned one ----
{
  const server = createServer({ dbPath: ':memory:', quiet: true, setupCode: 'attachment-quarantine' });
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
    for (const [username, role] of [['srv-tech', 'technician'], ['srv-gen', 'general'], ['srv-me', 'me']]) await server.store.upsertAccount({ username, displayName: `Server ${role}`, salt: '', hash: await makeHash(`${username}-pass-1`), role, roles: [role] });
    const state = curated();
    const order = state.orders.find(o => o.status === 'Building' && o.operations.some(op => !op.done) && o.tickets.some(t => t.status === 'Open'));
    const op = order.operations.find(item => !item.done), ticket = order.tickets.find(t => t.status === 'Open');
    host.withAccount(technician, () => { MES.addAttachment(state, order.id, op.id, photo); MES.addTicketAttachment(state, order.id, ticket.id, photo); }, state);
    const opFile = op.attachments.at(-1).id, ticketFile = ticket.attachments.at(-1).id;
    await server.store.putDoc('default', JSON.stringify(state), null, 'attachment-quarantine');
    const token = async username => (await call('POST', '/api/auth/session', null, { username, password: `${username}-pass-1` })).json.token;
    const tech = await token('srv-tech'), gen = await token('srv-gen'), eng = await token('srv-me');
    const doc = async () => JSON.parse((await server.store.getDoc('default')).json);
    const etag = async () => (await server.store.getDoc('default')).etag;
    const post = async (who, action, args) => call('POST', `/api/workspace/actions/MES.${action}`, who, { args }, { 'If-Match': await etag() });
    const liveOp = async () => (await doc()).orders.find(o => o.id === order.id).operations.find(x => x.id === op.id);
    const liveTicket = async () => (await doc()).orders.find(o => o.id === order.id).tickets.find(t => t.id === ticket.id);

    let was = await etag();
    const noReason = await post(tech, 'removeAttachment', [order.id, op.id, opFile]);
    check('over the server an operation attachment is not removed without a reason (403), nothing is written', noReason.status === 403 && /Give the reason for removing/.test(noReason.json.error) && await etag() === was && (await liveOp()).attachments.some(f => f.id === opFile));
    const blank = await post(tech, 'removeAttachment', [order.id, op.id, opFile, '  ']);
    check('over the server a blank reason is refused the same way', blank.status === 403 && await etag() === was);
    const objectReason = await post(tech, 'removeAttachment', [order.id, op.id, opFile, { text: REASON }]);
    check('over the server a reason that is not text is refused the same way', objectReason.status === 403 && /Give the reason for removing/.test(objectReason.json.error) && await etag() === was);
    const denied = await post(gen, 'removeAttachment', [order.id, op.id, opFile, REASON]);
    check('over the server a General User cannot remove an operation attachment (403), nothing is written', denied.status === 403 && /Your role cannot/.test(denied.json.error) && await etag() === was);
    const removed = await post(tech, 'removeAttachment', [order.id, op.id, opFile, REASON]);
    const after = await liveOp();
    check('over the server a Technician removes an operation attachment with a reason and it is quarantined', removed.status === 200 && !after.attachments.some(f => f.id === opFile) && after.quarantinedAttachments.some(f => f.id === opFile && f.removeReason === REASON && f.dataUrl === photo.dataUrl && /^[0-9a-f]{64}$/.test(f.manifest.hash)));

    was = await etag();
    const ticketNoReason = await post(eng, 'removeTicketAttachment', [order.id, ticket.id, ticketFile]);
    check('over the server an NC ticket file is not removed without a reason (403), nothing is written', ticketNoReason.status === 403 && await etag() === was);
    const ticketDenied = await post(tech, 'removeTicketAttachment', [order.id, ticket.id, ticketFile, REASON]);
    check('over the server a Technician cannot remove an NC ticket file (403)', ticketDenied.status === 403 && /Your role cannot/.test(ticketDenied.json.error) && await etag() === was);
    const ticketRemoved = await post(eng, 'removeTicketAttachment', [order.id, ticket.id, ticketFile, REASON]);
    check('over the server Manufacturing Engineering removes an NC ticket file with a reason and it is quarantined', ticketRemoved.status === 200 && (await liveTicket()).quarantinedAttachments.some(f => f.id === ticketFile && f.removeReason === REASON));
    check('the server workspace still validates and every manifest verifies', MES.validate(await doc()) && MES.verifyManifests(await doc()).ok);
  } finally { server.store.close(); }
}

// ---- page: Remove asks for a confirmation and a reason; the file moves to the quarantine view, not away ----
{
  const fixture = new URL('./fixtures/demo_qa150_publish.html', import.meta.url).href;
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const users = [{ username: 'admin', displayName: 'Flight Master', role: 'admin' }, { username: 'engineering', displayName: 'Gale General', role: 'general' }];
  const openAs = async username => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await context.addInitScript(([users, username]) => {
      localStorage.setItem('skyryse-mes-auth-v1', JSON.stringify({ users: users.map(u => ({ ...u, salt: 'test', hash: 'unused', createdAt: new Date().toISOString() })) }));
      sessionStorage.setItem('skyryse-mes-session-v1', username);
      sessionStorage.setItem('sk-boot-seen', '1');
    }, [users, username]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture);
    await page.waitForFunction(() => window.__ready === true);
    return { page, errors, context };
  };
  try {
    const { page, errors, context } = await openAs('admin');
    // An operation attachment on a Building order, shown on its operation.
    const target = await page.evaluate(photo => {
      const o = state.orders.find(o => o.status === 'Building' && !MES.blockingTickets(o).length && o.operations.some(op => !op.done));
      const op = o.operations.find(x => !x.done);
      const added = MES.addAttachment(state, o.id, op.id, photo);
      if (!added.ok || !save()) return { error: added.message };
      view = 'order'; selectedId = o.id; selectedOp = op.id; tab = 'operations'; render();
      return { order: o.id, op: op.id, file: op.attachments.at(-1).id };
    }, photo);
    assert.equal(target.error, undefined, `an attachment is added for the page check: ${target.error}`);
    const liveHas = () => page.evaluate(t => MES.getOrder(state, t.order).operations.find(x => x.id === t.op).attachments.some(f => f.id === t.file), target);
    const removeButton = page.locator(`[data-action="att-remove"][data-file="${target.file}"]`).first();
    await removeButton.click();
    const dialog = page.locator('#dialog');
    await dialog.getByRole('button', { name: 'Remove and quarantine' }).waitFor();
    check('Remove opens a confirmation that says the file is quarantined, not erased', /not erased: it stays in quarantine/.test(await dialog.innerText()));
    await dialog.getByRole('button', { name: 'Remove and quarantine' }).click();
    check('confirming without a reason shows the refusal and keeps the file', /Give the reason for removing/.test(await page.locator('#remove-file-error').innerText()) && await liveHas());
    await dialog.getByRole('button', { name: 'Keep file' }).click();
    check('Keep file closes the confirmation and changes nothing', await liveHas() && await page.evaluate(t => !(MES.getOrder(state, t.order).operations.find(x => x.id === t.op).quarantinedAttachments || []).length, target));
    await removeButton.click();
    await page.locator('#remove-file-reason').fill(REASON);
    await dialog.getByRole('button', { name: 'Remove and quarantine' }).click();
    await page.waitForFunction(t => !MES.getOrder(state, t.order).operations.find(x => x.id === t.op).attachments.some(f => f.id === t.file), target);
    const saved = await page.evaluate(t => { const stored = JSON.parse(localStorage.getItem(KEY)); const op = stored.orders.find(o => o.id === t.order).operations.find(x => x.id === t.op); return { live: op.attachments.some(f => f.id === t.file), kept: (op.quarantinedAttachments || []).find(f => f.id === t.file) }; }, target);
    check('the reasoned removal is saved with the file in quarantine', !saved.live && !!saved.kept && saved.kept.removeReason === REASON);
    check('the removed file is not in the normal attachment list', await page.locator(`[data-action="att-remove"][data-file="${target.file}"]`).count() === 0 && await page.locator(`[data-action="att-view"][data-file="${target.file}"]`).count() === 0);
    const quarantine = page.locator('details.att-quarantine').first();
    await quarantine.locator('summary').click();
    const shown = await quarantine.innerText();
    check('the quarantine view lists the removed file with who, why and its SHA-256', shown.includes(photo.name) && shown.includes(REASON) && shown.includes('removed by Flight Master') && /SHA-256 [0-9a-f]{16}/.test(shown));
    const download = page.waitForEvent('download');
    await quarantine.getByRole('button', { name: 'Download' }).click();
    check('a quarantined file can still be downloaded', (await download).suggestedFilename() === photo.name);

    // A quality record file, removed from the record files dialog, goes the same way.
    const rec = await page.evaluate(photo => { FlightManeuver.ensure(state); const raised = FlightManeuver.raiseNC(state, { sourceType: 'Serial number', type: 'NC', title: 'Scratched housing', description: 'Scratch on the housing face.', partNumber: 'SR-IH-040', revision: 'A', serial: 'IH-040-AQ2', quantity: 1, foundAt: 'Stock', pedigree: 'Production', escaped: 'no' }); if (!raised.ok) return { error: raised.message }; const nc = FlightManeuver.get(state, 'ncs', raised.id); const r = FlightManeuver.addRecordFile(state, 'ncs', nc.id, photo); if (!r.ok || !save()) return { error: r.message }; recordFilesDialog('ncs', nc.id); return { id: nc.id, file: nc.attachments.at(-1).id }; }, photo);
    assert.equal(rec.error, undefined, `a record file is added for the page check: ${rec.error}`);
    await page.locator(`#dialog [data-action="rec-att-remove"][data-file="${rec.file}"]`).click();
    await page.locator('#remove-file-reason').fill('Duplicate of the inspection photo.');
    await dialog.getByRole('button', { name: 'Remove and quarantine' }).click();
    await page.waitForFunction(r => !FlightManeuver.get(state, 'ncs', r.id).attachments.some(f => f.id === r.file), rec);
    check('a quality record file removed from its dialog is quarantined and listed apart when the dialog reopens', await page.locator('#dialog details.att-quarantine').count() === 1 && await page.evaluate(r => FlightManeuver.get(state, 'ncs', r.id).quarantinedAttachments.some(f => f.id === r.file), rec));
    check('the page raised no errors', errors.length === 0);
    await context.close();

    // A role without the authority sees the attachment but gets no Remove button. The demo build relaxes roles
    // except on its pilot seats, so the General User signs in on the engineering pilot seat, which keeps its role.
    const gale = await openAs('engineering');
    const galeHas = await gale.page.evaluate(photo => {
      const o = state.orders.find(o => o.status === 'Building' && !MES.blockingTickets(o).length && o.operations.some(op => !op.done)), op = o.operations.find(x => !x.done), id = `ATT-${op.id}-99`;
      op.attachments = [...(op.attachments || []), { id, ...photo, storage: 'inline', addedAt: new Date().toISOString(), addedBy: { name: 'Flight Master', role: 'Master Access', credentialId: 'ACCT-admin' } }];
      view = 'order'; selectedId = o.id; selectedOp = op.id; tab = 'operations'; render();
      return id;
    }, photo);
    await gale.page.locator(`[data-action="att-view"][data-file="${galeHas}"]`).first().waitFor();
    check('a General User sees the attachment but no Remove button', await gale.page.locator(`[data-action="att-remove"][data-file="${galeHas}"]`).count() === 0);
    check('the General User page raised no errors', gale.errors.length === 0);
    await gale.context.close();
  } finally { await browser.close(); }
}

console.log(`attachment quarantine: ${checks} checks, all passed`);
