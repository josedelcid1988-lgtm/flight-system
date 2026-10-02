#!/usr/bin/env node
// One-time, read-only scan of the archived work orders for an own "__proto__" key (issue #174).
//
//   node tools/scan-archive-proto.mjs                          the store the server uses (FLIGHT_DATABASE_URL, else
//                                                              FLIGHT_DB, else data/flight.sqlite)
//   node tools/scan-archive-proto.mjs --db <file.sqlite>       a SQLite database, for example a backup copy
//   node tools/scan-archive-proto.mjs --database-url <url>     a PostgreSQL database, named without its password
//                                                              (a URL with one is refused, #584: give it in
//                                                              FLIGHT_DATABASE_URL instead)
//
// Since #168 the engine refuses such a key before an order enters the archive, but rows archived earlier are served
// as stored. Content under an own "__proto__" key sits outside the record's signatures, so this lists every stored
// row that holds one, with the path, using the engine's own finder (MES.protoKeyPath) through the scan the server
// also runs at startup (server/archive-proto-scan.mjs). It opens the store read-only and changes nothing.
// Exit status: 0 no row flagged, 1 one or more rows flagged, 2 the scan could not finish.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbReadOnly } from '../server/db.mjs';
import { openPostgresReadOnly } from '../server/db-postgres.mjs';
import { createHost } from '../server/mes-host.mjs';
import { scanArchiveProto } from '../server/archive-proto-scan.mjs';
import { storeSettings } from '../server/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };

async function main() {
  const { MES } = createHost(path.join(ROOT, 'index.html'));
  const { dbPath, databaseUrl } = storeSettings(arg);
  // The connection string can carry a password, so the report names the store kind, never the string.
  const where = databaseUrl ? 'PostgreSQL (connection string not shown)' : `SQLite ${dbPath}`;
  console.log(`Archive "__proto__" key scan, read-only. Store: ${where}`);
  const store = databaseUrl ? await openPostgresReadOnly(databaseUrl) : openDbReadOnly(dbPath);
  let result;
  try { result = await scanArchiveProto(MES, store); } finally { await store.close(); }
  const { scanned, flagged, unreadable } = result;
  console.log(`Rows scanned: ${scanned}`);
  console.log(`Rows flagged: ${flagged.length}`);
  for (const f of flagged) console.log(`FLAGGED ${f.id} own "__proto__" key at ${f.at}`);
  for (const id of unreadable) console.log(`UNREADABLE ${id} the stored JSON does not parse, so this row was not checked`);
  if (flagged.length) console.log('Each path names the object that holds the key. Content under that key is outside the record\'s signatures.');
  console.log('Nothing was changed.');
  return unreadable.length ? 2 : flagged.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, error => {
  console.error(`Scan could not finish: ${error && error.message ? error.message : error}. Nothing was changed.`);
  process.exitCode = 2;
});
