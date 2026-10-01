# Flight System handover

For the in-house developer and IT, 30 September 2026. Build id and file hashes: `VERSION.md`. What
changed for this handover: `CHANGELOG.md`. Known limits: `KNOWN-ISSUES.md`.

This repository contains the app, its build tools, the authenticated server, and its test suites. The
browser experience is served from `index.html`; a local build bundles the React Hangar from
`src/react/flight-ui.jsx` into `assets/flight-ui.js`. There are no runtime CDN dependencies.

## 1. What it is

Flight System is the manufacturing execution and quality system for flight hardware built under AS9100D
and on the FAA 14 CFR Part 21 path. Its modules are:

| Module | What it does |
| --- | --- |
| **Flight Control** | Work orders cloned from released master work instructions (WIs); operations, step checks, buy-offs with stamps, PINs and calibrated tools; NC/IDR against an operation; FAI and the AS9102 FAIR; the LRU conformity package with the FAA 8130-9 and the 8130-3 record; the F-850-001 traveler; inventory and serial numbers; the Organization view (stamp register, accounts, Support Overrides log). |
| **Flight Plan** | Planned orders from released WIs, an MRP-style forecast, and conversion of a planned order to a work order. |
| **Flight Maneuver** | NC/IDR intake outside a work order, MRB boards, CAR with SCAR, SPR (the successor to FRACAS), escapes, PFMEA for critical safety parts, and quality metrics. |

`demo.html` is the same app with the separation-of-duties, PIN and stamp gates relaxed and a sample data
set loaded, for training and demonstrations. It is generated from `index.html` (section 8), and every
page and print says DEMO, NOT FOR ACCEPTANCE.

### How it holds data

Without server mode, the workspace and accounts live in browser storage. With server mode, the app
hydrates a shared workspace from the authenticated Node server and mirrors accepted writes to local
storage for recovery. The MES engine validates browser changes; the server also validates workspace
shape and evidence and exposes role-gated action endpoints. **Known release blocker:** the browser
still sends whole-workspace writes, and that route does not yet authorize each changed record by role.
Do not use the authenticated server as the production system of record until all mutating screens use
server-side MES actions. Details are in [`SECURITY_REVIEW-v82.md`](SECURITY_REVIEW-v82.md).

## 2. The rules and why they exist

These are enforced in the engine, not only in the screens, so no screen, import or console call can go
around them. The production build must keep every one; only the demo build relaxes them, and each
relaxation is listed in `docs/DEMO_DEVIATIONS.md`. `tests/test_frozen_contract.mjs` fails if any of the
separation-of-duties rules is removed or reworded.

Demo builds made before the demo had its own storage keys (D-38 to D-41) shared the account list,
session, security log, drafts, saved table filters and mirror queue with production in the same browser. On first open,
production removes what such a demo left (its accounts and every account they created, its queued
records, its security events, and the drafts and mirror sent index it could have touched). The accounts the
older demo made move to the demo's own account store, so they still work in the demo; a name the demo already
holds keeps the demo's account and the older one is set aside under `skyryse-mes-legacy-demo-accounts-v1`.
An account a person created while signed in to such a demo cannot be told apart from a production account, so
a standalone page then opens on an account review and nothing else, across reloads and identity provider
redirects. Only a QA Manager or Master Access account signs in to it (anyone else's session is ended and
switching account is refused); they confirm each account they recognize, and nobody confirms their own account
while another QA Manager or Master Access account exists to do it (the only such account confirming itself is
recorded as such). An account nobody recognizes is never confirmed: clear the browser's site data, or use the
server, before production use. Each step counts only once its security log entry is stored
(`legacy-demo-accounts-confirmed`, then `legacy-demo-reviewed` when every account is confirmed). With the server,
sign-in and accounts are the server's, so a notice stays on every page until a QA Manager or Master Access account
signed in to the server marks the review done, again only once that is logged. Drafts and partial sign-in failure
counts the older demo could have written are set
aside under `skyryse-mes-legacy-demo-*` keys; a lockout in force is kept. Every account creation is now written to
the security log (`account-create`), so this cannot recur unnoticed.

