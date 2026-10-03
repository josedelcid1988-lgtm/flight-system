# Changelog

## Current branch corrections

- Inspection and MRB seats now follow role capabilities in production and demo; only conformity and AQI require named, current-training grants. MRB disposition training tiers remain optional and off by default.
- Server-side grant routes reject attempts to grant inspection or MRB seat capabilities individually.
- Support Access only lifts stamp binding for one operation; its documentation now matches the enforced rule.
- The demo can be walked alone as `master`: new deviations D-47 to D-54 lift the same-person checks that still stopped one person in the demo (the MRB board vote form, the pedigree second approval and the closure review on the work order, System QMS documents, audits and findings, equipment maintenance), each matching an engine rule already lifted or lifted with it, and D-55 to D-59 replace the text beside those steps that still told one person to find another (pedigree change, closure request, analysis draft review, audit finding closure, FAIR box 22). Production is unchanged. `tests/qa_demo_solo_master.mjs` walks every multi-person workflow through the screens as `master` and fails on any refusal that names another person; `docs/DEMO_QUICK_START.md` explains how to open and use the demo.
- Fixed in production: **Record ECO from PDM** on a design ECR did nothing (its click was never handled), and setting Today's Big Three with fewer than three open tasks left the Planned orders page blank.
- Admin page: accounts and roles, training, the stamp register and the master SDS book moved out of Your credentials onto an Admin page (sidebar), shown only to accounts that manage access; others are refused the page and its deep link. Your credentials keeps your own profile, your own stamps and PIN, the account switch and sign out. Conformity and AQI authorities read in words. The stamp register scrolls sideways at tablet width instead of breaking words. Every self-target refusal is unchanged; `test_admin_page` covers it.

What changed in Flight System, newest first. The build id is set in `VERSION.md`; the release record at
the end of `VERSION.md` names the exact files and the suite results for the build. Storage keys, form
numbers and record number formats have not changed in any entry below.

## Work orders frozen in QA review; signed QA send back to Building (#542)

QA Manager decision: once a work order is sent to QA, no changes are allowed. Saved workspaces open as they are.

- **Frozen in Quality.** The engine (and so the server action route) refuses, for every role including Master
  Access, with "This work order is in QA review. Ask Quality to send it back to Building before changing it.":
  serial assign, auto-assign and void; operation, NC and kit file removal; engineering change submit, ECR
  approval and QA re-release; priority change and clearing AOG; planned dates; ATP software link; adding a
  purchase order; linking the order to a project; and adding operation files by anyone outside Quality.
  Operation add, remove and edit, splits, pedigree change and material lots stay refused as before.
- **Still allowed in Quality:** raising an NC, notes and messages, Quality adding evidence files, the FAIR,
  the conformity package and 8130-9, closure requests, and Review & close.
- **Send back to Building.** `MES.sendBackToBuilding` is the Quality role's (`approve-wo`) only way to move a
  work order from Quality back to Building. It needs a rationale of 1 to 300 characters and can link an NC
  raised on the order. It writes a record with the person, credential and time and a SHA-256 manifest binding
  the order, its revision and WO revision, the rationale, the linked NC, the from and to statuses, the signer
  and the time; `MES.validate` and `verifyManifests` recheck it. The order keeps its last 20 send backs. The
  work order shows "Sent back by QA: rationale, name, date" while it is back in Building, and the activity
  record, the record print and the traveler show it. The demo keeps the freeze.
- `test_qa_freeze` covers every refusal, the send back refusals, the tamper checks and the full flow;
  `test_frozen_contract` pins the rules.

## FAIR box 22 required, box 10 captured (build v81)

Checked against AS9102 Rev C in the QMS standards library. Saved FAIRs open as they are.

- **Box 22 is required.** After the FAIR is verified (boxes 20 and 21), a second person reviews and approves
  it in box 22; the Skyryse QA approval is refused until box 22 is signed, for every role
  including Master Access. The verifier still cannot sign box 22. An unsigned box 22 prints blank. FAIRs
  approved before this change keep the verifier in boxes 22 and 23, which is what the verifier signed then.
- **Box 10 (designed / qualified tooling)** has its own field on each characteristic (tool ID, or the gauge
  value or range for qualified tooling) and prints in the Form 3 grid. M&TE stays in the supplemental data.
