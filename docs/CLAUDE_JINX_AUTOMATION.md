# Claude and Jinx pull request automation

`claude-pr-review.yml` reviews each PR head when it is opened, updated, marked ready, or reopened. It asks Claude for a strict structured decision and fails unless the result explicitly approves the exact event SHA. A new commit starts a new Claude review; a decision from an older SHA cannot satisfy the merge gate.

`auto-merge-reviewed-pr.yml` merges with a SHA-guarded squash only after the latest CI workflow run succeeds for the current PR head, the latest Claude PR Review check succeeds for that head and is backed by its successful workflow run, and the configured Jinx account's latest formal GitHub PR review is `APPROVED` on that same head SHA. A newer commit makes prior Jinx reviews stale because their `commit_id` no longer matches. The gate re-reads the PR and evidence immediately before attempting the merge. It adds no human approval requirement.

## Approval signal limits and required setup

The checkout reviewed for this change does not contain `REVIEW.md` or `docs/CLAUDE_REVIEW_ROUTINE.md`. The tracked default branch also has no Claude review workflow. Its only tracked workflow is CI. The local, untracked `claude-jinx-review.yml` handles comments attributed to `JINX_BOT_LOGIN`; it does not emit a formal Jinx approval. No existing Jinx `APPROVED` review signal or authoritative Claude approval signal could be verified from the repository history. For that reason the merge gate fails closed: it requires a formal Jinx GitHub review and a successful, exact-SHA Claude workflow decision. A Jinx comment by itself never authorizes merging.

The Claude decision is a new workflow-generated signal, not a previously documented repository approval. The workflow exposes the validated structured result as a successful check only when `approved` is explicitly true; errors, missing output, or findings fail the check. The check is created against the reviewed PR head SHA and tied to the originating workflow run; the merge gate verifies both against the live PR head.

Before enabling this automation on the default branch:

1. Confirm that Jinx actually records approval as a submitted GitHub PR review with state `APPROVED`. If its real signal is different, document and implement a verifiable equivalent tied to an immutable head SHA before allowing merge. Until then, the gate will not merge.
2. Set the repository Actions variable `JINX_BOT_LOGIN` to the exact Jinx GitHub login. An empty or wrong value blocks merging.
3. Configure either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as an Actions secret. Missing credentials or an unavailable Claude decision block merging.
4. Keep both workflows on the default branch so PR-target and workflow-run gate logic comes from trusted base-branch code. Ensure the repository permits the Actions token to merge PRs; any repository protection rule that refuses the SHA-guarded merge remains authoritative.

No human approval is requested or used by these workflows. CI, Claude, Jinx and GitHub's own merge protections are the only gates described here.
