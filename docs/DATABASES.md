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
