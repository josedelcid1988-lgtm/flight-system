import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/mes-host.mjs';

const host = createHost(fileURLToPath(new URL('../index.html', import.meta.url)));
const { MES } = host;
const state = MES.seed();
const author = { username: 'doc-author', displayName: 'Dana Author', role: 'qm' };
const reviewer = { username: 'doc-reviewer', displayName: 'Riley Reviewer', role: 'qe' };
const releaser = { username: 'doc-releaser', displayName: 'Morgan Releaser', role: 'admin' };
const nextAuthor = { username: 'doc-author-two', displayName: 'Avery Author', role: 'mfgeng' };
const run = (account, fn) => host.withAccount(account, fn, state);
const raw = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
const file = (name = 'procedure.pdf') => ({ name, type: 'application/pdf', size: raw.length, base64: raw.toString('base64'), sha256: createHash('sha256').update(raw).digest('hex') });
let checks = 0;
function check(name, result) { checks += 1; assert.ok(result, name); console.log(`ok ${name}`); }

check('new and upgraded workspaces initialize the controlled document register', Array.isArray(state.controlledDocuments) && Array.isArray(MES.upgrade(MES.seed()).controlledDocuments));
check('a controlled document cannot be authored without its stored file', !run(author, () => MES.createControlledDocument(state, { documentNumber: 'SOP-750-001', title: 'Document Control', kind: 'SOP' })).ok);
check('a mismatched file SHA-256 is refused without changing the register', (() => { const before = state.controlledDocuments.length; const bad = file(); bad.sha256 = '0'.repeat(64); const result = run(author, () => MES.createControlledDocument(state, { documentNumber: 'SOP-750-001', title: 'Document Control', kind: 'SOP', file: bad })); return !result.ok && state.controlledDocuments.length === before; })());
const created = run(author, () => MES.createControlledDocument(state, { documentNumber: 'SOP-750-001', title: 'Document Control', kind: 'SOP', file: file() }));
check('the author creates revision A with the file hash in a signed manifest', created.ok && state.controlledDocuments[0].revision === 'A' && state.controlledDocuments[0].authorManifest.hash && MES.validate(state));
check('a second initial record cannot fork the same document number', !run(author, () => MES.createControlledDocument(state, { documentNumber: 'SOP-750-001', title: 'Duplicate', kind: 'SOP', file: file() })).ok);
check('the author cannot review their own controlled document', !run(author, () => MES.reviewControlledDocument(state, created.id)).ok);
check('an automated agent cannot review a controlled document', !run(reviewer, () => MES.reviewControlledDocument(state, created.id, { agent: true })).ok);
check('a different reviewer signs the author manifest', run(reviewer, () => MES.reviewControlledDocument(state, created.id)).ok && state.controlledDocuments[0].status === 'Reviewed');
check('the reviewer cannot release their own review', !run(reviewer, () => MES.releaseControlledDocument(state, created.id)).ok);
check('a third person signs release and whole-workspace verification passes', run(releaser, () => MES.releaseControlledDocument(state, created.id)).ok && state.controlledDocuments[0].status === 'Released' && MES.verifyManifests(state).ok && MES.validate(state));
const revision = run(nextAuthor, () => MES.startControlledDocumentRevision(state, created.id, { title: 'Document Control Rev B', file: file('procedure-b.pdf') }));
check('a revision creates a new immutable record linked to the prior released revision', revision.ok && state.controlledDocuments[1].revision === 'B' && state.controlledDocuments[1].previousId === created.id && state.controlledDocuments[0].status === 'Released' && MES.validate(state));
check('an older revision cannot start a parallel revision branch', !run(nextAuthor, () => MES.startControlledDocumentRevision(state, created.id, { title: 'Parallel Revision', file: file() })).ok);
check('the same credential cannot review and release the new revision', run(reviewer, () => MES.reviewControlledDocument(state, revision.id)).ok && !run(reviewer, () => MES.releaseControlledDocument(state, revision.id)).ok);
check('a different third person releases revision B', run(releaser, () => MES.releaseControlledDocument(state, revision.id)).ok && MES.verifyManifests(state).ok && MES.validate(state));
const tampered = structuredClone(state); tampered.controlledDocuments[0].file.base64 = Buffer.from('changed').toString('base64');
check('stored file changes fail workspace validation and manifest verification', !MES.validate(tampered) && !MES.verifyManifests(tampered).ok);
console.log(`qms_documents: ${checks} checks, all passed`);
