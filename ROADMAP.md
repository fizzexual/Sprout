# 🌱 Sprout — the road to the v0.1.0 freeze

**v0.0.13 was "spec-complete" — every edge case decided.** It was originally called
"the freeze," but it held exactly one version, so the honest name is a *release
candidate*, not a freeze. This is the plan for the **base-completion cycle**: grow the
base language in dependency order, then **freeze for real at v0.1.0** — the one that's
meant to hold, where the core stops moving and libraries can build on it. Deliberately
ambitious — pick what fits the mission, in this order.

> **Working model:** `spec-complete (v0.0.13) → base-completion batches (each its own
> version, reviewed + CI-green) → the v0.1.0 freeze (holds)`.
> A "freeze" only has value if it holds, so the word is reserved for v0.1.0; until then
> the core is in active development. The README's "Not in the core today" list shrinks
> as items here land — and two of its entries (first-class tasks, user types) are
> openly *under evaluation* here, not permanently excluded.

---

## ⛔ Open decisions that GATE the v0.1.0 freeze (these are the owner's calls)

A gap audit (v0.0.17) confirmed the *engineering* freeze-prep is done (contracts pinned — see
below). What remains before v0.1.0 is **strategic**, and these can't stay "under evaluation"
through a freeze, because they define what the freeze even promises. My recommendation is noted,
but the call is the language owner's:

1. **The mission fork — teaching language, or small multipurpose runtime?** Everything below
   hangs off this. *Recommendation: declare v0.1.0 the freeze of the **teaching/CLI core**, and
   make GC + the web server + first-class tasks an explicit **post-v0.1.0 "runtime" track** with
   its own (re-)freeze — so "freeze" stays meaningful for the part that's actually done.*

2. **Are tasks first-class (values)?** Today `make f = greet` errors. `map`/`filter`/`reduce`
   (Phase 3) and server handlers (Phase 9) both need passing a task as a value, and adding it
   *after* the freeze changes the type model. *Decision needed: in v0.1.0, or "never" — not
   "under evaluation." Recommendation: not in the teaching-core freeze; it opens the runtime track.*

3. **Memory model vs long-running programs.** Leak-until-exit is fine for scripts/CLIs and
   **disqualifying for a server** (leaks per request). You cannot honestly freeze "a core to build
   servers on" without GC. *Recommendation: the v0.1.0 teaching-core freeze does NOT promise
   long-running use; GC is a prerequisite of the runtime track, not the freeze.*

4. **Multiple return values** (Phase 2, "decide & document") — still undecided; pin it (a list/map,
   or real multi-return) before freezing the calling convention.

Until #1–#3 are decided, "v0.1.0 = freeze" is ambiguous. Everything in the phases below is either
already shipped, additive (safe after the freeze), or part of the runtime track.

---

## Is the base complete? — a pre-unfreeze audit

Verified by running real programs on v0.0.13 (a word-tally with maps + recursion + f-strings
runs fine — the core is genuinely usable and Turing-complete). But "usable" isn't "complete."
Scorecard:

**✅ Have (a real base):** numbers · text (indexable, f-strings, escapes) · yes/no · nothing ·
lists · maps · `make`/`set`/`show`/`ask` · `+ - * / %` · comparisons + `and`/`or`/`not` ·
`when`/`orwhen`/`otherwise` · `repeat times`/`while` · `for each` · `task`/`give` + recursion ·
modules + `public`/`private` · files (read/write/append/exists) · `get`/`json` · `system.run` ·
`test`/`expect` · friendly errors · `learn` mode.

**⚠️ Table-stakes GAPS — I would NOT re-freeze the base without these.** Each is something where
today you hit a wall or an ugly workaround:

