<p align="center">
  <img src="images/banner.png" alt="Sprout" width="100%" />
</p>

<h1 align="center">🌱 Sprout</h1>

<p align="center"><b>A small, friendly programming language — written from scratch in C.</b><br/>
Plain-English code, helpful errors, and zero dependencies. No Node, no VM, no runtime to install.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?style=flat-square" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/written%20in-C-2ea043?style=flat-square" alt="written in C" />
  <img src="https://img.shields.io/badge/runtime-none-2ea043?style=flat-square" alt="no runtime needed" />
</p>

<p align="center">
  <a href="wiki/getting-started.md">Get started</a> ·
  <a href="wiki/cheatsheet.md">Cheat sheet</a> ·
  <a href="wiki/architecture.md">How it works</a>
</p>

---

Sprout is a **real, from-scratch programming language** — its own lexer, parser, and
tree-walking interpreter, written in **C**. **Sprout itself** is compiled to a tiny
native executable that depends on **nothing but the operating system** (no Node, no
JavaScript, no runtime to install); your **`.sprout` programs are then interpreted by
that executable** — they aren't turned into machine code. The same path Python
(CPython) and Lua took.

It has one goal: **be the kindest language to learn programming with.** When
something's wrong, Sprout explains it in plain English, points at the line, and
suggests a fix:

```
  Sprout error (line 2): I don't know what 'nme' is.

  Did you mean 'name'?
```

And with `learn on`, Sprout **narrates itself as it runs** — perfect for a first
look at how code actually executes:

```sprout
learn on
make x = 5
make y = 10
show x + y
```
```
  Created variable x = 5
  Created variable y = 10
  Evaluating:
      x + y
      5 + 10 = 15
  Output:
      15
```

## Code you can read out loud

Sprout has its **own** vocabulary — `make`, `show`, `when`, `repeat`, `task` — so a
beginner can guess what a program does just by reading it. No `let`, no `print`, no `if`.

```sprout
make name = "world"
show f"Hello, {name}!"

make score = 8
when score >= 9:
    show "outstanding"
orwhen score >= 7:
    show "great job"
otherwise:
    show "keep going"

task greet(who):
    give "Hello, " + who + "!"

show greet("Sprout")
```

## What works today

Sprout is being **rebuilt from scratch in C**, one slice at a time. The core
language runs now:

- Values: numbers, text, `yes` / `no`, `nothing`
- `make`, `set`, `show` (commas join with spaces)
- **Text templates:** `f"Hi {name}, you have {x + y} points"` — values drop straight in
- Math `+ - * / %` with precedence and `( )`; `+` also joins text
- Compare `== != < <= > >=`, logic `and` `or` `not`
- `when` / `orwhen` / `otherwise`, `repeat N times`, `repeat while`
- `task` / `give`, function calls, **recursion**, proper scope
- **Lists** `[1, 2, 3]` and **maps** `{name: "Sam"}` — indexing, `set xs[i] = …`, `for each`, `range`
- **`learn on`** — Sprout explains each step as it runs (and **friendly errors** that say *"did you mean…?"*)
- **Toolbox:** `length` `add` `keys` `contains` `first` `last` `range` · `sqrt` `abs` `round` `floor` `ceil` `min` `max` `random` `number` · `upper` `lower` `trim` `replace` `split` `join` · `now` `today` `wait` · `ask` · `color` (terminal colour)
- **Superpowers — built in, no libraries:**
  - 🌐 `get(url)` — fetch any web page or API
  - 🧩 `json(text)` — parse JSON straight into native lists & maps
  - 🔎 `explore(value)` — list every field/target inside an API response
  - 📄 `read` / `write` / `append` / `exists` — files
  - ⚙️ `system.run(command)` — run any program and capture its output (after `use system`)
