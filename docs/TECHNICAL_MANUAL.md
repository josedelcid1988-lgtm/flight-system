# Flight Control MES · Technical Manual

Build: the product build id is set in [VERSION.md](../VERSION.md) and stamped into `index.html` with its SHA-256 by `tools/stamp-build.mjs`. This manual does not carry its own build number.
Scope: architecture, data model, access control, every workflow and its rules, printing, storage, integrations, known limits, operations and testing.
Audience: developers, the backend engineer who will host it, QA/QMS owners validating it.

---

## 1. System overview

Flight Control MES is a manufacturing execution system for flight-controls work orders. It manages the full life of a work order (WO) from creation through kitting, build, quality review and stocking, with master work instructions (WI), controlled buy-offs, nonconformance tickets, engineering change control and traceability to serial and lot.

**Current form factor.** A single self-contained HTML file (`index.html`, about 1.6 MB, fonts embedded as base64). It runs entirely in the browser with no server. All data lives in the browser's storage on that device.

**Target devices.** iPhone, iPad and laptop. Layout breakpoints at 700 px (phone), 900 px, 1180 px (tablet / small laptop).

**Important limits of the browser-only build.**
- Data is per browser and per device. Two devices do not share data.
- Accounts, passwords and roles are stored locally. This is an access gate, not authenticated security.
- Buy-offs, approvals and signatures are recorded but are **not** authenticated electronic signatures. Screens and prints say "Not a real signature" or "virtual".
- Integrations (NetSuite, Jira, GitHub, Slack) produce payloads and records locally; nothing is sent. See section 12 and `docs/BACKEND_CONTRACT.md`.

---

## 2. Architecture

### 2.1 Script modules (16 script blocks in one file)

| Module | Responsibility |
|---|---|
| Boot / splash (`#sk-boot`) | Sign-in and first-run account creation, typed greeting, access gate. Exposes `window.skAuth`. |
| MES model (IIFE → `window.MES`) | All business rules, validation, migrations. Pure functions over a `state` object. No DOM. |
| Print (`window.MESPrint`) | `MESPrint.document(order, mode)` builds the internal or external traveler as standalone HTML. |
| Evidence store | IndexedDB database `skyryse-mes-evidence-v1`, store `recordings`, for video and photo evidence blobs. |
| UI | Rendering (`render()`), dialogs, event delegation, dashboard, search, drafts, next-action bar. |
| Feature add-ons | Master WI module, sequence changes and step-by-step execution, stamp/credential profile dialog, WI library filters. |
| Style layers | Base styles, refresh layer, and `<style id="skyryse-qa-fixes">` (last-wins overrides added during QA). |

### 2.2 Rule enforcement pattern

Every state change goes through a `MES.*` function that:
1. Checks capability with `denied(cap, what)` (see section 4).
2. Validates the whole state (`validate`) and the target record (`target`).
3. Applies business rules and returns `{ ok: false, message }` on any failure.
4. Mutates `state`, appends a history event with `record(...)`, and returns `{ ok: true, message }`.

The UI never mutates records directly. It calls MES, then `save()` (or `mediaCommit()` for evidence), then `render()`. `applyResult(result)` is the common helper for this.

Defense in depth: the UI also hides or disables controls by capability, and a capture-phase click/submit guard refuses any `data-action` or form listed in `ACTION_CAP` / `FORM_CAP` when the signed-in role lacks the capability.

### 2.3 Rendering

- `render()` repaints the active view into `#main`, updates the sidebar, breadcrumb, document title, route hash and dashboard badge.
- Views: `home` (dashboard), `order`, `orders`, `activity`, `serials`, `wis` (library), `wi` (WI detail). Module switch: **Work orders** / **Master WI**.
- Route hash: `#home`, `#orders`, `#order/<WO>/<tab>/<opId>`, `#wi/<id|rev>`. Opening a URL restores view, order, tab and selected operation (used for resume).
- Next-action bar (`#next-action`): fixed bottom bar mirroring the primary action of the current order. When the action is blocked it shows the reason and offers the unblocking action.

---

## 3. Data model

### 3.1 Storage keys

