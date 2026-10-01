# Flight System server components

The main authenticated MES server is `server/server.mjs`; SQLite and PostgreSQL setup, backups, and the PostgreSQL integration check are documented in [`docs/DATABASES.md`](../docs/DATABASES.md).

## PostgreSQL backup and restore

The PostgreSQL target (selected with `--database-url` / `FLIGHT_DATABASE_URL`) backs up with
`pg_dump` in custom format and restores with `pg_restore`. The PostgreSQL client tools must be
installed wherever these commands run.

Online backup while the server runs:

```bash
node server/server.mjs --database-url "$FLIGHT_DATABASE_URL" --backup /backups/flight-2026-09-28.dump
```

Offline restore. Stop the server first when restoring into its database, or restore into an empty
database and point the server at it afterwards:

```bash
node server/server.mjs --database-url "$FLIGHT_DATABASE_URL" --restore /backups/flight-2026-09-28.dump
```

The restore expects an empty database by default. It runs as one transaction: if any step fails,
the target is left exactly as it was, including with `clean: true`. The session rows in the archive
are never restored: the same transaction recreates the sessions table empty, so a token that was
signed out after the backup cannot work again; everyone signs in again. Starting the server after a restore verifies the
audit chain before accepting traffic; a tampered archive refuses to start, exactly as it does for
SQLite.

Programmatic access: `store.backup(path)` on an open store, and
`restorePostgres(connectionString, archivePath, { clean })` from `server/db-postgres.mjs`
(`clean: true` replaces the target database in place with `--clean --if-exists`, inside the same
single transaction).

Keep backup archives off the database machine. The round-trip (backup, wipe, restore, verify data
and audit chain) is covered by `tests/postgres/backup_restore.mjs`, wired into the `test:postgres`
script.

The older optional append-only browser persistence mirror is in `server/mirror/`. Its setup, settings,
API, backups and restore procedure are in `server/mirror/README.md`, which is the only current
reference: the mirror needs two tokens (`FS_MIRROR_TOKEN` for the operator, `FS_MIRROR_WRITE_TOKEN`
for the page), listens on loopback unless it runs behind a TLS-terminating proxy, and the page accepts
only an `https://` mirror address (or `http://` on loopback).

```bash
node tests/test_mirror.mjs            # on and off, outage and recovery, idempotent retry, tamper detection, backup and restore
node tools/run-suites.mjs --mirror    # every other suite again with the mirror switched on
```