- Form 2 title and box 8 (supplier name, address, code) and the box 20 and 22 labels follow Rev C.
- **Boxes 24 and 25 (customer approval) print blank.** They are for a customer, not Skyryse. The Skyryse QA
  approval is unchanged in the app and prints in the supplemental section.
- Demo D-33 lets the verifier sign box 22 so an FAI order can be walked alone; production refuses it and
  `test_frozen_contract` pins it. `test_v74`, `qa_master` and the `qa_e2e` FAI flows sign box 22 before the
  approval.

## Authority, stamps and training (build v81, after the handover merge)

Requested by the QA Manager on 26 September 2026. Saved workspaces keep their stamp register and accounts;
nothing in them is rewritten.

- **Stamp register as the in-system database.** Stamps are numbered SKY-0000 onward. A fresh register ships
  with open placeholders SKY-0000 to SKY-0006 (no people) and the generic role credentials, retired. Leaving
  the number blank takes the next open placeholder, then the next SKY number; numbers are never reused.
  Holder names are editable, holders import from CSV (all or nothing, the bad row named) and the register
  downloads as CSV.
- **Several stamps per person**, one per buy-off type. Every stamp after a person's first cites a training
  they hold a current record for, and pauses while that training is not current.
- **Stamp PINs stored with scrypt** (RFC 7914, N = 16384, r = 8, p = 1), verified against the RFC test
  vector. PINs set earlier still verify. The PIN stays required at every buy-off.
- **Training requirements configured in the system.** The QA Manager adds or changes trainings (code, name,
  validity, LMS course); every change cites the QMS document and revision and a reason, and a revision can
  require retraining. Operations require ESD and FOD through their callouts and any other training by a
  tick in the WI or operation editor. **Training records** are entered per person.
- **More than one role per account.** Adding a role beyond the primary one cites a current training and
  pauses while it is not current.
- **Granted authorities.** Inspection, the four MRB seats, conformity package work and the AQI signature
  are no longer part of any role. A QA Manager or Master Access account grants each to a named, eligible
  person with a reason and a current training record, never to themselves; grants are signed, logged and
  pause when the training lapses. Master Access holds none until granted. Nobody holds any at first.
  Inspection now needs the inspection grant on every inspection operation.
- **Development NFF own-work exception.** On a Development NFF order the builder may inspect their own work;
  the order history records it. Every other separation-of-duties rule still applies.
- **Development NFF never reaches a flight path.** An NFF unit cannot go into a Production or Development
  order (as a sub-assembly or a rework source), cannot have a conformity package, 8130-9 or 8130-3, is never
  an FAI order or FAIR, and its pedigree never changes. NFF orders no longer use up a WI revision's
  first-article slot. Enforced in the engine; no role or override lifts it.
- **FAIR as AS9102 Rev C forms.** On screen, Form 1, Form 2, Form 3 and Review and sign are separate pages.
  The print and download follow the Rev C boxes: Form 2 box 8 is the supplier (name, address, code), and
  Form 3 is the Rev C grid (5 to 12, box 10 designed / qualified tooling) with Skyryse's revision, sample
  size, quantity, inspector, date and M&TE in a marked supplemental section. Box 22 (FAI reviewer /
  approval) is an optional second signature by someone other than the verifier; unsigned, boxes 22 and 23
  carry the verifier as before.
- **AQI self-signature with a warning.** The person who completed an 8130-9 may give the AQI signature after
  acknowledging a warning; the signature and its manifest record the self-signature.
- New suite `test_authority`; `tests/lib/grants.mjs` grants authorities in suites that exercise other rules.

## Handover, 30 September 2026 (build v81)

Prepared for the handover to the in-house developer and IT. Workspace schema unchanged; saved workspaces
open as they are.

### Controls

- **The author of a WI cannot release it.** Every edit to a draft revision records its author, and QA
  release, release against the drawing ECO and the Safety Team buy-off release refuse an author. Only
  the peer reviewer was refused before (`KNOWN-ISSUES.md` issue 7). An author cannot record the peer
  review either (issue 8).
- **Nobody inspects their own work.** An inspection buy-off, and a step check on an inspection
  operation, are refused when the person did any build operation the inspection covers. (Rejecting an
  inspection is not restricted: it only ever raises an NC.) No role is exempt, including Master Access and Support Access. Quality holds the
  `inspect-steps` capability for the step checks.
