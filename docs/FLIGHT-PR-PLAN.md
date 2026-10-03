# Flight System PR Plan

Five PRs, validated against the Flight System codebase (v82, main at d05626e5). Each PR is its own review, its own CI run, its own merge.

## PR 1 — Traveler print fix
Branch: `fix/traveler-closedas-print`

**Problem:** When a work order closes as scrap or obsolete, the traveler still prints just "Closed" with no reason. The record already stores the disposition in the `closedAs` field, and the React OrderPage renders it as a pill, but the print template never reads it.

**Fix:** One line in the traveler template: print "Closed as Scrap" or "Closed as Obsolete" next to the status. Add a test that closes an order as Scrap and asserts the print text contains it.

**Risk:** Low — display only, no data change. The print path lives inside index.html, which GitHub's code search cannot read, so the exact template location needs a local search before the edit.

## PR 2 — Withdrawn function for local-only ticket types
Branch: `feat/withdrawn-local-tickets`

**Problem:** There is no withdraw or cancel path for tickets. The only workaround is a second person recording a root-cause note saying the ticket was opened in error, then the opener verifying it — which works but leaves a messy record.

**Scope:** CARs, NCs, PFMEAs, MRBs, FAIRs, 8Ds, and SPRs — the seven ticket types not tied to Jira.

**Build:** A `withdrawn` status with a reason field, following the same request-then-approve pattern as work order closure. The opener requests, a second person with the right capability approves, and the record ends as Withdrawn with the reason attached.

**Tests:** The opener cannot withdraw their own record. The approver cannot be the requester. Refusal paths are pinned.

## PR 3 — Withdrawn function for Jira-tied ticket types
Branch: `feat/withdrawn-jira-tickets`

**Problem:** Same as PR 2, plus the Jira side. If a ticket was already pushed to Jira — an ECR, SPR, or SCAR — the local withdrawal has to tell Jira to close or cancel that issue too.

**Scope:** ECRs, SPRs, and SCARs — the three Jira-tied types.

**Build:** Same local pattern as PR 2, plus a connector command that closes the remote Jira issue, with idempotency rows and uncertain-response refusal so a lost response does not leave a silently-open ticket. Flight's connector already has durable per-record idempotency rows and uncertain-response refusal for ticket creation; this PR extends that machinery to withdrawals.

**Tests:** Local refusal paths (PR 2) plus connector tests against a mock Jira: a withdrawal command retries safely, and an uncertain response is refused rather than claimed as success.

**Sequencing:** PR 2 ships first and proves the local pattern. PR 3 builds on it and adds the Jira layer on top.

## PR 4 — Retention and archival
Branch: `feat/retention-archival`

**Problem:** No retention table, no disposition gate, no cold storage. Closed orders accumulate in the workspace forever. The archive exists — `archiveOrders` moves closed orders out of the live workspace, and `test_server_converge.mjs` asserts it — but it is the only tier.

**Build:**

- **Retention table:** One row per record class — work orders, evidence, audit log, skill runs — with a period and a disposition. Ships with defaults matching the regulatory floors: five years for manufactured products, ten for critical components, audit log kept as long as the database. The QA Manager fills it in at setup; the software enforces it. The two-year hot window is the default, not a limit — the QA Manager can set it to one year or three.
- **Disposition gate:** Before anything leaves hot storage, the system checks for a disposition record — attached, archived, or destroyed with a reason and a signature. No record, no delete. Nothing leaves silently.
- **Hot storage:** Postgres — all open work orders plus closed orders for two years.
- **Cold storage:** The cloud server — S3 Glacier or equivalent — holding everything older, with the same SHA-256 hashes and manifests traveling with the records so integrity survives the move.
- **The move:** Automatic. When a closed order hits the two-year mark, the system writes a disposition record, then copies the record and its evidence bytes to cold storage.

**Tests:** A closed order older than two years gets a disposition record before it moves. A record without a disposition is refused. The retention table is editable at setup without a code change.

## PR 5 — Sync conflict resolution
Branch: `feat/sync-conflict-resolution`

**Problem:** Flight's sync queue handles delivery — it retries with exponential backoff and shows the unsynced count — but it does not decide what happens when two offline edits collide. The ETag catches the collision: a stale write gets refused. But the refused write is not merged or flagged for a person. It just fails, and the second technician's changes are lost unless they re-enter them.

**Build:** Keep both versions, merge them, and flag the conflict for a person to resolve. Builds on the existing ETag on workspace writes and the append-only change log, which gives a replayable history.

**Tests:** A queued change pushes when the server returns. A conflict keeps both versions and flags them. The ETag still refuses a stale write.

## Not on the list

- **Mirror:** Already built in Flight — `server/mirror/` is complete and tested: hash-chained SQLite, verify endpoint, backup-restore cycle, seventeen thousand records verified intact. No port needed.
- **Jira connector:** Already built and tested in `test_jira_integration.mjs` — durable per-record idempotency rows and uncertain-response refusal for ticket creation. PR 3 extends it to withdrawals only.
- **Stamp test:** `test_authority.mjs` already tests retiring a number and refusing reissue. No coverage gap to fill.

## Datum cross-reference

The same five items were validated for Datum-OS and sequenced as eight PRs there (docs, traveler print, withdrawn local, withdrawn Jira, retention, mirror port, sync, stamp test). Flight's list is shorter because the mirror and Jira connector already exist.
