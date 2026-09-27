# Known issues

Entries are numbered in the order they were found and are never renumbered. Closed entries stay here
as the record of what changed and why. Open entries remain release blockers until their fixes and
refusal tests are complete.

## 1. Two `qa_full` checks skipped on every run since the fork (closed)

**Checks:** `Production | Render 1440 | View mnv-board renders` and
`Production | Strict guards | Signature manifests verify`.

**Cause.** The production half of `qa_full` signs into an empty workspace: the
first account, one work order moved to Building, nothing else. Both checks were
written to report Skip when the record they look at does not exist, and in that
workspace it never did:

- The MRB board view needs an MRB record. The production workspace had none,
  so the render check returned `skip` before rendering anything.
- The manifest check looked for closed orders. There were none, so it returned
  Skip. It was also weaker than its name: when it did run it only tested that
  `order.manifest.hash` looked like 64 hex characters, but orders never carry
  a top-level `manifest` (closures, buy-offs and approvals do), so it would
  have passed on any workspace, tampered or not. It was the only integrity
  test in the suite and it proved nothing.

**Fix.**

- The engine gained `MES.verifyManifests(state)`. It walks the whole workspace
  and checks the shape of every signature manifest (meaning, time, a named
  signer with a credential, algorithm SHA-256, a 64-hex hash). For operation
  buy-offs, NC/IDR quality approvals and order closures it recomputes the
  SHA-256 from the stored record and compares it with the signed hash; for the
  FAIR it checks that the approval chains to the verified FAIR. The signing
  code now builds its hash subject with the same functions the verifier uses
  (`buyoffSubject`, `ticketSubject`, `closureSubject`), so signing and
  verification cannot drift apart. The hashes produced are unchanged: the 85
  recomputable manifests in the 150-order sample, all signed by the previous
  code, verify.
- `qa_full` production setup now adds a second QA Manager account, raises an
  NC on its own Building order, records a Use as is disposition, convenes the
  MRB, and has one account request and the other approve an order closure. The
  MRB board view renders against that record, and the manifest check requires
  at least one closed order, requires every closed order to carry a closure
  manifest, and requires `verifyManifests` to pass with every closure
  recomputed.
- A new check edits a signed closure note after signing and requires
  `verifyManifests` to report that exact closure. This is the refusal path.

**Result.** `qa_full`: 309 checks. Both checks run and pass.

## 2. Release zip check skipped on every run (closed)

**Cause.** `Static | Build | Zips present for v72` looked for v72 zips in a
folder on the machine that built v72, so everywhere else it reported Skip.
There was no packaging tool in the repository to produce the zips it checked.

**Fix.** `tools/package-release.mjs` builds the two release zips for the build
stamped in `index.html` (`flight-system-<build>.zip` with `index.html` and
`assets/`, `flight-system-<build>-demo.zip` with `demo.html` and `assets/`),
reproducibly, and `--verify` checks a folder of zips against the tree. The
`qa_full` check now packages the current build on every run and requires both
zips to hold exactly the files in the tree. It is no longer skipped anywhere:
`tests/allowed_skips.json` is empty and every suite runs with zero skips.

## 3. Demo build granted every pilot seat every capability (closed)

**Cause.** The demo build chain lived outside this repository. Its overlay said the
five pilot seats keep their real role, but its `isShared()` returned true for every
account and the build also forced `can`, `skCan` and `canManageAccess` open, so
`tech`, `operations`, `mfgeng`, `quality` and `engineering` had every capability.
Seven `qa_full` checks under `Demo | Roles` failed.

**Fix.** The demo is now built in this repository by `tools/build-demo.mjs` from
`index.html` with numbered deviations (`docs/DEMO_DEVIATIONS.md`). The role
deviations apply only to accounts that are not pilot seats: `capsOf` returns
every capability only for them, and `canManageAccess`, the QA Manager only
settings, Use for Dev and MRB seat eligibility follow the same test. Pilot seats
keep their real role. Covered by `qa_full` (Demo / Roles, now passing) and
`tests/test_demo_build.mjs` (each pilot seat checked against its role, each
full-access account checked for every capability).

## 4. `qa_multi`: stamp prompt check expected a stamp number field (closed)

**Cause.** The old demo gave every account a "Demo override" at buy-off, which
hides the stamp number field. `qa_multi` checks that finishing the last step
opens the prompt with the stamp number field, so it failed.

**Fix.** The demo now gives every account a demo stamp instead of an override
(deviations "Every account holds a demo stamp" and the three that follow): the
prompt shows the stamp number field, and the number, training and PIN are not
checked for a demo stamp. The PIN fields are optional in the demo. `qa_multi`:
161 of 161; `test_v80i` still buys off through the prompt.

## 5. `test_v77`: a Quality account could take the Certification seat (closed)

**Cause.** In the demo every account sat in every MRB seat (issue 3).

**Fix.** Pilot seats keep their real MRB seats in the demo, so the `quality`
account holds only the Quality seat. `test_v77` passes. Capability-based seat
checks in production are item 6.

## 6. `test_v78`: record print capture recorded nothing (closed)

