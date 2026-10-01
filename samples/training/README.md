# Training floor samples

Sample CSV files for a 20-person training session on Flight System. All data
in these files is fake training data. The part numbers come from the built-in
part catalog because the importer accepts only catalog parts, but every WI
title, tool tag and tool description is marked Training or TRN. Nothing here
is for acceptance, and nothing here should be imported into a production
workspace.

## The files

| File | What it holds | Screen that imports it | Who may import it |
| --- | --- | --- | --- |
| `calibration.csv` | 20 training tools (torque wrenches, torque drivers, calipers, micrometers, gauges, multimeters). 18 are In Calibration; one is Out for Calibration and one is Quarantined, to show a tool that cannot be used. | System QMS records, calibration import | A QA Manager or Master Access account |
| `master_wis.csv` | 5 training master WIs (TRN-1001 to TRN-1005), one row per step. Each WI ends with a Quality inspection operation. | Master WI library, Import CSV | An account that may write WIs (edit-wi), for example Manufacturing Engineering |
| `work_orders.csv` | 30 training work orders cloned from the 5 WIs, with quantities, sites, aircraft, start and due dates, and first-article (fai) choices. | All work orders, Import CSV | An account that may create work orders (create-wo), for example Operations or Manufacturing Engineering |

## Import order

1. Calibration: a QA Manager imports `calibration.csv`.
2. Master WIs: an engineer imports `master_wis.csv`. Every WI arrives as a
   Draft at Rev A, and the importer is recorded as its author.
3. Peer review and release: a second engineer, not the importer, peer-reviews
   each WI. A Quality Engineer, who is neither the importer nor the peer
   reviewer, releases each WI with an ECO number (the test uses
   ECO-TRN-1001). The system refuses the importer or the peer reviewer.
4. Work orders: an Operations or engineering account imports
   `work_orders.csv`. Every order starts as a Draft.

The work order file is refused while any WI it names is still a Draft. That
is expected: release the WIs first.

## Things to know

- `work_orders.csv` names the WIs as MWI-0011 to MWI-0015. A new server
  starts its WI library with MWI-0001 to MWI-0010, so these are the numbers
  the five training WIs get when they are the first WIs imported. If the
  library already holds other WIs, the import message says which numbers it
  gave; change the masterWI column to match before importing the work orders.
- A workspace holds up to 100 work orders, and one import takes up to 100
  rows. These 30 orders fit only if the workspace has 70 or fewer orders.
- Calibration dates cannot be later than the day of the import. The due
  dates run to 2027 and 2028 so the tools stay usable through the training.
- The first order from each WI is a first article (FAI) unless the file
  clears the flag with a reason. One WI's first order clears it, with the
  reason given in the faiWaiver column.

`node tests/test_training_samples.mjs` imports all three files in this order
and checks that each one is accepted and leaves the workspace valid.
