# Tasks, lambdas & closures

Your own actions: how to name a task and hand a value back, how a task is itself a
**value** you can store and pass around, and how to write a quick anonymous task
(a **lambda**) that remembers the variables around it (a **closure**). Every
example on this page was run with the real interpreter, and the output block under
each one is its actual output.

## Contents

- [Named tasks: `task` and `give`](#named-tasks-task-and-give)
  - [Parameters, calling, and "no `give`"](#parameters-calling-and-no-give)
  - [Recursion](#recursion)
  - [Tasks are hoisted (call before you define)](#tasks-are-hoisted-call-before-you-define)
  - [Scope: a task sees globals + its own locals, not the caller's](#scope-a-task-sees-globals--its-own-locals-not-the-callers)
  - [A named task must be top-level](#a-named-task-must-be-top-level)
- [Tasks are first-class values](#tasks-are-first-class-values)
  - [Pass a task in, return a task out](#pass-a-task-in-return-a-task-out)
  - [Tasks in lists and maps](#tasks-in-lists-and-maps)
- [`map`, `filter`, `reduce`](#map-filter-reduce)
- [Lambdas: anonymous tasks](#lambdas-anonymous-tasks)
  - [One-line body = implicit `give`](#one-line-body--implicit-give)
  - [Multi-line lambda bodies](#multi-line-lambda-bodies)
- [Closures: lambdas that remember](#closures-lambdas-that-remember)
  - [Capture is by reference](#capture-is-by-reference)
  - [Fresh capture every evaluation](#fresh-capture-every-evaluation)
  - [Capturing inside a loop](#capturing-inside-a-loop)
  - [Returning a lambda from a task (a closure factory)](#returning-a-lambda-from-a-task-a-closure-factory)
  - [Currying: a lambda that returns a lambda](#currying-a-lambda-that-returns-a-lambda)
- [Pipes and tasks](#pipes-and-tasks)
- [`sort_by`: order records by a field](#sort_by-order-records-by-a-field)
- [Named tasks vs lambda closures — the key distinction](#named-tasks-vs-lambda-closures--the-key-distinction)
- [Gotchas & edge cases](#gotchas--edge-cases)
- [See also](#see-also)

---

## Named tasks: `task` and `give`

A `task` is a named action you write once and call by name. `give` hands a value
back to whoever called it.

```sprout
task greet(who):
    give "Hello, " + who + "!"

show greet("Sam")
```

```
Hello, Sam!
```

The header line ends in a **colon**, and the body is **indented** underneath it —
the same block shape as `when` and `repeat` (see [control flow](control-flow.md)).

### Parameters, calling, and "no `give`"

A task can take any number of inputs — or none, like `task tick():`. You call it
by writing its name with `( )` and the arguments in order.

A task with no `give`, or a `give` with no value, hands back **`nothing`**. Such a
task is usually called as a statement on its own line (for its effect, like
printing), but you can still `show` its result — you'll see `nothing`.

```sprout
task banner(text):
    show "== " + text + " =="

banner("menu")
show banner("x")
```

```
== menu ==
== x ==
nothing
```

`banner("menu")` ran for its effect. `show banner("x")` printed the banner *and*
then printed the `nothing` that `banner` handed back.

### Recursion

A task can call **itself**. Give it a base case so it stops:

```sprout
task fact(n):
    when n <= 1:
        give 1
    give n * fact(n - 1)

show "5! =", fact(5)
```

```
5! = 120
```

Runaway recursion doesn't crash Sprout — there's a fixed call-depth guard (6000
deep), and overshooting it raises a friendly error instead of a segfault.

### Tasks are hoisted (call before you define)

Named tasks are gathered up before the file runs, so order doesn't matter — you
can call one **above** where it's written:

```sprout
show twice(21)

task twice(x):
    give x + x
```

```
42
```

### Scope: a task sees globals + its own locals, not the caller's

A named task can read the file's **top-level** names plus its own **parameters and
locals**. It cannot see the caller's local variables. This keeps named calls
referentially clean — the same call with the same arguments always means the same
thing.

```sprout
make base = 100

task addbase(n):
    give n + base

show addbase(5)

task work():
    make secret = 7
    give secret * 2

show work()
```

```
105
14
```

`addbase` reaches the top-level `base`; `work`'s `secret` lives and dies inside the
call. And a name made inside one task is invisible to another:

```sprout
task inner():
    give secret + 1

task outer():
    make secret = 10
    give inner()

show outer()
```

```
  Sprout error in scope.sprout (line 2): I don't know what 'secret' is.

  Variables are made with 'make', like:
      make secret = "Sam"
```

`inner` can't peek at `outer`'s `secret` — they don't share locals. (If you want a
task to remember surrounding variables, you want a **lambda closure** — see
[below](#closures-lambdas-that-remember).)

### A named task must be top-level

A `task name(...):` statement is only allowed at the **far-left margin** of the
file. Tucking a named task inside a `when`, a loop, or another task is a parse
error:

```sprout
when yes:
    task helper(x):
        give x + 1
    show helper(2)
```

```
  Sprout error in nested_task.sprout (line 2): a task must be defined at the top level (the far-left margin), not inside another block.
```

If you need a task *inside* a block, write it as a **lambda** (an anonymous task,
which is an ordinary expression and goes anywhere a value goes).

---

## Tasks are first-class values

A task's name written **without** `( )` is a *value*. You can store it in a
variable, pass it to another task, return it, put it in a list or map, and compare
it. `kind_of` of a task is `"task"`, and a task is truthy.

```sprout
task double(n):
    give n * 2

make f = double
show f(21)
show kind_of(double)
show double == f
show double == double
```

```
42
task
yes
yes
```

`make f = double` stored the task (no call happened — there are no `( )`), and then
`f(21)` called it. Two names for the same task are equal.

### Pass a task in, return a task out

Because a task is a value, you can take one as a parameter and call it, and you can
`give` one back:

```sprout
task double(n):
    give n * 2

task apply_twice(g, x):
    give g(g(x))

show apply_twice(double, 5)

task picker(which):
    when which == "dbl":
        give double
    give double

make chosen = picker("dbl")
show chosen(8)
```

```
20
16
```

`apply_twice` was handed `double` and called it through the parameter name `g`.
`picker` *returned* a task, which we then called as `chosen(...)`.

### Tasks in lists and maps

A task value lives happily inside a collection. Pull it out into a variable, then
call **that**:

```sprout
task double(n):
    give n * 2

make ops = [double, double]
make pick = ops[0]
show pick(7)
```

```
14
```

> **One call per primary.** Sprout's grammar lets you index *or* call a plain
> name, but it doesn't chain `ops[0](7)` in one breath. Pull the task into a
> variable first (`make pick = ops[0]`) and call the variable — as above.

---

## `map`, `filter`, `reduce`

Because tasks are values, Sprout has the three classic higher-order builtins. Each
takes a list and a **task**:

- **`map(list, task)`** — a new list with `task` applied to every item.
- **`filter(list, task)`** — a new list of the items where `task` returns truthy.
- **`reduce(list, task, start)`** — folds the list to one value; the task takes
  **`(total, item)`** and returns the new running total.

```sprout
task double(n):
    give n * 2
task is_even(n):
    give n % 2 == 0
task add_up(total, n):
    give total + n

show map([1, 2, 3], double)
show filter([1, 2, 3, 4, 5, 6], is_even)
show reduce([1, 2, 3, 4], add_up, 0)
show map([], double)
show reduce([], add_up, 99)
```

```
[2, 4, 6]
[2, 4, 6]
10
[]
99
```

Over an empty list, `map`/`filter` give `[]` and `reduce` gives back the `start`
value untouched. None of the three mutates the source list — they return new
values. (For the full list of builtins, see [builtins](builtins-reference.md).)

If you call one of these with a task that takes the **wrong number of arguments**,
that's a catchable runtime error of kind `"error"`:

```sprout
task add_up(total, n):
    give total + n

try:
    show map([1, 2], add_up)
caught e:
    show "caught:", e["kind"]
```

```
caught: error
```

`map` calls its task with **one** argument per item, but `add_up` needs two — so
the call fails, and `try` catches it. (More on `try`/`caught` in [errors](errors.md).)

---

## Lambdas: anonymous tasks

A **lambda** is a task with no name, written **inline** wherever a value goes:
`task(x): x * 2`. It's the natural thing to hand to `map`/`filter`/`reduce` instead
of defining a named task first.

```sprout
make double = task(x): x * 2
show double(21)
show kind_of(double)

make nums = [1, 2, 3, 4, 5]
show map(nums, task(n): n * 2)
show filter(nums, task(n): n % 2 == 0)
show reduce(nums, task(total, n): total + n, 0)
```

```
42
task
[2, 4, 6, 8, 10]
[2, 4]
15
```

A lambda is an ordinary value — `kind_of` is still `"task"`, you can store it, pass
it, and call it exactly like a named task.

### One-line body = implicit `give`

When a lambda's body is a **single expression on the same line**, that expression
is its result — there's an **implicit `give`**. So `task(x): x * 2` returns `x * 2`
with no `give` keyword needed. You *may* write `give` explicitly, and a bare `give`
with no value hands back `nothing` (matching named tasks):

```sprout
make ignorer = task(x): give
show ignorer(99)
```

```
nothing
```

### Multi-line lambda bodies

For more than one step, drop to an indented block under the `task(...):` — now it
behaves like any named task body, with `when`/`otherwise`, locals, and explicit
`give`:

```sprout
make classify = task(v):
    when v > 0:
        give "positive"
    otherwise:
        give "non-positive"

show classify(7)
show classify(-3)
```

```
positive
non-positive
```

> **Inside a `[ ]` / `{ }` / `( )` literal, a lambda must be a one-liner.** Newlines
> are ignored inside brackets, so a multi-step block can't be detected there. If you
> need a multi-step lambda in a list, map, or call, `make` it with a name first and
> use the name. Sprout tells you this plainly if you hit it — see
> [gotchas](#gotchas--edge-cases).

To use a **builtin** as the task, wrap it in a one-line lambda (a builtin's name
isn't itself a first-class value, but a lambda around it is):

```sprout
make words_list = ["hi", "there"]
show map(words_list, task(s): upper(s))
```

```
[HI, THERE]
```

---

## Closures: lambdas that remember

Here is the one real difference between a named task and a lambda: **a lambda is a
closure.** It *captures* the variables around it where it was written and keeps them
alive, so you can build tasks that remember things.

```sprout
make factor = 10
make scale = task(x): x * factor
show scale(5)
```

```
50
```

`scale` had no `factor` parameter, yet it read `factor` from the surrounding scope.
A *named* task could not do this (it only sees globals + its own locals).

### Capture is by reference

A lambda captures the **variable**, not a snapshot of its value. If you change the
variable later, the closure sees the new value:

```sprout
make n = 1
make get_n = task(): n
set n = 99
show get_n()
```

```
99
```

`get_n` was made while `n` was `1`, but it reports `99` — it shares the live `n`.

### Fresh capture every evaluation

Every time a lambda **expression is evaluated**, it captures fresh. That's what
makes closure factories work (next section) and what keeps loop captures
independent.

### Capturing inside a loop

A lambda created inside a `for each` keeps **that turn's** value of the loop
variable — each iteration gets its own:

```sprout
make fns = []
for each i in [10, 20, 30]:
    add(fns, task(): i)

make first = fns[0]
make third = fns[2]
show first()
show third()
```

```
10
30
```

The first lambda froze `i = 10`, the third froze `i = 30` — no shared-mutable-loop
surprise.

### Returning a lambda from a task (a closure factory)

A named task can *return a lambda*, and that lambda captures the named task's
parameters. Each call builds an independent closure:

```sprout
task adder(by):
    give task(x): x + by

make add5 = adder(5)
make add100 = adder(100)
show add5(1)
show add100(1)
```

```
6
101
```

`adder(5)` and `adder(100)` produced two separate closures with their own `by` —
calling one never disturbs the other.

### Currying: a lambda that returns a lambda

Lambdas nest, so you can curry — a lambda whose body is another lambda:

```sprout
make make_add = task(a): task(b): a + b
make add3 = make_add(3)
show add3(4)
```

```
7
```

`make_add(3)` captured `a = 3` and gave back a lambda waiting for `b`.

> Captured environments are cleaned up by the garbage collector once nothing can
> reach them, so closures are safe to make freely, even in long-running programs.

---

## Pipes and tasks

The pipe operator **`|>`** threads a value into a task as its **first** argument —
`x |> f` is `f(x)`, and `x |> f(a)` is `f(x, a)`. It's left-associative, so a chain
reads top-to-bottom instead of inside-out. It pairs perfectly with tasks, lambdas,
`map`/`filter`/`reduce`, and builtins:

```sprout
make double = task(n): n * 2
make plus = task(a, b): a + b

show 21 |> double
show 5 |> plus(3)
show 3 |> double |> plus(1)
show 2 + 3 |> double

make nums = [1, 2, 3, 4, 5, 6]
show nums |> filter(task(n): n % 2 == 0) |> map(task(n): n * 10) |> sum

show "hi there" |> upper |> words
```

```
42
8
7
10
120
[HI, THERE]
```

Notice `2 + 3 |> double` is `double(5)` — pipe binds **looser** than arithmetic, so
the whole `2 + 3` flows in. The right side of a `|>` is a task or a call: a bare name
(`|> double`), a call with extra arguments (`|> plus(3)`), or a module call. (Full
details in [operators](operators.md).)

---

## `sort_by`: order records by a field

`sort` only handles a flat list of numbers or text. To order a list of **records**
(maps) by a computed key, use **`sort_by(list, task)`** — it sorts low-to-high by
whatever the task returns for each item, and it's **stable** (equal keys keep their
order). `reverse` it for high-to-low:

```sprout
make players = [
    {name: "Mo",  score: 17},
    {name: "Ada", score: 36},
    {name: "Sam", score: 22},
]
make ranked = reverse(sort_by(players, task(p): p["score"]))
for each p in ranked:
    show p["name"], p["score"]
```

```
Ada 36
Sam 22
Mo 17
```

Like `sort`, `sort_by` orders the list **in place** and returns the same list.

---

## Named tasks vs lambda closures — the key distinction

These two ways of making a task look similar but differ in two precise ways. Keep
them straight and the rest follows:

| | **Named task** (`task f(...):`) | **Lambda** (`task(...): ...`) |
| --- | --- | --- |
| Where it can appear | **Top level only** (far-left margin) | **Anywhere a value goes** (inside blocks, lists, args) |
| Has a name? | Yes — call it by name | No — it's an anonymous value (store it to reuse) |
| Hoisted? | Yes — call it before it's defined | No — it exists only once the line runs |
| Sees surrounding locals? | **No** — globals + its own params/locals only | **Yes** — it's a **closure**, capturing by reference |
| `give` | required to return a value | required in a block; **implicit** in a one-liner |

The throughline: a **named task is referentially clean** (same name, same behavior,
no hidden state from the caller), which is exactly why it's hoisted and top-level
only. A **lambda is a closure** that remembers its surroundings, which is exactly
why it's an inline value and not hoisted. Reach for a named task for the building
blocks of your program; reach for a lambda when you need a quick, surroundings-aware
function to hand to `map`/`filter`/`reduce`/`sort_by` or to build a task that
remembers.

---

## Gotchas & edge cases

- **`give` only works inside a task.** A `give` at the top level is a parse error:

  ```sprout
  give 5
  ```

  ```
    Sprout error in give_outside.sprout (line 1): 'give' only works inside a task (it hands a value back to whoever called it).
  ```

- **Calling a non-task is a friendly error.** Putting `( )` after a number, text, or
  an unknown name fails clearly:

  ```sprout
  make x = 5
  show x(3)
  ```

  ```
    Sprout error in notatask.sprout (line 2): I don't know a task or function called 'x'.
  ```

- **A multi-step lambda inside a `[ ]` / `{ }` / `( )` literal isn't allowed.** Give
  it a name first:

  ```sprout
  make ops = [
      task(v):
          when v > 0:
              give "pos"
          otherwise:
              give "neg"
  ]
  ```

  ```
    Sprout error in multiline_in_list.sprout (line 2): a one-line lambda body must be a single expression. For several steps, write the task on its own indented lines (and inside a list/map/call, give it a name first with 'make').
  ```

- **`reduce`'s task takes `(total, item)`**, in that order — `total` first. Getting
  the count of arguments wrong (e.g. a one-argument task to `map`'s two-argument
  needs, or vice versa) is the catchable `"error"` shown
  [above](#map-filter-reduce).

- **Wrong-arity is a runtime error, not a parse error** — so it's catchable with
  `try`/`caught`, and only fires when the call actually happens.

- **`learn on` narrates task calls.** With learn mode on, each call prints
  `Calling f(arg)` and then `f gave back …`, which is handy for tracing recursion.
  See [testing & learn mode](testing-and-learn.md).

---

## See also

- [Getting started](getting-started.md) — install Sprout and run your first file.
- [Sprout syntax](syntax-basics.md) — the whole language, explained slowly.
- [Control flow](control-flow.md) — `when` / `repeat` / `for each`, the block shape tasks share.
- [Operators](operators.md) — the pipe `|>`, ranges `a to b`, and the rest.
- [Builtins](builtins-reference.md) — `map`, `filter`, `reduce`, `sort_by`, and the other 60.
- [Pattern matching](pattern-matching.md) — `match` / `is`, often paired with tasks.
- [Errors](errors.md) — `try` / `caught` / `fail` and the error `kind`s.
- [Cheat sheet](cheatsheet.md) — everything on one page.