| Key | Storage | Contents |
|---|---|---|
| `skyryse-mes-work-order-v1` | localStorage | The whole workspace `state` (JSON). |
| `skyryse-mes-auth-v1` | localStorage | `{ users: [{ username, displayName, salt, hash, role, createdAt, createdBy }] }` |
| `skyryse-mes-session-v1` | sessionStorage | Signed-in username (per tab). |
| `skyryse-mes-drafts-v1` | localStorage | Unsubmitted buy-off form drafts (stamp number excluded). |
| `skyryse-mes-evidence-v1` | IndexedDB | Recording/photo blobs referenced by evidence records. |

Cross-tab protection: a `storage` event from another tab marks the workspace "changed in another tab" and blocks writes until reload.

### 3.2 Workspace `state` (version 3)

| Field | Description |
|---|---|
| `version` | `3` |
| `profile` | Stamp/credential in use for buy-offs `{ name, role, credentialId }` |
| `orders[]` | Work orders (max 100) |
| `activity[]` | Workspace activity (max 500) |
| `masterWIs[]` | Master work instructions (all revisions) |
| `serialLog[]` | Serial number database (max 5,000) |
| `lotSequence` | Counter for generated lot numbers |
| `savedViews[]` | Saved filter views for All work orders |
| `assignments[]` | Assignments (max 500) |
| `ecrRequests[]` | Process and design ECR requests (max 500) |
| `woRequests[]` | Work order requests (max 500) |
| `notices[]` | Dashboard announcements (max 200) |

### 3.3 Work order

Key fields: `id` (`WO-nnnnn`, splits `WO-nnnnn-Split-N`), `title`, `partNumber`, `revision`, `drawingRev`, `wiRev`, `woRev`, `quantity`, `pedigree`, `subcategory`, `aircraft`, `site`, `priority`, `status`, `start`, `due`, `owner`, `masterWI {id, revision, title}`, `materials[]`, `operations[]`, `tickets[]`, `reports[]`, `history[]` (max 300), `releaseApproval`, `engineeringChanges[]`, `pedigreeChange`, `pedigreeChanges[]`, `splitFrom`, `splitInto[]`, `sourceBuild` (rework of a stocked unit), `sourceTicket`, `inventory` (after stocking), `aog`, `closureRequest`, `closure`, `closedAs`.

Statuses in order: **Draft → Kitting → Building → Quality → Closed**.

### 3.4 Operation

`id`, `title`, `description`, `done`, `note`, `buyoff`, `buyoffType`, `inspectionPoint` (derived), `requiresTooling`, `requiresRecording`, `classification`, `callouts[]` (`ESD`, `FOD`, `MSDS`), `grounding` (`smock-wrist-foot` when ESD), `fodLevel` (`awareness` | `critical` when FOD), `steps[]`, `stepChecks{}`, `evidence[]`, `attachments[]`, `messages[]`, `slackThread`, `externalPO {number, url?}`, `poRequest {vendor, process, needBy?, notes?, requestedBy, requestedAt, fulfilledAt?}`, `atp {repo, baseline {sha, version, …}, pushes[]}`, `atpLinkDeferred` (temporary override), `addedToSequence`.

### 3.5 Step

`id`, `title`, `instruction`, `recordsTorque`, `consumables[]` (names), `image {dataUrl, caption, name}`.
Step check: `{ name, role, credentialId, at, torque? {value, unit, tool}, consumables? [{name, lot, expires}] }`.

### 3.6 Other records

- **Ticket (NC/IDR):** `id` (`NC-nnnn`/`IDR-nnnn`), `type`, `operationId`, `title`, `description`, `status` (`Open`/`Resolved`), `hold`, `createdAt`, `dispo {decision, note, …}`, `resolution`, `resolvedBy`, `resolvedAt`.
- **Master WI:** `id` (`MWI-nnnn`), `revision` (A, B, …), `status` (`Draft`/`Released`/`Obsolete`), `partNumber`, `partRevision`, `title`, `operations[]`, `peerReview`, `releasedAt`, `releasedBy`, `history[]`.
- **Serial entry:** `id` (`SNL-nnnnn`), `serial`, `partNumber`, `revision`, `orderId`, `unit`, `status` (`Assigned`/`Voided`), `assignedBy`, `auto`, `lotNumber`, `voidReason`.
- **Assignment:** `id` (`ASG-nnnn`), `type`, `assignee {username, name}`, target ids, `note`, `due`, `status` (`Open`/`Done`/`Reassigned`), `by`, `at`.
- **ECR request:** `id` (`ECR-nnnn`), `type` (`process`/`design`), `title`, `description`, `reason`, `partNumber`, `wiId`, `wiRevision`, `orderId`, `status`, `jira {project, issueType, summary, description, key?, url?}`, `incorporatedIn`.
- **WO request:** `id` (`WOR-nnnn`), `partNumber`, `quantity`, `pedigree`, `subcategory`, `aircraft`, `needBy`, `reason`, `status` (`Open`/`Fulfilled`/`Declined`), `orderId`.
- **Notice:** `id` (`NTC-nnnn`), `kind`, `title`, `body`, `mention`, `doc {number, revision, effective}`, `ackRequired`, `acks[]`, `pinned`, `by`, `at`.

