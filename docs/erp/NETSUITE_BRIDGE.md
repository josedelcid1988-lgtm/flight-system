# NetSuite bridge: what IT builds

Status: contract defined, reference bridge and contract test in the repository, live bridge not built.
Owner of the live bridge: IT (HANDOVER.md, open items).

Flight System never holds NetSuite credentials. It calls a small bridge service run by IT, and the
bridge calls NetSuite. This page is the whole contract. Build to it, run the contract test against it,
then switch the app over with one setting.

```
Flight System (browser)  ->  bridge (IT, holds the NetSuite role)  ->  NetSuite (REST record service, SuiteQL)
```

The bridge moves records. It never makes a quality decision: it does not disposition, release, accept or
close anything, and it does not decide whether a lot is usable. Flight System and a qualified person
decide; the bridge carries the result.

## 1. Start from the reference bridge

`tools/netsuite-bridge-stub.mjs` answers every route below from sample data, with the request checks,
bearer token, CORS and idempotency already in place. Replace each handler's body with the NetSuite call
named in its comment. No dependencies.

```bash
node tools/netsuite-bridge-stub.mjs --port 8787 --token <secret, 16+ characters> --allow-origin https://mes.internal
```

## 2. Switch Flight System over

In `index.html`, `window.SK_INTEGRATIONS` (or a config script loaded before it):

```js
mode: 'mcp',                                   // 'local' keeps today's snapshot and manual CSV posting
endpoint: 'https://mes-bridge.internal',       // the bridge base address
authHeader: 'Authorization',
token: ''                                      // bridge bearer token, or blank if the bridge trusts the SSO session
```

What changes when `mode` is `mcp`:

| Area | Local (as shipped) | With the bridge |
| --- | --- | --- |
| Flight Plan "NetSuite on hand" | Built-in snapshot | Live read on sign-in and every 15 minutes; a part the bridge does not know, or a failed read, shows the snapshot |
| Move to inventory, Mark posted | CSV exported, posted by hand, reference typed | Posted through `/netsuite/assembly-build`; the returned reference is recorded |
| Kitting lots, kit issue | Flight System ledger (snapshot plus issues and returns) | Unchanged until decision 1 below |
| Purchase requisition, bin transfer | By hand in NetSuite | Routes defined; the app does not call them yet |

## 3. Every request

- `POST`, JSON body, `Content-Type: application/json`, `Authorization: Bearer <token>` when a token is set.
- The page sends `credentials: 'include'`, so the bridge answers CORS for the app's exact origin with
  `Access-Control-Allow-Credentials: true` (never `*`), and answers the `OPTIONS` preflight.
- Every body carries `actor` (the signed-in account, name and credential) and `build` (the Flight System
  build id). Log both with the NetSuite reference: that is the audit trail from ERP record to person.
- Reply `200` with the JSON below on success. On a refusal reply `4xx` with `{ "message": "..." }` in
  plain words: say what is blocking and what to do next. The app shows the message as is.
- `401` without the right token. `404` for any other route.

## 4. Routes

### 4.1 `/netsuite/item-availability` (read)

Request `{ "partNumbers": ["SR-FC-200", ...] }`, 1 to 500 part numbers.
Reply `{ "items": [{ "partNumber", "onHand", "snapshotAt" }], "unknown": ["..."] }`.
`onHand` is a whole number, 0 or more, summed over the locations Flight System builds from.
`snapshotAt` is an ISO 8601 time. The app drops any row that breaks these rules.
NetSuite: SuiteQL over item and inventory balance (quantity on hand by item and location).

### 4.2 `/netsuite/lot-stock` (read)

Request `{ "partNumber": "SR-2401" }`.
Reply `{ "partNumber", "snapshotAt", "lots": [{ "lot", "onHand", "location", "bin", "buildClass", "conformityStatus", "conformityRef" }] }`.
`buildClass` is Production, Development, Prototype or Development NFF. `conformityStatus` is Accepted,
Pending or Hold. A lot whose build class or conformity NetSuite cannot report comes back as `unknown`, and
Flight System will treat it as not issuable to a Production order.
NetSuite: SuiteQL over inventory number, inventory balance and bin, with the lot's inventory status.

### 4.3 `/netsuite/assembly-build` (write, called by the app today)

Request `{ "orderId", "csv", "inventory": { ..., "netsuite": { "payload": { ... } } } }`.
The payload is built by `netsuitePayload` and already in NetSuite's shape:
`recordType: "assemblybuild"`, `externalId: "<work order>-<lot>"`, `tranDate`, `item`, `itemRevision`,
`quantity`, `location`, `memo`, `inventoryDetail.inventoryAssignment[]` (`receiptInventoryNumber`,
`quantity`, `binNumber`), and the body fields in section 5.
Reply `{ "reference": "<NetSuite transaction number>" }`.
NetSuite: Assembly Build, REST record service, upsert on `externalId`.