| Rule | What the engine does | Why |
| --- | --- | --- |
| The author of a WI cannot peer-review or release it | Anyone who edited a draft revision (created it, changed its title, operations, pictures, drawing status or critical safety flag) is refused at peer review, QA release, release against the drawing ECO, and release by the Safety Team buy-off. | Documents are approved by someone other than their author: AS9100D 7.5.2, 14 CFR 21.137(b). |
| The peer reviewer cannot release the WI or record its QA review | Refused by credential. | Two independent reviews means two people. |
| The requester of a closure or an engineering change cannot approve it | Refused by credential. A pedigree change needs two approvals from two different disciplines. | Approval is a separate act from the request: AS9100D 8.5.6 (control of changes). |
| One person holds one MRB seat | A second vote by the same person on another seat is refused, whatever their capabilities. | An MRB is a multi-discipline decision on nonconforming product: AS9100D 8.7.1, 14 CFR 21.137(h). |
| The 8130-9 preparer signs as the authorized inspector only after a warning | When the person who completed the 8130-9 gives the AQI signature, the engine stops with a warning they must acknowledge, then records the signature as self-signed on the record and in its manifest. (QA Manager decision, 26 Sep 2026; previously refused.) | The statement of conformity (14 CFR 21.53, FAA Form 8130-9) is attested by an authorized inspector; the self-signature is visible to the DAR and in the audit trail. |
| Nobody inspects their own work, except on Development NFF | An inspection buy-off or an inspection step check is refused for anyone who performed a build operation the inspection covers. No role is exempt, Master Access and Support Access included. On a Development NFF order (not for flight, not for credit) the builder may inspect, and the order history records that the exception was used; every other separation-of-duties rule still applies to NFF. Rejecting an inspection is open to anyone who may inspect, because a rejection only raises an NC and cannot release product. | Product is released by an authorized person independent of the work: AS9100D 8.6, 14 CFR 21.137(e). |
| The person who recorded a disposition or a root cause cannot approve or close it | Refused by credential. | Review of nonconformity and corrective action: AS9100D 8.7 and 10.2, 14 CFR 21.137(h) and (i). |
| A FAIR is reviewed by a second person before it is approved | The person who verified the FAIR (boxes 20 and 21) cannot sign box 22, and the Skyryse QA approval is refused until box 22 is signed. No role or override lifts either. | AS9102 Rev C Form 1 field 22 (required; should not be the individual in field 20). |
| An author of a PFMEA cannot give the Safety Team buy-off; the author of a standard rework cannot approve it | Refused by credential. | Independent review of risk analysis and of approved repair methods. |
| Every approval, buy-off and decision is signed | A signature manifest records the person, their credential, the time, what the signature means, a SHA-256 hash of the record content at that moment, and the build that recorded it. `MES.verifyManifests(state)` recomputes the hashes. | Quality records identify the person and cannot be altered unnoticed: 14 CFR 21.137(k), AS9100D 7.5.3, FAA AC 120-78A (electronic signatures and records). |
| Stamps, PINs, training and calibrated tools | A buy-off needs an active stamp of the right type assigned to the signed-in account, the holder's PIN (stored with scrypt), every training the operation requires, and tools inside their calibration window. A person may hold several stamps, one per buy-off type; each stamp after the first cites a training and pauses while that training is not current. Stamps are numbered SKY-0000 onward; the register ships with open placeholders SKY-0000 to SKY-0006. | Authorization of personnel and control of measuring equipment: AS9100D 7.1.5 and 7.2, 14 CFR 21.137(f). |
| Roles, grants and training | A person may hold more than one role. Inspection follows the Quality role; the four MRB seats follow their corresponding role capabilities. Optional current-training tiers by MRB disposition start Off. Conformity package work and the AQI signature are named grants that require a current training record and cannot be self-granted. An added role pauses while its required training is not current. The Safety Team buy-off needs `safety-buyoff`. `docs/ROLE_MATRIX.md` lists who holds each capability. | Competence and authority are assigned by role and supported by training evidence: AS9100D 7.2, 14 CFR 21.137. |
| Support Access | Granted only by Master Access with a reason. It can lift stamp binding for one operation at a time, and every grant and override is logged in the Support Overrides log. It cannot add an inspection or MRB role capability or lift separation of duties. | A controlled, visible way through a data problem during the pilot, instead of a hidden bypass account. |
| Development NFF never reaches a flight path | A unit built on a Development NFF order cannot be issued into a Production or Development order, cannot be the rework source of one, cannot have an LRU conformity package, an 8130-9 or an 8130-3, is never an FAI order or carries a FAIR, and its pedigree never changes away from NFF. NFF orders do not use up the first-article slot of a WI revision. No role or override lifts this. | Not-for-flight hardware must not gain airworthiness paperwork or enter conforming product: AS9100D 8.5.2 and 8.7, 14 CFR 21.137(h). |
| Training requirements | The QA Manager keeps the list of trainings in the system (code, name, validity, LMS course). Every addition or change cites the QMS document and revision that drives it and a reason, and a revision can require retraining: from then on, records entered before it no longer count. ESD and FOD follow the operation callouts; any other training is ticked on the operation. Training records are entered per person. | Training is controlled by the QMS and changes with it: AS9100D 7.2 and 7.5. |
| Every record names its build | Signature manifests, history events, Support Overrides entries, mirrored records, exports and prints carry the build id and the SHA-256 of `index.html`. | Any acceptance traces to the exact software that recorded it (configuration control of the tool that produces quality records). |
| State is valid after every write | Validate after the change; roll back if invalid. | A quality record is never partly written. |
| Plain, specific screen text | Each refusal says what is blocking and what to do next. No em dashes. | People on the floor act on the message without a manual. |

