# Known issues

Every entry names the cause, what was done about it, and the test that now
covers it. Entries are numbered in the order they were found and are never
renumbered. Closed entries stay here as the record of what changed and why.

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

**Result.** `qa_full`: 309 checks. Both checks run and pass. The only remaining
skip is the release zip check, which needs `RELEASE_OUTPUT_DIR` (issue 2).

## 2. Release zip check skips unless `RELEASE_OUTPUT_DIR` is set (open, explained)

`Static | Build | Zips present for v72` looks for release zips in a directory
from the machine that built v72. It reports Skip unless `RELEASE_OUTPUT_DIR`
points at a release output directory. It tests packaging, not the product.

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

## 8. The author of a WI can record its peer review (open)

**What.** Nothing stops the person who wrote a revision from also recording
the Manufacturing Engineering peer review. The release rules still hold (the
peer reviewer and every author are refused at release), so a WI always passes
through at least one person who did not write it, but the peer review itself
may not be independent.

**Recommendation.** Refuse peer review by an author with the same
`wiAuthorRefusal` check. Left open because it changes who can complete a
peer review on the floor and needs the QA Manager's agreement first.

## 9. Real names in the reference data and samples (closed)

**Cause.** The built-in stamp snapshot, the default profile, the sample
corrective actions and the demo data carried the names of real people.

**Fix.** Every one is replaced with a fictional name; stamp numbers and dates
are unchanged. A saved workspace keeps its own stamp register, so nothing in
an existing workspace changes. The demo sample buy-offs were signed over the
old names, so their manifests were re-signed with the engine's own subject
builder and `MES.verifyManifests` passes on every demo fixture. The real
register is entered by the QA Manager (`docs/HANDOVER.md`, open items).

## 10. Rejecting an inspection is not restricted to an independent inspector (by design)

Nobody may accept an inspection of their own work (`CHANGELOG.md`,
Controls). Rejecting one is allowed to anyone who may inspect, because a rejection
only raises an NC against the source operation and cannot release product.

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
