# Temporary argument storage and error recovery

An argument or default can fail while a task or named constructor is preparing
its inputs. Sprout uses temporary pointer arrays during that preparation.
The N011 change gives those arrays an explicit owner so error recovery can
free them even when the error jumps over the ordinary C return path.

Only argument positions and named-constructor field-name/default-expression
arrays are owned here. Their borrowed strings, expressions and values are not
freed by this mechanism. Successful task preparation releases its arrays before
the body runs; a successful constructor releases them after its fields finish.
Normal completion and recovery restore the saved preparation depth. Releasing
an individual array leaves an empty slot until restoration, preserving the
checkpoints of suspended callers.

Growing the owner registry must succeed before an array is allocated. Recovery
frees admitted arrays and clears used slots without allocating storage or
calling user code. Argument validation, source-order evaluation, typed inputs,
primary error messages and language/host value formats remain unchanged.
Cleanup does not roll back earlier language effects or external operations.

Independent fixtures reproduced the original leaks and reviewed the correction.
The correctly generated Windows local cohort passed 11 controls, including
UTF-8 byte reconstruction, counted success/error paths, allocation refusal,
suspended inputs, modules, REPL and failed-test recovery. Its separate six-case
shared corpus checks output/error semantics on normal native and WebAssembly;
WebAssembly supplies no allocation counters. Earlier diagnostic-transcoded
observer profiles and failed fixture/checker observations remain preserved.

This is ownership evidence for these arrays, not a whole-heap leak result,
memory quota, collector proof, effect rollback or production certification.
`6b8c724` subsequently passed all eight jobs on the first attempt in
[CI 38303471847](https://github.com/fizzexual/Sprout/actions/runs/38303471847).
The separate normal full-SQLite Windows build compared all 19 inputs with exact
Git bytes and passed verification alongside separately compiled minimal invariant
harnesses. Installed native recovery/GC and Python/Node smoke checks passed;
the prior executable is preserved. This development build and these fixtures
do not qualify sustained deployment. Current status is in
[the work queue](../SPROUT_WORK_PLAN.md).
