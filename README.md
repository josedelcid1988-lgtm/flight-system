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

For a training session on a separate database, add `--training` (or set `FLIGHT_TRAINING=1`): every rule
stays enforced and every page, print and download is marked TRAINING, NOT THE RECORD. See
[`docs/TRAINING_SERVER_SETUP.md`](docs/TRAINING_SERVER_SETUP.md) and the sample data in `samples/training/`.

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
authenticated server supports local SQLite and PostgreSQL, but whole-workspace
writes are not yet role-authorized; do not use it as the authoritative
production system until the blocker in
[`docs/SECURITY_REVIEW-v82.md`](docs/SECURITY_REVIEW-v82.md) is resolved.

The older visual inspection is retained at
[`docs/QA_INSPECTION_2026-09-25.md`](docs/QA_INSPECTION_2026-09-25.md). Current
browser test coverage and exact commands are listed in [`TESTING.md`](TESTING.md).
