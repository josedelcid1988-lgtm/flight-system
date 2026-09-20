# Flight System: notes for coding agents

Read this before changing anything. It is short on purpose.

## What this is

Skyryse in-house MES, built as a single self-contained HTML file. No backend, no
network calls, no build step for the app itself. State lives in the browser
under `localStorage` key `skyryse-mes-work-order-v1`. Accounts live under
`skyryse-mes-auth-v1`.

One product, three modules, all in the same file:
- Flight Control: work orders, operations, buy-offs, FAIR, conformity, prints.
- Flight Plan: planned orders, MRP-style forecast, conversion to work orders.
- Flight Maneuver: NC/IDR intake, MRB, CAR/SCAR, SPR, FRACAS, escapes, PFMEA.

## Files

- `index.html`: production build. All gates enforced. This is the app.
- `demo.html`: demo build. Same app with the separation-of-duties, PIN and stamp
  gates relaxed and a sample data set loaded. Sign in demo / demo1234.
- `tests/`: Playwright harnesses and their fixtures. See `TESTING.md`.
- `VERSION.md`: what the current build contains. `ACCESS.md`: how the machines
  and Claude sessions share this repo.

`demo.html` is generated from `index.html` by a build chain that does not live
in this repo. Do not edit `demo.html` by hand expecting it to survive; make the
change in `index.html` and say so in the PR or commit, and the demo gets rebuilt
on the next release.

## Rules that are not negotiable

This is aerospace quality software on the FAA Part 21 Subpart K path. The rules
below exist for AS9100 and 14 CFR reasons; do not "simplify" them away.

1. Separation of duties. The person who does a thing cannot approve it: the
   author of a WI cannot release it, the peer reviewer cannot release it, the
   requester of a closure cannot approve it, one person holds one MRB seat, and
   the person who prepares an 8130-9 cannot sign it as the authorized inspector.
   The demo build lifts these; the production build must not.
2. Every approval and buy-off writes a record with the person, their credential,
   the time and a SHA-256 signature manifest. Never drop those fields.
3. State is re-validated on every write and rolled back if it would leave the
   workspace invalid. `MES.validate(state)` and `MES.diagnose(state)` are the
   entry points. A change that makes validation fail is a bug, not a new rule.
4. Storage keys, form numbers (F-850-001, F-860-004, AS9102, 8130-9, 8130-3) and
   record number formats are fixed. Renaming them breaks saved workspaces and
   the traceability story.
5. Text in the UI is plain and specific: say what is blocking and what to do
   next. No em dashes anywhere in the product text.

## Working on it

- Change `index.html` only, unless the task is about the tests.
- Keep it one file: no new external scripts, no CDN links, no build tooling.
- Run the suites in `TESTING.md` before you claim something works. `qa_full.mjs`
  is the gate: 304 pass, 2 skip, 0 fail. `qa_e2e.mjs` runs 30 flows end to end
  and must report 0 failed.
- If you add a rule, add a test for it and for the refusal path (the thing it is
  supposed to block).
- Small, reviewable commits with a message that says what changed and why.