### 3.7 Reference data (built in)

| List | Values |
|---|---|
| Pedigrees | Production (fully conforming part build), Development (for flight hardware, cannot be used for credit), Development NFF (prototype, cannot be used for flight or credit) |
| Subcategories | Rework, Software load, Repair, Upgrade, Inspection, FAI, Mfg., Installation, Maintenance |
| Ad hoc only | Rework, Repair, Upgrade |
| Priorities | AOG, High, Normal |
| Sites | HHR, CMA, NASH, MAPLE |
| Aircraft | C2, C3, C4, C5 |
| Buy-off types | Technician, Quality, A&P, Engineering, 8130-9 Authorized Inspector |
| Inspection buy-off types | Quality, 8130-9 Authorized Inspector |
| Operation classifications | Manufacturing, Inspection, Acceptance Test Procedure (ATP), Software Integration Lab (SIL), Hold for Engineering, External Sub-Processing, Rework, Repair, Upgrade, Troubleshoot |
| NC dispositions | Use as is, Rework, Repair, Scrap, Return to supplier |
| Serialized parts | SR-FC-200, SR-CI-110, SR-BE-030, SR-AV-140, SR-SL-060 (others lot-tracked; list pending confirmation) |
| Part catalog | 10 parts (SR-FC-200 … SR-IN-030) with allowed revisions |
| Stamp Control Log | 7 holders (snapshot) |
| Calibrated Tool Log | 371 tools (snapshot `2026-09-15 15:13`) |
| Consumables | Loctite 222/242/243/271, Loctite 567, RTV 108, PR-1422 B2, Mastinox 6856K, Braycote 601 EF, Aeroshell 33, EA 9394, IPA 99%, plus free-text "other" |

---

## 4. Access control

### 4.1 Accounts and sessions

- First run creates the first account as **Master Access**. On the shared server this needs the first-run setup code printed in the server console (see `docs/DATABASES.md`). Master Access adds accounts and sets roles from the credentials dialog.
- Passwords: per-user random salt, SHA-256 via `crypto.subtle`. Stored locally.
- Session is per browser tab (`sessionStorage`). Signing in re-renders the app for that account.
- "One login at a time across devices" requires the backend (section 12).

### 4.2 Roles and capabilities

| Capability | General | Operator | Mfg Eng | Software Eng | Quality Eng | QA Manager |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| view, raise-nc, submit-ecr | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| operate (kit, AOG, schedule, advance, steps, buy-off form, stock) |  | ✔ | ✔ |  |  | ✔ |
| split |  | ✔ | ✔ |  |  | ✔ |
| request-pedigree, approve-pedigree |  | ✔ | ✔ |  | ✔ | ✔ |
| edit-wi, peer-review-wi, create-wo, adjust-wo, dispo-nc |  |  | ✔ |  |  | ✔ |
| push-software |  |  | ✔ | ✔ |  | ✔ |
| accept-software |  |  |  | ✔ |  | ✔ |
| approve-wo, approve-wi, approve-nc |  |  |  |  | ✔ | ✔ |
| assign-work |  |  | ✔ |  | ✔ | ✔ |
| post-notice |  |  |  |  |  | ✔ |

### 4.3 Separation of duties enforced in MES

- Whoever changes an operation sequence cannot release it.
- The ME peer reviewer of a master WI cannot also QA-release it.
- ECR and engineering change requesters cannot approve their own change.
- Pedigree change needs two approvals from **different disciplines**; General User cannot approve.
- An ATP software push cannot be accepted or rejected by the account that pushed it.
- An obsolete/scrap closure cannot be approved by its requester.