Why the design looks like this:

- **One file, no dependencies.** It runs from disk on a locked-down bench machine, is simple to host, and
  can be validated as one artifact with one hash. The cost is a large file; the map in section 5 keeps it
  navigable.
- **Rules in the engine, not the screens.** The same checks apply to every path into the data, and the
  suites exercise them directly.
- **Validate the whole workspace on every write.** Slower than per-field checks, but it makes an invalid
  state impossible rather than unlikely.
- **A mirror rather than a server-first rewrite.** Durability and tamper evidence arrive without touching
  the validated write path, and the app keeps working when the network does not.

## 3. Frozen names

Do not rename these. Saved workspaces, printed forms and the audit trail depend on them.

| Kind | Names |
| --- | --- |
| Storage keys | `skyryse-mes-work-order-v1` (workspace), `skyryse-mes-auth-v1` (accounts), `skyryse-mes-sync-queue-v1` (mirror queue). Also in use: `skyryse-mes-session-v1`, `skyryse-mes-oidc-v1`, `skyryse-mes-security-v1`, `skyryse-mes-evidence-v1` (IndexedDB), `skyryse-mes-sync-sent-v1`, `skyryse-mes-sync-client-v1`. |
| Form numbers | F-850-001 (traveler), F-860-004 (conformity tag), AS9102 (FAIR), FAA 8130-9 (statement of conformity), FAA 8130-3 (authorized release certificate). |
| Record numbers | The prefixes in use (WO-, MWI-, NC-, CAR-, SPR-, MRB-, STP-, SNL-, SUP-) and their widths. |
| Workspace schema | `state.version` 3. Adding an optional field is fine; changing the meaning of an existing one needs an upgrade step in `MES.upgrade`. |

`tests/test_frozen_contract.mjs` fails if a storage key, a form number or a separation-of-duties rule
changes.

## 4. Repository map

