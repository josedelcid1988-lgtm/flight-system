#!/usr/bin/env bash
# Kept for old instructions. Every harness now resolves its fixtures, shots and
# result files from its own folder (TESTS at the top of each file), so no path
# needs rewriting and nothing in tests/ changes when the suites run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/tests/shots"
echo "no paths to set; harnesses resolve from $ROOT/tests"
