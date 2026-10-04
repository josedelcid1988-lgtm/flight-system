# PostgreSQL backup, wipe, and restore verification

Date: 28 September 2026 (PDT). Reviewer environment: Grok scratch branch `grok/verify-postgres`, based on `main` at `c623ba870315e885fe4954eed2169958d0c864ea`.

This note records the exact commands that were run against the live PostgreSQL target and what they returned. Per the verification instruction, the cycle stopped when the live target could not be reached. No substitute database was stood up, and no restore procedure was improvised.

## Intended cycle (from `docs/DATABASES.md` and `server/README.md`)

```bash
# Export the URL once, so the backup and the restore both see it. A one-command prefix
# (FLIGHT_DATABASE_URL=... node ...) sets it for the backup only, and the restore would then
# be refused after the wipe, leaving the database empty.
export FLIGHT_DATABASE_URL='<live-url>'

# The server and its commands read FLIGHT_DATABASE_URL themselves. Do not pass it again on the
# command line: a command line is readable from the process list, so a --database-url that
# carries a password is refused and nothing runs (#584). This covers the server's own process
# only: until #234 lands, pg_dump and pg_restore still receive the connection string, password
# included, as their --dbname argument while they run.

# 1. Stop the MES server that uses that database, so no write lands between the backup and the
#    baseline below. Then take the backup and record the baseline (step 4 of the next section).
node server/server.mjs --backup data/flight-backup.dump

# 2. Wipe and restore. Wipe is a DROP/CREATE of the target database, or
#    restorePostgres(..., { clean: true }). The restore runs as one transaction, so a failed restore
#    leaves the target unchanged, and it ends every session that was in the backup.
node server/server.mjs --restore data/flight-backup.dump

# 3. Re-open and verify the content of every table plus the audit chain (next section).
# openPostgres() refuses to start if the restored audit chain does not verify.
```

The repository already covers the same sequence against a scratch database in `tests/postgres/backup_restore.mjs` (`npm run test:postgres` in CI on PostgreSQL 16). That suite is not a substitute for a live-target cycle.

## Commands actually run

Working directory for the checks was the verification host, not a cloned tree. GitHub access was used only to read `main` and to write this file. Open PR branches `#15`, `#19`, `#20`, `#22`, `#23` and `main` were not modified.

### 1. Look for the live connection string and client tools

```bash
python3 -c 'import os; print("FLIGHT_DATABASE_URL" in os.environ); print([k for k in os.environ if "FLIGHT" in k or "POSTGRES" in k or "PG" in k])'
command -v psql pg_dump pg_restore docker podman
```

Result:

```text
False
[]
```

`command -v` printed nothing. `FLIGHT_DATABASE_URL` is unset. `psql`, `pg_dump`, `pg_restore`, `docker`, and `podman` are not installed on the verification host. No Flight or PostgreSQL secret is present in the process environment.

### 2. Probe the documented and local listen addresses

```bash
python3 - <<'PY'
import socket
for host, port in (('127.0.0.1', 5432), ('db.internal', 5432)):
    s = socket.socket(); s.settimeout(2)
    try:
        s.connect((host, port)); print(host, port, 'open')
    except Exception as e:
        print(host, port, type(e).__name__, e)
    finally:
        s.close()
PY
```

Result:

```text
127.0.0.1 5432 ConnectionRefusedError [Errno 111] Connection refused
db.internal 5432 gaierror [Errno -2] Name or service not known
```

`db.internal` is the host used only as an example in `docs/DATABASES.md`. It does not resolve here. Nothing is listening on local `5432`.

### 3. Attempt the documented backup command without a live URL

```bash
node server/server.mjs --backup data/flight-backup.dump
```

This command was not executed against a live PostgreSQL database. There is no `FLIGHT_DATABASE_URL` to select the PostgreSQL store, and `pg_dump` is not installed. Running it here would have selected the default SQLite file (`data/flight.sqlite`) instead of the live PostgreSQL target. That is a different product path and was not used.

## Outcome

