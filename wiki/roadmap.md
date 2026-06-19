# Roadmap — the road to a full software language

Sprout is a **general-purpose software language**, written from scratch in C. It's growing
toward the capabilities you expect from a language like Java, Python or C# — in deliberate
**phases**, each one shipped, tested, and documented before the next begins.

This page is the map: what each phase contains, whether it's done, and where to read more.
If you want to know *"can Sprout do X yet?"* — start here.

## Status at a glance

| # | Phase | Status | Read more |
|:-:|-------|--------|-----------|
| 0 | **Core language** | ✅ Done | the [language guide](README.md#pages) |
| 1 | **Classes & objects** | ✅ Done — v0.1.7 | [Types & objects](types-and-objects.md) |
| 2 | **Inheritance & polymorphism** | ✅ Done — v0.1.8 | [Types & objects → Inheritance](types-and-objects.md#inheritance) |
| 3 | **Interfaces & type annotations** | 📋 Planned | — |
| 4 | **Standard-library breadth** | 🔜 In progress — v0.1.9 | [Builtins reference](builtins-reference.md) |
| 5 | **Package manager** | 📋 Planned | — |
| 6 | **Tooling** (LSP, formatter, debugger) | 📋 Planned | — |

Legend: ✅ done · 🔜 in progress · 📋 planned

---

## Phase 0 — Core language ✅

Everything a language needs to actually compute. All complete and documented:

- **Values & variables** — numbers, text, yes/no, nothing, lists, maps · `make` / `set` —
  see [Syntax basics](syntax-basics.md)
- **Control flow** — `when` / `orwhen` / `otherwise`, `repeat`, `for each`, `stop` / `skip` —
  see [Control flow](control-flow.md)
- **Tasks, lambdas & closures** — first-class functions — see [Tasks & lambdas](tasks-and-lambdas.md)
- **Pattern matching** — `match` / `is` with destructuring — see [Pattern matching](pattern-matching.md)
- **Errors** — `try` / `caught` / `fail` — see [Errors](errors.md)
- **Collections & comprehensions**, **ranges**, the **pipe** `|>` — see [Collections](collections.md), [Operators](operators.md)
- **Modules & projects** — `use`, `public`, `sprout.toml` — see [Modules & projects](modules-and-projects.md)
- **Built-in testing**, **learn mode**, a **garbage collector**, **persistence** — see [Testing](testing-and-learn.md), [Persistence](persistence.md)

## Phase 1 — Classes & objects ✅ *(v0.1.7)*

The `type` keyword: classes that bundle **fields** (data) with **methods** (behaviour).

- Define: `type Point:` with `make x` / `make y = 0` fields and `task length(self): …` methods
- Build: `Point(3, 4)` · read/write: `p.x` / `set p.x = …` · call: `p.length()`
- `kind_of(p)` and `show` report the type · methods that `give self` **chain**
- **Polymorphism** — different types sharing a method name dispatch at run time

→ Full page: **[Types & objects](types-and-objects.md)**

## Phase 2 — Inheritance & polymorphism ✅ *(v0.1.8)*

- `type Dog from Animal:` — a child **inherits** the parent's fields and methods
- **Override** a method by redefining it; calls use **virtual dispatch** (a parent method
  that calls `self.sound()` runs the child's version)
- **`is_a(obj, "Animal")`** — true for the type or any ancestor (like Java's `instanceof`)
- **Operator overloading + custom display** *(v0.1.11)* — a type can define `plus` / `minus` /
  `multiply` / `divide` / `modulo`, `equals`, `compare`, and `text`, so `+` `-` `*` `==` `<`
  and `show` all work on your own types

→ Full page: **[Types & objects](types-and-objects.md)** ([Inheritance](types-and-objects.md#inheritance) · [Operators](types-and-objects.md#operators--custom-display))

## Phase 3 — Interfaces & type annotations 📋

The plan: a way to say *"this type provides these methods"* (interfaces / protocols), and
**optional** type annotations that are checked when you write them — keeping the dynamic core
for everyday code while adding safety where you want it.

## Phase 4 — Standard-library breadth 🔜 *(in progress, v0.1.9)*

Closing the "batteries included" gap. **Shipped so far:**

- **Math** — `sin` `cos` `tan` `exp` `log` (natural, or `log(x, base)`) `pi()`
- **`args()`** — your program's command-line arguments (a list of text)
- **`env(name)` / `env(name, default)`** — read environment variables
- **Regex** — `matches` / `find` / `find_all` (classes, quantifiers `* + ? {n,m}`, anchors
  `^ $`, and the `\d \w \s` shorthands) — see [Builtins → Text patterns](builtins-reference.md#text-patterns-regex)

- **Date & time** *(v0.1.12)* — `time()` (a moment as a number), `time_parts` / `time_make` /
  `time_format`, and `days` / `hours` / `minutes` so date maths reads naturally
  (`time() + days(7)`, `(b - a) / days(1)`)

**Still planned:** sets and queues, a wider math library (inverse trig), and regex groups `( )`
+ alternation `a|b`.

## Phase 5 — Package manager 📋

Importing shared libraries by name, with a registry and versioning — so Sprout programs can
build on each other.

## Phase 6 — Tooling 📋

The professional developer experience: editor/LSP support, a formatter, a linter, a debugger
— and bundling a program into a standalone executable you can hand to someone.

---

## What we have vs. Java — gap snapshot

Sprout's **core language is complete** and on a par with a small Python/Lua/Ruby (and ahead of
Java on pattern matching, the pipe operator, built-in testing, and zero dependencies). The
remaining distance to a Java-class language is exactly phases **3–6** above: richer types,
a bigger standard library, an ecosystem, and tooling.

For the full feature-by-feature comparison, see the project README's design notes.
