#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ $# -gt 0 ]; then
	exec node --experimental-strip-types --test "$@"
fi
exec node --experimental-strip-types --test test/*.test.ts
