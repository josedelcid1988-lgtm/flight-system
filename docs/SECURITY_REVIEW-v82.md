# Security and reliability review, v82

Review date: 27 September 2026. This is a source review of the current branch, not a penetration test.

## Snapshot authorization: wholesale writes are refused

`PUT /workspace` initializes an empty server once. After initialization, a changed whole-workspace snapshot is refused and audited for every role. A same-content manager snapshot with a current ETag is an audited no-op. Tests cover refusal for operator and Master Access accounts and preserve stale ETag conflict handling.

The browser routes successful calls to matched state-changing MES functions through `POST /workspace/actions/...`, then refreshes the shared workspace. The server now independently applies the command-name allowlist and rejects exported readers, migration helpers, and manifest/signature primitives from the action route. The bridge still does not cover every direct field edit or legacy workflow. Definite action and snapshot refusals now reload the last committed shared workspace and discard unaccepted edits. If the request outcome is unknown because the connection failed, the browser preserves the local copy, marks it unconfirmed, and checks the server before sending another write after connectivity returns. This prevents a shared-record bypass, but command coverage remains incomplete. Finish it before multi-user production use. Do not expose this authenticated server as an authoritative production system yet.

## Reliability limitation: local save can precede server confirmation

The browser commits locally and queues the server request. The status indicator now distinguishes `Saving to server`, `Server synced`, `Offline copy`, `Sync conflict`, and `Sync needs attention`, and a rejection raises a message. A successful local save is still not proof of server persistence. Definite refusals reload the shared record; transport uncertainty remains visibly unconfirmed until the server can be checked. Operators must resolve that status before treating a change as shared.

## Authorization shim

Server actions use the same MES engine as the page and are limited to functions classified as commands by the client bridge. The server capability shim evaluates expanded-role and individual-grant training against the shared workspace; missing, expired, or stale training pauses that authority. The server suite covers active and expired training and rejects public helper functions at the command route. The browser suite verifies recognized MES actions are audited and committed by the server. Unmatched direct edits remain an availability and user-feedback risk, not a shared-workspace snapshot bypass.

Browser evidence uploads now store recording bytes in the authenticated server evidence table before the attach command can commit. The client supplies and verifies the SHA-256, retrieval rechecks the response digest, and the buy-off path refuses when the server copy cannot be confirmed. The browser integration test covers upload, server metadata, retrieval and digest validation. Offline cache availability alone does not satisfy the server evidence gate.

## Deployment checks

- Keep the server on a private network behind TLS and an access-controlled reverse proxy. Do not expose first-account setup to an untrusted network.
- SQLite and PostgreSQL share the async storage contract. PostgreSQL integration runs in CI; it has not been exercised against a separately provisioned local production-like service during this review.
- Back up the database and test restoration before use. A hash chain detects changes; it does not prevent a database administrator from replacing the database and its backups.
- This review did not find machine-specific paths in the repository. `node tests/check_no_machine_paths.mjs` enforces that check.
