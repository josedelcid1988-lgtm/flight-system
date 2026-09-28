# JINX-REVIEW.md (PR #11, head de5facb3, reviewed 2026-09-28T01:55Z)

## How to use this file (Codex)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (fix these, then CI, then ask for re-review)

1. Stamp gate for inspect-steps is still not implemented. Jose confirmed (2026-09-27): qe keeps inspect-steps and mrb-quality in ROLE_CAPS, but inspect-steps is active only when the account holds a valid inspection stamp, enforced server-side. The new training gates apply at account creation and role assignment, but `capsOf` in `server/mes-host.mjs` (lines 72-73) still derives inspect-steps from role membership alone. Any existing qe account, or one that legitimately passed the training gate, keeps inspect-steps with no stamp. Implement the stamp check where inspect-steps is computed, not only at the assignment boundary.
2. CI is not green on de5facb3: the suites check run completed FAILED (exit code 1, completed 2026-09-28T01:55Z; the run annotations name no failing suite, so pull the run logs locally to see which of the 67 failed). The prior head failed the 'VERSION.md release record matches index.html and demo.html' and 'All suites, mirror on' steps, and the PR body claims 67/67 local, 67/67 mirror, 310/310 qa_full. Fix, then re-run; mergeable_state is unstable.

## Claudia's green light (Flight merge gate)

Claudia (2026-09-27) approves only when all four are fixed on one head:
1. Training required for new qe accounts (blocker 1)
2. Inspection stamp gate implemented server-side (blocker 2)
3. CI green: VERSION.md release record matches index.html and demo.html
4. CI green: all suites, mirror on

## Do not merge checklist

- [ ] Stamp gate implemented server-side where inspect-steps is computed (mes-host.mjs capsOf or equivalent), verified by test.
- [ ] CI suites green on the exact head you push next.
- [ ] Jinx thumbs-up (+1) on the latest head.

## Non-blocking notes worth fixing now

- The training-verification snippet (catalog lookup plus trainingCurrentFor) is now in three places: the grants action, the roles action, and the accounts PUT handler. Consolidate into one helper.
- TRAINING_GATED_ROLE_CAPS is defined in server.mjs while ROLE_CAPS lives in the roles module; keep them together so a future cap addition cannot miss the gate.
- `loadState()` runs on every PUT /auth/accounts merge even when no new account is present; minor cost.

## Verified good

- New-account training gate (server/server.mjs:487-495) is correct and tested: any role carrying inspect-steps, mrb-quality, mrb-me, mrb-eng, or mrb-cert requires an Active catalog trainingCode with a current record for the new username; 403 otherwise, with a regression test asserting no account row is created. Both the `role:` and `roles:` paths are covered, and adding qe as a secondary role through the roles action still requires training.
- Build stamp hash regenerated consistently with tools/stamp-build.mjs. The deco() interval tweak in index.html/demo.html is typeof-guarded and safe.
