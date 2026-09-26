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

## 3. Demo build grants every pilot seat every capability (open)

Seven `qa_full` checks under `Demo | Roles` fail: the demo build's
`canManageAccess`, `can` and `skCan` relaxations give `tech`, `operations`,
`mfgeng`, `quality` and `engineering` every capability, although those seats
exist to rehearse the real roles. Handled by the in-repo demo build chain.

## 4. `qa_multi`: stamp prompt check expects a stamp number field (open)

`UI flow | Stamp prompt appears when the last step is checked` signs in as the
`demo` account, whose buy-off credential is an override, so the prompt shows no
stamp number field and the check fails. Handled with the removal of the `demo`
username relaxation and the demo build chain.

## 5. `test_v77`: a Quality account could take the Certification seat (open)

`quality account cannot take the Certification seat` fails: the Certification
vote is recorded for a Quality account. The `mrb-cert` capability is granted
to the Certification role but never checked when a seat is taken. Handled by
capability-based MRB seats.

## 6. `test_v78`: record print capture records nothing (open)

Every print assertion fails because the harness stubs `window.open` and the
prints no longer go through it, so the captured HTML is empty. To be diagnosed
with the demo rebuild.
