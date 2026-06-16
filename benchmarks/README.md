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
| `list_build` | 500,000 `add`s | ~90 ms | **fast** — amortized O(1) push *(v0.1.4: ~160 → ~90 ms)* |
| `comprehension` | build + sum 1,000,000 items | ~400 ms | fine |
| `string_concat` | 30,000 `+=` appends | ~340 ms | ⚠️ **O(n²)** |
| `loop` | 5,000,000 iterations | ~165 ms | **fast** *(v0.1.4: a make-free loop body skips its per-turn scope; was ~800 ms — ~5×)* |
| `fib` | naive `fib(30)` (~2.7M calls) | ~1790 ms | per-call frame allocation dominates *(v0.1.4: ~1960 → ~1790, param names borrowed not copied)* |

**The v0.1.0 GC's cost.** Adding the garbage collector slowed the allocation- and
call-heavy benchmarks (`fib` ~1.3 s → ~2.0 s, `loop` ~0.44 s → ~0.8 s, `list_build`
~0.13 s → ~0.16 s) and left the rest unchanged. That's the standard GC trade — the
language no longer leaks (a loop that used to leak gigabytes now runs in bounded memory),
in exchange for some time on hot paths.

**The v0.1.4 win — pay only for the scopes you use.** Two allocations the tree-walker was
making for nothing:

- A `repeat` loop allocated a fresh environment *every turn* to scope the body's `make`s —
  even when the body has none. Now a make-free body runs straight in the parent scope, so a
  tight loop allocates nothing per turn. **`loop`: ~800 → ~165 ms (~5×)**, and `list_build`
  (a `repeat` of `add`s) ~160 → ~90 ms. Closures, nested `make`s, and `stop`/`skip` behave
  exactly as before — an empty scope is invisible, so eliding it changes nothing.
- Every variable definition copied its *name* with `strdup`, including a recursive call
  binding its parameters on every call. But those names are permanent AST text, so there's
  nothing to copy — the environment borrows them now. Lighter GC pressure everywhere;
  `fib` ~1960 → ~1790 ms (the rest is the per-call frame, inherent to a tree-walker).

Both are pure internal speedups — identical semantics, validated by the full suite + the
examples under `SPROUT_GC_STRESS=1` and AddressSanitizer.

## What this tells us

**The core is fast enough for a tree-walking interpreter.** Recursion, loops, list
growth, sorting, maps, and comprehensions all scale linearly and run at sensible speeds.

Measuring found two O(n²) hot spots. Both are *optimization* targets, not new features:

1. ✅ **Maps — FIXED in v0.0.30.** Maps used a linear key scan (O(n²) to build a large
   one — 20k keys ≈ 0.8 s). Now there's a hash index behind the existing `SMap`: lookups
   are O(1) average, with **identical semantics** (insertion-order iteration preserved,
   `remove`-then-re-add still goes to the back). 20k inserts: **780 ms → 57 ms**; 100k:
   roughly 18 s → 0.11 s.
2. ✅ **Per-turn loop scopes — FIXED in v0.1.4.** A `repeat` loop allocated a fresh
   environment every turn even when the body made no variables; now it elides that scope.
   **`loop`: ~800 ms → ~165 ms (~5×).** Same for the per-definition name copy. (Details
   above.)
3. ⏳ **String building copies the whole string on every `+=`** — still O(n²). The fix is
   a string builder / rope, or batching a chain of `+`. Lower priority (strings are
   usually small, and you can already `join(list, "")` to build in O(n)).
4. ⏳ **Per-call frame allocation** dominates `fib`. Closing it means an arena or a
   slot-based local model — a deeper change I'd weigh carefully against the tree-walker's
   simplicity, not a quick win.

None of these change what programs *mean* — they're internal speedups, driven by data and
tracked here so a future change can show its win in this same table.
