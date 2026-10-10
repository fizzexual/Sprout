# Reproducible performance and fuzz evidence

## Workload timings

```text
python benchmarks/profile.py src/sprout --samples 5 --warmups 1 --output performance.json
```

The workload suite covers arithmetic loops, growing collections, task calls and
text construction. Reports include every sample, median/min/max wall times,
source hashes, an output hash, and the interpreter hash. Measurements include
process startup. Use the same compiler, optimization flags, machine and workload
bytes when comparing builds; inspect variance before treating a small difference
as an improvement. Historic numbers in `benchmarks/README.md` describe earlier
versions and are not measurements of the current production foundation.

`benchmarks/production-baseline-2026-10-10.json` records a five-sample Windows
GCC 16.2 `-O2 -DSPROUT_SQLITE` build of the shipping AST runtime. Median process
wall times were 0.1411 s (arithmetic), 0.0985 s (collections), 0.0924 s (tasks)
and 0.0345 s (text). These short local timings are a baseline for that binary
hash, not a cross-language comparison or performance guarantee.

The numeric bytecode prototype is kept under `benchmarks/prototypes/` because its
five-sample gate failed. The baseline JSON records that decision explicitly.
No faster-runtime claim follows from adding a bytecode format.

## Observed trace profile

```text
python tools/profile_trace.py src/sprout examples/fizzbuzz.sprout --output trace-profile.json
```

The profiler groups trace event counts by file, line and event kind. Where the
runtime includes `elapsed_ms`, it also adds intervals between adjacent observed
events. Those intervals include tracing overhead, nested calls and I/O; they do
not measure exclusive CPU time. A trace is a capped prefix (5000 events or 2 MiB),
so counts and intervals must not be presented as a complete profile after the cap.
Program stdout stays separate from trace stderr. Program failure is propagated.

## Deterministic fuzzing

```text
python tools/fuzz.py src/sprout --iterations 200 --seed 20261010 --report fuzz.json --artifacts fuzz-artifacts
```

The standard-library-only harness generates arithmetic programs and checks their
results against a separate Python arithmetic oracle, mutates representative
grammar inputs, and probes fixed malformed/deep/NUL inputs. Generated execution
uses sandbox mode, a 10,000-step budget, a 500 ms runtime deadline and an outer
process timeout. Malformed parser inputs may succeed or report a language error;
process crashes, sanitizer reports and hangs fail the run and retain the exact
source and a metadata JSON file for reproduction.

With the recorded seed, 200 generated cases, 200 grammar mutations and eight
fixed malformed cases completed without failure in both the AST and experimental
numeric-bytecode variants. This does not cover every language feature, establish
security isolation, or replace long-running/sanitizer/native coverage fuzzing.
Run the same harness against AddressSanitizer/UndefinedBehaviorSanitizer builds
for stronger evidence, and extend the corpus whenever a regression is fixed.
