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
  <a href="wiki_navigator.md">Full wiki</a> ·
  <a href="wiki/architecture.md">How it works</a>
</p>

---

I built Sprout as a **real, from-scratch programming language** — its own lexer, parser,
and tree-walking interpreter, written in **C**. The interpreter compiles to a tiny native
executable that depends on **nothing but the operating system** (no Node, no JavaScript,
no runtime to install); your **`.sprout` programs are then interpreted by that
executable** — they aren't turned into machine code. The same path Python (CPython) and
Lua took.

I had one goal the whole way: **make the kindest language to learn programming with.**
When something's wrong, Sprout explains it in plain English, points at the line, and
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

I gave Sprout its **own** vocabulary — `make`, `show`, `when`, `repeat`, `task` — so a
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

I built Sprout **from scratch in C**, one slice at a time, and **froze the core at
v0.1.0**. Here's everything it runs:

- Values: numbers, text, `yes` / `no`, `nothing`
- `make` (new name), `set` (change an existing one), `show` (print — *its* commas print with a space between; `make`/`set` take a single value)
- **Compound assignment:** `set x += 1` (and `-= *= /= %=`), including through an index (`set xs[i] += 1`, `set m[key] += 1`)
- **Text templates:** `f"Hi {name}, you have {x + y} points"` — values drop straight in
- Math `+ - * / %` with precedence and `( )`; `+` also joins text
- Compare `== != < <= > >=`, logic `and` `or` `not`, **membership** `x in xs`, **fallback** `a or else b` (use `b` if `a` is `nothing`)
- `when` / `orwhen` / `otherwise`, `repeat N times`, `repeat while`, **`stop`** / **`skip`** to leave or skip a loop turn, and **`match`** with destructuring patterns
- **Pattern matching** — `match value:` with `is "start":` / `is [a, b]:` / `is {name, age}:` arms that compare *or* pull a list/map apart, plus `otherwise`
- **Pipe** `|>` — `x |> f` is `f(x)`; chain data transforms left-to-right: `nums |> filter(is_even) |> map(double) |> sum`
- **Error handling:** `try:` / `caught problem:` to catch a runtime error (the caught error is a map `{message, kind, line}`), and `fail "message"` (or `fail {...}`) to raise your own
- `task` / `give`, function calls, **recursion**, proper scope — **tasks are first-class values** you can store, pass, and call (`make f = double`, `map(xs, double)`, `filter`, `reduce`), plus **lambdas + closures**: anonymous inline tasks that capture surrounding variables (`map(xs, task(n): n * 2)`, `task adder(by): give task(x): x + by`)
- **Objects** — `type Point:` defines a class with **fields** (`make x`, `make y = 0` for a default) and **methods** (`task length(self): …`, where `self` is the object). Build one with `Point(3, 4)`, read/write fields with `p.x` and `set p.x = …`, call methods with `p.length()`, and `kind_of(p)` is `"Point"`. Different types sharing a method name dispatch to the right one at run time (polymorphism)
- **Lists** `[1, 2, 3]` and **maps** `{name: "Sam"}` — indexing, `set xs[i] = …`, `range`, **`a to b` ranges**, **list comprehensions** (`[n*2 for each n in xs when n > 0]`), and `for each` (`for each item in xs`, or `for each key, value in m`)
- **`learn on`** — Sprout narrates each step as it runs: values, **which `when` branch ran, every loop turn, and each task call + what it gave back** (plus **friendly errors** that say *"did you mean…?"*)
- **Built-in testing** — `test "name": expect …`, plus **`expect error "kind":`** to assert that a block fails; run with `sprout test`
- **Toolbox:** `length` `add` `remove` `insert` `keys` `values` `contains` `first` `last` `index_of` `sort` `sort_by` `reverse` `copy` `kind_of` `map` `filter` `reduce` `sum` `count` `unique` `zip` `flatten` `slice` `range` · `sqrt` `pow` `abs` `round` `floor` `ceil` `min` `max` `random` `seed` `number` · `upper` `lower` `trim` `replace` `split` `join` `starts_with` `ends_with` `words` `lines` `title` · `now` `today` `wait` · `ask` · `color` (terminal colour)
- **Superpowers — built in, no libraries:**
  - 🌐 `get(url)` — fetch any web page or API
  - 🧩 `json(text)` — parse JSON straight into native lists & maps
  - 🔎 `explore(value)` — a *function* that returns a list of every `path = value` inside a value (the `sprout api <url>` *command* is just the CLI shortcut that fetches a URL and prints this)
  - 📄 `read` / `write` / `append` / `exists` — files
  - 💾 `remember(key, value)` / `recall(key)` / `forget(key)` — save data and read it back **between runs** (a key/value store kept as JSON in `sprout.data.json`)
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
build.cmd                     # or: gcc -O2 -Wall -s -o sprout.exe sprout.c -lm -lurlmon -lws2_32

