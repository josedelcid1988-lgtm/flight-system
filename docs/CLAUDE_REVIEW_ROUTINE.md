# Claude PR review routine

Claude reviews every pull request through a Claude Code routine with a GitHub
trigger. It runs on the owner's Claude plan (plan tokens; usage credits stay
off, so a review never bills money). The standard is `REVIEW.md`; the merge
gate is in `AGENTS.md`.

## Routine settings (claude.ai/code/routines)

- Name: Flight System PR review
- Model: Sonnet
- Repository: josedelcid1988-lgtm/flight-system; environment: Default
- Trigger: GitHub event, pull request, actions `opened` and `synchronized`,
  filter `Is draft` equals `false`
- Connectors: none

## Prompt

```
You review one pull request on josedelcid1988-lgtm/flight-system, the one named in the GitHub event that started this run.
1. Check out the PR head. Read AGENTS.md and REVIEW.md in full; REVIEW.md is the review standard. Follow it exactly.
2. Read the PR description and the full diff against its base. Open the surrounding code for every hunk; index.html is large, use grep.
3. If index.html, tests/ or tools/ changed, run: node tools/stamp-build.mjs --check, node tools/build-demo.mjs --check, and the suites for the changed area from TESTING.md (Chromium is preinstalled). A failing check is an Important finding.
4. Post only findings you verified, with a file:line citation and a concrete failure, as inline review comments starting "Important:" or "Nit:".
5. Post one summary comment: the tally line, the PR head SHA, which earlier findings a new push fixed, and as the last line exactly "Claude verdict: OK to merge" or "Claude verdict: changes needed (N important)", as defined in REVIEW.md's Merge gate.
Never push commits, approve, or merge.
```

If this prompt changes, update the routine to match.
