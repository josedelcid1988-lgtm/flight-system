#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
test -d "$SCRIPT_DIR/fixtures"
printf '%s\n' 'Harnesses resolve fixtures relative to their own module files; no path rewriting is needed.'