| Step | Result |
| --- | --- |
| Identify live `FLIGHT_DATABASE_URL` | Failed. Variable unset; no secret store, Vercel/Netlify Flight project, or on-host service provided a connection string. |
| `pg_dump` / `pg_restore` available | Failed. PostgreSQL client tools are not installed. |
| Reach a PostgreSQL listener | Failed. `127.0.0.1:5432` refused; `db.internal` does not resolve. |
| Backup | Not run. |
| Wipe | Not run. |
| Restore | Not run. |
| Compare pre-wipe vs post-restore counts and audit-chain head | Not run. |

**Stopped.** No wipe or restore was attempted. No local PostgreSQL was installed to stand in for the live target.

## What is required to finish the cycle

1. The live connection string in `FLIGHT_DATABASE_URL` (a `--database-url` that carries a password is refused; see #584), with network reachability from the host that will run `pg_dump` / `pg_restore`.
2. PostgreSQL client tools on that host (`pg_dump`, `pg_restore`, and a `psql` that can count rows).
3. An agreed maintenance window. Restore is offline: stop the MES server first, or restore into an empty database and point the server at it afterwards (`server/README.md`).
4. A pre-wipe baseline to compare after the restore, taken with the server stopped (step 1 above). A row
   count alone is not enough: a restored row whose content differs keeps the same count, and
   `verifyAudit()` hashes only the `audit` table. So record a SHA-256 content digest of every persisted
   table, and recompute the stored SHA-256 of every evidence item and archived order. The digest hashes
   one row at a time, so its memory use stays bounded however large the evidence recordings are:

```sql
-- Count and content digest of every persisted table. Each row is hashed on its own with SHA-256 (as canonical
-- jsonb; an evidence recording's bytes are hashed separately, so no recording is ever concatenated with another),
-- then the sorted row hashes are hashed again. Every row must match after the restore, except sessions: the
-- restore never brings session rows back, so sessions must read 0 rows afterwards.
SELECT 'documents' AS rel, COUNT(*) AS n, encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') AS digest FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM documents t) r
UNION ALL SELECT 'accounts', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM accounts t) r
UNION ALL SELECT 'sessions', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM sessions t) r
UNION ALL SELECT 'lockouts', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM lockouts t) r
UNION ALL SELECT 'audit', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM audit t) r
UNION ALL SELECT 'evidence', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to(((to_jsonb(t) - 'bytes') || jsonb_build_object('bytes_sha256', encode(sha256(t.bytes), 'hex')))::text, 'UTF8')), 'hex') AS h FROM evidence t) r
UNION ALL SELECT 'archive', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM archive t) r
UNION ALL SELECT 'record_extracts', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM record_extracts t) r
UNION ALL SELECT 'record_export_settings', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM record_export_settings t) r
UNION ALL SELECT 'record_export_jobs', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM record_export_jobs t) r
UNION ALL SELECT 'record_export_log', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM record_export_log t) r
UNION ALL SELECT 'jira_issue_requests', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM jira_issue_requests t) r
UNION ALL SELECT 'skill_runs', COUNT(*), encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') FROM (SELECT encode(sha256(convert_to((to_jsonb(t))::text, 'UTF8')), 'hex') AS h FROM skill_runs t) r;

-- Stored hashes recomputed from the stored content. Both queries must return no rows, before and after.
SELECT id FROM evidence WHERE encode(sha256(bytes), 'hex') <> sha256;
SELECT order_id FROM archive WHERE encode(sha256(convert_to(json, 'UTF8')), 'hex') <> sha256;
```

   If `server/db-postgres.mjs` gains a table, add it to the digest query.

Plus `store.verifyAudit()` after `openPostgres()`, which must report `ok: true` with the same `checked` and `head` as before the wipe.

CI already runs the scratch-database version of this cycle:

```yaml
FLIGHT_DATABASE_URL: postgresql://flight:flight_test_password@localhost:5432/flight_system
npm run test:postgres
```

in `.github/workflows/ci.yml` on PostgreSQL 16. That is evidence the code path exists. It is not evidence the live target was backed up, wiped, and restored.
