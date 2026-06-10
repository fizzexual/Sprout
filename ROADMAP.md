# 🌱 Sprout — Beyond the Freeze

The core froze at **v0.0.13**. This is the plan for the **next core cycle**: unfreeze,
grow the base language in dependency order, then **re-freeze as v0.1.0** (the "bigger
core"). It's deliberately ambitious — pick what fits the mission, in this order.

> **Working model:** `unfreeze → batches (each its own version, reviewed + CI-green) → re-freeze`.
> The "Not in v1 (deliberately)" list in the README shrinks as items here land.

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

## Phase 1 — Error handling (the missing pillar) 🟢🔴

Today the first error stops the run. This is the biggest robustness gap, and it unblocks
files, the web, and the server kind. It's also literally where this project started (`try`).

- [ ] **`try: … otherwise: …`** — run a block; if it errors, run the recovery block (with the message available).
  ```sprout
  try:
      make data = json(get(url))
      show data["name"]
  otherwise:
      show "couldn't load it - using a default"
  ```
- [ ] **`fail "message"`** — raise your own friendly error.
- [ ] **`default`** — a fallback for an error/`nothing`: `make port = number(env("PORT")) or else 8080`.
- [ ] **`expect error in: …`** — so tests can assert a failure (closes the freeze-test gap where errors can't be asserted today).
- [ ] Decide: is a caught error a value (a small `error` record with `.message`) or just a recovery branch? (Recommend: recovery branch + an `error` map you can read.)

## Phase 2 — Functions grow up 🟡 ⛓️(unblocks Phases 3, 9, 11)

Reverses the "no first-class functions" freeze decision — on purpose. This is the single
biggest ergonomics unlock (map/filter, callbacks, cleaner libraries).

- [ ] **First-class tasks** — store, pass, and return tasks as values (`make f = greet` becomes legal).
- [ ] **Anonymous tasks / lambdas** — `make double = do (x): give x * 2`.
- [ ] **Closures** — a nested/anonymous task captures the surrounding scope.
- [ ] **Default parameters** — `task greet(who, mark = "!")`.
- [ ] **Named arguments** — `area(width: 3, height: 4)`.
- [ ] **Variadic tasks** — `task add(...numbers)`.
- [ ] Re-decide: are nested `task` definitions allowed now? (Closures imply yes — relax the "top-level only" rule.)

## Phase 3 — Collections & iteration superpowers 🟢 ⛓️(needs Phase 2 for the task-taking ones)

- [ ] Higher-order builtins: **`map` `filter` `reduce` `sort` `find` `count` `any` `all` `sum` `min_by`/`max_by`**.
- [ ] **`for each key, value in map`** (today you only get keys).
- [ ] **Slicing** — `xs[1..3]`, `text[0..2]`; and **ranges as values** — `make r = 1..10`.
- [ ] More list ops: **`reverse` `unique` `zip` `flatten` `insert` `remove` `index_of` `join`(have)**.
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

## Phase 6 — Text, numbers & time 🟢 (mostly builtins — low risk, high beginner value)

- [ ] Text: **`starts_with` `ends_with` `index_of` `pad_left`/`pad_right` `repeat` `words` `lines` `title` `format`**.
- [ ] **Multi-line strings** (un-defer) — `"""…"""` triple-quoted.
- [ ] Math: **`pow` `log` `sin`/`cos`/`tan` `pi` `e` `clamp` `sign` `round_to`**; **seeded `random`** (reproducible).
- [ ] **Real date/time values** — `now()` returns a value you can do arithmetic on; durations; parse/format.

## Phase 7 — Persistence & I/O 🟢/🟡

- [ ] **`remember` / `recall`** — key/value that persists between runs (the smallest, friendliest first step — do this early).
- [ ] Filesystem: **`list_folder` `delete` `copy` `make_folder`** (have `read`/`write`/`append`/`exists`).
- [ ] **`args`** (command-line), **`env(name)`** (environment), **stdin lines**.
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

---

## Phase 12 — Re-freeze as v0.1.0

Repeat the v0.0.13 ritual for everything added:

- [ ] Decide every new edge case (one rule each) — especially: closures + scope, first-class-task equality/display, record equality/display, `match` exhaustiveness, integer↔double coercion, multi-line string rules.
- [ ] Vocabulary audit — every new keyword (`try`, `otherwise`(exists), `do`, `match`, `record`, `const`, `skip`, `stop`, `until`, …); update the reserved list.
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
Good first moves on unfreeze day: **`remember`/`recall`** (Phase 7, tiny + friendly) and **`try`/`otherwise`** (Phase 1, the original ask) — both high-value, both low-risk.

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
