# QA inspection, 25 September 2026

Scope: every harness in `tests/` run against the production build (`index.html`,
fixture `publish.html`) and the demo build (`demo.html`, fixtures
`demo_publish.html`, `demo_qa150.html`, `demo_qa150_publish.html`), a
demo-versus-production comparison, and a ranked list of changes worth making
next.

Build under test: v81 (`VERSION.md`), commit `72ffbc7`. Browser: Chromium 1194
through Playwright, `CHROME_PATH` set.

## 1. Are the fixtures the builds?

Yes. `tests/fixtures/publish.html` is byte-identical to `index.html` apart from
the one-line build-id comment. `tests/fixtures/demo_publish.html` is identical
to `demo.html`. The 150-order fixtures carry the same code with a larger sample
workspace. Everything below therefore tests what is in the repository.

## 2. Demo versus production

The demo build is the production build plus a fixed set of relaxations. The
whole difference (348 changed lines) is:

| Difference | Demo | Production |
| --- | --- | --- |
| Sample workspace and demo accounts preloaded | yes | no |
| `isDemoAccount()` / `isDemo()` | always true | true only for the `demo` username |
| `can(cap)` / `skCan(cap)` capability checks | always true | real role check |
| `canManageAccess(u)` | true for every account outside the pilot seat list | Master Access or QA Manager |
| Separation-of-duties comparisons (18 rules) | compare against a sentinel that never matches | compare against the actor |
| Stamp PIN step-up (FAIR, 8130-9) | lifted | enforced |
| Stamp check | synthetic `DEMO` holder | Stamp Control Log |
| Work order cap | 250 | 100 |
| Storage key | `skyryse-mes-work-order-qa100-v1` | `skyryse-mes-work-order-v1` |
| Title | Flight System Demo | Flight System |

No feature exists in the demo that is missing from production. Production is
fully realized relative to the demo; the demo only removes gates.

Two things in that table deserve attention:

- The production engine carries a username-based relaxation: an account named
  `demo` bypasses the stamp check, the self-approval rule on NC dispositions
  and the MRB seat rule in the production build. Creating such an account
  needs Master Access or a QA Manager, so it is not an open door, but a
  production build should not know a magic username. The fix is to move
  these relaxations into a demo build chain as marked replacements so the
  production source carries none.
- The demo build's comment says the five pilot seats (`mfgeng`, `operations`,
  `tech`, `quality`, `engineering`) keep their real role capabilities and only
  `demo` and `master` are wide open. The build does the opposite: every seat
  has every capability. That is what fails the seven `Demo / Roles` checks in
  `qa_full` below.

## 3. Results

First run, before any change: every fixture-based suite died in under two
seconds. The harnesses had the original author's absolute path
(`/Users/<user>/projects/flight-system`) baked in and `tests/setpaths.sh`
only rewrote the older `/home/claude/fc` layout; Playwright also expected a
different Chromium build. Neither is a product failure. After fixing the
script and setting `CHROME_PATH`:

| Suite | Build | Result | Verdict |
| --- | --- | --- | --- |
| `qa_full` | production + demo (150) | 307 checks: 297 pass, 7 fail, 3 skip | 7 fails are the demo RBAC relaxation (section 2); 2 skips pre-date the fork; 1 skip is the release zip check without `RELEASE_OUTPUT_DIR` |
| `qa_e2e` | demo (150) | 30 flows, 0 failed | pass |
| `qa_multi` | demo (150) | 161 pass, 0 fail | pass |
| `pilot_rehearsal` | demo (150) | pass | pass |
| `stable_test` | production + demo | 64 checks stable | pass (after removing the `/tmp/auth.json` dependency) |
| `test_v74` to `test_v78` | demo (150) | pass | pass |
| `test_v79` | demo (150) | 1 fail: close-as-Scrap option missing | real demo-build defect, fixed in `index.html` (section 4) |
| `test_v80`, `v80c`, `v80d`, `v80e`, `v80h` | production / demo | pass | pass |
| `test_v80i` | demo (150) | crash: stamp number field absent | stale harness plus a real submit-handler defect, both fixed (section 4) |
| `qa_access` | production | pass | pass |
| `qa_master` | production | pass | pass |
| `qa_operator` | demo | 3 stale assertions | harness updated to the v80 cues (section 5) |
| `qa_ui` | production | 1 stale assertion | harness updated (section 5) |

No browser page errors were reported by any suite. `MES.validate(state)` held
in every flow.

