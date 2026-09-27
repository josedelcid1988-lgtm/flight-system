# Flight System v82 handoff

**Date:** September 27, 2026  
**Branch:** `flight-v82-datum-port`  
**Build:** `v82`

**Status:** implementation remains in progress. The workspace snapshot authorization bypass is closed, and refused local edits now have an account-bound, tab-scoped recovery download. Legacy command coverage, several requested feature ports and the remaining design migration are still open. The local ZIPs were rebuilt from the current tree but remain integration-review packages, not production approval.

## Included

- Full application source, generated demo, React Hangar source and browser assets.
- Authenticated Node server with SQLite by default and PostgreSQL support for shared installations.
- Evidence, archive and audit storage, account profiles, export delivery, migration tooling, and test suites. Browser evidence uploads are confirmed in the server store and retrieved with SHA-256 verification before buy-off.
- Reproducible production and demo deployment packages, plus a source package that excludes Git history,
  local dependencies, machine paths, and transient Playwright logs.
- Browser captures and a short interaction recording under `artifacts/design/`.
- ATP operations require a baseline version and commit tied to an HTTPS repository on any host. Missing links are refused, and migrated legacy unlinked ATP operations require remediation before buy-off.

The approved React design is implemented on the Flight Control Hangar and work-order drawer, the
Flight Plan planned-order queue, Kanban, MRP forecast, Big Three, project/milestone planning and
dispatch, and Flight Maneuver Quality Hangar plus NC Intake, Corrective Actions, Material Review
Board and Problem Reports queues. Search, NC escape/source filters, density and current metrics use
live workspace records. Existing route actions continue into existing MES-gated workflows. Flight
Control workflows beyond the Hangar and Flight Maneuver full detail screens still need migration.

## Phase status

