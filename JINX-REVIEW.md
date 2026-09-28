# JINX-REVIEW.md (PR #11, head a6208d94, reviewed 2026-09-28T01:30Z)

## How to use this file (Codex)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (fix these, then CI, then ask for re-review)

1. Primary role swap needs no training. `server/server.mjs`, POST /auth/access `roles` action: `added` is computed from `list.slice(1)` (extra roles only), so changing the primary role (for example technician to qe) requires no training record. Now that the qe role directly confers inspect-steps and mrb-quality, a manager can hand out inspection and MRB authority with no training evidence. Fix: require a current training record when the primary role changes (treat a changed primary like an added role), or record in docs that this is intended.
2. RESOLVED by owner decision (Jose, 2026-09-27): QE role carries MRB and Inspection as role capabilities, model confirmed. New requirement from Jose: inspection authority must be gated via a stamp requirement. Implement: qe keeps inspect-steps and mrb-quality in ROLE_CAPS, but inspect-steps is active only when the account holds a valid inspection stamp (credential/training record), enforced server-side at POST /auth/access and everywhere inspect-steps is checked. MRB authority (mrb-quality) follows the standard training requirement. Master Access no longer granting conformity or aqi-sign stands.

## Do-not-merge checklist

- [ ] Blocker 1 fixed (primary role change requires training, or documented as intended)
- [x] Blocker 2: Jose confirmed the role-capability authority model (2026-09-27); inspection gated by stamp requirement (implementation pending)
- [ ] CI `suites` green on the final head (in progress on a6208d94 at review time; previous head failed mirror-off 65/67 and mirror-on 66/67)
- [ ] Claudia approves

## Non-blocking notes worth fixing now

- `grantValid` is implemented in three places over the same record shape: index.html client, server/mes-host.mjs, and the record writer in POST /auth/access. Derive the server-side check from one definition to avoid drift.
- Dead check in the grant action: `isSupervisor(actor)` can never be true because the route already requires a QA Manager actor and isSupervisor excludes managers. Harmless; remove or leave.
- Pre-existing client-created grants without the new signed record fields (by.credentialId, 64-hex hash, reason of at least 10 chars) fail the new grantValid and silently deactivate. No migration provided. Fine on a PR branch; note it before any production cutover.

## Verified good in this review

- Parked automation fully removed: `.github/workflows/claude-jinx-review.yml` and `docs/CLAUDE_JINX_AUTOMATION.md` are gone; `.github/workflows` holds only `ci.yml` on this head.
- PUT /auth/accounts forgery fixed by redesign: PUT returns 403 for any client-supplied change to role, roles, extraRoles, roleTraining, grants, grantHistory, or supportAccess, and rejects new accounts carrying expanded access; the upsert keeps stored values. New POST /auth/access centralizes grant, revoke, roles, and support with server-side checks (QA Manager only for grants, no self-grants, reason 10 to 300 chars, current training, ROLE_CAPS eligibility, hashed grant records, audit entries). Client routes through it in server mode. Covered by tests/test_server.mjs.
- GRANTED model is now internally consistent: only conformity and aqi-sign are named grants; ROLE_CAPS.qe carries inspect-steps, conformity, aqi-sign, mrb-quality; docs, generator, UI copy, and frozen contract test all agree.
- tests/lib/grants.mjs removed and its one importer (tests/test_inspect_own_work.mjs) moved to tests/lib/roles.mjs; no dangling references found in the diff.
- No new Codex or Claudia comments since the last check; nothing new to cross-evaluate.
