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

## Archived work orders

A closed work order leaves the live workspace once it is stocked, or when it cannot be stocked, and and is kept read-only in the archive. Trace search lists archive matches beside live records, with Print and Export on each row. Print opens the stamped record. Export downloads `WO-...-archive.json` with the order, its signatures and history, its activity and the bytes of every linked recording, including removed (quarantined) ones. Each print and export is recorded in the order's extract history and the audit log.

The export's `extractSha256` covers the order, its activity, the archive hash and the metadata of each recording, including that recording's SHA-256. The recording bytes are streamed one at a time, so a large archive never has to fit in server memory. To verify a download, check each recording's base64 bytes against its `sha256`, then hash the rest of the extract as described in `extractHashCovers`.

### One-time scan for a `__proto__` key (issue #174)

Since #168 an order carrying an own `"__proto__"` key cannot enter the archive, because content under that key sits outside the record's signatures. Rows archived before that are served as stored. This read-only scan lists any such row once. It opens the store the way the server does, runs no schema step, writes nothing, and uses the engine's own finder.

Run it from the checkout the server runs from, as a user who can read the database. SQLite, the server's database or a backup copy of it:

```bash
node tools/scan-archive-proto.mjs --db data/flight.sqlite
```

PostgreSQL, with the connection string in the environment (the scan never prints it) and a role that can read `archive`. The scan runs in one `REPEATABLE READ READ ONLY` transaction:

```bash
FLIGHT_DATABASE_URL='postgresql://flight:password@db.internal:5432/flight_system?sslmode=require' node tools/scan-archive-proto.mjs
```

It prints the rows scanned, the rows flagged, and one `FLAGGED <work order> own "__proto__" key at <path>` line per flagged row. The path names the object that holds the key. Exit status: `0` nothing flagged, `1` one or more rows flagged, `2` the scan could not finish (for example the store could not be opened or a row's JSON does not parse). The server can keep running during the scan. If it is stopped, keep it stopped until the scan finishes: a SQLite file with no `-wal` beside it is opened immutable, which leaves no files behind but assumes nothing writes to it meanwhile. Send the output to the QA Manager; the scan changes nothing, so any follow-up is a separate, recorded decision.

The server also runs this scan once each time it starts, against the store it was started with (SQLite or PostgreSQL). The check starts after the server is listening and does not hold up sign-in or any request. It reads through its own read-only connection, writes nothing, and never prints the connection string. It logs one line:

- `archive __proto__ check: 1200 rows scanned, 0 flagged`: nothing to do.
- `WARNING archive __proto__ check: 1200 rows scanned, 1 flagged: WO-... own "__proto__" key at <path>`: each flagged work order and path is named on that line. Send the line to the QA Manager, as for the manual scan.
- `WARNING archive __proto__ check could not finish: <reason>`: the server keeps running. Run the manual scan above to check the archive.

## Demo build

`demo.html` relaxes separation of duties, PIN entry and the stamp gate, so the production server does
not serve it. To offer it from a training server, start that server with `--serve-demo` or
`FLIGHT_SERVE_DEMO=1`. Every page of the demo still says DEMO, NOT FOR ACCEPTANCE.

## Training mode

`--training` or `FLIGHT_TRAINING=1` runs the production build, with every rule and gate enforced, for a training
session on its own database (`--db training.sqlite`). The server adds TRAINING, NOT THE RECORD to the page it sends:
a strip on every screen, the sign-in screen included, the word Training in the tab title, and a mark at the top of
every print and HTML download, the archive print included; printing a screen puts the mark first on the first sheet
and repeats the strip at the foot of every sheet. Every file the page saves is named `TRAINING-<name>`, and an archive
print or export carries `"training": "TRAINING, NOT THE RECORD"` inside the content its extract hash covers, so the
mark cannot be removed without breaking the hash. A training server sends nothing outward: the Jira connector reads as
not configured and record exports are neither configured, queued nor delivered. Without the option nothing is added
and the page is served as before. `FLIGHT_TRAINING` accepts 1, true,
yes or on, and 0, false, no or off; any other value stops the server so a misspelled setting never starts an unmarked
training server.

A training server opens only a training database. On a new, empty database it writes a `training-database` row as the
first row of the audit chain; it refuses any database that already holds records without that row. A production
server refuses a database that carries it. Give the training server its own `--db` file. Setup steps for a laptop rehearsal and an IT machine are in
[`TRAINING_SERVER_SETUP.md`](TRAINING_SERVER_SETUP.md).

## Health check

`GET /api/health` answers `{ "ok": true }` to anyone, for a load balancer or monitor. The product name,
account count, workspace presence, ETag and schema version are returned only to a signed-in session.

## Sessions at rest

Each session is stored as the SHA-256 of its token, in SQLite and PostgreSQL alike, so a copy of the
database or a backup holds no session that can be used. The browser keeps the token for its tab and
the server hashes it on every request. Upgrading a database made before this ends its stored sessions:
each person signs in again once.

## Who can read evidence

A recording is read under the authority of the record that names it. Any signed-in account can read the
live workspace and the archive, so it can read a recording a live operation or an archived order names,
including the stored copy behind another ID. A recording no record names yet (uploaded but not saved on
an operation) can be opened only by the account that uploaded it and by a QA Manager or Master Access
account. Other requests are refused with 403 and recorded as `evidence-read-refused`.

A record names a recording only through an operation's `evidence` or `quarantinedEvidence` entry, by its `id`
or its `copyOf`, matched exactly. The live check and the archive check use the same rule
(`server/evidence-refs.mjs`) in both the SQLite and the PostgreSQL store. A recording ID written anywhere else in
an order, such as a title, a note or an activity line, names nothing and does not open the recording.

Each archived order's references are recorded in `archive_evidence` when the order is archived, with a marker in
`archive_evidence_indexed`, so the archive check is one indexed lookup. Any archived order without a marker (the whole
archive of a database from before these tables, or an order archived by a server still on an earlier release during a
rolling upgrade) is recorded at startup and again by the next lookup that misses, so no archived recording is left
unreadable. Each pass covers the archive as it stood when the pass started, so a server still archiving on an earlier
release cannot keep a start or a lookup waiting; what it adds is indexed by the next pass.

A reference is also authority, so adding one is checked: a write (a record action or a workspace save) that adds a
new reference to a recording the server holds is refused with 422 and recorded as `evidence-refused` unless the
account uploaded that recording or is a QA Manager or Master Access account. On a workspace that already exists, a
new reference to a recording the server does not hold yet is refused too (the browser uploads before it saves the
reference), so a reference cannot be saved ahead of someone else's upload. A recording the workspace already names
stays usable as before.

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

## Model adapter key setting

The model adapter's configuration names the server setting that holds its key; the key itself stays
in the server environment. Only a setting the operator lists can be named:

```bash
FLIGHT_MODEL_ADAPTER_SETTINGS='FLIGHT_MODEL_KEY'
FLIGHT_MODEL_KEY='...'
```

Naming any other setting is refused with the same message as a listed setting that is empty, so the
check cannot be used to learn which environment variables exist on the server. A malformed list stops
the server at startup.

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
