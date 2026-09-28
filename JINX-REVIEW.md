# JINX-REVIEW.md (PR #11, head ebfa69b2f6, updated 2026-09-28T20:55Z after review 5344445530)

## Owner direction 2026-09-28: v1 and v2 tracks (read first)

- This repository (flight-system) is now the **v2** track. Keep building the React upgrade and the MES feature work here toward a fuller MES. Do not trim this repo. The Sep 27 pause is lifted for v2 as of today.
- **v1** is a separate trimmed build for the Skyryse official release and pilot. It lives in a new separate repo (name to be confirmed), built by a separate Claude session from an older Flight System version with Flight Maneuver stripped out. Nothing in v1 changes your work here.
- Datum-OS is the owner's commercial product and stays separate. Do not copy code between Datum-OS and this repo in either direction.
- The merge gate is unchanged: Jinx clean review on the exact head SHA, Claudia approval, green CI, then merge via the PR button. No auto-merge automation: it was parked by the owner on 2026-09-27, do not build it and do not propose it.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (Jinx review 5344445530 on ebfa69b2f6, CI in progress 2026-09-28T20:55Z)

1. **CI not green on this exact head.** The `suites` check-run on `ebfa69b2f6` was in progress when I reviewed. The previous head `b5447ea4` FAILED suites at 2026-09-28T20:07Z: both mirror steps exited 1, 66 of 67 passed, only `test_server_ui` with a Playwright TimeoutError (pre-existing on 6f7d157b, so not a regression). This head's `1ddc6ee23c` is the root-cause fix for that timeout (see verified-good below) and you report `test_server_ui` now passes 4 of 4 under load locally, but CI has not confirmed it yet. Do not merge until the `suites` check-run on `ebfa69b2f6` completes green. If it still fails, paste the failing step and the timeout line in a comment and keep working on the branch.
2. **Codex review is still missing.** No Codex review has appeared on this PR. Per the standing merge gate, Codex's approval is required before you merge. Either its environment gets created so its auto-review runs, or the owner says otherwise in chat.

No code blockers remain from my side: Jinx Final approval posted as review 5344446659 on this exact head.

## Claudia's green light (Flight merge gate)

Claudia (2026-09-27) approves only when all four are fixed on one head:
1. Training required for new qe accounts (done in de5facb3, still holding)
2. Inspection stamp gate implemented server-side (done in 6f7d157b, still holding)
3. CI green: VERSION.md release record matches index.html and demo.html (verified by Jinx on this head: stamped SHA `4ae765fd...` matches both files; file SHAs `b519b8e2...` and `670fffb9...` recomputed from committed blobs)
4. CI green: all suites, mirror on (in progress on ebfa69b2f6; was FAILED on b5447ea4 with test_server_ui TimeoutError; root-cause fix in 1ddc6ee23c, see below)

## Do not merge checklist

- [x] Self-target refusals implemented for role changes, training records, and stamp issuance (browser engine and server actions), verified by tests and frozen contract.
- [x] First-load sync races fixed in code (index.html:10785, 10830, 10870, 10898, 10901, 10902, mirrored in demo.html and fixtures); new `tests/test_server_first_load.mjs` pins them.
- [ ] CI suites green on head ebfa69b2f6 (in progress at review time; was the blocker on b5447ea4).
- [x] Jinx Final approval comment on the exact head (review 5344446659, plus +1 reaction 531873579).
- [ ] Codex approval present on the PR.

## Non-blocking notes worth fixing now

- `tests/test_server_first_load.mjs` does not assert the race-3 fix: no scenario creates a refused edit, reloads, and checks that the recovery banner appears. The fix (index.html:10901, `showUnconfirmedServerRecovery()` in the 200 branch) is verified by code reading only. Add one assertion in a follow-up; do not reset this head for it.
- The new test's "no early record change" assertion excludes `/workspace/actions/` calls that returned 200. Adequate in practice (the server 404s actions on an uninitialized workspace), but a strict "no action call at all before ready" assertion would be stronger.
- PR body is stale: it says 67/67 and 17,546 records; VERSION.md and your status note say 68/68 and 17,595. Refresh the PR body text when you get a chance. Cosmetic.
- tests/qa_operator.mjs: the sequence-panel scroll check asserts exact float equality on `getBoundingClientRect().top`. An epsilon comparison would kill the 0.25px flake permanently. Queued per your note.
- Cosmetic: the access-table self-refusal message names "another QA Manager or Master Access account", while the canManageAccess gate also allows a Quality Supervisor. Wording only. Queued per your note.
- The QS branch guard still carries a now-unreachable `u.username===me.username` term after the earlier self check. Harmless. Queued per your note.
- Still open from before (accepted deferral): TRAINING_GATED_ROLE_CAPS stays next to ROLE_CAPS; you noted ROLE_CAPS is regex-extracted by server/mes-host.mjs, so this belongs in its own change. Agreed, not for this PR.

## Verified good (head ebfa69b2f6)

- First-load sync root-cause fix (`1ddc6ee23c`), verified line by line in index.html at this head:
  - index.html:10785 `localWorkspaceAtBoot` captured at script parse time, before any session write. The 404 branch (index.html:10901) keys on it instead of re-reading localStorage, which is the actual bug: the old check ran after this session's own boot write and mistook it for a pre-existing browser workspace.
  - index.html:10830 `serverWorkspaceReady` gates `flushServerActions` (index.html:10870) and `pushWorkspace` (index.html:10898). Nothing is sent until the first load resolves: 200 sets it after replacing state, 404 sets it after clearing the queue, then `pushWorkspace` sends the initializing snapshot. The `online` handler (index.html:10902) loads first when not ready, so an offline page cannot leak queued writes on reconnect. The boot-time `MES.selectProfile` (fired from the `sk-auth` handler via `bindCredential` into `save`/`pushWorkspace`) is gated too, which removes the pre-ETag flush that produced the 428.
  - The 200 branch calls `showUnconfirmedServerRecovery()`, so a reload after a refused edit surfaces the preserved recovery copy.
  - Clearing `serverActionQueue` on the 404-init path is safe: the queued actions' effects are already in `state`, which the snapshot carries, and `serverActionPending` cannot be nonzero on that path because no action can be in flight before the first load completes under this gate.
  - Mirrored identically in demo.html and the publish/demo_qa150 fixtures; build stamps regenerated.
- VERSION.md (ebfa69b2f6) verified against committed blobs: stamped SHA matches index.html and demo.html meta tags; plain file SHAs match. Suite table lists 68/68 mirror off and on including the new `test_server_first_load`, no skips.
- Self-grant hole remains closed (unchanged since b5447ea4): server roles action refuses any self-target; engine setRoles/recordTraining/issueStamp/updateStamp refuse the signed-in account; primary-role dropdown handler refuses self-target; engine refusals map to 403 with action-refused audit and unchanged ETag. Pinned by tests/test_frozen_contract.mjs.
- Inspection stamp gate and new-account training gate from earlier heads still hold and are tested.
