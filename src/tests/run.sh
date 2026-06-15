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

# The example gallery doubles as an end-to-end smoke test: every example must run
# without a runtime error. (They print output rather than assertions, so we only gate
# on "sprout error".)
for f in ../examples/*.sprout; do
  [ -e "$f" ] || continue
  if out="$("$bin" run "$f" 2>&1)" && ! printf '%s' "$out" | grep -qiE "sprout error"; then
    echo "ok:   $f (example)"
  else
    echo "FAIL: $f (example)"
    printf '%s\n' "$out"
    fail=1
  fi
done
rm -f sprout.data.json   # the todo example writes one; it's gitignored anyway

# --sandbox / SPROUT_SANDBOX must block every file/shell/network builtin (for a playground
# running untrusted code). The probe lives in tests/sandbox/ so the loop above skips it.
if [ -f tests/sandbox/probe.sprout ]; then
  out="$(SPROUT_SANDBOX=1 "$bin" run tests/sandbox/probe.sprout 2>&1)"
  if printf '%s' "$out" | grep -qE "ok: all [0-9]+ dangerous ops blocked"; then
    echo "ok:   sandbox blocks file/shell/network builtins"
  else
    echo "FAIL: sandbox did not block everything"
    printf '%s\n' "$out"
    fail=1
  fi
fi

if [ "$fail" -eq 0 ]; then echo "All tests passed."; else echo "Some tests failed."; fi
exit "$fail"
