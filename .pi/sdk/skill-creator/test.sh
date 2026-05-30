#!/usr/bin/env bash
# Runs the skill-creator SDK test suite.
#
# Usage:
#   ./test.sh          # run all tests
#   ./test.sh <glob>   # run a specific test file (e.g. ./test.sh test/aggregate-benchmark.test.ts)
set -e
cd "$(dirname "$0")"
if [ $# -gt 0 ]; then
	exec node --experimental-strip-types --test "$@"
fi
exec node --experimental-strip-types --test test/*.test.ts
