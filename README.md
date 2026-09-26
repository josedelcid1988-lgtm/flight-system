# Flight System

Skyryse in-house MES. Modules: Flight Control (work order execution and quality
records), Flight Plan (planning), Flight Maneuver (corrective action).
The product build id is set in VERSION.md and stamped into index.html by tools/stamp-build.mjs. See TESTING.md for the test suites.

Start with `docs/HANDOVER.md`: what the system does, the rules and why they exist, a map of
`index.html`, the integration seams, the persistence mirror in `server/`, tests and the release process.

## Original notes

Single-file manufacturing execution system prototype. Open `index.html` in a
browser; keep `assets/` beside it.

Client-side: all state persists to `localStorage` under the key
`skyryse-mes-work-order-v1`. No network calls unless the optional persistence
mirror in `server/` is configured.

## QA pass

Tested at 375x812 (iPhone), 768x1024 and 1024x768 (iPad), and 1440x900 (laptop).
Result after patching: zero clipped elements, zero horizontal scroll, zero
unnamed controls, zero sub-11px text, no console errors.

### Performance

| Item | Before | After |
|---|---|---|
| `hero-cockpit` | 18.1 MB PNG, 9456x7096 (~268 MB decoded) | 304 KB JPEG, 2400px |
| Total payload | ~20 MB | ~1.7 MB |
| Forced splash hold | 5.5 s every load | 2.2 s (0 s under reduced-motion) |
| Background timer | 400 ms DOM read+write, uncleared | 1000 ms, redundant writes skipped |

The hero PNG was used only as a CSS background rendering under 1400 px wide.
At 67 megapixels it was the dominant cause of slow and failed loads on mobile.

### Correctness

- Tab title read `Flight Control · null` on an empty workspace: `selectedId`
  was interpolated while null.
- `.sequence-panel` had `overflow:hidden`, clipping 77 px of operation labels
  on iPhone with no way to scroll to them.
- `Export internal JSON` rendered clipped as `Export internal JSO`.
- The theme cloned the sidebar wordmark into the breadcrumbs, stacking two
  logos and consuming ~150 px above the fold on a phone.
- Two broken user-facing strings: `Invalid saved ` and `A fresh is displayed`.

### Accessibility

- `#att-input` (sr-only file input) had no accessible name; added `aria-label`.
- Raised sub-11px text to an 11 px floor. Shop-floor context: gloves, angled
  screens, mixed lighting.
- 44 px minimum tap targets under `@media(pointer:coarse)`.
- Splash animation suppressed under `prefers-reduced-motion`.

All style changes are isolated in a single appended `<style id="skyryse-qa-fixes">`
block so they can be reviewed or reverted independently of the theme layer.

## Not done

No AWS, NetSuite, or Jira integration layer. The seam for one, whenever it is
built, is the pair of functions `save()` and `mediaCommit()`; every state
mutation funnels through them to that one `localStorage` key.
