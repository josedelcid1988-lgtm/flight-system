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
| `node tests/qa_multi.mjs` | 165 checks across modules (Flight Control, Flight Plan, Flight Maneuver). |
| `node tests/pilot_rehearsal.mjs` | Three scenarios run through the real pilot accounts. |
| `node tests/stable_test.mjs` | Table layout stability across both builds, four widths and eight views (64 checks). Seeds its own Master Access account; no file on disk is needed. |
| `node tests/qa_access.mjs` | Production `index.html`: first-account setup, reload, role functions, invalid stamp refusal, master creation, password reset, unauthorized creation refusal, in-place account switch. |
| `node tests/qa_master.mjs` | Production `index.html` with the curated sample: all six buy-off types, FAIR and AQI signatures, signed override payload, ordinary-role refusal, holds, persistence. |
| `node tests/qa_operator.mjs` | `demo.html`: operator cues (current operation, beacon, blocked state, reduced motion, mobile) and unchanged records. |
| `node tests/qa_ui.mjs` | Production `index.html`: landing photograph, glossary, mobile navigation, search focus, reduced motion, recent-items key. |
| `node tests/test_v74.mjs` … `test_v80i.mjs` | Feature suites: FAIR and conformity (v74), inspection reject and prints (v75), unreleased WIs and standard rework (v76), Certification seat, stock NC source and Use for Dev (v77), record prints (v78), MRB auto-decision and scrap closure (v79), QA-approved rework pairs (v80), FAIR links and revision authority (v80c to v80e), rework entry points and buy-off flow (v80h, v80i). |

