# Phase 1 command-coverage audit: whole-workspace write inventory

Audited tree: `flight-v82-datum-port` @ `ebfa69b2f6` (v82 handoff build).
Auditor: Jinx (Muse AI). Date: 2026-09-28.
Scope: every path in the browser engine that writes the whole workspace, classified per the v82 handoff release blocker "Replace ordinary whole-workspace writes with role-checked server commands and add bypass refusal tests" (HANDOVER-v82.md, due 2026-09-29). Read-only analysis; no server code was changed.

## How the command boundary works (verified, not assumed)

1. Client wrapper: `index.html:10835` `trackServerMutations`, applied at `index.html:10862` to the MES, FlightPlan and FlightManeuver engine objects. Any exported function whose name matches the verb-prefix list or the exact set, and is not excluded, is wrapped. When a wrapped call succeeds (`result.ok === true`) with the live workspace as its first argument, the call is queued as `{action: '<ns>.<name>', args}`.
2. Matcher sets: client at `index.html:10831-10833`, server at `server/mes-host.mjs:110-112`. Verified byte-identical: the verb-prefix regex, the exact set `{containNC, effectivenessCheck, pfmeaSafetyBuyoff, pruneExpiredNotices}`, and the 16-entry exclude set are the same on both sides.
3. Flush: `index.html:10867` `flushServerActions` POSTs each queued command to `/workspace/actions/<ns>.<name>` with the workspace ETag in If-Match.
4. Server: `server/server.mjs:653` resolves the action via `host.resolveAction` (`server/mes-host.mjs:113`), runs the engine function inside `host.withAccount(session.account, ...)`, so the session's role gates apply. Unknown actions get 404, refused actions get 403 plus an audit record.
5. Legacy snapshot: PUT `/workspace` (`server/server.mjs:616`) is accepted exactly once to initialize an empty server (QA Manager or Master Access only). Any changed snapshot after init is refused with 403 and audited.

The earlier audit's three fixes are confirmed in place: `containNC`, `effectivenessCheck` and `pfmeaSafetyBuyoff` are in the exact set on both sides, with live call sites at `index.html:12969`, `index.html:12956` and `index.html:12887`, and `pruneExpiredNotices` at `index.html:10995`. `tests/test_server.mjs:262-293` covers the allowlist, the 404s for non-commands, and the 403 role refusals.

## Write-path inventory

Class: (a) routed through a role-checked server action, (b) legacy snapshot path, (c) unmatched/other.