- **Projects & modules:** a `sprout.toml` ties many files into one program — `use server` then call it by name (`server.start()`), `public` exposes a task/value (private by default — no hidden global sharing), and `sprout build` runs the whole thing
- **System module:** OS-level actions are explicit — `use system` then `system.run("...")`
- **Scaffolding:** `sprout new <folder>` creates a full multi-file project · `sprout template load <name>` scaffolds into the current folder · **`sprout api <url>`** dumps every field an API returns
- `~` comments, indentation blocks, friendly errors with line numbers

```sprout
~ call any API and use the result like a normal value — no libraries, no glue
make repo = json(get("https://api.github.com/repos/fizzexual/Sprout"))
show repo["name"], "is written in", repo["language"]
```

### Real projects, many files

Scaffold a project and run it — one command each:

```bash
sprout new chat-app       # creates the folder below
cd chat-app
sprout build              # reads sprout.toml, loads every file, runs main last
```

```
chat-app/
├─ sprout.toml            # the project: name, main file, files to include
├─ app.sprout            # the entry point (main)
├─ modules/
│   ├─ greeter.sprout     # task: greet(who)
│   └─ server.sprout      # tasks: start(), handle(user) — uses greeter
└─ tests/
    └─ test.sprout
```

```toml
# sprout.toml
project "chat-app"
main "app.sprout"

include [
    "modules/greeter.sprout",
    "modules/server.sprout"
]
```

```sprout
~ app.sprout — import a module, then call it by name
use greeter
use server

show greeter.greet("world")
server.start()
```

## Build & run

You need a C compiler **once** (to build it). The `sprout` executable it produces
needs nothing.

```bash
# get a compiler (Windows, one time):
winget install --id BrechtSanders.WinLibs.POSIX.UCRT

# build the interpreter:
cd src
build.cmd                     # or: gcc -O2 -Wall -s -o sprout.exe sprout.c -lm -lurlmon

# run a program:
sprout run hello.sprout     # or just: sprout hello.sprout
sprout version              # -> Sprout v0.0.7
sprout new myapp            # create a full multi-file project folder
sprout build                # run the project in the current folder (reads sprout.toml)
sprout api <url>            # list every field an API returns
```

The result is a **~86 KB** native executable that links only against the operating
system's own libraries. Drop it anywhere and it runs.

## Roadmap

The core is done; the rest of the language is on its way back, slice by slice:

1. ✅ **Core** — variables, math, text, `when`, `repeat`
2. ✅ **Tasks** — `task` / `give`, function calls, recursion, scope
3. ✅ **Collections** — lists `[...]`, maps `{...}`, indexing, `for each`, `range`
4. ✅ **Superpowers & tooling** — math/text toolbox, files, web (`get` / `json` / `explore`), `run`, `color`, templates, `sprout api`
5. ✅ **Projects & modules** — `sprout.toml`, `use`, `public`/`private`, `sprout new`, `sprout build`
6. ✅ **f-strings, friendly errors & `learn` mode** — `f"Hi {name}"`, "did you mean?", step-by-step narration
7. ⏭️ **`remember` / `recall`** — values that persist between runs
8. **Testing & docs** — `test "…": expect …`, `sprout test`, `sprout docs`
9. **Apps & more** — a package manager, then GUI windows

## How it works

```
source.sprout → lexer → parser → interpreter → output
```

Your `.sprout` program is **interpreted** (walked as a tree), not compiled to
machine code — only the Sprout interpreter itself is compiled (to that ~86 KB
native `sprout.exe`). A small, dependency-free pipeline in one C file. The full tour is in
[`src/README.md`](src/README.md) and **[How Sprout Works](wiki/architecture.md)**.
There's a **[VS Code extension](vscode-extension)** for syntax highlighting too.

> Sprout previously had a TypeScript-on-Node implementation with a GUI, a
> compile-to-JavaScript engine, and libraries. That has been retired so the
> language can stand entirely on its own in C — it lives on in the git history.

---

<p align="center"><sub>A real language, built from scratch — one slice at a time. 🌱</sub></p>
