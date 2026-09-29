# JINX-REVIEW.md (PR #35, head b88be197, updated 2026-09-29T13:55Z; Jinx review 5353568768)

## Owner direction 2026-09-28 (evening): record-coverage fixes before Oct 7 handoff (read first)

Jose reversed the "hand over WIP with gaps documented" plan. Every record-coverage gap below must be fixed before the Wed Oct 7 handoff to Hemant and IT, not delivered unfinished.

1. **Kill the dual-path.** When a server is configured, record writes require an active server session. No silent on-device saves for quality and product records.
2. **Build the calibration record write path.** This is PR #35. Real lifecycle for calibrated-tool log entries, server-covered like the other records.
3. **Label the browser security log.** secLog must never be mistaken for the server audit trail.

Merge gate (owner 2026-09-28): Jinx final approval plus green CI on the exact head, then Claudia merges through the PR button. Codex reviews automatically but its approval does not gate merges. No auto-merge automation (parked by owner 2026-09-27).

Owner direction 2026-09-29 (option 1, relayed on the PR): the ~15 calibration-log P2/P3 issues get fixed on the #35 branch with `Closes #n` before merge, not in the main-targeted cleanup PR. Cleanup PR stays scoped to main's code.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`jinx/calibration-write-path`), push. Never commit to `jinx/review-notes`. This file is replaced after every Jinx review.

## Current status (Jinx review 5353568768 on head b88be197)

No code blockers. All 20 calibration-log issues in the PR body (#38, #39, #40, #41, #47, #48, #49, #53, #54, #56, #57, #58, #59, #64, #65, #66, #67, #106, #107, #108) are verified fixed on this branch, each with a regression check in tests/test_calibration.mjs. The new commit b88be19 adds: #107 (toolIn counts buyoff.testAssets, index.html:5097), #108 (manifest meaning bound to entry kind, index.html:2539), #41 (read-only MES.calibrationCurrentIds, index.html:2674, used once per render in both log views instead of the inline supersede sets). Final approval is withheld for one reason only: the GitHub 'suites' check is still in_progress on this exact head. Eyes reaction is up, no thumbs-up.

## Do-not-merge checklist

- [ ] CI suites GREEN on the exact head b88be197 (in_progress at review time). This is the only remaining gate item.
- [ ] Jinx Final approval on the exact head (not yet posted; will post when CI is green and the head is unchanged).
- [ ] Before merge, add `Closes #110` to the PR body (Codex P2 4133924755, the per-row index rebuild, is fixed on this branch by the calibrationCurrentIds change, but the body does not list it). Or confirm #110 stays open intentionally.
- [ ] When CI is green, Claudia merges through the PR button.

## Verified this head (Jinx review 5353568768)

- Every one of the 20 issues was checked against the code at b88be197 and the regression tests: tag regex accepts 2 to 40 chars (#38); updateCalibration enforces the 5,000-entry cap (#39); future calibration dates are refused (#40); one engine rule (calibrationCurrentIds) decides current entries in both views (#41); updateCalibration applies a patched calibratedAt (#47); step tool renderer and torque dropdown come from calibratedToolChecks (#48); diagnose has a calibrationLog branch (#49); atpAssetBlock and buy-off datalists suggest from calibratedToolChecks (#53, #59, #65); traceSearch checks the log before the seed (#54); buy-off and ATP lists record the checked calibrationEntry (#56); recordMaintenance accepts seed plus log tools (#57); renderStepTorque uses the shared check set, no per-tag rescan (#58); retirement is the removal path, tested, and the form documents it (#64); verifyManifests treats an AI draft body manifest key as payload (#66); tests run at a fixed reference time (#67); nextCalibrationId returns null past CALLOG-99999 (#106); #107 and #108 as above.
- Security pass on the new delta: calibrationEntryValid rejects any supersedes that is not undefined or a CALLOG id, and recordCalibration never sets supersedes, so the meaning binding cannot be spoofed. The manifest subject already hashes supersedes; the meaning check is defense in depth. calibrationCurrentIds is read-only and matches no server mutator prefix (the test asserts host.resolveAction returns null). toolIn handles non-string asset values safely.
- Waste pass: calibrationCurrentIds and calibrationStatus share calibrationIndex as the single source of current-entry truth. Minor: toolIn uses startsWith for buy-off tools but exact match for testAssets; harmless.
- Not independently verified: the relay comment's local verification claims (76/76 suites, dry-run record, generator checks, test count). The GitHub 'suites' run is the authority and it is still in_progress.

## Open issue counts

P2 open: 25 (unchanged). P3 open: 7 (unchanged). The 20 calibration-log issues close on merge; #110 is not yet in the PR body's Closes list (see checklist).
