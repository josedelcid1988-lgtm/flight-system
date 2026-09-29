# JINX-REVIEW.md (PR #35, head 7b56961d, updated 2026-09-29T15:15Z; Jinx reviews 5353924076 and 5354526433)

## Owner direction 2026-09-28 (evening): record-coverage fixes before Oct 7 handoff (read first)

Jose reversed the "hand over WIP with gaps documented" plan. Every record-coverage gap below must be fixed before the Wed Oct 7 handoff to Hemant and IT, not delivered unfinished.

1. **Kill the dual-path.** When a server is configured, record writes require an active server session. No silent on-device saves for quality and product records.
2. **Build the calibration record write path.** This is PR #35. Real lifecycle for calibrated-tool log entries, server-covered like the other records.
3. **Label the browser security log.** secLog must never be mistaken for the server audit trail.

Merge gate (owner 2026-09-28): Jinx final approval plus green CI on the exact head, then Claudia merges through the PR button. Codex reviews automatically but its approval does not gate merges. No auto-merge automation (parked by owner 2026-09-27).

Owner direction 2026-09-29 (option 1, relayed on the PR): the ~15 calibration-log P2/P3 issues get fixed on the #35 branch with `Closes #n` before merge, not in the main-targeted cleanup PR. Cleanup PR stays scoped to main's code.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`jinx/calibration-write-path`), push. Never commit to `jinx/review-notes`. This file is replaced after every Jinx review.

## Cross-review update 2026-09-29T14:20Z (5 new Codex inline replies on this head, all evaluated by Jinx)

