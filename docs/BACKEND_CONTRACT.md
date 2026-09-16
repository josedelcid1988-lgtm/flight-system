# Flight Control MES: backend interface contract (v0.1, draft for the AI engineer)

Purpose: let the app move off browser-local storage without changing its behavior, and add the
three things the browser cannot do: one active session per account, work-order state that
follows the account across devices, and role checks the client cannot bypass. The contract is
deployment-neutral: a local server on the floor or AWS satisfies it identically.

## 1. What the app persists today

| Blob | Key today | Written by | Shape |
|---|---|---|---|
| Workspace | `localStorage['skyryse-mes-work-order-v1']` | `save()`, `mediaCommit()` | `{version:3, profile, orders[], activity[], masterWIs[], savedViews[], serialLog[], ...}` validated by `MES.validate` / `MES.upgrade` |
| Accounts | `localStorage['skyryse-mes-auth-v1']` | boot script | `{users:[{username, displayName, salt, hash, role, createdAt, createdBy}]}` |
| Session | `sessionStorage['skyryse-mes-session-v1']` | boot script | `username` |

Every state mutation funnels through `save()` or `mediaCommit()`; every gate reads
`window.skAuth.can(cap)` and `window.skAuth.actor()`. Those four functions are the seam.
Nothing else in the app touches storage.

## 2. Server duties

1. **Identity and single session.** Username/password (or SSO later). Issue one session token per
   account; a new sign-in revokes the previous token. Revoked clients receive `SESSION_REVOKED`
   on their next call (and via push, see §5) and drop to the sign-in screen with the message
   "Signed in elsewhere".
2. **Roles.** Store `role ∈ {general, operator, me, qe, qm}` per account. Return it with the
   session. Enforce the capability map (§4) server-side on every write; the client's hiding of
   controls is an affordance, not a gate.
3. **Workspace of record.** One workspace document (the `version:3` state) per site/tenant, not
   per user. All accounts read the same orders. Writes are whole-document with optimistic
   concurrency (`If-Match: <etag>`); on mismatch return `409` with the current document so the
   client can re-apply (the app already re-runs `MES.upgrade` on load).
4. **Attribution.** Stamp `actor = {name, role, credentialId:'ACCT-<username>'}` server-side onto
   approvals and history; do not trust the client's copy.
5. **Media.** Evidence recordings and attachments move from base64-in-document to object storage
   (`PUT /media`, returns id + URL); the document keeps ids only. This also removes the 5 MB
   localStorage ceiling that `mediaCommit()` guards against today.

## 3. Endpoints (HTTP + JSON)

| Method | Path | Body / result | Notes |
|---|---|---|---|
| POST | `/auth/session` | `{username,password}` → `{token, account:{username,displayName,role}}` | Revokes any prior session for that account |
| DELETE | `/auth/session` | → `204` | Sign out |
| GET | `/auth/session` | → `{account, issuedAt}` or `401 SESSION_REVOKED` | Heartbeat; app calls on focus and every 60 s |
| GET | `/accounts` | → `[{username,displayName,role,createdAt}]` | qm only |
| POST | `/accounts` | `{username,displayName,role,temporaryPassword}` | qm only |
| PATCH | `/accounts/:username` | `{role}` | qm only; refuse demoting the last qm |
| GET | `/workspace` | → document + `ETag` | All roles |
| PUT | `/workspace` | document, `If-Match` → `204` or `409 {current}` | Server re-validates with the same `MES.validate` (ship the MES module server-side; it is pure JS) |
| POST | `/workspace/actions/:name` | `{args}` → `{ok,message,...}` | Preferred over PUT: run `MES[name](state, ...args)` server-side so gates and attribution are authoritative. Client keeps PUT only as fallback. |
| POST | `/media` | multipart → `{id,url,bytes,contentType}` | Reviewed/unreviewed flag stays in the document |
| GET | `/media/:id` | binary | Auth required |

Actions are exactly the exported `MES` functions the UI already calls (`addOrder`, `splitOrder`,
`approveRelease`, `dispositionTicket`, `peerReviewMasterWI`, ...). Running them server-side
means zero change to the UI call sites: `MES.x(state, …)` becomes `await api.action('x', …)`
with the returned document replacing local state.

## 4. Capability map (server must mirror `ROLE_CAPS` in the boot script)

```
general : view raise-nc submit-ecr
operator: general + operate split request-pedigree approve-pedigree
me      : operator + edit-wi peer-review-wi create-wo adjust-wo dispo-nc
qe      : general + request-pedigree approve-pedigree approve-wo approve-wi approve-nc
qm      : everything
```
Action → capability is `ACTION_CAP` / `FORM_CAP` in the boot script; the server needs the same
table keyed by MES function name. Stamps (operation buy-offs) stay in the document as today;
they are credentials, not accounts.

## 5. Realtime (small, optional first)

`GET /events` (SSE) per session: `session.revoked`, `workspace.changed {etag}`. The client
refetches on `workspace.changed`. This is what makes "sign in on the iPad, laptop drops, work
continues" feel instant; polling every 60 s is the acceptable fallback.

## 6. Non-goals for v0.1

NetSuite and Jira integration (parked; they attach behind `/workspace/actions` later),
SSO, audit export, multi-site tenancy. Keep the surface small enough to stand up in a week.

## 7. Client changes when this lands

`save()` and `mediaCommit()` → `PUT /workspace` (or action calls); boot-script auth → `/auth`;
`skAuth.can` → reads role from the session; `record()` attribution stays but is overwritten by
the server. Everything else is untouched.

## ATP software pushes (added 2026-09-16)

ATP operations carry `atp: { repo, baseline: { sha, version }, pushes[] }`. In the browser build a push is recorded by hand. With a backend:

- `POST /webhooks/github` (GitHub push event, HMAC-verified with the webhook secret). For every open ATP operation whose `atp.repo` matches the repository, append a push `{ id, sha, version (tag or package version), message, by: { name: pusher, credentialId: 'GITHUB-<login>' }, at, status: 'Pending' }`. Ignore pushes whose sha equals the baseline.
- `POST /workspace/actions/reviewATPPush` `{ orderId, opId, pushId, decision: Accepted|Rejected, note }`. Requires capability `accept-software` (Software Engineering, QA Manager). The reviewing account must differ from the pusher.
- Buy-off (`completeOperation`) is refused while any push on the operation is Pending. With no pushes, no Software Engineering sign-off is required.
- Capabilities: `push-software` (Software Engineering, Manufacturing Engineering, QA Manager), `accept-software` (Software Engineering, QA Manager).

## Known temporary overrides (remove before production)

- **ATP software link deferral** (added 2026-09-16). ATP operations may be saved with `atpLinkDeferred: true` and no `atp` block. The operation shows "ATP software not linked" with a Link software action. Remove the "Link software later" option and the `atpDeferred` branch in `atpFor` (marked TEMPORARY OVERRIDE).

## External sub-processing purchase orders (added 2026-09-16)

- An External Sub-Processing operation carries either `externalPO { number, url? }` or `poRequest { vendor, process, needBy?, notes?, requestedBy, requestedAt, fulfilledAt? }`.
- With a backend, creating a PO request should create a NetSuite purchase requisition and store its internal ID; a NetSuite PO approval webhook fills `externalPO` and sets `fulfilledAt`.
- Buy-off is refused until `externalPO` exists.