| # | File:line | Write path | Class | Gap or not |
|---|-----------|------------|-------|------------|
| 1 | index.html:10867 | `flushServerActions`: queued engine commands POSTed to `/workspace/actions/<ns>.<name>` | (a) | Not a gap. Covers roughly 183 wrapped mutators (verb-prefix match) plus the 4 exact-set commands. The server re-runs each under the session account (`server/server.mjs:653`). |
| 2 | index.html:11041 | Model adapter config form POSTs directly to `/workspace/actions/MES.configureModelAdapter` | (a) | Not a gap. Role-checked server side (the server also requires the named environment setting). Bypasses the local queue by design, then refreshes the workspace. |
| 3 | index.html:10898 | `pushWorkspace`: when the action queue is empty, PUTs the full workspace snapshot to `/workspace` | (b) | Not a gap on the server: changed snapshots are refused after init (403 plus audit). Note the client still attempts this PUT for every non-command write, so every (c) mutation below can never reach the shared server this way. |
| 4 | index.html:10901 | `loadServerWorkspace`: first-run PUT initializes an empty server from the local snapshot | (b) | Not a gap. Allowed once, QA Manager or Master Access only; the server runs upgrade, `ensureMasterWIs`, `FlightPlan.ensure` and `syncBlockers` during init. |
| 5 | index.html:10903 | `save()`: `localStorage.setItem(KEY, JSON.stringify(state))` | (c) | Not a gap for shared records. Device-only persistence; it is also what persists every (c) write below. |
| 6 | index.html:10903 | `save()` calls `MES.syncBlockers(state)` (alias of `syncPlanningBlockers`, def `index.html:7248`) before persisting | (c) | GAP, primary. It mutates blocker rows (voids, resolves, opens new ones) on every save, but the name matches neither the verb list nor the exact set, so it is never queued as a command. Blocker changes stay local and are discarded by the next `refreshServerWorkspace`. See fix below. |
| 7 | index.html:10790-10903 | Boot self-heal: `MES.upgrade` (def 5838), `MES.repair` (def 7173, excluded), `MES.autoAssignSerials` (def 4693, unmatched), `MES.ensureMasterWIs` (def 3907, unmatched), `FlightPlan.ensure` (def 7805, excluded) | (c) | Minor gap. Legitimate load-time migration, but the mutations are local-only and can never become commands. Acceptable if documented as migration-only. |
| 8 | index.html:10863 | `refreshServerWorkspace` runs `MES.ensureMasterWIs` and `FlightPlan.ensure` on the freshly fetched server state, then saves locally | (c) | Minor gap. The local copy diverges from the server ETag content immediately after refresh. Consider running these server-side or not persisting their output. |
| 9 | index.html:9574, 9575, 9867, 9917, 11982, 14652 | Render paths call `MES.syncAssignments(state)` (def `index.html:3400`, excluded), which rewrites `state.assignments` | (c) | Minor gap. Render-time mutation persists on the next save but never becomes a command. See fix below. |
| 10 | index.html:11051 | `render()` calls `FlightManeuver.ensure(state)` (def `index.html:8807`, excluded) on maneuver views | (c) | Minor gap. Same fix options as row 9. |
| 11 | index.html:10903 | `save()` calls `MES.repair(state)` when validation fails (excluded by design) | (c) | Not a gap. Deliberate exclusion (migration helper). Note: a repaired workspace still cannot sync via PUT after init; the user must re-apply changes as commands. |
| 12 | multiple | Deliberately excluded functions used read-only or engine-internally: `MES.verifyManifests`, `MES.verifyAIActionLog` (404 at the action route, covered by `tests/test_server.mjs:266-267`), `MES.icalExport`, `MES.ticketAttachments`, `MES.openProcessECRs`, `MES.stampCheck`, `MES.stampCredential`, `MES.stampHolderFor`, `MES.stampRegisterCsv`, `MES.buyoffCredential`; `MES.signManifest` runs only inside wrapped outer actions (for example `MES.aqiSign8130_9`, def `index.html:5317`), so it executes server-side as part of the outer command | (c) | Not gaps. Exclusions are symmetric in both allowlists. |
| 13 | index.html:8756 | `FlightManeuver.seedDemoRecords` mutates state but has no call sites in `index.html` | (c) | Not a gap in production. Dead code in this tree; leave it out of the action surface. |
| 14 | index.html:13241 | `sk-mirror` `commit(ws)` POSTs workspace-derived record entities to `<mirror>/api/v1/writes` | (c) | Not a gap for the primary server. Separate opt-in mirror target, not the shared workspace. |
| 15 | tools/demo/overlay.js:15-16 | Demo build seeds `localStorage` with the sample workspace | (c) | Not a gap. Demo-only file, not part of the production build. |

Checked and cleared (not write paths): `assets/flight-ui.js` uses `localStorage` only for UI preferences (filters, compact view). `assets/floor-picker.js`, `planner/big3.mjs` and `src/react/flight-ui.jsx` contain no workspace write paths; the React bundle calls the already-wrapped engine through props. `index.html:13586` re-wraps `MES.markNetSuitePosted`, but it delegates to the queue-wrapped base function, so command routing is preserved. No direct field edits (`state.X = ...`) were found in app scripts, so engine-function coverage is the complete mutation surface.

## Summary counts

- Total write paths inventoried: 15
- (a) role-checked server action: 2
- (b) legacy snapshot path: 2
- (c) unmatched/other: 11
- Gaps needing implementation: 5 (1 primary, 4 minor)

## Fixes for Claudia (owner: Claudia, due: 2026-09-29 per the handoff blocker)

1. Primary, row 6 (`MES.syncBlockers`): add `'syncBlockers'` to `serverMutatorExact` (`index.html:10832`) and to `actionExact` (`server/mes-host.mjs:111`). Alternative: run `syncBlockers` server-side in the action commit path (`server/server.mjs`, after the engine function succeeds), which keeps it off the client surface entirely. Add the name to the allowlist assertion in `tests/test_server.mjs:262` and a role-refusal case modeled on `pruneExpiredNotices` (`tests/test_server.mjs:281-293`).
2. Minor, rows 9 and 10 (`MES.syncAssignments`, `FlightManeuver.ensure`): make them pure (derive and return without writing `state`) or add both names to the exact sets in `index.html:10832` and `server/mes-host.mjs:111` with matching tests.
3. Minor, rows 7 and 8 (boot self-heal and refresh ensures): either document as accepted migration-only behavior, or move the ensure calls into the server action commit path so device and server converge.

## What this audit could not verify

- A full git clone was not available in this environment (the `gh` CLI is unauthenticated here), so the analysis used the GitHub API tree listing at `ebfa69b2f6` plus 13 fetched files. `tools/migrate-browser.mjs` (a Node tool, out of browser scope) and test fixtures were not examined.
- All roughly 183 wrapped call sites were not individually checked for passing the live `state` object as the first argument; the wrapper silently skips queueing otherwise.
- Every wrapped mutator was not individually checked for returning `{ok: true}` on success, which the wrapper requires before queueing.
