# Flight System persistence mirror

A small Node server that keeps a durable, tamper-evident copy of everything the app commits. It is a
mirror, not a replacement: the app keeps working from the browser's `localStorage`, validates and
rolls back exactly as before, and never waits on this server. With the mirror switched off (the
shipped default) the app is unchanged.

- One process, one SQLite file in WAL mode, Node built-ins only (`node:sqlite`, `node:http`). No
  `npm install`.
- Append-only: SQLite triggers reject every `UPDATE` and `DELETE` on both tables (`schema.sql`).
- Hash chain: every row stores the SHA-256 link of the row before it (`prev_sha256`), and each row's
  link covers its signature manifests (`manifests_sha256`), so an edit to a stored row or manifest,
  or a missing row, is found by `GET /api/v1/verify`.
- Chain anchor: the row count and the link of the last row are kept outside the database (the
  anchor file), so rows removed from the end, or a changed last row, are found too. The server
  refuses to start, refuses every write (409 `anchor_mismatch`) and refuses every backup while the
  database does not match its anchor, so the anchor is never overwritten to cover a change. Before
  the first write, and before any write after another process changed the database file, the
  server walks the whole chain and every manifest, so a changed earlier row or manifest is refused
  the same way.
- Two tokens: the page carries an append-only write token; reading, verifying and exporting need
  the operator token, which never goes into the page.
- Loopback only in plain HTTP: to serve other machines it runs behind a TLS-terminating reverse proxy.
- Never receives a password, a stamp PIN or their hashes and salts. Accounts arrive as name, role
  and Support Access only.
- Not an authority on who did what. The write token is shared by every browser, and the actor and
  credential on each record are what the browser reports, checked for format only. The signature
  manifests inside a record are the app's own evidence; the mirror proves only that a record arrived
  and has not changed since. Keep the anchor (`FS_MIRROR_ANCHOR`) on storage the database host cannot
  rewrite: next to the database it catches mistakes, not someone who can edit both files.

Requires Node 22.13 or later (for `node:sqlite` without a flag).

## Run it

```bash
FS_MIRROR_TOKEN='<long random operator value>' FS_MIRROR_WRITE_TOKEN='<a different long random value>' \
FS_MIRROR_ALLOW_ORIGIN='https://mes.internal' node server/mirror/server.mjs
```

**Upgrading an existing mirror:** the old `FS_MIRROR_TOKEN` was the value in `SK_MIRROR.token`, so
every browser that loaded the app has seen it. Generate a **new** operator token for
`FS_MIRROR_TOKEN`; do not keep the old value as the operator token. The old value may become the
write token only if you accept that it stays readable in the page, which is all a write token is.
Then run `--reanchor` once (see Settings).

The mirror refuses to start without both tokens, if they are equal, or if either is shorter than 16
characters. The **write token** goes into the page and can only append records (`POST /api/v1/writes`):
anyone who can open the page can read it, so it gives no read access. The **operator token** reads,
verifies and exports, and stays with the operator. Health without the operator token answers only
that the mirror is up. With no allowed origin the mirror sends no CORS header, so a browser page can
reach it only when `FS_MIRROR_ALLOW_ORIGIN` names the address the app is served from.

The mirror speaks plain HTTP and listens on `127.0.0.1`. It refuses any other address unless
`FS_MIRROR_BEHIND_TLS_PROXY=1` states that a TLS-terminating reverse proxy is in front of it. Run the
proxy on the same host (it listens on https and forwards to `127.0.0.1:8787`) so records and tokens
never cross the network unencrypted. `--insecure-no-token` is allowed only on loopback.

Then point the app at the proxy's https address. In `index.html`, in the `sk-mirror` block, set:

```js
window.SK_MIRROR = { url: 'https://mes-mirror.internal', token: '<the write token>', batchSize: 50 };
```

The app refuses an `http://` address unless it is this machine (`localhost` or `127.0.0.1`): the
mirror stays off and the reason is in `skMirror.refused`.

