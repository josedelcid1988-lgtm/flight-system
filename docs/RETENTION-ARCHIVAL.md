# Retention and archival (scope)

**Problem:** No retention table, no disposition gate, no cold storage. Closed orders accumulate in the workspace forever. The archive exists — `archiveOrders` moves closed orders out of the live workspace, and `test_server_converge.mjs` asserts it — but it is the only tier.

**Build:**

- **Retention table:** One row per record class — work orders, evidence, audit log, skill runs — with a period and a disposition. Ships with defaults matching the regulatory floors: five years for manufactured products, ten for critical components, audit log kept as long as the database. The QA Manager fills it in at setup; the software enforces it. The two-year hot window is the default, not a limit — the QA Manager can set it to one year or three.
- **Disposition gate:** Before anything leaves hot storage, the system checks for a disposition record — attached, archived, or destroyed with a reason and a signature. No record, no delete. Nothing leaves silently.
- **Hot storage:** Postgres — all open work orders plus closed orders for two years.
- **Cold storage:** The cloud server — S3 Glacier or equivalent — holding everything older, with the same SHA-256 hashes and manifests traveling with the records so integrity survives the move.
- **The move:** Automatic. When a closed order hits the two-year mark, the system writes a disposition record, then copies the record and its evidence bytes to cold storage.

**Tests:** A closed order older than two years gets a disposition record before it moves. A record without a disposition is refused. The retention table is editable at setup without a code change.

**Status:** Scope agreed. Implementation not started.
