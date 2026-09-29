# Testing Flight System

The product build id is set in `VERSION.md`. The SHA-256 stamp is generated, not
committed: CI and the release process run `node tools/stamp-build.mjs`. Before running
the suites locally, stamp the working copy (`node tools/stamp-build.mjs`, then
`node tools/build-demo.mjs`); before committing, put it back with `--clear` and
`build-demo`. Suite names such as
`test_v80.mjs` record when that suite was added. They are not the build id.

The product page is generated from `index.html`; the React Hangar is bundled
locally from `src/react/`. `server/server.mjs` provides the authenticated
shared-storage mode, and `server/mirror/` remains an optional append-only
mirror. Browser harnesses drive Chromium against the built files or the live
server, so browser failures are user-visible failures.

## Setup

```bash
npm i -D playwright && npx playwright install chromium
# No path setup: every harness resolves tests/fixtures, tests/shots and its result file from its own folder.
```

Every harness honours `CHROME_PATH=/path/to/chrome` when the Playwright package
and the installed Chromium do not match (for example on a machine that already
carries a browser under `PLAYWRIGHT_BROWSERS_PATH`). `qa_full` packages the
release zips on every run (`tools/package-release.mjs`); set `RELEASE_OUTPUT_DIR`
to check zips already built there instead.

## Fixtures in tests/fixtures

- `demo_qa150.html` and `demo_qa150_publish.html`: demo build carrying the
  150-work-order regression dataset. Most harnesses use the `_publish` copy.
- `demo_publish.html`: demo build with the small curated sample set (9 work
  orders, the LRU conformity package, FAIR, NC with MRB, CAR).
- `publish.html`: production build, all gates enforced.

Sign in with `demo` / `demo1234`. Other demo accounts: `master`, `quality`,
`mfgeng`, `engineering`, `certification`, `operations`, `tech`, `safety`, same
password. The demo build relaxes separation of duties, PIN entry and the stamp
binding so one person can walk a whole flow; the production build enforces them.
Every relaxation is listed in `docs/DEMO_DEVIATIONS.md`. Rebuild the demo and the
fixtures with `node tools/build-demo.mjs`; never edit them by hand.

## Run everything

```bash
node tools/run-suites.mjs            # every suite, mirror off (as shipped)
node tools/run-suites.mjs --mirror   # every suite again with the mirror on, then checks the server's chain
```

The runner fails a suite on a non-zero exit, a non-empty `FAILS` list, a failed
check or flow, a page error, or a skip that is not explained in
`tests/allowed_skips.json`. It writes `tests/suite_results.json` and, for a
failing suite, `tests/suite_<name>.log`. `--only a,b` runs named suites.

## Suites

| Command | What it covers |
| --- | --- |
| `node tests/qa_full.mjs` | 310 checks: engine rules, guards, signature manifest verification, UI flows, rendering at 1440 and 375 px. Current target: 310 pass, 0 skip, 0 fail. |
| `node tests/qa_e2e.mjs` | 30 end-to-end flows: every order type and every ticket type driven to closure, with actions, typed fields, role handoffs and gates counted per flow. Writes `qa_e2e_results.json`. |
| `node tests/qa_multi.mjs` | 161 checks across modules (Flight Control, Flight Plan, Flight Maneuver). |
| `node tests/pilot_rehearsal.mjs` | Three scenarios run through the real pilot accounts. |
| `node tests/stable_test.mjs` | Table layout stability across both builds, four widths and eight views (64 checks). Seeds its own Master Access account; no file on disk is needed. |
| `node tests/qa_access.mjs` | Production `index.html`: first-account setup, reload, role functions, invalid stamp refusal, master creation, password reset, unauthorized creation refusal, in-place account switch. |
| `node tests/qa_master.mjs` | Production `index.html` with the curated sample: all six buy-off types, FAIR and AQI signatures, signed override payload, ordinary-role refusal, holds, persistence. |
| `node tests/qa_operator.mjs` | `demo.html`: operator cues (current operation, beacon, blocked state, reduced motion, mobile) and unchanged records. |
| `node tests/qa_ui.mjs` | Production `index.html`: landing photograph, glossary, mobile navigation, search focus, reduced motion, recent-items key. |
| `node tests/test_v74.mjs` … `test_v80i.mjs` | Feature suites: FAIR and conformity (v74), inspection reject and prints (v75), unreleased WIs and standard rework (v76), Certification seat, stock NC source and Use for Dev (v77), record prints (v78), MRB auto-decision and scrap closure (v79), QA-approved rework pairs (v80), FAIR links and revision authority (v80c to v80e), rework entry points and buy-off flow (v80h, v80i). |

