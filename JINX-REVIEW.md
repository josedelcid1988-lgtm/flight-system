# JINX-REVIEW.md: Jinx review findings for Codex

## How to use this file
Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`, PR #11). This branch never touches the PR branch. Findings below are from the Jinx review of head `9c64d8d2a06dafa635bcc6c6db25465b1bfac796`, posted 2026-09-28T00:10Z (review 5332781666).

## Blockers (do not merge until resolved)
1. `.github/workflows/claude-jinx-review.yml` + `docs/CLAUDE_JINX_AUTOMATION.md`: remove both from the PR. They reintroduce per-run Claude automation Jose abandoned on 2026-09-27 (the API key bills per run), and review/merge automation is parked by owner direction. The trigger is also wrong: it fires on any comment by `vars.JINX_BOT_LOGIN`, and Jinx's reviews post as `josedelcid1988-lgtm`, so every comment from the owner account (Jose, Codex, routine posts) would start a `contents: write` Claude run. Fix: delete both files from the PR branch, or record Jose's explicit approval with the billing accepted.
2. `server/server.mjs:394`: `PUT /auth/accounts` stores client-supplied `grants` and `grantHistory` verbatim. Any Master Access, QA Manager, or Quality Supervisor session can grant itself `aqi-sign` or `conformity` with no training check, no reason, no grant hash, and no self-grant refusal, bypassing the client-side grant discipline pinned in `tests/test_frozen_contract.mjs:51-52`. Fix: strip `grants`/`grantHistory` from the bulk PUT and add a dedicated grant action that enforces the named-person, current-training, no-self-grant rules server-side, with tests covering the self-grant and missing-training refusals.
3. `docs/ROLE_MATRIX.md` vs `AGENTS.md` rule 1: the docs now say only `conformity` and `aqi-sign` are never part of a role, but `AGENTS.md` rule 1 says inspection and MRB seats are granted to named people by a QA Manager against a current training record. The code (`var GRANTED=['conformity','aqi-sign']`, pinned by `tests/test_frozen_contract.mjs:53`) grants inspection and MRB seats by role. This PR changed the docs to match the code without an owner decision. Needs Jose's explicit decision: restore the person-granted rule in code, or amend `AGENTS.md` rule 1.

## Do-not-merge checklist
- [ ] Blocker 1 resolved (workflow and doc removed from the PR, or Jose approved with billing accepted)
- [ ] Blocker 2 resolved (server-side grant discipline in place, tests green)
- [ ] Blocker 3 resolved (owner decision recorded on the PR)
- [ ] CI `suites` green on the exact head (`mergeable_state` was `unstable` and suites were in progress at review time)

## Non-blocking notes worth fixing now
- `MES.pruneExpiredNotices` (engine function in `index.html`/`demo.html`): add a `can('post-notice')` gate. Currently any authenticated session, including a view-only General User, can trigger shared-notice deletion through `/workspace/actions/MES.pruneExpiredNotices`.
- Behavior change: the old client `purgeNotices()` deleted undated notices (`Date.parse(undefined)` is NaN, and `NaN >= cutoff` is false); the new `pruneExpiredNotices` preserves them, and the test pins the new behavior. Confirm no flow depended on the old deletion.
- `docs/ROLE_MATRIX.md` documents an `ops` (Operations Manager) role with no reference in `server/server.mjs`. The canonical role list is extracted from `index.html` (`var ROLES`); confirm `ops` exists there before relying on it.
- Minor: `purgeNotices()` still recomputes the expiry pre-check with slightly different date parsing than `pruneExpiredNotices`; consider letting the engine function be the single implementation.

## Verified good (no action needed)
- Prior blockers genuinely fixed: `server/db-postgres.mjs` accounts query selects `profile` and `mapAccount` already spreads `row.profile`; `backup()` uses `--dbname <connectionString>`; the new pg_dump/pg_restore round-trip integration test drops its scratch database in a `finally` block.
- Notice cleanup routing is coherent: engine function, server action allowlist (`server/mes-host.mjs`), browser server-command queue, and the pinned/recent/undated preservation test.
- Generated files (build stamps, fixtures, `VERSION.md`, `docs/TEST-RESULTS-v82.md`) are consistent with the head.
- Mirror record count moved 17,546 to 17,545 with the hash chain intact; noted, no action.

## CI failure on the reviewed head (2026-09-28T00:18Z, run 36360283905)
The `suites` check completed FAILED on head 9c64d8d2. 65/67 pass mirror-off, 66/67 pass mirror-on:
- `tests/test_server_ui.mjs` fails BOTH runs: `page.waitForFunction(() => window.skServer?.sync?.status === 'synced', ...)` at line 24 times out (15s). The React shell renders (`#main .flight-react` visible), but the workspace sync never reaches `synced`. qa_full 310/310 and the local 67/67 claim in the PR body do not hold in CI.
- `tests/test_react_maneuver_ui.mjs` fails the mirror-off run only: `locator('body[data-view="mnv-car"]')` never becomes visible within 30s (line 69). It passes under the mirror run, so this smells like a timing-dependent render or a genuine startup path difference when persistence is local.
Fix: get `suites` green on the exact head before any merge. If these are timeout flakes, either raise the wait bounds in the tests or make the boot path deterministic; if the sync handshake actually stalls on this head, that is a behavior blocker in its own right.
