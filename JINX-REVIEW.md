# JINX-REVIEW.md (PR #35, head b88be197, updated 2026-09-29T14:05Z; Jinx review 5353568768 plus cross-review of the 5 new Codex comments)

## Owner direction 2026-09-28 (evening): record-coverage fixes before Oct 7 handoff (read first)

Jose reversed the "hand over WIP with gaps documented" plan. Every record-coverage gap below must be fixed before the Wed Oct 7 handoff to Hemant and IT, not delivered unfinished.

1. **Kill the dual-path.** When a server is configured, record writes require an active server session. No silent on-device saves for quality and product records.
2. **Build the calibration record write path.** This is PR #35. Real lifecycle for calibrated-tool log entries, server-covered like the other records.
3. **Label the browser security log.** secLog must never be mistaken for the server audit trail.

Merge gate (owner 2026-09-28): Jinx final approval plus green CI on the exact head, then Claudia merges through the PR button. Codex reviews automatically but its approval does not gate merges. No auto-merge automation (parked by owner 2026-09-27).

Owner direction 2026-09-29 (option 1, relayed on the PR): the ~15 calibration-log P2/P3 issues get fixed on the #35 branch with `Closes #n` before merge, not in the main-targeted cleanup PR. Cleanup PR stays scoped to main's code.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`jinx/calibration-write-path`), push. Never commit to `jinx/review-notes`. This file is replaced after every Jinx review.

## Cross-review update 2026-09-29T14:05Z (5 new Codex comments on this exact head, all evaluated by Jinx)

Five Codex inline comments landed 13:51:51Z, after review 5353568768. Verdicts:

**B1 (P1, pre-merge): torque classification gap on live-only entries.** Codex 4134256601, CONFIRMED. `calibrationEntryValid` (index.html:2546) permits `torque` to be absent, but the record-time mutator `calibrationTorque` (index.html:2623) forces every new tag to declare torque Yes or No. The validator is looser than the mutator: a crafted or imported log-only entry without the flag and without TORQUE in the description passes `MES.validate` and `verifyManifests` (manifest hashes are unkeyed SHA-256, index.html:3095), and `resolveToolCheck` (index.html:2513) plus `isTorqueTool` (index.html:2709) then classify it as non-torque, so the buy-off `missingTorque` gate (index.html:6611) is skipped. A torque tool can be bought off with no torque value recorded. Fix: in `calibrationEntryValid`, require `torque` to be boolean whenever the tag is not in `CAL_TOOLS`, mirroring the mutator rule. Add a regression test (log-only entry without the flag must be refused by validate).

**B2 (P1, pre-merge): dangling calibrationEntry references are never validated.** Codex 4134256621, CONFIRMED. `qualityRecordsValid` (index.html:3100) checks each log entry but nothing checks that a buy-off's stored `calibrationEntry` id resolves to a signed log row; an empty log is valid. If the row goes missing (import path or manual edit), signed operation and ATP buy-offs citing it still pass validate and verifyManifests: calibration evidence disappears while acceptance records stay valid. Fix: at buy-off validation, require every stored `calibrationEntry` reference to resolve to a matching signed log row. Add a regression test.

**P2s, all confirmed and filed (non-blocking, fix on this branch or in cleanup):**
- #111: trace search matches buy-off tools by prefix (Codex 4134256612, index.html:5098). Searching `CAL-1` false-matches operations that used only `CAL-10`. Fix: compare normalized tags for equality, like the testAssets and torque branches on the same line. Correction to the earlier review note: this asymmetry is NOT harmless.
- #112: calibration entry signer role never validated on load (Codex 4134256633, index.html:2542). The manifest carries `signer.role` (index.html:2821) but `calibrationManifestValid` only binds name and credentialId. Cheap hardening: require the manifest signer role to hold `configure-qms` authority. (Codex badge P1 is generous: natural creation always goes through the gated mutators, so exploitation needs manual crafting; filed as P2.)
- #113: the 5,000-entry limit tells the operator to archive, but no archive path exists (Codex 4134256644, index.html:2639, 2653; same dead instruction at 2610). Implement an archive mechanism that preserves referenced signed history, or define the real capacity strategy.

## Current status (Jinx review 5353568768 on head b88be197, plus the cross-review above)

Final approval is WITHHELD for three reasons: (1) the GitHub 'suites' check is still in_progress on this exact head; (2) B1 must be fixed on the branch; (3) B2 must be fixed on the branch. Eyes reaction is up, no thumbs-up. All 20 calibration-log issues in the PR body (#38, #39, #40, #41, #47, #48, #49, #53, #54, #56, #57, #58, #59, #64, #65, #66, #67, #106, #107, #108) remain verified fixed on this head, each with a regression check in tests/test_calibration.mjs.

## Do-not-merge checklist

- [ ] Fix B1 (require boolean torque for non-seed tags in calibrationEntryValid) with regression test.
- [ ] Fix B2 (calibrationEntry references must resolve to a signed log row) with regression test.
- [ ] CI suites GREEN on the exact head b88be197 (in_progress at last check 14:00Z).
- [ ] Jinx Final approval on the exact head (not yet posted).
- [ ] PR body: add `Closes #110` (per-row index rebuild, fixed on branch by calibrationCurrentIds but not listed), plus `Closes #111 #112 #113` if fixed on the branch.
- [ ] When green and approved, Claudia merges through the PR button.

## Verified this head (Jinx review 5353568768)

- Every one of the 20 issues was checked against the code at b88be197 and the regression tests: tag regex accepts 2 to 40 chars (#38); updateCalibration enforces the 5,000-entry cap (#39); future calibration dates are refused (#40); one engine rule (calibrationCurrentIds) decides current entries in both views (#41); updateCalibration applies a patched calibratedAt (#47); step tool renderer and torque dropdown come from calibratedToolChecks (#48); diagnose has a calibrationLog branch (#49); atpAssetBlock and buy-off datalists suggest from calibratedToolChecks (#53, #59, #65); traceSearch checks the log before the seed (#54); buy-off and ATP lists record the checked calibrationEntry (#56); recordMaintenance accepts seed plus log tools (#57); renderStepTorque uses the shared check set, no per-tag rescan (#58); retirement is the removal path, tested, and the form documents it (#64); verifyManifests treats an AI draft body manifest key as payload (#66); tests run at a fixed reference time (#67); nextCalibrationId returns null past CALLOG-99999 (#106); #107 and #108 as above.
- Security pass on the new delta: calibrationEntryValid rejects any supersedes that is not undefined or a CALLOG id, and recordCalibration never sets supersedes, so the meaning binding cannot be spoofed. The manifest subject already hashes supersedes; the meaning check is defense in depth. calibrationCurrentIds is read-only and matches no server mutator prefix (the test asserts host.resolveAction returns null). toolIn handles non-string asset values safely.
- Waste pass: calibrationCurrentIds and calibrationStatus share calibrationIndex as the single source of current-entry truth.
- Not independently verified: the relay comment's local verification claims (76/76 suites, dry-run record, generator checks, test count). The GitHub 'suites' run is the authority and it is still in_progress.

## Open issue counts

P2 open: 28 (was 25; +3 this run: #111, #112, #113). P3 open: 7 (unchanged). The 20 calibration-log issues close on merge.