| `node tests/test_support_access.mjs` | Support Access: granted only through Master Access, reason required, activity entry, Support Overrides log, a saved account named demo loads as an ordinary account. |
| `node tests/test_demo_build.mjs` | `demo.html` and the demo fixtures are current, every deviation is marked, production has no demo username check, pilot seats keep their real role, the demo watermark on pages and prints. |
| `node tests/test_inspect_own_work.mjs` | Nobody inspects their own work, for every role including Master Access and Support Access. |
| `node tests/test_mrb_seat_caps.mjs` | MRB seats and the QA Manager safety buy-off follow capabilities, with the refusal paths. |
| `node tests/test_build_stamp.mjs` | The build id and index.html SHA-256: the stamp tool, and the stamp on manifests, history events, Support Overrides entries and prints; older unstamped records still verify. |
| `node tests/test_frozen_contract.mjs` | The frozen contract: storage keys, form numbers and every separation-of-duties rule in the engine, plus the WI author and peer reviewer release refusals. Fails if any of them changes. |
| `node tests/test_authority.mjs` | Stamp placeholders and SKY numbering, issue, import and export; the training requirements list with QMS references and retraining; person training records; several stamps per person; conformity and AQI grants plus extra roles tied to training (never to oneself, eligible roles only, paused on lapse); inspection and MRB capabilities follow roles; stamp PINs with scrypt. |
| `node tests/test_nff_boundary.mjs` | Development NFF stays out of every flight and production path: no FAI or FAIR, no conformity package, 8130-9 or 8130-3, no issue or rework into Production or Development, pedigree one way, first-article slot untouched. |
| `node tests/test_mirror.mjs` | The persistence mirror: off by default, on, outage and recovery, idempotent retry, no password or PIN material, tamper detection, backup, restore test and restart on the restored file. |
| `node tests/test_server.mjs` | SQLite API: scrypt sessions, lockouts, shared ETags, evidence, archive, extracts, exports, engine actions and hash-chained audit. |
| `node tests/test_server_ui.mjs` | Browser sign-in, shared workspace hydration, a real MES mutation saved to the server, and account-profile round-trip. |
| `node tests/test_server_stamp.mjs` | The server stamps a checkout's unstamped index.html in memory at start, so the page it serves carries the release SHA-256 for its build, never the placeholder; a stamped release file is served as it is. |
| `node tests/test_server_record_path.mjs` | With a server configured, a record change is sent to the server as an action, or refused before it runs when there is no server session, the shared workspace has not loaded, or an earlier change is unconfirmed: nothing is changed, stored in the browser or queued. Evidence and discussion commits are refused the same way. Standalone use still saves in the browser. |
| `node tests/test_server_first_load.mjs` | First sign-in against an uninitialized server on a 6x CPU-throttled page: no record change is sent while the first load is in flight, the workspace initializes and syncs, and a browser workspace that predates the page is still refused until migrated. |
| `node tests/test_react_screens_ui.mjs` | The React screens routed in this build (plan home, QMS records, trace report) render without page errors, and the trace report receives the searched serial. WI library and detail, Flight Maneuver record details, QMS configuration, the support log and work order detail stay on legacy until their React versions match the legacy behavior. |
| `node tests/test_media_commit_ui.mjs` | The evidence, discussion and profile commit refuses an invalid workspace before browser storage, the server or the mirror sees it, with a plain reason, and commits a valid one. |
| `node tests/test_jira_integration.mjs` | Jira Cloud issue creation from canonical ECR/SPR/SCAR records, server-only secrets, caller authorization, saved issue linking, persistent idempotency, restart replay, uncertain-response refusal, and ECR UI flow. |
| `node tests/test_migration.mjs` | Browser workspace migration dry-run, validation, report and copy verification. |
| `node tests/postgres/integration.mjs` | PostgreSQL store, account profiles, ETags, archive, exports, Jira idempotency rows and immutable histories. Requires a running PostgreSQL service; CI runs it on PostgreSQL 16. |
| `node tools/build-react.mjs --check` | Local React bundle and generated demo files are current. |
| `npm run check:paths` | Fails if repository files include a machine-specific absolute path. |

Each harness prints `FAILS []` or a list, and the browser page errors it saw.

## Where to look when something fails

State lives in `localStorage` under `skyryse-mes-work-order-v1`. Every write is
re-validated and rolled back if it would leave the workspace invalid, so a
failure that reports "invalid" points at the engine rule named in the message.
`MES.validate(state)` and `MES.diagnose(state)` are callable from the console.
