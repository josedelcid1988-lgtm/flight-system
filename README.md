# Flight System

Skyryse manufacturing execution and quality system. The product has three
modules: Flight Control, Flight Plan, and Flight Maneuver.

## Run the shared server

The app runs on an on-premises server or an internal server in another network.
SQLite is the default and stores data on the host disk. PostgreSQL is available
for shared deployments. Users open the server address in a browser; the app and
API are served together.

```bash
npm ci
node server/server.mjs --host 0.0.0.0 --port 8080 --db data/flight.sqlite
```

With no `--host` (or `FLIGHT_HOST`) the server binds `127.0.0.1`, so only this
machine and a reverse proxy on it can connect; that is the setting to use behind
a proxy. Name `--host 0.0.0.0`, as above, only when network access is controlled
by a firewall or trusted internal network. Configure TLS at the reverse proxy for browser access beyond
the local machine.

PostgreSQL is selected with `FLIGHT_DATABASE_URL`. See
[`docs/DATABASES.md`](docs/DATABASES.md) for server setup, backups, and the
PostgreSQL integration check. The optional append-only browser mirror in
`server/mirror/` is separate from the authenticated server.

For standalone use, open `index.html` with `assets/` beside it. Browser storage
is local to that browser and is not shared with the server workspace.

## Build and verify

See [`TESTING.md`](TESTING.md) for the full verification commands and suite
expectations. The app bundles its React interface locally; no CDN is required.
The demo build is generated from production and is labeled DEMO, NOT FOR
ACCEPTANCE.

Start with [`HANDOVER-v82.md`](HANDOVER-v82.md) for the package contents,
on-prem startup steps, verification status, and release blocker. The deeper
architecture and record-control guide is [`docs/HANDOVER.md`](docs/HANDOVER.md).
End-user workflows are summarized in [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md).

## Integrations and deployment status

Okta, NetSuite, Jira, PDM, LMS, and Slack connections still require external
configuration or bridge services. Standalone browser mode is available. The
authenticated server supports local SQLite and PostgreSQL. Whole-workspace
writes are role-authorized: `PUT /api/workspace` lets only a QA Manager or
Master Access account initialize an empty server. Once the workspace exists,
other roles are refused with 403, a manager request needs the current ETag in
`If-Match` (428 without it, 409 when it is stale). With the current ETag, a
snapshot identical to the stored workspace is an audited no-op (204) and a
changed snapshot is refused with 403. Each 403 refusal is recorded in the
security audit. After
initialization, shared records change only through server-side engine writes
that run the same checks as the page: the MES actions at
`POST /api/workspace/actions/...` and, when the Jira connector is enabled, the
record link written by `POST /api/jira/issue`. The remaining gap is coverage,
not authorization: some direct field edits and legacy workflows are not yet
bridged to a server action. The server refuses those edits rather than saving
them; the browser keeps an unconfirmed recovery copy and reloads the shared
workspace. Do not use the server as the authoritative production system until
that bridge is complete
(see [`docs/SECURITY_REVIEW-v82.md`](docs/SECURITY_REVIEW-v82.md)).

The older visual inspection is retained at
[`docs/QA_INSPECTION_2026-09-25.md`](docs/QA_INSPECTION_2026-09-25.md). Current
browser test coverage and exact commands are listed in [`TESTING.md`](TESTING.md).