# run a program:
sprout run hello.sprout     # or just: sprout hello.sprout
sprout --sandbox run x.sprout   # run UNTRUSTED code: no file / shell / network access
sprout version              # -> Sprout v0.1.1
sprout new myapp            # create a full multi-file project folder
sprout build                # run the project in the current folder (reads sprout.toml)
sprout test                 # run your tests (a file, or every tests/*.sprout)
sprout api <url>            # list every field an API returns
```

### Running untrusted code — `--sandbox` (for an online playground)

If you host a playground where strangers run Sprout on **your** server, pass `--sandbox`
(anywhere on the line) or set `SPROUT_SANDBOX=1`. It turns **off** every builtin that can
reach outside the program — the filesystem (`read` `write` `append` `exists`), the on-disk
store (`remember` `recall` `forget`), the network (`get` `explore`), and the **shell**
(the whole `system` module). Each blocked call is a clear, catchable error; everything
else (math, text, lists, maps, tasks, `match`, the pipe, …) works normally.

```
sprout --sandbox run untrusted.sprout      # read/write/get/system... are all disabled
```

> **The flag is necessary but not sufficient.** It closes the *language's* outward APIs,
> but a hosting server must still cap **CPU time, memory, and output** at the OS/container
> level (a process timeout, a memory limit, an output cap) — Sprout can still loop forever
> or allocate a lot. Run each submission as a short-lived, unprivileged, resource-limited
> process. (The GC keeps memory *bounded per program*, but not *small*.)

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
is `2.5` and very large integers lose precision. `%` is `fmod`; **the remainder
takes the sign of the left operand** (`(0 - 7) % 3` is `-1`, `7 % (0 - 3)` is `1`).
Division/modulo by zero is a runtime error (kind `"math"`); `sqrt` of a negative is
too, so `nan`/`inf` aren't reachable through the normal paths. **Whole-number values
display without a decimal point** — `range(3)` shows `[0, 1, 2]`, and
indices/counts/`length` read as `0`, `1`, `2` (not `0.0`) — so the doubles-only
choice is invisible until you do real division. (Very large whole numbers fall back
to exponential form, e.g. `1e+21`, past `1e15`.) **Scientific-notation literals** are
accepted (`1e3`, `2.5e-2`). `random` is **not** seedable yet, so runs aren't
reproducible (a roadmap item).

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
error; write `1 < 2 and 2 < 3`. **`x in xs`** is membership — at the same
(non-chaining) level as the comparisons — and tests a list item, a map *key*, or a
substring of text. **`a or else b`** is nothing-coalescing: it's `a` unless `a` is
`nothing`, in which case `b` (and `b` is only evaluated then). It's *not* error
recovery — that's `try`/`caught` — it's for the `nothing` that `number("x")` or a
missing map key gives back: `make port = number(ask("port?")) or else 8080`.

**`kind_of(x)`** returns a value's type as text — `"number"`, `"text"`, `"yes-no"`,
`"nothing"`, `"list"`, or `"map"` — so you can branch on a type: `when kind_of(x) == "number": …`.

**Lists & maps.** `[1, 2, 3]` and `{name: "Sam", age: 3}`. A **bare identifier key
is shorthand for its text** — `{name: 1}` has the key `"name"`; keys are never
evaluated as variables. Index with `x[i]` (a whole number for a list, text for a
map). `set` can write through an index: `set xs[i] = v` requires the position to
already exist (lists don't auto-grow — an out-of-range index is an error), while
`set m[key] = v` **inserts** the key if it's absent — **new map keys use `set`**,
not `make`, because the map itself already exists (you're changing it; `make` is
only for brand-new *names*). Index assignment may nest (`set grid[i][j] = v`),
even though *module* member access is a single dot. **`for each` over a map yields
its keys** (in insertion order); use `m[key]` for the value, or bind both with a
comma: **`for each key, value in m`**. With two names over a *list* or *text* you get
**`for each index, item`** (the index is 0-based). **Map key order is insertion
order; `remove`ing a key then setting it again puts it at the back.**

**Ranges (`a to b`) and comprehensions** *(v0.0.25)*. **`a to b`** is an **inclusive**
range of whole numbers — `1 to 5` is `[1, 2, 3, 4, 5]` and `3 to 3` is `[3]`. If the
start is past the end it's **empty** (`1 to 0` is `[]`, so `for each i in 1 to count`
does nothing when `count` is 0 — no surprise reverse); to count down, use
`reverse(1 to 5)`. It binds looser than arithmetic, so `1 to n + 1` means
`1 to (n + 1)`. (It's the human-friendly, inclusive sibling of the 0-based,
end-exclusive `range(n)` / `range(a, b)` builtin.) Ranges are ordinary lists,
so they drive loops and the toolbox directly:

```
for each i in 1 to 10:   ...        # 1, 2, … 10
show sum(1 to 100)                  # -> 5050
```

A **list comprehension** builds a list in one line — `[expr for each x in xs]`, with an
optional **`when`** filter — over a list, a range, text (its characters), or a map (its
keys):

```
show [n * 2 for each n in [1, 2, 3]]              # -> [2, 4, 6]
show [i * i for each i in 1 to 10 when i % 2 == 0]  # -> [4, 16, 36, 64, 100]
show [upper(c) for each c in "abc"]              # -> ["A", "B", "C"]
```

It's just a list, so it composes with everything (`sum([…])`, `map`, a lambda inside).

**Pattern matching (`match`)** *(v0.0.26)*. `match value:` checks a value against `is`
arms in order and runs the first that fits, with an optional `otherwise`:

```
match command:
    is "start":   show "go"            # a literal/value — compared with ==
    is "stop":    show "halt"
    is [a, b]:    show a + " & " + b    # a 2-item list — pulls it apart, binds a, b
    is {name, age}:                     # a map with those keys — binds name, age
        show name + " is " + age
    otherwise:    show "no idea"