| Phase | Status | Delivered here | Still open |
| --- | --- | --- | --- |
| 1. Storage, records, load safety | Partial | SQLite/PostgreSQL stores, sessions, ETags, audit, evidence, archive, export delivery, migration tooling, server MES actions, persisted training checks; recognized successful MES mutators route through server actions. The FAA 8130-9 AQI signature and active-operation labor clock both use audited server commands verified in browser tests. The server independently allowlists command functions and refuses exported readers, migration helpers, and signature primitives on the action route. Workspace snapshots can initialize the server once; changed snapshots are refused and audited for every role. Initialization seeds normalized master WIs, planning state, blockers and the current account profile. Refused edits are preserved in an account-bound, tab-scoped recovery copy for manual download; there is no automatic import path. `test_server.mjs` covers the command allowlist and role refusals; `test_server_ui.mjs` covers recovery, reload, labor clocking and AQI signing. | Direct field edits and unmatched legacy workflows may still save on-device, but cannot replace shared records. Complete server command coverage and clear unsynced-edit handling are still required before multi-user production. |
| 2. Planning, scheduling, resources | Partial | Flight planned-order and work-order blockers are re-derived with owner capability, separation-of-duty exclusions and due dates. The Flight Plan Big Three is ranked, persisted per person, supports accept/decline with reason and next-day carry, and supports time-block proposals with overlap checks, assigned-person decisions, and QA escalation records. Calendar import/export is off by default. QA Manager and Master Access can enable the iCal file adapter; imported events create deduplicated busy blocks, prevent overlapping proposals, and accepted blocks export. Datum source does not contain live Google or Outlook OAuth connectors, so those are not represented as working sync. Master WI operations carry standard hours and a seeded work-center assignment; converted orders retain them. A configurable site, area, work-center and work-unit hierarchy supports multiple units, unit-specific maintenance and capacity reduction. A React dispatch panel ranks open operations, shows daily capacity load, estimated hours, and AOG emphasis. Labor clocks record start/end, reject duplicate open clocks per person, and enforce clock-off ownership. The active operation exposes owner-aware clock controls backed by audited server commands. Project WBS, dated objectives and milestones, reasoned sensitivity raises, work-order labor rollups, must-start Big Three candidates, sprint backlog and capacity validation, daily burndown and throughput-based latest-start reporting are implemented with React planning controls. Only a different credential can verify return to service, and ATP/tool checks refuse tools under maintenance. The append-only inventory ledger supports issue, return, receipt, adjustment and consume, lot build classes, on-hand rollup, NetSuite references, kit issue/return and Development NFF boundary checks. External work at an external center requires a PO, ERP receipt, supplier inspection lot, and QA receiving record; Production requires a full inspection reference and Development/Prototype use simplified confirmation. | Project telemetry currently derives throughput from recorded labor and completed sprint items; it is not connected to a source-of-truth planning system. Google and Outlook live sync are unavailable. The referenced Datum `docs/SCHEDULING.md` is absent from the supplied checkout. |
| 3. Operation types | Partial | Existing master-WI and open-work-order operations are migrated to top-level types, including legacy Part Conformity to Conformity/PARTS and legacy ATP/SIL/HIL to Test sub-codes. New Test and Conformity operations require registered sub-codes. Parts Conformity keeps its existing package gate, and all Test sub-codes capture calibrated assets and require a baseline repository, version, and commit. Source Inspection can be planned in master WIs and new work orders with Customer, DCMA, and FAA sub-codes. QA Manager and Master Access can add source-inspection codes with notice days and notification text; changes require rationale and a signed history entry. Recording checks authority, own-work separation, prior operations, dates, and DCMA notice; it is one-time, gates buy-off, shows an open hold and a Quality task, and prints on the traveler. Standard Inspection Step A is locked to the controlled title and instruction in master WI editing, migration and rework templates; browser and engine tests cover tampering, removal, reorder and image changes. | Expand Datum's role, stamp and operation migration tests against fixtures not present in the supplied checkout; review Step A migration on representative legacy production data. |
| 4. People, authority, training, stamps | Partial | Operations Manager and Quality Supervisor role capabilities. Operations Manager can run work orders, planned-order conversion, assignments, sensitivity, notices, organization settings, training records, and WI training requirements. Quality Supervisor has the Quality capability set, training and standard-account administration, notices, and organization settings. The browser and server prevent a Quality Supervisor from changing QA Manager or Master Access accounts or assigning those roles. Ordinary inspection and MRB seats are role capabilities, not person grants. Optional per-disposition MRB training tiers start Off, are audited in QMS configuration, and block votes server-side when current training is required. The access page flags critical capabilities with fewer than two active holders. Stamp imports reject malformed quotes, normalized duplicate columns, and mismatched row widths without mutating the workspace. Training records can carry PDF or image certificates with name, type, size and SHA-256 bound into the trainer's signed manifest; the in-app preview verifies the stored bytes before opening. `test_roles_ops_qs.mjs`, `test_authority.mjs`, and `test_mrb_seat_caps.mjs` cover the matrix, grant paths, import edge cases, certificate tampering, and refusals. | More complete Datum role and stamp migration fixtures. |
| 5. QMS configuration and integrations | Partial | QA Manager and Master Access own the QMS configuration page. Source Inspection, Conformity, Test, and MRB training settings require a rationale and signed old/new-value history. The page reads and saves server-managed record export destinations, toggles, token setting names, and naming patterns through the audited export settings API; it never accepts a secret value. The page shows delivery history, hashes, attempts, last errors, and offers retry for failed deliveries. The authenticated server can create Jira issues for saved ECR, SPR and SCAR records using credentials held in server environment settings; it loads canonical payloads from the shared workspace, checks the caller capability, links returned keys through Flight's engine and stores one idempotency row per record. `test_jira_integration.mjs` covers success, duplicate, restart, uncertain-response refusal, caller authorization, and the ECR UI. | Configure and verify the owner's actual Jira Cloud tenant and service account. A pending unknown request requires Jira-label search and manual reconciliation. Phase 7 skill triggers remain separately open. |
| 6. System-level QMS | Partial | Signed audits/findings, supplier approvals, certifications, quality-study values/verdicts, and controlled document revisions with attached, hashed files and separate author/reviewer/releaser credentials. AI governance adds DG-01 to DG-04 and SOP-750-007 drafts, a DG-01 job description template, a 13-entry AI risk register, hash-chained action evidence, a signed ISO/IEC 42001 export, and model-setting controls that verify a named secret exists on the server. `test_qms_records*`, `test_qms_documents*`, `test_qms_governance*` cover the current paths. | DG procedures remain drafts until three-person document release. Model execution is deliberately unavailable; the model setting is configuration evidence only. The ISO export is an evidence extract, not certification of an AI management system. |
| 7. Skills | Partial | Twelve Flight-only deterministic draft categories are allowlisted. The engine records input/output hashes and reasons, deduplicates repeated trigger/input pairs, supports signed reviewer and different-person acceptance steps, and refuses any draft that still contains `[confirm]` scaffolds. It does not mutate target production records. QA Manager/Master Access can configure signed triggers. The master WI draft has a Form 3 plan editor with a SHA-256 manifest, and FAIR seeding copies planned characteristics. SPC calculates I-MR control limits, common stability signals and capability from numeric readings. MSA calculates average-and-range repeatability, reproducibility, gage R&R, percent variation and distinct categories for balanced crossed studies. `test_qms_skills.mjs` and `test_form3_plan_ui.mjs` cover these paths. | Other requested skill outputs remain conservative templates rather than the full Datum per-skill analysis algorithms. Triggers are authorized run definitions and are not yet wired to every business event. More ported Datum fixtures remain. Model execution is unavailable. |
| 8. Prints and floor | Partial | Record extracts, print/export logs, build stamps, server sync status, the existing helicopter lifecycle bar, a companion progress ring, an opt-in screen wake lock, and a coarse-pointer bounded whole-number picker with touch adjustment, accessible step controls and min/max enforcement. FAIR Forms 1, 2, and 3 each start on a new printed page, table headers repeat, and the signature block appears only on Form 1. `test_v74.mjs`, `test_floor_ui.mjs`, and `test_floor_picker_ui.mjs` cover print layout, wake-lock consent, helicopter preservation and picker behavior. | Verify the generated picker against representative in-app quantity fields on iOS and Android hardware. No extra vendor library was needed for current work. |
| 9. Verify and package | Partial | CI jobs, 63-suite local and mirror runs with zero skips, realistic legacy-workspace migration with `verifyManifests`, browser captures, source packaging and mirror-chain verification. The React Flight Plan Kanban and MRP forecast have focused browser checks for record-derived lanes and summaries, selection handoff, density, responsive layout and reduced motion. The source, production and demo archives are rebuilt and verified for integration review. These artifacts do not imply that the open phases are complete. | PostgreSQL target checks, all requested phases, and production authorization are still required before release approval. Rebuild the ZIPs after any further source change. |

