# 🌱 The Sprout Wiki

Everything about **Sprout** — a small, friendly programming language written from scratch
in **C**, depending on nothing but the operating system. These pages document the language
**exactly as it works today** (the frozen core, v0.1.4), and every example was run against
the real interpreter.

**→ Start at the [Wiki Navigator](../wiki_navigator.md)** for the full map plus a
find-anything index of every keyword, operator, builtin, and command.

## Pages

**Start here**
- [Getting started](getting-started.md) · [Cheat sheet](cheatsheet.md)
- [**Roadmap**](roadmap.md) — every phase, what's built and what's planned (start here to find *"can Sprout do X yet?"*)

**Language guide**
- [Syntax basics](syntax-basics.md) — values, `make` / `set` / `show`, scope
- [Operators](operators.md) — math, comparison, logic, `in`, `or else`, `|>`, ranges
- [Control flow](control-flow.md) — `when` / `repeat` / `stop` / `skip`
- [Text](text.md) — strings, f-strings, indexing
- [Lists, maps, ranges & comprehensions](collections.md)
- [Tasks, lambdas & closures](tasks-and-lambdas.md)
- [Types & objects](types-and-objects.md) — `type`: classes with fields, methods, `self`
- [Pattern matching](pattern-matching.md) — `match` / `is`
- [Errors](errors.md) — `try` / `caught` / `fail`

**Reference**
- [Builtins reference](builtins-reference.md) — all 84 builtins
- [Grammar & decided edge cases](grammar-and-edge-cases.md) — EBNF, indentation, reserved words
- [Glossary](glossary.md)

**Tooling, projects & hosting**
- [Command line & flags](cli-and-flags.md)
- [Modules & projects](modules-and-projects.md)
- [Testing & learn mode](testing-and-learn.md)
- [Persistence](persistence.md) — `remember` / `recall` / `forget`
- [Files, web, system & time](io-web-system-time.md)
- [Sandbox & the online playground](sandbox-and-playground.md)

**Internals**
- [How Sprout works](architecture.md)

## The 30-second tour

```sprout
~ this is a comment

make name = "world"
show "Hello, " + name + "!"

repeat 3 times:
    show "🌱"

task add(a, b):
    give a + b

show add(2, 3)        ~ 5
```

Sprout has its **own** vocabulary — `make`, `set`, `show`, `when`, `repeat`, `task` — it
doesn't borrow `let`, `print`, or `if` from anyone.
