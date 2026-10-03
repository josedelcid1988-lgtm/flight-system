// Issue #581: the Quality approval of a Rework or Repair disposition and the QA sequence release that closes the
// ticket each write a SHA-256 signature manifest (AGENTS.md rule 2). MES.validate and MES.verifyManifests recompute
// both from the stored record, so an edit to the approved plan, the approver, the released operation or the releaser
// is refused, and a newly resolved Rework ticket whose release signature was removed is refused. A plan approved
// before these signatures existed carries neither: it still loads and validates, and verifyManifests lists it under
// unsignedLegacy instead of failing it. Drives the production engine through the server host.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const fails = [];
const ok = (what, cond, more = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + what + (cond ? '' : ' -> ' + more)); if (!cond) fails.push(what); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const seed = name => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../tools/demo/${name}.json`, import.meta.url)), 'utf8'));
const account = (role, username, displayName) => ({ username, displayName, role });
const qm = account('qm', 'rw-qm', 'Quincy Manager');
const me = account('me', 'rw-me', 'Morgan Engineer');
const qe = account('qe', 'rw-qe', 'Quinn Quality');
const qe2 = account('qe', 'rw-qe2', 'Riley Release');
const APPROVAL = 'Quality approval of ME rework or repair disposition';
const RELEASE = 'QA release of ME rework or repair operation';
const verify = state => MES.verifyManifests(state);
const failsAt = (state, pattern) => verify(state).failures.some(f => pattern.test(f.where));
const detail = state => (MES.diagnose(state) || {}).detail || '';
const reworkOp = (state, orderId, ticketId, classification) => MES.addOrderOperation(state, orderId, { ticketId, position: MES.getOrder(state, orderId).operations.length, title: `${classification} J3`, description: `${classification} J3 per the drawing.`, classification, buyoffType: 'Technician', requiresTooling: false, steps: [{ title: classification, instruction: `${classification} J3.` }] });

// Raises an NC on the order, has ME disposition it and Quality approve it; release() has ME add the operation and a
// second Quality account release the sequence.
function walk(seedName, orderId, decision, details = {}, prepare = () => {}) {
  const state = MES.upgrade(structuredClone(seed(seedName)));
  prepare(state);
  const as = (who, fn) => host.withAccount(who, fn, state);
  const order = MES.getOrder(state, orderId);
  const op = order.operations.find(item => !item.done) || order.operations[0];
  const out = { state, orderId };
  out.create = as(qm, () => MES.createTicket(state, orderId, op.id, { type: 'NC', title: 'Torque out of spec', description: 'J3 torque below the drawing value.', hold: true }));
  out.ticketId = out.create.id;
  out.dispo = as(me, () => MES.dispositionTicket(state, orderId, out.ticketId, { decision, note: `${decision} J3.` }));
  out.approve = as(qe, () => MES.resolveTicket(state, orderId, out.ticketId, `${decision} approved: restore J3 to the drawing.`, { defectCode: 'DIM', subCode: 'DIM-02', ...details }));
  out.ticket = () => MES.getOrder(state, out.orderId).tickets.find(t => t.id === out.ticketId);
  out.approvedPlan = structuredClone(out.ticket().reworkPlan);
  out.approvedValid = MES.validate(state);
  out.approvedVerify = verify(state);
  out.release = () => {
    out.add = as(me, () => reworkOp(state, out.orderId, out.ticketId, decision));
    out.released = as(qe2, () => MES.approveSequenceChange(state, out.orderId));
    return out;
  };
  return out;
}

// ---- Rework: approval and release are both signed and verify (the issue's reproduction, WO-10006) ----
const rework = walk('seed-curated', 'WO-10006', 'Rework');
{
  const plan = rework.approvedPlan;
  ok('Rework: the NC is raised, dispositioned and approved', rework.create.ok && rework.dispo.ok && rework.approve.ok, JSON.stringify([rework.create, rework.dispo, rework.approve]));
  ok('Rework: the Quality approval writes a manifest on the rework plan', plain(plan.manifest) && plan.manifest.meaning === APPROVAL && plan.manifest.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(plan.manifest.hash), JSON.stringify(plan.manifest));
  ok('Rework: the approval manifest names the approver, their credential and the approval time', plan.manifest.signer.name === 'Quinn Quality' && plan.manifest.signer.credentialId === 'ACCT-rw-qe' && plan.manifest.at === plan.approvedAt && plan.approvedBy.credentialId === 'ACCT-rw-qe');
  ok('Rework: the approval manifest binds the order, ticket, decision, rationale and affected units', plan.manifest.subject.orderId === 'WO-10006' && plan.manifest.subject.ticketId === rework.ticketId && plan.manifest.subject.decision === 'Rework' && plan.manifest.subject.approval === plan.approval && plain(plan.manifest.subject.affected) && plan.manifest.subject.affected.defectCode === 'DIM');
  ok('Rework: the approved workspace validates and every manifest verifies', rework.approvedValid && rework.approvedVerify.ok, JSON.stringify(rework.approvedVerify.failures));
  ok('Rework: the approval is not counted as unsigned legacy', !rework.approvedVerify.unsignedLegacy.some(w => w.includes(rework.ticketId)), JSON.stringify(rework.approvedVerify.unsignedLegacy));
  rework.release();
  const t = rework.ticket();
  ok('Rework: ME adds the operation and a second Quality account releases the sequence', rework.add.ok && rework.released.ok, JSON.stringify([rework.add, rework.released]));
  ok('Rework: the release closes the ticket with a release manifest', t.status === 'Resolved' && plain(t.manifest) && t.manifest.meaning === RELEASE && t.manifest.at === t.resolvedAt, JSON.stringify(t.manifest && t.manifest.meaning));
  ok('Rework: the release manifest names the releaser, not the approver', t.manifest.signer.credentialId === 'ACCT-rw-qe2' && t.reworkPlan.releasedBy.credentialId === 'ACCT-rw-qe2');
  ok('Rework: the release manifest binds the released operation and the approval signature', !!t.reworkPlan.opId && t.manifest.subject.opId === t.reworkPlan.opId && t.manifest.subject.approvalHash === t.reworkPlan.manifest.hash);
  ok('Rework: the approval manifest is unchanged by the release', JSON.stringify(t.reworkPlan.manifest) === JSON.stringify(rework.approvedPlan.manifest));
  const v = verify(rework.state);
  ok('Rework: the released workspace validates and every manifest verifies', MES.validate(rework.state) && v.ok, JSON.stringify(v.failures));
}

// ---- Repair: WO-10003 is set to Development NFF here, so the Repair needs no MRB board before Quality approves ----
const repair = walk('seed-curated', 'WO-10003', 'Repair', {}, state => { MES.getOrder(state, 'WO-10003').pedigree = 'Development NFF'; });
{
  ok('Repair: the approval is signed and verifies', repair.approve.ok && plain(repair.approvedPlan.manifest) && repair.approvedPlan.manifest.meaning === APPROVAL && repair.approvedPlan.manifest.subject.decision === 'Repair' && repair.approvedValid && repair.approvedVerify.ok, JSON.stringify([repair.approve, repair.approvedVerify.failures]));
  repair.release();
  const t = repair.ticket();
  ok('Repair: the release is signed and the ticket closes', repair.released.ok && t.status === 'Resolved' && plain(t.manifest) && t.manifest.meaning === RELEASE && t.manifest.subject.decision === 'Repair', JSON.stringify([repair.add, repair.released]));
  ok('Repair: the released workspace validates and every manifest verifies', MES.validate(repair.state) && verify(repair.state).ok, JSON.stringify(verify(repair.state).failures));
}

// ---- Tamper: an edit to a signed field is refused by validate and fails verifyManifests ----
{
  const tamper = (what, edit, where) => {
    const copy = structuredClone(rework.state);
    edit(MES.getOrder(copy, 'WO-10006').tickets.find(t => t.id === rework.ticketId));
    ok(`Tamper: ${what} is refused by validate`, MES.validate(copy) === false);
    ok(`Tamper: ${what} fails verifyManifests at the ${where}`, failsAt(copy, new RegExp(`${rework.ticketId} rework ${where}`)), JSON.stringify(verify(copy).failures));
    return copy;
  };
  const edited = tamper('editing the approved rework rationale', t => { t.reworkPlan.approval = 'Use as is.'; }, 'approval');
  ok('Tamper: diagnose names the changed approval', /Quality approval signature does not match the approved rework plan/.test(detail(edited)), detail(edited));
  tamper('changing the approver', t => { t.reworkPlan.approvedBy = { ...t.reworkPlan.approvedBy, name: 'Someone Else' }; }, 'approval');
  tamper('changing the approver credential on the plan and the signature', t => { t.reworkPlan.approvedBy = { ...t.reworkPlan.approvedBy, credentialId: 'ACCT-other' }; t.reworkPlan.manifest.signer.credentialId = 'ACCT-other'; }, 'approval');
  tamper('changing the affected units after approval', t => { t.affected = { ...t.affected, subCode: 'DIM-01' }; }, 'approval');
  const op = tamper('changing the released operation', t => { t.reworkPlan.opId = MES.getOrder(rework.state, 'WO-10006').operations[0].id; }, 'release');
  ok('Tamper: diagnose names the changed release', /(QA release signature does not match the release record|no longer on the work order)/.test(detail(op)), detail(op));
  tamper('changing the releaser', t => { t.reworkPlan.releasedBy = { ...t.reworkPlan.releasedBy, name: 'Someone Else' }; }, 'release');
  tamper('changing the resolver', t => { t.resolvedBy = { ...t.resolvedBy, name: 'Someone Else' }; }, 'release');
  // Codex P1 on #602: the signer on the manifest is the whole identity, not the credential alone.
  tamper('changing the approval signer name', t => { t.reworkPlan.manifest.signer.name = 'Impostor'; }, 'approval');
  tamper('changing the approval signer role', t => { t.reworkPlan.manifest.signer.role = 'Quality Manager'; }, 'approval');
  tamper('changing the release signer name', t => { t.manifest.signer.name = 'Impostor'; }, 'release');
  tamper('changing the release signer role', t => { t.manifest.signer.role = 'Quality Manager'; }, 'release');
  // Codex P1 on #602: a released ticket set back to Open is still checked; the release cannot be undone.
  const reopened = tamper('reopening a released ticket', t => { t.status = 'Open'; t.resolution = ''; t.resolvedAt = null; delete t.resolvedBy; }, 'release');
  ok('Tamper: diagnose names the reopened ticket', /carries a QA release but is open again/.test(detail(reopened)), detail(reopened));
  tamper('reopening a released ticket and removing its release signature', t => { t.status = 'Open'; t.resolution = ''; t.resolvedAt = null; delete t.resolvedBy; delete t.manifest; }, 'release');
  // Codex P1 on #602 (3792f0e): the stored subject inside each signature must be the record that was signed.
  // verifyManifests already caught these by the stored subject's own hash; validate now refuses them too.
  // Codex P2 on #602 (3246580): a removed stored subject fails verifyManifests too, not only validate.
  for (const [what, edit] of [['approval', t => { delete t.reworkPlan.manifest.subject; }], ['release', t => { delete t.manifest.subject; }]]) {
    const copy = structuredClone(rework.state);
    edit(MES.getOrder(copy, 'WO-10006').tickets.find(t => t.id === rework.ticketId));
    ok(`Tamper: removing the stored subject of the ${what} signature is refused by validate`, MES.validate(copy) === false, detail(copy));
    ok(`Tamper: removing the stored subject of the ${what} signature fails verifyManifests`, failsAt(copy, new RegExp(`${rework.ticketId} rework ${what}`)) && verify(copy).failures.some(f => /no stored subject/.test(f.reason)), JSON.stringify(verify(copy).failures));
  }
  for (const [what, edit] of [['approval', t => { t.reworkPlan.manifest.subject.approval = 'Use as is.'; }], ['release', t => { t.manifest.subject.opId = 'op-1'; }]]) {
    const copy = structuredClone(rework.state);
    edit(MES.getOrder(copy, 'WO-10006').tickets.find(t => t.id === rework.ticketId));
    ok(`Tamper: editing the stored subject of the ${what} signature is refused by validate`, MES.validate(copy) === false, detail(copy));
    ok(`Tamper: editing the stored subject of the ${what} signature fails verifyManifests`, !verify(copy).ok, JSON.stringify(verify(copy).failures));
  }
  tamper('changing the closing rationale', t => { t.resolution = 'Closed.'; }, 'release');
  tamper('swapping in a re-signed approval under the old release', t => { t.reworkPlan.approval = 'Use as is.'; t.reworkPlan.manifest = host.withAccount(qe, () => MES.signManifest(rework.state, APPROVAL, { ...t.reworkPlan.manifest.subject, approval: 'Use as is.' }, t.reworkPlan.approvedAt)); }, 'release');
}

// ---- Refusal: a newly resolved Rework ticket with a signature removed or replaced ----
{
  const ticketIn = state => MES.getOrder(state, 'WO-10006').tickets.find(t => t.id === rework.ticketId);
  const stripped = structuredClone(rework.state);
  delete ticketIn(stripped).manifest;
  ok('Refusal: validate refuses a resolved Rework ticket whose release manifest was removed', MES.validate(stripped) === false);
  ok('Refusal: verifyManifests fails it instead of skipping it', !verify(stripped).ok && verify(stripped).failures.some(f => f.where.endsWith(`${rework.ticketId} rework release`) && /not signed/.test(f.reason)), JSON.stringify(verify(stripped).failures));
  ok('Refusal: diagnose says the release that closed it is not signed', /is closed, but the QA release that closed it is not signed/.test(detail(stripped)), detail(stripped));
  const r = host.withAccount(qm, () => MES.setPriority(stripped, 'WO-10006', 'High'));
  ok('Refusal: a write to the work order is refused while the release is unsigned', r && r.ok === false, JSON.stringify(r));
  const emptied = structuredClone(rework.state);
  delete ticketIn(emptied).reworkPlan.manifest;
  ok('Refusal: removing the approval manifest breaks the release signature that binds it', MES.validate(emptied) === false && failsAt(emptied, new RegExp(`${rework.ticketId} rework release`)), JSON.stringify(verify(emptied).failures));
  const relabeled = structuredClone(rework.state);
  { const t = ticketIn(relabeled); t.manifest = host.withAccount(qe2, () => MES.signManifest(relabeled, 'Quality approval of ME disposition', { orderId: 'WO-10006' }, t.resolvedAt)); }
  ok('Refusal: a release signed with another meaning is refused', MES.validate(relabeled) === false && failsAt(relabeled, new RegExp(`${rework.ticketId} rework release`)), JSON.stringify(verify(relabeled).failures));
}

// ---- NC split: a signed plan moved to the new order keeps its approval and is released there ----
{
  const state = MES.upgrade(structuredClone(seed('seed-curated')));
  const as = (who, fn) => host.withAccount(who, fn, state);
  const parentId = 'WO-10007', parent = MES.getOrder(state, parentId);
  const serials = (state.serialLog || []).filter(e => e.orderId === parentId).map(e => e.serial);
  const op = parent.operations.find(item => !item.done) || parent.operations[0];
  const created = as(qm, () => MES.createTicket(state, parentId, op.id, { type: 'NC', title: 'Torque out of spec', description: 'J3 torque below the drawing value on one unit.', hold: true }));
  as(me, () => MES.dispositionTicket(state, parentId, created.id, { decision: 'Rework', note: 'Rework J3.' }));
  const approved = as(qe, () => MES.resolveTicket(state, parentId, created.id, 'Rework approved for the affected unit.', { defectCode: 'DIM', subCode: 'DIM-02', quantity: 1, serials: serials.slice(0, 1) }));
  const sr = (parent.splitRequests || []).find(x => x.ticketId === created.id);
  const split = sr ? as(me, () => MES.splitRequestOrder(state, parentId, sr.id)) : { ok: false, message: 'no split request' };
  const child = split.ok ? MES.getOrder(state, split.id) : null;
  const moved = child && child.tickets.find(t => t.id === created.id);
  ok('Split: the approved Rework NC moves to the new order', approved.ok && split.ok && !!moved, JSON.stringify([approved, split]));
  ok('Split: the moved plan records the order it was approved on', !!moved && plain(moved.reworkPlan.carriedFrom) && moved.reworkPlan.carriedFrom.orderId === parentId);
  ok('Split: the moved approval validates and verifies on the new order', MES.validate(state) && verify(state).ok, JSON.stringify(verify(state).failures));
  if (moved) {
    const add = as(me, () => reworkOp(state, split.id, created.id, 'Rework'));
    const rel = as(qe2, () => MES.approveSequenceChange(state, split.id));
    const done = MES.getOrder(state, split.id).tickets.find(t => t.id === created.id);
    ok('Split: the release on the new order is signed and verifies', add.ok && rel.ok && done.status === 'Resolved' && done.manifest.meaning === RELEASE && MES.validate(state) && verify(state).ok, JSON.stringify([add, rel, verify(state).failures]));
    const forged = structuredClone(state);
    MES.getOrder(forged, split.id).tickets.find(t => t.id === created.id).reworkPlan.carriedFrom = { orderId: split.id };
    ok('Split: changing the carried order id breaks the approval signature', MES.validate(forged) === false && failsAt(forged, new RegExp(`${created.id} rework approval`)), JSON.stringify(verify(forged).failures));
  }
}

// ---- Legacy: plans approved before #581 have no manifests and still load ----
{
  const raw = seed('seed-curated');
  const legacyTicket = raw.orders.find(o => o.id === 'WO-10005').tickets.find(t => t.id === 'NC-0001');
  ok('Legacy: the curated sample carries a pre-#581 plan with no approval manifest', plain(legacyTicket.reworkPlan) && legacyTicket.reworkPlan.manifest === undefined && legacyTicket.reworkPlan.stage === 'Awaiting QA release');
  const state = MES.upgrade(structuredClone(raw));
  ok('Legacy: the workspace upgrades and validates', !!state && MES.validate(state));
  const v = verify(state);
  ok('Legacy: verifyManifests passes and lists the unsigned approval instead of failing it', v.ok && v.complete === false && v.unsignedLegacy.includes('WO-10005 NC-0001 rework approval'), JSON.stringify({ ok: v.ok, unsignedLegacy: v.unsignedLegacy, failures: v.failures }));
  ok('Legacy: diagnose finds nothing to repair', MES.diagnose(state) === null, JSON.stringify(MES.diagnose(state)));
  // Released by this build: the release is signed and binds no approval hash.
  const order = MES.getOrder(state, 'WO-10005');
  const linked = order.operations.some(op => op.id === order.tickets.find(x => x.id === 'NC-0001').reworkPlan.opId);
  const add = linked && order.sequenceChange ? { ok: true } : host.withAccount(me, () => reworkOp(state, 'WO-10005', 'NC-0001', 'Rework'));
  const released = host.withAccount(qe2, () => MES.approveSequenceChange(state, 'WO-10005'));
  const t = MES.getOrder(state, 'WO-10005').tickets.find(x => x.id === 'NC-0001');
  ok('Legacy: a legacy plan released by this build closes with a signed release', add.ok && released.ok && t.status === 'Resolved' && plain(t.manifest) && t.manifest.meaning === RELEASE && t.manifest.subject.approvalHash === null, JSON.stringify([add, released, t.status]));
  const after = verify(state);
  ok('Legacy: that release verifies; only the unsigned approval stays listed', MES.validate(state) && after.ok && after.unsignedLegacy.includes('WO-10005 NC-0001 rework approval') && !after.unsignedLegacy.includes('WO-10005 NC-0001 rework release'), JSON.stringify(after.unsignedLegacy));
  const moved = structuredClone(state);
  MES.getOrder(moved, 'WO-10005').tickets.find(x => x.id === 'NC-0001').reworkPlan.opId = MES.getOrder(moved, 'WO-10005').operations[0].id;
  ok('Legacy: an edit to the signed release of a legacy plan is still refused', MES.validate(moved) === false && failsAt(moved, /NC-0001 rework release/));
  // Codex P1 on #602 (78c8c73): the release this build signed for a legacy approval cannot be stripped back to legacy.
  const strippedRelease = structuredClone(state);
  delete MES.getOrder(strippedRelease, 'WO-10005').tickets.find(x => x.id === 'NC-0001').manifest;
  const srV = verify(strippedRelease);
  ok('Legacy: removing the signed release of a legacy approval is refused by validate', MES.validate(strippedRelease) === false && /NC-0001 is closed without a signed QA release, but it was not released before releases were signed/.test(detail(strippedRelease)), detail(strippedRelease));
  ok('Legacy: verifyManifests fails that release instead of listing it as unsigned legacy', !srV.ok && srV.failures.some(f => f.where === 'WO-10005 NC-0001 rework release' && /does not predate signing/.test(f.reason)) && !srV.unsignedLegacy.includes('WO-10005 NC-0001 rework release'), JSON.stringify({ failures: srV.failures, unsignedLegacy: srV.unsignedLegacy }));
  // A plan approved and released by a build before #581: that release wrote no manifest at all. The saved workspace
  // holds it closed before this build first opens it, so the seal lists both the approval and the release.
  const oldRaw = structuredClone(raw);
  { const ot = oldRaw.orders.find(o => o.id === 'WO-10005').tickets.find(x => x.id === 'NC-0001'), at = new Date(Date.parse(ot.reworkPlan.approvedAt) + 60000).toISOString();
    ot.reworkPlan = { ...ot.reworkPlan, stage: 'Released', releasedBy: { name: 'Riley Release', role: 'Quality Engineer', credentialId: 'ACCT-rw-qe2' }, releasedAt: at };
    ot.status = 'Resolved'; ot.resolution = ot.reworkPlan.approval; ot.resolvedBy = ot.reworkPlan.approvedBy; ot.resolvedAt = at; }
  const old = MES.upgrade(oldRaw);
  ok('Legacy: the seal lists the pre-#581 release as well as the approval', !!old && old.reworkLegacySeal.releases.includes(`NC-0001@${raw.orders.find(o => o.id === 'WO-10005').tickets.find(x => x.id === 'NC-0001').createdAt}`), JSON.stringify(old && old.reworkLegacySeal));
  const oldV = verify(old);
  ok('Legacy: a ticket closed by a pre-#581 release still validates', MES.validate(old), JSON.stringify(MES.diagnose(old)));
  ok('Legacy: verifyManifests lists its approval and release as unsigned legacy, not failures', oldV.ok && oldV.unsignedLegacy.includes('WO-10005 NC-0001 rework approval') && oldV.unsignedLegacy.includes('WO-10005 NC-0001 rework release'), JSON.stringify({ ok: oldV.ok, unsignedLegacy: oldV.unsignedLegacy, failures: oldV.failures }));
}

// ---- Seal: which unsigned plans predate signing is recorded once, so a later strip of both signatures is refused ----
{
  const raw = seed('seed-curated');
  const legacyCreated = raw.orders.find(o => o.id === 'WO-10005').tickets.find(t => t.id === 'NC-0001').createdAt;
  ok('Seal: the raw pre-#581 sample has no seal', raw.reworkLegacySeal === undefined);
  const state = MES.upgrade(structuredClone(raw));
  ok('Seal: MES.upgrade seals the unsigned plans present at upgrade', plain(state.reworkLegacySeal) && JSON.stringify(state.reworkLegacySeal.tickets) === JSON.stringify([`NC-0001@${legacyCreated}`]) && !Number.isNaN(Date.parse(state.reworkLegacySeal.sealedAt)), JSON.stringify(state.reworkLegacySeal));
  const again = MES.upgrade(structuredClone(state));
  ok('Seal: a second upgrade never rewrites the seal', JSON.stringify(again.reworkLegacySeal) === JSON.stringify(state.reworkLegacySeal));
  ok('Seal: the signed Rework workspace carries the seal, and the new plan is not listed', plain(rework.state.reworkLegacySeal) && !rework.state.reworkLegacySeal.tickets.includes(rework.ticketId));
  const both = structuredClone(rework.state);
  { const t = MES.getOrder(both, 'WO-10006').tickets.find(x => x.id === rework.ticketId); delete t.manifest; delete t.reworkPlan.manifest; }
  ok('Seal: removing both signatures of a signed plan is refused by validate', MES.validate(both) === false);
  ok('Seal: diagnose names the plan whose signatures were removed', new RegExp(`${rework.ticketId} (has an unsigned Rework or Repair approval, but it was not approved before approvals were signed|was approved for rework or repair with a signed plan, but that plan and its signature are missing)`).test(detail(both)), detail(both));
  ok('Seal: MES.upgrade does not accept the stripped plan', MES.upgrade(structuredClone(both)) === null);
  const listed = structuredClone(both); { const tk = MES.getOrder(listed, 'WO-10006').tickets.find(x => x.id === rework.ticketId); listed.reworkLegacySeal.releases.push(`${tk.id}@${tk.createdAt}`); listed.reworkLegacySeal.signed = listed.reworkLegacySeal.signed.filter(k => k !== `${tk.id}@${tk.createdAt}`); } listed.reworkLegacySeal.tickets.push(`${rework.ticketId}@${MES.getOrder(listed, 'WO-10006').tickets.find(x => x.id === rework.ticketId).createdAt}`);
  ok('Seal: the stripped plan passes only if the seal is edited too (outside what the seal can catch)', MES.validate(listed) === true);
  const noSeal = structuredClone(rework.state); delete noSeal.reworkLegacySeal;
  ok('Seal: a workspace with signed plans and no seal is refused', MES.validate(noSeal) === false && /no record of the unsigned approvals that predate signing/.test(detail(noSeal)), detail(noSeal));
  ok('Seal: MES.upgrade does not reseal a workspace that already holds signed plans', MES.upgrade(structuredClone(noSeal)) === null);
  // Codex P2 on #602: a ticket number freed by archiving can be issued again. A new ticket that reuses a sealed number
  // does not inherit the seal, because the entry names the ticket's creation time as well.
  const reused = structuredClone(both);
  { const t = MES.getOrder(reused, 'WO-10006').tickets.find(x => x.id === rework.ticketId); reused.reworkLegacySeal.tickets.push(`${rework.ticketId}@2026-01-01T00:00:00.000Z`); ok('Seal: the stripped ticket was created at another time than the reused entry', t.createdAt !== '2026-01-01T00:00:00.000Z'); }
  ok('Seal: an unsigned plan on a reused ticket number is refused', MES.validate(reused) === false && new RegExp(`${rework.ticketId} (has an unsigned Rework or Repair approval|was approved for rework or repair with a signed plan, but that plan and its signature are missing)`).test(detail(reused)), detail(reused));
  const bad = structuredClone(rework.state); bad.reworkLegacySeal = { tickets: 'NC-0001', sealedAt: 'yesterday' };
  ok('Seal: a malformed seal is refused', MES.validate(bad) === false && /is malformed/.test(detail(bad)), detail(bad));
  // A workspace with no rework plans at all gets no seal on upgrade; the first signed approval writes it.
  const fresh = walk('seed-curated', 'WO-10006', 'Rework', {}, st => { delete st.reworkLegacySeal; const o = MES.getOrder(st, 'WO-10005'); o.tickets = o.tickets.filter(t => !t.reworkPlan); });
  ok('Seal: the first signed approval in an unsealed workspace writes an empty seal', fresh.approve.ok && plain(fresh.state.reworkLegacySeal) && fresh.state.reworkLegacySeal.tickets.length === 0 && MES.validate(fresh.state), JSON.stringify([fresh.approve, fresh.state.reworkLegacySeal]));
}

// ---- Codex P2 on #602 (3bce5c0): a stripped approval that the seal does not list fails verifyManifests too ----
{
  const open = walk('seed-curated', 'WO-10006', 'Rework');
  const stripped = structuredClone(open.state);
  delete MES.getOrder(stripped, 'WO-10006').tickets.find(t => t.id === open.ticketId).reworkPlan.manifest;
  const v = verify(stripped);
  ok('Seal: a stripped approval on an open ticket is refused by validate', MES.validate(stripped) === false);
  ok('Seal: verifyManifests fails it instead of listing it as unsigned legacy', !v.ok && v.failures.some(f => f.where.endsWith(`${open.ticketId} rework approval`) && /does not predate signing/.test(f.reason)) && !v.unsignedLegacy.some(w => w.includes(open.ticketId)), JSON.stringify({ failures: v.failures, unsignedLegacy: v.unsignedLegacy }));
  const legacyOnly = verify(open.state);
  ok('Seal: the sealed legacy NC-0001 is still listed as unsigned legacy, not failed', legacyOnly.ok && legacyOnly.unsignedLegacy.includes('WO-10005 NC-0001 rework approval'), JSON.stringify(legacyOnly.failures));
}

// ---- Codex P2 on #602 (3bce5c0): the release names the ME author of an operation added before Quality approved ----
{
  const state = MES.upgrade(structuredClone(seed('seed-curated')));
  const as = (who, fn) => host.withAccount(who, fn, state);
  const id = 'WO-10006', order = MES.getOrder(state, id);
  const op = order.operations.find(item => !item.done) || order.operations[0];
  const created = as(qm, () => MES.createTicket(state, id, op.id, { type: 'NC', title: 'Torque out of spec', description: 'J3 torque below the drawing value.', hold: true }));
  as(me, () => MES.dispositionTicket(state, id, created.id, { decision: 'Rework', note: 'Rework J3.' }));
  const early = as(me, () => reworkOp(state, id, created.id, 'Rework'));
  const approved = as(qe, () => MES.resolveTicket(state, id, created.id, 'Rework approved.', { defectCode: 'DIM', subCode: 'DIM-02' }));
  const plan = MES.getOrder(state, id).tickets.find(t => t.id === created.id).reworkPlan;
  ok('Operation author: ME adds the operation before Quality approves, and the approval links it', early.ok && approved.ok && plan.stage === 'Awaiting QA release', JSON.stringify([early, approved, plan.stage]));
  ok('Operation author: the plan names ME, not the Quality reviewer who linked it', plain(plan.opAddedBy) && plan.opAddedBy.credentialId === 'ACCT-rw-me', JSON.stringify(plan.opAddedBy));
  const rel = as(qe2, () => MES.approveSequenceChange(state, id));
  const t = MES.getOrder(state, id).tickets.find(x => x.id === created.id);
  ok('Operation author: the signed release binds the ME author', rel.ok && t.manifest.subject.opAddedBy && t.manifest.subject.opAddedBy.credentialId === 'ACCT-rw-me' && MES.validate(state) && verify(state).ok, JSON.stringify([rel, t.manifest && t.manifest.subject.opAddedBy]));
}

// ---- Codex P1 on #602 (8a7cc4f): an approved Rework or Repair NC cannot lose its plan and release records ----
{
  const ticketIn = st => MES.getOrder(st, 'WO-10006').tickets.find(t => t.id === rework.ticketId);
  const gone = structuredClone(rework.state);
  { const t = ticketIn(gone); delete t.reworkPlan; delete t.manifest; }
  const gV = verify(gone);
  ok('Plan: deleting the plan and release of a closed Rework NC is refused by validate', MES.validate(gone) === false && new RegExp(`${rework.ticketId} (is a closed Rework NC without its approved plan and signed release|was approved for rework or repair with a signed plan, but that plan and its signature are missing)`).test(detail(gone)), detail(gone));
  ok('Plan: verifyManifests fails it instead of treating it as an ordinary closed ticket', !gV.ok && gV.failures.some(f => f.where.endsWith(`${rework.ticketId} rework release`) && /plan is missing/.test(f.reason)), JSON.stringify(gV.failures));
  const open = walk('seed-curated', 'WO-10006', 'Rework');
  const openGone = structuredClone(open.state);
  delete MES.getOrder(openGone, 'WO-10006').tickets.find(t => t.id === open.ticketId).reworkPlan;
  ok('Plan: deleting the approved plan of an open Rework NC is refused', MES.validate(openGone) === false && new RegExp(`${open.ticketId} (was approved for Rework but its approved plan is missing|was approved for rework or repair with a signed plan, but that plan and its signature are missing)`).test(detail(openGone)) && failsAt(openGone, new RegExp(`${open.ticketId} rework approval`)), detail(openGone));
  // A Rework NC closed without a plan by data from before #581 is sealed as legacy and still loads.
  const raw = seed('seed-curated');
  const rawOrder = raw.orders.find(o => o.id === 'WO-10005'), base = rawOrder.tickets.find(x => x.id === 'NC-0001');
  const planless = { ...structuredClone(base), id: 'NC-0901', status: 'Resolved', resolution: 'Reworked before plans were recorded.', resolvedAt: new Date(Date.parse(base.createdAt) + 60000).toISOString(), resolvedBy: base.reworkPlan.approvedBy, hold: false };
  delete planless.reworkPlan;
  rawOrder.tickets.push(planless);
  const st = MES.upgrade(raw), pv = st ? verify(st) : null;
  ok('Plan: a pre-#581 Rework NC closed without a plan is sealed as a legacy release and loads', !!st && st.reworkLegacySeal.releases.includes(`NC-0901@${base.createdAt}`) && MES.validate(st) && pv.ok && pv.unsignedLegacy.includes('WO-10005 NC-0901 rework release'), JSON.stringify(st ? { seal: st.reworkLegacySeal, failures: pv.failures } : null));
}

// ---- Codex P2 on #602 (8a7cc4f): a reused operation id names the author of the current operation ----
{
  const state = MES.upgrade(structuredClone(seed('seed-curated')));
  const as = (who, fn) => host.withAccount(who, fn, state);
  const id = 'WO-10006', me2 = account('me', 'rw-me2', 'Morgan Two');
  const before = new Set(MES.getOrder(state, id).operations.map(o => o.id));
  const first = as(me, () => reworkOp(state, id, undefined, 'Manufacturing'));
  const firstId = (MES.getOrder(state, id).operations.find(o => !before.has(o.id)) || {}).id;
  const rel1 = as(qe2, () => MES.approveSequenceChange(state, id));
  const removed = as(me, () => MES.removeOrderOperation(state, id, firstId, 'Added in error.'));
  const rel2 = as(qe2, () => MES.approveSequenceChange(state, id));
  const order = MES.getOrder(state, id), op = order.operations.find(item => !item.done) || order.operations[0];
  const created = as(qm, () => MES.createTicket(state, id, op.id, { type: 'NC', title: 'Torque out of spec', description: 'J3 torque below the drawing value.', hold: true }));
  as(me, () => MES.dispositionTicket(state, id, created.id, { decision: 'Rework', note: 'Rework J3.' }));
  const before2 = new Set(MES.getOrder(state, id).operations.map(o => o.id));
  const second = as(me2, () => reworkOp(state, id, created.id, 'Rework'));
  const secondId = (MES.getOrder(state, id).operations.find(o => !before2.has(o.id)) || {}).id;
  const rel3 = as(qe2, () => MES.approveSequenceChange(state, id));
  const approved = as(qe, () => MES.resolveTicket(state, id, created.id, 'Rework approved.', { defectCode: 'DIM', subCode: 'DIM-02' }));
  const plan = MES.getOrder(state, id).tickets.find(t => t.id === created.id).reworkPlan;
  ok('Operation author: the replacement operation reuses the removed operation id', [first, rel1, removed, rel2, second, rel3, approved].every(r => r && r.ok) && secondId === firstId && plan.opId === secondId, JSON.stringify([first, rel1, removed, rel2, second, rel3, approved].map(r => r && r.message), null, 0) + ` ${firstId} ${secondId} ${plan.opId}`);
  ok('Operation author: the plan names who added the current operation, not the removed one', plain(plan.opAddedBy) && plan.opAddedBy.credentialId === 'ACCT-rw-me2', JSON.stringify(plan.opAddedBy));
}

// ---- Codex on #602 (c13a080): the verifier checks meaning and time; a closure stripped of every rework field is refused ----
{
  const ticketIn = st => MES.getOrder(st, 'WO-10006').tickets.find(t => t.id === rework.ticketId);
  const relabel = structuredClone(rework.state);
  { const m = ticketIn(relabel).reworkPlan.manifest; m.meaning = 'Engineering review'; m.at = '2026-01-01T00:00:00.000Z'; }
  ok('Verifier: a changed approval signature meaning and time fails verifyManifests, not only validate', MES.validate(relabel) === false && failsAt(relabel, new RegExp(`${rework.ticketId} rework approval`)), JSON.stringify(verify(relabel).failures));
  const retime = structuredClone(rework.state);
  ticketIn(retime).manifest.at = '2026-01-01T00:00:00.000Z';
  ok('Verifier: a changed release signature time fails verifyManifests', MES.validate(retime) === false && failsAt(retime, new RegExp(`${rework.ticketId} rework release`)), JSON.stringify(verify(retime).failures));
  const bare = structuredClone(rework.state);
  { const t = ticketIn(bare); delete t.reworkPlan; delete t.manifest; delete t.dispo; delete t.affected; }
  const bV = verify(bare);
  ok('Stripped: a released Rework NC stripped of plan, signatures, disposition and affected units is refused', MES.validate(bare) === false && new RegExp(`${rework.ticketId} (was closed after approvals were signed but carries no signature|was approved for rework or repair with a signed plan, but that plan and its signature are missing)`).test(detail(bare)), detail(bare));
  ok('Stripped: verifyManifests fails that closure', !bV.ok && bV.failures.some(f => f.where === `WO-10006 ${rework.ticketId} closure`), JSON.stringify(bV.failures));
}

// ---- Codex on #602 (c5b8f3a): signed approvals are registered on the seal; operation authors live on the operation ----
{
  const open = walk('seed-curated', 'WO-10006', 'Rework');
  const key = `${open.ticketId}@${open.ticket().createdAt}`;
  ok('Register: a signed approval adds its ticket to the seal\'s signed list', open.state.reworkLegacySeal.signed.includes(key), JSON.stringify(open.state.reworkLegacySeal));
  const stripped = structuredClone(open.state);
  { const t = MES.getOrder(stripped, 'WO-10006').tickets.find(x => x.id === open.ticketId); delete t.reworkPlan; delete t.dispo; delete t.affected; }
  const sV = verify(stripped);
  ok('Register: an open approved NC stripped of plan, disposition and affected units is refused', MES.validate(stripped) === false && new RegExp(`${open.ticketId} was approved for rework or repair with a signed plan, but that plan and its signature are missing`).test(detail(stripped)), detail(stripped));
  ok('Register: verifyManifests fails it', !sV.ok && sV.failures.some(f => f.where === `WO-10006 ${open.ticketId} rework approval` && /plan and its signature are missing/.test(f.reason)), JSON.stringify(sV.failures));
  const unlisted = structuredClone(stripped); unlisted.reworkLegacySeal.signed = unlisted.reworkLegacySeal.signed.filter(k => k !== key);
  ok('Register: it passes only if the seal is edited too (outside what the seal can catch)', MES.validate(unlisted) === true);

  // The operation records who added it, so the author survives the bounded sequence change log.
  const state = MES.upgrade(structuredClone(seed('seed-curated')));
  const as = (who, fn) => host.withAccount(who, fn, state);
  const id = 'WO-10006', order = MES.getOrder(state, id);
  const op = order.operations.find(item => !item.done) || order.operations[0];
  const created = as(qm, () => MES.createTicket(state, id, op.id, { type: 'NC', title: 'Torque out of spec', description: 'J3 torque below the drawing value.', hold: true }));
  as(me, () => MES.dispositionTicket(state, id, created.id, { decision: 'Rework', note: 'Rework J3.' }));
  const before = new Set(order.operations.map(o => o.id));
  const added = as(me, () => reworkOp(state, id, created.id, 'Rework'));
  const newOp = MES.getOrder(state, id).operations.find(o => !before.has(o.id));
  ok('Operation author: a new operation records who added it', added.ok && !!newOp && plain(newOp.addedBy) && newOp.addedBy.credentialId === 'ACCT-rw-me', JSON.stringify(newOp && newOp.addedBy));
  as(qe2, () => MES.approveSequenceChange(state, id));
  // As if more than 50 later releases had pushed the add event out of the bounded log.
  const o2 = MES.getOrder(state, id); o2.sequenceChanges = (o2.sequenceChanges || []).map(c => ({ ...c, entries: (c.entries || []).filter(e => !(e.type === 'add' && e.opId === newOp.id)) }));
  const approved = as(qe, () => MES.resolveTicket(state, id, created.id, 'Rework approved.', { defectCode: 'DIM', subCode: 'DIM-02' }));
  const plan = MES.getOrder(state, id).tickets.find(t => t.id === created.id).reworkPlan;
  ok('Operation author: with the add event gone from the log, the plan still names ME from the operation', approved.ok && plain(plan.opAddedBy) && plan.opAddedBy.credentialId === 'ACCT-rw-me', JSON.stringify([approved, plan.opAddedBy]));
}

// ---- Codex P1 on #602 (2f9b515): the operation a QA release closed the ticket on cannot be removed ----
{
  const state = structuredClone(rework.state);
  const t = MES.getOrder(state, 'WO-10006').tickets.find(x => x.id === rework.ticketId);
  const opId = t.reworkPlan.opId;
  const removed = host.withAccount(me, () => MES.removeOrderOperation(state, 'WO-10006', opId, 'No longer needed.'));
  ok('Released operation: ME cannot remove the operation that closed the NC', removed.ok === false && new RegExp(`QA released this operation to close ${rework.ticketId}`).test(removed.message) && MES.getOrder(state, 'WO-10006').operations.some(op => op.id === opId), JSON.stringify(removed));
  const gone = structuredClone(rework.state);
  { const o = MES.getOrder(gone, 'WO-10006'); o.operations = o.operations.filter(op => op.id !== opId); }
  ok('Released operation: a workspace with it removed outside the application is refused', MES.validate(gone) === false && /no longer on the work order/.test(detail(gone)), detail(gone));
  const recl = structuredClone(rework.state);
  { const op = MES.getOrder(recl, 'WO-10006').operations.find(x => x.id === opId); op.classification = 'Manufacturing'; }
  ok('Released operation: reclassifying it is refused', MES.validate(recl) === false && /no longer on the work order/.test(detail(recl)), detail(recl));
}

console.log(fails.length ? `FAILS ${JSON.stringify(fails)}` : 'FAILS []');
process.exit(fails.length ? 1 : 0);
