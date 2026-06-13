# Sprout benchmarks

A small, reproducible performance suite. Run it with:

```
bash benchmarks/run.sh            # uses src/sprout.exe
bash benchmarks/run.sh /path/to/sprout
```

Times are wall-clock per program (including ~process startup) — meant for **relative
comparison and catching regressions**, not absolute scores.

## Baseline (Windows, `-O2` build, **with the v0.1.0 GC**)

| Benchmark | Work | Time | Read |
| --- | --- | --- | --- |
| `sort` | sort 100,000 numbers | ~55 ms | **fast** — C `qsort`, O(n log n) |
| `map_insert` | 20,000 distinct keys | ~55 ms | **fast** — O(1) hash lookup *(v0.0.30; was ~780 ms)* |
| `list_build` | 500,000 `add`s | ~160 ms | **fast** — amortized O(1) push |
| `comprehension` | build + sum 1,000,000 items | ~450 ms | fine |
| `string_concat` | 30,000 `+=` appends | ~485 ms | ⚠️ **O(n²)** |
| `loop` | 5,000,000 iterations | ~800 ms | fine — pays the per-statement GC safe-point check |
| `fib` | naive `fib(30)` (~2.7M calls) | ~1960 ms | fine — now collects ~2.7M envs that used to leak |

**The v0.1.0 GC's cost.** Adding the garbage collector slowed the allocation- and
call-heavy benchmarks (`fib` ~1.3 s → ~2.0 s, `loop` ~0.44 s → ~0.8 s, `list_build`
~0.13 s → ~0.16 s) and left the rest unchanged. That's the standard GC trade — the
language no longer leaks (a loop that used to leak gigabytes now runs in bounded memory),
in exchange for some time on hot paths. The collector is a first implementation; the
threshold and the per-statement safe-point check are the obvious tuning knobs.

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
