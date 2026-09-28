# JINX-REVIEW.md (PR #11, head f40228d5, reviewed 2026-09-28T01:40Z)

## How to use this file (Codex)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (fix these, then CI, then ask for re-review)

1. New accounts can be created with the qe role and no training on file. `PUT /auth/accounts` (`server/server.mjs:477-483`) accepts a new account with `role: 'qe'` or `roles: ['qe']` with no `trainingCode`. At read time `rolesOf` in `server/mes-host.mjs` trusts the primary role unconditionally and `capsOf` adds `inspect-steps` and `mrb-quality` straight from `ROLE_CAPS.qe`. Fix: require a current training record when creating an account whose role carries inspect-steps or an mrb capability, with a refusal test for each path. Same class as the fixed primary-change gap. Owner decision needed if you want this deferred instead of fixed.
2. Stamp gate for inspect-steps is still not implemented. Jose confirmed (2026-09-27): qe keeps inspect-steps and mrb-quality in ROLE_CAPS, but inspect-steps is active only when the account holds a valid inspection stamp, enforced server-side. `capsOf` in `server/mes-host.mjs` currently adds inspect-steps from role membership with no stamp check. Implement the stamp requirement where inspect-steps is computed and checked.

## Do-not-merge checklist

- [ ] Blocker 1: new-account training gap (fix or explicit owner deferral)
- [ ] Blocker 2: inspection stamp gate implemented server-side
- [ ] CI `suites` green on the final head (in_progress on f40228d5 at review time; previous head a6208d94 had failed mirror-off 65/67 and mirror-on 66/67)
- [ ] Claudia approves

## Resolved in this review

- Primary role change now requires training (`server/server.mjs:408-412`): `primaryChanged = before[0] !== list[0]` feeds the training check, the 403 path rejects before any write, and the audit records `trainingCode`. New regression tests in `tests/test_server.mjs` cover the 403 refusal (account unchanged) and the 200 path with a current ESD record. This was the owner-approved blocker 1 fix; verified correct.
- Parked automation fully removed: `.github/workflows/claude-jinx-review.yml` and `docs/CLAUDE_JINX_AUTOMATION.md` are gone; `.github/workflows` holds only `ci.yml` on this head.
- PUT /auth/accounts forgery redesign stands: 403 for any client-supplied change to role, roles, extraRoles, roleTraining, grants, grantHistory, or supportAccess; new accounts rejected with expanded access; grants go through POST /auth/access with QA Manager only, no self-grants, reason 10 to 300 chars, current training, ROLE_CAPS eligibility, hashed grant records, audit entries. Covered by tests/test_server.mjs.
- GRANTED model internally consistent: only conformity and aqi-sign are named grants; ROLE_CAPS.qe carries inspect-steps, conformity, aqi-sign, mrb-quality; docs, generator, UI copy, and frozen contract test all agree.

## Non-blocking notes worth fixing now

- `roleTraining` only records training evidence for extra roles (`list.slice(1)`); a primary change's `trainingCode` lands only in the audit entry. The audit covers the evidence, so this is a note.
- `grantValid` is implemented in three places over the same record shape: index.html client, server/mes-host.mjs, and the record writer in POST /auth/access. Derive the server-side check from one definition to avoid drift.
- Dead check in the grant action: `isSupervisor(actor)` can never be true because the route already requires a QA Manager actor and isSupervisor excludes managers. Harmless; remove or leave.
- Pre-existing client-created grants without the new signed record fields (by.credentialId, 64-hex hash, reason of at least 10 chars) fail the new grantValid and silently deactivate. No migration provided. Fine on a PR branch; note it before any production cutover.

## Verified good in this review

- Head f40228d5 is a single-commit delta over a6208d94 (server/server.mjs +3/-2, tests/test_server.mjs +19), fully read. No behavior changes outside the primary-change training gate.
- mergeable_state on this head is `unstable` (CI in progress).

## Cross-review notes

- Claude inline 4117811919 (server/server.mjs:407): first paragraph stale (describes a6208d9, fixed by this commit); second paragraph confirmed correct (new-account qe without training, now Blocker 1).
- Claude inline 4117812126 (AGENTS.md:51): owner decision is recorded on the PR (issue comment 5860599154) and the stamp requirement is captured here; the implementation (Blocker 2) remains open.
