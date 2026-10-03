# Withdrawn function — local-only ticket types (scope)

**Problem:** There is no withdraw or cancel path for tickets. The only workaround is a second person recording a root-cause note saying the ticket was opened in error, then the opener verifying it — which works but leaves a messy record.

**Scope:** CARs, NCs, PFMEAs, MRBs, FAIRs, 8Ds, and SPRs — the seven ticket types not tied to Jira.

**Build:** A `withdrawn` status with a reason field, following the same request-then-approve pattern as work order closure. The opener requests, a second person with the right capability approves, and the record ends as Withdrawn with the reason attached.

**Tests:** The opener cannot withdraw their own record. The approver cannot be the requester. Refusal paths are pinned.

**Status:** Scope agreed. Implementation not started. Ships before the Jira-tied variant (PR 3) to prove the local pattern.
