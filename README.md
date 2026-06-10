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

## Language reference (the precise rules)

A short, exact description of the semantics as implemented — written so a language
designer can audit it. If something here reads as a mistake, it probably is:
[open an issue](https://github.com/fizzexual/Sprout/issues).

**Values & types.** Dynamically typed. Five value kinds: **number**, **text**,
**yes/no** (boolean), **nothing**, and the collections **list** and **map**.
There are no user-defined types/structs/classes — a **map** (`{name: "Sam"}`) is
the record type. Maps preserve **insertion order**; keys are text.

**Numbers are IEEE-754 doubles.** There is no separate integer type, so `5 / 2`
is `2.5` and very large integers lose precision. `%` is `fmod`. Division/modulo by
zero is a runtime error.

**Text is UTF-8.** `length("café")` is `4` (characters, not bytes). Strings are
immutable and **not indexable** (`"abc"[0]` is an error) — iterate with `for each`
or `split`. `+` concatenates, and if either side of `+` is text the other side is
coerced via its display form (`"n=" + 3` → `"n=3"`).

**Truthiness** (for `when` / `repeat while` / `and` / `or` / `not`): `no`,
`nothing`, `0`, `""`, and empty list/map are falsey; everything else is truthy.
`and`/`or` short-circuit. **Equality** (`==`/`!=`) is structural and deep for
lists/maps (with a depth guard against self-referential values); `< <= > >=`
compare only two numbers or two pieces of text.

**Scope.** Variables are **function/file scoped — blocks do not introduce scope.**
A `make` inside a `when`/`repeat`/`for each` writes into the enclosing scope, and a
loop variable is still in scope after the loop. `set` requires the name to already
exist. Top-level code of each file runs in that file's own scope.

**Tasks** (`task f(...) ... give`) are **top-level only** — no nested functions and
**no closures**. A task sees its own file's top-level names plus its parameters and
locals, *not* the caller's locals (so calls are referentially clean). Recursion is
supported, bounded by a call-depth guard (~6000) on a 64 MB stack.

**Modules & visibility.** A `sprout.toml` (`project`, `main`, `include [...]`)
defines a project. `use server` imports a module; you then reach its **`public`**
tasks/values as `server.start()` / `server.config`. Everything is **private by
default** (file-local, called bare within the file). There is **no implicit global
sharing** between files, and a file may only name a module it has `use`d. Modules
load **once** (so circular `use` terminates), are resolved by `sprout.toml` then by
searching `modules/ src/ lib/ ./`, and are keyed by basename (first file with a
given basename wins). `system` is a **reserved** built-in module (`system.run`).

**Evaluation & errors.** Eager, left-to-right; statements run top to bottom. The
**first error aborts** the run (there is no batch diagnostics pass and no static
type checking) — except in the interactive REPL, which catches the error and keeps
your session. Error messages are heuristic (edit-distance "did you mean?").

**Concurrency.** None — single-threaded, synchronous. `wait(seconds)` blocks.

## Design decisions & rationale

The interesting choices, and what each one costs — the places worth challenging:

| Decision | Why | Trade-off / risk |
| --- | --- | --- |
| **Tree-walking interpreter** (no bytecode/JIT) | Tiny, simple, easy to read and trust | Slow vs. a bytecode VM; fine for learning, not for hot loops |
| **All C, zero deps** (links only OS libs) | One ~86 KB exe, nothing to install, no supply chain | Reimplementing everything (JSON, HTTP) by hand; C memory risks |
| **No GC — allocate and leak until exit** | Trivial, no pauses, correct for short CLI runs | Memory grows in long-running programs; **the biggest known weakness** |
| **Doubles only, no integer type** | One number type is simpler for beginners | Precision/overflow surprises; no bigint |
| **Namespaced modules + `private` default** | Predictable, scales, no hidden global sharing | More to type across files (`module.name`) |
| **Maps as the only record type** | Fewer concepts to learn | No fields/methods/type checking on shapes |
| **First error aborts** | Simple, clear single message | No "here are all 12 errors" batch reporting |
| **Own keywords** (`make`/`show`/`task`) | Readable out loud for first-timers | Unfamiliar to experienced devs; not C/JS-like |
| **Indentation blocks** (Python-style) | Clean, no `{}`/`;` noise | Tabs-vs-spaces and copy-paste pitfalls |

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

## How it works (architecture)

```
source.sprout → lexer → parser → AST → tree-walking interpreter → output
```

The whole language is **one C file** (`src/sprout.c`, ~2k lines), compiled to a
~86 KB native exe. Your `.sprout` program is **interpreted** (the AST is walked) —
only the interpreter itself is compiled to machine code.

- **Lexer** — hand-written; turns indentation into `INDENT`/`DEDENT` tokens
  (Python-style). f-strings are **desugared in the lexer**: `f"Hi {name}"` becomes
  the token stream `( "Hi " + ( name ) + "" )`, so they need no special AST/eval.
- **Parser** — recursive descent with precedence climbing for the operators;
  produces a plain AST of `Expr`/`Stmt` nodes. Token strings are owned by the AST,
  which makes re-parsing additional files (for `use`) re-entrant and safe.
- **Interpreter** — walks the AST. Variables live in a chain of environments
  (file scope → call frame). Tasks live in a table keyed by `(name, file)`;
  visibility is resolved against the current file id, with separate small
  registries for module namespaces, per-file imports (`use`), and `public` vars.
- **Memory** — values are `malloc`'d and intentionally **not freed** (freed by
  process exit). Recursion runs on a 64 MB stack with a call-depth guard.
