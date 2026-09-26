# Flight System design definition

Read this before changing anything a person sees. The sign-in page sets the
standard: dark, cinematic, one blue accent. Every screen after sign-in follows
it. Datum is an operations tool used all day; screens are dense, quiet and
scannable. If a screen makes you read a sentence to understand it, search for
which column a number belongs to, or wonder which button matters, it fails.

## Material

1. Chrome is Liquid Glass: the dock, the top bar, sheets, menus, popovers and
   toasts. Blur and saturation, a specular line on the top edge, a light rim,
   a dark base, a pointer-following light on interactive tiles.
2. Content is quiet: solid dark panels, a hairline border, 14px radius, 16px
   gap between panels. No card inside a card. No glass on content.
3. Lists and tables sit on a surface about 20% lighter than a panel.
4. A faint gradient drifts slowly behind the chrome. It never competes with
   content.

## Type and copy

5. Inter only, tabular numerals. Ramp: page title 32/38, Hangar greeting
   40/46, panel title 17/24, body 14/20, table cell 13/18, label 12/16.
   Headings balance; short text pretty-wraps.
6. No explainer text under a heading, panel, form or field. No instruction
   suffixes in titles. Labels are two words; a field that needs a sentence is
   named wrong.
7. Dates read `Sep 26, 2026`, months `Sep 2026`. Never ISO on screen. A date
   appears only where the reader needs it; a panel header never.
8. Empty is one muted dash. Never "None", "Not yet", "Not coded",
   "Not required".
9. One value per cell. A "·" or a word inside a cell means it is two columns.
   A count and its percent are two values.

## Layout

10. Header: title left, actions right, one line, full content width. One
    primary plus at most two secondary actions; more collapse into a menu.
    Create actions and navigation never share a group. The greeting format
    ("…, Demo") belongs to the Hangar only. Title, actions, filters and
    panels share one left edge.
11. Column widths are set once per table, never per row. The long-text
    column takes the width; ID, date and status columns fit their content.
    Short and date cells never wrap; tokens never break mid-word.
12. Queue rows are 44 to 56px. Content that needs more is a detail, not a
    column. A queue shows at least 15 rows at 1440×900.
13. Forms read like System Settings: the current value first, editing second,
    820px wide, labels above fields, one primary. A grid cell holds one value
    or one control, never a stack.
14. A panel with nothing in it is hidden.

## Color

15. Blue marks the primary action and focus, nothing else. Primary buttons
    are tinted glass; the glow appears on hover only.
16. Links are text color with an underline on hover. The row is the click
    target.
17. Status is always a colored pill with a dot: green done or released, blue
    active or planned, amber waiting or firm, red critical, hold, late or
    escape. Sensitivity: Low green, Medium blue, High amber, Extra High red.
    AOG is solid red and pulses.
18. Lists whose title implies urgency (past due, at risk, blocked) show the
    urgency on every row, in red.
19. Charts: one data color, real units, a visible scale, month names. A
    Pareto is sorted descending with a cumulative line. Chart or table, not
    both stacked. Red never paints a whole series.

## Interaction

20. Targets are 44px minimum. Press scales to 0.96. Focus rings are visible.
    Per-row actions are icons that appear on hover.
21. Motion happens on state change only: press, hover, open, close, sort,
    filter, a badge changing. Enter 200ms ease-out, exit 150ms. Transform and
    opacity only; progress uses `scaleX`. Stagger 40ms. No count-up, no
    constant glow, no animation on every render. The theme never animates a
    property the app itself transitions. Reduced-motion turns everything off.
22. Transitions name their properties. Never `transition: all`.
23. Dock: the workspace switch plus at most six tiles; the rest live in
    folder tiles. Only the hovered tile grows, one label, no native tooltip,
    badges only when nonzero, a dot under the active view, the segmented
    highlight slides.

## Review checklist

Sign in, walk every dock tile in Execute, Planning and Improve, open a work
order and each tab, sort one table, open one dialog. A single miss fails.

- [ ] Glass only on chrome; content panels solid; 16px gaps; no card in card
- [ ] Nothing renders white or cream, hover states included
- [ ] Sorting, filtering and re-rendering never blank a list
- [ ] Header on one line: title left, actions right, one primary
- [ ] Columns aligned across rows; one value per cell; short cells never wrap
- [ ] Rows 44 to 56px; 15 rows visible in a queue
- [ ] Dates `Mon D, YYYY`; empties are a dash; no explainers; labels two words
- [ ] Every status word is a colored pill; links are text, not blue
- [ ] Motion only on state change; nothing moves at rest except the drift
- [ ] Dock within six tiles plus folders; badges only when nonzero
- [ ] Contrast: text 4.5:1, secondary 3:1, on both panel and table surfaces
- [ ] `node tools/build-demo.mjs`, `tests/test_demo_build.mjs`,
      `tests/qa_ui.mjs`, `tests/qa_e2e.mjs` pass; print output unchanged

## Rules added from review

24. Table headers read as headers: their own lighter surface, bright uppercase
    labels, a stronger rule under them. Never the same look as a data row.
25. Different descriptors never share a cell or a pill group. Priority (AOG,
    High) is its own column; status (Building, Draft) is its own column.
26. One row beats two. A record with a handful of values is one row of
    columns; details and descriptions sit in their own column, not under the
    title.
27. Actions for a whole panel live in the panel header, on the right. Never
    in a footer or loose inside the list.
28. Every number carries its label. A count alone in a header ("110") is
    removed or labelled ("107 queued").
29. Decision pairs (Accept/Decline, Approve/Reject) are neutral at rest; on
    hover and focus, yes turns green with a check and no turns red with an X.
30. AOG is a filled red control or pill wherever it appears.
31. Columns align across every row and the header, within 1px. The review
    crawl measures it.
32. A cell listing more than four records collapses to a count ("27 planned
    orders") that expands on click.
33. Table descriptions are one line with an ellipsis; the full text is on
    hover.
34. The sign-in scales with the screen: the headline and form grow on wide
    displays; the primary button is tinted blue glass.

## Automated review

`scratch/audit2.mjs` (kept outside the repo) signs in to the demo, walks every
dock tile in Execute, Planning and Improve, opens each page's primary dialog,
the work order and its tabs, and the Master WI library, and reports light
fills, dark text on dark, grey status pills, joined values, ISO dates, header
wraps, column misalignment, overlapping controls, clipped text, truncated
selects, explainer paragraphs and wrapped labels. The target is zero findings.
