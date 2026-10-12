# Measure a fixed library workload

This tool records a small synthetic application workload on an explicitly trusted,
pinned native runtime. It helps separate preparation from validation, shallow
configuration merging, literal request routing, JSON response construction and
checkpoint summarizing. It does not establish a language ranking, SLA, tail
latency, arbitrary capacity, general production readiness or an eight-hour result.

The tools are available on the revival branch. Revision `1992c9a` passed all eight
jobs in [CI 38315637983](https://github.com/fizzexual/Sprout/actions/runs/38315637983),
including39 tool controls on each native platform. The earlier74ea run failed
a fixture's canonical-root spelling assertion on Windows/macOS; that evidence
is retained. A [reviewed historical derived copy](../benchmarks/library-workloads/README.md)
restores48 SDK host labels omitted by the first private export; every other
decoded value is unchanged. The exporter correction passed full
[CI 38319793595](https://github.com/fizzexual/Sprout/actions/runs/38319793595)
on `a3e11de`, including40 tool controls on each native platform.
No new Sprout measurement was run
to prepare this package. The historical experiment used one normal-collector
Windows `6b8c724` / `4ffec927...` runtime and completed204 observations without
an invariant error. It preserves34 warmups and five measured samples for every
case/mode. That runtime's separate functional CI does not qualify new tooling.

| Cases | Fixed input and batch | Purpose |
| --- | --- | --- |
| V1 / V64 / V512 | 1 /64 /512 exact-ID/decimal/Unicode records; batch8 /8 /4 | Valid declarative validation |
| Verrors |64 invalid synthetic records; first64 errors, explicit truncation; batch8 | Bounded aggregated diagnostics |
| Csmall / Cmedium / Clarge |16 /32 /128 root keys,1 /4 /16 file layers; batch8 /8 /4 | Atomic nested values and ordered shallow precedence |
| Aselect1 / Aselect32 |1 /32 literal routes, exact body/query; batch8 /4 | Contract-first route selection |
| Aresult2K / Aresult32K | Complete DTO plus2-byte line reserve=2048 /32768B; batch8 /4 | Bounded JSON-compatible exact response trees |
| P1 / P128 |1 complete /128 mixed-status jobs; batch8 | Exact attempts, uncertainty and fingerprint mismatch summaries |
| Hmin / Hecho16K | Minimal /16384B encoded synthetic input | Inclusive Python and Node stock-SDK calls |
| HpreviewValid / HpreviewInvalid | Synthetic contacts preview, accepted/rejected body | Validation/router rule calls, no persistence |

The versioned specification fixes13 prepared cases and four cases per SDK.
Pure calls=13*(1 warmup+5 paired samples)*2=156. SDK calls=4*2*(1 warmup+5)=48.
There are204 interpreter-call reservations under208, without retries. A persistent
Node parent and internal OS guardians are not extra language samples;204 is not
a claim about total OS process count. Full/control pair order alternates by sample.

Prepared programs import and restore the same fixture before a flushed READY/GO
barrier. Timing starts before the bounded GO write and stops at receipt of DONE.
Serialization, oracle comparison, startup and teardown are outside that phase.
The constant-result control has the same import/input/batch setup. Durations
include dispatch/synchronization; differences are not exclusive CPU time.
SDK input restoration precedes timing; the stock run call includes its own
serialization/spawn/VM/decoding, and output comparison follows the stop clock.

Keep all five raw samples, median/min/max/MAD and paired differences. Negative or
zero differences are retained as `not_separable_from_noise`; no sample is retried,
dropped, clamped, tuned or converted into a percentile claim. Clock representation
and clock resolution are distinct. UTC labels are attribution, not the monotonic
stopwatch or stable-clock deployment qualification.

## Explicit local inputs

Use Python3.10+ and the stock Node SDK's Node18+ interface. Executable hashes and
recorded version availability identify the actual combination; this does not
claim every version combination was measured. No dependency, compiler or runtime
is installed, downloaded or automatically selected. No network API is used.

Prepare a caller-pinned `sprout.measurement-selection.v2` JSON with these fields:

```json
{
  "schema":"sprout.measurement-selection.v2",
  "profile":"windows-native-sqlite-normal-v1",
  "revision":"<40 lowercase hex characters>",
  "source_root":"exported-source",
  "application_sources":{"<each of7 required source names>":"<sha256>"},
  "native_path":"runtime.exe","native_sha256":"<sha256>",
  "build_path":"build.json","build_sha256":"<sha256>",
  "compiler_path":"toolchain/compiler.exe","compiler_sha256":"<sha256>",
  "ci_path":"completed-ci.json","ci_sha256":"<sha256>",
  "python_path":"<selected Python path>","python_sha256":"<sha256>",
  "node_path":"<selected Node path>","node_sha256":"<sha256>",
  "spec_path":"v1-spec.json","spec_sha256":"<sha256>"
}
```

Paths resolve relative to the record, with absolute paths also allowed. There is
no drive/username/suffix/cwd assumption in executable selection. Source export
bytes must match all19 declared canonical build input digests and the7 explicit
library/SDK/preview digests. The build record identifies a normal Windows SQLite
build; the pinned CI record must match its revision and all eight declared
completed successful jobs. Attempt is retained. Candidate/compiler/source bytes
are copied/hashed without rewriting text. These are consistency checks with
independently trusted caller pins, not authenticity from self-claimed metadata.

```sh
python tools/prepare_measurement.py --selection selection.json --selection-sha256 SHA
python tools/prepare_measurement.py --selection selection.json --selection-sha256 SHA --prepare --destination frozen
python tools/measure_workloads.py --snapshot frozen --manifest-sha256 MANIFEST_SHA
```

Both inspection commands are check-only by default: no workload/SDK/compiler
child, write or marker consumption. Python helper bytecode writes are disabled
by the tool. The explicitly trusted host interpreter may have its own startup
hooks; this is not an OS isolation promise. Preparation is a separate explicit
write to a new destination and never compiles or launches a workload. It carries
compiler identity bytes, specification, selected sources and actual controller
files. Check-only works with those portable relative inventory names without
requiring the original machine's compiler location.

Full execution is Windows-only in v1. Path handling, generation, export and
inspection are portable. Linux/macOS execution refuses before launch until a
separately reviewed ownership profile exists. Fake tests on a platform do not
make it measured. Moving to another host requires explicitly reselecting and
pinning the host interpreters, never silently finding a different Node executable.

## One finite invocation

An externally pinned `sprout.measurement-reviewed-scope.v2` record binds profile,
snapshot/native/CI/Python/Node hashes, exact absolute output directory, bounded
ASCII run ID, `scope_reviewed_and_sealed:true`, and the unchanged bounds. Invoke
the copied controller, rather than another file with a convenient name:

```sh
python frozen/controller/measure_workloads.py --run-once --snapshot frozen --manifest-sha256 MANIFEST_SHA --scope-record scope.json --scope-sha256 SCOPE_SHA --report new-report
```

The loaded controller/helper paths and bytes must match the frozen inventory.
An exclusive sibling `.new-report.attempt.json` is reserved before execution and
remains even if startup fails. The same output cannot silently be retried; a new
experiment needs a deliberately new reviewed scope/output. There is no CLI for
tuning counts, deadlines, warmups or samples. Inspection is not a new permission
request; callers are responsible for the trusted scope they explicitly choose.

The supervisor has90s, runtime3s, host at most4s and separate2s owned-process
cleanup. Stdout/stderr are capped at262144 /65536B, fixtures1MiB, report2MiB.
Selection64KiB, metadata1MiB, source files32MiB, runtime/compiler64MiB,
host interpreter files256MiB and total snapshot256MiB are fixed input bounds.
Regular-file/size checks precede pin hashing, and streaming reads stay within
their credited bytes. Inventory hashing retains preflight sizes and rechecks
the aggregate; growth fails. Snapshot copying and artifact reads reserve their
remaining byte allowance before collecting or hashing data. These checks cover
the tool's reads, not arbitrary filesystem operations inside a trusted worker.
OS creation, queries and filesystem calls cannot be preempted, so this is not
a hard inclusive wall90s promise. Identity preflight precedes supervision.

Unexpected output/stderr, wrong oracle, incomplete capture, clock/deadline
failure, changed bytes or unconfirmed cleanup retains available raw/error
evidence and fails. Startup failures are not zero-valued successful samples.
The primary error is preserved alongside cleanup diagnostics. No broad PID kill,
cleanup-success fabrication, automatic retry or detached effect replay is used.
Trusted snapshots/candidate code remain required; capabilities are not OS sandboxing.

## Memory and evidence

Windows `GetProcessMemoryInfo` uses an owned live Popen HANDLE at READY and DONE.
Peak working set includes startup/preparation up to that observation. Current
working set and current private commit are distinct; private commit is not peak
heap/private memory. Stock SDK native child peak/PID handles are unavailable;
those metrics stay null with reasons. SDK parent group observations are separate.
Unsupported providers/unknown clock resolution are null/reason fields, never
guessed zeros. No memory hard-limit claim is made.

`tools/export_measurement.py` defaults to read-only verification of an explicitly
pinned completed report/snapshot and independent review record. It checks all
204 oracles/artifacts/schedule/raw clocks and recomputes summaries. Node output
is a packet: identity/clocks are checked first, then its `result`. A simulation,
incomplete/tampered report or missing sample cannot be exported as a result.

An explicit `--export NEW_FILE` produces derived bytes with their own schema
and source-report/manifest/review digests. It conserves all measured rows,
warmups, timing samples, negative pairs, capture hashes and outcome scopes.
Machine-local paths/usernames and ephemeral PIDs are omitted; unavailable free
diagnostic text is replaced by a fixed category. The original remains immutable.
Raw bodies are verified but are not embedded or automatically published. The
old private B5 snapshot has an original external compiler path, so checking that
legacy record needs that compiler identity file; new snapshots carry portable
identity bytes. Publication still needs its own privacy/attribution review.

Functional CI should use bounded fake/oracle/check-only and small ordinary
Python lifecycle controls. It must not run204 measurements or compare speed
thresholds automatically. The historical one-run observation and each later
tool/profile change have separate evidence. The sustained eight-hour gate is
unchanged.
