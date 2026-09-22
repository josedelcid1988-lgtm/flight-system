# Testing Flight System

The product build id is written only in `VERSION.md`. Suite names such as
`test_v80.mjs` record when that suite was added. They are not the build id.

The app is a single HTML file with no backend. Every harness drives a real
browser against a built copy, so a test failure is a real user-visible failure.

## Setup

```bash
npm i -D playwright && npx playwright install chromium
bash tests/setpaths.sh     # points the harnesses at tests/fixtures in this checkout
```

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

## Suites

| Command | What it covers |
| --- | --- |
| `node tests/qa_full.mjs` | 306 checks: engine rules, guards, UI flows, rendering at 1440 and 375 px. Expect 304 pass, 2 skip, 0 fail. |
| `node tests/qa_e2e.mjs` | 30 end-to-end flows: every order type and every ticket type driven to closure, with actions, typed fields, role handoffs and gates counted per flow. Writes `qa_e2e_results.json`. |
| `node tests/qa_multi.mjs` | 161 checks across modules (Flight Control, Flight Plan, Flight Maneuver). |
| `node tests/pilot_rehearsal.mjs` | Three scenarios run through the real pilot accounts. |
| `node tests/stable_test.mjs` | Table layout stability across 18 views. |
| `node tests/test_v74.mjs` … `test_v80i.mjs` | Feature suites: FAIR and conformity (v74), inspection reject and prints (v75), unreleased WIs and standard rework (v76), Certification seat, stock NC source and Use for Dev (v77), record prints (v78), MRB auto-decision and scrap closure (v79), QA-approved rework pairs (v80), FAIR links and revision authority (v80c to v80e), rework entry points and buy-off flow (v80h, v80i). |

Each harness prints `FAILS []` or a list, and the browser page errors it saw.

## Where to look when something fails

State lives in `localStorage` under `skyryse-mes-work-order-v1`. Every write is
re-validated and rolled back if it would leave the workspace invalid, so a
failure that reports "invalid" points at the engine rule named in the message.
`MES.validate(state)` and `MES.diagnose(state)` are callable from the console.
