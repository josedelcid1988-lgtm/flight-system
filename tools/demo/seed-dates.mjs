// Moves the operational dates of a demo seed forward by the gap between the day the seed was captured
// and the day the page first loads it, so the seed's dates do not age. tools/build-demo.mjs inlines the
// source of rebaseDemoSeed into the demo page (deviation "Seed operational dates follow the first-load
// day"), and the tests import the same function, so the page and the tests cannot disagree.
//
// Moved (forward-looking dates of open work and of credentials):
//   orders that are not Closed:                start, due
//   conformity packages with no 8130-9 yet:    mdlReceived (a completed 8130-9 locks the package data)
//   planned orders that are Planned or Firm:   needDate
//   work-order requests that are Open:         needBy
//   CARs that are not Closed or Cancelled:     dueDate, and dueDate of every action not yet completed
//   stamps:                                    expires, qualifications[].expires
// A history entry, by "Demo build", naming the old and new dates is appended where the record would
// otherwise disagree with its own history or hide a change production records:
//   CARs: their history quotes the due dates they were raised and actioned with.
//   orders whose conformity package MDL date moves: production records an MDL copy refresh on the
//   order. A moved MDL date is the same change production makes when someone refreshes the MDL copy of
//   the same revision: saveConformity clears steps 1.3 and 1.4 only when the MDL revision or the PDM
//   path changes, not the receipt date.
// Order plan dates, planned need dates, request need-by dates and stamp expiries appear in no history
// text, so they move without an entry.
// Never moved: anything signed or recorded as having happened (buy-offs, manifests, signatures, existing
// history, every at / recordedAt field, tool and test-asset calibration dates captured in a buy-off, FAIR
// and DAR dates, stamp issue dates, closed and stocked orders). Moving those would break
// MES.verifyManifests and misstate when things were signed.
//
// `now` is the first-load moment as an ISO timestamp (default: the current time). The capture day is the
// day of the latest activity entry in the seed. A clock on or before the capture day changes nothing.
// The function is self-contained (no imports, no outer names) because its source text is inlined into
// the page.
export function rebaseDemoSeed(seed, now) {
  var DAY = 86400000, DATE = /^\d{4}-\d{2}-\d{2}$/, ACTOR = 'Demo build · DEMO-BUILD';
  if (!seed || typeof seed !== 'object' || !Array.isArray(seed.activity)) return seed;
  var at = typeof now === 'string' && Number.isFinite(Date.parse(now)) ? new Date(Date.parse(now)).toISOString() : new Date().toISOString();
  var today = at.slice(0, 10);
  var captured = seed.activity.reduce(function (max, a) { var d = a && typeof a.at === 'string' ? a.at.slice(0, 10) : ''; return DATE.test(d) && d > max ? d : max; }, '');
  if (!captured) return seed;
  var days = Math.round((Date.parse(today) - Date.parse(captured)) / DAY);
  if (!(days > 0)) return seed;
  var out = JSON.parse(JSON.stringify(seed));
  var why = 'Demo copy: dates moved forward ' + days + ' day' + (days === 1 ? '' : 's') + ' because this demo was first opened on ' + today + ' and its sample data was captured on ' + captured + '.';
  var shift = function (value) { return new Date(Date.parse(value) + days * DAY).toISOString().slice(0, 10); };
  // Moves item[key] when it is a calendar date; returns "label old to new" for the history entry.
  var move = function (item, key, label) {
    if (!item || !Object.prototype.hasOwnProperty.call(item, key) || typeof item[key] !== 'string' || !DATE.test(item[key])) return null;
    var from = item[key]; item[key] = shift(from);
    return label + ' ' + from + ' to ' + item[key];
  };
  var each = function (list, fn) { if (Array.isArray(list)) list.forEach(fn); };
  var note = function (changes) { return why + ' ' + changes.join('; ') + '.'; };
  var moved = function (list) { return list.filter(Boolean); };
  each(out.orders, function (order) {
    if (!order || order.status === 'Closed') return;
    var changes = moved([move(order, 'start', 'Planned start'), move(order, 'due', 'due')]), mdl = [];
    each(order.conformity, function (p) { if (p && p.form == null && p.status !== 'Closed') mdl = mdl.concat(moved([move(p, 'mdlReceived', 'conformity package ' + p.serial + ' MDL copy received')])); });
    if (mdl.length && Array.isArray(order.history)) order.history.push({ id: order.id + '-demo-dates', at: at, action: note(changes.concat(mdl)), actor: ACTOR });
  });
  each(out.plannedOrders, function (po) {
    if (!po || (po.status !== 'Planned' && po.status !== 'Firm')) return;
    move(po, 'needDate', 'Need date');
  });
  each(out.woRequests, function (r) { if (r && r.status === 'Open') move(r, 'needBy', 'Need by'); });
  each(out.maneuver && out.maneuver.cars, function (car) {
    if (!car || car.status === 'Closed' || car.status === 'Cancelled') return;
    var changes = moved([move(car, 'dueDate', 'Due date')]);
    each(car.actions, function (a) { if (a && !a.completedAt) changes = changes.concat(moved([move(a, 'dueDate', (a.id || 'action') + ' due')])); });
    if (changes.length && Array.isArray(car.history)) car.history.push({ at: at, action: note(changes), actor: ACTOR });
  });
  each(out.stamps, function (stamp) {
    if (!stamp) return;
    move(stamp, 'expires', 'Expiry');
    each(stamp.qualifications, function (q) { move(q, 'expires', 'Qualification expiry'); });
  });
  return out;
}
