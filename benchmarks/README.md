# Sprout benchmarks

A small, reproducible performance suite. Run it with:

```
bash benchmarks/run.sh            # uses src/sprout.exe
bash benchmarks/run.sh /path/to/sprout
```

Times are wall-clock per program (including ~process startup) — meant for **relative
comparison and catching regressions**, not absolute scores.

## Baseline (v0.0.29, Windows, `-O2` build)

| Benchmark | Work | Time | Read |
| --- | --- | --- | --- |
| `sort` | sort 100,000 numbers | ~60 ms | **fast** — C `qsort`, O(n log n) |
| `list_build` | 500,000 `add`s | ~140 ms | **fast** — amortized O(1) push |
| `loop` | 5,000,000 iterations | ~480 ms | fine — ~10M simple ops/s |
| `comprehension` | build + sum 1,000,000 items | ~500 ms | fine |
| `string_concat` | 30,000 `+=` appends | ~520 ms | ⚠️ **O(n²)** |
| `map_insert` | 20,000 distinct keys | ~780 ms | ⚠️ **O(n²)** |
| `fib` | naive `fib(30)` (~2.7M calls) | ~1400 ms | fine — ~2M calls/s for a tree-walker |

## What this tells us

**The core is fast enough for a tree-walking interpreter.** Recursion, loops, list
growth, sorting, and comprehensions all scale linearly and run at sensible speeds.

**Two real O(n²) hot spots, found by measuring** — both are *optimization* targets, not
new features:

1. **Maps use a linear key scan.** Every `m[key]` read/write walks the keys, so building
   or scanning a large map is O(n²) (20k keys ≈ 0.8 s; 100k would be many seconds). The
   fix is a **hash table** behind the existing `SMap` — same language semantics, just a
   faster lookup. This is the higher-priority one (maps are a core data structure).
2. **String building copies the whole string on every `+=`.** So assembling a big string
   one piece at a time is O(n²). The fix is a **string builder / rope**, or having the
   compiler/runtime batch a chain of `+`. Lower priority (strings are usually small; you
   can already `join(list, "")` to build in O(n)).

Neither changes what programs *mean* — they're internal speedups, exactly the kind of
"polish, don't expand" work to do on the road to v0.1. They are tracked here so the
decision to optimize is driven by data, and so a future change can show its win in this
same table.