The phase list above is the original requested scope, not a claim that phases 2 through 8 are complete.

## Source conflicts and interpretation

Datum-OS does not currently contain `docs/SCHEDULING.md` or a milestone and sprint engine. Flight now
has its own project, objective, milestone, sprint, and capacity features, but these cannot be claimed
as a faithful Datum port without those source specifications and fixtures. Google and Outlook live
connectors, Jira tenant configuration, complete server command coverage, and the remaining React page
migrations also remain open as listed above.

## Run on a private server

Install the locked Node dependencies, then start the local SQLite server:

```sh
npm ci
node server/server.mjs --host 127.0.0.1 --port 8080 --db data/flight.sqlite
```

For PostgreSQL, set `FLIGHT_DATABASE_URL` before starting the same server. See
[`DATABASES.md`](docs/DATABASES.md) for backups, TLS/reverse proxy setup, and the PostgreSQL integration
check. Persistent storage and tested backups are required.

## Verification status

The current local run (15:44:00 to 15:49:46 UTC) and mirror run (15:49:48 to 15:55:37 UTC) on
September 27, 2026 each passed 63 of 63 suites, including `qa_full` with 310 checks and zero skips.
Both tested index stamp
`391e7ed814b70640bbb7cc023189f4c07aa5116c7282d34954e79e6cd86898aa`; the mirror run stored 17,545
records with an intact chain. These runs include browser checks that server refusals on both the MES
action and legacy snapshot paths restore the committed workspace. Both runs include FAIR print
layout checks and an authorized 8130-9 AQI browser signature persisted through its audited server action,
React Flight Maneuver queue and dashboard interactions, React Flight Plan Kanban and
MRP forecast interactions, Jira ECR/SPR/SCAR issue creation, record linking and idempotent retry
refusals, signed training certificate metadata and file verification, iCal UI
import/export, ATP HTTPS repository acceptance and refusal checks, source-inspection rule and browser
configuration coverage, Test/Conformity sub-code coverage, Operations Manager and Quality Supervisor
role boundaries, optional MRB training-tier vote gates, malformed stamp CSV refusal checks, QMS
record export settings and retry controls, and signed audits, supplier approvals, certifications and
quality verdicts. The access page also surfaces critical capabilities held by fewer than two active
accounts. The machine-path scan, React build check, and recorded browser flows passed. Full details are in
[`TEST-RESULTS-v82.md`](docs/TEST-RESULTS-v82.md). PostgreSQL integration is configured in CI; it was not
run against a locally provisioned database during this handoff.

