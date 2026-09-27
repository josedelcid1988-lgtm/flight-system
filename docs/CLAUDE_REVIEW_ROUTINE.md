# Claude pull request review workflow

Claude reviews each ready pull request through the GitHub Actions workflow
`.github/workflows/claude-pr-review.yml`. It uses Claude Code OAuth from the
`claude-review` GitHub Environment and the Claude GitHub App for GitHub
operations. It does not use an Anthropic API key or a user GitHub token.

## Live workflow settings

- Model: Opus (`claude-opus-5`).
- Authentication: the `CLAUDE_CODE_OAUTH_TOKEN` secret stored in the
  `claude-review` environment.
- GitHub: built-in Claude GitHub App/MCP only. The allow-list is limited to PR
  and file reads and posting a summary. Claude cannot edit code, push, approve,
  or merge.
- Trusted workflow: `pull_request_target` runs the workflow definition from the
  base repository's default branch. The job does not check out or execute PR
  code. The environment must restrict deployments to `main` only.
- Events, each filtered to `Is draft = false`:
  - Pull request opened.
  - Pull request synchronize.
  - Pull request ready for review.
  - Pull request reopened.
  - Pull request edited, so title and description changes require a new verdict.
- Policy: Claude reads `AGENTS.md` and `REVIEW.md` from `origin/main` at the
  exact current main SHA, never from the PR head. The workflow computes a
  SHA-256 from the exact PR title and description. Claude includes that digest
  with its reviewed head and main SHAs in its verdict. CI-enforced checks are
  left to CI.

The live prompt is in `.github/workflows/claude-pr-review.yml`. It treats PR
content as untrusted, inspects the full diff and surrounding source, reports
only verified findings with file and line citations, and posts one summary
comment as `claude[bot]`. The summary records:

- `PR head SHA reviewed: <exact PR head SHA>`
- `Main SHA reviewed against: <exact current main SHA>`
- `PR description SHA-256 reviewed: <trusted workflow output>`
- A final verdict line matching `REVIEW.md`.

Do not add the Claude action's `github_token` input. That would post as the
token owner instead of `claude[bot]`.

## Jinx approval and automatic merge

The Jinx approval signal is the latest submitted GitHub pull request review
with state `COMMENTED`, `commit_id` equal to the current PR head SHA, and a
standalone no-blockers statement such as `Jinx verdict: No blockers`. The
Actions variable `JINX_REVIEWER_LOGIN` must contain Jinx's dedicated GitHub
login, distinct from the PR author. An issue conversation comment, a review by
the PR author, a review with another state, ambiguous wording, or a review on an
older commit does not approve the PR.

The merge gate also requires all of the following:

- CI completed successfully on the current PR head.
- The latest `claude[bot]` summary approves the current head, current main SHA,
  and current PR title and description digest.
- The PR is open, ready for review, targets `main`, is mergeable, and is not
  behind current `main`.
- No unresolved Important review thread remains. Markdown Important labels and
  P1 review badges both count as blockers.
- The PR does not change `.github/workflows/**`,
  `.github/scripts/review-gate.cjs`, `tools/run-suites.mjs`,
  `tests/allowed_skips.json`, `tests/test_frozen_contract.mjs`, or
  `tests/test_review_gate.mjs`. Renames from protected paths and incomplete
  changed-file listings also disable auto-merge. Such PRs require a manual
  merge after every other gate passes.

The privileged merge workflow runs from trusted `main` on pull request target
events, Claude comments, completed CI or Claude workflows, and a five-minute
sweep. It does not use `pull_request_review`, which runs the workflow from the
PR merge branch. The sweep retries after Jinx submits a review or an Important
thread is resolved. The workflow re-fetches the PR and rechecks all evidence
immediately before a SHA-guarded squash merge. Protect `main` by requiring the
PR branch to be up to date, to prevent a base-branch race at merge time.

## One-time repository setup

1. Create a GitHub Actions Environment named `claude-review`.
2. Restrict environment deployments to the `main` branch.
3. Add `CLAUDE_CODE_OAUTH_TOKEN` as an environment secret. Remove repository or
   organization secrets with that name after confirming the environment secret
   is available.
4. Set `JINX_REVIEWER_LOGIN` to Jinx's dedicated GitHub login. Do not set it to
   the PR author's login. If Jinx cannot submit an independent review, the gate
   remains blocked.
5. Enable Actions `GITHUB_TOKEN` write permissions for workflows and require
   the PR branch to be up to date before merging to `main`.

This bootstrap PR changes protected workflow and gate files, so it cannot
auto-merge itself. Merge it only after fresh Claude and Jinx approvals for its
final head and green CI. If any setup value or review signal is missing, the
automation waits without merging.
