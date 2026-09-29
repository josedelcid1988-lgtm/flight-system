## 2026-09-29 20:26Z: Jinx Final approval posted (head 8d3405d4, CI suites SUCCESS)

**Do-not-merge checklist: CLEARED.** CI `suites` completed SUCCESS on the exact head 8d3405d4 (2026-09-29T20:23:19Z). The carriedFrom split-regression fix was verified against this exact head (review 5357702860); security pass clean; waste pass clean; no new reviews/comments since. Jinx Final approval posted as review 5357979193 (COMMENT; +1 reaction set). Jinx's gate condition is met: clean review + green CI on the exact head. Claudia may merge this PR through the PR button on 8d3405d4. Do not merge a different head without a new Jinx approval.

Open follow-ups live on as issues, not on this branch: #118 (cite check expiry/supersession), #120 (Retired without dates), plus the rest of the calibration-log P2/P3 set per the owner's Option 1 ordering.

---

## 2026-09-29 20:02Z: cross-review update (head still 8d3405d4, no new commits; CI suites still in_progress; Final approval still WITHHELD)

### Codex P2 4137748116 CONFIRMED correct, non-blocking, filed as #120
`calibrationFieldError` (index.html:2600-2602) requires `calibratedAt` and `expires` as YYYY-MM-DD for every entry, and `calibrationEntryValid` (index.html:2546) requires both dates plus `expires > calibratedAt`, with no status exemption. So a shipped asset like SR0077 with status `Initial Cal Pending` and no dates cannot get a truthful `Retired` entry: QA must invent dates or leave the asset without a retirement record. `updateCalibration` shares the same validator, so correcting an entry to Retired hits the same wall. Not a regression: this PR adds the first retirement path, so it is a feature limit; P2 is fair, non-blocking. Claude confirmed it against 8d3405d (inline reply 4137762057) and filed it as issue #120 with fix direction "allow blank dates on Retired entries only, plus a test proving blank dates are still refused on In Calibration". Jinx agrees with that direction. Not for this branch; no action on the PR.

### Tracking gap RESOLVED: #118 reopened
The stale "tracked in #119" claim is corrected (Claude inline reply 4137762351). #118 is reopened as the tracking issue for Codex 4134256748/4137333748 (P2: the cite check does not test expiry or supersession on the buy-off day). #119 stays closed as duplicate. Jinx ruling: keep #118 open as the tracker; it stays with the Option 1 calibration-log P2 set for the branch fix set (Claude's relay asked whether to reopen #119 or accept it out of scope; neither, #118 as reopened is the right tracker and it is in scope for the branch).

### Relay 5897698660 (Claude, ~20:02Z)
No new commits; head still 8d3405d4; CI suites still running. Claude will wait for Jinx's final approval before merging the exact SHA. No action needed from Claude beyond CI.

---

## 2026-09-29 19:55Z: split-regression fix verified on head 8d3405d4 (Jinx review 5357702860); Final approval still WITHHELD pending green CI

Claude pushed 8d3405d4 (one commit: "fix: splits keep carried buy-offs and tickets verifiable"), implementing Jinx ruling A for the Codex 4137333755 P1. Jinx re-reviewed the full delta against the exact head. No blockers found.

### Verified against the code (all CONFIRMED)
1. carriedFrom provenance (index.html:6876-6884, splitRequestOrder): each carried buy-off with a manifest records { orderId: order.id, evidenceIds: originals } BEFORE the evidence re-keying loop below, so the recorded ids are exactly what the signature was computed over. Moved resolved tickets get { orderId } at 6886. The !plain(carriedFrom) guards keep the first split's values on a split-of-split.
2. verifyManifests recheck (index.html:2890, 2893): the carried subject override replaces ONLY orderId and evidenceIds. operationId, title, note, stepChecks, stamp, override, tools, testAssets are recomputed from the current record, so any post-split edit still fails verification. The override applies only when order.splitFrom is set; split children get splitFrom: order.id at 6863, so carriedFrom cannot excuse an edit on a non-split order.
3. Server gate: server.mjs:245 validState runs verifyManifests on every server write, confirming this was the exact rollback path the P1 described.
4. Tests: the test_calibration.mjs additions (now 167 checks) cover the end-to-end split of a signed buy-off (verifyManifests plus server.validState), the moved signed ticket, a post-split edit still failing, and carriedFrom on a non-split order not excusing an edit. The each-half-fails and local 76/76 suite claims are Claude's process claims, not independently executed by Jinx; noted honestly in the review.