### 4.4 `/netsuite/purchase-requisition` (write)

Request `{ "externalId": "<work order>-<operation>-PR", "vendor", "process", "needBy", "orderId", "operationId" }`.
Reply `{ "reference" }`. NetSuite: Purchase Requisition. A NetSuite approval later fills the operation's
NetSuite PO (BACKEND_CONTRACT.md).

### 4.5 `/netsuite/work-order-issue` (write)

Request `{ "externalId": "<work order>-KIT-<n>", "workOrder", "location", "lines": [{ "partNumber", "lot", "bin", "quantity" }] }`.
A positive quantity issues to the work order, a negative quantity returns to stock. Reply `{ "reference" }`.
NetSuite: Work Order Issue (or Inventory Adjustment against the WIP account if the account does not use
NetSuite work orders: confirm with the NetSuite administrator).

### 4.6 `/netsuite/bin-transfer` (write)

Request `{ "externalId", "location", "lines": [{ "partNumber", "lot", "fromBin", "toBin", "quantity" }] }`.
Reply `{ "reference" }`. NetSuite: Bin Transfer.

### Rules for every write

1. **Idempotent on `externalId`.** The same request again returns the first reference and writes nothing.
   The same `externalId` with different content is refused with `409`, never silently applied.
2. **No retries from the app.** If a reply is lost, the person looks the record up in NetSuite by
   `externalId`.
3. **All or nothing.** A write that fails part way writes nothing and says so.

## 5. NetSuite setup

- Features: REST Web Services, OAuth 2.0 (or token-based authentication), Server SuiteScript, Lot and
  Serial Numbered Items, Bins, Inventory Status.
- Integration role "Flight System Bridge": view items, locations, bins, inventory numbers and balances,
  SuiteQL; create Assembly Build, Purchase Requisition, Work Order Issue and Bin Transfer; nothing else.
  Start read-only (no create) in the sandbox.
- Transaction body fields on Assembly Build: `custbody_mes_work_order`, `custbody_mes_lot_number`,
  `custbody_mes_master_wi`, `custbody_mes_pedigree`, `custbody_mes_aircraft`,
  `custbody_mes_reworked_serial`, `custbody_mes_trace_ref`.
- Inventory number fields: build class, usage and conformity (list fields, not free text). Use an
  Inventory Status such as "Development only", not available for commitment, so NetSuite itself refuses
  to issue a development lot to a production build.

## 6. Decisions before the writes go live

| # | Decision | Recommendation | Owner | Due |
| --- | --- | --- | --- | --- |
| 1 | Which system is the stock of record for kitting lots | NetSuite. Kitting then reads `/netsuite/lot-stock`, each kit confirm posts `/netsuite/work-order-issue`, and the Flight System ledger keeps the issue with its NetSuite reference. Until then the ledger stays as is. | Jose Del Cid with the NetSuite administrator | 16 Oct 2026 |
| 2 | NetSuite work orders, or WIP adjustments, for component issue | Work Order Issue if NetSuite work orders are in use | NetSuite administrator | 16 Oct 2026 |
| 3 | Who may post bin transfers from the floor | Operators with the operate role, logged to the ledger like an issue | Jose Del Cid | 16 Oct 2026 |

## 7. Prove it

```bash
node tests/test_netsuite_bridge.mjs                                   # against the reference bridge
BRIDGE_URL=https://mes-bridge.internal BRIDGE_TOKEN=<token> node tests/test_netsuite_bridge.mjs   # against yours
```

Run the second form against the sandbox only: the contract checks post test records. It checks the token,
every route's reply shape and refusals, and idempotency on every write; then drives the production page
against the reference bridge (bridge off sends nothing; bridge on reads live on-hand; bad rows and an
unreachable bridge fall back to the snapshot).

## 8. Checklist

| Step | Owner | Due |
| --- | --- | --- |
| Sandbox account, features and the read-only role in section 5 | IT (NetSuite administrator) | 14 Oct 2026 |
| Body and inventory number fields in section 5 created in the sandbox | IT (NetSuite administrator) | 14 Oct 2026 |
| Bridge built from the reference, deployed behind TLS on the internal network | IT | 21 Oct 2026 |
| Contract test passes against the sandbox bridge | IT | 21 Oct 2026 |
| Flight Plan live on-hand checked against NetSuite for five parts | Jose Del Cid | 23 Oct 2026 |
| One finished order posted twice: exactly one Assembly Build | IT with Jose Del Cid | 23 Oct 2026 |
| Decisions 1 to 3 recorded, then writes enabled on the role | Jose Del Cid | 30 Oct 2026 |
