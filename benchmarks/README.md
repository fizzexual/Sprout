# Sprout benchmarks

A small, reproducible performance suite. Run it with:

```
bash benchmarks/run.sh            # uses src/sprout.exe
bash benchmarks/run.sh /path/to/sprout
```

Times are wall-clock per program (including ~process startup) — meant for **relative
comparison and catching regressions**, not absolute scores.

## Baseline (Windows, `-O2` build)

| Benchmark | Work | Time | Read |
| --- | --- | --- | --- |
| `sort` | sort 100,000 numbers | ~55 ms | **fast** — C `qsort`, O(n log n) |
| `map_insert` | 20,000 distinct keys | ~57 ms | **fast** — O(1) hash lookup *(v0.0.30; was ~780 ms)* |
| `list_build` | 500,000 `add`s | ~135 ms | **fast** — amortized O(1) push |
| `loop` | 5,000,000 iterations | ~440 ms | fine — ~10M simple ops/s |
| `comprehension` | build + sum 1,000,000 items | ~490 ms | fine |
| `string_concat` | 30,000 `+=` appends | ~490 ms | ⚠️ **O(n²)** |
| `fib` | naive `fib(30)` (~2.7M calls) | ~1300 ms | fine — ~2M calls/s for a tree-walker |

## What this tells us

**The core is fast enough for a tree-walking interpreter.** Recursion, loops, list
growth, sorting, maps, and comprehensions all scale linearly and run at sensible speeds.

Measuring found two O(n²) hot spots. Both are *optimization* targets, not new features:

1. ✅ **Maps — FIXED in v0.0.30.** Maps used a linear key scan (O(n²) to build a large
   one — 20k keys ≈ 0.8 s). Now there's a hash index behind the existing `SMap`: lookups
   are O(1) average, with **identical semantics** (insertion-order iteration preserved,
   `remove`-then-re-add still goes to the back). 20k inserts: **780 ms → 57 ms**; 100k:
   roughly 18 s → 0.11 s.
2. ⏳ **String building copies the whole string on every `+=`** — still O(n²). The fix is
   a string builder / rope, or batching a chain of `+`. Lower priority (strings are
   usually small, and you can already `join(list, "")` to build in O(n)).

Neither changes what programs *mean* — they're internal speedups, exactly the kind of
"polish, don't expand" work to do on the road to v0.1. They are tracked here so the
decision to optimize is driven by data, and so a future change can show its win in this
same table.