1. **Error recovery (`try`/`caught`, `fail`).** *Any* error kills the whole run. You can
   dodge some (number→nothing, exists), but you can't recover from a failed file/web/json/
   out-of-range. A base language needs at least one recovery path. (Confirmed: `try` doesn't parse.)
2. **List mutation — `remove`, `insert`.** Lists are **append-only**: there is no way to delete
   or insert an element (you must rebuild the whole list with a `for each`). No stack-pop, no
   queue, no "delete the matching item." (Confirmed: no `remove`; `set xs[i] = nothing` keeps length 3.)
3. **Loop control — `stop` (break) / `skip` (continue).** Search-and-stop / skip-bad-item need a
   flag-and-`repeat while` dance today. (Confirmed: `stop` is unknown.)
4. **`sort`** (and `reverse`, `index_of`). Extremely common; hand-rolling a sort is a lot for a
   beginner. (Confirmed: no `sort`.)

**🟨 Strongly expected (workable without, but a base usually has them):** text `starts_with`/
`ends_with`/`index_of`/`pad`; math `pow`/`log`/`pi`; `const` (immutable bindings); counted
`for i from a to b`.

**⬜ Genuinely deferrable power (the base feels complete without these):** first-class
functions/closures · `map`/`filter`/`reduce` · user types/records · pattern `match` · integers/
decimals · concurrency · the server `kind` · GC · persistence (`remember`) · package manager.

### → The "base-completion" milestone ✅ SHIPPED in v0.0.14–v0.0.15

Pulled out of the phases below into one tight bundle, because *these* are what make the base
**complete**, not just bigger. **All landed** (tested + CI-green on Linux/macOS/Windows):

- [x] `try`/`caught` + `fail`  (from Phase 1) — **reshaped in v0.0.15 after a spec review** (see below)
- [x] `remove`, `insert` for lists  (from Phase 3) — `remove(xs, i)` returns the removed item; `insert(xs, i, v)`
- [x] **`remove(map, key)` (delete a map key) + `values(map)`** — `remove` dispatches on list-vs-map  (from Phase 3)
- [x] `stop` / `skip` in loops  (from Phase 5) — parse-time error if used outside a loop; affects the innermost loop
- [x] `sort`, `reverse`, `index_of`  (from Phase 3) — `sort` is homogeneous num-or-text; `index_of` works on lists and text
- [x] **compound assignment `set x += 1`** (and `-= *= /= %=`, incl. `set xs[i] += 1` / `set m[k] += 1`)  (from Phase 5.5)
- [x] small builtin top-up: text `starts_with`/`ends_with`/`index_of`, math `pow`  (from Phase 6)

**Error-handling spec, as shipped (v0.0.15 — the load-bearing decisions a founder review flagged):**
- **Keyword:** the catch block is **`caught`** (not `otherwise`, which stays the `when`/else word) — one word, one meaning.
- **A caught error is a map** `{message, kind, line}`; the bound name is **user-chosen + optional** (`caught problem:` / `caught:`). Built-in `kind`s: `math`/`index`/`io`/`name`/`fail`/`error`. *This is the decision libraries + the web `kind` depend on — an error that was only text would have to be string-matched.*
- **`fail`** carries a map whole (`fail {kind:"http", status:404, message:"..."}`, standard keys auto-filled) or wraps text/scalars as `{message, kind:"fail", line}`.
- **Two tiers:** `try` catches runtime *conditions* (bad input, divide-by-zero, IO, `fail`); it does **not** catch *code mistakes* — name/task/module typos and lex/parse errors are "hard" and skip every `try` (so the "did you mean?" help is never swallowed), though the test/REPL/run boundaries still catch them.
- `give`/`stop`/`skip` pass cleanly **through** a `try`; the `caught` block does not run for them.

**Answer to "do we have everything a base language needs?":** *Yes, as of v0.0.15.* The
table-stakes items above are done, so the power phases below are now true extensions you can
take or leave, and the base that freezes at v0.1.0 will be genuinely complete.

**Freeze-prep, pinned in v0.0.17 (the contracts a freeze must guarantee — done):**
- [x] **Lists/maps are shared references** — `make b = a` aliases; documented + tested; added **`copy(x)`** (deep snapshot) since reference semantics need an escape hatch.
- [x] **Mutate-vs-return convention** — `add`/`insert` → nothing, `remove` → the removed item, `sort`/`reverse` → the same (mutated) list; documented + tested.
- [x] **Stable error-`kind` table** — `math`/`index`/`io`/`fail`/`name`/`error` documented in the README as frozen-at-v0.1.0 (add-only); `sqrt`-of-negative re-tagged `math` for consistency.
- [x] **Number-edge rules stated** — modulo takes the dividend's sign; `nan`/`inf` unreachable (guarded); `random` not seedable + scientific-notation literals unparsed (both flagged as roadmap, not silent).
- [x] **CI gates the test framework** — `run.sh` now runs `*_test.sprout` via `sprout test` (exit-code), closing the hole where a failing `expect` (prints `x`, not `FAIL`) slipped past the grep.

> Note (v0.0.14 build): fixed a Windows-only crash where a top-level `try:` that caught an
> error segfaulted at `-O2` — `cmd_run` now establishes an outer error boundary (like
> `sprout test`/`build` already had), giving the nested `longjmp` a valid SEH frame to unwind to.
>
> Note (v0.0.15 adversarial review): a parse error in a module loaded by `use` *inside* a
> `try` was wrongly catchable — fixed by suppressing the catch across the whole lex+parse in
> `parse_file` (save/restore `g_quiet_fail`), so code mistakes stay uncatchable. Also hardened
> the post-`longjmp` save locals (`volatile`) on cold error paths and tightened state resets.

---

## Full feature & syntax sweep (everything, checked)

Every language dimension, each row probed against v0.0.13. Legend: **✅ in core** ·
**📋 already planned (phase)** · **➕ NEW — was missing, added to the plan now** ·
**🚫 non-goal (deliberately out)**.

### Lexical surface (comments, literals)

| Feature | Status |
| --- | --- |
| `~` line comment · indentation blocks · `"..."` + escapes | ✅ |
| f-strings `f"{x}"` · UTF-8 text · text indexing | ✅ |
| **Block / multi-line comment** (`~~ … ~~`) | ➕ Phase 5.5 |
| Multi-line strings (`"""…"""`) | 📋 Phase 6 |
| **Number underscores** `1_000_000` | ➕ Phase 5.5 |
| **Hex / binary literals** `0xFF` `0b101` | ➕ Phase 5.5 (decide) |
| **Scientific notation input** `1e3` | ➕ Phase 5.5 |
| Raw strings | 🚫 (escapes cover it) |

### Operators & expressions

| Feature | Status |
| --- | --- |
| `+ - * / %`, comparisons, `and`/`or`/`not`, `( )`, unary `-`/`not` | ✅ |
| `//` floor-div, `mod` | 📋 Phase 4 |
| **Compound assignment** `+= -= *= /= %=` (incl. `xs[i] += 1`) | ✅ v0.0.14 |
| **`in` operator** `x in xs` (sugar for `contains`) | ➕ Phase 5.5 |
| **Inline-if / ternary expression** (`give a when c otherwise b` as a *value*) | ➕ Phase 5.5 (decide) |
| **Pipe** `xs \|> map(...) \|> sort()` | ➕ Phase 5.5 (power; decide) |
| Spread `[...a, ...b]` · slicing `xs[1..3]` · ranges `1..10` | 📋 Phase 3 |
| `or else` (fallback) | 📋 Phase 1 |
| Bitwise `& \| ^ << >>` | 🚫 (not a teaching need) |
| Operator overloading | 🚫 |

### Control flow

| Feature | Status |
| --- | --- |
| `when`/`orwhen`/`otherwise` · `repeat times`/`while` · `for each` · `give` · recursion | ✅ |
| **`stop`/`skip` (break/continue)** | ✅ v0.0.14 |
| `repeat until` · `for i from a to b` · `match` | 📋 Phase 5 |
| **`try`/`caught` · `fail`** (error = map `{message,kind,line}`; hard/soft tiers) | ✅ v0.0.14, reshaped v0.0.15 |
| **`finally` / `always` (cleanup block)** | ➕ Phase 1 |
| **`assert <cond>`** (outside tests) | ➕ Phase 1 |
| Labeled break / `break N` · `goto` | 🚫 |

### Functions

| Feature | Status |
| --- | --- |
| `task`/`give`, recursion, top-level | ✅ |
| first-class tasks · closures · lambdas (`do (x): …`) · default/named/variadic args | 📋 Phase 2 |
| higher-order builtins (`map`/`filter`/`reduce`/…) | 📋 Phase 3 |
| **Multiple return values** (or "return a list/map" — decide & document) | ➕ Phase 2 |
| **Iterator protocol** (so `for each` walks a user-defined type) | ➕ Phase 2/4 |
| currying / partial application · decorators | 🚫 |

### Data types & values

| Feature | Status |
| --- | --- |
| number (double) · text · yes/no · nothing · list · map | ✅ |
| records · `const` · type-check (`is a number`) · enums/variants · sets · integers/decimals | 📋 Phase 4 |
| tuples | 🚫 (use a list) |
| classes / methods / inheritance / interfaces / generics · static typing | 🚫 (records are data-only; dynamic) |

### Collection & string operations

| Feature | Status |
| --- | --- |
| list: `add` · index · `set xs[i]` · `length`/`first`/`last`/`contains`/`range`/`keys` · **`remove`/`insert`/`sort`/`reverse`/`index_of`** | ✅ (last five v0.0.14) |
| list: `unique`/`zip`/`flatten`/comprehensions | 📋 Phase 3 |
| map: get/`set`/`keys`/`contains` · **`remove(key)` (delete) + `values(map)`** | ✅ (last two v0.0.14) |
| `for each key, value in map` | 📋 Phase 3 |
| text: `split`/`join`/`replace`/`upper`/`lower`/`trim` · **`starts_with`/`ends_with`/`index_of`** | ✅ (last three v0.0.14) |
| text: `pad`/`format`/`words`/`lines`/`title` | 📋 Phase 6 |

### Modules & namespaces

| Feature | Status |
| --- | --- |
| `sprout.toml` · `use` · `public`/`private` · namespaced (`server.start()`) | ✅ |
| **`use x as y` (alias) + selective import (`use greet from greeter`)** | ➕ Phase 11 |
| **Stdlib namespacing decision** (`math.`/`text.`/`time.`/`web.` vs. flat builtins) | ➕ Phase 11 |

### I/O, system & runtime

| Feature | Status |
| --- | --- |
| `show`/`ask` · files read/write/append/exists · `get`/`json` · `system.run` · `wait` · `random` | ✅ |
| folder ops · `args` · `env(name)` · stdin lines · HTTP client (POST/headers) · date/time | 📋 Phase 7 |
| **`exit(code)`** | ➕ Phase 7 |
| `remember`/`recall` (persistence) | 📋 Phase 7 |
| GC / arena · tail-call optimization · bytecode VM | 📋 Phase 8 |
| `kind` system / HTTP server / handler 500-boundary | 📋 Phase 9 |
| structured concurrency · timers | 📋 Phase 10 |

### Metaprogramming & tooling

| Feature | Status |
| --- | --- |
| REPL · `test`/`expect`/`sprout test` · `learn` mode · friendly errors · CI | ✅ |
| `sprout docs` · `sprout format` · step debugger · LSP · package manager · C extension API | 📋 Phase 11 |
| reflection (`kind of x`) | 📋 Phase 4 |
| macros · `eval` / runtime code-gen | 🚫 (keeps it predictable for beginners) |

## Markers

- 🟢 **Mission-aligned** — makes *learning to program* better. Safe to add freely.
- 🟡 **Power** — genuinely useful, but must NOT complicate a beginner's first 10 minutes (keep it out of the hello-world path).
- 🔴 **Big rock** — foundational, multi-week, unblocks other things. Plan deliberately.
- ⛓️ depends on a thing earlier in the list.

---

## Phase 0 — Unfreeze ritual

- [ ] Branch from the `v0.0.13` tag; note "core UNFROZEN" at the top of the Language Reference.
- [ ] Move every shipped item below out of the README's "Not in v1" list as it lands.
- [ ] Keep the freeze tests (`tests/freeze_test.sprout`) green the whole way — they guard the rules that *aren't* changing.

---

## Phase 1 — Error handling (the missing pillar) 🟢🔴 — core SHIPPED v0.0.14–v0.0.15

Today's first error stops the run; this was the biggest robustness gap, and it unblocks
files, the web, and the server kind. It's literally where this project started (`try`).

- [x] **`try: … caught: …`** — run a block; if it errors (a runtime *condition*), run the recovery block.
  ```sprout
  try:
      make data = json(get(url))
      show data["name"]
  caught problem:
      show "couldn't load it:", problem["message"]   ~ the error is a map {message, kind, line}
  ```
- [x] **`fail "message"`** (and `fail {kind:"http", status:404, ...}` to carry structure) — raise your own error.
- [x] **The caught-error shape — DECIDED:** a **map** `{message, kind, line}`, bound to a user-chosen optional name. (The Phase-1 open question below is now answered: recovery branch **+** a readable error map, with categorised `kind`s.)
- [x] **Two tiers — DECIDED:** `try` catches runtime conditions; name/task/module typos and lex/parse errors are "hard" and uncatchable (so diagnostics aren't swallowed). Verified by adversarial review.
- [ ] **`default` / `or else`** — a fallback for an error/`nothing`: `make port = number(env("PORT")) or else 8080`.
- [ ] **`expect error in: …`** — so tests can assert a failure (closes the gap where errors can't be asserted today).
- [ ] **`finally:` / `always:`** — a cleanup block that runs whether or not the `try` failed.
- [ ] **`assert <cond>`** — a guard outside tests: stop with a clear message if something that must be true isn't.

## Phase 2 — Functions grow up 🟡 ⛓️(unblocks Phases 3, 9, 11)

Reverses the "no first-class functions" freeze decision — on purpose. This is the single
biggest ergonomics unlock (map/filter, callbacks, cleaner libraries).

- [ ] **First-class tasks** — store, pass, and return tasks as values (`make f = greet` becomes legal).
- [ ] **Anonymous tasks / lambdas** — `make double = do (x): give x * 2`.
- [ ] **Closures** — a nested/anonymous task captures the surrounding scope.
- [ ] **Default parameters** — `task greet(who, mark = "!")`.
- [ ] **Named arguments** — `area(width: 3, height: 4)`.
- [ ] **Variadic tasks** — `task add(...numbers)`.
- [ ] **Multiple return values** — decide: `give a, b` (and `make x, y = …`), or keep "return a list/map" and just document it.
- [ ] **Iterator protocol** — let `for each` walk a user-defined type (needs records, Phase 4).
- [ ] Re-decide: are nested `task` definitions allowed now? (Closures imply yes — relax the "top-level only" rule.)

## Phase 3 — Collections & iteration superpowers 🟢 ⛓️(needs Phase 2 for the task-taking ones)

- [ ] Higher-order builtins: **`map` `filter` `reduce` `sort` `find` `count` `any` `all` `sum` `min_by`/`max_by`**.
- [ ] **`for each key, value in map`** (today you only get keys).
- [ ] **Slicing** — `xs[1..3]`, `text[0..2]`; and **ranges as values** — `make r = 1..10`.
- [ ] More list ops: **`reverse` `unique` `zip` `flatten` `insert` `remove` `index_of` `join`(have)**.
- [ ] **Map ops:** **`remove(map, key)` (delete a key — currently impossible)**, **`values(map)`**, `merge`.
- [ ] **Spread** — `[...a, ...b]` and `{...base, key: value}`.
- [ ] Maybe: **comprehensions** — `[x * 2 for each x in xs when x > 0]` (decide vs. `map`/`filter`).

## Phase 4 — Types & data 🟡

No user-defined types today (maps are the record). Add structure without losing simplicity.

- [ ] **Records** — `record Point(x, y)` → a constructor, field access (`p.x`), and a clean display.
- [ ] **`const`** — an immutable binding (`const PI = 3.14159`).
- [ ] **Type checks** — `x is a number`, `kind of x` → `"number"`/`"text"`/`"list"`/…
- [ ] **Enums / variants** + use with `match` (Phase 5).
- [ ] **Sets** — `{1, 2, 3}` membership/union/intersection (decide syntax vs. maps).
- [ ] **Integers** — at least `//` (floor division) and `mod`; consider a real integer type, and **decimals for money**.

## Phase 5 — Control flow polish 🟢

- [ ] **`match` / pattern matching** — `match shape: when circle(r): … when square(s): …`.
- [ ] **`skip`** (continue) and **`stop`** (break) in loops.
- [ ] **`for i from 1 to 10 [by 2]`** — counted loops without `range`.
- [ ] **`repeat until …`** — the inverse of `repeat while`.

## Phase 5.5 — Syntax sugar & literals 🟢 (small, high daily-value; the bits the first draft missed)

Pure quality-of-life. None add a value kind; they just make everyday code shorter and friendlier.

- [ ] **Compound assignment** — `set x += 1` (`-= *= /=`). The #1 ergonomic gap; do it in the base-completion bundle.
- [ ] **`in` operator** — `when name in names:` (reads like English; sugar for `contains`).
- [ ] **Block comments** — `~~ … ~~` for commenting out a span (today only `~` to end-of-line).
- [ ] **Nicer number literals** — underscores `1_000_000`, scientific `1e3`, and (decide) hex `0xFF`.
- [ ] **Inline-if (ternary) as a value** — `make label = "pass" when score >= 50 otherwise "try again"` (decide vs. statement-only `when`).
- [ ] **Pipe** *(power, decide)* — `words \|> map(upper) \|> sort` reads top-to-bottom; needs Phase 2/3.

## Phase 6 — Text, numbers & time 🟢 (mostly builtins — low risk, high beginner value)

- [ ] Text: **`starts_with` `ends_with` `index_of` `pad_left`/`pad_right` `repeat` `words` `lines` `title` `format`**.
- [ ] **Multi-line strings** (un-defer) — `"""…"""` triple-quoted.
- [ ] Math: **`pow` `log` `sin`/`cos`/`tan` `pi` `e` `clamp` `sign` `round_to`**; **seeded `random`** (reproducible).
- [ ] **Real date/time values** — `now()` returns a value you can do arithmetic on; durations; parse/format.

## Phase 7 — Persistence & I/O 🟢/🟡

- [ ] **`remember` / `recall`** — key/value that persists between runs (the smallest, friendliest first step — do this early).
- [ ] Filesystem: **`list_folder` `delete` `copy` `make_folder`** (have `read`/`write`/`append`/`exists`).
- [ ] **`args`** (command-line), **`env(name)`** (environment), **stdin lines**, **`exit(code)`**.
- [ ] HTTP client grows up: **headers, `POST`, methods, status code** (today `get` is GET-only) — likely lives in a `web` module.

## Phase 8 — Runtime foundations (the big rocks) 🔴 ⛓️(unblocks Phase 9, long-running programs)

- [ ] **Memory model decision** — a real **GC** *or* a **per-request/per-scope arena**. The hard one: values pass by value on the C stack, so a precise GC needs a managed root set, and an arena must guarantee nothing escapes the scope being wiped. Enables long-running programs (servers).
- [ ] **Tail-call optimization** — so deep recursion-as-iteration doesn't hit the 6000 guard.
- [ ] *(Optional, large)* a **bytecode VM** for speed — keep the tree-walker as the reference implementation.

## Phase 9 — The `kind` system / web runtime 🔴 ⛓️(needs Phase 1 errors + Phase 8 arena)

- [ ] Per-file **`kind`** in `sprout.toml`: `script` (default) · `module` · `test` · `handler` · `server`.
- [ ] **`module`** — a "don't run me directly" guard (small; can land before the rest).
- [ ] **HTTP server** — bind/accept/route; a `request` **map** into the handler; `give` a text body or `{status, headers, body}`.
- [ ] **The one language override:** a handler error becomes a **500 response**, not a process exit (bounded error scope).
- [ ] **Capability gating per kind** — e.g. only certain kinds may `use system`.

## Phase 10 — Concurrency (carefully) 🟡🔴

Only if it stays beginner-legible. A teaching language probably wants *structured* parallelism, not raw threads.

- [ ] **`do X and Y at the same time`** — structured parallel blocks that join at the end.
- [ ] **Timers / scheduling** — `every 5 seconds: …`, `after 1 second: …`.
- [ ] Channels / actors → probably a **library**, not core.

## Phase 11 — Tooling & ecosystem 🟡 (the cycle's payoff — mostly *around* the language)

- [ ] **`sprout docs`** — generate docs from `~` comments above tasks.
- [ ] **`sprout format`** — one canonical formatter (no style debates).
- [ ] **C extension API** — so libraries can be native; this is what makes "everything new is a library" real.
- [ ] **Package manager** — `sprout install <pkg>` / `sprout publish` + a registry.
- [ ] **Step debugger** — extend `learn` mode into step/over/inspect.
- [ ] **Editor support** — a Language Server (LSP) so any editor gets errors + completion; grow the VS Code extension.
- [ ] **Module imports grow up** — `use greeter as g` (alias) and `use greet from greeter` (selective); decide a **standard-library namespacing** scheme (`math.` / `text.` / `time.` / `web.` modules vs. the current flat builtins).

## Deliberately NOT planned (non-goals)

So the roadmap is *complete* — these are decided-out, not forgotten. Each is a deliberate "no"
for a small, beginner-first language; any could be reconsidered, but none is on the path to v0.1.0:

- **Object orientation** — classes, methods, inheritance, interfaces/traits. Records are *data*, tasks are *behavior*; that split is the point.
- **A static / gradual type system** — Sprout stays dynamically typed with friendly runtime errors.
- **Generics**, operator overloading, currying/decorators — power-language complexity beyond the mission.
- **Macros / `eval` / runtime code-gen** — keeps "what runs is what you read" true for beginners.
- **Bitwise operators**, raw bytes/binary, manual memory/pointers, `goto`, labeled breaks.
- **Raw threads / async-await** — concurrency, if it comes (Phase 10), is *structured* and legible, not a thread API.
- **Tuples** (a list does the job) — one sequence type, not two.

---

## Phase 12 — Re-freeze as v0.1.0

Repeat the v0.0.13 ritual for everything added:

- [ ] Decide every new edge case (one rule each) — especially: closures + scope, first-class-task equality/display, record equality/display, `match` exhaustiveness, integer↔double coercion, multi-line string rules.
- [ ] Vocabulary audit — every new keyword (`try`/`caught`(shipped), `fail`/`stop`/`skip`(shipped), `do`, `match`, `record`, `const`, `until`, …); update the reserved list.
- [ ] Language Reference complete; `tests/freeze_test.sprout` extended to cover the new rules; CI green on Linux/macOS/Windows.
- [ ] Mark the core frozen again.

---

## Cross-cutting principles (apply to every item)

1. **The 10-minute filter.** A beginner's first program must not get harder. Power features (closures, records, concurrency) are opt-in and stay off the hello-world path.
2. **Every keyword earns its place.** Prefer a builtin (a name) over a new keyword (reserved syntax). Sprout's vocabulary is a feature — don't dilute it.
3. **Reuse what exists.** `request` is a map; a response is a map; a caught error can be a map. New capability, no new value kinds where avoidable.
4. **One batch = one version = one review.** Each phase ships on its own, with an adversarial review and green CI before merge. No big-bang.
5. **Stay zero-dependency C**, and keep the leak-until-exit model *honest in the docs* until Phase 8 lands a real memory model.
6. **Errors stay kind.** Every new feature gets the "did you mean / here's the fix" treatment.

## Dependency order at a glance

```
Phase 1 (errors) ─┬─> Phase 9 (server)
Phase 2 (functions) ─> Phase 3 (collections), Phase 11 (libraries)
Phase 8 (arena/GC)  ─> Phase 9 (server), long-running programs
```
First moves done: error handling (`try`/`caught`/`fail`, Phase 1 — the original ask) shipped in v0.0.14–v0.0.15. Next good low-risk move: **`remember`/`recall`** (Phase 7, tiny + friendly).

## The one decision to make before unfreezing

This roadmap roughly **doubles** the language. That's a real fork in Sprout's identity:

- **"Kindest language to *learn* with"** → take Phases 1, 3, 5, 6, 7 (errors, collections,
  control flow, text/math/time, persistence). They make learning richer without making the
  basics harder. Skip or defer closures/types/concurrency/server.
- **"Small multipurpose *runtime*"** → take everything, including Phases 2, 4, 8, 9, 10.
  More powerful, but it stops being a tiny teaching language.

Both are valid — but they're different languages. Decide which Sprout is *before* unfreezing,
and let that pick the phases. (My read: lead with the 🟢 items; treat 🟡/🔴 as opt-in power
that has to keep earning its place against the mission.)
