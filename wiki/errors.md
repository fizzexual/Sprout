# Errors: try / caught / fail

How Sprout handles things going wrong — run a risky step, catch the problem, and
keep going (or raise your own). A caught error is just a **map**, so you read it
with `["message"]`, `["kind"]`, and `["line"]` like any other map.

## On this page

- [The shape of the page](#the-shape-of-the-page)
- [`try:` / `caught e:` — run a risky step, catch a soft error](#try--caught-e--run-a-risky-step-catch-a-soft-error)
- [The caught value is a map: `{message, kind, line}`](#the-caught-value-is-a-map-message-kind-line)
- [`fail` — raise your own error](#fail--raise-your-own-error)
- [Branching on `kind`](#branching-on-kind)
- [The full error-kind table](#the-full-error-kind-table)
- [Hard vs soft errors (typos are uncatchable on purpose)](#hard-vs-soft-errors-typos-are-uncatchable-on-purpose)
- [`give` / `stop` / `skip` pass through `try`](#give--stop--skip-pass-through-try)
- [Nesting and re-raising](#nesting-and-re-raising)
- [`expect error` (in tests)](#expect-error-in-tests)
- [`or else` is *not* error handling](#or-else-is-not-error-handling)
- [Patterns & gotchas](#patterns--gotchas)

---

## The shape of the page

Every complete program below was run with the real interpreter, and the second
code block is its **actual** output. Try them yourself:

```
sprout run yourfile.sprout
```

---

## `try:` / `caught e:` — run a risky step, catch a soft error

`try:` runs a block. If a step inside fails, Sprout **stops that block** and jumps
straight to the matching `caught:` block instead of aborting the whole program. The
`caught:` block is **required** — a `try:` without one is a parse error.

```sprout
try:
    show 10 / 0
caught problem:
    show "couldn't do that, but we recovered"
show "the program keeps going"
```

```
couldn't do that, but we recovered
the program keeps going
```

The name after `caught` is **yours to choose** — `caught problem:`, `caught e:`,
`caught oops:`, anything. It binds the error so you can inspect it. If you don't
need the details, use a **bare `caught:`** with no name:

```sprout
try:
    show "risky" + (1 / 0)
caught:
    show "something went wrong, but we recovered"
show "carrying on"
```

```
something went wrong, but we recovered
carrying on
```

> The whole point: a wrapped step **never crashes the run**. Without `try`, the
> first error stops the program (see [hard vs soft](#hard-vs-soft-errors-typos-are-uncatchable-on-purpose)).

---

## The caught value is a map: `{message, kind, line}`

The error you catch is an ordinary **map** with three standard keys:

| key | type | what it is |
| --- | --- | --- |
| `message` | text | a plain-English description of what went wrong |
| `kind` | text | a stable category you can branch on (see the [table](#the-full-error-kind-table)) |
| `line` | number | the source line where it happened |

`show` the whole thing to see it:

```sprout
try:
    show 10 / 0
caught problem:
    show problem
```

```
{message: you tried to divide by zero., kind: math, line: 2}
```

Read the fields with `["..."]`, just like any [map](collections.md):

```sprout
try:
    make xs = [10, 20]
    show xs[99]
caught e:
    show "message: " + e["message"]
    show "kind:    " + e["kind"]
    show "line:    " + e["line"]
```

```
message: that position doesn't exist in the list (positions start at 0; for the end use last(...)).
kind:    index
line:    3
```

(The `message` text is meant for humans and may improve between versions — branch on
`kind`, not on the exact words of `message`.)

---

## `fail` — raise your own error

You raise your own error with `fail`. The most common form is a message:

```sprout
task checkout(cart):
    when length(cart) == 0:
        fail "your cart is empty"
    show "checking out " + length(cart) + " items"

try:
    checkout([])
caught e:
    show e["kind"] + ": " + e["message"]
```

```
fail: your cart is empty
```

A `fail "message"` always gets the kind **`"fail"`** — that's how a caught error
tells "your own error" apart from a built-in one.

A **bare `fail`** (no message) uses a default:

```sprout
try:
    fail
caught e:
    show e
```

```
{message: the program stopped with 'fail'., kind: fail, line: 2}
```

### `fail` with a map — carry structured detail

`fail` can also carry a **whole map**, which is caught intact. This lets a library
(or the web `kind`) attach its own fields and its own `kind`:

```sprout
try:
    fail {kind: "http", status: 404, message: "Not found"}
caught e:
    show e
    show "kind is " + e["kind"]
    show "status is " + e["status"]
```

```
{kind: http, status: 404, message: Not found, line: 2}
kind is http
status is 404
```

Notice two things:

- A map's own `kind` **wins** — here the caught error is `"http"`, not `"fail"`. So
  you're free to define your own kinds for your own errors.
- Any **missing standard keys are filled in** with defaults. A map with no `message`
  and no `kind` still comes out with all three standard keys (`line` is always added):

```sprout
try:
    fail {code: 1}
caught e:
    show e
```

```
{code: 1, message: (no message), kind: fail, line: 2}
```

---

## Branching on `kind`

Because `kind` is a small, stable set of strings, you can react differently to
different problems with [`when` / `otherwise`](control-flow.md) or [`match`](pattern-matching.md):

```sprout
task safe_divide(a, b):
    try:
        give a / b
    caught e:
        when e["kind"] == "math":
            show "can't divide " + a + " by zero"
            give nothing
        otherwise:
            fail e

show safe_divide(10, 2)
show safe_divide(10, 0)
```

```
5
can't divide 10 by zero
nothing
```

That last `fail e` re-raises anything you didn't expect — see
[nesting and re-raising](#nesting-and-re-raising).

A realistic input-validation loop, raising a couple of different errors and
recovering per item:

```sprout
task to_age(text):
    make n = number(text)
    when n == nothing:
        fail "not a number: " + text
    when n < 0:
        fail {kind: "range", message: "age can't be negative"}
    give n

for each input in ["33", "oops", "-4"]:
    try:
        show input + " -> age " + to_age(input)
    caught e:
        show input + " -> rejected (" + e["kind"] + "): " + e["message"]
```

```
33 -> age 33
oops -> rejected (fail): not a number: oops
-4 -> rejected (range): age can't be negative
```

---

## The full error-kind table

A caught error's `kind` is **one of these exact strings**. They're stable as of
v0.0.15 and frozen at v0.1.0 — a library may rely on them. New kinds may be *added*
in future versions; existing ones won't be renamed or removed.

| `kind` | catchable? | what raises it |
| --- | --- | --- |
| `"math"` | yes | a number operation with no answer: divide / remainder by zero, `sqrt` of a negative |
| `"type"` | yes | a value of the **wrong kind** for an operator or `[ ]`: `yes + 5`, `-text`, `a < b` across kinds, `x in 5`, `xs["k"]`, indexing `nothing`, and list ops on mixed/non-number items (`sort([1,"a"])`, `sum([1,"a"])`) |
| `"index"` | yes | a list/text position that doesn't exist — any out-of-range **read, assign, remove, or insert** |
| `"io"` | yes | a file (or network) that can't be opened |
| `"fail"` | yes | your own `fail` (text, or a map with no `kind` of its own) |
| `"error"` | yes | the generic default for any other runtime condition — including calling a built-in with the **wrong number or shape of arguments** (like `abs("x")`) |
| `"name"` | **no — hard** | an unknown variable, task, or module (a code mistake) — see [below](#hard-vs-soft-errors-typos-are-uncatchable-on-purpose) |

Here is each catchable kind with its **real** message, all caught in one run:

```sprout
try:
    show 1 / 0
caught e:
    show "1 / 0       -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    show sqrt(-1)
caught e:
    show "sqrt(-1)    -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    show 7 % 0
caught e:
    show "7 % 0       -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    show yes + 5
caught e:
    show "yes + 5     -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    make xs = [1, 2]
    show xs[99]
caught e:
    show "xs[99]      -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    show 1 < "a"
caught e:
    show "1 < \"a\"     -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    show sort([1, "a"])
caught e:
    show "sort mixed  -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    show abs("x")
caught e:
    show "abs(\"x\")    -> kind=" + e["kind"] + "  msg=" + e["message"]
try:
    fail "boom"
caught e:
    show "fail boom   -> kind=" + e["kind"] + "  msg=" + e["message"]
```

```
1 / 0       -> kind=math  msg=you tried to divide by zero.
sqrt(-1)    -> kind=math  msg=sqrt can't take a negative number.
7 % 0       -> kind=math  msg=you tried to take a remainder with zero.
yes + 5     -> kind=type  msg=I can't add a yes/no and a different kind of value.
xs[99]      -> kind=index  msg=that position doesn't exist in the list (positions start at 0; for the end use last(...)).
1 < "a"     -> kind=type  msg=I can only compare two numbers or two pieces of text.
sort mixed  -> kind=type  msg=sort needs every item to be the same kind (all numbers, or all text).
abs("x")    -> kind=error  msg=abs needs a number.
fail boom   -> kind=fail  msg=boom
```

And the `io` kind — opening a file Sprout can't write:

```sprout
try:
    write("no_such_dir/cannot.txt", "hello")
caught e:
    show "kind=" + e["kind"] + "  msg=" + e["message"]
```

```
kind=io  msg=I couldn't open that file to write.
```

### A few `kind` rules worth pinning down

- **`type` vs `index`.** *Wrong kind of value* is `type` (`xs["k"]`, `xs[1.5]`,
  `m[0]` where `m` is a map). *Right kind, out of range* is `index` (`xs[99]`,
  `"hi"[99]`, `remove(xs, 99)`, `insert(xs, 99, 0)`). Out-of-range is **always**
  `index`, whether you're reading, assigning, removing, or inserting.
- **`+` is not a type error with text.** Because `+` *concatenates* when either side
  is text, `"a" + 1` is `"a1"`, not an error. (`yes + 5` *is* a `type` error — neither
  side is text and they're different kinds.)
- **`number("abc")` is not an error.** It returns `nothing` so you can check input
  safely. See [`or else`](#or-else-is-not-error-handling).
- **Wrong-shape built-in calls are generic `"error"`,** not `type` — `abs("x")`,
  too few arguments, etc.

---

## Hard vs soft errors (typos are uncatchable on purpose)

Sprout splits errors into two tiers:

- **Soft (runtime) errors** are conditions: bad input, divide-by-zero, a missing
  file, an out-of-range index, a `fail`. These are what `try` catches.
- **Hard (code-mistake) errors** are bugs in the program text: an **unknown variable,
  task, or module** (kind `"name"`), and lexer/parser errors. These are the
  "did you mean?" diagnostics.

**`try` deliberately does *not* catch hard errors.** A hard error skips *every*
enclosing `try` and surfaces its diagnostic — so wrapping a block in `try` can never
silently swallow a typo:

```sprout
try:
    show totl
caught e:
    show "you will never see this: " + e["message"]
```

```
  Sprout error in hard.sprout (line 2): I don't know what 'totl' is.

  Did you mean 'title'?
```

The program **exits with an error** (status `1`); the `caught` block never runs. The
idea is that a misspelled name is a mistake to *fix*, not a runtime condition to
*handle* — if `try` swallowed it you'd be debugging a silent program. (Hard errors are
still contained by the system boundaries — a single test, one REPL line, or one file
run — so one bad line fails just that unit, not your whole session.)

> **In short:** `try` is for things that *can* go wrong with good code. It is not a
> safety net for typos.

---

## `give` / `stop` / `skip` pass through `try`

`give` (return from a task), and `stop` / `skip` (loop control) are **control flow,
not errors**. They pass cleanly *out through* a `try`, and the `caught` block does
**not** run for them:

```sprout
task double(x):
    try:
        give x * 2
    caught e:
        give -999

show double(21)
```

```
42
```

The `give x * 2` returns straight out of `double` — it doesn't trip the `caught`
block. The same is true of `stop` and `skip` inside a loop that sits in a `try`.

---

## Nesting and re-raising

`try` blocks **nest**. An inner `caught` handles the error; the outer one is left
untouched, and the rest of the outer `try` keeps running:

```sprout
try:
    try:
        fail "inner problem"
    caught a:
        show "inner caught: " + a["message"]
    show "outer keeps going"
caught b:
    show "outer caught (should NOT run)"
```

```
inner caught: inner problem
outer keeps going
```

To **re-raise** — handle part of an error, then let an outer handler deal with the
rest — just `fail` again from inside `caught`. You can re-raise the same error map
(`fail e`) or a new one:

```sprout
try:
    try:
        fail "first"
    caught inner:
        show "logging: " + inner["message"]
        fail "second"
caught outer:
    show "outer handled: " + outer["message"]
```

```
logging: first
outer handled: second
```

---

## `expect error` (in tests)

Inside [`test`](testing-and-learn.md) blocks you assert that something *should* fail with
`expect error`. Plain `expect error:` passes if the block raises **any** soft error;
add a kind string to require a **specific** kind:

```sprout
test "divide by zero is a math error":
    expect error "math":
        show 1 / 0

test "out of range is an index error":
    expect error "index":
        make xs = [1, 2]
        show xs[99]

test "a plain expect error catches any failure":
    expect error:
        fail "anything"

test "a fail-map keeps its custom kind":
    expect error "http":
        fail {kind: "http", status: 404, message: "Not found"}

test "normal expect still works":
    expect 2 + 2 == 4
```

Run it with `sprout test`:

```
sprout test demo_test.sprout
```

```
  demo_test.sprout
  ok  divide by zero is a math error
  ok  out of range is an index error
  ok  a plain expect error catches any failure
  ok  a fail-map keeps its custom kind
  ok  normal expect still works

  5 passed
```

`expect error "kind":` checks the **same `kind` string** you'd read off a caught
error — including a [custom kind from a `fail` map](#fail-with-a-map--carry-structured-detail), like
`"http"` above. It fails the test if the block *doesn't* raise, or raises a
*different* kind. (Plain `expect <condition>` is the ordinary assertion — see the
[testing page](testing-and-learn.md).)

---

## `or else` is *not* error handling

It's easy to reach for `try` when all you need is a **default for `nothing`**. That's
what [`or else`](syntax-basics.md) is for. `a or else b` is `a`, unless `a` is
`nothing`, in which case `b`:

```sprout
make port = number("not a port") or else 8080
show port
make name = nothing or else "anonymous"
show name
```

```
8080
anonymous
```

Use `or else` for the `nothing` that `number("x")` or a missing map key hands back.
Use `try` / `caught` for things that actually *raise* — divide-by-zero, an
out-of-range index, a `fail`, a missing file. They solve different problems:

| you want to… | use |
| --- | --- |
| supply a default when a value is `nothing` | `a or else b` |
| recover from a raised error (math/type/index/io/fail/error) | `try:` / `caught:` |
| stop the program with your own error | `fail "..."` / `fail {...}` |

---

## Patterns & gotchas

- **`caught` is required.** A `try:` with no `caught:` is a parse error — there's no
  "try and ignore."
- **Pick the name you like.** `caught e:`, `caught problem:`, `caught err:` all work;
  the binding is whatever you write. Use a bare `caught:` when you don't need the map.
- **Branch on `kind`, not `message`.** Kinds are a frozen, stable set; messages are
  human text and may be reworded.
- **A `fail` map's own `kind` wins** over the default `"fail"`, and any missing
  standard keys (`message`, `kind`, `line`) are filled in for you.
- **`line` is always present** and is a real source line number — handy for logging.
- **Re-raise with `fail e`** inside a `caught` block to pass an error you can't handle
  up to an outer `try`.
- **Typos won't be caught.** Unknown names are hard `"name"` errors that bypass every
  `try` — that's a feature, not a limitation.
- **`give` / `stop` / `skip` are not errors** — they travel through `try` without
  triggering `caught`.

---

See also: [Sprout Syntax](syntax-basics.md) · [Tasks & lambdas](tasks-and-lambdas.md) ·
[Pattern matching](pattern-matching.md) · [Testing](testing-and-learn.md) ·
[Built-in functions](builtins-reference.md) · [Cheat Sheet](cheatsheet.md)
