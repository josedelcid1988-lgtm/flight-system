# Traveler print fix — scope

**Problem:** When a work order closes as scrap or obsolete, the traveler still prints just "Closed" with no reason. The record already stores the disposition in the `closedAs` field, and the React OrderPage renders it as a pill, but the print template never reads it.

**Fix:** One line in the traveler template: print "Closed as Scrap" or "Closed as Obsolete" next to the status. Add a test that closes an order as Scrap and asserts the print text contains it.

**Risk:** Low — display only, no data change. The print path lives inside index.html, which GitHub's code search cannot read, so the exact template location needs a local search before the edit.

**Status:** Scope agreed. Implementation not started.
