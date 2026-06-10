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

And with `learn on`, Sprout **narrates each step's values as it runs** (`make` /
`set` / `show`) — perfect for a first look at how code actually executes:

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
- `make` (new name), `set` (change an existing one), `show` (print — *its* commas print with a space between; `make`/`set` take a single value)
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
  - 🔎 `explore(value)` — a *function* that returns a list of every `path = value` inside a value (the `sprout api <url>` *command* is just the CLI shortcut that fetches a URL and prints this)
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
sprout version              # -> Sprout v0.0.11
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
is `2.5` and very large integers lose precision. `%` is `fmod`; division/modulo by
zero is a runtime error. **Whole-number values display without a decimal point** —
`range(3)` shows `[0, 1, 2]`, and indices/counts/`length` read as `0`, `1`, `2`
(not `0.0`) — so the doubles-only choice is invisible until you do real division.
(Very large whole numbers fall back to exponential form, e.g. `1e+21`.)

**Text is UTF-8.** `length("café")` is `4` (characters, not bytes). Strings are
immutable, but **indexable by character**: `s[i]` is the *i*-th character, 0-based
and UTF-8 aware (`"café"[3]` is `"é"`; an out-of-range index errors). `for each`
and `split` also walk the characters.

**One display form.** `show`, f-strings (`f"{x}"`), and `+` all render a value
through the **same** function, so the result is always identical:

| value | displays as |
| --- | --- |
| number | `3`, `2.5` (no trailing `.0` for whole numbers) |
| text | the text itself (no quotes) |
| yes / no | `yes` / `no` |
| nothing | `nothing` |
| list | `[1, 2, 3]` |
| map | `{name: Sam, age: 3}` |

So `"L=" + [1, 2]` → `"L=[1, 2]"` and `f"{nothing}"` → `nothing`. For `+`, if
either side is text the other is coerced to its display form; otherwise `+` is
numeric addition (and `text + text` concatenates). Inside an f-string each `{...}`
keeps its own operator meaning and only the final splice is coerced, so
`f"{2 + 3}"` is `"5"`, not `"23"`.

**Truthiness** (for `when` / `repeat while` / `and` / `or` / `not`): `no`,
`nothing`, `0`, `""`, and empty list/map are falsey; everything else is truthy.
`and`/`or` short-circuit, and **`and` binds tighter than `or`** (`a or b and c`
means `a or (b and c)`). **Equality** (`==`/`!=`) is structural and deep for
lists/maps (depth-guarded against self-reference); `< <= > >=` compare two numbers
or two pieces of text. **Comparisons don't chain** — `1 < 2 < 3` is a friendly
error; write `1 < 2 and 2 < 3`.