- **Built-ins, from scratch** — JSON is a hand-written parser; HTTP uses the OS
  (`urlmon` on Windows); shell via `popen`. No third-party libraries.

Full tour: [`src/README.md`](src/README.md) and **[How Sprout Works](wiki/architecture.md)**.
There's a **[VS Code extension](vscode-extension)** for syntax highlighting too.

> Sprout previously had a TypeScript-on-Node implementation with a GUI, a
> compile-to-JavaScript engine, and libraries. That has been retired so the
> language can stand entirely on its own in C — it lives on in the git history.

## Known limitations & open questions

Sprout is **v0.0.7** — early, and deliberately small. These are the rough edges
I already know about; **spotting more (or telling me which of these matter most)
is exactly the kind of feedback I'm looking for** —
[issues](https://github.com/fizzexual/Sprout/issues) /
[discussions](https://github.com/fizzexual/Sprout/discussions) welcome.

- **No garbage collection.** Memory grows for the life of the process. Fine for
  scripts/CLIs; wrong for a long-running server. The intended fix is a small GC or
  arena — design input wanted.
- **Performance.** Tree-walking, so tight numeric loops are slow. No bytecode/JIT.
- **Numbers are doubles only** — no integers/bigints; precision and overflow can
  surprise.
- **No user-defined types.** Maps are the only record; no structs, no methods, no
  shape/type checking.
- **No closures or first-class functions.** Tasks are top-level only; a task
  defined inside a block is silently not registered (a gotcha I'd like to error on).
- **No block scope.** Loop/`when` variables leak into the enclosing scope.
- **Strings aren't indexable** (`s[0]` errors); iterate or `split`.
- **Errors abort on the first one** — no batch diagnostics, no static checks; all
  type errors are caught at runtime.
- **`system.run` shells out** — powerful and OS-dependent; gated behind
  `use system`, but still a sharp edge for beginners.
- **Portability.** Built and tested on Windows (MinGW). POSIX branches exist
  (realpath/opendir/etc.) but aren't CI-tested yet.
- **No package manager / versioning** for modules yet.

Each release goes through an adversarial review pass before shipping, and the
fixes are listed in the [release notes](https://github.com/fizzexual/Sprout/releases).

---

<p align="center"><sub>A real language, built from scratch — one slice at a time. 🌱</sub></p>
