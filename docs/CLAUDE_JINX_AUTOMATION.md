# Jinx review automation

The `claude-jinx-review.yml` workflow lets Claude evaluate Jinx's GitHub review comments and apply valid fixes to the open `flight-v82-datum-port` pull request. It runs the repository's local and mirror suites and reports the outcome on the pull request. It cannot merge the pull request.

## GitHub setup

1. In the `flight-system` repository, open **Settings → Secrets and variables → Actions**.
2. Add the repository variable `JINX_BOT_LOGIN`. Set it to the exact GitHub login shown as the author of Jinx's review comments. The workflow remains inactive for comments from every other account.
3. Add either the `CLAUDE_CODE_OAUTH_TOKEN` secret or the `ANTHROPIC_API_KEY` secret. The workflow accepts either credential.
4. Add this workflow to the repository's default branch. GitHub only loads `issue_comment` and `pull_request_review_comment` workflows from the default branch, so the file on `flight-v82-datum-port` is staged configuration until the branch is merged.

Claude receives repository write permission so it can push verified fixes to the open pull request branch. Review comment text is untrusted input; the workflow only runs for the configured Jinx login and only when the pull request head is `flight-v82-datum-port`.
