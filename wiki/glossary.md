# Glossary

Every Sprout word, in one place — a quick definition of each keyword, operator,
and core idea, with a tiny runnable example for the ones that benefit from one.
Each entry links to the page that explains it in depth. Skim it like a dictionary;
every program shown here was run with the real interpreter and the block under it
is its actual output.

## Contents

- [How to read this page](#how-to-read-this-page)
- [Variables: `make`, `set`](#variables-make-set)
- [Output: `show`](#output-show)
- [Branching: `when` / `orwhen` / `otherwise`](#branching-when--orwhen--otherwise)
- [Loops: `repeat` / `times` / `while`](#loops-repeat--times--while)
- [Steering loops: `stop`, `skip`](#steering-loops-stop-skip)
- [Walking collections: `for each` / `in`](#walking-collections-for-each--in)
- [Your own actions: `task`, `give`](#your-own-actions-task-give)
- [Pattern matching: `match` / `is`](#pattern-matching-match--is)
- [Errors: `try` / `caught` / `fail`](#errors-try--caught--fail)
- [Modules: `use`, `public`, `private`](#modules-use-public-private)
- [Testing: `test`, `expect`](#testing-test-expect)
- [Narration: `learn`](#narration-learn)
- [Logic words: `and`, `or`, `not`](#logic-words-and-or-not)
- [Lambda, closure, first-class task](#lambda-closure-first-class-task)
- [The pipe operator `|>`](#the-pipe-operator-)
- [Ranges: `a to b`](#ranges-a-to-b)
- [Comprehensions](#comprehensions)
- [The values: list, map, text, number, `yes`/`no`, `nothing`](#the-values-list-map-text-number-yesno-nothing)
- [Truthiness](#truthiness)
- [Scope](#scope)
- [The garbage collector (GC)](#the-garbage-collector-gc)
- [Sandbox](#sandbox)
- [The full keyword list](#the-full-keyword-list)
- [See also](#see-also)

---

## How to read this page

Each entry is **one or two lines**, in plain English, with a "→" link to the page
that covers it fully. Where a quick example helps, you'll see a small program
followed by a second block showing its **real output**. Words in `code font` are
the exact spelling Sprout expects — Sprout is case-sensitive, so `make` works and
`Make` does not.

---

## Variables: `make`, `set`

- **`make`** — introduce a *brand-new* name and give it a value. Using `make` on a
  name that already exists in the same scope is an error (it tells you to use
  `set`), so a typo can't silently overwrite something. → [syntax basics](syntax-basics.md)
- **`set`** — change a name that already exists (it searches outward to enclosing
  scopes). `set` also writes through an index — `set xs[i] = v`, `set m[key] = v`
  (a new *map key* is added with `set`, because the map itself already exists) — and
  supports compound forms `+= -= *= /= %=`. → [syntax basics](syntax-basics.md)

```sprout
make score = 0
set score = score + 10
show "score:", score
```

```text
score: 10
```

## Output: `show`

- **`show`** — print one or more values; commas put a space between them. `show`,
  `+`, and f-strings all render a value the *same* way, so what you see is
  consistent everywhere. → [syntax basics](syntax-basics.md)

## Branching: `when` / `orwhen` / `otherwise`

- **`when`** — run a block only if a condition is truthy. On its own, or with
  `orwhen`/`otherwise`. → [control flow](control-flow.md)
- **`orwhen`** — the "else-if" branch (one word, on purpose; not `else when`). Try
  the next condition if the previous `when`/`orwhen` didn't match.
- **`otherwise`** — the "else" branch: runs when nothing above it matched. A `when`
  with no matching branch and no `otherwise` simply does nothing.

```sprout
make n = 5
when n > 8:
    show "great"
orwhen n == 5:
    show "okay"
otherwise:
    show "low"
```

```text
okay
```

## Loops: `repeat` / `times` / `while`

- **`repeat`** — the loop keyword. Two shapes: a fixed count or a condition. → [control flow](control-flow.md)
- **`times`** — `repeat N times:` runs the body N times (N is truncated to a whole
  number; `0` or less runs zero times).
- **`while`** — `repeat while <cond>:` keeps looping as long as the condition stays
  truthy.

```sprout
repeat 3 times:
    show "*"
make n = 2
repeat while n > 0:
    show n
    set n = n - 1
```

```text
*
*
*
2
1
```

## Steering loops: `stop`, `skip`

- **`stop`** — end the innermost loop immediately. → [control flow](control-flow.md)
- **`skip`** — jump straight to the next turn of the innermost loop. Both are a
  parse-time error outside a loop.

```sprout
for each i in 1 to 5:
    when i == 2:
        skip
    when i == 4:
        stop
    show i
```

```text
1
3
```

## Walking collections: `for each` / `in`

- **`for each`** — loop over each item of a list, each character of text, or each
  *key* of a map (in insertion order). Two names give you more: `for each i, item`
  over a list/text binds the 0-based index and the item; `for each k, v` over a map
  binds key and value. The loop variable is fresh each turn and gone after the loop.
  → [control flow](control-flow.md)
- **`in`** — appears in two roles: it's part of `for each … in …`, and it's also the
  **membership operator** (`x in xs`) that tests a list item, a map key, or a
  substring of text. → [operators](operators.md)

```sprout
for each k, v in {a: 1, b: 2}:
    show k, "=", v
show 2 in [1, 2, 3]
```

```text
a = 1
b = 2
yes
```

## Your own actions: `task`, `give`

- **`task`** — define a named action (a function). Named tasks live at the top level
  of a file and see the file's top-level names plus their own parameters — *not* the
  caller's locals. Recursion is supported. → [tasks & lambdas](tasks-and-lambdas.md)
- **`give`** — hand a value back from a task and return. `give` with no value, or a
  task that never reaches a `give`, both return `nothing`.

```sprout
task greet(name):
    give "Hello, " + name
show greet("Sam")
```

```text
Hello, Sam
```

## Pattern matching: `match` / `is`

- **`match`** — check a value against a list of `is` arms and run the first that
  fits, with an optional `otherwise` at the end. → [pattern matching](pattern-matching.md)
- **`is`** — one arm of a `match`. It can match a **value** (`is "stop"`, compared
  with `==`), **pull a list apart** (`is [a, b]` binds the two items of a 2-item
  list), or **pull a map apart** (`is {name, age}` binds those keys). Bound names live
  only inside that arm.

```sprout
make command = "stop"
match command:
    is "start":
        show "go"
    is "stop":
        show "halt"
    otherwise:
        show "no idea"
```

```text
halt
```

## Errors: `try` / `caught` / `fail`

- **`try`** — run a block; if a step fails at runtime, jump to the matching
  `caught` block instead of stopping the program. → [errors](errors.md)
- **`caught`** — the handler that `try` jumps to (required). `caught problem:` binds
  the error to a name you choose; the error is a **map** with `message`, `kind`, and
  `line`. A bare `caught:` handles it without binding.
- **`fail`** — raise your own error: `fail "message"`, or a whole map
  (`fail {kind: "http", status: 404, message: "…"}`). `try` catches runtime
  conditions, but deliberately **not** code mistakes like a misspelled name.

```sprout
try:
    show 10 / 0
caught problem:
    show "caught:", problem["kind"], "-", problem["message"]
```

```text
caught: math - you tried to divide by zero.
```

## Modules: `use`, `public`, `private`

- **`use`** — import another file as a module (`use server`), then reach its public
  members with a single dot (`server.start()`). `use system` is the built-in OS
  module. → [modules & projects](modules-and-projects.md)
- **`public`** — mark a `task` or `make` so other files can reach it through the
  module name.
- **`private`** — file-local (the default), callable bare within the file only. The
  keyword is allowed for emphasis but optional, since private is already the default.

```sprout
~ greeter.sprout
public task greet(name):
    give "Hi, " + name
~ app.sprout (uses it)
~   use greeter
~   show greeter.greet("world")   ->  Hi, world
```

## Testing: `test`, `expect`

- **`test`** — a named block of checks, run by `sprout test`. → [testing](testing-and-learn.md)
- **`expect`** — assert that something is truthy (`expect double(2) == 4`). The form
  `expect error "kind":` asserts that the indented block *fails* with that error
  kind. → [testing](testing-and-learn.md)

```sprout
task double(n):
    give n * 2
test "double works":
    expect double(2) == 4
test "dividing by zero fails":
    expect error "math":
        show 1 / 0
```

```text
  ok  double works
  ok  dividing by zero fails

  2 passed
```

## Narration: `learn`

- **`learn`** — a teaching aid. `learn on` makes Sprout narrate the value of each
  step as it runs (what each `make`/`set` did, which `when` branch ran, every loop
  turn, every task call). `learn off` turns it back off. It's a single global flag —
  the most recent one wins. → [testing & learn](testing-and-learn.md)

## Logic words: `and`, `or`, `not`

- **`and`** — true only if both sides are truthy; short-circuits, and binds *tighter*
  than `or`. → [operators](operators.md)
- **`or`** — true if either side is truthy; short-circuits. (See also the separate
  `or else` operator below.)
- **`not`** — flips a truthy value to `no` and a falsey one to `yes`.

```sprout
show yes and no
show yes or no
show not no
```

```text
no
yes
yes
```

## Lambda, closure, first-class task

- **Lambda** — an **anonymous task** written inline as a value: `task(x): x * 2`. A
  one-line body is an implicit `give`. Perfect for `map`/`filter`/`reduce`.
  → [tasks & lambdas](tasks-and-lambdas.md)
- **Closure** — a lambda *captures* the surrounding variables and keeps them alive,
  so you can build tasks that remember. Capture is by reference and fresh per
  evaluation. (Named tasks are not closures; only lambdas are.)
- **First-class task** — a task's name used without `()` is a *value* you can store,
  pass, return, and call: `make f = double` then `f(5)`. `kind_of(t)` is `"task"`.

```sprout
task adder(by):
    give task(x): x + by
make add5 = adder(5)
show add5(10)
```

```text
15
```

## The pipe operator `|>`

- **`|>`** — threads a value into a call as its *first* argument: `x |> f` is `f(x)`,
  and `x |> f(a)` is `f(x, a)`. It reads top-to-bottom instead of inside-out, and
  pairs beautifully with lambdas. → [operators](operators.md)

```sprout
make nums = [1, 2, 3, 4, 5, 6]
show nums |> filter(task(n): n % 2 == 0) |> map(task(n): n * 10) |> sum
```

```text
120
```

## Ranges: `a to b`

- **`to`** — `a to b` builds an **inclusive** list of whole numbers (`1 to 5` is
  `[1, 2, 3, 4, 5]`). If the start is past the end it's empty (`1 to 0` is `[]`), so
  `for each i in 1 to count` is safe at `count = 0`. To count down, use
  `reverse(1 to 5)`. It binds looser than arithmetic. → [collections](collections.md)

```sprout
show 1 to 5
show sum(1 to 100)
```

```text
[1, 2, 3, 4, 5]
5050
```

## Comprehensions

- **Comprehension** — build a list in one line: `[expr for each x in xs]`, with an
  optional `when` filter. It runs over a list, a range, text (its characters), or a
  map (its keys). It's just a list, so it composes with everything.
  → [collections](collections.md)

```sprout
show [n * 2 for each n in [1, 2, 3]]
show [i * i for each i in 1 to 10 when i % 2 == 0]
```

```text
[2, 4, 6]
[4, 16, 36, 64, 100]
```

## The values: list, map, text, number, `yes`/`no`, `nothing`

Sprout is dynamically typed with a small set of value kinds. `kind_of(x)` tells you
which one you have.

- **number** — one numeric type (IEEE-754 double). `5 / 2` is `2.5`; whole numbers
  print without a decimal point. → [operators](operators.md)
- **text** — UTF-8 string in double quotes; immutable, but indexable by character
  (`"café"[3]` is `"é"`). `+` joins text. → [text](text.md)
- **`yes` / `no`** — the two boolean values; they print as `yes` and `no`.
- **`nothing`** — the empty value. A missing map key, `number("abc")`, and a task
  with no `give` all produce `nothing`.
- **list** — an ordered collection: `[10, 20, 30]`, indexed from `0`.
  → [collections](collections.md)
- **map** — key/value pairs in insertion order: `{name: "Sam", age: 3}`. Maps are
  Sprout's record type (there are no classes). Keys are text. → [collections](collections.md)

> **Lists and maps are shared references.** `make b = a` does *not* copy — `a` and
> `b` are the same collection. Use `copy(x)` for an independent snapshot. Numbers,
> text, `yes`/`no`, and `nothing` are immutable value types.

```sprout
show kind_of(3), kind_of("hi"), kind_of(yes), kind_of(nothing), kind_of([1]), kind_of({a: 1})
```

```text
number text yes-no nothing list map
```

## Truthiness

- **Truthiness** — the rule for what counts as "true" in a `when`, `repeat while`,
  and `and`/`or`/`not`. **Falsey:** `no`, `nothing`, `0`, `""` (empty text), and an
  empty list or map. **Everything else is truthy.** → [control flow](control-flow.md)

```sprout
when "" or 0 or [] or nothing or no:
    show "some truthy"
otherwise:
    show "all falsey"
when "hi" and 1 and [0]:
    show "all truthy"
```

```text
all falsey
all truthy
```

## Scope

- **Scope** — the region where a name is visible. `make` creates a name in the
  current scope; each block (`when`/`repeat`/`for each` body) has its own scope, so a
  name made inside is gone when the block ends and may *shadow* an outer one. `set`
  reaches outward to change an enclosing variable. Each task call gets fresh locals
  and cannot see the caller's. → [tasks & lambdas](tasks-and-lambdas.md)

```sprout
make x = 1
when yes:
    make x = 99
    show x
show x
```

```text
99
1
```

## The garbage collector (GC)

- **The GC** — Sprout reclaims memory for you. A conservative mark-sweep collector
  frees lists, maps, captured closure environments, and strings once nothing can
  reach them, so long-running programs and closures don't leak. It's invisible: you
  never allocate or free by hand. → [architecture](architecture.md)

## Sandbox

- **Sandbox** — a safe mode for running untrusted code (e.g. an online playground).
  The `--sandbox` flag (or `SPROUT_SANDBOX=1`) turns **off** the host-facing builtins:
  files (`read`/`write`/`append`/`exists`), persistence (`remember`/`recall`/`forget`),
  network (`get`/`explore`), the `system` module, and `use` of a file. Safe builtins
  still work, and the block is a catchable error. The frozen language itself is
  unchanged. → [sandbox & playground](sandbox-and-playground.md)

```sprout
~ run with:  sprout run --sandbox file.sprout
try:
    write("hack.txt", "nope")
caught e:
    show e["kind"], "-", e["message"]
show 2 + 2
```

```text
error - 'write' is turned off in sandbox mode — file, shell, and network access are disabled here.
4
```

## The full keyword list

These 34 words are reserved — you can't use them as your own names:

```text
make set show when orwhen otherwise repeat while times task give
for each in to match is use public private learn test expect
and or not yes no nothing try caught fail stop skip
```

A few notes:

- **`else` is not reserved.** It's only meaningful right after `or` (the `or else`
  nothing-coalescing operator) — anywhere else it's an ordinary name.
- **`or else`** — `a or else b` is `a` unless `a` is `nothing`, in which case `b`
  (and `b` is only evaluated then). It's for the `nothing` that a missing map key or
  `number("x")` hands back — *not* error recovery (that's `try`/`caught`).
- **`learn on` / `learn off`** and **`expect error "kind":`** are the multi-word
  forms built from these keywords.

```sprout
make m = {a: 1}
show m["missing"] or else 42
show number("not a number") or else 0
```

```text
42
0
```

## See also

- [Getting started](getting-started.md) — install and run your first program
- [Cheat sheet](cheatsheet.md) — the whole language on one page
- [Syntax basics](syntax-basics.md) · [Control flow](control-flow.md) · [Operators](operators.md)
- [Collections](collections.md) · [Text](text.md) · [Tasks & lambdas](tasks-and-lambdas.md)
- [Pattern matching](pattern-matching.md) · [Errors](errors.md) · [Testing & learn](testing-and-learn.md)
- [Builtins reference](builtins-reference.md) — every built-in function
- [Modules & projects](modules-and-projects.md) · [Persistence](persistence.md) · [IO, web, system & time](io-web-system-time.md)
- [Sandbox & playground](sandbox-and-playground.md) · [CLI & flags](cli-and-flags.md) · [Architecture](architecture.md)