### Security pass on this commit
carriedFrom sits outside the signed subject. A forged carriedFrom only changes which historical subject the recheck compares against; every other subject field is recomputed from the current record, so forging it cannot excuse an edit. Manifests are unkeyed SHA-256 (authenticated: false): the manifest system is tamper-evident against corruption and casual edits, not against a forger who recomputes hashes. carriedFrom adds no new forgery capability beyond that. Waste pass clean; demo.html and the five fixture files carry the same generated patch.

### Do-not-merge checklist (head 8d3405d4)
- [x] Split-regression fix (carriedFrom provenance + verifyManifests original-subject recheck + end-to-end split test) on this branch, verified by Jinx
- [ ] CI (suites) green on the exact head 8d3405d4 (in_progress at review time)
- [ ] Jinx Final approval after green CI
- [ ] Claudia merges through the PR button after both are done

### Tracking gap (not blocking, needs owner call)
Codex 4134256748 (calibrationReferenceProblem does not check expiry/status/location; Jinx downgraded to P2) has NO open tracking issue: #118 and #119 are both closed as duplicates, and it is not in the PR body Closes list. Claude inline reply 4137675742 says it is "tracked in #119", which is stale. Owner call needed: reopen #119, file a fresh issue, or accept it out of scope.

---

# JINX-REVIEW.md (PR #35, head 8d3405d4, updated 2026-09-29T19:55Z; blocker fix verified, CI suites still in_progress, Final approval still WITHHELD)

## 2026-09-29 19:16Z: Final approval WITHDRAWN, new P1 blocker (Jinx review 5357324836)

Codex review 5357214051 landed 75 seconds after the Final approval, with two new P1s. Jinx evaluated both against the exact head 606ca713. One blocks; one is a P2 issue.

### BLOCKER: server-mode splits of work orders with completed operations are rolled back (Codex 4137333755) - CONFIRMED P1

This PR introduces the regression. `validState` (server/server.mjs:245) now runs `verifyManifests` on every server write; the PR diff shows the old line had no such call, so main does not gate writes this way.

`splitRequestOrder` (index.html:6843) deep-clones the parent order into a child with a new id (`${base}-Split-${seq}`, index.html:6857-6860), carrying completed operations with their buy-offs intact, including `op.buyoff.manifest`, which still hashes the parent's subject. The carried buy-off's evidenceIds are re-keyed to fresh ids (index.html:6869-6873) while the manifest was computed over the original ids. `verifyManifests` (index.html:2857) recomputes every buy-off as `buyoffSubject(child order, op, note)` (index.html:2849; the subject includes `orderId` and `evidenceIds`) and fails on hash mismatch (index.html:2884). No `carriedFrom` provenance exists (zero hits in the tree).

So in server mode the ordinary "split some units out after early operations are bought off" flow reports engine success, then the server rejects the write with "A signed record failed verification". This is a user-visible defect in a real workflow, introduced by this PR. It blocks the merge.

**Jinx ruling (option A): fix on this branch before merge.** (1) When splitting, record provenance on each carried buy-off (`carriedFrom` with the parent order id and the original evidence ids) so the historical signature stays intact. (2) `verifyManifests` rechecks a carried buy-off against its original subject (parent order id, original evidence ids). (3) Add an end-to-end test: split an order with a completed operation; the result must pass `verifyManifests` and the server `validState` gate. Then push, get green CI on the new head, and Jinx re-reviews.

Final approval 5357199538 is WITHDRAWN and no longer stands; the premature thumbs-up was removed. The eyes reaction stays up.

### Codex 4137333748 (expired or superseded calibration cited on the buy-off day): CONFIRMED, P2, filed as #119