- 4134529332 (reply to B1 finding): "Fixed in 7b56961" CONFIRMED correct. Jinx verified the fix below.
- 4134529968 (reply to #112): "Not changed in this push; I've asked for a scope decision. The finding is accurate." Correct: calibrationManifestValid binds signer identity but not signer role (index.html:2542). Stays filed as #112 (P2).
- 4134530675 (reply to B2): "Not changed in this push; I've asked for a scope decision. The finding is accurate." Correct: nothing checks that a buy-off's calibrationEntry still resolves to a log row. B2 is still open and needs an owner scope decision (Jose).
- 4134531042 (reply to #111): "Not changed in this push. This is a P2 for Jinx to file." Correct; already filed as #111.
- 4134531479 (reply to #113): "Not changed in this push. This is a P2 for Jinx to file." Correct; already filed as #113.

## B1 status: FIXED on this head (verified by Jinx, review 5353924076)

Commit 7b56961d ("fix: require the torque answer on load for log-only calibration tags") implements the fix exactly as specified: the log-validation walk now refuses any entry with `torque === undefined` when the tag is not in the shipped CAL_TOOLS snapshot (tag matched case-insensitively). The refusal names the entry id and tag and explains the answer is required. It runs at load validation, not just in recordCalibration, closing the crafted or imported log-only hole. The seeded-tag exemption is narrow: only tags present in CAL_TOOLS may omit torque, and the existing guard still refuses any entry that removes a torque classification a current entry records. Regression test added in tests/test_calibration.mjs: an imported log-only entry without the torque answer (CW-IMPORT) fails validate and diagnose names CALLOG-09994 with a torque detail; seeded tags recorded without a torque answer still validate. Push delta is only this change plus generated-file mirrors (demo.html, 4 fixtures) and the test; server/ untouched.

## B2 status: still OPEN, awaiting owner scope decision

Codex 4134256621 (P1 per the 2026-09-29 decision), CONFIRMED still present: `qualityRecordsValid` (index.html:3100) checks each log entry but nothing checks that a buy-off's stored `calibrationEntry` id resolves to a signed log row; an empty log is valid. If the row goes missing (import path or manual edit), signed operation and ATP buy-offs citing it still pass validate and verifyManifests: calibration evidence disappears while acceptance records stay valid. Codex's inline reply states a scope decision was asked of the owner (Jose). Fix when decided: at buy-off validation, require every stored `calibrationEntry` reference to resolve to a matching signed log row, plus a regression test.


## New blocker 2026-09-29T15:10Z: Codex P1 4134619499 (postdated calibration on loaded records), CONFIRMED still open on this head

Codex inline 4134619499 (index.html:2546), review 5354007084: `calibrationEntryValid` (index.html:2546) never checks the write-path invariant that `calibratedAt` is on or before the Pacific day of `recordedAt`. Jinx verified against the branch code on this exact head: neither `calibrationEntryValid` (2546) nor its diagnose mirror `calibrationInvalidField` (2547) nor the diagnose calibrate block (7383) contains any chronology check; the write path alone enforces it (`calibrationFieldError`, index.html:2595, with the comment "a calibration cannot be dated after the day it is recorded"). `calibrationSequenceProblem` (2574) does not cover this, it only checks id ordering and torque classification. Consequence: an imported or manually signed entry signed on Sep 29 with `calibratedAt` of Oct 1 passes `MES.validate`, `MES.verifyManifests`, and `MES.diagnose`; from Oct 1 onward `toolCheck` accepts the tool even though the signed record predates the claimed calibration. This is a data integrity P1 and blocks the merge. NOTE: the earlier B1 label belonged to the torque comment (4134256601), which IS fixed on this head; the postdated finding (4134619499) was never fixed.

Fix: apply the same chronology check in `calibrationEntryValid` and in the diagnose calibrate block so loading a workspace cannot admit a postdated calibration. Suggested condition: `entry.calibratedAt <= pacificDay(entry.recordedAt)` using the same `pacificDay` helper the write path uses, alongside the existing dateOnly checks. Existing log entries that violate it should be surfaced by diagnose for QA Manager review, never silently repaired. Add a regression test in tests/test_calibration.mjs: an imported signed entry with calibratedAt after pacificDay(recordedAt) fails validate and diagnose names the entry.

## Current status (Jinx review 5353924076 on head 7b56961d, plus the cross-review above)

Final approval is WITHHELD. Review 5353924076 found no blockers on the diff it covered, but review 5354526433 (this run) confirmed an open Codex P1 on this head: the postdated calibration load gap (4134619499, section above). A Final approval (5354503581) was posted earlier today on the mistaken basis that the Codex P1s were closed; it is WITHDRAWN and superseded by 5354526433, and the thumbs-up reaction was removed. GitHub 'suites' is now completed SUCCESS on this exact head (checked 15:06Z), so CI is not the blocker. Eyes reaction stays up. B2 (dangling calibrationEntry references) is still open pending the owner scope decision. All 20 calibration-log issues in the PR body remain verified fixed on this head, each with a regression check in tests/test_calibration.mjs, and B1 (the torque live-only gap) is now fixed with its own regression test.

## Do-not-merge checklist

- [x] Fix B1 (require boolean torque for non-seed tags at load validation) with regression test. Done in 7b56961d, verified by Jinx.
- [ ] Fix the postdated calibration load gap (Codex P1 4134619499): chronology check in `calibrationEntryValid` (index.html:2546) and the diagnose calibrate block (7383), plus regression test. Fix goes on this branch.
- [ ] Owner scope decision on B2 (dangling calibrationEntry references). Codex asked Jose; no decision recorded yet.
- [x] CI suites GREEN on the exact head 7b56961d (completed, success, checked 2026-09-29T15:06Z).
- [ ] Jinx Final approval on the exact head (5354503581 was withdrawn; re-review needed after the fix).
- [ ] PR body: add `Closes #110` (per-row index rebuild, fixed on branch by calibrationCurrentIds but not listed), plus `Closes #111 #112 #113` if fixed on the branch.
- [ ] When green and approved, Claudia merges through the PR button.

## Verified this head (Jinx review 5353924076)

- B1 fix verified: load-time torque-answer requirement for non-seed tags, seeded-tag exemption, seeded classification-removal guard intact, CW-IMPORT regression test and seeded-validation test.
- All 20 issues in the PR body (#38, #39, #40, #41, #47, #48, #49, #53, #54, #56, #57, #58, #59, #64, #65, #66, #67, #106, #107, #108) were previously checked against the code at b88be197 and the regression tests; this push changes none of that code. Spot-check: none of those code regions are in this push's diff.
- Security pass on the new delta: the new refusal rule only adds a stricter refusal in the validation walk; it widens no input path, introduces no new remote action, and touches no auth or upload handling.
- Waste pass: the new rule reuses the existing CAL_TOOLS snapshot and the same tag-normalization convention as neighboring guards; no parallel mechanism.
- Not independently verified: the suite was not executed by Jinx. The GitHub 'suites' run is the authority and it is in_progress.

## Open issue counts (2026-09-29T15:06Z)

- P2: 29 (new since last note: #111 prefix-match trace search, #112 unvalidated signer role, #113 5k-entry limit with no archive path, #114 AI draft bodyHash canonical mismatch)
- P3: 7


P2 open: 28 (unchanged: #38, #39, #40, #47, #48, #49, #53, #54, #56, #57, #64, #66, #67, #94, #97, #98, #99, #100, #101, #102, #105, #106, #107, #108, #110, #111, #112, #113). P3 open: 7 (unchanged: #41, #58, #59, #65, #95, #103, #104). The 20 calibration-log issues close on merge.