| `node tests/test_support_access.mjs` | Support Access: granted only through Master Access, reason required, activity entry, Support Overrides log, a saved account named demo loads as an ordinary account. |
| `node tests/test_demo_build.mjs` | `demo.html` and the demo fixtures are current, every deviation is marked, production has no demo username check, pilot seats keep their real role, the demo watermark on pages and prints. |
| `node tests/test_demo_seed_dates.mjs` | The demo seed's operational dates (open due and start dates, the MDL date of a package with no 8130-9, planned need dates, open request and CAR due dates, stamp expiries) move to the first-load day, a CAR or an order whose MDL date moves gets one Demo build history entry naming the old and new dates, and nothing signed or recorded moves. Opens the demo fixtures with the browser clock 60 and 400 days ahead: the workspace validates, every manifest verifies, no MDL-age gap, no expired stamp. |
| `node tests/test_demo_cal_snapshot.mjs` | The demo moves the shipped Calibrated Tool Log snapshot (its label and every tool expiry) forward by the same days as the seed dates, counted from the first-load day, so demo tooling does not all expire. Opens the demo fixtures first loaded on 2027-09-01 and 2028-06-01: the usable-tool count is the one the seed had on its capture day, some tools still come due, a later visit keeps the first-load day, and signed buy-offs keep the tool expiries they recorded. Production's snapshot lines are pinned by SHA-256 and its engine still reports the shipped expiries. |
| `node tests/test_inspect_own_work.mjs` | Nobody inspects their own work, for every role including Master Access and Support Access. |
| `node tests/test_sod_history.mjs` | Separation-of-duties history that must not be lost: a person who checks off a step and unchecks it stays recorded as a performer, so they still cannot inspect that work; a WI keeps all its authors (42 here, past the 200-entry history), so the first author still cannot peer-review or release it; standalone, Support Access is granted only after its Support Overrides log entry is written and saved, a failed write or save leaves the account unchanged and no entry behind, and a Master Access account cannot grant it to itself. |
| `node tests/test_mrb_seat_caps.mjs` | MRB seats and the QA Manager safety buy-off follow capabilities, with the refusal paths. |
| `node tests/test_build_stamp.mjs` | The build id and index.html SHA-256: the stamp tool, and the stamp on manifests, history events, Support Overrides entries and prints; older unstamped records still verify. |
| `node tests/test_frozen_contract.mjs` | The frozen contract: storage keys, form numbers and every separation-of-duties rule in the engine, plus the WI author and peer reviewer release refusals. Fails if any of them changes. |
| `node tests/test_authority.mjs` | Stamp placeholders and SKY numbering, issue, import and export; the training requirements list with QMS references and retraining; person training records; several stamps per person; conformity and AQI grants plus extra roles tied to training (never to oneself, eligible roles only, paused on lapse); inspection and MRB capabilities follow roles; stamp PINs with scrypt. |
| `node tests/test_nff_boundary.mjs` | Development NFF stays out of every flight and production path: no FAI or FAIR, no conformity package, 8130-9 or 8130-3, no issue or rework into Production or Development, pedigree one way, first-article slot untouched. |
| `node tests/test_calibration_chain.mjs` | The hash-chained calibration log: each entry links to the one before it and the workspace head records the count and last hash, so a truncated log, a removed or reordered entry, or an import that lost its head fails validation with a plain reason; a retired tool cannot return by truncation; once a workspace has held an entry it keeps a start marker bound to the first entry, so deleting both the log and its head fails validation while a new workspace with no entries still validates, and upgrade adds the marker to a workspace recorded before it; a log recorded before the chain is sealed once on upgrade and still validates; standalone, if browser storage refuses to save that seal or the added marker, the load stops with a message naming which one; the server refuses to initialize from a truncated or deleted log and refuses any write that drops or changes a stored entry. The hashes are unkeyed SHA-256: this catches mistakes and bad imports, not someone who recomputes every hash or removes the log, head and marker together. |
| `node tests/test_mirror.mjs` | The persistence mirror: off by default, on, outage and recovery, idempotent retry, no password or PIN material, tamper detection, backup, restore test and restart on the restored file. |
| `node tests/test_engine_authz.mjs` | Engine write paths reachable as server actions check the caller's capability: removing a file from a Flight Maneuver record (dispo-nc or approve-nc, and never once the record is closed, checked on a resolved NC, a decided MRB board, a cancelled CAR and a closed problem report, while any role may still attach to any record, over the engine and the server action), voiding a serial, recording a NetSuite posting, storing a quality study value, operation attachments, incorporating MCRs, linking a rework order, and signing an audit finding or an audit closed each need the capability of the page control that calls them, and an AOG escalation is refused until it is due. Each rule is checked for the refusal (nothing changes) and the role meant to do it. |
| `node tests/test_role_refusal_message.mjs` | A role refusal reads the same from every engine scope: the MES engine and the Flight Maneuver engine both build it from `MES.roleDeniedMessage`, each refusal leaves the workspace unchanged, and the wording appears once in the engine source. The Flight Maneuver refusal does not depend on load order: a maneuver engine evaluated before the MES engine gives the same message, and one with no MES engine still refuses instead of throwing. |
| `node tests/test_server.mjs` | SQLite API: scrypt sessions, lockouts, shared ETags, evidence, archive, extracts, exports, engine actions and hash-chained audit. |
| `node tests/test_server_security.mjs` | Server hardening, each rule with the request it refuses: the unauthenticated page carries no account directory; the server binds 127.0.0.1 unless a host is named; sessions are stored only as SHA-256 hashes and older plaintext sessions end on upgrade; evidence no record names is readable only by its uploader and a manager; unauthenticated health is liveness only; demo.html is served only when the operator asks; an unexpected failure returns a reference, not the error text; the model adapter accepts only operator-listed settings; only reviewed engine commands are remotely callable; a change whose audit row cannot be written is not committed. |
| `node tests/test_server_ui.mjs` | Browser sign-in, shared workspace hydration, a real MES mutation saved to the server, and account-profile round-trip. The AQI check re-completes the fixture's 8130-9 through the server action route (void, current MDL copy, new form by a separate preparer), so it does not depend on the calendar. |
| `node tests/test_server_stamp.mjs` | The server stamps a checkout's unstamped index.html in memory at start, so the page it serves carries the release SHA-256 for its build, never the placeholder; a stamped release file is served as it is. |
| `node tests/test_server_record_path.mjs` | With a server configured, a record change is sent to the server as an action, or refused before it runs when there is no server session, the shared workspace has not loaded, or an earlier change is unconfirmed: nothing is changed, stored in the browser or queued. Evidence and discussion commits are refused the same way. Standalone use still saves in the browser. |
| `node tests/test_server_first_load.mjs` | First sign-in against an uninitialized server on a 6x CPU-throttled page: no record change is sent while the first load is in flight, the workspace initializes and syncs, and a browser workspace that predates the page is still refused until migrated. |
| `node tests/test_react_record_links_ui.mjs` | The React activity record builds its record links as React elements from the event text, not from an HTML string: `<b>` and `<img onerror>` in an action or work order show as text and run nothing, even if the legacy `recordLinks` stops escaping; every record link, its target and its order match the legacy activity template; a React record link opens its record. |
| `node tests/test_record_link_builder_ui.mjs` | Record links are built once: `index.html` holds the only record patterns, the split of an activity line into text and links, and the attributes of a link (`window.FlightRecordLinks`). The legacy `recordLinks` template and the React `RecordLinks` render the same activity text to the same buttons, attributes, attribute order and link order; the React source keeps no copy of the patterns or the link attributes. A malformed work-order field that is another record id (`ATP-123`) links the ticket once and writes no button inside another button's attribute, in both paths. |
| `node tests/test_react_history_ui.mjs` | Every React record history (Flight Maneuver records, work-order activity record, trace report, Master WI) matches its legacy template entry for entry: action, actor with credential, time and order. Markup in an entry (`<b>`, `<img onerror>`) prints as text; no element is created and no handler runs. |
| `node tests/test_react_screens_ui.mjs` | The React screens routed in this build (plan home, QMS records, trace report) render without page errors, and the trace report receives the searched serial. WI library and detail, Flight Maneuver record details, QMS configuration, the support log and work order detail stay on legacy until their React versions match the legacy behavior. |
| `node tests/test_media_commit_ui.mjs` | The evidence, discussion and profile commit refuses an invalid workspace before browser storage, the server or the mirror sees it, with a plain reason, and commits a valid one. |
| `node tests/test_jira_integration.mjs` | Jira Cloud issue creation from canonical ECR/SPR/SCAR records, server-only secrets, caller authorization, saved issue linking, persistent idempotency, restart replay, uncertain-response refusal, and ECR UI flow. |
| `node tests/test_archive_proto_scan.mjs` | Issue #174: `tools/scan-archive-proto.mjs` against SQLite stores: a clean archive reports 0 and exits 0, a row with a nested own `__proto__` key is listed with its work order and path and exits 1, 5000 levels of nesting scan without a stack overflow, a row still in the `-wal` of a running server is read, an unreadable row, a missing store or a store without an archive exits 2, and the store files are byte for byte unchanged every time. `tests/postgres/archive_proto_scan.mjs` (in `npm run test:postgres`) checks the same on PostgreSQL (archive row count and checksum unchanged, connection string and password never printed), the read-only transaction, that no table is created, and the server's startup check against PostgreSQL. |
| `node tests/test_server_archive_check.mjs` | The server runs the same scan once at startup, after it listens: a clean SQLite store logs `archive __proto__ check: N rows scanned, 0 flagged`, a store with a planted row logs a warning naming the work order and path, the archive rows are unchanged, and a scan error logs a warning while the server keeps answering. |
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