Leave `url` empty to switch the mirror off. The header then shows nothing and the app makes no
network calls.

The demo build (`demo.html`) never uses this setting: whatever `SK_MIRROR` the production file or a
page sets, the demo's mirror stays off and it sends nothing (deviation "Never the production mirror" in
`docs/DEMO_DEVIATIONS.md`). Only `tools/run-suites.mjs --mirror` gives it a throwaway test server.

## Settings

Command line flags win over environment variables, which win over the defaults.

| Flag | Environment | Default | What it does |
| --- | --- | --- | --- |
| `--host` | `FS_MIRROR_HOST` | `127.0.0.1` | Address to listen on. Anything other than loopback is refused unless `--behind-tls-proxy` is set. |
| `--behind-tls-proxy` | `FS_MIRROR_BEHIND_TLS_PROXY=1` | off | States that a TLS-terminating reverse proxy is in front, so a non-loopback `--host` is allowed. |
| `--port` | `FS_MIRROR_PORT` | `8787` | Port. |
| `--db` | `FS_MIRROR_DB` | `server/mirror/data/mirror.sqlite` | The database file. |
| `--backup-dir` | `FS_MIRROR_BACKUP_DIR` | `server/mirror/backups` | Where backups go. Point it at storage on a different machine. |
| `--backup-every-minutes` | `FS_MIRROR_BACKUP_EVERY_MINUTES` | `1440` | How often to take a backup; `0` switches the schedule off. |
| `--backup-keep-days` | `FS_MIRROR_BACKUP_KEEP_DAYS` | `30` | Daily copies kept (the newest copy of each day). |
| `--token` | `FS_MIRROR_TOKEN` | none: required | The operator token: verify, export, records read-back and health details need `Authorization: Bearer <token>`. Never put it in the page. |
| `--write-token` | `FS_MIRROR_WRITE_TOKEN` | none: required | The append-only token the page carries in `SK_MIRROR.token`. It can post writes and nothing else. Must differ from the operator token. |
| `--insecure-no-token` | `FS_MIRROR_INSECURE_NO_TOKEN=1` | off | Runs the mirror with no token. Loopback only, for a machine nobody else can reach. |
| `--anchor` | `FS_MIRROR_ANCHOR` | `<db>.anchor.json` | The chain anchor file (row count and chain tip). Put it on storage the database host cannot rewrite, for example a mount from another machine. |
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
`workspace-settings`, `account`, and `snapshot` (sent after a restore: every entity key the device holds).

## API (JSON, versioned)

