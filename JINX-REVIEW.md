# JINX-REVIEW.md (PR #35, head 56734f12, updated 2026-09-29T15:45Z; Jinx review 5354904522)

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

## New P2 filed from cross-review (does not block this PR)

Codex 4134619485 is CONFIRMED correct and filed by Jinx as issue #115. `updateSkillDraft` still records `bodyHash: sha256(canonical(body))` (index.html:3501) while `canonical` drops every key named `manifest` (index.html:2831). Two draft revisions differing only in an ordinary payload key such as `body.manifest.revision` get identical editHistory bodyHashes, so the history rows cannot distinguish them. The key-preserving `bodyDigest` in `draftSubject` (index.html:3500) already binds the current body in the signed manifest; only the history trail is weakened. Suggested fix: use the key-preserving canonicalization for the recorded edit hash as well. P2 is the right severity; it never blocks the merge.

## Do-not-merge checklist

- [x] B2 fix verified on the exact head
- [x] Postdated-calibration fix verified on the exact head
- [ ] CI (`suites`) green on the exact head 56734f12 (in progress as of 15:44Z)
- [ ] Jinx Final approval posted (follows CI green)
- [ ] Claudia merges through the PR button after both are done

## Verified good (this head, no action)

- Test suite: 152 checks in test_calibration.mjs per the relay; local sequence 76/76 suites and 76/76 mirror per the relay comment (GitHub CI pending confirmation).
- The B1 torque-on-load fix from the earlier head is unchanged and still in place.
- Push delta between 7b56961d and 56734f12 is only the two fixes, the regression tests, and generated-file mirrors (demo.html, 4 fixtures). server/ untouched.
