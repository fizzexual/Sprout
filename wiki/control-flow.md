# Control flow

How Sprout decides what to do next: branching with `when` / `orwhen` /
`otherwise`, repeating with `repeat`, and steering loops with `stop` and `skip`.
Every example on this page was run with the real interpreter, and the output
block under each one is its actual output.

## Contents

- [The shape of a block: colons and indentation](#the-shape-of-a-block-colons-and-indentation)
- [Choices: `when` / `orwhen` / `otherwise`](#choices-when--orwhen--otherwise)
  - [What counts as true (truthiness)](#what-counts-as-true-truthiness)
  - [No match, no `otherwise` → nothing happens](#no-match-no-otherwise--nothing-happens)
- [Looping: `repeat`](#looping-repeat)
  - [`repeat N times` — a fixed count](#repeat-n-times--a-fixed-count)
  - [`repeat while <cond>` — keep going while true](#repeat-while-cond--keep-going-while-true)
  - [Walking a collection: `for each`](#walking-a-collection-for-each)
- [Steering a loop: `stop` and `skip`](#steering-a-loop-stop-and-skip)
- [Nesting, and which loop is "innermost"](#nesting-and-which-loop-is-innermost)
- [How `give`, `stop`, and `skip` interact with loops](#how-give-stop-and-skip-interact-with-loops)
- [Scope inside a block](#scope-inside-a-block)
- [Gotchas & edge cases](#gotchas--edge-cases)
- [See also](#see-also)

---

## The shape of a block: colons and indentation

Every control-flow construct follows the same simple shape: a header line that
ends in a **colon**, then an **indented body** underneath it.

```sprout
when ready:
    show "go"
```

A few rules that hold everywhere:

- The header line (the `when …`, `repeat …`, `for each …`) ends with `:`.
- The body is **indented more than the header**. Any consistent indent opens a
  block — 4 spaces is the convention, but the unit is whatever you pick, as long
  as you're consistent. A **tab counts as one column, same as one space**, so
  don't mix tabs and spaces or your levels won't line up.
- The block ends when the indentation comes back **out** to a previous level.
  Coming out to a level that was never used is an error.

If your dedent doesn't line up:

```sprout
when yes:
    show "a"
  show "b"
```

```
  Sprout error in misalign.sprout (line 3): the indentation doesn't line up with the block.
```

Blank lines and `~`-comment-only lines don't affect indentation, so you can space
things out freely. And inside `( )`, `[ ]`, or `{ }`, newlines and indentation
are **ignored** — a long list or call can span many lines — but that's about
*data literals*, not control flow. (More in [Sprout syntax](syntax-basics.md).)

---

## Choices: `when` / `orwhen` / `otherwise`

`when` runs its body only if a condition is true. Add `orwhen` for "else-if"
(you can stack as many as you like) and `otherwise` for the catch-all "else".
The first branch that matches runs, and the rest are skipped.

```sprout
make score = 5
when score > 8:
    show "great"
orwhen score == 5:
    show "okay"
otherwise:
    show "keep going"
```

```
okay
```

`orwhen` and `otherwise` are both optional — a bare `when` on its own is fine.
You can chain several `orwhen`s before an optional `otherwise`:

```sprout
make grade = 74
when grade >= 90:
    show "A"
orwhen grade >= 80:
    show "B"
orwhen grade >= 70:
    show "C"
otherwise:
    show "F"
```

```
C
```

> **Why `orwhen`, not `else when`?** It's one word, in keeping with Sprout's own
> vocabulary, so the else-if branch reads as a single idea. And `otherwise` (the
> else-branch of `when`) is deliberately a *different* word from `caught` (the
> catch-block of `try`) — see [error handling](errors.md) — so each reads as
> exactly one thing.

### What counts as true (truthiness)

The condition doesn't have to be a `yes`/`no`. Sprout treats these as **falsey**:
`no`, `nothing`, `0`, `""` (empty text), and an empty list or map. **Everything
else is truthy.**

```sprout
make items = []
when items:
    show "has items"
otherwise:
    show "empty list is falsey"

make name = "Sam"
when name:
    show "non-empty text is truthy"
```

```
empty list is falsey
non-empty text is truthy
```

The logical operators `and` / `or` / `not` use the same truthiness, `and` and
`or` **short-circuit**, and `and` binds tighter than `or`. Comparisons
(`== != < <= > >=`) and `in` (membership) give you `yes`/`no`. Note that
comparisons **don't chain**: write `1 < 2 and 2 < 3`, not `1 < 2 < 3`.

### No match, no `otherwise` → nothing happens

If no branch matches and there's no `otherwise`, the whole `when` simply does
nothing and execution carries on — no error.

```sprout
make temp = 3
when temp > 100:
    show "boiling"
show "done"
```

```
done
```

> Need to match a value against several shapes — a literal, a list to pull apart,
> a map with certain keys? That's what `match` is for. See
> [pattern matching](pattern-matching.md).

---

## Looping: `repeat`

There are two `repeat` forms. One repeats a fixed number of times; the other
keeps going while a condition holds. To walk the items of a collection, use
`for each`.

### `repeat N times` — a fixed count

```sprout
repeat 3 times:
    show "*"
```

```
*
*
*
```

The count can be any expression. A few rules worth knowing:

- A **count of 0 or less runs the body 0 times** — no surprise infinite loop, no
  negative weirdness.
- A **fractional count is truncated to a whole number** — `3.9 times` runs 3
  times.

```sprout
show "zero:"
repeat 0 times:
    show "never"
show "negative:"
repeat (0 - 2) times:
    show "never either"
show "fraction 3.9 -> 3 turns:"
repeat 3.9 times:
    show "tick"
```

```
zero:
negative:
fraction 3.9 -> 3 turns:
tick
tick
tick
```

`repeat N times` doesn't give you the turn number. When you need a counter, loop
over a range — `for each i in 1 to N` — or keep your own `make i = 0` and
`set i += 1`.

### `repeat while <cond>` — keep going while true

This re-checks the condition before each turn and stops as soon as it's false
(using the same [truthiness](#what-counts-as-true-truthiness) as `when`).

```sprout
make n = 3
repeat while n > 0:
    show n
    set n = n - 1
```

```
3
2
1
```

The body is responsible for eventually making the condition false (here,
`set n = n - 1`). If it never does, the loop runs forever — use `stop` to break
out on a condition (see below), or rethink the exit condition.

### Walking a collection: `for each`

`for each` is the everyday loop: it walks a list's items, a range's numbers, a
map's keys, or a text's characters. It pairs perfectly with an inclusive range
(`a to b`):

```sprout
for each n in 1 to 3:
    show n
```

You can also bind **two** names. Over a list or text you get
`for each index, item` (0-based index); over a map you get
`for each key, value`:

```sprout
for each i, fruit in ["apple", "pear", "plum"]:
    show f"{i}: {fruit}"
```

```
0: apple
1: pear
2: plum
```

The loop variable is **scoped to the loop body** — each turn gets a fresh one,
and it doesn't exist after the loop ends. (`for each`, ranges, and maps have
their own deep dives — see [Sprout syntax](syntax-basics.md) and
[builtins](builtins-reference.md) for `range`.)

---

## Steering a loop: `stop` and `skip`

Inside any `repeat` or `for each` body:

- **`stop`** ends the loop **immediately** — no more turns.
- **`skip`** jumps straight to the **next turn**, skipping the rest of the
  current one.

`stop` lets you bail out of a `repeat while yes:` once you've found what you want:

```sprout
make i = 0
repeat while yes:
    set i = i + 1
    when i == 3:
        stop
    show i
show "stopped after", i
```

```
1
2
stopped after 3
```

`skip` filters out turns you don't care about — here, the even numbers:

```sprout
for each n in 1 to 6:
    when n % 2 == 0:
        skip
    show n
```

```
1
3
5
```

You can use both in the same loop. This sums the even numbers but bails out the
moment it hits a number over 50:

```sprout
make total = 0
for each n in [3, 7, 2, 99, 5, 8]:
    when n > 50:
        stop
    when n % 2 == 1:
        skip
    set total += n
show "sum of evens before the first big number:", total
```

```
sum of evens before the first big number: 2
```

(Only `2` is counted: `3` and `7` are skipped as odd, then `99` triggers `stop`
before `5` and `8` are ever reached.)

**Using `stop` or `skip` outside a loop is a parse-time error** — it's caught
before the program runs, so you can't accidentally leak loop control into
straight-line code:

```sprout
show "before"
stop
```

```
  Sprout error in stop_outside.sprout (line 2): 'stop' only works inside a loop (it ends the loop early).
```

---

## Nesting, and which loop is "innermost"

Blocks nest freely — a `when` inside a `repeat` inside a `for each`, as deep as
you like. Each level just indents one step further.

```sprout
for each n in 1 to 3:
    show f"n = {n}"
    repeat n times:
        when n == 2:
            show "  (special two)"
        otherwise:
            show "  tick"
```

```
n = 1
  tick
n = 2
  (special two)
  (special two)
n = 3
  tick
  tick
  tick
```

When loops are nested, **`stop` and `skip` only affect the innermost loop** —
the one whose body they're directly in. Here, `stop` ends the inner `col` loop
but the outer `row` loop keeps going:

```sprout
for each row in 1 to 3:
    for each col in 1 to 5:
        when col == 3:
            stop
        show f"{row},{col}"
    show "-- end of row", row
```

```
1,1
1,2
-- end of row 1
2,1
2,2
-- end of row 2
3,1
3,2
-- end of row 3
```

Each row only prints columns 1 and 2 (the inner loop `stop`s at `col == 3`), but
all three rows run — the outer loop is untouched.

---

## How `give`, `stop`, and `skip` interact with loops

Three pieces of control flow can appear inside a loop, and they do different
things:

| Keyword | What it does inside a loop |
| --- | --- |
| `skip` | Jump to the **next turn** of the innermost loop |
| `stop` | End the **innermost loop**; execution continues after it |
| `give` | Return from the **whole task** — the loop and everything around it |

`give` is *not* a loop control word — it belongs to [tasks](tasks-and-lambdas.md).
But it's handy inside a loop: it returns from the entire task the moment you find
an answer, exiting every enclosing loop at once.

```sprout
task first_even(xs):
    for each x in xs:
        when x % 2 == 0:
            give x
    give nothing

show first_even([1, 3, 8, 9, 10])
show first_even([1, 3, 5])
```

```
8
nothing
```

The first call returns `8` and never looks at `9` or `10`; the second walks the
whole list, finds nothing even, and falls through to `give nothing`.

**`give`, `stop`, and `skip` all pass cleanly *out through* a [`try`](errors.md)
block.** They're control flow, not errors, so the matching `caught` block does
**not** run for them — only a real failure jumps to `caught`. Here `skip` exits
the `try` normally, and only the divide-by-zero turn triggers `caught`:

```sprout
make total = 0
for each n in [1, 2, 0, 4]:
    try:
        when n == 0:
            skip
        set total += 10 / n
    caught problem:
        show "caught:", problem["kind"]
show "total:", total
```

```
total: 17.5
```

Wait — where's the `caught: math` line? When `n` is `0`, the `skip` fires
*before* `10 / n` is ever evaluated, so the divide-by-zero never happens. The
`try`/`caught` is there as a safety net, but `skip` takes the turn out cleanly
first. (`10/1 + 10/2 + 10/4` = `10 + 5 + 2.5` = `17.5`.)

---

## Scope inside a block

Each control-flow body has **its own scope**. A name you `make` inside a
`when` / `repeat` / `for each` body is gone when the block ends, and it may
*shadow* (temporarily hide) an outer name of the same name:

```sprout
make x = "outer"
repeat 1 times:
    make x = "inner"
    show x
show x
```

```
inner
outer
```

The inner `make x` creates a *new* `x` that lives only inside the loop body; the
outer `x` is untouched. To change an enclosing variable from inside a block, use
**`set`** (it searches outward to find the existing name) rather than `make`
(which always introduces a brand-new name and errors if the name already exists
in the same scope).

A subtle but useful detail: a `make`-free loop body (one that only `set`s or
`show`s) shares the surrounding scope, but a `make` inside the body still gets a
**fresh** binding each turn — so `make x = 5` at the top of a loop never throws
an "already made" error, and a closure built inside the loop captures *that
turn's* values correctly. (This is an internal optimization with no visible
effect; it's locked down by `src/tests/loop_scope.sprout`.)

---

## Gotchas & edge cases

- **`repeat N times` doesn't hand you the turn number.** Loop over a range
  (`for each i in 1 to N`) or keep your own counter if you need it.
- **A count ≤ 0 runs zero times; a fractional count is truncated.** `repeat 3.9
  times` runs 3 times; `repeat 0 times` and `repeat (0 - 2) times` run none.
- **`1 to 0` is the empty range,** so `for each i in 1 to count` does nothing
  when `count` is `0` — no surprise countdown. To count down, use
  `reverse(1 to n)`.
- **`stop` / `skip` only touch the innermost loop,** and using either outside a
  loop is a parse-time error.
- **`give` returns from the whole task,** not just the loop — even from inside
  nested loops and `try` blocks.
- **Block bodies have their own scope.** `make` inside a block creates a local
  that vanishes when the block ends (and can shadow an outer name); use `set` to
  reach outward and change an enclosing variable.
- **Comparisons don't chain.** `1 < 2 < 3` is a friendly error — write
  `1 < 2 and 2 < 3`.
- **`when` with no matching branch and no `otherwise` does nothing** — that's by
  design, not an error.
- **Indentation must line up.** A dedent has to return *exactly* to a previous
  level, or you get *"the indentation doesn't line up with the block."* Don't mix
  tabs and spaces.

---

## See also

- [Sprout syntax](syntax-basics.md) — the whole language, slowly
- [Pattern matching](pattern-matching.md) — `match` / `is` / `otherwise` for
  branching on a value's shape
- [Tasks and lambdas](tasks-and-lambdas.md) — `give`, parameters, scope, closures
- [Errors](errors.md) — `try` / `caught` / `fail` and how control flow passes
  through them
- [Builtins reference](builtins-reference.md) — `range`, `map`/`filter`/`reduce`,
  and the rest of the toolbox
- [Testing and learn mode](testing-and-learn.md) — `test` / `expect`, and
  `learn on` narration that walks each loop turn and branch
- [Cheat sheet](cheatsheet.md) — the whole language on one page