**Lists & maps.** `[1, 2, 3]` and `{name: "Sam", age: 3}`. A **bare identifier key
is shorthand for its text** — `{name: 1}` has the key `"name"`; keys are never
evaluated as variables. Index with `x[i]` (a whole number for a list, text for a
map). `set` can write through an index: `set xs[i] = v` requires the position to
already exist (lists don't auto-grow — an out-of-range index is an error), while
`set m[key] = v` **inserts** the key if it's absent — **new map keys use `set`**,
not `make`, because the map itself already exists (you're changing it; `make` is
only for brand-new *names*). Index assignment may nest (`set grid[i][j] = v`),
even though *module* member access is a single dot. **`for each` over a map yields
its keys** (in insertion order); use `m[key]` for the value.

**Variables & scope.** `make` introduces a **new** name; **`make` on a name that
already exists in the same scope is an error** ("use 'set' to change it") — so a
typo'd `make` can't silently become a reassignment. `set` changes an existing name
(searching outward to enclosing scopes) and errors if it was never made.
**Blocks have their own scope:** names `make`d inside a `when`/`repeat`/`for each`
body are gone when the block ends and may *shadow* an outer name; `set` still
reaches outward to mutate an enclosing variable. A `for each` variable is scoped to
the loop body — each iteration gets a fresh one, and it does not exist after the loop.

**Tasks** (`task f(...) ... give`) are **top-level only** — defining a `task`
inside a block is a parse error. No nested functions and **no closures**: a task
sees its own file's top-level names plus its parameters and locals, *not* the
caller's locals (so calls are referentially clean). Recursion is supported, bounded
by a fixed call-depth guard of **6000** on a 64 MB stack.

**Modules & visibility.** A `sprout.toml` (`project`, `main`, `include [...]`)
defines a project. `use server` imports a module; you then reach its **`public`**
tasks/values as `server.start()` / `server.config` (member access is a **single**
dot — `a.b.c` is a syntax error). Everything is **private by default** (file-local,
called bare within the file). There is **no implicit global sharing**, and a file
may only name a module it has `use`d (otherwise: *"to call server.start, add 'use
server' at the top of this file."*). Modules load **once** (so circular `use`
terminates) and resolve via `sprout.toml` then by searching `modules/ src/ lib/ ./`;
**two project files with the same basename are a load-time error** (module names
must be unique). A `use` target that **looks like a path** (contains `/`, `\`, or
`.sprout`, e.g. `use "modules/server.sprout"`) is taken literally, resolved from the
project root, and skips the name search; any other target — bare *or* quoted —
goes through the search above (so `use server` and `use "server"` behave the same).
`system` is a **reserved**
built-in module — you still write `use system` so OS access (`system.run`) is
explicit, and you can't define your own module named `system`. (`private` is the
**default**, so the keyword is optional — allowed for emphasis but redundant.)

**`learn on` / `learn off`.** `learn` is a keyword; `learn on` and `learn off` are
statements that flip a single **global** narration flag (it is *not* scoped and does
*not* nest — the most recent one wins, and it persists across files in a run). While
on, it narrates the **value of each step**: `make`/`set` (the name and its new
value) and `show` (the expression with its values substituted, then the result). It
does **not** (yet) narrate which `when` branch ran, each loop iteration, or task
calls/returns. Off by default.

**Evaluation & errors.** Eager, left-to-right; statements run top to bottom. The
**first error aborts** the run (there is no batch diagnostics pass and no static
type checking) — except in the interactive REPL, which catches the error and keeps
your session. Error messages are heuristic (edit-distance "did you mean?").

**Concurrency.** None — single-threaded, synchronous. `wait(seconds)` blocks.

### Grammar (core, EBNF)

Descriptive, not yet a formal spec — the source is the truth — but enough to spot
ambiguities. `INDENT`/`DEDENT`/`NEWLINE` come from the lexer (see below).

```ebnf
program    = { statement } ;
statement  = make | set | show | when | repeat | foreach
           | task | give | use | learn | ( expr NEWLINE ) ;
make       = [ "public" | "private" ] "make" ident "=" expr NEWLINE ;
set        = "set" ( ident | postfix ) "=" expr NEWLINE ;
show       = "show" expr { "," expr } NEWLINE ;        (* commas print with a space between *)
when       = "when" expr block { "orwhen" expr block } [ "otherwise" block ] ;
repeat     = "repeat" ( expr "times" | "while" expr ) block ;  (* a 'times' count is truncated to a whole number; <= 0 runs 0 times *)
foreach    = "for" "each" ident "in" expr block ;             (* over a map, ident takes each KEY *)
task       = [ "public" | "private" ] "task" ident "(" [ ident { "," ident } ] ")" block ;  (* top level only *)
give       = "give" [ expr ] NEWLINE ;                 (* a parse error outside a task *)
use        = "use" ( ident | string ) NEWLINE ;       (* a path-looking target (has / \ or .sprout) is literal; otherwise it's a searched module name *)
learn      = "learn" ( "on" | "off" ) NEWLINE ;
block      = ":" NEWLINE INDENT { statement } DEDENT ;

expr       = or ;
or         = and { "or" and } ;
and        = cmp { "and" cmp } ;
cmp        = term [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) term ] ;  (* non-associative: comparisons don't chain *)
term       = factor { ( "+" | "-" ) factor } ;
factor     = unary { ( "*" | "/" | "%" ) unary } ;
unary      = ( "-" | "not" ) unary | postfix ;
postfix    = primary { "[" expr "]" } ;
primary    = number | string | fstring | "yes" | "no" | "nothing"
           | list | map | "(" expr ")"
           | ident [ "." ident ] [ "(" [ expr { "," expr } ] ")" ] ;
list       = "[" [ expr { "," expr } ] "]" ;
map        = "{" [ key ":" expr { "," key ":" expr } ] "}" ;
key        = ident | string ;
fstring    = 'f"' { char | "{" expr "}" } '"' ;
```

### Indentation rules

- Leading whitespace is significant. **A tab counts as one column, the same as one
  space** — so don't mix tabs and spaces, or levels won't line up.
- **Any** increase in indentation opens a block (the unit is whatever you used —
  there's no fixed size). A decrease must return **exactly** to a previous level, or
  you get *"the indentation doesn't line up with the block."*
- Blank lines and `~`-comment-only lines don't affect indentation.

> **Tested.** The behaviors above are exercised by the suite in
> [`src/tests/`](src/tests), run in **CI on Linux, macOS, and Windows**
> ([workflow](.github/workflows/ci.yml)), and re-checked each release by an
> adversarial review. The POSIX paths (`realpath`/`opendir`/`mkdir`, and `get`
> via `curl`) are now built and tested there too.

## Design decisions & rationale

The interesting choices, and what each one costs — the places worth challenging:

| Decision | Why | Trade-off / risk |
| --- | --- | --- |
| **Tree-walking interpreter** (no bytecode/JIT) | Tiny, simple, easy to read and trust | Slow vs. a bytecode VM; fine for learning, not for hot loops |
| **All C, zero deps** (links only OS libs) | One ~86 KB exe, nothing to install, no supply chain | Reimplementing everything (JSON, HTTP) by hand; C memory risks |
| **No GC — allocate and leak until exit** | Trivial, no pauses, correct for short CLI runs | Memory grows in long-running programs; **the biggest known weakness** |
| **Doubles only, no integer type** | One number type is simpler for beginners | Precision/overflow surprises; no bigint |
| **Namespaced modules + `private` default** | Predictable, scales, no hidden global sharing | More to type across files (`module.name`) |
| **Block scope + strict `make`** | Loop/`when` vars can't leak; a typo'd `make` can't silently reassign | You must `set` (not re-`make`) to change a value; shadowing is allowed |
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

Sprout is **v0.0.11** — early, and deliberately small. Honest about the edges:
spotting more (or telling me which matter most) is exactly the feedback I want —
[issues](https://github.com/fizzexual/Sprout/issues) /
[discussions](https://github.com/fizzexual/Sprout/discussions) welcome.

**On the roadmap — real gaps I want to close:**

- **No garbage collection.** Memory grows for the life of the process — fine for
  scripts/CLIs, wrong for a long-running server. The honest fix is a real GC or
  arena; it's a sizeable change to a value model that currently passes values on
  the C stack, so it's a deliberate slice, not a quick patch. Design input wanted.
- **Performance.** Tree-walking, so tight numeric loops are slow. A bytecode VM
  would help — a large rewrite, not yet started.
- **Errors abort on the first one** — no batch diagnostics and no static type
  checking; type errors surface at runtime.
- **No package manager / versioning** for modules yet.

**Deliberately small — design choices, not bugs (challenge them if you disagree):**

- **One number type (doubles).** No separate int/bigint — simpler for a beginner;
  the cost is precision/overflow at the extremes (`1e+21`).
- **Maps are the only record** — no structs/methods/shape-checking. One concept,
  not two.
- **Tasks are top-level; no closures or first-class functions.** Keeps "what can
  call what" obvious; a task inside a block is a clear error, not a silent no-op.
- **`system.run` is the single, explicit escape hatch** for OS commands — gated
  behind `use system` so it's never ambient, but it's still real power.

Each release goes through an adversarial review before shipping; fixes are in the
[release notes](https://github.com/fizzexual/Sprout/releases). **Recently closed:**
string indexing (`s[i]`), `get` on POSIX (via `curl`), and **CI that builds &
tests on Linux, macOS, and Windows**.

---

<p align="center"><sub>A real language, built from scratch — one slice at a time. 🌱</sub></p>
