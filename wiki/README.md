# 🌱 The Sprout Wiki

Everything about **Sprout** — a small, friendly programming language written from
scratch in **C**, depending on nothing but the operating system.

> Sprout is being (re)built in C one slice at a time. These pages document the
> language **as it works today** (the core). The [roadmap](#roadmap) lists what's
> coming next.

## Pages

| Page | What's inside |
| --- | --- |
| **[Getting Started](getting-started.md)** | build the interpreter and run your first program |
| **[Sprout Syntax](sprout-syntax.md)** | the language explained slowly — variables, math, text, conditions, loops, tasks |
| **[Built-in Functions](builtins.md)** | the toolbox + the superpowers — `get`, `json`, `run`, files, math, text |
| **[Cheat Sheet](cheatsheet.md)** | the whole language on one page |
| **[How Sprout Works](architecture.md)** | the architecture — the pipeline and how the C interpreter is built |

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

Sprout has its **own** vocabulary — `make`, `set`, `show`, `when`, `repeat`,
`task` — it doesn't borrow `let`, `print`, or `if` from anyone.

## Roadmap

1. ✅ **Core** — variables, math, text, `when`, `repeat`
2. ✅ **Tasks** — `task` / `give`, function calls, recursion, scope
3. ✅ **Collections** — lists `[...]`, maps `{...}`, indexing, `for each`, `range`
4. ✅ **Superpowers** — the toolbox (math/text), files, the web (`get`), JSON, `run`, `ask`
5. ⏭️ **f-strings** (`f"Hi {name}"`) and `remember` / `recall`
6. **Richer errors** — the `^` pointer and "did you mean?" suggestions
7. **Apps & more** — GUI windows, libraries