```

Three kinds of pattern: a **value** (any expression — `is 0`, `is "x"`, `is yes`,
`is nothing`, even `is [1, 2]` — matched with `==`); a **list-destructure**
`is [a, b]` (matches a list of *exactly* that length and binds each item to a name);
and a **map-destructure** `is {name, age}` (matches a map that has *all* those keys
and binds each to a same-named variable). The bound names live only inside that arm.
The rule of thumb: **bare names** in `[ ]`/`{ }` mean *destructure*; anything else
(`[1, 2]`, `{a: 1}`) is a **value** compared with `==`. If nothing matches and there's
no `otherwise`, the `match` does nothing (like a `when` with no `otherwise`).

**The pipe operator `|>`** *(v0.0.27)*. `x |> f` is just `f(x)`, and `x |> f(a)` is
`f(x, a)` — the left value threads in as the **first** argument. It's left-associative,
so a chain reads **top to bottom** instead of inside-out:

```
nums |> filter(task(n): n % 2 == 0) |> map(task(n): n * 10) |> sum
#  ==  sum(map(filter(nums, …even…), …×10…))
```

The right side is a **task or a call** — a name (`|> double`), a call with more
arguments (`|> add(2)`), or a module call (`|> server.handle(req)`). It binds looser
than arithmetic (so `2 + 3 |> double` is `double(5)`) and tighter than comparisons. It
pairs beautifully with lambdas, ranges, and comprehensions — every stage is just a
normal call, so there's nothing new to learn at runtime.

**Lists & maps are shared references — this is load-bearing.** `make b = a` does
**not** copy; `a` and `b` are the *same* list/map, so `add(b, 3)` changes `a` too,
and passing one into a task lets the task mutate the caller's value. (Numbers,
`yes`/`no`, `nothing`, and text are value types / immutable — only lists and maps
are shared.) When you need an independent snapshot, use **`copy(x)`** — a deep copy
that later changes to the original won't touch. **Equality** (`==`) is by *value*,
not identity: two different lists/maps with equal contents are equal (and map key
order doesn't affect equality, even though it's preserved for iteration).

**The mutating builtins, and what they return.** `add`/`insert` change a list and
return **nothing** (they're commands). `remove` changes the list/map and returns the
**removed item** (or `nothing` if a map key was absent). `sort`/`reverse` change the
list **in place** and return the **same list** (a reference, not a copy — so
`show sort(xs)` works *and* `xs` is now sorted). `copy` is the only one that returns
a new value.

**Sorting records by a field — `sort_by(list, task)`.** `sort` only handles a flat
list of numbers or text. To order a list of *records* (or anything) by a computed
value, use **`sort_by`** — it sorts low-to-high by whatever the task returns for each
item (a number or text), and it's **stable** (equal keys keep their order). Reverse it
for high-to-low:

```
make ranked = reverse(sort_by(players, task(p): p["score"]))   # highest score first
```

Like `sort`, it sorts **in place** and returns the same list.

**The "batteries" builtins** all return **new** values (they never mutate their
input): `sum(list)`, `count(list, value)` / `count(text, piece)`, `unique(list)`,
`zip(a, b)` (pairs up to the shorter), `flatten(list)` (one level deep),
`slice(list-or-text, start, end)` (**`start` inclusive, `end` exclusive**, clamped —
`slice([10,20,30], 0, 2)` is `[10, 20]`), `words(text)` (split on any run of
whitespace), `lines(text)` (split on newlines; a *trailing* newline doesn't add an
empty line; `""` → `[]`), `title(text)`, and `seed(n)` (makes `random` reproducible).
The higher-order `map`/`filter`/`reduce` take a task (see *Tasks are first-class
values*).

**Variables & scope.** `make` introduces a **new** name; **`make` on a name that
already exists in the same scope is an error** ("use 'set' to change it") — so a
typo'd `make` can't silently become a reassignment. `set` changes an existing name
(searching outward to enclosing scopes) and errors if it was never made.
**Blocks have their own scope:** names `make`d inside a `when`/`repeat`/`for each`
body are gone when the block ends and may *shadow* an outer name; `set` still
reaches outward to mutate an enclosing variable. A `for each` variable is scoped to
the loop body — each iteration gets a fresh one, and it does not exist after the loop.

**Tasks** (`task f(...) ... give`) are **named** at the top level only — a *named*
`task` statement inside a block is a parse error. A named task sees its own file's
top-level names plus its parameters and locals, *not* the caller's locals (so named
calls are referentially clean). Recursion is supported, bounded by a fixed call-depth
guard of **6000** on a 64 MB stack.

**Lambdas (anonymous tasks) + closures** *(v0.0.24)*. Write a task **inline, with no
name**, anywhere a value goes: `task(x): x * 2`. A one-line body is an **implicit
`give`** of a single expression (the everyday case) — `give` is allowed but optional;
for several statements, use an indented block:

```
make double = task(x): x * 2          # one-liner: implicit give
show map([1, 2, 3], task(n): n * 2)    # -> [2, 4, 6]
make classify = task(v):               # multi-line block body
    when v > 0:
        give "positive"
    otherwise:
        give "non-positive"
