// The archive "__proto__" key scan (issue #174), shared by tools/scan-archive-proto.mjs and the server's startup
// check. It reads every archive row from a read-only store (openDbReadOnly or openPostgresReadOnly) and uses the
// engine's own finder (MES.protoKeyPath). It never writes. Every YIELD_EVERY rows it lets the event loop run, because
// the SQLite reader yields rows synchronously and a running server must keep answering requests during the scan.
const YIELD_EVERY = 100;
export async function scanArchiveProto(MES, store) {
  let scanned = 0;
  const flagged = [], unreadable = [];
  for await (const row of store.archiveRows()) {
    scanned += 1;
    if (scanned % YIELD_EVERY === 0) await new Promise(resolve => setImmediate(resolve));
    let entry;
    try { entry = JSON.parse(row.json); } catch { unreadable.push(row.id); continue; }
    const at = MES.protoKeyPath(entry, row.id);
    if (at) flagged.push({ id: row.id, at });
  }
  return { scanned, flagged, unreadable };
}