### 4.4 Buy-off credentials (separate from roles)

Operation buy-offs are made on a **stamp credential** chosen from the Stamp Control Log, not on the account role. The buy-off checks: stamp exists and is active, credential ID matches, stamp type matches the operation's buy-off type, and the stamp number typed matches the holder's number. The screen shows "Signed in as X · stamping as Y" when the account and stamp differ.

---

## 5. Work order lifecycle

### 5.1 Creation

| Path | Who | Rules |
|---|---|---|
| From master WI | create-wo | WI must be Released. Subcategory cannot be ad hoc only. Part and revision come from the WI. |
| Ad hoc | create-wo | Rework/Repair need a linked NC/IDR; Upgrade needs an approved ECR/ECO; unit traceability to a stocked serial is mandatory for these. |
| Request work order | roles without create-wo | Captures part, quantity, pedigree, subcategory, aircraft, need-by, reason, optional assignee. Fulfilled or declined by ME/QM. |

On creation of a **serialized** part, the next serial numbers are assigned for every unit (part number without `SR-`, then five digits, for example `FC-200-00004`; never reused). Rework of a stocked unit keeps its original serial. Open orders missing serials are backfilled on load.

### 5.2 Stage gates (`canAdvance`)

| From → To | Blocked when |
|---|---|
| any | Pending engineering change; blocking NC/IDR hold; record invalid |
| Draft → Kitting | QA release approval required and missing. Required unless pedigree is Development NFF, or Production + Mfg. **Approving the release moves the order to Kitting automatically.** |
| Kitting → Building | Any material line not verified |
| Building → Quality | Any operation not bought off |
| Quality → Closed | Only through the quality review (`closeOrder`, approve-wo), with all materials and operations complete and no open holds |

Orders open on the tab for their stage: Kitting → Kit, Quality → Quality, Closed → Stock, otherwise Build. Tabs: **Kit, Build, Quality, Stock, Record**.

### 5.3 Split

Draft or Kitting, quantity ≥ 2. Child id `WO-nnnnn-Split-N`. Operations copied, none complete. Serials for the moved units (highest unit numbers) move to the child. Parent release approval resets.

### 5.4 Pedigree change

Draft or Kitting. Request with reason; two approvals from different disciplines apply it. Release approval resets.

### 5.5 Closure as Obsolete or Scrap

Requested by adjust-wo or approve-wo roles with a reason. **Scrap requires a linked NC/IDR unless the order is Development NFF.** Approved by a different approve-wo account; blocked while an engineering or sequence change is pending. On approval the order is Closed with `closedAs`, all assigned serials are voided with the reason, and the print shows "Closed as".

### 5.6 AOG and schedule

Priority AOG floats orders to the top everywhere. AOG escalation messages are prepared every 2 hours for the AOG thread (copy to Slack; nothing is sent). Planned start/finish can be changed by operate roles.

---

## 6. Operations and execution

### 6.1 Adding and editing operations

- **Add operation** is a guided flow: details → "Is this a multi-step operation?" → step slides (title, instructions, optional photo, consumables). Single step uses the title as the instruction.
- Operations can't be inserted before completed or in-progress work.
- Any add, edit or removal creates a **sequence change awaiting QA release**; buy-offs and issue are held until a different approve-wo account releases it. Release rolls the work order revision (`woRev`).

### 6.2 Classification rules

| Classification | Rule |
|---|---|
| Inspection | Buy-off type forced to Quality or 8130-9. |
| External Sub-Processing | Either an existing NetSuite PO (number, optional netsuite.com link) or a PO request (vendor, process/spec, need-by, notes). Buy-off refused until the PO is added. |
| Acceptance Test Procedure (ATP) | GitHub repo, approved version and commit. Pushes need Software Engineering acceptance before buy-off. Temporary override allows "Link software later" (section 13). |
| Others | Label only. |

### 6.3 Inspection points

An operation is an inspection point when its buy-off type is Quality or 8130-9 (derived, not selectable). Work cannot be checked or bought off on any later operation until every earlier inspection point is bought off.

### 6.4 Callouts

| Callout | Behavior |
|---|---|
| ESD | Fixed requirement "Smock & Wrist Strap / Foot Grounding", animated reminder. |
| FOD | Choose **FOD Awareness Area** or **FOD Critical Area**. Critical adds a **Tool control** badge and reminder, and buy-off requires a tool accountability confirmation with a criticality acknowledgment (logged). |
| MSDS | Review the MSDS and wear PPE reminder. |

