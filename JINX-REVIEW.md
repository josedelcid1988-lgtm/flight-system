## Owner direction 2026-09-28 (evening): record-coverage fixes before Oct 7 handoff (read first)

Jose reversed the "hand over WIP with gaps documented" plan. Every record-coverage gap below must be fixed before the Wed Oct 7 handoff to Hemant and IT, not delivered unfinished. Owner-confirmed priority: these three jump ahead of the P2/P3 cleanup queue.

Background: Jinx mapped every quality and product record write to server-covered or on-device (full table with file:line in Jinx's workspace at flight-system-review/record-coverage-map.md). Headline: every record type (WI, Stamp Log, Work Orders, Traceability, NC, MRB, CAR, approval logs, buy-offs, user info, training) already has a server path. The gaps to fix:

1. **Kill the dual-path.** Today the same record write goes to the server or stays on-device depending on whether a server session was active at that moment (trackServerMutations wraps the mutator, index.html:10862; save() always writes localStorage regardless, index.html:10930). Fix: when a server is configured, record writes require an active server session. No silent on-device saves for quality and product records. Recommended approach: refuse the write with a clear message telling the user to sign in, rather than silently persisting locally. Seeding functions (ensureMasterWIs, ensureStamps) stay on-device by design; read-only helpers and validation helpers are unaffected.
2. **Build the calibration record write path.** Today CAL_TOOLS is Object.freeze'd seed data (index.html:2106) with no UI, no MES mutator, and zero server code; calibration only enters records as references inside buy-offs. Build a real lifecycle for calibrated-tool log entries (create/update, append-only preferred; state your choice in the PR), server-covered through the normal mutator path like the other records, landing in the hash-chained server audit trail.
3. **Label the browser security log.** secLog (localStorage key skyryse-mes-security-v1, index.html:13356-13364) is on-device only and must never be mistaken for the server audit trail. Rename or relabel it in the UI so the distinction is obvious to IT.

Merge gate (current, owner 2026-09-28): Jinx final approval plus green CI on the exact head, then you merge through the PR button. Codex reviews automatically but its approval does not gate merges. Ship each fix as its own PR through the normal gate. Work split (owner, 2026-09-28 evening): Claudia owns fix 1 (dual-path). A second agent run by Jinx owns fix 2 (calibration write path) and fix 3 (secLog label) on branches jinx/calibration-write-path and jinx/seclog-label; it opens its own PRs, Jinx reviews them, and Claudia merges them through the PR button under the same gate. Coordinate on index.html: the second agent avoids the mutation-pipeline region (index.html:10853-10930).

# JINX-REVIEW.md (PR #11, head d1c5393c, updated 2026-09-28T22:45Z: Codex cross-review findings verified)
## Owner decision 2026-09-28: PR #25 stamp P1 (Codex finding)

Jose selected option 1: server stamps at start. Implement about 10 lines in server/server.mjs: at startup, if index.html is unstamped, the server stamps it in memory from VERSION.md using the same stamp tool, then serves and records that. This is PR #25's own P1 (records would otherwise carry build hash "unstamped"), so it belongs in PR #25, not a follow-up; the earlier "tooling and CI only" scope is overridden for this P1 data-integrity fix. Standalone users open the release zip per the docs. Sequencing note: PR #36 is blocked behind #25 (its unstamped index.html trips CI's hard gates until #25's new gate logic lands); PR #35's B4 is the same root cause, so both rebase after #25 merges.


## Owner direction 2026-09-28: v1 and v2 tracks (read first)

- This repository (flight-system) is now the **v2** track. Keep building the React upgrade and the MES feature work here toward a fuller MES. Do not trim this repo. The Sep 27 pause is lifted for v2 as of today.
- **v1** is a separate trimmed build for the Skyryse official release and pilot. It lives in a new separate repo, built by a separate Claude session from an older Flight System version with Flight Maneuver stripped out. Nothing in v1 changes your work here.
- Datum-OS is the owner's commercial product and stays separate. Do not copy code between Datum-OS and this repo in either direction.
- The merge gate (updated by owner 2026-09-28): Jinx final approval plus green CI on the exact head, then Claudia merges via the PR button. Codex reviews automatically but its approval does not gate merges. No auto-merge automation: it was parked by the owner on 2026-09-27, do not build it and do not propose it.

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

## Codex cross-review findings, verified by Jinx (2026-09-28T22:45Z, issue comment 5879847895 on PR #11)

Codex posted 10 findings on this head. I verified all 10 against the code. All 10 are correct; none are wrong. The P1 below blocks Codex's approval, and Codex's approval is part of the merge gate, so treat it as a merge blocker. The P2s are follow-ups: fix the cheap ones now, the rest in the next change.

### Blocker (P1, blocks Codex approval)

1. **Internal audit helpers are remotely callable.** `MES.recordAIAction` (index.html:7695, via Object.assign), `MES.logSupport` (index.html:7703), and `MES.noteDemoBypassRemoved` (index.html:7703) are on the sandbox MES object. The action allowlist regex in server/mes-host.mjs:110 admits the `record`, `log`, and `note` prefixes, and the `actionExclude` set (server/mes-host.mjs:112) does not list these three. So any authenticated account can POST the action endpoint and append a hash-valid fake AI skill execution (`recordAIAction`, index.html:3256), fabricate a Support Access override record (`logSupport`, index.html:2692), or create a purported system bypass-removal notice (`noteDemoBypassRemoved`, index.html:2709), bypassing the workflows that normally authorize those records. Fix: add all three to `actionExclude` in server/mes-host.mjs, or tighten the prefix regex so only real commands match.

### Follow-ups (P2, verified correct)

2. **Migration silently drops `extraRoles`.** Browser exports serialize accounts as `{ role, extraRoles: [...] }` (index.html:13226), with no `roles` array. The migration helper (tools/migrate-browser.mjs:43) only reads `user.roles` or the primary `role`, and line 53 strips `extraRoles`; line 56 builds `roleFollowUps` only from the `roles` array. A real export like `{ role: 'technician', extraRoles: ['qe'] }` therefore loses the QE role with no follow-up or warning. Fix: include `user.extraRoles` in the migration role list (migrate-browser.mjs:43) so secondary roles pass through the audited follow-up flow.
3. **Master Access training preflight gap.** `needsTraining` (tools/migrate-browser.mjs:57) exempts admin accounts, but PUT /auth/accounts (server/mjs:519-524) requires training for new admin accounts whose roles carry inspection/MRB authority. A migrated second Master Access account without training passes the dry run, then the import refuses it with 403. Note the import refusal is not atomic: the transaction loop does not break on refusal, so earlier accounts in the batch are committed before the 403 is sent. Fix: include Master Access in `needsTraining` when it will be created as a new account; consider breaking the loop on refusal.
4. **Unconditional JSON.parse on truncated audit detail.** Both stores truncate audit detail to 4000 chars (server/db-postgres.mjs:81, server/db.mjs:181), usually mid-JSON-string. server/mjs:767 does `JSON.parse(r.detail || '{}')` unconditionally, so after a large orphan-evidence report every later GET /api/evidence/report returns 500. Fix: tolerate parse failure (fall back to the raw string) or store a bounded valid summary.
5. **Shared planning records attribute to the wrong person.** `createProject` (index.html:7523), objectives (index.html:7530), milestones, sensitivity changes, and sprints record `by` from `state.profile` (the workspace-wide shared profile), not the authenticated session actor (`skAuth`, available via `withAccount`). A second manager creating a project without changing the shared profile records the first manager's name and credential. Fix: build attribution snapshots from the authenticated actor, with `state.profile` only as the standalone fallback.
6. **Bulk account writes race authority changes.** PUT /auth/accounts (server/mjs:492) runs its transaction without `tx.lockAuthority()`, while /auth/access takes it (server/mjs:387), and `existing` is read before the transaction. In a multi-client PostgreSQL deployment, an overlapping /auth/access role or grant change can be overwritten by stale values with no corresponding audit event. Fix: take the same authority lock and compare against freshly read transaction rows.
7. **No in-app route to archived work orders.** src/react/flight-ui.jsx:592 renders archived orders as plain text in the traceability table, and the file has zero references to the /api/archive endpoints, so users cannot view, print, or export the archived record through the app. Fix: link each result to an archive detail or drawer exposing the existing endpoints.
8. **Migration report reads wrong maneuver collection names.** tools/migrate-browser.mjs:76 reads `tickets`, `scars`, `fracas`, `escapes`, `pfmea`, but the upgraded schema stores stock NCs in `maneuver.ncs` and PFMEAs in `maneuver.pfmeas` (index.html:7933), and `fracas` is deleted on upgrade (index.html:8004). A migration containing stock NCs or PFMEAs reports zero for them. Fix: report the actual current collection names.
9. **Evidence supersession is not atomic.** The stores' conditional UPDATE ignores the affected-row count (server/db-postgres.mjs:193, server/db.mjs:175), and server/mjs:755-756 unconditionally writes the `evidence-supersede` audit entry and returns 200. In a race, the loser writes an audit entry naming a replacement that was never applied. Fix: have the store report a failed conditional update and return 409 without auditing the losing request.
10. **Archive export buffers all evidence in memory.** server/mjs:802-807 loads every recording, expands it to base64, and serializes another complete response object; an evidence-heavy archive can exhaust the Node heap and take down the server. Fix: stream a bounded archive format instead of materializing all bytes.

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
