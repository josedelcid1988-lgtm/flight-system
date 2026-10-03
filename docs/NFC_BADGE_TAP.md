# Badge tap (NFC) on a phone

Status: built behind a flag, off by default (`SK_IDENTITY.nfcTap: false`). Production behaviour is
unchanged until the flag is turned on.

## What a tap does, and what it does not

A tap identifies the person. It never signs anything.

| Where | A tap fills | Still typed by the person |
| --- | --- | --- |
| Sign-in screen | Username | Password (nothing is submitted by the tap) |
| Operation buy-off, step buy-off | Stamp no., only when the badge belongs to the signed-in account | Stamp PIN |

The buy-off record, its credential snapshot and its SHA-256 signature manifest are exactly what they
were before: the engine still checks the stamp against the Stamp Control Log and the PIN against its
scrypt record. A tap writes nothing to the workspace.

## Why a tap alone cannot be the login or the buy-off signature

- A Web NFC page can read only the tag's public serial number and its NDEF records. Both can be copied
  to a blank tag with a free phone app in a few seconds, so a tap is "something you have" only in name.
- AGENTS.md rule 2 and 14 CFR Part 21 Subpart K traceability need the buy-off to be attributable to the
  person. Today that is the stamp plus the PIN (`completeOperation` and `stampCheck`). Replacing the PIN
  with a copyable tag would weaken every buy-off record.
- So the design is tap to identify, PIN to sign. A tap saves the typing, the PIN keeps the signature.

What the rules ask for: 14 CFR 21.137(e), (g) and (k) and AS9100D 8.5.2, 8.6 and 7.5.3 require an
attributable, controlled record of inspection acceptance. FAA AC 120-78A asks that an electronic signature be
unique to the person, under their sole control and bound to the record. 21 CFR 11.200 (FDA, not binding
on aviation, but the usual reference model) asks for two distinct components, and allows one component for
later signings in a continuous session only if it is executable only by that person. A copyable tag on an
unlocked, signed-in phone is not, so the PIN stays. The controlling requirement is Skyryse's own quality
manual and stamp control procedure.

A real tap-to-sign-in (no password) is possible later with cryptographic tags (NXP NTAG 424 DNA with
Secure Unique NFC messages), where every tap produces a one-time code the server verifies. That needs a
server route, a key-management decision and a security review, so it is a separate change.

## Device support

- Works: Chrome on Android, page served over HTTPS (the on-prem server behind its TLS proxy).
- Does not work: any browser on iPhone (Apple does not expose Web NFC), desktop browsers, plain HTTP.
  On those the button never appears and sign-in and buy-off work as today.

## Badge format

One NDEF text record:

```
FS-BADGE:1;u=<username>;s=<stamp no.>
```

- `u`: the Flight System username, 2 to 40 characters of a-z, 0-9, dot, dash or underscore.
- `s`: optional stamp number, up to 8 letters, digits or dashes.
- Anything else on the tag is ignored. A tag without this record is refused with a plain message.

Badges are written by the QA Manager with any NFC writer app (for example NXP TagWriter) and locked
read-only after writing. NTAG213 or NTAG215 stickers on the existing badge are enough for this phase.

## Turning it on for a pilot

1. Serve the app over HTTPS from the on-prem server.
2. Set `nfcTap: true` in `window.SK_IDENTITY` (index.html `sk-identity` block, or a config script loaded
   before it).
3. Write a badge for each pilot user and confirm the stamp no. matches the Stamp Control Log.

## Tests

`node tests/test_nfc_tap.mjs` (Web NFC is mocked): off by default, hidden without Web NFC, badge parsing
and its refusals, sign-in fills the username only and submits nothing, the buy-off fills the stamp no.
only from the signed-in person's own badge and moves to the PIN, another person's badge and a badge
without a stamp no. are refused, and a tap writes nothing to the workspace.
