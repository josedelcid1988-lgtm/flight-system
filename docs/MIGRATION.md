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

## Dry run

```sh
node tools/migrate-browser.mjs --input /protected/path/flight-browser-export.json
```

Review the report before applying. It lists work orders, master work instructions, planned orders, Flight Maneuver records, accounts, signatures and evidence, including removed (quarantined) recordings. Missing IndexedDB media and multi-role accounts are called out. The server preserves all assigned roles and their capability union.

An account whose role carries inspection or MRB authority (Quality, Manufacturing Engineering, Engineering, Certification) is created only when it cites a current training record for that person. The dry run finds one in the migrated workspace for each such account and lists any account that has none under `accounts.needsTraining`; the apply step refuses to start until that list is empty.

## Apply to an empty server

The target must already have a server account with Master Access or QA Manager permissions; on a new server, create the first one with the setup code from the server console (see `docs/DATABASES.md`). The migration refuses to overwrite a workspace that already exists.

```sh
FLIGHT_MIGRATION_URL=http://127.0.0.1:8080/api \
FLIGHT_MIGRATION_USERNAME=qa-manager \
FLIGHT_MIGRATION_PASSWORD='your password' \
node tools/migrate-browser.mjs --input /protected/path/flight-browser-export.json --apply
```

The command uploads supplied recordings, writes the validated Flight workspace, and then imports account records, so each account's cited training record is already on the server. It uses the server ETag and same workspace validation used by normal writes. If a step fails, the command reports which earlier step completed. Check the server audit and evidence report before retrying.

## Verification limits

Flight records created before the v82 port did not store the subject used to calculate their signature hash. The verifier preserves these signatures and reports them as legacy, but it cannot recompute those hashes. New manifests store their subject and can be checked against the SHA-256. The report marks whether verification is complete.

Pre-existing manifests without a stored subject remain marked legacy because their original signed payload cannot be reconstructed from the browser export. The migration preserves those signatures without claiming that they were recomputed.
