# Lists, maps, ranges & comprehensions

Sprout's collections — ordered **lists** `[1, 2, 3]`, keyed **maps** `{name: "Sam"}`,
inclusive **ranges** `1 to 5`, and one-line **comprehensions** `[x * 2 for each x in xs]` —
plus every builtin that works on them, with a clear note on each: does it **change** the
collection, or **return** a new value?

Every program below was run with the real interpreter, and the output blocks are its
exact output.

## On this page

- [Lists](#lists)
  - [Indexing `xs[i]`](#indexing-xsi)
  - [Setting an item `set xs[i] = v`](#setting-an-item-set-xsi--v)
  - [Multi-line lists & trailing commas](#multi-line-lists--trailing-commas)
  - [Nested lists](#nested-lists)
- [Maps](#maps)
  - [Reading, writing, and missing keys](#reading-writing-and-missing-keys)
  - [Key order](#key-order)
- [Walking a collection: `for each`](#walking-a-collection-for-each)
- [Ranges: `a to b`](#ranges-a-to-b)
- [Comprehensions](#comprehensions)
- [Shared references and `copy()`](#shared-references-and-copy)
- [The builtins, and what each one returns](#the-builtins-and-what-each-one-returns)
  - [Change a list (mutate)](#change-a-list-mutate)
  - [Look inside (return a value)](#look-inside-return-a-value)
  - [Order a list (mutate, in place)](#order-a-list-mutate-in-place)
  - [Build a new collection (return new)](#build-a-new-collection-return-new)
  - [Reduce to one value (return new)](#reduce-to-one-value-return-new)
  - [Higher-order: `map` / `filter` / `reduce`](#higher-order-map--filter--reduce)
- [Putting it together](#putting-it-together)
- [Quick reference](#quick-reference)

---

## Lists

A **list** holds values in order. Write it with square brackets, values separated by
commas. Positions start at **0**.

```sprout
make xs = [10, 20, 30]
show xs
show xs[0], xs[2]
show length(xs)
```

```text
[10, 20, 30]
10 30
3
```

A list can hold any mix of values — numbers, text, `yes`/`no`, `nothing`, other lists,
maps, even [tasks](tasks-and-lambdas.md). There's no fixed size: you grow it with
[`add`](#change-a-list-mutate).

### Indexing `xs[i]`

`xs[i]` reads the item at position `i` — **0-based**, so the first item is `xs[0]`.

Indexing is **non-negative**, and a list **never auto-grows**. Reading a position that
doesn't exist is an `index` error (it doesn't quietly give back `nothing`). There's no
`xs[-1]` — use [`last(xs)`](#look-inside-return-a-value) for the end.

```sprout
make xs = [10, 20, 30]
try:
    show xs[5]
caught e:
    show e["kind"], "-", e["message"]
try:
    show xs[-1]
caught e:
    show e["kind"], "-", e["message"]
```

```text
index - that position doesn't exist in the list (positions start at 0; for the end use last(...)).
index - that position doesn't exist in the list (positions start at 0; for the end use last(...)).
```

(See [errors](errors.md) for how `try` / `caught` and the error `kind`s work.)

### Setting an item `set xs[i] = v`

`set xs[i] = v` overwrites an item — but the position must **already exist**. Lists
don't stretch to fill a gap, so writing past the end is an `index` error too. To grow a
list, use [`add`](#change-a-list-mutate). (Note: this is `set`, not `make` — you're
changing the list that already exists, not introducing a new name.)

```sprout
make xs = [10, 20, 30]
set xs[1] = 99
show xs
try:
    set xs[9] = 1
caught e:
    show e["kind"], "-", e["message"]
```

```text
[10, 99, 30]
index - that position doesn't exist in the list.
```

Compound assignment writes through an index too: `set xs[i] += 1` is `set xs[i] = xs[i] + 1`
(again, the position must already exist).

### Multi-line lists & trailing commas

Inside `[ ]`, newlines and indentation are ignored, so a list can span as many lines as
you like — and a **trailing comma** is fine. This makes long lists tidy and easy to
reorder.

```sprout
make multi = [
    1,
    2,
    3,
]
show multi
```

```text
[1, 2, 3]
```

(The same is true inside `{ }` and `( )` — see [syntax basics](syntax-basics.md).)

### Nested lists

Lists hold lists. Chain the brackets to reach inside.

```sprout
make grid = [[1, 2], [3, 4]]
show grid[1][0]
```

```text
3
```

---

## Maps

A **map** pairs **keys** with **values**. Keys are **text**; a bare identifier key is
shorthand for its text, so `{name: "Sam"}` has the key `"name"` (keys are *never* read as
variables). Sprout has no separate "struct" or "object" type — **a map is the record
type**.

```sprout
make person = {name: "Sam", age: 3}
show person
show person["name"]
```

```text
{name: Sam, age: 3}
Sam
```

### Reading, writing, and missing keys

Look a value up with `m[key]`. Writing is `set m[key] = v` — and unlike a list, this
**inserts** the key if it's missing (the map already exists; you're changing it, so it's
`set`, not `make`). A **missing key reads as `nothing`** — never an error — which pairs
perfectly with [`or else`](operators.md) for defaults.

```sprout
make person = {name: "Sam", age: 3}
set person["age"] = 4
show person["age"]
set person["city"] = "Reef"
show person
show person["missing"]
show length(person)
show keys(person)
show values(person)
show contains(person, "name"), contains(person, "nope")
```

```text
4
{name: Sam, age: 4, city: Reef}
nothing
3
[name, age, city]
[Sam, 4, Reef]
yes no
```

A quick tour of the map helpers shown above:

- `m[key]` — the value, or `nothing` if the key is absent.
- `length(m)` — how many keys.
- `keys(m)` / `values(m)` — lists, in insertion order.
- `contains(m, key)` — `yes` / `no`, testing the **keys** (not the values).

### Key order

Maps remember **insertion order**, and that's the order `keys`, `values`, and `for each`
walk them. Overwriting an existing key keeps its place. `remove`-ing a key then setting it
again puts it at the **back**. (Order is for iteration only — two maps with the same pairs
in a different order are still equal.)

---

## Walking a collection: `for each`

`for each x in xs` runs the body once per item, with `x` bound to each value. Over a
**map** it yields the **keys**; over **text** it yields the characters. The loop variable
is fresh each turn and gone after the loop.

Bind **two** names to get more:

- over a **map**: `for each key, value in m`
- over a **list** or **text**: `for each index, item in xs` (index is 0-based)

```sprout
for each n in [10, 20, 30]:
    show n
show "---"
make scores = {ada: 90, mo: 72}
for each key in scores:
    show key
show "---"
for each key, value in scores:
    show key, "=>", value
show "---"
for each i, item in ["a", "b", "c"]:
    show i, item
show "---"
for each ch in "hi":
    show ch
```

```text
10
20
30
---
ada
mo
---
ada => 90
mo => 72
---
0 a
1 b
2 c
---
h
i
```

For counting loops and the rest of the loop family (`repeat`, `while`, `stop`, `skip`),
see [control flow](control-flow.md).

---

## Ranges: `a to b`

`a to b` is an **inclusive** range of whole numbers — both ends included. A range is an
ordinary list, so it drives loops and the whole toolbox.

The one rule worth remembering: if the start is **past** the end, the range is **empty**
(it never silently counts down). So `for each i in 1 to count` does nothing when `count`
is `0` — no surprise. To count **down**, wrap it in [`reverse`](#order-a-list-mutate-in-place).
`to` binds looser than `+ - * /`, so `1 to n + 1` means `1 to (n + 1)`.

```sprout
show 1 to 5
show 3 to 3
show 5 to 1
show -2 to 2
show reverse(1 to 5)
make n = 4
show 1 to n + 1
make total = 0
for each i in 1 to 10:
    set total += i
show total
show sum(1 to 100)
show length(1 to 7)
show range(3)
show range(2, 5)
```

```text
[1, 2, 3, 4, 5]
[3]
[]
[-2, -1, 0, 1, 2]
[5, 4, 3, 2, 1]
[1, 2, 3, 4, 5]
55
5050
7
[0, 1, 2]
[2, 3, 4]
```

> **`a to b` vs `range(...)`.** `a to b` is the human-friendly, **inclusive** one
> (`1 to 5` → `[1, 2, 3, 4, 5]`). The [`range`](#look-inside-return-a-value) builtin is
> **0-based and end-exclusive**: `range(3)` → `[0, 1, 2]` and `range(2, 5)` → `[2, 3, 4]`.
> Reach for `to` when you mean "from a to b inclusive"; reach for `range` when you mean
> "n items starting at 0".

---

## Comprehensions

A **list comprehension** builds a list in one line:
`[expr for each x in xs]`, with an optional **`when`** filter. It works over anything
`for each` does — a **list**, a **range**, **text** (its characters), or a **map** (its
keys).

```sprout
make nums = [1, 2, 3, 4, 5, 6]
show [x * 2 for each x in nums]
show [x for each x in nums when x % 2 == 0]
show [x * x for each x in nums when x > 3]
show [upper(c) for each c in "abc"]
show [k for each k in {a: 1, b: 2}]
show [x for each x in nums when x > 100]
show [i * i for each i in 1 to 5]
show sum([n for each n in 1 to 10 when n % 3 == 0])
```

```text
[2, 4, 6, 8, 10, 12]
[2, 4, 6]
[16, 25, 36]
[A, B, C]
[a, b]
[]
[1, 4, 9, 16, 25]
18
```

The loop variable (`x`, `c`, `k`, `i`) is scoped to the comprehension and doesn't leak. A
comprehension *is* just a list, so it composes with everything — `sum([...])`, `map`, a
[lambda](tasks-and-lambdas.md) inside, you name it.

---

## Shared references and `copy()`

This is the most important rule on the page, so read it twice.

**Lists and maps are shared references.** `make b = a` does **not** copy — `a` and `b` are
the *same* list (or map). Change one, you've changed the other. Passing a list into a task
hands over the same list, so the task can change the caller's. (Numbers, text, `yes`/`no`,
and `nothing` are value types — only lists and maps are shared.)

When you need an **independent snapshot**, use `copy(x)` — a **deep** copy, so later
changes to the original never touch it.

```sprout
make a = [1, 2]
make b = a
add(b, 3)
show a
make m = {x: 1}
make n = m
set n["y"] = 2
show m
make orig = [1, 2, 3]
make snap = copy(orig)
add(orig, 4)
show snap
show orig
make deep = {nums: [1, 2], name: "Sam"}
make dcopy = copy(deep)
add(deep["nums"], 9)
show dcopy["nums"]
```

```text
[1, 2, 3]
{x: 1, y: 2}
[1, 2, 3]
[1, 2, 3, 4]
[1, 2]
```

Note the last line: `dcopy["nums"]` is still `[1, 2]` even though we changed the original's
nested list — that's what "deep" buys you. (`copy` of a number, text, etc. just gives the
value back.)

Equality is by **value**, not identity: two different lists with the same contents are
equal, and `5 == "5"` is just `no` — never a crash.

---

## The builtins, and what each one returns

The single thing to keep straight: **does the builtin change the collection, or return a
new value?** Sprout is consistent about it.

- **Mutating builtins** (`add`, `insert`, `remove`, `sort`, `sort_by`, `reverse`) change
  the list/map in place. `add`/`insert` return `nothing` (they're commands). `remove`
  returns the **removed item**. `sort`/`sort_by`/`reverse` return the **same** list (a
  reference, so `show sort(xs)` prints it *and* `xs` is now sorted).
- **Builders** (`sum`, `count`, `unique`, `zip`, `flatten`, `slice`, `keys`, `values`,
  `range`, `map`, `filter`, `reduce`, `copy`) never touch their input — they hand back a
  **new** value.

### Change a list (mutate)

`add(list, x)` appends `x`. `insert(list, pos, x)` inserts at a position. `remove(list, i)`
removes by index (and returns the removed item); `remove(map, key)` removes by key (and
returns its value, or `nothing` if the key was absent).

```sprout
make xs = [1, 2, 3]
show add(xs, 4)
show xs
show insert(xs, 0, 0)
show xs
show remove(xs, 0)
show xs
make m = {a: 1, b: 2}
show remove(m, "a")
show m
show remove(m, "zzz")
```

```text
nothing
[1, 2, 3, 4]
nothing
[0, 1, 2, 3, 4]
0
[1, 2, 3, 4]
1
{b: 2}
nothing
```

> **Heads up: there is no list `append`.** "Add to the end of a list" is **`add`**.
> The builtin `append` is for **files** (`append("notes.txt", text)` — see
> [builtins reference](builtins-reference.md)). Reach for `add`, not `append`, on a list.

`insert` past the end is an `index` error (the position must be `0` to the list's length):

```sprout
try:
    show insert([1, 2, 3], 9, 0)
caught e:
    show e["kind"], "-", e["message"]
```

```text
index - that insert position is out of range (0 to the list's length).
```

### Look inside (return a value)

| Call | Gives back | Notes |
| --- | --- | --- |
| `length(coll)` | item count | works on lists, maps, and text |
| `first(list)` / `last(list)` | the end items | **error** on an empty list |
| `keys(map)` / `values(map)` | lists | in insertion order |
| `contains(coll, x)` | `yes` / `no` | list item, map **key**, or text substring |
| `index_of(coll, x)` | the position | `nothing` if not found (not `-1`) |
| `count(list, value)` / `count(text, piece)` | how many | overlapping-safe for text |
| `range(n)` / `range(a, b)` | a list | `0..n-1` / `a..b-1`, **end-exclusive** |
| `min(...)` / `max(...)` | smallest / largest | takes numbers as **separate args** |

```sprout
make xs = [1, 2, 3, 4]
show first([10, 20, 30]), last([10, 20, 30])
show length([1, 2, 3]), length({a: 1}), length("hi")
show keys({a: 1, b: 2}), values({a: 1, b: 2})
show contains([1, 2, 3], 2), contains([1, 2, 3], 9)
show contains({a: 1}, "a"), contains("hello", "ell")
show index_of([10, 20, 30], 20), index_of([10, 20, 30], 99)
show index_of("hello", "l")
show count([1, 2, 2, 3, 2], 2), count("banana", "a")
show min(3, 9, 5), max(3, 9, 5)
```

```text
10 30
3 1 2
[a, b] [1, 2]
yes no
yes yes
1 nothing
2
3 3
3 9
```

Two gotchas worth pinning:

- **`first([])` / `last([])` error** (kind `"error"`) rather than silently returning
  `nothing` — so a beginner sees the cause:

  ```sprout
  try:
      show first([])
  caught e:
      show e["kind"], "-", e["message"]
  ```

  ```text
  error - first() needs a list with at least one item (this list is empty).
  ```

- **`min`/`max` take numbers as separate arguments** — `min(3, 1, 2)`, not `min([3, 1, 2])`.
  Handing them a list is a `type` error. To get the smallest of a list, use `reduce` or
  spread the items yourself.

### Order a list (mutate, in place)

`sort` orders a flat list of numbers, or a flat list of text. `sort_by(list, task)` orders
a list of **records** (or anything) low-to-high by whatever the task returns for each item,
and it's **stable** (equal keys keep their order). `reverse` flips a list. All three change
the list **in place** and return the **same** list — so `reverse(sort_by(...))` reads as
"sort, then flip" and is the idiom for descending order.

```sprout
show sort([3, 1, 2])
show sort(["cat", "ant", "bee"])
make people = [{name: "Ada", age: 36}, {name: "Mo", age: 17}, {name: "Sam", age: 52}]
make by_age = sort_by(people, task(p): p["age"])
show map(by_age, task(p): p["name"])
show reverse([1, 2, 3])
```

```text
[1, 2, 3]
[ant, bee, cat]
[Mo, Ada, Sam]
[3, 2, 1]
```

`sort` needs every item to be the same kind. A mixed list is a `type` error:

```sprout
try:
    show sort([1, "a", 2])
caught e:
    show e["kind"], "-", e["message"]
```

```text
type - sort needs every item to be the same kind (all numbers, or all text).
```

### Build a new collection (return new)

These never change their input — they return a fresh value:

| Call | Builds |
| --- | --- |
| `unique(list)` | the list with duplicates dropped, order kept |
| `zip(a, b)` | a list of `[a-item, b-item]` pairs, up to the **shorter** |
| `flatten(list)` | one level of nesting removed (deeper nesting stays) |
| `slice(coll, start, end)` | a sub-list/sub-text, `start` **inclusive**, `end` **exclusive**, clamped |
| `copy(x)` | a deep, independent copy |

```sprout
show unique([1, 1, 2, 3, 3, 1])
show zip([1, 2], [3, 4, 5])
show flatten([1, [2, 3], [[4]]])
show slice([10, 20, 30, 40, 50], 1, 3)
show slice("hello world", 0, 5)
show slice([1, 2, 3], 2, 2)
```

```text
[1, 2, 3]
[[1, 3], [2, 4]]
[1, 2, 3, [4]]
[20, 30]
hello
[]
```

Note `flatten` only goes one level deep (the `[4]` stays nested), `zip` stops at the
shorter list, and `slice` works on text as well as lists (and clamps an out-of-range
`end` instead of erroring).

### Reduce to one value (return new)

`sum(list)` adds up a list of numbers (`sum([])` is `0`):

```sprout
show sum([1, 2, 3, 4]), sum([])
```

```text
10 0
```

For a custom fold, use [`reduce`](#higher-order-map--filter--reduce).

### Higher-order: `map` / `filter` / `reduce`

These take a **task** — a named [task](tasks-and-lambdas.md) or an inline lambda
`task(x): ...`. They all return **new** lists/values and never mutate the source.

- `map(list, task)` — apply the task to each item.
- `filter(list, task)` — keep the items the task says `yes` to.
- `reduce(list, task, start)` — fold to one value; the task takes `(total, item)`.

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
show map([1, 2, 3], task(n): n * n)
```

```text
[2, 4, 6]
[2, 4, 6]
10
[1, 4, 9]
```

They pair beautifully with the [pipe operator](operators.md) `|>`, which threads the left
value in as the first argument so a chain reads top-to-bottom:

```sprout
make nums = [1, 2, 3, 4, 5, 6, 7, 8]
show nums |> filter(task(n): n % 2 == 0) |> map(task(n): n * 10) |> sum
```

```text
200
```

---

## Putting it together

A small leaderboard: list of records, `sort_by` + `reverse` to rank, `for each index, item`
to number them, and the toolbox for a summary. This is a complete program — its output is
below it.

```sprout
make scores = [
    {name: "Ada", points: 90},
    {name: "Mo",  points: 72},
    {name: "Sam", points: 85},
]

~ rank highest-first, then number them
make ranked = reverse(sort_by(scores, task(p): p["points"]))
for each place, p in ranked:
    show (place + 1) + ". " + p["name"] + " — " + p["points"]

~ a quick summary with the toolbox
make points = map(scores, task(p): p["points"])
show "players: " + length(scores)
show "total:   " + sum(points)
show "best:    " + max(points[0], points[1], points[2])
show "evens:   " + [n for each n in points when n % 2 == 0]
```

```text
1. Ada — 90
2. Sam — 85
3. Mo — 72
players: 3
total:   247
best:    90
evens:   [90, 72]
```

---

## Quick reference

**Literals & access**

| Form | Means |
| --- | --- |
| `[a, b, c]` | a list (multi-line + trailing comma ok) |
| `{name: v, ...}` | a map (text keys; bare key = its text) |
| `xs[i]` | list item at `i` (0-based; out-of-range = `index` error) |
| `m[key]` | map value (missing key = `nothing`) |
| `set xs[i] = v` | overwrite an item (position must exist) |
| `set m[key] = v` | set or **insert** a key |
| `a to b` | inclusive range; empty if `a > b` |
| `[expr for each x in xs when cond]` | comprehension |

**Builtins at a glance** — M = mutates in place, R = returns a new value, RM = mutates *and*
returns the same reference.

| Builtin | Kind | What it does |
| --- | --- | --- |
| `add(list, x)` | M | append `x`; returns `nothing` |
| `insert(list, pos, x)` | M | insert at `pos`; returns `nothing` |
| `remove(list, i)` / `remove(map, key)` | M | remove; returns the removed item / value |
| `sort(list)` | RM | sort numbers-or-text in place |
| `sort_by(list, task)` | RM | stable sort by the task's value |
| `reverse(list)` | RM | flip in place |
| `first(list)` / `last(list)` | R | the ends (error if empty) |
| `length(coll)` | R | item / key / character count |
| `keys(map)` / `values(map)` | R | lists, in insertion order |
| `contains(coll, x)` | R | `yes`/`no` (item / key / substring) |
| `index_of(coll, x)` | R | position, or `nothing` |
| `count(list, v)` / `count(text, p)` | R | how many |
| `sum(list)` | R | total (`0` for `[]`) |
| `min(...)` / `max(...)` | R | of separate number args |
| `unique(list)` | R | drop duplicates, keep order |
| `zip(a, b)` | R | pairs, up to the shorter |
| `flatten(list)` | R | one level of nesting removed |
| `slice(coll, s, e)` | R | sub-list/text, `s` incl., `e` excl., clamped |
| `range(n)` / `range(a, b)` | R | `0..n-1` / `a..b-1` (end-exclusive) |
| `copy(x)` | R | deep, independent copy |
| `map(list, task)` | R | transform each item |
| `filter(list, task)` | R | keep matching items |
| `reduce(list, task, start)` | R | fold to one value, task is `(total, item)` |

> Remember: **lists/maps are shared references** — `make b = a` aliases, it doesn't copy.
> Use `copy()` for an independent snapshot. And **"add to the end of a list" is `add`**,
> not `append` (`append` is for files).

---

**See also:** [tasks & lambdas](tasks-and-lambdas.md) ·
[pattern matching](pattern-matching.md) · [control flow](control-flow.md) ·
[operators](operators.md) · [builtins reference](builtins-reference.md) ·
[errors](errors.md) · [syntax basics](syntax-basics.md) · [cheat sheet](cheatsheet.md) ·
[getting started](getting-started.md)
