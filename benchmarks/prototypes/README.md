# Numeric bytecode experiment

This prototype is deliberately outside the shipped runtime. The complete AST
interpreter remains Sprout's execution engine.

The experiment compiles pure numeric expressions (constants, numeric variables,
unary minus, and arithmetic) to at most 256 instructions. It rejects unsupported
expressions and falls back to the AST without changing their behavior. Variable
types are checked before execution, so text, exact integers/decimals, objects,
and operator overloads continue through the AST. Runtime step ticks retain their
original order. Compilation depth is capped at 32.

Build a temporary variant without editing `src/sprout.c`:

```text
python benchmarks/prototypes/build.py --cc gcc --output /tmp/sprout-vm
python benchmarks/prototypes/numeric_vm_test.py /tmp/sprout-vm
python benchmarks/profile.py /tmp/sprout-vm --compare-vm --output /tmp/performance.json
```

On Windows, pass the full MinGW GCC path and an output ending in `.exe`.
`SPROUT_NUMERIC_VM=1` selects the prototype; `SPROUT_NUMERIC_VM_STATS=1` reports
compiled expressions, bytecode executions and AST fallbacks at process exit.

The recorded Windows `-O2` comparison in `../baseline-2026-10-10.json` failed the
measurement gate: arithmetic was about 9% slower, and collection timing also
regressed. These short workloads include process startup and are subject to
machine noise. The result establishes no general performance advantage and the
prototype must not become the default on this evidence. Six parity tests passed,
including failures, dynamic type changes, exact values, object overloads and
execution-step budgets. Grammar/property fuzzing found no failure in 408 seeded
cases in each mode; that is bounded evidence, not a memory-safety proof.

A useful next experiment should change a measured operation cost, such as
variable slots or task frame allocation, rather than only changing dispatch.
Repeat measurements and full semantic/sanitizer validation on each target before
considering a production optimization.
