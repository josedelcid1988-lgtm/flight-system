# Flight System v82 package summary

**September 27, 2026 | Branch `flight-v82-datum-port` | Draft for integration review**

## Implemented in this package

- SQLite and PostgreSQL server stores, account sessions, workspace ETags, append-only audit, evidence, archive, export delivery, browser workspace migration and download-only recovery for server-refused local edits.
- Locally bundled React Flight Control Hangar and work-order queue with live records, search, filters, compact density, open holds, an accessible record drawer, and routing to the existing full-page work-order workflow.
- React Flight Plan queue and Big Three with blocker-driven tasks and FlightPlan actions.
- React Flight Plan Kanban and MRP forecast with live planned orders, status lanes, demand/shortage summaries, compact density and responsive layout.
- React Flight Maneuver Quality Hangar with live CAR, MRB, NC and SPR metrics and queue, search, record-type filtering, compact density, accessible detail drawer and links into the existing gated workflows.
- Dedicated React NC Intake, Corrective Actions, Material Review Board and Problem Reports queues; NC Intake retains escape and work-order/stock-source filtering.
- Planning, capacity, work-center hierarchy, owner-aware server-persisted labor clock controls, milestones, maintenance and related scheduling records.
- Operation sub-code registers, source inspection, locked standard Inspection Step A, and expanded authority, role, training and stamp controls.
- Signed training completions can retain PDF or image certificates; the trainer manifest binds file name, MIME type, byte size and SHA-256, and the in-app preview checks the stored bytes before opening.
- QMS export settings and delivery history, signed audit/supplier/certification/quality records, and server-side record actions.
- Authenticated Jira Cloud issue creation for ECR, SPR and SCAR records. Credentials stay on the server, the server builds requests from shared records and durable per-record idempotency prevents duplicate sends after a confirmed or uncertain response.
- Signed controlled documents with retained SHA-256 checked files, distinct author/reviewer/releaser credentials, append-only revisions, and verified downloads.
- Draft AI governance procedures DG-01 to DG-04, DG-01 job description template and draft SOP-750-007, signed action hashes, 13 risk entries, governance evidence export, and server-only secret-presence confirmation for model settings. Model execution stays disabled in this package.
- Twelve deterministic skill draft templates with [confirm] refusal, deduplicated run evidence, independent review/acceptance, manager-controlled trigger records and a signed AS9102 Form 3 plan on WI drafts.
- Floor wake-lock opt-in, progress ring, retained helicopter motion, coarse-pointer bounded whole-number picker with touch swipes, design screenshots and browser recording.
- FAIR print export starts Forms 1, 2, and 3 on separate pages, repeats table headers, and keeps signature fields on Form 1 only.
- Build, test and source packaging tools, CI coverage and a machine path scan.

## Verification

- 64 of 64 suites passed in both local and mirror-enabled runs on September 27, 2026. `qa_full` passed 310 checks with zero skips. The mirror stored 17,545 records and its chain remained intact. Both runs used index stamp `48342b28496510abe133cfdfccd46974a78bfb52dfb0789feae2d00a761effab`; exact suite output is in `tests/suite_results.json` and `tests/suite_results_mirror.json`. Browser tests verify an authorized inspector signing FAA 8130-9 through the audited server action route.
- Browser captures exercise Hangar drawers, open holds, search, density, Flight Plan Kanban and MRP forecast, all four dedicated Flight Maneuver queues, the Flight Control work-order queue at 1440px, 1920px with reduced motion, and tablet widths; Created and Due use Month Day, Year formatting, full work order navigation, and the protected helicopter progress visualization. Jira browser verification covers authenticated ECR issue requests and safe replay of a linked ticket.
- Production, demo, and source ZIPs are rebuilt and checked against the tree for this integration-review package.
- PostgreSQL integration is configured in CI but was not run against a locally provisioned PostgreSQL database.

## Known incomplete work

- Some legacy edits are still browser-local, while unmatched server workspace snapshot writes are refused. The server is not ready to become the sole production system of record until all workflows use authorized server commands.
- React migration now includes the Flight Control Hangar, Flight Plan queue/Big Three/projects/dispatch/Kanban/MRP forecast, and all four dedicated Flight Maneuver record queues. MRP source links are capped inline with an expandable remainder. Other Flight Control screens and Flight Maneuver full detail screens still need the shared React design migration.
- Project telemetry is not tied to a planning system. The source had no live Google/Outlook connectors. Flight has a server-side Jira Cloud bridge with durable idempotency and ECR/SPR/SCAR linking; the owner's Jira tenant and service account still need configuration and live deployment verification. Several requested Datum skill modules remain conservative templates, and triggers are not wired to every business event. SPC I-MR control/capability and crossed-study MSA calculations are ported and covered by focused tests. FAIR page-break/repeating-header requirements are implemented and covered by print tests. The touch picker is implemented; hardware verification on iOS and Android remains open. See [`HANDOVER-v82.md`](../HANDOVER-v82.md).
- The specified Google and Outlook live calendar connectors are not implemented. Datum's source did not include them.

## Go/no-go recommendation

Do not approve production use of the authenticated server until the remaining server command coverage, requested feature scope, PostgreSQL target checks, and restore evidence are complete and reviewed by QA and IT. The current branch package is for integration review, not production deployment. PostgreSQL has not been exercised against an actual target database, and not every phase is complete.

See the detailed findings in [`SECURITY_REVIEW-v82.md`](SECURITY_REVIEW-v82.md) and [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).
The one-page handoff summary is in [`ONE-PAGE-SUMMARY-v82.md`](ONE-PAGE-SUMMARY-v82.md).

## Decisions needed before the September 29 checkpoint

- **Calendar and Jira integrations:** Datum's supplied source has no Google or Outlook OAuth connector. The Flight Jira bridge is implemented but needs the owner's Jira Cloud tenant, service account and project access configured on the server, then verified against that tenant.
- **Model use:** this package records model-setting governance only and never runs a provider. If model-generated analysis is required, QA and IT must approve the provider, endpoint, data flow, validation and server secret name before implementation can be enabled.
- **Deployment target:** IT must identify the PostgreSQL target and demonstrate backup/restore. No production server approval is recommended until this is tested with complete server command coverage.
- **Production use:** no skipped QA check is permitted without a named reason. The current evidence has zero unexplained skips; accept or reject any new waiver explicitly if a later full suite finds one.

These items are blockers or decisions, not claims that the missing integrations are working. The current code and evidence remain on `flight-v82-datum-port` for review and can be removed by returning to the baseline branch.