| Path | What it is |
| --- | --- |
| `index.html` | The production app. |
| `demo.html` | The demo build. Generated; never edit by hand. |
| `assets/` | Landing photographs. |
| `src/react/flight-ui.jsx`, `assets/flight-ui.*` | React Hangar source, generated JavaScript, and styling. |
| `server/` | Authenticated MES server, SQLite/PostgreSQL stores, and optional append-only mirror. |
| `docs/DATABASES.md` | On-prem setup, database selection, backup, and PostgreSQL checks. |
| `tools/stamp-build.mjs` | Writes the build id and the SHA-256 of `index.html` into its head. |
| `tools/build-demo.mjs`, `tools/demo/` | Builds `demo.html` and the demo test fixtures from `index.html`. |
| `tools/role-matrix.mjs` | Writes `docs/ROLE_MATRIX.md` from the role table in `index.html`. |
| `tools/run-suites.mjs` | Runs every suite, mirror off or on. |
| `tools/release-report.mjs` | Writes the release record into `VERSION.md`. |
| `tools/package-release.mjs` | Builds the production and demo release zips; `--verify` checks them. |
| `tests/` | Playwright and Node suites, their fixtures, and `allowed_skips.json`. See `TESTING.md`. |
| `.github/workflows/ci.yml` | CI (section 9). |
| `docs/TECHNICAL_MANUAL.md` | Screen-by-screen and rule-by-rule reference. |
| `docs/BACKEND_CONTRACT.md` | The contract a future server-side engine must meet. |
| `docs/ROLE_MATRIX.md`, `docs/DEMO_DEVIATIONS.md` | Generated references. |
| `docs/QA_INSPECTION_2026-09-25.md` | The last independent inspection of both builds. |

## 5. Map of index.html

Line numbers drift with every change, so find a block by its anchor.

| Anchor to search for | Approx. line | What is there |
| --- | --- | --- |
| `<meta name="fs-build"` | 1 | Build id and SHA-256, written by `tools/stamp-build.mjs`. |
| `window.skTable` | 2 | Shared table sort and filter state. |
| `<style id="skyryse-theme">`, `skyryse-qa-fixes`, `flight-plan-styles` | 125 to 1500 | Styles. |
| `<script id="sk-identity">` | 1500 | Sign-in: local accounts, the Okta seam (`window.SK_IDENTITY`), sessions. |
| `function skBoot()` | 1620 | The sign-in gate and first-account setup. |
| `root.MES = MES` (the block that ends there) | 1870 to 6040 | **The engine.** Reference data, stamps, profiles, signature manifests and their verification, Support Access, validation, repair, upgrade, and every work order, WI, FAIR, conformity and ticket rule. `const MES = {` near the end lists what it exports. |
| `root.FlightPlan = FlightPlan` | 6040 to 6210 | Flight Plan engine: planned orders and conversion. |
| `<script id="sk-maneuver-engine">` | 6210 to 7150 | Flight Maneuver engine: NC/IDR intake, MRB, CAR/SCAR, SPR, escapes, PFMEA. |
| `skyryse-mes-evidence-v1` | 7150 | Evidence recordings in IndexedDB. |
| `// Master WI module` | 7370 | WI editor and step-by-step instructions (screens). |
| `// Inventory and serial number records` | 8450 | Inventory and serial screens. |
| `const KEY='skyryse-mes-work-order-v1'` | 9000 | App shell: `state`, `save()`, `render()`, navigation, dialogs, prints (`printRecord`, `markDocument`). |
| `<script id="sk-maneuver-ui">` | 10700 | Flight Maneuver screens. |
| `<script id="sk-tables">` | 11070 | Sortable and filterable tables. |
| `<script id="sk-mirror">` | 11160 | Mirror client: queue, backoff, header indicator (`window.SK_MIRROR`). |
| `<script id="sk-hardening">` | 11335 | Security log, idle lock, stamp register administration, audit export, and the integration seam (`window.SK_INTEGRATIONS`, `window.skIntegrations`). |
| `<script id="flight-system-experience">` | 12600 | Landing and dashboard. |

