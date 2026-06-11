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
- **Compound assignment:** `set x += 1` (and `-= *= /= %=`), including through an index (`set xs[i] += 1`, `set m[key] += 1`)
- **Text templates:** `f"Hi {name}, you have {x + y} points"` — values drop straight in
- Math `+ - * / %` with precedence and `( )`; `+` also joins text
- Compare `== != < <= > >=`, logic `and` `or` `not`
- `when` / `orwhen` / `otherwise`, `repeat N times`, `repeat while`, and **`stop`** / **`skip`** to leave or skip a loop turn
- **Error handling:** `try:` / `caught problem:` to catch a runtime error (the caught error is a map `{message, kind, line}`), and `fail "message"` (or `fail {...}`) to raise your own
- `task` / `give`, function calls, **recursion**, proper scope
- **Lists** `[1, 2, 3]` and **maps** `{name: "Sam"}` — indexing, `set xs[i] = …`, `for each`, `range`
- **`learn on`** — Sprout explains each step as it runs (and **friendly errors** that say *"did you mean…?"*)
- **Built-in testing** — `test "name": expect …`, run with `sprout test` (pass/fail report + exit code)
- **Toolbox:** `length` `add` `remove` `insert` `keys` `values` `contains` `first` `last` `index_of` `sort` `reverse` `range` · `sqrt` `pow` `abs` `round` `floor` `ceil` `min` `max` `random` `number` · `upper` `lower` `trim` `replace` `split` `join` `starts_with` `ends_with` · `now` `today` `wait` · `ask` · `color` (terminal colour)
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
sprout version              # -> Sprout v0.0.15
sprout new myapp            # create a full multi-file project folder
sprout build                # run the project in the current folder (reads sprout.toml)
sprout test                 # run your tests (a file, or every tests/*.sprout)
sprout api <url>            # list every field an API returns
```

Tests use plain words too — `test` and `expect`:

```sprout
test "greeting":
    expect greet("Sam") == "Hello, Sam!"
    expect length([1, 2, 3]) == 3
```
```
  ok  greeting

  1 passed
