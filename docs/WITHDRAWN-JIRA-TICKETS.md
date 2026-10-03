# Withdrawn function — Jira-tied ticket types (scope)

**Problem:** Same as the local-only withdrawn function, plus the Jira side. If a ticket was already pushed to Jira — an ECR, SPR, or SCAR — the local withdrawal has to tell Jira to close or cancel that issue too.

**Scope:** ECRs, SPRs, and SCARs — the three Jira-tied types.

**Build:** Same local pattern as the local-only withdrawn function, plus a connector command that closes the remote Jira issue, with idempotency rows and uncertain-response refusal so a lost response does not leave a silently-open ticket. Flight's connector already has durable per-record idempotency rows and uncertain-response refusal for ticket creation; this PR extends that machinery to withdrawals.

**Tests:** Local refusal paths plus connector tests against a mock Jira: a withdrawal command retries safely, and an uncertain response is refused rather than claimed as success.

**Sequencing:** The local-only withdrawn PR ships first and proves the local pattern. This PR builds on it and adds the Jira layer on top.

**Status:** Scope agreed. Implementation not started.
