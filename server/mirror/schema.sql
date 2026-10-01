-- Flight System persistence mirror. SQLite, WAL mode (set by server.mjs on open).
-- Both tables are append-only: the triggers at the end reject every UPDATE and DELETE, so a row, once
-- written, can only be read. Corrections are new rows.

-- One row per record the app committed. payload_json is the entity exactly as the app sent it
-- (passwords, PINs and their hashes are never included). prev_sha256 chains every row to the one before
-- it across the whole table: it is the SHA-256 of the previous row's fields (see linkHash in
-- server.mjs), 64 zeros for the first row. GET /api/v1/verify walks the chain and reports the first
-- row where it breaks. The row count and the link of the last row are also kept outside the database
-- (the chain anchor file), so rows removed from the end or a changed last row are found.
CREATE TABLE IF NOT EXISTS records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_write_id TEXT    NOT NULL UNIQUE,
  store_key       TEXT    NOT NULL,
  entity_type     TEXT    NOT NULL,
  entity_id       TEXT    NOT NULL,
  operation       TEXT    NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload_json    TEXT    NOT NULL,
  payload_sha256  TEXT    NOT NULL CHECK (length(payload_sha256) = 64),
  prev_sha256     TEXT    NOT NULL CHECK (length(prev_sha256) = 64),
  actor           TEXT,
  credential      TEXT,
  client_ts       TEXT    NOT NULL,
  server_ts       TEXT    NOT NULL,
  build_version   TEXT    NOT NULL,
  build_sha256    TEXT    NOT NULL,
  client_id       TEXT    NOT NULL,
  -- SHA-256 of this record's signature manifests (manifestSetHash in server.mjs). It is part of the row's
  -- link, so a manifest changed, added or removed breaks the chain. Null on rows written before it existed.
  manifests_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS records_entity ON records (entity_type, entity_id);

-- Every SHA-256 signature manifest found in a record's payload, one row each, so an auditor can list
-- who signed what without parsing payloads. path is where the manifest sits inside the payload.
CREATE TABLE IF NOT EXISTS signature_manifests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id         INTEGER NOT NULL REFERENCES records (id),
  path              TEXT    NOT NULL,
  meaning           TEXT    NOT NULL,
  signer_name       TEXT    NOT NULL,
  signer_credential TEXT    NOT NULL,
  signed_at         TEXT    NOT NULL,
  algorithm         TEXT    NOT NULL,
  hash              TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS manifests_record ON signature_manifests (record_id);

CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
BEGIN SELECT RAISE(ABORT, 'records are append-only: UPDATE is not allowed'); END;
CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
BEGIN SELECT RAISE(ABORT, 'records are append-only: DELETE is not allowed'); END;
CREATE TRIGGER IF NOT EXISTS manifests_no_update BEFORE UPDATE ON signature_manifests
BEGIN SELECT RAISE(ABORT, 'signature_manifests are append-only: UPDATE is not allowed'); END;
CREATE TRIGGER IF NOT EXISTS manifests_no_delete BEFORE DELETE ON signature_manifests
BEGIN SELECT RAISE(ABORT, 'signature_manifests are append-only: DELETE is not allowed'); END;
