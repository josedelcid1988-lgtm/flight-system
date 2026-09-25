#!/usr/bin/env bash
# The harnesses carry absolute paths from the machine they were last run on.
# This rewrites any such path (whatever checkout it came from) to this checkout
# so the suites run anywhere: file URLs and plain paths under tests/fixtures/
# and tests/shots/, plus the two historical layouts (/home/claude/fc and the
# original author's checkout) that predate the fixtures directory.
# Usage: bash tests/setpaths.sh        (run from the repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tests"
for f in *.mjs *.js; do
  perl -pi -e "s{file:///home/claude/fc/(demo_qa150_publish\.html|demo_qa150\.html|demo_publish\.html|publish\.html)}{file://$ROOT/tests/fixtures/\$1}g" "$f"
  perl -pi -e "s{/home/claude/fc/(demo_qa150_publish\.html|demo_qa150\.html|demo_publish\.html|publish\.html)}{$ROOT/tests/fixtures/\$1}g" "$f"
  perl -pi -e "s{/home/claude/fc/}{$ROOT/tests/}g" "$f"
  perl -pi -e "s{/home/claude/shots}{$ROOT/tests/shots}g" "$f"
  # Any absolute checkout path into tests/ (fixtures, shots, helpers, result files), with one or three slashes after file:.
  perl -pi -e "s{(file:/+)?/(?:Users|home|opt|srv|var|mnt|tmp)/[^'\"\s]*?/tests/}{\$1 ? \"file://$ROOT/tests/\" : \"$ROOT/tests/\"}ge" "$f"
done
mkdir -p "$ROOT/tests/shots"
echo "paths set to $ROOT"
