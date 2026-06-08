#!/usr/bin/env bash
# Compare Sprout's speed to other languages (best-of-3 wall-clock).
#   bash benchmarks/bench.sh
cd "$(dirname "$0")"
besttime() { local best=9999; for i in 1 2 3; do local line=$( { time "$@" >/dev/null 2>&1 ; } 2>&1 | grep '^real'); local s=$(echo "$line" | sed -E 's/real[[:space:]]+([0-9]+)m([0-9.]+)s/\1 \2/' | awk '{print $1*60+$2}'); best=$(awk -v a="$best" -v b="$s" 'BEGIN{print (b<a)?b:a}'); done; echo "$best"; }
have(){ command -v "$1" >/dev/null 2>&1; }
have go    && for f in fib loop primes; do go build -o "${f}_go" "$f.go" 2>/dev/null; done
have javac && javac Fib.java Loop.java Primes.java 2>/dev/null
declare -A CAP=( [fib]=Fib [loop]=Loop [primes]=Primes )
printf "%-22s | %-8s | %-8s | %-8s | %-8s | %-8s\n" "benchmark" Sprout Python Node Go Java
for bench in fib loop primes; do
  st=$(besttime node ../src/cli.ts run "$bench.sprout")
  py="  -"; have python && py=$(besttime python "$bench.py")
  js="  -"; have node   && js=$(besttime node "$bench.js")
  go="  -"; [ -f "${bench}_go" ] && go=$(besttime "./${bench}_go"); [ -f "${bench}_go.exe" ] && go=$(besttime "./${bench}_go.exe")
  jv="  -"; [ -f "${CAP[$bench]}.class" ] && jv=$(besttime java -cp . "${CAP[$bench]}")
  printf "%-22s | %7ss | %7ss | %7ss | %7ss | %7ss\n" "$bench" "$st" "$py" "$js" "$go" "$jv"
done