Every endpoint except `POST /api/v1/writes` and health needs the operator token.

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/writes` | Write token (or operator token). Body `{ clientId, lastAck, records: [...] }`, up to 500 records. `lastAck` is the newest row the server confirmed to this client; the answer carries `ackCheck: 'missing'` when the server no longer holds it (it was restored from an older backup), and the app then sends every record again. A post with `records: []` and a `lastAck` is a probe: it stores nothing and is answered with `ackCheck` only, so a device with nothing queued (it probes on load, when it comes back online, when its tab is shown again and every five minutes) still finds out about a restore. Each record comes back `stored`, `duplicate` (the same `clientWriteId` and payload already stored: a safe retry) or `rejected` with a reason (bad hash, malformed manifest, a `clientWriteId` reused for a different payload). |
| `GET /api/v1/health` | With the token: row and manifest counts, the last write time, the backup settings and the last backup file. Without it: `{ ok, api }` only. |
| `GET /api/v1/verify` | Walks the whole chain and compares its count and tip with the anchor: `chainIntact`, the row count, the chain tip, the anchor, and `firstBreak: { id, reason }` when it is broken. `legacyRows` counts rows written before manifests joined the chain (their manifests are not covered by the link). Such rows are accepted only at the start of the chain, up to the row id recorded once when the database gained the column (`mirror_meta.legacy_through`, which cannot be changed); a row without `manifests_sha256` anywhere else breaks the chain. |
| `GET /api/v1/export?format=json` | Full retention export: every record with its manifests, the chain anchor (`anchor`) and a verify result against it. |
| `GET /api/v1/export?format=csv` | The same records as CSV, one row per record. The last row also carries the anchor (`chain_anchor_records`, `chain_anchor_tip`), so a file missing rows from its end, or with a changed last row, shows it. |
| `GET /api/v1/records?entity=order&id=WO-10001` | Every record for one entity, oldest first, with its manifests. For audits. |

## Backups

The server takes an online backup on its schedule with SQLite `VACUUM INTO`, which produces a
consistent copy while the server keeps accepting writes, and writes the copy's own anchor next to it
(`<backup>.sqlite.anchor.json`). The database is checked against its trusted anchor before the copy and the
copy is checked against the same anchor after it, so a change made by another process in between is never
backed up; the copy's anchor is taken from the copy itself. Keep the two together. After each backup it keeps the newest copy
of each day for `backup-keep-days` days and deletes the rest. Take one on demand with:

```bash
node server/mirror/server.mjs --backup-now --db <database-file> --backup-dir <backup-host-directory>
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
   Exit status 0 means the chain is intact against the backup's anchor and the append-only triggers
   are present. Do not restore a backup that fails this test; take the previous day's and test that.
   A backup taken before anchors existed has none: `--no-anchor` checks it, and says that rows
   removed from its end cannot be ruled out.
3. Stop the server.
4. Move the current database aside; do not delete it. Move its `-wal` and `-shm` files with it.
5. Copy the tested backup into place under the database file name, and its `.anchor.json` into
   place as the anchor (`FS_MIRROR_ANCHOR`, or `<database file>.anchor.json`). The server refuses to
   start on an existing database with no anchor, even one with no rows (only a database file the server
   creates itself gets a fresh anchor); for a database written before anchors existed,
   run `node server/mirror/server.mjs --reanchor --db <database-file>` once, which checks the chain
   first.
6. Start the server and check that `GET /api/v1/verify` shows `chainIntact: true`.
7. Records that devices had not yet synced are still in their local queues and are re-sent on their
   own. Records the server had confirmed after the backup was taken are re-sent too: on its next post
   (or its next probe, within five minutes even when nothing is queued) each device names the newest row it was told was stored, the restored server answers that it no
   longer has it, and the device queues every entity it holds again, a delete for every entity it
   deleted, and one `snapshot` record listing every entity key it holds. The device builds these from
   the workspace saved in the browser, not from one tab's memory, so a tab that has not yet heard of
   another tab's change never leaves that change out; when the saved workspace fails validation it
   sends no snapshot. Anything from that device
   absent from its latest snapshot is deleted, including deletions made before this build. Intermediate versions written
   between the backup and the restore are only in the database you moved aside. Before deciding anything about them, compare:
   ```bash
   node server/mirror/restore-test.mjs <backup>.sqlite --against <the database you moved aside> \
     --live-anchor <its anchor file>
   ```
   This confirms the old database is intact against its own anchor, that the backup is an exact
   prefix of it, and prints how many rows came after it. Give the anchor with `--live-anchor`, or set
   `FS_MIRROR_ANCHOR` as the server had it; without either the anchor next to the database is used,
   and a missing anchor fails the check. Record the restore and its outcome in the quality system.

`tests/test_mirror.mjs` runs this whole cycle (backup, restore test, start a server on the restored
file, check the chain tip matches, keep writing) on every run of the suites. Run
`restore-test.mjs` on the chosen host once it is set up (see the open items in `docs/HANDOVER.md`).

## Tests

```bash
node tests/test_mirror.mjs            # on and off, outage and recovery, idempotent retry, tamper detection, backup and restore
node tools/run-suites.mjs --mirror    # every other suite again with the mirror switched on
```