## Design verification

The React Hangar uses current Flight records for its queue, search, open/all filter, density control, open holds and work-order drawer. The React Flight Plan page renders the blocker-ranked Big Three, work-center dispatch, project/milestone planning and planned-order queue; existing FlightPlan actions remain authoritative. The React Flight Maneuver Quality Hangar uses current CAR, MRB, NC and SPR records, with search, type filter, density control, accessible detail drawer and navigation into the full legacy workflows. Keyboard Escape closes drawers and restores focus. Captures and browser suites cover desktop/tablet layouts, search, filters, density, focus, reduced motion, Flight Maneuver records, and the protected Skyryse helicopter imagery.

React now renders the Flight Maneuver Quality Hangar, NC Intake, Corrective Actions, Material Review
Board and Problem Reports queues from current records. NC Intake retains the Escapes filter and
work-order/stock source selection. The four queue routes have captures in `artifacts/design/final/`:
`flight-maneuver-nc-intake-1440.png`, `flight-maneuver-corrective-actions-1440.png`,
`flight-maneuver-mrb-1440.png` and `flight-maneuver-problem-reports-1440.png`. The React checks cover
headings, queue identity and terminal-record overdue treatment. Their record drawers expose details
and route into the existing gated full-record workflows, which remain legacy.
Flight Plan Kanban and MRP forecast now render in React from `FlightPlan` records. The focused
browser test checks status lane counts against the planner, MRP demand summaries against its
forecast, compact density, selected-order routing, reduced motion, bounded source-order links and tablet rendering; captures
are `flight-plan-kanban-1440.png`, `flight-plan-mrp-forecast-1440.png` and
`flight-plan-mrp-forecast-tablet.png`. Flight Control workflows beyond the Hangar and Flight
Maneuver full detail screens still use legacy rendering; the approved React migration remains
incomplete.

## Release blocker

The server refuses changed workspace snapshots after initialization for every account. Recognized
successful MES mutators use audited server actions. Some direct field edits and unmatched legacy
workflows still save only in the browser and receive a server refusal; this is an availability and
user-feedback risk. Complete command coverage and test every refusal before deploying this server as
the authoritative production system of record. A local browser-only installation remains available.
The browser shows whether a local save is pending, synced, offline, conflicted, or refused; local save
is not proof of server persistence. See [`SECURITY_REVIEW-v82.md`](docs/SECURITY_REVIEW-v82.md) and
[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md).

## Package files

- The one-page contents, verification and open-items summary is in [`docs/ONE-PAGE-SUMMARY-v82.md`](docs/ONE-PAGE-SUMMARY-v82.md).
- `release/flight-system-v82-source.zip` contains the source tree, server, docs, test code and browser evidence for integration review.
- `release/flight-system-v82.zip` is the static browser deployment package.
- `release/flight-system-v82-demo.zip` is the marked training/demo package.

These files are created locally. GitHub publishing is left to the repository owner.

## Open work before go/no-go

| Item | Owner | Due |
| --- | --- | --- |
| Replace ordinary whole-workspace writes with role-checked server commands and add bypass refusal tests | Application developer | September 29, 2026 |
| Finish Datum planning, scheduling, resource, operation-type, QMS, authority, and skill ports | Application developer and QA | September 29, 2026 |
| Apply the approved React design across the remaining Flight Control, Flight Plan and Flight Maneuver workflows; verify every drawer action uses the server authority path | Application developer and QA | September 29, 2026 |
| Run PostgreSQL integration against the target environment, then confirm backup and restore | IT | September 29, 2026 |
| Review the go/no-go evidence and approve or defer production use | QA Manager and IT | September 29, 2026 |
