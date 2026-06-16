# Operators & expressions

Every way to combine values in Sprout — the math, the comparisons, the logic, and
the little operators that make data read top-to-bottom. Each one comes with a tiny
program you can run and the exact output it prints.

> An **expression** is anything that produces a value: `2 + 3`, `name == "Sam"`,
> `nums |> sum`. Operators are the glue between them. This page walks every operator
> Sprout has, in plain English, and ends with a full precedence table so you never
> have to guess what binds to what.

## On this page

- [Math: `+ - * / %`](#math----)
- [Joining text with `+`](#joining-text-with-)
- [Unary minus](#unary-minus)
- [Comparing: `== != < <= > >=`](#comparing------)
- [Logic: `and` / `or` / `not`](#logic-and--or--not)
- [Truthiness — what counts as true](#truthiness--what-counts-as-true)
- [Membership: `x in xs`](#membership-x-in-xs)
- [Nothing-coalescing: `a or else b`](#nothing-coalescing-a-or-else-b)
- [The pipe: `x |> f`](#the-pipe-x--f)
- [Ranges: `a to b`](#ranges-a-to-b)
- [Grouping with `( )`](#grouping-with--)
- [Indexing with `[ ]` and member access `.`](#indexing-with---and-member-access-)
- [Precedence & associativity (the full table)](#precedence--associativity-the-full-table)
- [A worked example](#a-worked-example)
- [Gotchas at a glance](#gotchas-at-a-glance)

---

## Math: `+ - * / %`

The five arithmetic operators do what you'd expect. `*` and `/` bind tighter than
`+` and `-`, and `%` is the remainder.

```sprout
show 5 + 3
show 10 - 4
show 6 * 7
show 10 / 4
show 10 % 3
```

```
8
6
42
2.5
1
```

A few things worth knowing:

- **There's only one number type** — IEEE-754 doubles. So `10 / 4` is `2.5`, not
  `2`. Whole-number results print without a decimal point (`6`, not `6.0`).
- **`%` is the remainder, and it takes the sign of the left operand.** `(0 - 7) % 3`
  is `-1`; `7 % (0 - 3)` is `1`.

```sprout
show (0 - 7) % 3
show 7 % (0 - 3)
```

```
-1
1
```

### Divide or remainder by zero is an error

There's no `inf` or `nan` to stumble into — dividing or taking a remainder by zero
stops with a clear `math` error (one you can [catch](errors.md)).

```sprout
show 10 / 0
```

```

  Sprout error in /…/divzero.sprout (line 1): you tried to divide by zero.

```

```sprout
show 10 % 0
```

```

  Sprout error in /…/modzero.sprout (line 1): you tried to take a remainder with zero.

```

Both raise `kind` `"math"`, so you can recover from them:

```sprout
try:
    show 10 / 0
caught problem:
    show "caught:", problem["kind"], "-", problem["message"]
```

```
caught: math - you tried to divide by zero.
```

## Joining text with `+`

`+` does double duty: it adds numbers **and** joins text. The rule is simple — **if
either side is text, the result is text**, and the other side is coerced to how it
would `show`. Otherwise `+` is numeric addition.

```sprout
show "score: " + 10
show "a" + "b" + "c"
show "L=" + [1, 2, 3]
```

```
score: 10
abc
L=[1, 2, 3]
```

So `"a" + 1` is `"a1"` — never an error. (This is why mixing text and numbers with
`+` is safe, and why there's no separate "concatenate" operator to remember.)

> For pulling values into the *middle* of a sentence, an
> [f-string](syntax-basics.md) is usually nicer than a pile of `+`s:
> `f"score: {points}"`. Inside an f-string each `{...}` keeps its own operator
> meaning, so `f"{2 + 3}"` is `"5"`.

## Unary minus

A `-` in front of a value negates it. It binds tighter than the binary operators, so
`-2 + 3` is `(-2) + 3`.

```sprout
show -5
show -(2 + 3)
show -2 + 3
show 2 - -3
```

```
-5
-5
1
5
```

Unary minus only works on numbers — `-"hello"` is a `type` error:

```sprout
show -"hello"
```

```

  Sprout error in /…/unaryneg.sprout (line 1): I can only put a minus sign in front of a number.

```

## Comparing: `== != < <= > >=`

Comparisons give back `yes` or `no`.

- **`==` and `!=`** work on **any** two values and compare by *value* — they never
  crash. Two different lists with equal contents are equal; two maps are equal if
  they hold the same keys and values, **regardless of key order**. Values of
  different kinds are simply never equal (`5 == "5"` is `no`).
- **`< <= > >=`** compare **two numbers or two pieces of text** (text sorts
  alphabetically). Anything else is a `type` error.

```sprout
show 3 == 3
show 2 != 3
show 5 <= 5
show "apple" < "banana"
show 5 == "5"
show [1, 2] == [1, 2]
show {a: 1, b: 2} == {b: 2, a: 1}
```

```
yes
yes
yes
yes
no
yes
yes
```

### Comparisons don't chain

`1 < 2 < 3` looks tempting but Sprout won't let you — it's a friendly error rather
than a silent surprise. Write it with `and`:

```sprout
show 1 < 2 < 3
```

```

  Sprout error in /…/chaincmp.sprout (line 1): comparisons can't be chained - use 'and', like  a < b and b < c.

```

```sprout
show 1 < 2 and 2 < 3
```

```
yes
```

### Comparing across kinds

`< <= > >=` need both sides to be the same comparable kind:

```sprout
show 5 < "x"
```

```

  Sprout error in /…/typecmp.sprout (line 1): I can only compare two numbers or two pieces of text.

```

## Logic: `and` / `or` / `not`

`and`, `or`, and `not` combine truth values. Two things to keep in mind:

1. **The result is always `yes` or `no`** — a plain boolean. Unlike some languages,
   Sprout's `and`/`or` do **not** hand back one of the operands. `5 and 10` is
   `yes`, not `10`; `0 or "fallback"` is `yes`, not `"fallback"`. (For "use this
   value unless it's missing", reach for [`or else`](#nothing-coalescing-a-or-else-b)
   instead.)
2. **They short-circuit.** `and` stops at the first falsey side; `or` stops at the
   first truthy one. So the right side isn't evaluated when the answer is already
   decided — handy for guards like `when xs != nothing and length(xs) > 0:`.

```sprout
show yes and no
show yes or no
show not no
show 5 and 10
show 0 or "fallback"
```

```
no
yes
yes
yes
yes
```

**`and` binds tighter than `or`**, so `a or b and c` reads as `a or (b and c)`, and
`not` binds tighter than both:

```sprout
show yes or no and no
show (yes or no) and no
show not no and yes
```

```
yes
no
yes
```

(That last line is `(not no) and yes` → `yes and yes` → `yes`.)

## Truthiness — what counts as true

`when`, `repeat while`, `and`, `or`, and `not` all ask the same question: is this
value truthy? **Falsey** values are `no`, `nothing`, `0`, `""` (empty text), and an
empty list or map. **Everything else is truthy** — including non-empty text, any
non-zero number, and any non-empty collection.

```sprout
when 0:
    show "0 truthy"
otherwise:
    show "0 falsey"
when "hi":
    show "non-empty text truthy"
when []:
    show "empty list truthy"
otherwise:
    show "empty list falsey"
```

```
0 falsey
non-empty text truthy
empty list falsey
```

`not` flips truthiness into a plain `yes`/`no`:

```sprout
show not 0
show not ""
show not [1]
```

```
yes
yes
no
```

## Membership: `x in xs`

`x in xs` asks whether `x` is **in** something, and gives back `yes`/`no`. It lives
at the same level as the comparisons (and like them, it doesn't chain). What it
checks depends on the right-hand side:

- **a list** — is `x` one of the items?
- **a map** — is `x` one of the **keys**? (Not the values.)
- **text** — is `x` a substring?

```sprout
show 2 in [1, 2, 3]
show 5 in [1, 2, 3]
show "name" in {name: "Sam", age: 3}
show "Sam" in {name: "Sam"}
show "ell" in "hello"
show "z" in "hello"
```

```
yes
no
yes
no
yes
no
```

Notice line 4: `"Sam" in {name: "Sam"}` is `no`, because `in` looks at a map's
**keys**, and `"Sam"` is a *value* there.

The right side has to be a list, map, or text — `3 in 5` is an error:

```sprout
show 3 in 5
```

```

  Sprout error in /…/inmember.sprout (line 1): 'in' needs a list, a map, or text on the right (like:  x in things).

```

> `in` is also the keyword that separates the loop variable from the collection in
> `for each x in xs` — same word, different job. The operator is the one that
> appears *inside an expression* and returns `yes`/`no`.

## Nothing-coalescing: `a or else b`

`a or else b` is **`a`**, unless `a` is exactly `nothing` — in which case it's `b`.
And `b` is only evaluated when it's needed. This is the clean way to supply a default
for the `nothing` you get from `number("notanumber")`, a missing map key, or
[`recall`](builtins-reference.md) of a name that was never saved.

```sprout
show nothing or else "backup"
show 5 or else 99
show number("abc") or else 0
make m = {a: 1}
show m["missing"] or else "no key"
show "" or else "still empty wins?"
show no or else "kept"
```

```
backup
5
0
no key

no
```

Two lines are the whole point of `or else` vs `or`:

- **`"" or else ...`** prints an empty line — empty text is *not* `nothing`, so it's
  kept. (`"" or ...` would treat it as falsey.)
- **`no or else "kept"`** is `no` — `or else` only ever steps in for `nothing`,
  never for `no` or `0` or `""`.

> `or else` is **not** error recovery. If the right side could *fail* (not just be
> `nothing`), you want [`try` / `caught`](errors.md). Use `or else` for the everyday
> "give me a default when this is missing."

The word `else` is only special right after `or`. Anywhere else it's an ordinary
name you could `make` — you'll never have to escape it.

## The pipe: `x |> f`

`x |> f` is exactly `f(x)`, and `x |> f(a)` is `f(x, a)` — the left value threads in
as the **first** argument. That turns nested calls inside-out into a pipeline you
read top to bottom.

```sprout
make double = task(n): n * 2
make plus = task(a, b): a + b
show 21 |> double
show 5 |> plus(3)
show [3, 1, 2] |> sort
show "hello" |> length
show "hi there" |> upper |> words
```

```
42
8
[1, 2, 3]
5
[HI, THERE]
```

The right side has to be **a task name or a call** — `|> double`, `|> plus(3)`, or a
module call like `|> server.handle(req)`. (You can't drop a bare inline `task(...)`
lambda directly to the right of `|>`; give it a name first, as `double` above.)

Pipe binds **looser than arithmetic** and **tighter than comparisons**, so the left
of a `|>` can be a whole arithmetic expression:

```sprout
make double = task(n): n * 2
show 2 + 3 |> double
```

```
10
```

That's `double(2 + 3)` → `double(5)` → `10`.

It's left-associative, so a chain composes cleanly — every stage is just a normal
call, which is what makes data pipelines read so well:

```sprout
make nums = [1, 2, 3, 4, 5, 6]
show nums |> filter(task(n): n % 2 == 0) |> map(task(n): n * 10) |> sum
```

```
120
```

That line means `sum(map(filter(nums, …evens…), …×10…))`, just written in the order
it actually happens.

## Ranges: `a to b`

`a to b` builds an **inclusive** list of whole numbers from `a` up to `b`. `1 to 5`
is `[1, 2, 3, 4, 5]`; `3 to 3` is `[3]`. It only counts **upward** — if the start is
past the end, you get an **empty** list (no silent count-down), which is exactly what
makes `for each i in 1 to count` safe when `count` is `0`.

```sprout
show 1 to 5
show 3 to 3
show 5 to 1
show 1 to 0
show -2 to 2
```

```
[1, 2, 3, 4, 5]
[3]
[]
[]
[-2, -1, 0, 1, 2]
```

To count down, reverse an ascending range:

```sprout
show reverse(1 to 5)
```

```
[5, 4, 3, 2, 1]
```

`to` binds **looser than arithmetic**, so `1 to 3 + 1` means `1 to (3 + 1)`:

```sprout
show 1 to 3 + 1
```

```
[1, 2, 3, 4]
```

A range is just an ordinary list, so it drives loops, the toolbox, and the pipe
directly:

```sprout
show sum(1 to 100)
show length(1 to 7)
```

```
5050
7
```

> `a to b` is the human-friendly, **inclusive** sibling of the 0-based,
> end-exclusive [`range(n)` / `range(a, b)`](builtins-reference.md) builtin. Reach for `to`
> when you mean "1 through 10"; reach for `range` when you mean "0, 1, … n-1".

## Grouping with `( )`

Parentheses override precedence — the contents are evaluated first. Use them
whenever you want to be explicit instead of relying on the table below.

```sprout
make double = task(n): n * 2
show 2 + 3 * 4
show (2 + 3) * 4
show (5 |> double) + 1
show (1 to 5) |> sum
```

```
14
20
11
15
```

## Indexing with `[ ]` and member access `.`

Two more bits of syntax read like operators because they tack onto a value:

- **`x[i]`** reads an element — a list by 0-based whole number, a map by its text
  key, or text by character position. Out-of-range list/text positions raise an
  `index` error; a missing map key gives back `nothing` (so
  `m["missing"] or else …` is the idiom). Negative indices aren't allowed —
  `xs[-1]` is an error; use `last(xs)`.
- **`m.member`** reaches a `public` member of a [module](modules-and-projects.md) you've
  `use`d — `server.start()`, `config.port`. It's a **single** dot only: `a.b.c` is
  a syntax error.

```sprout
make xs = [10, 20, 30]
make person = {name: "Sam", age: 3}
show xs[0]
show person["name"]
show "hello"[1]
```

```
10
Sam
e
```

Index access binds tightest of all — `nums[0] + 1` is `(nums[0]) + 1`. For the full
rundown of reading and writing through `[ ]`, see
[lists & maps in the syntax guide](syntax-basics.md).

## Precedence & associativity (the full table)

From **loosest** (binds last) to **tightest** (binds first). This is read straight
off Sprout's grammar, so it matches what the interpreter actually does.

| Level | Operators | Associativity | Notes |
| --- | --- | --- | --- |
| 1 (loosest) | `or`, `or else` | left | `or` is logical-or; `or else` is nothing-coalescing |
| 2 | `and` | left | binds tighter than `or` |
| 3 | `==` `!=` `<` `<=` `>` `>=` `in` | **non-associative** | can't chain — `a < b < c` is an error |
| 4 | `+` `-` | left | `+` also joins text |
| 5 | `\|>` (pipe) | left | looser than `+ - * / %`, tighter than comparisons |
| 6 | `*` `/` `%` | left | |
| 7 | unary `-`, `not` | (prefix) | applies to the value on its right |
| 8 (tightest) | `x[i]` index, `f(...)` call, `m.member` | left | postfix — sticks to the value before it |

A couple of consequences that trip people up, made concrete:

- **`a or b and c`** → `a or (b and c)` (level 2 beats level 1).
- **`2 + 3 |> double`** → `double(2 + 3)` (pipe at level 5 is looser than `+`).
- **`1 to n + 1`** → `1 to (n + 1)`. (`to` sits at the comparison level — looser
  than arithmetic — so the endpoint can be any sum.)
- **`-2 * 3`** → `(-2) * 3` = `-6` (unary minus is tighter than `*`).

## A worked example

Here's a small scoreboard built almost entirely out of the operators on this page —
pipe, range, comprehension, comparison, and a `when` ladder inside a task. It's a
real program; the output below is what it actually prints.

```sprout
~ A tiny scoreboard, built entirely out of operators.
make scores = [42, 17, 88, 5, 63]

make total = scores |> sum
make average = total / length(scores)
make passed = [s for each s in scores when s >= 40]

show "total:", total
show "average:", average
show "passing scores:", passed
show "everyone passed?", length(passed) == length(scores)
show "top three places:", 1 to 3

make grade = task(s):
    when s >= 90:
        give "A"
    orwhen s >= 60:
        give "B"
    otherwise:
        give "C"

for each i, s in scores:
    show f"score {s} -> grade {grade(s)}"
```

```
total: 215
average: 43
passing scores: [42, 88, 63]
everyone passed? no
top three places: [1, 2, 3]
score 42 -> grade C
score 17 -> grade C
score 88 -> grade B
score 5 -> grade C
score 63 -> grade B
```

## Gotchas at a glance

- **`and` / `or` give back `yes`/`no`, not an operand.** Want "this value, or a
  default"? That's `or else`, and it only fills in for `nothing`.
- **`or else` ignores `no`, `0`, and `""`** — those are real values it keeps. Only
  literal `nothing` triggers the fallback.
- **`in` on a map checks keys, not values.**
- **Comparisons don't chain** — write `a < b and b < c`.
- **`+` joins text whenever either side is text**, so `"a" + 1` is `"a1"` (never an
  error). Use it deliberately, or use an f-string.
- **Divide or remainder by zero is a `math` error**, not `inf`/`nan`. Catch it with
  [`try` / `caught`](errors.md) if it might happen.
- **`%` takes the sign of the left operand** — `(0 - 7) % 3` is `-1`.
- **The right of `|>` must be a name or a call**, never a bare inline lambda — name
  the lambda first.

---

See also: [Sprout syntax](syntax-basics.md) for statements and values,
[Built-in functions](builtins-reference.md) for everything you can call,
[Errors](errors.md) for `try` / `caught` and the error `kind`s, and the
[Cheat sheet](cheatsheet.md) for the whole language on one page.