Addendum, 26 September: a re-run in a clean container after the harness and
product fixes merged found three suites this table reports as passing now
failing: `qa_multi` (1: "Stamp prompt appears when the last step is checked",
the demo account's override prompt has no stamp number field), `test_v77`
(1: "quality account cannot take the Certification seat") and `test_v78`
(its print capture stub records nothing, so every print assertion fails).
They are tracked in `KNOWN-ISSUES.md` and handled by the handover items.

## 4. Product defects found and fixed (`index.html`)

1. **Stamp prompt submit asked for a stamp number it never showed.** The
   prompt (`stampPrompt`) hides the stamp number field when
   `MES.buyoffCredential` returns an override (Master Access, or the demo
   account). The submit handler only recognised Master Access, so on the
   override path it refused with "Enter your stamp number." and there was no
   field to type into. The handler now derives the same override condition
   from `MES.buyoffCredential`. Production behaviour for stamped buy-offs is
   unchanged. Verified: `test_v80i` passes on a demo fixture carrying the fix.
2. **NC quality review refused the demo account's own approval in the view
   while the engine allowed it.** `ticketQualityReview` compared the
   disposition author to the actor without the demo relaxation the engine
   applies in `resolveTicket`, so the Scrap approval form never rendered and
   the "Also close as Scrap" option was unreachable. The view now asks the
   engine (`MES.demoAccount()`, newly exported from the same `isDemoAccount`
   the engine uses) so the two agree, and the demo build chain's existing
   replacement of that predicate covers both. Production separation of duties
   is unchanged. Verified: `test_v79` passes on a demo fixture carrying the fix.

Both fixes need the demo build (`demo.html` and the three demo fixtures)
regenerated from `index.html` before the committed fixtures show them; the
build chain is outside this repository.

## 5. Harness defects found and fixed (`tests/`)

- `setpaths.sh` now rewrites any absolute checkout path into `tests/`, with
  `file:` URLs of either slash count, instead of one historical layout.
- `qa_full`: the demo title assertion expected "Flight System (Demo)"; the
  product says "Flight System Demo". The release zip check pointed at
  `/mnt/user-data/outputs`, a directory from the container that built v72; it
  now reports Skip unless `RELEASE_OUTPUT_DIR` is set.
- `stable_test`: read `/tmp/auth.json`, which never existed in the
  repository, and a hard-coded fixture path. It now seeds its own Master
  Access account and resolves fixtures relative to itself.
- `qa_ui`: clicked a "Next aircraft photograph" button removed in the v80
  refinement (`77c4f67`); it now asserts the single landing photograph.
- `qa_operator`: selected fixed sample ids (`WO-10003`, `WO-10005`) whose
  state changed with the NC/IDR consolidation, expected a pending sequence
  change to classify as an approval step (the product classifies it as an
  issue, "Change approval required"), and looked for a `.release-summary`
  glow that now lives on the release next-action button.
- `test_v80i`: typed a stamp number into a field the override prompt does not
  render.

## 6. Still open

| Item | Where | Owner |
| --- | --- | --- |
| Demo build grants every pilot seat every capability (7 `qa_full` fails) | demo build chain, outside this repo | rebuild demo with `isShared()` honouring the pilot seat list |
| `demo.html` and demo fixtures do not yet carry the two `index.html` fixes | demo build chain | regenerate on next release |
| Production engine knows the `demo` username | `index.html` | move the relaxation into a demo build chain (see section 7, item 1) |
| `Production / Render 1440 / View mnv-board renders` and `Signature manifests verify` report Skip | `qa_full` | pre-existing since the fork; not investigated |
| `qa_access` and `qa_master` were run against the pre-fix `index.html` only | this inspection | re-run after the demo rebuild; `qa_ui` did run against the fixed file and passed |

## 7. Recommended next changes

Ranked by value against effort, respecting `AGENTS.md` (one file, no external
scripts, gates never simplified):

1. **Demo build chain in the repository.** Every demo relaxation becomes a
   marked replacement that must match exactly once; `demo.html` is rebuilt
   from `index.html` and a check verifies it is current. This fixes the seven
   RBAC failures, removes the `demo` username from the production engine, and
   ends the "demo lags production" problem behind sections 4 and 6.
2. **Work order ceiling counts open orders only.** Today the 100 cap counts
   closed orders and the refusal says "Reset the workspace", which is not a
   next step.
3. **Capability-based MRB seats and safety buy-off.** Seats become
   capabilities instead of role-name checks in `seatsForRole`, and the QA
   Manager holds the safety buy-off capability the manual already describes.
   `mrb-cert` is granted but never checked, which should be verified.
4. **Nobody inspects their own work.** A narrow inspection capability for the
   Quality role, and an inspection refused to anyone who performed the build
   operations it covers, Master Access included. Directly on the AS9100 /
   Part 21 path this product is on.
5. **Stronger password and stamp PIN hashing.** The demo accounts show
   `salt: "00"` with SHA-256 hashes. A memory-hard hash (scrypt) with the
   parameters stored in the hash, constant-time compare and rehash on next
   sign-in, without changing the storage key.
6. **Closed-order archive.** Closed orders leave the live document and stay
   searchable, viewable and printable, with counters so numbers are never
   reused.
7. **Repository hygiene**: `KNOWN-ISSUES.md` and `CHANGELOG.md`; the role
   matrix generated from the role table so documents cannot drift from code;
   fictional names in defaults and sample data.

## 8. How this was verified

- All suites run from this checkout after `bash tests/setpaths.sh`, with
  `CHROME_PATH` set to the installed Chromium.
- The two `index.html` fixes were verified by applying the same three text
  patches to a scratch copy of `demo_qa150_publish.html` (each matched exactly
  once) and running `test_v79` and `test_v80i` against it: both report
  `FAILS []`. The committed fixtures are unchanged and still show the old
  behaviour until the demo is rebuilt.
- After the harness fixes: `qa_full` 297 pass / 7 fail (all demo RBAC) /
  3 skip; `qa_ui`, `qa_operator`, `stable_test` pass; the fixture suites
  listed in section 3 unchanged.