- **MRB seats are capabilities.** Each seat maps to a capability (`mrb-quality`, `mrb-me`, `mrb-eng`,
  `mrb-cert`); a vote checks the voter's capability for the seat, and one person still holds one seat.
  The QA Manager holds `safety-buyoff`, and the PFMEA Safety Team buy-off checks it.
- **Support Access replaces the demo username.** The production build no longer treats an account
  named `demo` as special. Support Access is granted only through Master Access with a reason and can
  lift two gates (stamp binding, MRB seat eligibility) one record at a time, each with a reason. Every
  grant and every override writes an entry in the Support Overrides log (person, credential, time,
  rule lifted, record, reason), filterable in the Organization view. Separation-of-duties rules are
  never overridable. A saved account named `demo` loads as an ordinary account with one log entry.
- **Signature manifests are verified.** `MES.verifyManifests(state)` checks every manifest in a
  workspace and recomputes the hash of buy-offs, NC/IDR approvals and order closures from the stored
  record; FAIR and 8130-9 chains are checked link by link.
- **Every record names its build.** `tools/stamp-build.mjs` writes the build id and the SHA-256 of
  `index.html` into its head. Every signature manifest, order history event, Support Overrides entry,
  mirrored record, audit export and printed or downloaded document carries both.

### Persistence

- **Mirror server** in `server/`: Node with its built-in SQLite, WAL mode, no dependencies. Append-only
  records in a SHA-256 hash chain, signature manifests in their own table, triggers that refuse every
  update and delete, JSON and CSV export, per-entity audit lookup, scheduled backups with daily
  retention, a restore procedure and `server/restore-test.mjs`.
- **App side:** after each validated write the app queues the changed records under
  `skyryse-mes-sync-queue-v1` and sends them with backoff; the header shows Synced or N unsynced.
  Off by default (empty URL). Password and PIN hashes and salts are never sent. The engine's write,
  validation and rollback are unchanged.

### Demo build

- `demo.html` and the demo fixtures are generated from `index.html` by `tools/build-demo.mjs`, which
  applies 31 numbered deviations, each marked `DEMO D-n` in the output and listed in
  `docs/DEMO_DEVIATIONS.md`. `--check` fails on any drift.
- Pilot seats (tech, quality, mfgeng, operations, engineering) keep their real role in the demo.
- The demo writes its sample workspace before the app reads storage, so it opens populated without a
  reload (this removed a race in `qa_multi` on a busy machine, `KNOWN-ISSUES.md` issue 11).
- The demo writes its sample workspace before the app reads storage, so it opens populated without a
  reload (this removed a race in `qa_multi` on a busy machine, `KNOWN-ISSUES.md` issue 11).
- Every demo page, print and download says DEMO, NOT FOR ACCEPTANCE.

### Tests and CI

- New suites: `test_support_access`, `test_demo_build`, `test_inspect_own_work`,
  `test_mrb_seat_caps`, `test_mirror`, `test_build_stamp`, `test_frozen_contract`.
- The mnv-board render at 1440 px and the signature manifest check in `qa_full` run again (they were
  skipped); causes and fixes in `KNOWN-ISSUES.md`.
- Harnesses find their fixtures from their own folder; no path setup.
- `tools/run-suites.mjs` runs every suite the same way, with the mirror off or on, and fails on a
  failed check, a page error or an unexplained skip.
- GitHub Actions (`.github/workflows/ci.yml`) runs the generated-file checks and every suite, mirror
  off and on, on every pull request.
- `docs/ROLE_MATRIX.md` is generated by `tools/role-matrix.mjs`.
- `tools/package-release.mjs` builds reproducible production and demo release zips; `qa_full` packages
  and verifies them on every run, so no check is skipped any more.

### Text

- No em dashes in the product, the docs or the code comments.
- Real people's names in the reference data and samples are replaced with fictional ones.
- `docs/HANDOVER.md` for the in-house developer and IT.

## Build v81, 20 September 2026

Split into three reviewed changes before the handover work: portable harnesses, the stamp prompt and
NC review fixes carried into the demo, and the QA inspection report of 25 September 2026
(`docs/QA_INSPECTION_2026-09-25.md`). Feature scope of v81 is listed in `VERSION.md`.