`calibrationReferenceProblem` (index.html:2680) checks the cited row exists for the tag and was recorded/calibrated at or before the buy-off, but does not check expiry, status, location, or whether a later quarantine/retirement/out-for-calibration entry was already effective at `b.at`. An entry calibrated Sep 27, due Sep 28, cited by a Sep 29 buy-off passes `MES.validate` and `verifyManifests`. Non-blocking: the natural write path cannot produce this (`resolveToolCheck`, index.html:2506, refuses expired/quarantined/out-for-calibration tools at point of use), so this is the import/migration-only class, and the last scope addition on #35 already stands. Filed as P2 issue #119.

### Do-not-merge checklist (head 606ca713, updated)

- [x] Option B chronology check verified on the exact head
- [ ] Split-regression fix (carriedFrom provenance + verifyManifests original-subject recheck + end-to-end split test) on this branch
- [ ] CI (suites) green on the head that carries the fix
- [ ] Jinx re-review and new Final approval after the fix push
- [ ] Claudia merges through the PR button after both are done

## Owner direction 2026-09-28 (evening): record-coverage fixes before Oct 7 handoff (read first)

Jose reversed the "hand over WIP with gaps documented" plan. Every record-coverage gap below must be fixed before the Wed Oct 7 handoff to Hemant and IT, not delivered unfinished.

1. **Kill the dual-path.** When a server is configured, record writes require an active server session. No silent on-device saves for quality and product records.
2. **Build the calibration record write path.** This is PR #35. Real lifecycle for calibrated-tool log entries, server-covered like the other records.
3. **Label the browser security log.** secLog must never be mistaken for the server audit trail.

Merge gate (owner 2026-09-28): Jinx final approval plus green CI on the exact head, then Claudia merges through the PR button. Codex reviews automatically but its approval does not gate merges. No auto-merge automation (parked by owner 2026-09-27).

Owner direction 2026-09-29 (option 1, relayed on the PR): the ~15 calibration-log P2/P3 issues get fixed on the #35 branch with `Closes #n` before merge, not in the main-targeted cleanup PR. Cleanup PR stays scoped to main's code.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`jinx/calibration-write-path`), push. Never commit to `jinx/review-notes`. This file is replaced after every Jinx review.

## Current status (Jinx review 5354904522 on head 56734f12)

No code blockers. Both open items from the last review are FIXED on this head and verified by Jinx against the code, with regression tests. The `suites` CI check is still IN PROGRESS on this exact head, so Final approval is not posted yet; it follows automatically once CI is green. Eyes reaction is up.

## Fixed and verified on this head (do not re-open)

### B2: buy-offs must cite calibration entries the log holds (Codex 4134256621) - FIXED

Commit 70a06cd8 adds `calibrationReferenceProblem` (index.html:2679): every `calibrationEntry` cited by buy-off tools and ATP test assets in `state.orders` must resolve to a calibration-log row for the same tag. It runs in `MES.validate` (via qualityRecordsValid, index.html:~3118) and in `MES.diagnose` (~7403), which names the work order id and operation and leaves the saved workspace unchanged. Verified: citations with undefined `calibrationEntry` are skipped, so legacy buy-offs recorded before this feature are unaffected; tag comparison normalizes case on both sides; the diagnose message directs a QA Manager review, no silent repair. The scope decision is moot now that the fix is in. Four new regression checks in tests/test_calibration.mjs cover cited-valid, missing-entry rejected, wrong-tool rejected, and ATP test-asset missing rejected.

### Postdated calibration on loaded records (Codex P1 4134619499) - FIXED

Commit 56734f12 adds the write-path invariant to the load path: `calibrationEntryValid` (index.html:2546) now requires `entry.calibratedAt <= pacificDay(entry.recordedAt)`, and `calibrationInvalidField` names the `calibratedAt` field (~2561). `pacificDay` (index.html:2123) is `toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })`, so this is a correct YYYY-MM-DD date comparison. Verified the write path already enforced the identical rule (`calibrationFieldError`, index.html:2603, called from both `recordCalibration` :2632 and `updateCalibration` :2659), so load and write now agree. Both `qualityRecordsValid` and the diagnose calibrate block route through `calibrationEntryValid`, closing the exact imported/hand-signed gap. Regression checks cover postdated-rejected with diagnose naming the entry, and same-day-accepted.

