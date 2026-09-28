# JINX-REVIEW.md (PR #11, head 6f7d157b, reviewed 2026-09-28T02:30Z)

## How to use this file (Codex)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (fix these, then CI, then ask for re-review)

1. **Self-granting hole: a QA Manager or Master Access account can give itself inspection authority.** The stamp gate is now implemented, but it fails if the holder can issue themselves a stamp. Four paths have no self-target refusal:
   - Server `roles` action (`server/server.mjs:402`): only a Quality Supervisor is refused from changing their own roles. A QA Manager or Master Access can change their own roles, including adding the Quality role, needing only a current training record for themselves (the new training gate at server/server.mjs:407-411 does not block this).
   - Browser `setRoles` (index.html:1768): same, only Quality Supervisor refused.
   - `recordTraining` (index.html:2189): records who recorded it but has no self-target check; the QA Manager role holds the `configure-training` capability, so a QA Manager can record their own training.
   - `issueStamp` (index.html:2352): restricted to Master Access and QA Manager callers but has no self-target check, so a QA Manager can issue a Quality stamp to their own account.
   - Both `recordTraining` and `issueStamp` are remotely callable through the server action route (server/mes-host.mjs:109-115) under the caller's session authority, so the gap exists on the server path too, not just on device.
   - The named-grant path already refuses this (server/server.mjs:372: "Nobody grants or revokes their own authority"). Fix: refuse self-targets for role changes by any actor, for training records, and for stamp issuance, in both the browser engine and the server actions. Add refusal tests in tests/test_authority.mjs and tests/test_server.mjs and a frozen-contract line.
2. CI is not green on 6f7d157b: the `suites` check run completed FAILED (completed 2026-09-28T02:25:46Z; the run annotations name no failing suite, so pull the run logs locally to see which suite failed). The PR body claims 67/67 local, 67/67 mirror, 310/310 qa_full, all unproven. Fix, then re-run; mergeable_state is unstable.

## Claudia's green light (Flight merge gate)

Claudia (2026-09-27) approves only when all four are fixed on one head:
1. Training required for new qe accounts (done in de5facb3, still holding)
2. Inspection stamp gate implemented server-side (done in 6f7d157b)
3. CI green: VERSION.md release record matches index.html and demo.html
4. CI green: all suites, mirror on

Blocker 1 and blocker 2 above are the remaining gaps before her green light.

## Do not merge checklist

- [ ] Self-target refusals implemented for role changes, training records, and stamp issuance (browser engine and server actions), verified by tests.
- [ ] CI suites green on the exact head you push next.
- [ ] Jinx thumbs-up (+1) on the latest head.

## Non-blocking notes worth fixing now

- Browser `capsOf` (index.html:1739) calls `hasValidInspectionStamp` inside the per-role loop; hoist to once per `capsOf` call.
- The training-verification snippet (catalog lookup plus trainingCurrentFor) is now in three places: the grants action, the roles action, and the accounts PUT handler. Consolidate into one helper.
- TRAINING_GATED_ROLE_CAPS is defined in server.mjs while ROLE_CAPS lives in the roles module; keep them together so a future cap addition cannot miss the gate.
- tests/test_server_ui.mjs raised the server-sync wait to 30s; watch that it does not mask slow sync on real runs.

## Verified good

- Inspection stamp gate (the previous blocker) is now implemented and verified: `hasValidInspectionStamp` (index.html:2524) checks an assigned Quality stamp is Active, issued on or before today, not expired, and backed by current training when it is an expansion stamp. Browser `capsOf` and server `capsOf` (server/mes-host.mjs:72-73) both withhold inspect-steps without a valid stamp, failing closed. AGENTS.md rule 1, HANDOVER-v82.md, docs/ROLE_MATRIX.md, docs/DEMO_DEVIATIONS.md and the role-matrix and demo-deviation generators updated consistently; frozen contract pins the new model; index.html and demo.html both carry build v82 with matching SHA.
- New-account training gate (server/server.mjs:487-495) from de5facb3 still holds and is tested.
- No new duplication introduced by this commit; docs and their generators were changed together.
