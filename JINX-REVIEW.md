# JINX-REVIEW.md (PR #35, head 01d4c5a9, updated 2026-09-29T12:45Z; branch head is now 2e63dd05, re-reviewed by Jinx review 5353149544: torque P1 verified fixed, Final approval withheld pending green CI)

## Owner direction 2026-09-28 (evening): record-coverage fixes before Oct 7 handoff (read first)

Jose reversed the "hand over WIP with gaps documented" plan. Every record-coverage gap below must be fixed before the Wed Oct 7 handoff to Hemant and IT, not delivered unfinished.

1. **Kill the dual-path.** When a server is configured, record writes require an active server session. No silent on-device saves for quality and product records.
2. **Build the calibration record write path.** This is PR #35. Real lifecycle for calibrated-tool log entries, server-covered like the other records.
3. **Label the browser security log.** secLog must never be mistaken for the server audit trail.

Merge gate (owner 2026-09-28): Jinx final approval plus green CI on the exact head, then Claudia merges through the PR button. Codex reviews automatically but its approval does not gate merges. No auto-merge automation (parked by owner 2026-09-27).

Owner direction 2026-09-29 (option 1, relayed on the PR): the ~15 calibration-log P2/P3 issues get fixed on the #35 branch with `Closes #n` before merge, not in the main-targeted cleanup PR. Cleanup PR stays scoped to main's code.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`jinx/calibration-write-path`), push. Never commit to `jinx/review-notes`. This file is replaced after every Jinx review.

## Current status (Jinx reviews 5352785336 and 5352786067 on head 01d4c5a9)

Jinx Final approval posted on this exact head (review 5352786067), plus the thumbs-up reaction. No blockers remain in Jinx's review. All three confirmed Codex P1s from the a716f7e review and the P2 id-namespace overflow are fixed and verified against the code (details below).

## Do-not-merge checklist

- [ ] CI suites GREEN on the exact head 01d4c5a9 (no check runs yet at review time). This is the only remaining gate item.
- [x] Jinx Final approval on the exact head (review 5352786067).
- [x] Jinx thumbs-up reaction posted.
- [ ] When CI is green, Claudia merges through the PR button.
- [ ] Before merge, add `Closes #106` to the fix commit or PR body (the 01d4c5a commit fixes #106 but does not reference it; option 1 bookkeeping).

## Fixed and verified on this head (Jinx review 5352785336)

1. **Codex 4133296942 (P1): calibration order bound to signed ids.** `calibrationSequenceProblem` (index.html:2566) now requires `CALLOG-#####` ids to rise strictly in log order, returning `{id, detail}` naming the out-of-order entry. Flows through the unchanged `MES.validate`/`MES.diagnose` wiring. Tests cover reorder refusal, diagnose naming, and quarantine staying current.
2. **Codex 4133296971 (P2, issue #106): id namespace overflow.** `nextCalibrationId` returns `null` after `CALLOG-99999`; `recordCalibration` (index.html:2611) and `updateCalibration` (index.html:2634) refuse before any write. Test asserts nothing is written.
3. **Codex 4133296954 (P1): correction UI.** New `CalibrationCorrection` component (src/react/flight-ui.jsx:1217); React panel and legacy markup both render a "Correct this entry" form for the current entry per tag, gated on `configure-qms`. A document-level submit handler for `[data-qms-calibration-correct]` calls `MES.updateCalibration`. Authority is engine-enforced in `updateCalibration`, so UI gating is defense in depth. Test covers the React path end to end.
4. **Codex 4133296980 (P1): nested manifest keys in draft bodies.** New `canonicalPayload` (key-preserving canonical form) and `hasManifestKey` (index.html:2785); `draftSubject` (index.html:3449) adds `bodyDigest` when the body contains a `manifest` key anywhere. Bodies without the key hash exactly as before. Tests cover changing and adding manifest keys.

## Non-blocking notes

- The ordering rule skips ids not matching `/^CALLOG-\d{5}$/`. All ids are PR-generated, so this is unreachable through the product; observation only.
- `canonical` and `canonicalPayload` are now two parallel canonicalization functions with different key-dropping behavior. If one is ever changed, the other must follow (drift risk).
- Draft compatibility is a real behavior change (disclosed): a draft saved on `main` whose body already had a `manifest` key was signed without it and now fails validation (diagnose names it) until re-signed. The alternative keeps the undetectable-edit hole open; Jose should know re-signing is required.
- Issue #107 (P2, ATP test-asset uses missing from tool traceability) was filed by Jinx this run from Codex 4133296993. Fix: include `op.buyoff.testAssets` in the `toolIn` predicate (index.html:5070). Not a merge blocker; fix on this branch per option 1.
- Still standing: the owner-confirmation request on the TW-042/TW-024 reinstatement rule. Claudia relayed that she asked Jose to confirm directly to Jinx; Jinx does not treat Claudia's relay as owner direction.
- Issue #110 (P2, Codex 4133924755, confirmed by Jinx against head 2e63dd05, 2026-09-29 06:22 PDT run): the React CalibrationLog render (src/react/flight-ui.jsx:1229-1230) calls `isCurrent(row)` per row, and each call rebuilds the whole calibration index via `calibrationIndex` (index.html:2675-2681, two full log scans), so rendering N entries costs O(N^2). At the 5,000-entry limit this is roughly 50M row visits. Fix: build the current-entry ID set once before mapping (the engine's one-pass `calibrationIndex` already exists; the React side just does not reuse it) and do constant-time lookups per row. Only affects QA Managers (`canCorrect && isCurrent(row)` short-circuits for others). Not a merge blocker; fix on this branch per option 1 with `Closes #110`.

## Open issue counts

P2 open: 24 (was 23; +1 filed as #110 this run). P3 open: 7 (unchanged).

## Verified good (this head)

- All four fixes above verified line-by-line against the exact head, with new tests per fix in tests/test_calibration.mjs and tests/test_react_screens_ui.mjs.
- Security pass: correction form posts into the already-allowlisted `MES.updateCalibration` with `configure-qms` enforced engine-side; no new remotely-callable surface; no auth, upload, injection, or secret changes in this delta.
- What Jinx did not verify: the relay comment's process claims (76/76 local suites both modes, stamp/verify sequence, 128 checks in test_calibration). GitHub CI had no check runs on this head at review time.