```

The result is a **~86 KB** native executable that links only against the operating
system's own libraries. Drop it anywhere and it runs.

## Language reference (the precise rules)

A short, exact description of the semantics as implemented — written so a language
designer can audit it.

> **On "freeze."** v0.0.13 was originally called a freeze; in hindsight that was the
> wrong word — it held for one version. It's better understood as **spec-complete /
> a release candidate**: every edge case decided and documented. The **v0.0.14–v0.1.0
> "base-completion" cycle** is deliberately still adding the table-stakes pieces a
> small language needs (error handling, loop control, compound assignment, the missing
> builtins). **v0.1.0 is the freeze that's meant to hold** — the point where the core
> stops moving and libraries can build on it. Until then, the core is in active
> development and the rules below can still change.

The rules below are tested. If something here reads as a mistake, it probably is:
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

**Compound assignment.** `set x += e` is exactly `set x = x + e`, and likewise
`-=`, `*=`, `/=`, `%=`. It works through an index too: `set xs[i] += 1` and
`set m[key] += 1` (the list position / map key must already exist). The operator
keeps `+`'s meaning, so `set s += "!"` appends text. The name (or element) must
already exist — compound assignment never *creates* one.

**Loop control.** Inside a `repeat`/`for each` body, **`stop`** ends the loop
immediately and **`skip`** jumps to the next turn. Both affect only the innermost
loop, and using either outside a loop is a parse-time error. `give` inside a loop
still returns from the whole task.

**Error handling.** `try:` runs a block; if a step fails, control jumps to the
matching **`caught:`** block (which must be present) instead of aborting the run.
**The caught error is a map** with `message` (text), `kind` (text), and `line`
(number): `caught problem:` binds it to `problem`, so `problem["message"]` and
`problem["kind"]` are available; a bare `caught:` handles it without binding. The
**name is yours to choose** (`caught err:`, `caught oops:` — anything). Built-in
errors set `kind` to a category (`"math"`, `"index"`, `"io"`, `"name"`, `"fail"`, …)
so code can branch on the kind instead of string-matching the message.

You raise your own error with **`fail "message"`** (a bare `fail` uses a default).
`fail` can also carry a **map** — `fail {kind: "http", status: 404, message: "Not
found"}` is caught *whole* (the three standard keys are filled in if you omit them),
so a library or the web `kind` can attach structured detail. `try` blocks nest, and
`give`/`stop`/`skip` pass cleanly **out through** a `try` (they're control flow, not
errors — the `caught` block does **not** run for them).

**Two error tiers — what `try` does and doesn't catch.** `try` catches *runtime
conditions*: bad input, divide-by-zero, a missing file, an out-of-range index, a
`fail`. It deliberately does **not** catch *code mistakes* — an unknown variable,
task, or module (the "did you mean?" errors) and lexer/parser errors. Those are
"hard": they skip every enclosing `try` and surface their diagnostic, so wrapping a
block in `try` can never silently swallow a typo. (Hard errors are still caught by
the system boundaries — a test, the REPL, a file run — so one bad line fails just
that test or REPL line rather than the whole session.)

**Evaluation & errors.** Eager, left-to-right; statements run top to bottom. Outside
of `try`, the **first error aborts** the run (there is no batch diagnostics pass and
no static type checking) — except in the interactive REPL, which catches the error
and keeps your session. Error messages are heuristic (edit-distance "did you mean?").

**Concurrency.** None — single-threaded, synchronous. `wait(seconds)` blocks.

### Decided edge cases (settled at v0.0.13, the spec-complete point)

Every corner case decided and tested. One rule each:

- **Indexing is non-negative.** `xs[-1]` is an error — use `last(xs)`. Lists don't auto-grow: an out-of-range index errors, it doesn't extend.
- **`first([])` / `last([])` error** on an empty list (rather than silently giving `nothing`) — beginners see the cause.
- **`number("abc")` is `nothing`** (not an error), so you can safely check input: `when number(x) == nothing: …`. (`number` of real text like `"42"` is `42`.)
- **Equality never crashes.** `5 == "5"` is `no` (different kinds are never equal); `==`/`!=` work across any types.
- **String escapes** `\n` `\t` `\"` `\\` are real characters in text and f-strings (and `\{` `\}` in f-strings).
- **Text is single-line.** A string literal can't span source lines — join with `\n`. (Multi-line string syntax is *not in v1*.)
- **Using `nothing` wrongly is a friendly error** — `nothing[0]` and `nothing + 1` say so plainly, rather than guessing.
- **`when` with no matching branch and no `otherwise` does nothing.**
- **`give` with no value, and a task that never `give`s, both return `nothing`.**
- **A task name isn't a value (yet).** `make f = greet` is a friendly error ("tasks can't be stored in a variable yet") — there are no first-class functions.

### Reserved words & identifiers

**Identifiers** start with a letter or `_`, then letters/digits/`_` (ASCII), and are
**case-sensitive** (`Name` and `name` are different).

**Keywords** (reserved — you can't use them as names):

```
make set show when orwhen otherwise repeat while times task give
for each in use public private learn test expect and or not yes no nothing
try caught fail stop skip
```

> **`otherwise` vs `caught`.** `otherwise` is the else-branch of `when`; `caught` is
> the catch-block of `try`. They're separate words so each reads as one thing —
> `when … otherwise:` ("else") and `try … caught problem:` ("on error").

**Built-in functions** are predefined names — `length sqrt pow abs round floor ceil
min max random number upper lower trim replace split join starts_with ends_with
range add remove insert keys values contains first last index_of sort reverse
ask now today wait read write append exists get json explore color`
(plus `system.run`). You *may* shadow one with your own variable, but the function
stays callable, so it's clearer not to.

> **`orwhen` stays.** It's the committed spelling for "else-if" (not `else when` /
> `or when`) — one word, in keeping with Sprout's own vocabulary.

### Not in the core *today* (and what's being decided before v0.1.0)

What you can't assume in the current core: **no closures**, **no first-class / stored
tasks**, **no user-defined types** (maps are the record), **no multi-line string
syntax**, **no negative indexing**, **no integer type** (numbers are doubles).

Two of these — **first-class/stored tasks** and **user-defined types** — are openly
**under evaluation** for the v0.1.0 core (see [ROADMAP.md](ROADMAP.md), phases 2 and
4); the base-completion cycle is exactly when that gets decided. They are *not in the
core yet*, and may or may not make the cut. The rest (multi-line strings, negative
indexing, a separate integer type) are deliberate long-term choices, not omissions.
(Error recovery — `try:` / `caught:` — landed in the cycle: v0.0.14, reshaped in
v0.0.15.)

### Grammar (core, EBNF)

Descriptive, not yet a formal spec — the source is the truth — but enough to spot
ambiguities. `INDENT`/`DEDENT`/`NEWLINE` come from the lexer (see below).

```ebnf
program    = { statement } ;
statement  = make | set | show | when | repeat | foreach
           | task | give | use | learn | try | fail | "stop" | "skip"
           | ( expr NEWLINE ) ;
make       = [ "public" | "private" ] "make" ident "=" expr NEWLINE ;
set        = "set" ( ident | postfix ) assign expr NEWLINE ;
assign     = "=" | "+=" | "-=" | "*=" | "/=" | "%=" ;  (* compound: x op= e  ==  x = x op e; target must exist *)
show       = "show" expr { "," expr } NEWLINE ;        (* commas print with a space between *)
when       = "when" expr block { "orwhen" expr block } [ "otherwise" block ] ;
repeat     = "repeat" ( expr "times" | "while" expr ) block ;  (* a 'times' count is truncated to a whole number; <= 0 runs 0 times *)
foreach    = "for" "each" ident "in" expr block ;             (* over a map, ident takes each KEY *)
task       = [ "public" | "private" ] "task" ident "(" [ ident { "," ident } ] ")" block ;  (* top level only *)
give       = "give" [ expr ] NEWLINE ;                 (* a parse error outside a task *)
try        = "try" block "caught" [ ident ] block ;    (* caught is required; ident binds the error map {message,kind,line} *)
fail       = "fail" [ expr ] NEWLINE ;                 (* raise an error; a map is carried whole, else wrapped as {message,kind:"fail",line} *)
use        = "use" ( ident | string ) NEWLINE ;       (* a path-looking target (has / \ or .sprout) is literal; otherwise it's a searched module name *)
learn      = "learn" ( "on" | "off" ) NEWLINE ;
block      = ":" NEWLINE INDENT { statement } DEDENT ;  (* "stop"/"skip" only inside a loop body *)

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

The core grew back slice by slice; it's now in the base-completion cycle toward the
v0.1.0 freeze:

1. ✅ **Core** — variables, math, text, `when`, `repeat`
2. ✅ **Tasks** — `task` / `give`, function calls, recursion, scope
3. ✅ **Collections** — lists `[...]`, maps `{...}`, indexing, `for each`, `range`
4. ✅ **Superpowers & tooling** — math/text toolbox, files, web (`get` / `json` / `explore`), `run`, `color`, templates, `sprout api`
5. ✅ **Projects & modules** — `sprout.toml`, `use`, `public`/`private`, `sprout new`, `sprout build`
6. ✅ **f-strings, friendly errors & `learn` mode** — `f"Hi {name}"`, "did you mean?", step-by-step narration
7. ✅ **Built-in testing** — `test "…": expect …` and `sprout test`
8. ✅ **Spec-complete (v0.0.13)** — every edge case decided and tested (originally called "the freeze"; it held one version — see the note in the Language reference).
9. ✅ **Base-completion (v0.0.14–v0.0.15)** — the cycle's first slices: `stop`/`skip`, compound assignment (`+=` …), the missing list/map/text builtins (`remove` `insert` `sort` `reverse` `index_of` `values` `pow` `starts_with` `ends_with`), and **error handling** — `try` / `caught` / `fail` with a structured error map `{message, kind, line}` and a hard/soft split so typos aren't swallowed (reshaped from `otherwise` in v0.0.15).

The cycle continues toward **v0.1.0 — the freeze that's meant to hold**. The full,
sequenced plan — first-class tasks, collections superpowers, user types, a memory
model, the web `kind`, tooling — is in **[ROADMAP.md](ROADMAP.md)**.

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

Sprout is **v0.0.15** — early, and deliberately small. Honest about the edges:
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
- **Errors abort on the first one** *unless* wrapped in `try:` / `caught:`
  (added v0.0.14, reshaped v0.0.15) — there's still no batch diagnostics and no
  static type checking; type errors surface at runtime.
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