### 6.5 Steps

Steps are checked in order by operate roles, only on the current operation of a Building order with no hold or inspection gate. A step that records torque requires a calibrated torque tool, value and unit. A step with consumables requires **lot number and shelf-life expiration** for each; expired material is refused.

### 6.6 Buy-off checks (`completeOperation`, in order)

1. operate capability; order Building; no engineering or sequence change; operation not done
2. inspection gate clear; preceding operation done; no blocking NC/IDR
3. no pending ATP software push; External Sub-Processing has a PO; FOD Critical tool accountability confirmed
4. required video evidence attached and reviewed
5. all steps checked
6. stamp credential valid, type matches, stamp number matches
7. calibrated tooling rules: required tools logged (or none logged when not required), each tool In Calibration, not expired, not quarantined; torque values for torque tools

The buy-off stores name, role, credential, time, stamp, tools and evidence ids, and writes a history event.

### 6.7 Drafts and resume

The selected operation is in the URL hash and buy-off form drafts persist locally (stamp number excluded), so a reload returns the technician to the same operation with notes and tools filled.

---

## 7. Quality

- **NC/IDR:** raised by anyone on an issued order from an operation, optional hold, optional assignee.
- **Initial disposition:** Manufacturing Engineering (dispo-nc) records one of the dispositions.
- **Approval / resolution:** Quality (approve-nc) resolves only after ME disposition.
- **Quality queue:** for Quality Engineering and QA Manager it appears on the dashboard. An order is flagged when it is AOG, in Quality, has an open NC/IDR, a pending engineering change, a pending release approval, or a pending sequence change.

---

## 8. Engineering change

| Type | Where | Flow |
|---|---|---|
| Process ECR | Master WI (how we build) | Submitted against a released WI. Flagged when the WI is revised; checked ECRs become `Incorporating` and close as `Incorporated` when that revision is released. |
| Design ECR | Part (drawing, material, form/fit/function) | Creates a Jira ECR ticket request (project ECR). Copy to Jira, then record the Jira key; status becomes `In Jira`. |
| WO engineering edit | This work order only | Revision, quantity or operation instruction change. ECR approval when required (Production Mfg./FAI), then QA re-release. Work pauses until applied. |

---

## 9. Master work instructions

- Draft → ME peer review → QA release (different person). Releasing a revision obsoletes the previous released revision.
- Editing operations after peer review clears the peer review.
- Revise creates the next revision letter as a draft and shows previous ECRs (open process ECRs, design ECRs on the part, WO engineering edits from that WI).
- Draft WIs have **Peer review** and **QA review** assignee fields.
- Steps may include pictures (resized to ≤ 300 KB each; 2.6 MB total workspace picture budget).

---

## 10. Stock, serials and lots

- **Stock readiness:** closed by QA, all operations bought off, inspection points bought off, every kit item has a lot/serial, serials assigned (serialized parts only), no open NC/IDR, no pending sequence change.
- **Move to inventory:** generates `LOT-YYMMDD-nnnn`, stamps serial entries with the lot, builds the traceability record and a NetSuite assembly build payload and CSV. NetSuite posting is marked manually.
- **Serial database view** lists every serial, status, lot and rework history. Voided numbers are never reused.

---

## 11. Dashboard, assignment and communication

### 11.1 Dashboard (landing page)

Reached on open (no deep link) and by clicking the Y logo (badge = open tasks + assignments + unacknowledged QMS changes). Header label "My Path to Certification" with a greeting. Sections: Announcements, Quality queue (quality roles), Assigned to me, role tasks (Approvals, Quality, Engineering, Software, Planning, Floor, Master WI), Assigned by me, Team assignments (assigners).

### 11.2 Assignment

Assignment happens at the point of work:
- When raising an ECR, NC/IDR or WO request (optional "Assign to").
- Master WI peer and QA reviewers.
- Operation technician from the operation panel (shown in app and **internal** print only, never external).

Pickers are one type-to-search field listing only accounts whose role can do that work. Dashboard rows offer **Reassign** (old assignment kept as `Reassigned`). Assignments auto-close when the underlying work completes.

### 11.3 Announcements