```

> Inside a multi-line `[ ]` / `{ }` / `( )` literal, a lambda must use a **one-line
> body** (newlines there are ignored, so a `when`/multi-step block can't be detected).
> For a multi-step lambda in a list/map/call, `make` it with a name first and use the
> name. Sprout tells you this if you hit it.

Unlike a named task, a **lambda is a closure**: it *captures the surrounding
variables* and keeps them alive. So you can build tasks that remember:

```
task adder(by):
    give task(x): x + by      # the returned lambda captures `by`
make add5 = adder(5)
show add5(10)                  # -> 15
```

Each evaluation captures **fresh** — `adder(5)` and `adder(100)` give independent
closures, and a lambda created inside a `for each` keeps *that turn's* value. Capture
is **by reference**: if you change a captured variable later, the closure sees the new
value. (Lambdas pair naturally with `map`/`filter`/`reduce`; to map a builtin you can
still wrap it, `task(s): upper(s)`.) Captured environments are reclaimed by the
garbage collector once nothing can reach them (*v0.1.0*), so closures are fine even in
long-running programs.

**Tasks are first-class values.** A task's name used without `( )` is a *value* you
can store, pass, return, and call: `make f = double` then `f(5)`; `apply(double, 5)`;
`give double` from another task; `[double, square]` in a list. `kind_of(t)` is
`"task"`, and a task is truthy. Calling a non-task with `( )` (or a variable that
holds, say, a number) is a friendly error. This unlocks the higher-order builtins
**`map(list, task)`**, **`filter(list, task)`**, and **`reduce(list, task, start)`**
(the `reduce` task takes `(total, item)`). For now you pass a **named task**; to map a
builtin, wrap it (`task up(s): give upper(s)` then `map(words, up)`).

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
also narrates **control flow** — which `when` branch ran, each loop turn (`Repeat
turn N of M`, while-loop turns, and each `for each` turn with the loop variables
bound), and each task call plus what it gave back. Off by default.

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
errors set `kind` to one of a **fixed, stable set** (below) so code can branch on the
kind instead of string-matching the message.

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

**Error `kind`s (stable as of v0.0.15; frozen at v0.1.0).** A caught error's `kind`
is one of these exact strings — a library may rely on them. New kinds may be *added*
in future versions; existing ones won't be renamed or removed.

| `kind` | catchable? | what raises it |
| --- | --- | --- |
| `"math"` | yes | a number operation that has no answer: divide/remainder by zero, `sqrt` of a negative |
| `"type"` | yes | a value of the wrong kind for an operator or `[ ]`: `yes + 5`, `-text`, `a < b` across kinds, `x in 5`, `xs["k"]`, indexing `nothing`, and list ops on mixed/non-number items (`sort([1,"a"])`, `sum([1,"a"])`). (Note: `+` *concatenates* when either side is text, so `"a" + 1` is `"a1"`, not an error.) |
| `"index"` | yes | a list/text position that doesn't exist |
| `"io"` | yes | a file that can't be opened for writing |
| `"fail"` | yes | your own `fail` (text or a map without its own `kind`) |
| `"name"` | **no (hard)** | an unknown variable, task, or module — a code mistake |
| `"error"` | yes | the default for any other runtime condition (including calling a built-in with the wrong number or shape of arguments, like `abs("x")`) |

A `fail` with a map keeps whatever `kind` you put in it (e.g. `"http"`), so you're
free to define your own kinds for your own errors.

**Evaluation & errors.** Eager, left-to-right; statements run top to bottom. Outside
of `try`, the **first error aborts** the run (there is no batch diagnostics pass and
no static type checking) — except in the interactive REPL, which catches the error
and keeps your session. Error messages are heuristic (edit-distance "did you mean?").

**Persistence.** `remember(name, value)` / `recall(name)` / `forget(name)` are a tiny
key/value store that survives between runs: one JSON file, **`sprout.data.json`**, in
the current folder (shared by every program run there). `recall` of a name that was
never set — or after a `forget` — is **`nothing`**, so the idiom is
`make x = recall("x") or else <default>`. Any value round-trips except tasks (which
aren't values): numbers, text, `yes`/`no`, `nothing` (stored as JSON `null`), lists,
and maps (stored as a JSON object). `recall` returns an **independent copy** (mutating
it doesn't change the store — you must `remember` again to save). `forget` returns
`yes` if the name existed. A missing or corrupt file reads as an empty store.

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
- **A task's name *is* a value.** `make f = greet` stores the task; `f(...)` calls it (added v0.0.20). Calling a non-task with `( )` is a friendly error.

### Reserved words & identifiers

**Identifiers** start with a letter or `_`, then letters/digits/`_` (ASCII), and are
**case-sensitive** (`Name` and `name` are different).

**Keywords** (reserved — you can't use them as names):

```
make set show when orwhen otherwise repeat while times task give
for each in to match is use public private learn test expect and or not yes no nothing
try caught fail stop skip
```
(`else` is **not** reserved — it's only meaningful right after `or` (the `or else`
operator); anywhere else it's an ordinary name.)

> **`otherwise` vs `caught`.** `otherwise` is the else-branch of `when`; `caught` is
> the catch-block of `try`. They're separate words so each reads as one thing —
> `when … otherwise:` ("else") and `try … caught problem:` ("on error").

**Built-in functions** are predefined names — `length sqrt pow abs round floor ceil
min max random number upper lower trim replace split join starts_with ends_with
range add remove insert keys values contains first last index_of sort reverse copy kind_of map filter reduce
sum count unique zip flatten slice words lines title seed
ask now today wait read write append exists remember recall forget get json explore color`
(plus `system.run`). You *may* shadow one with your own variable, but the function
stays callable, so it's clearer not to.

> **`orwhen` stays.** It's the committed spelling for "else-if" (not `else when` /
> `or when`) — one word, in keeping with Sprout's own vocabulary.

### Not in the core (on purpose)

A few things you won't find, by design: **no user-defined types** (maps are the record),
**no multi-line string syntax**, **no negative indexing**, and **no separate integer
type** (numbers are doubles). I left each of these out so there's one obvious way to do the
thing — they're decisions, not gaps I'm getting to.

For the record: **first-class/stored tasks** landed in v0.0.20 and **lambdas + closures**
in v0.0.24 (`task(x): x * 2`, capturing surrounding variables — see *Lambdas (anonymous
tasks)* above), and **error handling** (`try:` / `caught:`) in v0.0.14–v0.0.15. The core
**froze at v0.1.0**; the longer plan lives in [ROADMAP.md](ROADMAP.md).

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
foreach    = "for" "each" ident [ "," ident ] "in" expr block ; (* 1 name: item / map-key. 2 names: (index,item) over a list/text, (key,value) over a map *)
task       = [ "public" | "private" ] "task" ident "(" [ ident { "," ident } ] ")" block ;  (* top level only *)
give       = "give" [ expr ] NEWLINE ;                 (* a parse error outside a task *)
try        = "try" block "caught" [ ident ] block ;    (* caught is required; ident binds the error map {message,kind,line} *)
fail       = "fail" [ expr ] NEWLINE ;                 (* raise an error; a map is carried whole, else wrapped as {message,kind:"fail",line} *)
use        = "use" ( ident | string ) NEWLINE ;       (* a path-looking target (has / \ or .sprout) is literal; otherwise it's a searched module name *)
learn      = "learn" ( "on" | "off" ) NEWLINE ;
block      = ":" NEWLINE INDENT { statement } DEDENT ;  (* "stop"/"skip" only inside a loop body *)

expr       = or ;
or         = and { ( "or" "else" and )            (* nothing-coalescing: left unless it's nothing *)
                  | ( "or" and ) } ;              (* logical or *)
and        = cmp { "and" cmp } ;
cmp        = term [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) term ] ;  (* non-associative; `x in xs` = membership *)
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
number     = digits [ "." digits ] [ ("e"|"E") ["+"|"-"] digits ] ;  (* 42, 2.5, 1e3, 1.5e-2 *)
```

