# Design critique: Flight Control MES work-order screen (run 2)

Method: dual-agent (A: critique-A2 design review at 1280/768/375 · B: critique-B2 detector + live overlay, plus a phone-context reproduction of the field screenshots). B CLI ran degraded (regex fallback, 3 static findings); live overlay 9/7/5 findings on desktop views and 17 at 375 (10 of them body text bleeding past the viewport edge). Build critiqued: v14 (commit b8f2360). Fixes listed at the end were applied after scoring and are not reflected in the score.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Fixed bar carries id, state and verb everywhere. Four words for one state: "In progress" (hero pill), "BUILD" (rail), "Building" (bar), "On the floor" (sidebar). |
| 2 | Match system / real world | 3 | Stamp, credential, lot, IDR/NC vocabulary is right. "Record workspace", "Pedigree / subcategory", "WO_Rev-C" are system-speak. |
| 3 | User control and freedom | 2 | Bar click swaps tabs but leaves scrollY at 0 and focus on body. No in-app back control at phone width. |
| 4 | Consistency and standards | 2 | Two identical "Review material kit" buttons; "Operation changes need QA release" appears in two wordings; primary CTA duplicated in panel and bar. |
| 5 | Error prevention | 3 | Stamp type mismatch blocks before submit. But the bar clones a disabled "Complete operation" with no reason attached. |
| 6 | Recognition rather than recall | 2 | Blocked reason lives 2,000 px from the CTA. Sidebar shows 11 views including two "QA test view" entries with identical counts. |
| 7 | Flexibility and efficiency | 3 | Arrow keys on stepper, datalist for tool tags. No jump-to-current-op. ~19 clicks and ~8 scroll gestures for one buy-off. |
| 8 | Aesthetic and minimalist design | 1 | WO-10012 is 3,742 px tall on desktop (4.7 viewports). Hero photo, 8-field metadata grid, two release cards and a Slack composer precede or surround the traveler. |
| 9 | Error recovery | 3 | Blocked messages name the fix ("Switch credentials", "Review material kit"). Kit warning and "Resolve the missing material checks" say the same thing 60 px apart. |
| 10 | Help and documentation | 3 | Help dialog is a solid six-step overview. Stepper note is a rule dump, not help. |
| | **Total** | **25/40** | |

## Cognitive load checklist: 6 of 8 fail

First screen shows the primary task: fail (first operation at y=1484 desktop, 1415 tablet, 1654 phone). One primary action per view: fail. Four or fewer options per decision point: fail (hero 7 targets, sidebar 13, task panel 16 controls). Progressive disclosure of metadata: fail. Consistent state vocabulary: fail. Blocked states explain themselves at the point of action: fail on the bar, pass in the panel. Reading level: pass. Visual noise: fail.

## Duplication inventory (WO-10012, Operations tab, desktop)

| Field | Where it appears | Count |
|---|---|---|
| Work order id | tab title, H1, fixed bar, split chip, discussion body, footer activity | 5 visible |
| Revision | hero WO REV, hero DRAWING REV, details strip, REVISION cell, rail note, footer | 6 |
| Status | hero pill, rail, fixed bar, kit panel header, footer | 5, three spellings |
| Operation number and title | sequence row, task panel badge and H2, Edit/Remove buttons, discussion prompt, bar | 5 |
| User identity | avatar, "Posting as", "Buy-off as", footer, discussion author | 5, and it is a different person from the signed-in account |
| Master WI reference | hero chip, hero WI REV, task panel WI card | 3 |
| Buy-off type | metadata cell, fieldset legend, blocked message | 3 |
| Part, site, pedigree, quantity | details strip plus metadata grid | 2 each |
| "QA release needed" rule | sequence panel note, footer | 2 |
| "Review material kit" CTA | in-panel button, fixed bar | 2 |

## Answers to the three standing questions

**Is the layout logical for a technician?** Partly. The fixed next-action bar is the right primitive and the best decision in the build: 48 px target, correct verb in Kitting, visible in the first viewport on every device. The page order is wrong for OPERATE mode: hero, record details, metadata grid, stage rail, release cards and tabs all precede the sequence, so the traveler starts two screens down on every device.

**Is information duplicated?** Yes, see the inventory. Revision appears six times and status five times with three spellings. The details strip and the metadata grid carry the same four fields back to back.