QA Manager posts **Great work**, **Shout-out** (optionally naming a person) and **QMS change** (document number, revision, effective date, optional required acknowledgment with an acknowledgment list). Pin, unpin and remove by poster or leadership.

### 11.4 Search

Top bar search (press `/`) across work order ids, part numbers and serial numbers. Serial hits open the order on the Stock tab.

### 11.5 Team discussion

Per-operation local messages with Slack thread references. Not synchronized with Slack; excluded from the external print.

---

## 12. Printing and exports

`MESPrint.document(order, mode)`:

| Content | Internal | External |
|---|:-:|:-:|
| Metadata (part, serial, revisions, pedigree, status, closed-as) | ✔ | ✔ |
| Pre-release QA record | ✔ | No |
| Engineering change control | ✔ | ✔ |
| Operation sequence with steps as rows under each operation (checks, torque, consumable lots) | ✔ | ✔ |
| Callout notes (ESD, FOD level, tool control, MSDS) | ✔ | ✔ |
| Operation assignee | ✔ | No |
| Linked records (tickets, ATP reports, evidence metadata) | ✔ | ✔ |
| Team discussions | ✔ | No |

Record tab: **Export internal JSON** of the work order.

---

## 13. Known temporary overrides and open decisions

| Item | Status |
|---|---|
| ATP "Link software later" | Temporary override. Remove the checkbox and the `atpDeferred` branch in `atpFor` (marked `TEMPORARY OVERRIDE`). Reminder set for 23 Sep 2026. |
| Serialized parts list | Assumed; needs confirmation. |
| Hold for Engineering | Label only; decide whether it should block work. |
| "Fully conforming" wording | Used instead of "conformable"; confirm. |
| QA Manager self-release of own sequence change | Currently blocked; decide. |

---

## 14. Integrations and backend

See `docs/BACKEND_CONTRACT.md` for endpoints. Summary:

| System | Today (browser build) | With backend |
|---|---|---|
| Accounts/session | Local salted hash, per-tab session | `/auth/session`, single active session per user, device handoff with resume |
| Workspace | localStorage JSON | `/workspace` with ETag/409 concurrency; actions run MES server-side |
| Evidence | IndexedDB | `/media` object storage |
| NetSuite | Payload + CSV; PO number/link recorded; PO request stored | Assembly build post, purchase requisition create, PO approval webhook |
| Jira | Design ECR ticket text copied manually, key recorded | `POST /rest/api/3/issue`, store key |
| GitHub | ATP pushes recorded manually | Push webhook creates pending pushes |
| Slack | AOG and discussion text prepared locally | Post to channels/threads |

---

## 15. Operations

### 15.1 Deploy

Static hosting of `index.html` plus `assets/` (hero images). The code of record is this repository (`main`); CI builds nothing, so the file on `main` is the file to host. The optional persistence mirror runs beside it (`server/README.md`).

### 15.2 Backup and reset

- Record tab JSON export per order.
- "Reset workspace" (sidebar bottom) clears the workspace after confirmation. Accounts are separate.
- Clearing browser site data removes everything on that device.

### 15.3 Migrations on load (`MES.upgrade`)

Legacy split ids `-A` → `-Split-N`; engineering change snapshots; op 010 renamed "Verify kit at bench"; inspection point derived from buy-off type; legacy ESD grounding values → fixed requirement; FOD operations without a level → Critical; serial backfill for open serialized orders.

---

## 16. Testing and verification

- Syntax: every script block passes `node --check`.
- `MES.validate(state)` must be `true` after every change.
- Browser verification at 375 px (phone), 768 px (tablet), 1280–1440 px (laptop): no horizontal overflow, no console errors.
- Lifecycle regression used during QA: create → QA release (auto Kitting) → verify kit → steps (torque, consumables) → buy-off with stamp and tools → Quality → close → serial/lot → stock; plus split, pedigree change, sequence change release, ECR paths, ATP push review, PO request, scrap closure, assignments and reassign.

---

## 17. Glossary

AOG (aircraft on ground) · ATP (acceptance test procedure) · ECR/ECO (engineering change request/order) · ESD (electrostatic discharge) · FOD (foreign object debris/damage) · IDR (inspection discrepancy report) · MSDS (material safety data sheet) · MWI (master work instruction) · NC (nonconformance) · NFF (not for flight) · SIL (software integration lab) · WO (work order).
