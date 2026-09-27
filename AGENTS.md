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
- `demo.html`: demo build, generated. Same app with the separation-of-duties, PIN
  and stamp gates relaxed and a sample data set loaded. Pilot seats (`tech`,
  `quality`, `mfgeng`, `operations`, `engineering`) keep their real role. Sign in
  with any demo account and the password demo1234. Every page and print says
  DEMO, NOT FOR ACCEPTANCE.
- `tests/`: Playwright harnesses and their fixtures. See `TESTING.md`.
- `VERSION.md`: where the product build id is set; `tools/stamp-build.mjs` writes it and the
  SHA-256 of `index.html` into the head of `index.html`. `ACCESS.md`: how the machines
  and Claude sessions share this repo.

`demo.html` and the demo test fixtures are generated from `index.html` by
`node tools/build-demo.mjs`, which applies the numbered deviations in
`tools/demo/deviations.mjs` (listed in `docs/DEMO_DEVIATIONS.md`). Never edit
`demo.html` or a fixture by hand: change `index.html`, run `node tools/stamp-build.mjs`,
then `node tools/build-demo.mjs`, and commit all of them. `--check` on either tool fails
if its output is out of date.

## Rules that are not negotiable

This is aerospace quality software on the FAA Part 21 Subpart K path. The rules
below exist for AS9100 and 14 CFR reasons; do not "simplify" them away.

1. Separation of duties. The person who does a thing cannot approve it: the
   author of a WI cannot release it, the peer reviewer cannot release it, the
   requester of a closure cannot approve it, one person holds one MRB seat, and
   nobody inspects their own work (Development NFF orders excepted, and recorded).
   The person who completes an 8130-9 may give the AQI signature only after an
   acknowledged warning, recorded on the signature. Inspection, MRB seats,
   conformity work and the AQI signature are granted to named people by a QA
   Manager against a current training record, never to themselves. The demo
   build lifts these; the production build must not.
   `tests/test_frozen_contract.mjs` fails if one changes.
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

## Reviewing and merging

Every pull request is reviewed by Claude (a routine, set up in
`docs/CLAUDE_REVIEW_ROUTINE.md`, standard in `REVIEW.md`) and by Jinx. The merging agent (Codex) merges a pull
request only when all of these hold on its current head commit:

1. CI (`CI / suites`) is green.
2. Jinx has approved.
3. The latest Claude review comment names the current head SHA and ends with
   the line `Claude verdict: OK to merge`. A verdict on an older commit does
   not count; `Claude verdict: changes needed` blocks the merge.
4. There is no merge conflict and no unresolved Important review thread.

If any condition is missing, do not merge: say on the pull request which one
is missing. Never approve or merge your own change, and never merge to get
around a missing verdict.