The console is a useful map too: `Object.keys(MES)`, `Object.keys(FlightManeuver)`,
`Object.keys(FlightPlan)`.

## 6. Server storage

`server/server.mjs` is the authenticated MES server. It serves the app, enforces account sessions and
roles, runs MES actions, and stores the shared workspace, evidence, archive and audit history. SQLite
(WAL mode) is the default; PostgreSQL is available with `FLIGHT_DATABASE_URL`. Both backends use the
same async store contract. Setup, backup and PostgreSQL integration instructions are in
[`docs/DATABASES.md`](DATABASES.md).

`server/mirror/` is a separate optional browser mirror. It keeps its append-only client write log and
does not replace the authenticated MES server. Its protocol and restore checks are documented in
[`server/README.md`](../server/README.md).

## 7. Integration seams

Every seam is a configuration object at the top of its block, empty by default, so the app runs today
with manual handoffs and IT connects each system without changing the rules.

| System | Seam | Today | To connect |
| --- | --- | --- | --- |
| **Okta** (identity) | `window.SK_IDENTITY` in `sk-identity`: `provider: 'okta'`, `issuer`, `clientId`, group-to-role map. OpenID Connect authorization code flow with PKCE. | Local accounts; the first account becomes the access administrator. | Create the Okta SPA app and groups, fill the values, map groups to the roles in `docs/ROLE_MATRIX.md`. |
| **Hosting** (cloud or on-prem) | `server/server.mjs` serves the app and authenticated API. | SQLite on a local/private server; PostgreSQL is optional. | Follow `docs/DATABASES.md`, put the service behind TLS and an internal reverse proxy, and resolve security issue 12 before authoritative production use. |
| **NetSuite** (via an MCP bridge) | `window.SK_INTEGRATIONS.mode = 'mcp'` and `endpoint`; `window.skIntegrations.netsuite` posts to `/netsuite/item-availability`, `/netsuite/purchase-requisition` and `/netsuite/assembly-build`. | `mode: 'local'`: stock comes from the embedded snapshot, and postings are exported as CSV (`MES.netsuiteCsv`) and marked posted by hand. | Stand up the bridge (it holds the NetSuite credentials; the app never does), set `mode` and `endpoint`; the returned reference is recorded on the order. |
| **Jira** | `SK_INTEGRATIONS.jira` and the bridge route `/jira/issue`. | SPRs, SCARs and design ECRs queue on the Quality Hangar and the key is typed in. | Point the bridge at Jira; the app records the key and receives status. |
| **PDM** (SolidWorks) | `SK_INTEGRATIONS.pdm`. | ECO numbers and drawing links are recorded by hand on the design ECR and the WI. | A bridge route for released revisions and ECOs. |
| **LMS** | `SK_INTEGRATIONS.lms` (course ids for ESD and FOD). | An access administrator records training expiry on the stamp register. | Feed expiry dates to the stamp register; the buy-off training check already reads them. |
| **Slack** | `window.skIntegrations.slack.post` (route `/slack/post`); an operation can link a Slack thread. | Messages are saved locally on the operation and say they were not sent. | A bridge route with a Slack app token held server-side. |
| **Persistence** | `window.SK_MIRROR.url` and `token`. | Off. | Section 6. |

## 8. Working on it

- Change `index.html` or `src/react/flight-ui.jsx`, then run `node tools/build-react.mjs` and
  `node tools/build-demo.mjs`, and commit the generated files. A change to a role or capability also
  needs `node tools/role-matrix.mjs`. Do not commit a build stamp: `index.html` keeps the placeholder
  `unstamped`. To run the suites locally, stamp the working copy first (`node tools/stamp-build.mjs`,
  then `node tools/build-demo.mjs`) and put it back before committing (`node tools/stamp-build.mjs
  --clear`, then `node tools/build-demo.mjs`).
- Keep browser assets self-hosted: no CDN runtime scripts or external fonts.
- A new rule needs a test for the rule and for its refusal path.
- A demo relaxation is a new entry in `tools/demo/deviations.mjs`, appended at the end so existing `D-n`
  ids stay stable.

