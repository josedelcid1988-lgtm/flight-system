# Browser workspace migration

`tools/migrate-browser.mjs` validates a Flight System browser export before it sends data to a shared server. It is dry-run by default. The source browser data is not edited.

## Export the workspace, accounts and recordings

Sign in to the browser that contains the current Flight System data. In its developer console, run:

```js
(async () => {
  const workspace = localStorage.getItem('skyryse-mes-work-order-v1');
  const accounts = localStorage.getItem('skyryse-mes-auth-v1');
  if (!workspace) throw new Error('No Flight System workspace was found.');
  const state = JSON.parse(workspace);
  // Removed recordings are quarantined, not deleted: export their bytes too so archive exports stay complete.
  const evidence = (state.orders || []).flatMap(order => (order.operations || []).flatMap(operation => [...(operation.evidence || []), ...(operation.quarantinedEvidence || [])]));
  const media = {};
  for (const item of evidence) {
    const blob = await MESMedia.get(item.id);
    if (!blob) continue;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    media[item.id] = {
      base64: String(dataUrl).split(',', 2)[1],
      mimeType: blob.type || item.mimeType,
      fileName: item.fileName
    };
  }
  copy(JSON.stringify({
    storage: {
      'skyryse-mes-work-order-v1': workspace,
      'skyryse-mes-auth-v1': accounts
    },
    media
  }));
  console.info(`Export copied. Included ${Object.keys(media).length} of ${evidence.length} recordings.`);
})();
```

Paste the clipboard contents into a JSON file. The export contains password hashes and potentially sensitive production records. Keep it in a protected location and remove it when migration and verification are complete.

### A browser closed after an older demo build

A standalone browser that once opened a demo build from before the demo had its own storage keys is closed to production use: that demo let anyone create, change or reset accounts with relaxed rules, so none of the browser's accounts can be trusted. Export its workspace and recordings with the script above, but leave the accounts out: delete the `'skyryse-mes-auth-v1': accounts` line before running it. The migration then creates no account from this browser; create the people's accounts on the server, where a QA Manager grants roles against current training. After the migration is applied and verified, clear the browser's site data for Flight System.

## Dry run

```sh
node tools/migrate-browser.mjs --input /protected/path/flight-browser-export.json
```

Review the report before applying. It lists work orders, master work instructions, planned orders, Flight Maneuver records, accounts, signatures and evidence, including removed (quarantined) recordings. Missing IndexedDB media and multi-role accounts are called out. Flight Maneuver records are counted from the upgraded workspace's current collections (`ncs`, `mrb`, `cars`, `sprs`, `pfmeas`, and `scars` for CARs that carry a SCAR); legacy FRACAS and escape records appear under `ncs` after the upgrade converts them.

A new server account never arrives with authority attached. Each account is created with its first role; its other roles, whether the browser stored them in `roles` or `extraRoles`, are then added through the server's audited role-change route (the same one a QA Manager uses), each citing the person's current training record, so every added role appears in the audit trail as a `role-change` by the migrating account. The migrating account cannot change its own roles; if it has more than one, another QA Manager or Master Access account adds them afterwards. Individually granted authority (conformity work, the AQI signature) and Support Access are signed by the person who granted them and are not copied. The dry run lists them under `accounts.manualAfterMigration`, and a QA Manager (Master Access for Support Access) grants them again after migration.

An account whose role carries inspection, MRB or Master Access authority (Quality, Manufacturing Engineering, Engineering, Certification, QA Manager, Master Access) is created only when it cites a current training record for that person. The same applies to an account with more than one role, since each added role cites training. The dry run finds one in the migrated workspace for each such account and lists any account that has none under `accounts.needsTraining`. The apply step signs in, drops accounts that already exist on the target server (such as the migrating account), and refuses before writing anything if any account in the list remains.

## Apply to an empty server

The target must already have a server account with Master Access or QA Manager permissions; on a new server, create the first one with the setup code from the server console (see `docs/DATABASES.md`). The migration refuses to overwrite a workspace that already exists.

```sh
FLIGHT_MIGRATION_URL=http://127.0.0.1:8080/api \
FLIGHT_MIGRATION_USERNAME=qa-manager \
FLIGHT_MIGRATION_PASSWORD='your password' \
node tools/migrate-browser.mjs --input /protected/path/flight-browser-export.json --apply
```

The command uploads supplied recordings, writes the validated Flight workspace, then imports account records, so each account's cited training record is already on the server, and then adds each account's other roles. Its result lists `rolesNotApplied` (with the server's reason) and `manualAfterMigration`. It uses the server ETag and same workspace validation used by normal writes. If a step fails, the command reports which earlier step completed. Check the server audit and evidence report before retrying.

The server refuses a workspace that holds a removed recording with no removal signature (422, `UNSIGNED_EVIDENCE_REMOVAL`), and stores nothing. Recordings removed before removals were signed have no signature, and a signed removal with its signature deleted looks the same, so the server cannot tell who removed it. The refusal names the recordings. Keep that workspace in the browser, where it still loads, and have the QA Manager review those removals before migrating.

## Verification limits

Flight records created before the v82 port did not store the subject used to calculate their signature hash. The verifier preserves these signatures and reports them as legacy, but it cannot recompute those hashes. New manifests store their subject and can be checked against the SHA-256. The report marks whether verification is complete.

Pre-existing manifests without a stored subject remain marked legacy because their original signed payload cannot be reconstructed from the browser export. The migration preserves those signatures without claiming that they were recomputed.
