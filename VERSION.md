# Build v81 (20 Sep 2026)

The product is named **Flight System**. It carries three modules: Flight Control
(work order execution and quality records), Flight Plan (planning) and Flight
Maneuver (corrective action). Module names are unchanged; only the product name
changed, and storage keys and record numbers were left alone.

`index.html` is the production build. `demo.html` is the demo build: every
account has full access, the sample data set loads once, and the separation of
duties and PIN gates are relaxed. Sign in with demo / demo1234.

## In this build since v47

- Flight Maneuver: NC/IDR intake, MRB (Quality, Manufacturing Engineering,
  Engineering, and Certification on Production FAI and Mfg. orders), CAR with
  SCAR, SPR, FRACAS, escapes, PFMEA, metrics.
- AS9102 FAIR (Forms 1 to 3) with verify and approve; FAI orders close only on
  an approved FAIR, and the header links to it.
- LRU conformity package per SOP-860-002: checklist phases 1 to 7, 8130-9
  statement of conformity signed by an independent authorized inspector, DAR
  review and the FAA 8130-3 record.
- ATP operations with test asset capture; inspection operations with a fixed
  standard-inspection header and a reject path that raises the NC against the
  source operation.
- Standard rework: a QA-approved library of locked pairs (rework operation then
  its rework inspection), added to a work order exactly as approved and linked
  to the NC.
- Master WIs written to an unreleased drawing; every WI release records its ECO.
- Dispositions include Use for Dev (QA Manager approval, downgrades the work
  order pedigree); stock NC/IDR requires a source (PO line, work order, lot or
  serial).
- Prints: work order traveler, FAIR, 8130-9, and the records outside a work
  order (stock NC/IDR, CAR, MRB, PFMEA).
- Dashboard organized by area and subcategory, with a Quality queue.

## Tests

Run from the build directory with Playwright installed:
`node qa_full.mjs`, `node qa_e2e.mjs`, `node qa_multi.mjs`, `node test_v80.mjs`.
