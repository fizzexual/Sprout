# Sprout memory model & garbage-collector design

**Status: IMPLEMENTED in v0.1.0; extended to strings in v0.1.3** (this document is the
design it was built from). Lists, maps, environments, lambda closures, **and heap strings**
are now collected by a conservative mark-sweep GC. Strings were the planned next slice: every
`Value`'s text is a GC-owned copy (`vstr` copies into a `GC_STR`), so strings are marked and
swept alongside the values that hold them — while the strings that map keys, environment
names, and the module tables own stay plain `malloc` (they live where the conservative scan
never reaches, so the GC must not touch them). The guiding principle held: **for a beginner language, a crash is
far worse than a leak — the collector never frees a live object, even at the cost of
over-retaining.** It is validated in CI by AddressSanitizer running the whole suite
*twice* — once normally and once in **stress mode** (collect on every statement, so any
missing root frees a live object and ASan catches the use-after-free).

The motivation: before this, the interpreter freed nothing, which is fine for short
scripts (the OS reclaims on exit) but a blocker for **long-running programs** — a REPL
session, a big loop, the future web `kind`/server with its per-request churn.

## The heap (what the GC manages)

Five heap object types form a reference graph:

| Object | Struct | Points to |
| --- | --- | --- |
| `SList` | `{ Value *items; int n, cap; }` | each `Value` → list/map/task/string |
| `SMap` | `{ char **keys; Value *vals; int n, cap; }` | `keys` → strings, `vals` → Values |
| `Env` | `{ Var *vars; int n, cap; Env *parent; }` | each `Var` = (name string, Value), plus `parent` |
| `TaskDef` (lambda) | `… Env *home; Env *file_env;` | `home`/`file_env` → Env (the closure) |
| heap strings | `char *` (from `dup_str`/`stringify`) | — |

The internal arrays (`items`, `keys`/`vals`, `vars`) are **owned** by their object and
freed with it — they are not separately collected.

**Must NOT be touched** (allocated once, live for the whole program): the AST
(`Expr`/`Stmt`), token text, the global `tasks[]` array of *named* tasks, and interned
keyword strings. String `Value`s that point into the AST (string literals) are likewise
never freed — only *heap* strings are. The registry (below) is what tells them apart.

**Cycles are possible** — a closure can capture an environment that transitively holds
the closure (`TaskDef.home` → `Env` → `Var` → `Value(V_TASK)` → same `TaskDef`). This
rules out plain reference counting (it would leak every such cycle) and points squarely
at **tracing (mark-sweep)**, which collects cycles naturally.

## Roots

- **Precise global roots** (enumerated directly): `global_env`, `cur_file_env`,
  `g_mods[].env`, every `tasks[].home` / `tasks[].file_env`, and `g_fail_override`
  (the active `fail` map).
- **Transient roots — the hard part.** During `eval`, live `Value`s sit in C locals
  (`apply_arith`'s `l`/`r`; builtin `a[16]`; the `for each`/comprehension iterable `it`;
  `match`'s `subj`; `reduce`'s `acc`; index `c`/`ix`; half-built list/map elements). A
  collection that runs mid-eval could free an object reachable only through one of these.

## Approach: conservative mark-sweep

Two ways to capture the transient roots were evaluated:

1. **Precise + shadow stack** — push/pop every eval temporary onto a side stack.
   *Rejected as the primary design:* it must instrument every temporary (miss one →
   use-after-free), and Sprout's `setjmp`/`longjmp` error handling can skip the matching
   `pop`s on unwind, corrupting the stack. Too fragile for a correctness-first collector.

2. **Conservative stack scan** — at GC time, treat any aligned word on the C stack (and
   in registers) that equals a registered object pointer as a root. **Chosen.** It needs
   *zero* eval instrumentation, is immune to the `longjmp` problem, and **cannot free a
   live object**. The costs — slight over-retention from false-positive pointers, and
   platform-specific stack bounds — are acceptable for this language.

### Mechanism

- **Allocation registry + header.** Every collectible allocation goes through
  `gc_alloc(type, size)`, which prepends a small `{ type_tag; mark; }` header and records
  the object in a registry. `list_new`/`map_new`/`env_new`/the lambda `TaskDef` malloc/
  `dup_str` route through it.
- **Roots.** Flush callee-saved registers to a `jmp_buf` via `setjmp` (the Boehm
  technique), then scan from a stack base captured at interpreter entry to the current
  stack pointer; mark any word matching a registered pointer. Then mark the precise
  global roots above.
- **Mark.** Recurse `Env → vars → Value`, `SList → items`, `SMap → vals` (+ key strings),
  `TaskDef → home/file_env`. The mark bit makes it terminate on cycles.
- **Sweep.** Free every registered object whose mark is clear; clear marks for the rest.
- **Trigger.** Only at **safe points** (between top-level statements, and between
  statements inside any block — so long loops get collected), and only once
  bytes-allocated-since-last-GC crosses a threshold. Conservative scanning makes these
  safe points sound automatically, because the enclosing frames' live `Value`s are on the
  stack.

## Why this is safe, and how we'll prove it

- **Never frees a live object:** a live `Value` is either in a registered container (Env/
  list/map) reachable from a global root, or in a C local whose pointer the conservative
  scan sees. Both are marked.
- **Cycles collected:** the mark bit stops re-traversal; an unreachable cycle is simply
  never marked, so it's swept.
- **Register-resident pointers** (the classic conservative-GC trap): handled by the
  `setjmp` register flush before scanning.

**Safety net (shipped now, ahead of the implementation):** an **AddressSanitizer CI job**
(`.github/workflows/ci.yml`) builds with `-fsanitize=address` and runs the whole suite +
examples on every push. With leak detection off (leaks are by-design until the GC lands),
it catches exactly the bugs a GC could introduce — use-after-free, buffer overflow, bad
free. The GC will be developed against it, plus a **stress mode** (collect on *every*
allocation, to flush out any missed root fast) and explicit **cycle tests**
(`make m = {}; set m["self"] = m` and a self-capturing closure).

## Rollout (incremental, each step independently shippable)

1. ✅ **ASan in CI** — the safety net, and a check that today's code is already clean.
2. **Registry only** — route allocations through `gc_alloc`; track, don't collect yet.
   (No behavior change; validates the header/registry plumbing under ASan.)
3. **Mark-sweep at the top-level safe point** with the conservative scan; default trigger
   high. Validate under ASan + stress mode + cycle tests.
4. **Collect inside loops** (block-statement safe points); tune the threshold against
   `benchmarks/`.
5. Ship once ASan is green across many real programs and the stress mode finds nothing.

Until step 3 lands, leaking remains the honest, correct behavior — and the benchmark
table will show the GC's real cost when it arrives.
