# Runtime environment reachability

The scoped environment-root candidate keeps active interpreter scopes reachable
through collection, including a caller suspended while a later argument runs,
partially prepared task parameters, task defaults, methods and imported modules.
It does this independently of whether an optimizing compiler leaves an exact
environment allocation address visible to the conservative C-stack scan.

The collector marks registered environments and their parents and values. The
scope registry uses heap storage because runtime errors can jump over C frames.
Normal statement/task/module completion restores the entry depth; each error,
test, REPL and top-level recovery boundary restores its saved depth. Discarded
slots are cleared so completed scopes do not remain registered accidentally.
Growing the registry must succeed before execution proceeds. An allocation
failure follows the existing error path through an initialized recovery boundary.

This change leaves the language's values and host ABI unchanged. Collection
still happens at statement safe points; `SPROUT_GC_STRESS=1` selects the existing
collect-on-every-statement mode. Conservative scanning remains part of the
collector, and the scope registry is not a general memory quota or ownership
system for every native allocation.

The dedicated include harness checks required scope admission, actual pre-sweep
environment marks, discarded-slot clearing and depth recovery. Bounded fixtures
cover nested arguments/defaults, captured and value-based calls, imports,
ordinary control flow, caught/rethrown/hard errors, failed tests, REPL and bundled
programs. Its observer and allocation-failure controls exist only in the test
build; there is no new runtime option or language builtin for them.

The test supervisor captures at most64KiB per stream and treats exceeded caps,
I/O failures and sanitizer output as failures. Its existing15-second supervised
I/O deadline also covers an owned stdin writer. Process creation is an OS
boundary that this helper cannot preempt. Direct-child wait and each I/O-thread
join have separate bounded cleanup budgets; uncertain cleanup is reported
without credit for a clean exit or descendant termination.

The original `3e0238e` macOS GC-stress API failure remains recorded. Windows and
optimized offline Linux investigations did not reproduce its compiler-specific
cause. This reachability contract is a separately attributed hardening change;
passing local checks or a later CI run does not establish that original cause.
Source hashes, build profiles, peer review and exact CI status are recorded in
the [work queue](../SPROUT_WORK_PLAN.md) and [readiness gates](production-readiness.md).

`241f68f` subsequently passed all eight jobs on the first attempt in
[CI 38297387716](https://github.com/fizzexual/Sprout/actions/runs/38297387716),
including actual WebAssembly and both sanitizers. Its separate normal
full-SQLite Windows build passed all 16 dedicated controls before installation.
Earlier failed local sanitizer and compiler profiles remain separately recorded.
Temporary native argument buffers are a distinct ownership issue under N011;
this environment registry does not claim to fix those allocations.
