# Prompt for Grok: Flight Control MES storyboard walkthrough

Copy everything below the line into Grok.

---

You are a senior product designer and front-end developer. Build a **single self-contained HTML file** that is an interactive **storyboard walkthrough** of an aerospace manufacturing execution system called **Flight Control MES**. It is used to train technicians, engineers and quality staff and to show leadership how the system works end to end.

## Output requirements

- One `.html` file. All CSS and JavaScript inline. No external images; draw every UI mockup with HTML/CSS or inline SVG.
- Works on iPhone, iPad and laptop (responsive, no horizontal scrolling, touch friendly, 44 px tap targets).
- Light and dark mode via `prefers-color-scheme`.
- Navigation: Previous / Next buttons, arrow keys, swipe on touch, a progress bar, and a chapter menu to jump to any scene.
- Each scene is a storyboard frame with: scene number and chapter, a title, a **mock screen** of the app for that moment (simplified but recognizable), 2 to 4 numbered callouts pointing at the parts of the mock screen that matter, a short narration (2 to 4 sentences, plain language), and a "Who does this" role tag.
- A "Rules that matter" box on scenes where a quality or safety rule applies.
- Respect `prefers-reduced-motion`. Keep animation subtle: frame slide, callout fade-in.
- Visual style: clean industrial/aerospace. Dark sidebar with a white Y-shaped logo, white work surfaces, blue primary actions (#0A6CFF), status pills (Draft grey, Kitting amber, Building blue, Quality purple, Closed green, AOG red). Typeface: a neutral sans for UI, a monospace for IDs like WO-10012.
- Use realistic example data (below). Do not use real personal names other than the example roles given.

## The app in brief

Work orders move through **Draft → Kitting → Building → Quality → Closed**, then units are stocked with serial and lot traceability. Master work instructions (master WI) are templates that work orders are cloned from. Everything is permission based by role:

| Role | Can |
|---|---|
| General User | View, raise NC/IDR, submit ECR, request a work order |
| Operator (technician) | Kit parts, run steps, buy off operations with their stamp, split, AOG, schedule |
| Manufacturing Engineering | Author master WIs and work orders, add/edit operations, peer review WIs, NC initial disposition, assign work |
| Software Engineering | Push ATP software and accept/reject pushes |
| Quality Engineering | Approve work order release, sequence changes, WI release, NC approval, closures |
| QA Manager | Everything, plus post announcements |

## Chapters and scenes to storyboard (about 28 scenes)

**Chapter 1 · Sign in and dashboard**
1. Sign-in screen with the Y logo and "Safety is the mission."
2. Dashboard: label "My Path to Certification", greeting "Good morning, Jose", announcement cards (Great work, Shout-out, QMS change with an Acknowledge button), Quality queue, "Assigned to me", task groups. The Y logo has a small blue badge with the open-task count at its bottom right.
3. Top-bar search: typing "FC-200-00004" finds the serial and opens its work order on the Stock tab.

**Chapter 2 · Create the work order**
4. Create work order: choose "From master WI" or "Ad hoc". Pedigree picker shows Production, Development, Development NFF with a small grey description under it.
5. Serials auto-assigned at creation for serialized parts (FC-200-00002 to 00004 for quantity 3).
6. A General User instead sees "Request work order"; the request appears on the Manufacturing Engineering dashboard.

**Chapter 3 · Release and kitting**
7. Quality reviews the release; approving it moves the order straight to Kitting.
8. Kit tab: verify each material lot. Tabs read Kit, Build, Quality, Stock, Record.

**Chapter 4 · Build**
9. Build tab: operation sequence on the left, the current operation on the right, bottom next-action bar.
10. Operation callouts: ESD (Smock & Wrist Strap / Foot Grounding), FOD Critical Area with a Tool control badge, MSDS PPE reminder.
11. Operation steps one at a time (Step A of 3). A torque step needs a calibrated torque tool and value.
12. A consumable step (Loctite 242) needs lot number and shelf-life date; expired material is refused.
13. Inspection point: Quality buy-off blocks later operations until bought off.
14. Buy-off: stamp credential and stamp number, calibrated tools checked against the tool log.
15. FOD Critical buy-off pops up "Confirm tool control" with a criticality acknowledgment.
16. Blocked state: the bottom bar says "Buy-off blocked: no valid stamp" and offers "Switch credentials".
17. Lunch break: reload returns to the same operation with the draft note restored.

**Chapter 5 · Changes and holds**
18. Add operation guided flow: details, "Is this a multi-step operation?", step slides with photos.
19. Sequence change awaits QA release; the person who made it cannot release it.
20. ATP operation: GitHub repo and approved version; a new software push is Pending and blocks buy-off until a different Software Engineering account accepts it.
21. External Sub-Processing: add an existing NetSuite PO or create a PO request; buy-off waits for the PO.
22. NC/IDR raised from an operation with a hold and an assignee; ME disposition, then Quality approval.
23. Engineering change chooser: Process ECR (update master WI) or Design ECR (Jira ECR ticket request).

**Chapter 6 · Master work instructions**
24. Draft master WI with Peer review and QA review assignee fields; peer review then QA release by a different person.
25. Revising a WI flags previous ECRs to incorporate into the new revision.

**Chapter 7 · Close out and traceability**
26. Quality review closes the order; Stock tab moves units to inventory, generates LOT-260916-0001, prepares the NetSuite posting.
27. Close as Obsolete or Scrap; Scrap requires a linked NC/IDR unless the order is Development NFF.
28. Printed traveler: internal copy includes assignees and team discussion, external copy does not; steps print as rows under each operation.

## Example data to use

- Work orders: WO-10012 (SR-FC-200 Rev C, Flight controls integration kit, quantity 4, Kitting), WO-10008 (Building, Op 010 "Verify kit at bench"), WO-10013 (Development NFF).
- Parts: SR-FC-200, SR-AV-140. Sites: HHR, CMA. Aircraft: C2, C3.
- Master WI: MWI-0002 Rev B (Draft).
- Tickets: NC-0002 "Scratch on bracket". ECR-0001 Design ECR linked to Jira ECR-123.
- Tools: CAL-022 digital caliper, torque wrench in calibration. Stamp: Technician stamp TE-01.
- People (example roles): Jose Del Cid (QA Manager), Mia Engineer (Manufacturing Engineering), Quinn Quality (Quality Engineering), Omar Operator (Operator).

## Closing frame

End with a summary frame: the lifecycle as a horizontal flow (Create → Release → Kit → Build → Quality → Stock), the role list, and the three safety callouts (ESD, FOD, MSDS). Add a "Restart walkthrough" button.

Return only the finished HTML file.