**Cause.** The harness captured prints by stubbing `window.open` and reading
what was written into the new window. Record prints now go through
`printRecord`, which opens a blob URL instead, so the capture was empty and
every assertion failed. The prints themselves were correct.

**Fix.** The harness also captures the HTML blob handed to the browser. Every
assertion is unchanged (SKYRYSE header, sections, no SPR/SCAR print) and all
pass. The same capture is used by `test_demo_build` to check that every demo
print carries DEMO, NOT FOR ACCEPTANCE.

## 7. The author of a WI could release it (closed)

**Cause.** The engine refused a release by the peer reviewer but never looked
at who wrote the revision, and a draft does not record its authors. An account
holding both the edit and the release capabilities (Master Access) could write
a WI and release it, which breaks the "author cannot release" rule.

**Fix.** Every edit to a draft revision records the editor's credential in
`wi.authors`; for a revision edited before that, the edit entries in its
history name them. QA release, release against the drawing ECO and release by
the Safety Team buy-off all refuse an author, with no role or override exempt.
The check sits after the existing preconditions, so every earlier refusal keeps
its message. `tests/test_frozen_contract.mjs` covers the rule and its refusal
paths; the demo lifts it as D-30.

## 8. The author of a WI could record its peer review (closed)

**Cause.** Nothing stopped the person who wrote a revision from also recording
the Manufacturing Engineering peer review, so the peer review might not be
independent (release itself was already refused to every author).

**Fix.** Peer review refuses anyone who edited the revision, using the same
author record as release, with no role or override exempt. The demo lifts it as
D-31. `tests/test_frozen_contract.mjs` pins the rule and checks the refusal.

## 9. Real names in the reference data and samples (closed)

**Cause.** The built-in stamp snapshot, the default profile, the sample
corrective actions and the demo data carried the names of real people.

**Fix.** Every one is replaced with a fictional name; stamp numbers and dates
are unchanged. A saved workspace keeps its own stamp register, so nothing in
an existing workspace changes. The demo sample buy-offs were signed over the
old names, so their manifests were re-signed with the engine's own subject
builder and `MES.verifyManifests` passes on every demo fixture. The real
register is entered by the QA Manager (`docs/HANDOVER.md`, open items).

## 10. Rejecting an inspection of one's own work (not an issue; moved)

This was a note, not a defect: anyone who may inspect can reject an
inspection, including of work they did, because a rejection only raises an NC
and cannot release product. It is documented with the rules in
`docs/HANDOVER.md` section 2.


## 11. `qa_multi` failed six 1440 px render checks on a loaded machine (closed)

**Cause.** The first CI run failed `qa_multi` with the order, mnv-board and
trace views unable to find their records; it passed locally and in the
mirror-on run on the same machine. Running three copies at once alongside
`qa_full` reproduced it locally. The demo overlay wrote the sample workspace
at the end of the page and then reloaded, but the app had already set
`window.__ready` on the first, empty load. On a busy machine the harness saw
`__ready`, waited its fixed 1.2 s, and ran while the reload was still under
way, against an empty workspace.

**Fix.** The demo head script (D-3) writes the sample workspace before the app
reads storage, so the first open is already populated and never reloads; the
overlay's reload stays only as a fallback. No test was changed. Under the same
load `qa_multi` passes six runs out of six. `tools/run-suites.mjs` now prints a
failing suite's FAIL lines to the console, so a CI log says what failed.

## 12. Shared-workspace snapshots are blocked after initialization (mitigated)

**Fix.** `PUT /workspace` now initializes an empty database once. Afterward,
changed snapshots are refused for every account, including QA Manager and
Master Access, and the refusal is audited. A byte-equivalent manager snapshot
with the current ETag is a no-op only. Mutations must use an authorized server
MES action. Initialization normalizes the master WI library, planning records,
blockers, and signed-in profile before storage.

**Remaining.** Some legacy UI field edits still optimistically save to the
local browser copy. A definite HTTP refusal now reloads the committed shared
workspace and discards the unaccepted local change. A transport failure is
uncertain, so the browser preserves the local copy, marks it unconfirmed, and
checks the server before sending later writes after connectivity returns. This
prevents a shared-record bypass but does not replace complete command coverage.
Finish that coverage before multi-user production use. See
[`docs/SECURITY_REVIEW-v82.md`](docs/SECURITY_REVIEW-v82.md).

**Status.** Whole-workspace mutation is blocked; action and legacy snapshot
refusal reconciliation are covered by browser checks. Command coverage remains
incomplete, so do not expose this server as an authoritative production system
until remaining workflows are converted and refusal tests pass.

## 13. Local save can precede server confirmation (open)

**Cause.** Browser changes are saved locally and sent to the server
asynchronously. A local success therefore does not prove the shared server
accepted the change.

**Mitigation.** The status indicator now shows a pending server save and
distinguishes server success, offline, conflict, and refusal. The server
command migration in issue 12 should make server-backed actions report success
only after the server commits. See
[`docs/SECURITY_REVIEW-v82.md`](docs/SECURITY_REVIEW-v82.md).
