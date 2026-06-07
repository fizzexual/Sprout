# 🌱 The Sprout Wiki

Everything about the **Sprout** language and its styling language **Bloom**.

## Pages

- **[Getting Started](getting-started.md)** — install, run your first program
- **[Sprout Syntax](sprout-syntax.md)** — the whole language: variables, math, text, conditions, loops, tasks
- **[Built-in Functions](builtins.md)** — `sqrt`, `max`, `length`, `upper`, and friends
- **[GUI & Servers](gui-and-servers.md)** — build native windows and websites in Sprout
- **[Bloom Styling](bloom-syntax.md)** — Sprout's own CSS
- **[Cheat Sheet](cheatsheet.md)** — the whole language on one page

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

Sprout is a small, friendly language with its **own** vocabulary — it doesn't
borrow `let`, `print`, or `if` from anyone. It can also build **native GUI apps**
and **websites**, styled with **Bloom**.
