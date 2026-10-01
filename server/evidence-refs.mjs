// Where a work order legitimately names a stored recording: the id or copyOf of an entry in an operation's
// evidence or quarantinedEvidence list. Evidence read authority follows these fields only, matched exactly, for
// the live workspace and for archived orders alike, in every store. A recording id that appears anywhere else
// (a note, a title, an activity line, an unrelated field) names nothing and authorizes nothing.
const list = value => Array.isArray(value) ? value : [];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function evidenceIdsInOrder(order, ids = new Set()) {
  if (!isRecord(order)) return ids;
  for (const op of list(order.operations)) {
    if (!isRecord(op)) continue;
    for (const e of [...list(op.evidence), ...list(op.quarantinedEvidence)]) {
      if (!isRecord(e)) continue;
      if (typeof e.id === 'string' && e.id) ids.add(e.id);
      if (typeof e.copyOf === 'string' && e.copyOf) ids.add(e.copyOf);
    }
  }
  return ids;
}

// Every evidence id the live workspace names.
export function evidenceIdsInWorkspace(doc) {
  const ids = new Set();
  for (const order of list(doc?.orders)) evidenceIdsInOrder(order, ids);
  return ids;
}

// Whether one archived entry ({ order, activity }) names the recording. Accepts the stored JSON text or the parsed
// entry; unreadable JSON names nothing.
export function archivedEntryNamesEvidence(entry, id) {
  if (typeof id !== 'string' || !id) return false;
  let parsed = entry;
  if (typeof entry === 'string') { try { parsed = JSON.parse(entry); } catch { return false; } }
  return isRecord(parsed) && evidenceIdsInOrder(parsed.order).has(id);
}
