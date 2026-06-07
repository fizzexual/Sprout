# 🌱 The Sprout Wiki

Everything about the **Sprout** language and its styling language **Bloom**.

## What can you build with Sprout?

- 🧮 **Programs** — variables, math, text, conditions, loops, and `task` functions
- 🪟 **Native desktop apps** — real windows with buttons, labels, and inputs
- 🌐 **Websites** — the same app served in a browser, no extra code
- 🎨 **Styled either way** with **Bloom**, Sprout's own CSS
- 🤖 **A Discord bot** — chat + `/slash` commands, and a real **music player**
- 🔌 …and a growing library ecosystem (see [Libraries](libraries.md))

All from **one small, dependency-free language** with its own friendly vocabulary.

## Pages

| Page | What's inside |
| --- | --- |
| **[Getting Started](getting-started.md)** | install Sprout, run your first program |
| **[Sprout Syntax](sprout-syntax.md)** | the whole language — variables, math, text, conditions, loops, tasks |
| **[Built-in Functions](builtins.md)** | `sqrt`, `max`, `length`, `upper`, `remember`/`recall`, `get`/`post`, `secret`… |
| **[GUI & Servers](gui-and-servers.md)** | build native windows and websites in Sprout |
| **[Bloom Styling](bloom-syntax.md)** | Sprout's own CSS — style apps and embeds |
| **[Libraries](libraries.md)** | add powers like `discord-bot`, manage them with `sprout modules` |
| **[Cheat Sheet](cheatsheet.md)** | the whole language on one page |

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