### Indentation rules

- Leading whitespace is significant. **A tab counts as one column, the same as one
  space** — so don't mix tabs and spaces, or levels won't line up.
- **Any** increase in indentation opens a block (the unit is whatever you used —
  there's no fixed size). A decrease must return **exactly** to a previous level, or
  you get *"the indentation doesn't line up with the block."*
- Blank lines and `~`-comment-only lines don't affect indentation.
- **Inside `( )`, `[ ]`, or `{ }` newlines and indentation are ignored** *(v0.0.28)* —
  a list, map, or call can span as many lines as you like, and a **trailing comma** is
  allowed, so each item gets its own line and reorders cleanly:

  ```
  make people = [
      {name: "Ada", age: 36},
      {name: "Mo",  age: 17},
  ]
  ```
  (Text literals still can't span lines — join with `\n`.)

> **Tested.** The behaviors above are exercised by the suite in
> [`src/tests/`](src/tests), run in **CI on Linux, macOS, and Windows**
> ([workflow](.github/workflows/ci.yml)), and re-checked each release by an
> adversarial review. The POSIX paths (`realpath`/`opendir`/`mkdir`, and `get`
> via `curl`) are now built and tested there too.

## Design decisions & rationale

These are the calls I find most interesting — and what each one costs me. Every "Sprout is
small" line below is a decision I'd make again, not a hole I'm hiding; if you'd have called
one differently, [tell me](https://github.com/fizzexual/Sprout/issues).

| Decision | Why I chose it | What it costs |
| --- | --- | --- |
| **Tree-walking interpreter** (no bytecode/JIT) | Tiny, simple, the whole thing reads as one C file you can trust | Slower than a bytecode VM — I built it for learning and real scripts, not tight numeric hot loops |
| **All C, zero deps** (links only OS libs) | One ~86 KB exe, nothing to install, no supply chain | I reimplement everything (JSON, HTTP) by hand; C memory discipline is on me |
| **Conservative mark-sweep GC** *(v0.1.0; strings v0.1.3)* | Long-running programs stay bounded — lists, maps, environments, closures, **and strings** all collected; cycles collected; it can never free a live value | Some overhead on allocation/call-heavy paths |
| **Doubles only, no integer type** | One number type means a beginner never has to pick one before `make x = 5` | Precision/overflow at the extremes (past `1e+21`); no bigint |
| **Maps are the only record** | One way to group data, not two — fewer concepts before you're productive | No structs/methods/shape-checking |
| **Named tasks are top-level; closures are lambdas** | "What can call what" stays obvious — a `task` statement in a block is a clear error, never a silent no-op | To capture surrounding locals you reach for an anonymous `task(x): …` lambda |
| **One clear error at a time** (dynamic typing) | A beginner gets one fixable message, not a cascade or a type-checker to satisfy before running | No batch diagnostics; type mistakes surface at runtime (wrap risky work in `try:` / `caught:`) |
| **`system.run` gated behind `use system`** | Shell access is explicit and never ambient; `--sandbox` removes it entirely for hosting untrusted code | It's still real OS power once you opt in |
| **Namespaced modules + `private` default** | Predictable, scales, no hidden global sharing | More to type across files (`module.name`) |
| **Block scope + strict `make`** | Loop/`when` vars can't leak; a typo'd `make` can't silently reassign | You must `set` (not re-`make`) to change a value; shadowing is allowed |
| **Own keywords** (`make`/`show`/`task`) | Readable out loud for first-timers | Unfamiliar to experienced devs; not C/JS-like |
| **Indentation blocks** (Python-style) | Clean, no `{}`/`;` noise | Tabs-vs-spaces and copy-paste pitfalls |

## Roadmap

I grew the core back slice by slice, then **froze it at v0.1.0** — the milestone meant to
hold. Here's the path I took, and what I've shipped since the freeze:

1. ✅ **Core** — variables, math, text, `when`, `repeat`
2. ✅ **Tasks** — `task` / `give`, function calls, recursion, scope
3. ✅ **Collections** — lists `[...]`, maps `{...}`, indexing, `for each`, `range`
4. ✅ **Superpowers & tooling** — math/text toolbox, files, web (`get` / `json` / `explore`), `run`, `color`, templates, `sprout api`
5. ✅ **Projects & modules** — `sprout.toml`, `use`, `public`/`private`, `sprout new`, `sprout build`
6. ✅ **f-strings, friendly errors & `learn` mode** — `f"Hi {name}"`, "did you mean?", step-by-step narration
7. ✅ **Built-in testing** — `test "…": expect …` and `sprout test`
8. ✅ **Spec-complete (v0.0.13)** — every edge case decided and tested (originally called "the freeze"; it held one version — see the note in the Language reference).
9. ✅ **Base-completion (v0.0.14–v0.0.16)** — the cycle's slices: `stop`/`skip`, compound assignment (`+=` …), the missing list/map/text builtins (`remove` `insert` `sort` `reverse` `index_of` `values` `pow` `starts_with` `ends_with`), **error handling** (`try` / `caught` / `fail` with a structured error map `{message, kind, line}` and a hard/soft split so typos aren't swallowed), and SEH-free error unwinding on Windows.
10. ✅ **Freeze-prep (v0.0.17)** — pinned the observable contracts a freeze must guarantee: lists/maps are shared references + `copy()` for a deep snapshot, the mutate-vs-return convention, the stable error-`kind` table, and the number-edge rules — all documented + tested (`tests/contracts.sprout`); CI now also gates the `test`/`expect` framework, not just guarded scripts.
11. ✅ **Ergonomics (v0.0.18)** — `expect error`, `for each key, value`, the `in` operator, `or else` (nothing-coalescing), `kind_of`, scientific-notation literals, and `learn` mode narrating control flow.
12. ✅ **Persistence (v0.0.19)** — `remember` / `recall` / `forget`: a key/value store that survives between runs (JSON in `sprout.data.json`), with a built-in JSON writer.
13. ✅ **First-class tasks (v0.0.20)** — a task is a value you can store, pass, return, and call, plus the higher-order builtins `map` / `filter` / `reduce`.
14. ✅ **Standard-library batch (v0.0.21)** — `sum` `count` `unique` `zip` `flatten` `slice` (lists/text), `words` `lines` `title` (text), and `seed` (reproducible `random`).
15. ✅ **Lambdas + closures (v0.0.24)** — anonymous inline tasks (`task(x): x * 2`, one-line body is an implicit `give`) that capture the surrounding variables; each evaluation captures fresh, capture is by-reference.
16. ✅ **Ranges + comprehensions (v0.0.25)** — `a to b` inclusive ranges (counts up or down) and one-line list comprehensions `[expr for each x in xs when cond]` over lists, ranges, text, or maps.
17. ✅ **Pattern matching (v0.0.26)** — `match value:` with `is <pattern>:` arms (value/literal, list-destructure `[a, b]`, map-destructure `{name, age}`) and `otherwise`.
18. ✅ **Pipe operator (v0.0.27)** — `x |> f` is `f(x)` and `x |> f(a)` is `f(x, a)`; left-associative, so `data |> filter(is_even) |> map(double) |> sum` reads top to bottom.
19. ✅ **Multi-line literals (v0.0.28)** — lists, maps, and call arguments may span multiple lines (newlines inside `( ) [ ] { }` are ignored), with an optional trailing comma.
20. ✅ **Dogfooding + faster maps (v0.0.29–v0.0.30)** — an `examples/` gallery of real programs (run by CI), `sort_by`, and an O(n²)→O(n) hash index for maps.
21. ✅ **The freeze — v0.1.0** — a conservative mark-sweep garbage collector and more examples; the core stops moving.
22. ✅ **`--sandbox` + Docker playground (v0.1.1–v0.1.2)** — run untrusted code safely (no files, shell, or network), plus a one-command, hardened web playground.
23. ✅ **String GC (v0.1.3)** — heap strings join the collector; the runtime no longer leaks.

The language now does what I set out to do, so what's next is about **reach, not patching holes:**

- **A bytecode VM**, eventually — the same language, just faster for tight loops. It's a big rewrite, so I'll take it slowly and keep it behind the exact syntax you already know.
- **A simple way to share modules** (packaging + versioning) — once enough real programs have shown me the shape it should take.
- **More real programs, not more syntax** — I'd rather prove the language by building with it than keep growing it.

The longer, sequenced plan lives in **[ROADMAP.md](ROADMAP.md)**. I run an adversarial review over every release before it ships, and write down what each one fixed in the [release notes](https://github.com/fizzexual/Sprout/releases).

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
- **Memory** — a conservative mark-sweep **garbage collector** reclaims lists, maps,
  environments, closures, and strings. It finds roots by scanning the C stack (plus a few
  precise globals), so it can never free a value that's still in use. Recursion runs on a
  64 MB stack with a call-depth guard.
- **Built-ins, from scratch** — JSON is a hand-written parser; HTTP uses the OS
  (`urlmon` on Windows); shell via `popen`. No third-party libraries.

Full tour: [`src/README.md`](src/README.md) and **[How Sprout Works](wiki/architecture.md)**.
There's a **[VS Code extension](vscode-extension)** for syntax highlighting too.

> Sprout previously had a TypeScript-on-Node implementation with a GUI, a
> compile-to-JavaScript engine, and libraries. That has been retired so the
> language can stand entirely on its own in C — it lives on in the git history.

---

<p align="center"><sub>A real language, built from scratch — one slice at a time. 🌱</sub></p>
