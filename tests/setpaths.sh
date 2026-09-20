#!/usr/bin/env bash
# The harnesses were written against the build directory /home/claude/fc.
# This rewrites those paths to this checkout so they run anywhere.
# Usage: bash tests/setpaths.sh        (run from the repo root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tests"
for f in *.mjs *.js; do
  perl -pi -e "s{file:///home/claude/fc/(demo_qa150_publish\.html|demo_qa150\.html|demo_publish\.html|publish\.html)}{file://$ROOT/tests/fixtures/\$1}g" "$f"
  perl -pi -e "s{/home/claude/fc/(demo_qa150_publish\.html|demo_qa150\.html|demo_publish\.html|publish\.html)}{$ROOT/tests/fixtures/\$1}g" "$f"
  perl -pi -e "s{/home/claude/fc/}{$ROOT/tests/}g" "$f"
  perl -pi -e "s{/home/claude/shots}{$ROOT/tests/shots}g" "$f"
done
mkdir -p "$ROOT/tests/shots"
echo "paths set to $ROOT"
