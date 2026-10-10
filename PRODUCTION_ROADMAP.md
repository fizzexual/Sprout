# Sprout production roadmap

The target is a readable general-purpose language with dependable automation,
services, embedded application rules, and useful app tooling. Production claims
are workload-specific and must be backed by reproducible evidence.

## Milestones

| Milestone | Deliverable | Acceptance evidence |
| --- | --- | --- |
| Runtime foundations | Explicit exact integers/decimals, binary data, execution budgets, stable errors and data boundaries | Boundary/overflow tests, fuzzing, sanitizer and GC stress |
| Practical libraries | HTTP, processes, files, CSV, parameterized SQLite transactions | Local HTTP fixtures, timeout/cleanup tests, interrupted writes, rollback tests |
| Distribution | Multi-file bundles, assets, pinned packages and verified lockfiles | Relocated bundle runs, deterministic payloads, corrupt/traversal rejection |
| Editor | Scope-aware navigation/completion, signatures, conservative diagnostics, safe rename and formatting | Shadowing, imports, unsaved buffers, cancellation and edit tests |
| Learning/debugging | Structured trace, step inspection, variables, stack, breakpoints | Trace/runtime parity, bounded output, worker recovery, browser verification |
| Workflows/concurrency | Bounded parallel work, explicit retries, checkpoints/resume, cancellation | Crash/restart and duplicate-side-effect tests, failure/cancellation cleanup |
| Embedding | Isolated execution protocol and host SDKs, then native host ABI | Protocol/version tests, host timeouts, repeated execution and isolation |
| Minecraft | Paper adapter for commands/events and validated reloads | Adapter build, scheduler correctness, old-program fallback and actual server smoke |
| App toolkit | Small UI/web application library with clear host integrations | Finished example apps and responsive browser verification |
| Ergonomics | Named arguments and multiline strings with formatter/editor support | Grammar, evaluation order, default/duplicate arguments and formatting tests |
| Performance | Benchmarks, profiler, measured bytecode optimization | Published baseline/comparison, semantic parity, representative workloads |

## Adoption order

1. Packaged CLI tools and automation.
2. Bounded embedded rules, including Minecraft behavior behind a Java host.
3. Background workers and durable workflows.
4. API services with database, operational and deployment evidence.
5. Broader desktop/web/mobile host integrations.

React/Svelte, Android platform APIs, SQL databases and native engines remain useful
host technologies. Sprout replaces selected implementation layers through tested
interfaces; language syntax alone does not replace their ecosystems.

## Compatibility and release gates

- Preserve existing floating-point numbers; exact numeric types are explicit.
- Keep existing scripts, modules, tests and CLI contracts working or document migrations.
- Pin external source dependencies, ship license notices and reproducible build instructions.
- Test Windows, Linux, macOS and WebAssembly independently.
- Bound untrusted execution in a host process; library permission switches are not an OS sandbox.
- Do not label an unfinished milestone as delivered or equate green smoke tests with production readiness.
- Promote a release only after its claimed workloads pass failure/recovery, long-running and security checks.

## Current implementation record

The revival branch already repairs runtime/import/JSON regressions, editor process
handling, playground execution limits, installation and branch deployment checks.
The milestones above are being implemented on that branch with separate agent
ownership and integration testing. Detailed feature docs and tests record the
actual supported contracts as each milestone lands.

Implemented foundations include exact/binary data, bounded runtime traces,
native I/O and SQLite, deterministic project bundles, verified package locks,
semantic editor tooling, recorded debugging, named arguments/multiline text,
bounded native parallelism, checkpointed workflows, an offline app toolkit,
and isolated host/service protocols. The numeric bytecode experiment is
reproducible but failed its speed gate; it remains experimental. Native host
adapters and cross-platform integration evidence are being verified before the
next review checkpoint. [Stack adoption](docs/stack-adoption.md) maps these
interfaces to the existing GitHub projects.

Production promotion still requires representative migrations, real Paper
server evidence, extended crash/soak workloads, independent security review,
published compatibility policy and workload-specific performance budgets.
Completing features and passing CI does not close these operational gates.
