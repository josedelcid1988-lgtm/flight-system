# Flight System v82 integration handoff

**September 27, 2026 | Branch:** `flight-v82-datum-port` | **Status:** integration review, not production approval

## Shipped in this package

- SQLite server-of-record mode with PostgreSQL support, sessions, ETags, append-only audit, evidence storage, archive, exports, migration and server-side MES commands.
- Planning, capacity, dispatch, labor, work centers, maintenance, inventory, projects, milestones, sprints, calendar file import/export and planned-order workflows.
- Operation sub-codes, source inspection, role and training controls, stamp handling, signed QMS records and controlled documents.
- Server-side Jira issue creation for ECR, SPR and SCAR with role checks and durable idempotency.
- AI governance records and twelve Flight-only deterministic skill drafts with human review and acceptance controls. QA Manager or Master Access can configure supported event triggers for NC raised, CAR raised or verified, FAIR approval and WI release; these only create deduplicated review drafts.
- Approved React design in the Flight Control Hangar, serial-number register, Traceability search/results and work-order queue; Flight Plan queue, Big Three, projects, dispatch, Kanban and MRP forecast; and Flight Maneuver queues. Skyryse branding and helicopter progress visuals remain.
- Floor picker, wake-lock option, sync indicators, FAIR print page rules, full test suite and portable source, production and demo archives.

## Verification

The September 27 local and mirror runs each passed 66 of 66 suites with zero skips against build stamp `9dea7470173bda204772cff9c96e70efd162f13f38ccd6d190b17d824120de65`. `qa_full` passed 310 checks. The mirror verified 17,546 records with an intact hash chain. Archive creation, source archive CRC, current build outputs and the machine-path scan passed. PostgreSQL was not provisioned locally.

## Open before production use

- Route remaining legacy edits through authorized server commands; some still save only in browser storage and are refused by the shared server.
- Complete the React migration for remaining Flight Control screens and Flight Maneuver full-record workflows.
- Add more Datum source fixtures and finish the remaining skill-port validation. Model execution is unavailable; compatible NC, CAR, FAIR and WI triggers create drafts only.
- Implement and verify Google Calendar and Outlook connectors. The supplied Datum source had no OAuth connector implementation.
- Configure and verify the owner's Jira tenant and service account. Keep Jira as the source of truth for its tickets.
- Run PostgreSQL integration, then verify target backup and restore. Test the floor picker on iOS and Android hardware.
- Complete three-person release of draft AI governance procedures; model execution remains disabled.

## Decisions and owners

- **Product owner:** confirm whether Google/Outlook live sync and model-generated analysis are required for handoff, and provide approved connection/data-flow requirements if they are.
- **IT:** identify the PostgreSQL target, run its integration checks, and record backup/restore evidence; configure the Jira server credentials and project settings.
- **QA Manager and IT:** review the open items and make the production go/no-go decision. This package is ready for integration review, not production operation.

## Local archives

- `release/flight-system-v82-source.zip`
- `release/flight-system-v82.zip`
- `release/flight-system-v82-demo.zip`

No archive was pushed to GitHub. The repository owner can upload or post these files from the branch checkout.
