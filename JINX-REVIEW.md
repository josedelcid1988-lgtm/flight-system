# JINX-REVIEW.md (PR #11, head b5447ea4, reviewed 2026-09-28T19:50Z)

## Owner direction 2026-09-28: v1 and v2 tracks (read first)

- This repository (flight-system) is now the **v2** track. Keep building the React upgrade and the MES feature work here toward a fuller MES. Do not trim this repo. The Sep 27 pause is lifted for v2 as of today.
- **v1** is a separate trimmed build for the Skyryse official release and pilot. It lives in a new separate repo (name to be confirmed), built by a separate Claude session from an older Flight System version with Flight Maneuver stripped out. Nothing in v1 changes your work here.
- Datum-OS is the owner's commercial product and stays separate. Do not copy code between Datum-OS and this repo in either direction.
- The merge gate is unchanged: Jinx clean review on the exact head SHA, Claudia approval, green CI, then merge via the PR button. No auto-merge automation: it was parked by the owner on 2026-09-27, do not build it and do not propose it.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (Jinx review 5343782329 on b5447ea4)

1. **CI green on this exact head: pending.** The `suites` check-run on `b5447ea4` is still in_progress at review time. Watch it; if the qa_operator 0.25px flake shows up, see the non-blocking note below before treating it as real. Both root causes from the 6f7d157b failure were verified fixed in code (see Verified good).
2. **Codex review is still missing.** No Codex review has appeared on this PR (only the bot note that an environment must be created). Per the standing merge gate, Codex's approval is required before Claude merges. Either the environment gets created so its auto-review runs, or the owner says otherwise in chat.

The two previous blockers are RESOLVED in code (details below) and need no further fix work, only green CI confirmation.

## Claudia's green light (Flight merge gate)

Claudia (2026-09-27) approves only when all four are fixed on one head:
1. Training required for new qe accounts (done in de5facb3, still holding)
2. Inspection stamp gate implemented server-side (done in 6f7d157b, still holding)
3. CI green: VERSION.md release record matches index.html and demo.html (release record regenerated from full clean runs on this tree; awaiting the in-progress run)
4. CI green: all suites, mirror on (awaiting the in-progress run)

## Do not merge checklist

- [x] Self-target refusals implemented for role changes, training records, and stamp issuance (browser engine and server actions), verified by tests and frozen contract.
- [ ] CI suites green on head b5447ea4 (currently in_progress).
- [ ] Jinx Final approval comment on the exact head (eyes reaction only so far).
- [ ] Codex approval present on the PR.
- [ ] No Jinx thumbs-up (+1) yet; that lands with Final approval.

## Non-blocking notes worth fixing now

- tests/qa_operator.mjs: the sequence-panel scroll check asserts exact float equality on `getBoundingClientRect().top`. This is the real source of the 0.25px flake you flagged. An epsilon comparison would make it robust. Not caused by this PR and not a merge blocker, but fix it now and the flake goes away permanently.
- Cosmetic: the access-table self-refusal message names "another QA Manager or Master Access account", while the canManageAccess gate also allows a Quality Supervisor to manage access. Wording only.
- The QS branch guard still carries a now-unreachable `u.username===me.username` term after the earlier self check. Harmless.
- Still open from before (accepted deferral): TRAINING_GATED_ROLE_CAPS stays next to ROLE_CAPS; you noted ROLE_CAPS is regex-extracted by server/mes-host.mjs, so this belongs in its own change. Agreed, not for this PR.

## Verified good (head b5447ea4)

- Self-grant hole is closed and verified in code and tests:
  - `server/server.mjs` roles action refuses any account changing its own roles (`if (target.username === actor.username)`), not just a Quality Supervisor.
  - Browser engine (index.html, mirrored in demo.html and fixtures): setRoles, recordTraining, issueStamp, updateStamp all refuse the signed-in account as target. updateStamp allows only suspend or retire on one's own stamp, which can only reduce authority.
  - The fifth path is closed: the primary-role dropdown change handler (index.html access table, `data-role-user` listener) refuses self-target before writing instead of bypassing setRoles.
  - The server action route (server/server.mjs) turns any engine `{ok:false}` into 403 with an `action-refused` audit row and returns before persistence, so the workspace ETag is unchanged; engine refusals hold on the remote route.
  - tests/test_frozen_contract.mjs pins all five refusal strings plus the server line. tests/test_authority.mjs checks each refusal next to the same act for another person. tests/test_server.mjs checks 403 through both the access route and the action route (QA Manager and Master Access self-role attempts), unchanged ETag, audited refusals, and no inspect-steps granted.
  - qa_master, qa_full D-5/D-6, and test_inspect_own_work now use a second account for setup acts; test_jira_integration honours CHROME_PATH.
- VERSION.md release record regenerated by tools/release-report.mjs from full clean runs on this tree: 67 of 67 mirror off, 67 of 67 mirror on, 17,595 mirror records, chain intact, no skips, qa_full 310 checks, stamped sha 49145a4a.
- First-run sync race fixed in code and the fix is sound: the action queue chains behind the in-flight snapshot push before sending, so the first-run initialize PUT lands with its ETag before any action flush (no more 428, no more false "The server refused this change"). test_server_ui timeout correctly back to 15s.
- `trainingQualifies` helper in server/server.mjs consolidates the three training-check copies (the non-blocking note from 6f7d157b, now done). Browser `capsOf` and server `capsOf` memoize the stamp check to once per call (the other note from 6f7d157b, now done).
- Inspection stamp gate and new-account training gate from earlier heads still hold and are tested.
