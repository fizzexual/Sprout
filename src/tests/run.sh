#!/usr/bin/env bash
# Run every tests/*.sprout and fail on any error or failed assertion.
# Two gating styles, by filename:
#   *_test.sprout  -> a `test`/`expect` framework file: run with `sprout test`, gate on the EXIT CODE
#                     (a failing `expect` prints an "x" line, not "FAIL", so grep alone would miss it).
#   everything else -> a plain guarded script: run with `sprout run`, gate on output (errors / "FAIL").
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
  case "$f" in
    *_test.sprout)
      if out="$("$bin" test "$f" 2>&1)"; then
        echo "ok:   $f (sprout test)"
      else
        echo "FAIL: $f (sprout test)"
        printf '%s\n' "$out"
        fail=1
      fi
      ;;
    *)
      if out="$("$bin" run "$f" 2>&1)" && ! printf '%s' "$out" | grep -qiE "sprout error|FAIL"; then
        echo "ok:   $f"
      else
        echo "FAIL: $f"
        printf '%s\n' "$out"
        fail=1
      fi
      ;;
  esac
done

if [ "$fail" -eq 0 ]; then echo "All tests passed."; else echo "Some tests failed."; fi
exit "$fail"
