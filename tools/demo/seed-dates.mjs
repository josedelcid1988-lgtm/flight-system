// Moves the operational dates of a demo seed forward by the gap between the day the seed was captured
// and the day the page first loads it, so the demo does not age. tools/build-demo.mjs inlines the source
// of rebaseDemoSeed into the demo page (deviation "Seed operational dates follow the first-load day"), and
// the tests import the same function, so the page and the tests cannot disagree.
//
// Moved (forward-looking dates of open work and of credentials):
//   orders that are not Closed:                start, due
//   conformity packages with no 8130-9 yet:    mdlReceived (a completed 8130-9 locks the package data)
//   planned orders that are Planned or Firm:   needDate
//   work-order requests that are Open:         needBy
//   CARs that are not Closed or Cancelled:     dueDate, and dueDate of every action not yet completed
//   stamps:                                    expires, qualifications[].expires
// Never moved: anything signed or recorded as having happened (buy-offs, manifests, signatures, history,
// every at / recordedAt field, tool and test-asset calibration dates captured in a buy-off, FAIR and DAR
// dates, stamp issue dates, closed and stocked orders). Moving those would break MES.verifyManifests and
// misstate when things were signed.
//
// The capture day is the day of the latest activity entry in the seed. A clock earlier than the capture
// day moves nothing. The function is self-contained (no imports, no outer names) because its source text
// is inlined into the page.
export function rebaseDemoSeed(seed, today) {
  var DAY = 86400000, DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!seed || typeof seed !== 'object' || !Array.isArray(seed.activity)) return seed;
  var captured = seed.activity.reduce(function (max, a) { var at = a && typeof a.at === 'string' ? a.at.slice(0, 10) : ''; return DATE.test(at) && at > max ? at : max; }, '');
  var now = typeof today === 'string' && DATE.test(today) ? today : new Date().toISOString().slice(0, 10);
  if (!captured) return seed;
  var days = Math.round((Date.parse(now) - Date.parse(captured)) / DAY);
  if (!(days > 0)) return seed;
  var out = JSON.parse(JSON.stringify(seed));
  var shift = function (value) { return typeof value === 'string' && DATE.test(value) ? new Date(Date.parse(value) + days * DAY).toISOString().slice(0, 10) : value; };
  var move = function (item, key) { if (item && Object.prototype.hasOwnProperty.call(item, key)) item[key] = shift(item[key]); };
  var each = function (list, fn) { if (Array.isArray(list)) list.forEach(fn); };
  each(out.orders, function (order) {
    if (!order || order.status === 'Closed') return;
    move(order, 'start'); move(order, 'due');
    each(order.conformity, function (p) { if (p && p.form == null && p.status !== 'Closed') move(p, 'mdlReceived'); });
  });
  each(out.plannedOrders, function (po) { if (po && (po.status === 'Planned' || po.status === 'Firm')) move(po, 'needDate'); });
  each(out.woRequests, function (r) { if (r && r.status === 'Open') move(r, 'needBy'); });
  each(out.maneuver && out.maneuver.cars, function (car) {
    if (!car || car.status === 'Closed' || car.status === 'Cancelled') return;
    move(car, 'dueDate');
    each(car.actions, function (a) { if (a && !a.completedAt) move(a, 'dueDate'); });
  });
  each(out.stamps, function (stamp) {
    if (!stamp) return;
    move(stamp, 'expires');
    each(stamp.qualifications, function (q) { move(q, 'expires'); });
  });
  return out;
}