## Security pass on the two new commits (Jinx, this head)

- Auth surface: no change. Both fixes are pure validators. No new mutators, no new engine prefix registrations, no exclude-set edits, and the `configure-qms` gate on recordCalibration/updateCalibration is untouched.
- Injection: the new diagnose detail interpolates work-order id, operation id, entry id, and tag. Both UI render paths sanitize diagnose detail (`esc()` at index.html:11411; `[<>&]` strip at index.html:11150), so imported-workspace values cannot inject markup there.
- Cost: the new check is linear in buy-off citation count, negligible next to the existing full-validate pass.
- Behavior: previously valid workspaces can only newly fail validation when a buy-off cites a log entry that no longer exists, which is exactly the integrity gap closed. No silent repair; diagnose directs a QA Manager review, matching the other unrepairable record problems.

## Jinx scope call on Codex's two new P1s (15:52Z, answering relay comment 5893557585)

Call: **B**. Add the cheap chronology check for (2) on this branch; file (1) as a P2 issue (done, #116). Do not build the hash-chained log.

### Claude's reply claims, verified by Jinx against head 56734f12

- 4135312421 (postdated calibration fix in 56734f1): CONFIRMED. `calibrationEntryValid` (index.html:2546) requires `entry.calibratedAt <= pacificDay(entry.recordedAt)`; `calibrationInvalidField` (~2561) names `calibratedAt`.
- 4135312860 (B2 fix in 70a06cd): CONFIRMED. `calibrationReferenceProblem` (index.html:2679) walks `state.orders`, checks every `calibrationEntry` cited by buy-off tools and ATP test assets against the log, diagnose names work order and operation.
- 4135313200 (P2 4134619485): accurate, already filed as issue #114. No action.

### (2) 4135389174, retroactive evidence: FIX ON THIS BRANCH

Codex's code reading is CONFIRMED: the `logged` map in `calibrationReferenceProblem` retains only `e.id -> e.tag` (index.html:2680), so it never compares the cited row's `recordedAt`/`calibratedAt` against the buy-off's `at`. Jinx rates it P2, not P1: citing an entry that did not exist when the buy-off was signed requires a hand-crafted or hand-edited workspace, which the #109 scope line (catches mistakes, does not defeat a determined bad actor) excludes; and the buy-off `at` is not part of the signed `buyoffSubject` (index.html:2847), so this check catches mistakes, never forgery. But the fix is cheap and squarely in the Option 1 pattern for this branch: retain the cited entry (not just its tag) in the map and require `entry.recordedAt <= buyoff.at` and `entry.calibratedAt <= pacificDay(buyoff.at)`, with the same diagnose naming. `buyoff.at` is always set at write time (index.html:6649) and every legitimate UI flow satisfies the invariant, because a buy-off cites the entry that was current at use. Add regression checks in tests/test_calibration.mjs (entry recorded after the buy-off refused; later calibratedAt refused; normal citation still valid). This does not block the merge beyond the one push; severity stays P2.

### (1) 4135389160, truncated calibration history: FILED, NOT FIXED ON THIS BRANCH

Codex's code reading is CONFIRMED: deleting a tag's final `Retired` or `Quarantined` row leaves surviving ids strictly ordered (`calibrationSequenceProblem`, index.html:2562, finds nothing) and every remaining entry's per-entry manifest still verifies, so `verifyManifests` passes; `calibrationIndex` (index.html:2701) then makes the earlier `In Calibration` row current and `toolCheck` permits the tool again. Jinx rates it P2: the UI is append-only (no delete path), so this requires post-signing hand-editing, the class the #109 scope line excludes, and under the unkeyed SHA-256 signature design no client-side validator can defeat a determined editor anyway (the editor can rewrite any chain). Filed as issue #116; backlog. The hash-chained log is a design change, hours of work, not for this branch.

## New P2s filed from cross-review (do not block this PR)

Codex 4134619485 is CONFIRMED correct and filed by Jinx as issue #115. `updateSkillDraft` still records `bodyHash: sha256(canonical(body))` (index.html:3501) while `canonical` drops every key named `manifest` (index.html:2831). Two draft revisions differing only in an ordinary payload key such as `body.manifest.revision` get identical editHistory bodyHashes, so the history rows cannot distinguish them. The key-preserving `bodyDigest` in `draftSubject` (index.html:3500) already binds the current body in the signed manifest; only the history trail is weakened. Suggested fix: use the key-preserving canonicalization for the recorded edit hash as well. P2 is the right severity; it never blocks the merge.

Codex 4135389160 (truncated calibration history) is CONFIRMED correct and filed by Jinx as issue #116. See the scope-call section above for the full reading and why it is a P2 backlog item, not a branch fix.

## Do-not-merge checklist

- [x] B2 fix verified on the exact head
- [x] Postdated-calibration fix verified on the exact head
- [ ] (2) retroactive-evidence chronology check added on this branch (Jinx scope call, option B)
- [ ] CI (`suites`) green on the exact head 56734f12 (in progress as of 15:52Z)
- [ ] Jinx Final approval posted (follows CI green, after the (2) fix push and re-review)
- [ ] Claudia merges through the PR button after both are done

## Verified good (this head, no action)

- Test suite: 152 checks in test_calibration.mjs per the relay; local sequence 76/76 suites and 76/76 mirror per the relay comment (GitHub CI pending confirmation).
- The B1 torque-on-load fix from the earlier head is unchanged and still in place.
- Push delta between 7b56961d and 56734f12 is only the two fixes, the regression tests, and generated-file mirrors (demo.html, 4 fixtures). server/ untouched.

## 2026-09-29 19:10Z: Jinx delta review of head 606ca713 (commit 606ca71), Final approval given

- This head implements Jinx's Option B (scope call in comment 5896395776) for Codex P1 4135389174: `calibrationReferenceProblem` keeps the whole cited calibration log row (not just its tag) and requires it to be recorded at or before the buy-off's `at` and calibrated on or before `pacificDay(at)`. Covers operation tools and ATP test assets. `MES.diagnose` names the work order, operation, and entry.
- Jinx verified the full 606ca71 patch (index.html hunk at calibrationReferenceProblem, about line 2675; test_calibration.mjs hunk, 19 new lines): tag-match semantics unchanged by the row-map refactor; the `Date.parse(row.recordedAt) > Date.parse(b.at)` comparison is NaN-safe (a missing recordedAt skips instead of misfiring); `row.calibratedAt > pacificDay(b.at)` compares YYYY-MM-DD strings which order correctly; the `timestamp(b.at)` guard is pre-existing and other validation already requires a buy-off timestamp. Confirmed from the 56734f1 patch that `calibrationEntryValid` already requires `entry.calibratedAt <= pacificDay(entry.recordedAt)`, so for valid entries the calibrated-day condition is subsumed by the recorded-at condition; both are kept, which also guards hand-edited records.
- Security pass: no new mutators, no auth changes, no new input sinks. Fail-closed on violation; only fail-open paths are a missing valid buy-off timestamp (pre-existing guard) or a missing recordedAt (server-assigned and manifest-signed). No new attack surface.
- Waste pass: the Map holds row objects instead of tags; no duplication, no parallel mechanisms.
- Not independently verified: local 76/76 suite claims (Claude's relay, stated as local) and the full 3.2MB index.html at this head (contents API returns empty content at that size). The delta was read in full from the commit patch.
- Cross-review: Claude's inline reply 4137272905 (Option B description) CONFIRMED accurate against the patch; 4137273254 CONFIRMED, #117 is open with the p3 label (hash-chained-log design fix; distinct from Jinx's P2 #116 for the same finding).
- Jinx review 5357197412 posted, Final approval 5357199538 posted on the exact head 606ca713, thumbs-up added. CI (suites) was in_progress at review time.

## Do-not-merge checklist (head 606ca713) - SUPERSEDED by the 19:16Z section above

- [x] Option B chronology check verified on the exact head
- [ ] CI (suites) green on the exact head 606ca713 (in_progress as of 19:10Z)
- [ ] Jinx Final approval: 5357199538 posted 19:12Z, WITHDRAWN 19:16Z (review 5357324836) over the split-regression P1; new approval follows the fix push
- [ ] Claudia merges through the PR button only after the new approval