## 9. Tests and CI

```bash
npm install --no-save playwright && npx playwright install chromium   # test tooling only
node tools/run-suites.mjs            # every suite, mirror off
node tools/run-suites.mjs --mirror   # every suite, mirror on
```

`TESTING.md` lists every suite and what it covers. A suite fails on a failed check, a page error or a
skip not explained in `tests/allowed_skips.json`. There are no unexplained skips.

CI (`.github/workflows/ci.yml`) runs on every pull request and push to `main`. It checks that the React
bundle, demo build and role matrix are current and that `index.html` carries no committed stamp. It then
generates the build stamp in its working copy (not committed), verifies it with `--verify`, runs every
suite with the mirror off and on against the stamped build, and builds a release record from the results
with `release-report --dry-run`. On a pull request it checks out the pull request head, not GitHub's merge
ref, because the record names that commit and `release-report` refuses a commit other than the one checked
out. The results are kept as a run artifact.

## 10. Release process

1. Set the new build id on the `build:` line of `VERSION.md`, describe the change in `CHANGELOG.md`, and
   merge that in a pull request. This merge is the release commit: the stamp is generated from it, and
   the release record names it.
2. From a clean checkout of the release commit, generate the stamp: `node tools/stamp-build.mjs`, then
   `node tools/build-demo.mjs`. The stamp is not committed.
3. Run `node tools/run-suites.mjs` and `node tools/run-suites.mjs --mirror`. Both must pass.
4. Run `node tools/release-report.mjs`. It writes the release record (build, the commit the stamp was
   generated from, hashes, results, skips) into `VERSION.md`. It refuses an unstamped `index.html`, a
   stamp that was not generated from the `index.html` and build id committed in HEAD, a `demo.html` not
   regenerated from the stamped `index.html`, a packaged file in `assets/` whose bytes differ from HEAD
   (changed, added, ignored or missing), a failed run, or results from different files or from a commit
   other than the one the record names (`tools/run-suites.mjs` records the commit it ran on). `tools/package-release.mjs` also refuses an unstamped or mismatched
   `index.html`, and checks `assets/` against HEAD again before it writes the zips.
5. `node tools/package-release.mjs` writes `release/flight-system-<build>.zip` and the demo zip from the
   stamped files. Deploy from the production zip, not from `main`, and check the deployed copy with
   `node tools/stamp-build.mjs --verify <deployed index.html>`.
   The shared server run from a checkout stamps `index.html` in memory at start with the same tool, so
   its page and records carry the release SHA-256. For standalone use, open `index.html` from the
   production zip: the repository copy carries the placeholder `unstamped`.
6. Put the committed form back (`node tools/stamp-build.mjs --clear`, then `node tools/build-demo.mjs`),
   commit only the release record in `VERSION.md` in a pull request, and merge it once CI is green.
7. Record the build id and the SHA-256 from the release record in the quality system's software
   configuration record.

## 11. Open items

| Item | Owner | Date |
| --- | --- | --- |
| Okta app and groups, mapped to the roles in `docs/ROLE_MATRIX.md` | IT | 30 Sep 2026 |
| Persistence server host and backup location, after security issue 12 is resolved | IT | 14 Oct 2026 |
| Backup restore test on the chosen host (`server/restore-test.mjs`) | IT | 14 Oct 2026 |
| NetSuite MCP bridge | IT | 14 Oct 2026 |
| Stamp register and training records (holders into the SKY placeholders or by CSV import, PINs, training requirements with their QMS references, training records, then the authority grants) | QA Manager | 2 Oct 2026 |

Security issues 12 and 13 in `KNOWN-ISSUES.md` remain open. The stamp register and the people in the sample data that ship with the app are fictional placeholders.
The real register is entered in the Organization view before production use. There are no open
issues; `KNOWN-ISSUES.md` records what was found, fixed, and remains open.