**Can a technician tell immediately where to click?** On a laptop, yes within a few seconds, because the bar is the only saturated blue button in view. In Building state the bar lies by omission: it shows a greyed "Complete operation" with no reason while the reason ("no valid stamp; Abel Napoleon holds a Quality credential") sits roughly 2,000 px below. Clicking any bar action does not scroll or move focus, so on tablet and phone the click feels like nothing happened.

## Field defects reproduced from the iPhone screenshots (375 px, iOS WebView)

1. **Whole page overflowed sideways.** The pedigree-change block inherited the hero chip rule (`.page-heading .inline-info`: inline-flex, monospace, `white-space:nowrap`). At 375 px it measured 524 px wide, the layout viewport stretched to 1,042 px, the page scaled to 0.36 and every dialog centered off-screen. Root cause of screenshots 1 and 3.
2. **Step letter badge flush against the card edge.** The refresh set `.step-card{padding:8px 0}`, removing the side padding. Root cause of screenshot 2.
3. **Operation list wider than its panel.** Two-column `1fr 1fr` grid with no `minmax(0,…)`, so long titles pushed rows 60 px past the viewport. B's live overlay saw this as ten body-text-edge findings.
4. **WO REV chip spilled out of the revision strip** (A measured 17 px on WO-10012; the "Baseline" value on drafts spills further).
5. **No in-app back control.** At phone width the header shows only the wordmark, help and avatar; "All work orders" sits below the hero.
6. **Cold-load URL wrote `#order/null/operations`** before an order was selected.

## Priority issues

- **P0. Blocked state is silent at the point of action.** The bar clones a disabled submit and drops the explanation. The primary button should never be disabled without its reason next to it, and the fix action (Switch credentials, Verify lots) should become the primary. Command: harden, then clarify.
- **P0. Phone overflow** (defects 1 to 4 above). Command: adapt. Fixed in this pass.
- **P1. The traveler is two screens down on every device.** Collapse the hero to a one-line title bar with a Details disclosure, move release and engineering-change cards to the Record tab with a chip on the rail, drop the cockpit photo on execution screens. Target first operation under y=420 on desktop and y=520 on phone. Command: layout, then distill.
- **P1. Bar click does not move the user.** After the tab swap, scroll the target panel heading into view and focus it. Command: harden.
- **P2. One state, four words.** Use "Building" everywhere. Command: clarify.
- **P2. Mobile targets.** 23 of 55 visible targets under 44 px in one dimension; 11 px minimum body text. Command: adapt.
- **P3. Identity confusion.** Signed in as one person, stamping and posting as another, with nothing on screen that says "acting as". Command: clarify.
- **P3. Work-in-progress resume.** Step checks persisted, but the buy-off form draft and the selected operation lived only in memory, so a lunch-break reload lost them. Fixed in this pass (draft persisted locally without the stamp number; selected operation carried in the URL).

## Strengths

The fixed next-action bar. Buy-off integrity copy (stamp matched to the Stamp Control Log, credential mismatch blocks with a named fix, torque unit captured, "Not a real signature"). Traceability cards showing who, role, account and time in one line.

## Detector notes (B)

Static: side-tab on hold rows (legitimate status border), grid-line background (advisory; fits a measurement UI), dark glow on `#0a6cff` shadows (real). Live: thin-border-wide-shadow on buttons and dialogs (21 to 34 px blur), nested cards ×2, all-caps body on labels (label style, not slop), 88-character line length in a data table.

## Provocative questions

1. If the bar already carries id, state and the one verb, what is the hero for on an execution screen?
2. Who is the operations tab for: the technician doing the work, or the QE auditing it? Right now the dossier is inline and the traveler is the appendix.
3. Should a primary button ever exist in a disabled state, or should the only primary action on screen always be the one that unblocks?

## Fixes applied after scoring (v15)

Pedigree block wraps and excludes itself from the chip rule; `overflow-x:clip` guard on html and body; step card side padding restored; mobile operation grid uses `minmax(0,1fr)` with wrapping callouts; revision strip becomes a 3-column grid at phone width; Previous/Next buttons share one row on phone; header back button on order and WI views; selected operation persisted in the URL hash; buy-off form drafts persisted locally (stamp number excluded); `null` no longer written into the route. Verified at 375 and 1280: document width equals viewport, zero elements past the right edge, zero console errors, resume of op 030 plus draft note after reload.
