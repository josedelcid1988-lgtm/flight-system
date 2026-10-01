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

The older optional append-only browser persistence mirror is in `server/mirror/`:

A small Node server that keeps a durable, tamper-evident copy of everything the app commits. It is a
mirror, not a replacement: the app keeps working from the browser's `localStorage`, validates and
rolls back exactly as before, and never waits on this server. With the mirror switched off (the
shipped default) the app is unchanged.

- One process, one SQLite file in WAL mode, Node built-ins only (`node:sqlite`, `node:http`). No
  `npm install`.
- Append-only: SQLite triggers reject every `UPDATE` and `DELETE` on both tables (`schema.sql`).
- Hash chain: every row stores the SHA-256 link of the row before it (`prev_sha256`), so an edit to
  a stored row, or a missing row, is found by `GET /api/v1/verify`.
- Never receives a password, a stamp PIN or their hashes and salts. Accounts arrive as name, role
  and Support Access only.

Requires Node 22.13 or later (for `node:sqlite` without a flag).

## Run it

```bash
FS_MIRROR_TOKEN='<long random value>' FS_MIRROR_ALLOW_ORIGIN='https://mes.internal' node server/mirror/server.mjs
```

The mirror refuses to start without a token. Every endpoint needs it except health, which without the
token answers only that the mirror is up. With no allowed origin the mirror sends no CORS header, so a
browser page can reach it only when `FS_MIRROR_ALLOW_ORIGIN` names the address the app is served from.

Then point the app at it. In `index.html`, in the `sk-mirror` block, set:

```js
window.SK_MIRROR = { url: 'http://mes-mirror.internal:8787', token: '<the same token>', batchSize: 50 };
```

Leave `url` empty to switch the mirror off. The header then shows nothing and the app makes no
network calls.

## Settings

Command line flags win over environment variables, which win over the defaults.

| Flag | Environment | Default | What it does |
| --- | --- | --- | --- |
| `--host` | `FS_MIRROR_HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` only behind the site's reverse proxy or firewall. |
| `--port` | `FS_MIRROR_PORT` | `8787` | Port. |
| `--db` | `FS_MIRROR_DB` | `server/mirror/data/mirror.sqlite` | The database file. |
| `--backup-dir` | `FS_MIRROR_BACKUP_DIR` | `server/mirror/backups` | Where backups go. Point it at storage on a different machine. |
| `--backup-every-minutes` | `FS_MIRROR_BACKUP_EVERY_MINUTES` | `1440` | How often to take a backup; `0` switches the schedule off. |
| `--backup-keep-days` | `FS_MIRROR_BACKUP_KEEP_DAYS` | `30` | Daily copies kept (the newest copy of each day). |
| `--token` | `FS_MIRROR_TOKEN` | none: required | Every endpoint needs `Authorization: Bearer <token>`; health without it reports liveness only. Set the same token in `SK_MIRROR.token`. The mirror does not start without one. |
| `--insecure-no-token` | `FS_MIRROR_INSECURE_NO_TOKEN=1` | off | Runs the mirror with no token. Only for a machine nobody else can reach. |
| `--allow-origin` | `FS_MIRROR_ALLOW_ORIGIN` | none | CORS origin. Set it to the address the app is served from; with none, no CORS header is sent and no other website can call the mirror from a browser. |
| `--max-body-bytes` | `FS_MIRROR_MAX_BODY_BYTES` | `33554432` | Largest request accepted. |

## What the app sends

After every committed write (only once `MES.validate` has passed) the app compares the workspace
with what it last sent and queues one record per changed entity, plus account and role changes.
Each record carries the entity JSON and its SHA-256, the signed-in person and credential, the client
time, the build number and build SHA-256 (see `VERSION.md`), and every signature manifest found in
the entity. The queue lives on the device under `skyryse-mes-sync-queue-v1` until the server
confirms each record; the header shows **Synced** or **N unsynced**. If the server is down the queue
grows, writes carry on, and the app retries with exponential backoff capped at 60 seconds until the
server is back.

Entity types: `order`, `master-wi`, `planned-order`, `stamp`, `serial`, `car`, `mrb`, `nc`, `spr`,
`pfmea`, `ecr`, `wo-request`, `notice`, `assignment`, `rework-template`, `support-log`,
`workspace-settings`, `account`.

## API (JSON, versioned)

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/writes` | Body `{ clientId, records: [...] }`, up to 500 records. Each comes back `stored`, `duplicate` (the same `clientWriteId` and payload already stored: a safe retry) or `rejected` with a reason (bad hash, malformed manifest, a `clientWriteId` reused for a different payload). |
| `GET /api/v1/health` | With the token: row and manifest counts, the last write time, the backup settings and the last backup file. Without it: `{ ok, api }` only. |
| `GET /api/v1/verify` | Walks the whole chain: `chainIntact`, the row count, the chain tip, and `firstBreak: { id, reason }` when it is broken. |
| `GET /api/v1/export?format=json` | Full retention export: every record with its manifests, plus a verify result. |
| `GET /api/v1/export?format=csv` | The same records as CSV, one row per record. |
| `GET /api/v1/records?entity=order&id=WO-10001` | Every record for one entity, oldest first, with its manifests. For audits. |

## Backups

The server takes an online backup on its schedule with SQLite `VACUUM INTO`, which produces a
consistent copy while the server keeps accepting writes. After each backup it keeps the newest copy
of each day for `backup-keep-days` days and deletes the rest. Take one on demand with:

```bash
node server/mirror/server.mjs --backup-now --db /srv/flight-system/mirror.sqlite --backup-dir <backup-host-directory>
```

Put the backup directory on a different machine (a mount from the backup host, or a directory a
nightly job copies off the box). A backup on the same disk as the database does not survive the loss
of that disk.

## Restore procedure

1. Pick the backup: normally the newest file in the backup directory.
2. Test it before using it:
   ```bash
   node server/mirror/restore-test.mjs <backup-host-directory>/<backup>.sqlite
   ```
   Exit status 0 means the chain is intact and the append-only triggers are present. Do not restore
   a backup that fails this test; take the previous day's and test that.
3. Stop the server.
4. Move the current database aside; do not delete it. Move its `-wal` and `-shm` files with it.
5. Copy the tested backup into place under the database file name.
6. Start the server and check that `GET /api/v1/verify` shows `chainIntact: true`.
7. Records that devices had not yet synced are still in their local queues and are re-sent on their
   own. Records the server had confirmed after the backup was taken are in the database you moved
   aside. Before deciding anything about them, compare:
   ```bash
   node server/mirror/restore-test.mjs <backup>.sqlite --against <the database you moved aside>
   ```
   This confirms the backup is an exact prefix of the old database and prints how many rows came
   after it. Record the restore and its outcome in the quality system.

`tests/test_mirror.mjs` runs this whole cycle (backup, restore test, start a server on the restored
file, check the chain tip matches, keep writing) on every run of the suites. Run
`restore-test.mjs` on the chosen host once it is set up (see the open items in `docs/HANDOVER.md`).

## Tests

```bash
node tests/test_mirror.mjs            # on and off, outage and recovery, idempotent retry, tamper detection, backup and restore
node tools/run-suites.mjs --mirror    # every other suite again with the mirror switched on
```
