# Server databases

The authenticated MES server supports SQLite for a single-machine installation and PostgreSQL for a shared deployment. The browser still calls one HTTP API, and the MES validation, session, audit, archive and evidence rules run through the same async store interface.

## SQLite (default)

```bash
node server/server.mjs --host 127.0.0.1 --port 8080 --db data/flight.sqlite
```

SQLite uses WAL mode. The database file contains accounts, sessions, lockouts, workspace, archived work orders, evidence bytes, extract history and the hash-chained audit log. Back up the whole database with:

```bash
node server/server.mjs --db data/flight.sqlite --backup data/flight-backup.sqlite
```

## PostgreSQL

Install the locked dependencies and PostgreSQL client tools, then set a connection URL in the server process:

```bash
npm ci
export FLIGHT_DATABASE_URL='postgresql://flight:password@db.internal:5432/flight_system?sslmode=require'
node server/server.mjs --host 127.0.0.1 --port 8080
```

`FLIGHT_DATABASE_URL` selects PostgreSQL. An explicit `--db` selects SQLite instead. The server creates or upgrades its tables at startup. Each store operation is awaited. Multi-record workspace and account writes use a single PostgreSQL client and transaction; account sessions and audit-chain writes use PostgreSQL advisory locks to serialize concurrent changes. Password hashes, lockouts, record extracts, evidence bytes, archive rows and the audit chain have the same behavior as in SQLite.

Back up PostgreSQL using the server command and `pg_dump`:

```bash
FLIGHT_DATABASE_URL='postgresql://flight:password@db.internal:5432/flight_system?sslmode=require' \
  node server/server.mjs --backup data/flight-backup.dump
```

The PostgreSQL integration suite runs against a PostgreSQL 16 service in CI:

```bash
FLIGHT_DATABASE_URL='postgresql://flight:password@localhost:5432/flight_system' npm run test:postgres
```

The PostgreSQL test is intentionally separate from the SQLite-only local suite runner so it never reports a skip when no PostgreSQL service is available. CI always provides the service and runs the integration test.

## First-run setup code

The first account on a new server becomes Master Access, so creating it needs a setup code that only
the person running the server can see. When no account exists yet, the server prints the code in its
console at startup:

```text
First-run setup code: <code>
```

Enter it on the Set up Master Access screen. To choose the code yourself, set
`FLIGHT_BOOTSTRAP_TOKEN` in the server's secret store before the first start. Once the first account
exists the code is no longer accepted or shown. A request without the right code is refused with 403
and recorded in the audit trail as `first-account-refused`.

## HTTPS record export credentials

An HTTPS record export sends a bearer token read from a server setting. Record export settings name
that setting, but the server only sends a setting the operator has bound to the destination's origin
in `FLIGHT_EXPORT_CREDENTIALS`:

```bash
FLIGHT_EXPORT_TOKEN='...'
FLIGHT_EXPORT_CREDENTIALS='{"FLIGHT_EXPORT_TOKEN": ["https://records.example.com"]}'
```

Saving an export setting whose setting name or destination host is not bound is refused. Each queued
delivery is checked again before it is sent, so no other server secret, such as
`FLIGHT_JIRA_API_TOKEN`, can be sent to any host. A malformed `FLIGHT_EXPORT_CREDENTIALS` stops the
server at startup.

## Jira Cloud connector

The authenticated server can send saved ECR, SPR and SCAR records to Jira Cloud. Keep these
environment variables in the server's secret store:

```bash
FLIGHT_JIRA_BASE_URL='https://company.atlassian.net'
FLIGHT_JIRA_EMAIL='flight-service@example.com'
FLIGHT_JIRA_API_TOKEN='...'
```

The service account needs permission to browse the referenced Jira projects and create issues. The
browser receives only whether the connector is configured. It never receives the API token. The
server reads each issue payload from the shared workspace and writes the returned Jira key back
through the Flight rule engine. A durable per-record idempotency row is stored in either SQLite or
PostgreSQL. If Jira may have accepted a create request but the response was lost, Flight refuses to
send a second request. Search for the `flight-mes-<type>-<id>` label and reconcile the existing issue
before trying to resolve that pending request.
