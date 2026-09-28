# JINX-REVIEW.md (PR #11, head d1c5393c, updated 2026-09-28T22:30Z after review 5345292049)

## Owner direction 2026-09-28: v1 and v2 tracks (read first)

- This repository (flight-system) is now the **v2** track. Keep building the React upgrade and the MES feature work here toward a fuller MES. Do not trim this repo. The Sep 27 pause is lifted for v2 as of today.
- **v1** is a separate trimmed build for the Skyryse official release and pilot. It lives in a new separate repo, built by a separate Claude session from an older Flight System version with Flight Maneuver stripped out. Nothing in v1 changes your work here.
- Datum-OS is the owner's commercial product and stays separate. Do not copy code between Datum-OS and this repo in either direction.
- The merge gate is unchanged: Jinx clean review on the exact head SHA, Codex approval, green CI, then Claudia merges via the PR button. No auto-merge automation: it was parked by the owner on 2026-09-27, do not build it and do not propose it.

## How to use this file (Claude)

Fetch with `git fetch origin jinx/review-notes`, read this file, apply fixes on the PR branch (`flight-v82-datum-port`), push. Never commit to `jinx/review-notes` and never touch the PR branch from this file's update flow. This file is replaced after every Jinx review.

## Blockers (Jinx review 5345292049 on d1c5393c, CI in progress 2026-09-28T22:30Z)

1. **CI not green on this exact head.** The `suites` check-run on `d1c5393c` started 2026-09-28T22:11:33Z and was still in progress at review time. Do not merge until it completes green. If it fails, paste the failing step and the failure line in a comment and keep working on the branch.
2. **Codex approval still missing on this head.** No Codex review has appeared on `d1c5393c`. Per the standing merge gate, Codex's approval is required before you merge.

No code blockers remain from my side: Jinx Final approval posted as review 5345293063 on this exact head.

## Claudia's green light (Flight merge gate)

Claudia (2026-09-27) approves only when all four are fixed on one head:
1. Training required for new qe accounts (done in de5facb3, still holding)
2. Inspection stamp gate implemented server-side (done in 6f7d157b, still holding)
3. VERSION.md release record matches index.html and demo.html (d1c5393c refreshes the release record for this tree; release-report --check matches per your status note; CI will confirm)
4. CI green: all suites, mirror on (in progress on d1c5393c)

## Do not merge checklist

- [x] Self-target refusals implemented for role changes, training records, and stamp issuance (browser engine and server actions), verified by tests and frozen contract.
- [x] First-load sync races fixed in code (index.html:10785, 10830, 10870, 10898, 10901, 10902, mirrored in demo.html and fixtures); `tests/test_server_first_load.mjs` pins them.
- [ ] CI suites green on head d1c5393c (in progress at review time).
- [x] Jinx Final approval comment on the exact head (review 5345293063, plus +1 reaction).
- [ ] Codex approval present on the PR.

## Non-blocking notes worth fixing now

- `closeMaintenance` person separation compares credentialId, but the two modes use different namespaces (standalone profile credential vs `ACCT-username` in server mode). A record opened in standalone profile mode and verified after signing in would compare different strings and pass the self-check. Obscure, but normalize the comparison to the person (account username when signed in) in a follow-up. Non-blocking.
- PR body is stale: it says 67/67 and 17,546 records; VERSION.md and your status note say 68/68 and 17,595. Refresh the PR body text when you get a chance. Cosmetic.
- Still open from before (accepted deferral): TRAINING_GATED_ROLE_CAPS stays next to ROLE_CAPS; you noted ROLE_CAPS is regex-extracted by server/mes-host.mjs, so this belongs in its own change. Agreed, not for this PR.
- Resolved by PR #15 (Jinx Final approval 5345236262, same day): race-3 banner assertion, qa_operator epsilon scroll, access-table wording, unreachable QS guard term.

## Verified good (head d1c5393c)

- Receiving-inspection P1 fixed: `recordExternalReceipt` (index.html:7476) gates on the signed-in account's `inspect-steps` (stamp-gated via `capsOf`, index.html:1740) when a session account exists; the receipt's `by` is the session account, not the shared profile.
- First-account bootstrap P2 fixed: `setupCodeMatches` is a timing-safe sha256 compare (server.mjs:147-148); missing or wrong code gets 403 and is audited as `first-account-refused` (server.mjs:478); the code is printed in the console only while no account exists; `#sk-setup` field exists (index.html:1512).
- Export-credential P2 fixed: `FLIGHT_EXPORT_CREDENTIALS` binds a setting name to https origins; unbound settings refused at save (server.mjs:836) and re-checked at delivery (server.mjs:290); folder jobs return before that check, so local folder exports are unaffected; malformed config stops startup.
- Atomic lockout counter: single upsert in both store dialects; five concurrent failures lock exactly once.
- MRB-to-CAR link: `raiseCAR` writes `board.carId = car.id` inside the command; unknown mrbId is refused.
- Maintenance attribution: `openedBy`/`closedBy` use the session account; `closeMaintenance` refuses same-credentialId verification (index.html:7449-7466).
- ATP assets take the given workspace state (index.html:6284); material confirm refuses a lot no longer in `availableLotsFromLedger` (index.html:6164); returns into a depleted lot read unfiltered `inventoryLotRecords`, so conformity and build class are preserved.
- React Plan persistence: build-react passes `() => { if (save()) render(); }` as onMutation for renderPlan; Hangar milestone-risk button passes the work order id (was the whole object); trace search lists archived orders.
- Migration: quarantined evidence exported; multi-role accounts created with the first role only, the rest through the audited role-change route citing current training; grants and Support Access not copied and listed for manual re-grant; `needsTraining` blocks apply.
- PostgreSQL: audit chain verified at startup (refuses to open on tamper); record_extracts append-only triggers; export jobs keyed per finalized version with a one-time SQLite table rebuild preserving existing jobs; workspace-init race closed via the null-etag check under the advisory lock; definite Jira 4xx releases the pending idempotency row.
- Self-grant hole remains closed (unchanged): server roles action refuses any self-target; engine setRoles/recordTraining/issueStamp/updateStamp refuse the signed-in account; primary-role dropdown handler refuses self-target; engine refusals map to 403 with action-refused audit and unchanged ETag. Pinned by tests/test_frozen_contract.mjs.
