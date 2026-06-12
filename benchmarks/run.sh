#!/usr/bin/env bash
# Time every benchmark in this folder. Wall-clock per program (includes ~process startup),
# meant for relative comparison and regression-watching, not absolute scores.
# Usage: bash benchmarks/run.sh [path-to-sprout-binary]
set -u
here="$(cd "$(dirname "$0")" && pwd)"
bin="${1:-}"
if [ -z "$bin" ]; then
  if [ -f "$here/../src/sprout.exe" ]; then bin="$here/../src/sprout.exe"; else bin="$here/../src/sprout"; fi
fi
echo "binary: $bin"
"$bin" version 2>/dev/null | head -1
echo "-----------------------------------------"
for f in "$here"/*.sprout; do
  name="$(basename "$f" .sprout)"
  s=$(date +%s%N)
  "$bin" run "$f" >/dev/null 2>&1
  e=$(date +%s%N)
  printf "%-20s %6d ms\n" "$name" "$(( (e - s) / 1000000 ))"
done
