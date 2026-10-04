#!/usr/bin/env node
// Restore test: proves a backup can be restored and that it carries an intact record chain.
//
//   node server/mirror/restore-test.mjs <backup.sqlite> [--against <live.sqlite> [--live-anchor <file>]] [--no-anchor]
//
// The backup is copied to a temporary folder and opened there (the original is never touched). The
// script walks the whole hash chain against the anchor written next to the backup (<backup>.anchor.json),
// so a backup missing rows from its end, or with a changed last row, fails. A backup taken before anchors
// existed has none: --no-anchor checks it without one and says that truncation cannot be ruled out. With --against it also
// checks that every row in the backup is identical to the same row in the live database, so the backup
// is a true prefix of what the server holds now. Exit status 0 means the restore is good; 1 means it is not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyChain, readAnchor, defaultAnchorPath } from './server.mjs';

const argv = process.argv.slice(2);
const backup = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--against' && argv[i - 1] !== '--live-anchor');
const againstAt = argv.indexOf('--against');
const against = againstAt >= 0 ? argv[againstAt + 1] : null;
const noAnchor = argv.includes('--no-anchor');
// The live database's anchor: --live-anchor, else FS_MIRROR_ANCHOR (where the server keeps it when it is held
// off the database host), else the file next to the live database.
const liveAnchorAt = argv.indexOf('--live-anchor');
const liveAnchorArg = liveAnchorAt >= 0 ? argv[liveAnchorAt + 1] : (process.env.FS_MIRROR_ANCHOR || null);
if (!backup || !fs.existsSync(backup)) { console.error('FAIL give the backup file to test: node server/restore-test.mjs <backup.sqlite> [--against <live.sqlite>]'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-restore-'));
const copy = path.join(dir, 'restored.sqlite');
fs.copyFileSync(backup, copy);
let ok = true;
try {
  const db = new DatabaseSync(copy);
  const anchorFile = defaultAnchorPath(backup), anchor = fs.existsSync(anchorFile) ? readAnchor(anchorFile) : undefined;
  if (anchor === undefined && !noAnchor) { console.error(`FAIL no anchor next to the backup (${path.basename(anchorFile)}): rows removed from its end cannot be ruled out. Use the backup's anchor, or --no-anchor for a backup taken before anchors existed.`); ok = false; }
  if (anchor === undefined && noAnchor) console.log('no anchor: checked without one (--no-anchor); rows removed from the end of this backup cannot be ruled out');
  const v = verifyChain(db, anchor === undefined ? {} : { anchor });
  const manifests = Number(db.prepare('SELECT COUNT(*) n FROM signature_manifests').get().n);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map(t => t.name);
  console.log(`restored ${path.basename(backup)}: ${v.records} records, ${manifests} signature manifests, chain ${v.ok ? 'intact' : 'BROKEN'}${v.ok ? `, tip ${v.tip}` : `: row ${v.firstBreak.id}, ${v.firstBreak.reason}`}`);
  if (!v.ok) ok = false;
  const want = ['manifests_no_delete', 'manifests_no_update', 'records_no_delete', 'records_no_update'];
  if (want.some(t => !triggers.includes(t))) { console.error(`FAIL the restored database is missing its append-only triggers: ${want.filter(t => !triggers.includes(t)).join(', ')}`); ok = false; }
  if (against) {
    const live = new DatabaseSync(against, { readOnly: true });
    // The live database must itself be intact (its manifest rows included), or matching its records proves nothing.
    const liveAnchorFile = liveAnchorArg ? path.resolve(liveAnchorArg) : defaultAnchorPath(against);
    const liveAnchor = fs.existsSync(liveAnchorFile) ? readAnchor(liveAnchorFile) : undefined;
    if (liveAnchor === undefined && !noAnchor) { console.error(`FAIL no anchor for the live database at ${liveAnchorFile}: rows removed from its end, or a changed last row, cannot be ruled out. Give it with --live-anchor <file> (or FS_MIRROR_ANCHOR), or --no-anchor to check without one.`); ok = false; }
    const lv = verifyChain(live, liveAnchor === undefined ? {} : { anchor: liveAnchor });
    if (!lv.ok) { console.error(`FAIL the live database is not intact: row ${lv.firstBreak.id}, ${lv.firstBreak.reason}`); ok = false; }
    // manifests_sha256 is part of each row's link; compare it whenever both databases have the column. A
    // backup with the column against a live database without it (or the reverse) is not a prefix.
    const hasM = d => d.prepare('PRAGMA table_info(records)').all().some(c => c.name === 'manifests_sha256');
    if (hasM(db) !== hasM(live)) { console.error('FAIL the backup and the live database differ in schema (manifests_sha256): one predates signature manifests in the chain'); ok = false; }
    const cols = 'id, client_write_id, store_key, entity_type, entity_id, operation, payload_json, payload_sha256, prev_sha256, actor, credential, client_ts, server_ts, build_version, build_sha256, client_id' + (hasM(db) && hasM(live) ? ', manifests_sha256' : '');
    const get = live.prepare(`SELECT ${cols} FROM records WHERE id = ?`);
    // Each row's signature manifests are compared too: rows written before manifests joined the chain
    // (manifests_sha256 null) are not covered by any hash, so only a direct comparison finds a change to theirs.
    const mq = 'SELECT path, meaning, signer_name, signer_credential, signed_at, algorithm, hash FROM signature_manifests WHERE record_id = ? ORDER BY id';
    const mine = db.prepare(mq), theirs = live.prepare(mq);
    let mismatch = null, manifestMismatch = null;
    for (const row of db.prepare(`SELECT ${cols} FROM records ORDER BY id`).iterate()) {
      const other = get.get(row.id);
      if (!other || JSON.stringify(other) !== JSON.stringify(row)) { mismatch = Number(row.id); break; }
      if (JSON.stringify(mine.all(row.id)) !== JSON.stringify(theirs.all(row.id))) { manifestMismatch = Number(row.id); break; }
    }
    if (manifestMismatch !== null) { console.error(`FAIL the signature manifests of row ${manifestMismatch} differ between the backup and the live database`); ok = false; }
    const liveCount = Number(live.prepare('SELECT COUNT(*) n FROM records').get().n);
    if (mismatch !== null) { console.error(`FAIL row ${mismatch} in the backup differs from the live database`); ok = false; }
    else if (manifestMismatch === null) console.log(`backup matches the first ${v.records} of ${liveCount} live records`);
    live.close();
  }
  db.close();
} catch (error) { console.error('FAIL ' + error.message); ok = false; }
fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
