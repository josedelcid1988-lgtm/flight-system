# Flight System demo: quick start

This is for anyone trying the Flight System demo on their own computer. You can walk every
workflow alone. Nothing you do in the demo is a real record: every page and every print says
DEMO, NOT FOR ACCEPTANCE.

## 1. Open the demo

1. On GitHub, open the repository, click **Code**, then **Download ZIP**.
2. Unzip the file. Keep the folder together: `demo.html` needs the `assets` folder next to it.
3. Double-click `demo.html`. It opens in your browser. Nothing to install, no internet needed.

Use Chrome or Edge. Do not open `demo.html` from inside the ZIP; unzip it first.

## 2. Sign in

The password for every demo account is **demo1234**.

| Account | Use it to |
| --- | --- |
| `master` | Walk every workflow alone. You can do every step, approve your own work and fill every seat on a board. Start here. |
| `demo`, `safety`, `certification` | Same as `master`: full access, every step on your own. |
| `tech`, `quality`, `mfgeng`, `operations`, `engineering` | Pilot seats. Each keeps the real rules of its role (Technician, Quality, Manufacturing Engineering, Operations, Engineering), so a step outside that role is refused. Use these when two or more people rehearse the real hand-offs together. |

To switch accounts, click your initials at the top right and choose **Sign out**, then sign in
again.

## 3. Your data stays on your computer

Everything you create is saved in your browser on this computer only. Someone else opening the
demo on their computer starts from the same sample data and never sees your changes. Closing the
browser keeps your work; it is there the next time you open `demo.html`.

## 4. Start over

To get the original sample data back, remove only the demo's saved data. The demo and the production
`index.html` can share the same browser storage when they are opened from the same folder, so do **not**
use the browser's **Clear site data**: it would also erase any production workspace, accounts and
records kept in this browser.

- Chrome or Edge: with `demo.html` open, press F12, open **Console**, paste this line, press Enter,
  then reload the page (if Chrome asks first, type `allow pasting` and press Enter):

  ```js
  Object.keys(localStorage).filter(k=>k.startsWith('skyryse-mes-demo-')||k==='skyryse-mes-work-order-qa100-v1').forEach(k=>localStorage.removeItem(k));sessionStorage.removeItem('skyryse-mes-demo-session-v1');indexedDB.deleteDatabase('skyryse-mes-demo-evidence-v1')
  ```

  It removes only what the demo saved: the keys that start with `skyryse-mes-demo-`, the demo
  workspace `skyryse-mes-work-order-qa100-v1`, and the demo's recordings database
  `skyryse-mes-demo-evidence-v1`. Production keys and production recordings are left alone. The
  demo then loads its sample data again and shows the sign-in screen.
- Or use a private window (Incognito or InPrivate) when you want a throwaway session: nothing is
  kept when you close it.

**Reset workspace** at the bottom of the side menu empties the workspace completely; it does not
bring the sample data back.

## 5. Five guided scenarios

Sign in as `master` for all five. Each one runs start to finish without anyone else.

### A. Build and buy off a work order

1. **All work orders**, then **Create work order**, then **From master WI**. Pick MWI-0004, set the
   quantity to 2, untick FAI and give the reason, then **Create work order**.
2. **Move to kitting**. When asked, print the traveler or choose **Later**.
3. Open the **Kit** stage. For each line pick a lot and tick it, then add the NetSuite kit list
   under **Add files or photos**. Click **Start build**.
4. On each operation, tick every step. If a tool is asked for, type its asset tag (for example
   CAL-022) and click **Add tool**. On an inspection point tick the standard inspection box. The
   buy-off window opens; click **Complete operation**.
5. When every operation is done, click **Send to QA**, then **Review & close**, tick the box and
   **Close work order**.
6. Open the **Closed** stage, choose a location and bin, click **Move to inventory & generate
   lot**, then enter a NetSuite transaction number and **Mark posted**.

### B. FAI order with the AS9102 FAIR

1. Create a work order from MWI-0003 with **FAI order** ticked. Issue, kit, build and send it to
   Quality as in scenario A.
2. In the **Quality** stage click **Start the FAIR**. On Form 1 choose Full FAI, a reason and the
   supplier code, then **Save Form 1**. Fill each FAIR identifier in the index and **Save index**.
3. **Form 2**: add the material line. **Form 3**: add each characteristic, then enter the result,
   choose Conforms and the tool, and **Save**.
4. **Review and sign**: **Verify FAIR**, then sign box 22 yourself, then the Skyryse QA approval.
5. **Review & close** the work order.

### C. NC to MRB disposition

1. On a work order in build, open the current operation and click **Create NC**. Describe the
   problem and keep **Place this operation on hold** ticked.
2. Open the NC from the **Quality** stage. Choose a disposition (for example Use as is), write the
   rationale and **Record initial disposition**.
3. Click **Move to MRB**, then **Move to MRB** again. On the board, record a vote for each seat in
   turn: pick the seat, choose Approve, add a note, **Record vote**. The board decides on the last
   vote.
4. Back on the NC, choose the defect code and sub code, write why the disposition is acceptable,
   tick the box and **Approve and close ticket**.

Rework and Repair add the operation from the NC; Scrap can close the work order in the same
approval; Use for Dev moves the order to Development.

### D. Corrective action (CAR)

1. **Flight Maneuver**, **Corrective actions**, **Raise corrective action**. Fill the title,
   problem statement, owner and due date.
2. Work down the page: **Record containment**, the 5 Why and fishbone root cause, **Add action**,
   **Mark done**, **Verify actions**, **Record effectiveness** (Effective), then **Close and sign**.
3. If the cause sits with a supplier, name the supplier in the root cause. Record the SCAR Jira key
   and close the SCAR before closing the CAR.

### E. Master WI release

1. **Master WI**, **Master WI library**, **New master WI**. Pick the part, give it a title and
   **Create draft**.
2. Write the operation title and summary, the step title and instruction. Enter the ECO number and
   **Save drawing and ECO**. Optionally add the AS9102 Form 3 plan.
3. Click **ME peer review**, then **QE release**. The WI is released and new work orders can be
   cloned from it.
4. If you tick **Critical safety part**, QA review opens a PFMEA instead. Fill the scope and team,
   a failure mode, the action on any high-risk row, send it to the Safety Team and record the Safety
   Team decision. That releases the WI.

## 6. Known gaps in this build

These affect every account, in the demo and in production, and are being fixed separately:

- Do not split a work order after an engineering change has been applied to it: the split leaves
  the workspace invalid and the original order is set aside. Split first, then make the
  engineering change.
