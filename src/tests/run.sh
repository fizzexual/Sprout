#!/usr/bin/env bash
# Run every tests/*.sprout and fail if any errors or prints "FAIL".
# Usage: bash src/tests/run.sh [path-to-sprout-binary]
# Runs from the src/ directory so tests can use paths like "tests/lib.sprout".
set -u
here="$(cd "$(dirname "$0")" && pwd)"   # .../src/tests
src="$(dirname "$here")"                # .../src
cd "$src"

bin="${1:-}"
if [ -z "$bin" ]; then
  if [ -f ./sprout.exe ]; then bin=./sprout.exe; else bin=./sprout; fi
fi

fail=0
for f in tests/*.sprout; do
  if out="$("$bin" run "$f" 2>&1)" && ! printf '%s' "$out" | grep -qiE "sprout error|FAIL"; then
    echo "ok:   $f"
  else
    echo "FAIL: $f"
    printf '%s\n' "$out"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then echo "All tests passed."; else echo "Some tests failed."; fi
exit "$fail"
