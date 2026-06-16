# Pattern matching

Branch on a value's *shape* with `match` / `is` / `otherwise` — pick an arm by
comparing a value, pulling a list apart, or reading keys out of a map, all in one
readable block. Every example on this page was run with the real interpreter, and
the output block under each one is its actual output.

## Contents

- [The shape of a `match`](#the-shape-of-a-match)
- [Pattern kind 1: value compare (`is "x"`, `is 0`, `is yes`)](#pattern-kind-1-value-compare)
- [Pattern kind 2: list-destructure (`is [a, b]`)](#pattern-kind-2-list-destructure)
- [Pattern kind 3: map-destructure (`is {name, age}`)](#pattern-kind-3-map-destructure)
- [Destructure vs. value: the one rule that decides](#destructure-vs-value-the-one-rule-that-decides)
- [Empty `[]` and `{}` patterns](#empty--and--patterns)
- [First match wins](#first-match-wins)
- [`otherwise`, and no-match-without-`otherwise`](#otherwise-and-no-match-without-otherwise)
- [Where bound names live (scope)](#where-bound-names-live-scope)
- [Worked example: a tiny command interpreter](#worked-example-a-tiny-command-interpreter)
- [Gotchas & edge cases](#gotchas--edge-cases)
- [See also](#see-also)

---

## The shape of a `match`

`match value:` looks at one value, then checks it against a list of `is <pattern>:`
arms **in order**. The first arm whose pattern fits runs, and the rest are skipped.
An optional `otherwise:` at the end catches everything that fell through.

```sprout
task describe(cmd):
    match cmd:
        is "start":
            give "go"
        is "stop":
            give "halt"
        otherwise:
            give "?"

show describe("start")
show describe("stop")
show describe("pause")
```

```text
go
halt
?
```

Like every block in Sprout, the header line ends in a **colon** and the body is
**indented** four spaces (see [control flow](control-flow.md) for the block shape).
A `match` is a statement: its arms can `show`, `set`, `give`, call tasks — anything.
Above they happen to `give`, because the `match` sits inside a task; but you can use
`match` anywhere, with no task in sight:

```sprout
make ok = yes
match ok:
    is yes:
        show "matched the yes branch"
```

```text
matched the yes branch
```

There are exactly **three kinds of pattern** you can write after `is`. The rest of
this page is one section each.

---

## Pattern kind 1: value compare

If the pattern is *any ordinary value or expression* — a number, a piece of text,
`yes` / `no` / `nothing`, or even a computed expression — the arm matches when the
value **equals** it (the same `==` you use elsewhere, which is deep/structural for
lists and maps; see [operators](operators.md)).

Text and numbers:

```sprout
task name_num(n):
    match n:
        is 0:
            give "zero"
        is 1:
            give "one"
        otherwise:
            give "many"

show name_num(0)
show name_num(1)
show name_num(7)
```

```text
zero
one
many
```

`yes`, `no`, and `nothing` are values too, so you can match them directly:

```sprout
task truthy_name(v):
    match v:
        is yes:
            give "Y"
        is no:
            give "N"
        is nothing:
            give "none"
        otherwise:
            give "other"

show truthy_name(yes)
show truthy_name(no)
show truthy_name(nothing)
show truthy_name(5)
```

```text
Y
N
none
other
```

A value pattern does **not** introduce any names — it only compares.

---

## Pattern kind 2: list-destructure

When the pattern is a list of **bare names** — `is [a, b]` — it does two things at
once:

1. It matches only a **list of *exactly* that length** (two names match a 2-item
   list, three names match a 3-item list, and so on).
2. It **binds** each item to the name in that position, so you can use `a` and `b`
   inside the arm.

```sprout
task pair_sum(p):
    match p:
        is [a, b]:
            give a + b
        otherwise:
            give -1

show pair_sum([10, 20])
show pair_sum([1, 2, 3])
```

```text
30
-1
```

The first call binds `a = 10`, `b = 20` and gives `30`. The second is a 3-item list,
so the 2-name pattern doesn't fit — it falls through to `otherwise`.

Because length has to match exactly, different-length patterns act as a clean way to
branch on how many items there are:

```sprout
task shape(xs):
    match xs:
        is [a]:
            give "single"
        is [a, b]:
            give "pair"
        is [a, b, c]:
            give "triple"
        otherwise:
            give "other"

show shape([9])
show shape([1, 2])
show shape([1, 2, 3])
show shape([1, 2, 3, 4])
```

```text
single
pair
triple
other
```

If the value isn't a list at all, a list-destructure simply doesn't match and the
`match` moves on to the next arm — no error:

```sprout
task lst(v):
    match v:
        is [a, b]:
            give "two items"
        otherwise:
            give "not a 2-list"

show lst("hi")
show lst({a: 1, b: 2})
```

```text
not a 2-list
not a 2-list
```

---

## Pattern kind 3: map-destructure

When the pattern is a set of **bare names** in braces — `is {name, age}` — it matches
a **map that contains all of those keys**, and binds each key's value to a
same-named variable inside the arm.

```sprout
task greet(person):
    match person:
        is {name, age}:
            give name + " (" + age + ")"
        is {name}:
            give "just " + name
        otherwise:
            give "stranger"

show greet({name: "Sam", age: 30})
show greet({name: "Mo"})
show greet({city: "NYC"})
show greet({name: "Ada", age: 40, role: "admin"})
```

```text
Sam (30)
just Mo
stranger
Ada (40)
```

Three things to notice in that output:

- `{name: "Sam", age: 30}` has both keys, so the first arm matches and binds
  `name = "Sam"`, `age = 30`.
- `{name: "Mo"}` is missing `age`, so the first arm is skipped; `{name}` matches and
  binds just `name`.
- `{city: "NYC"}` has neither key → `otherwise`.
- `{name: "Ada", age: 40, role: "admin"}` has **extra** keys (`role`), and that's
  fine — a map-destructure requires *all* its named keys to be present but does **not**
  forbid others. It matched `{name, age}` and ignored `role`.

So `is {name, age}` means "a map that *at least* has `name` and `age`." As with
lists, a non-map value (or a map missing one of the keys) just fails the arm quietly:

```sprout
task tolerant(v):
    match v:
        is {name}:
            give "named " + name
        otherwise:
            give "not a named map"

show tolerant("hello")
show tolerant([1, 2])
show tolerant(42)
```

```text
not a named map
not a named map
not a named map
```

Sprout has no structs or classes — a **map is the record type** (see
[collections](collections.md)) — so map-destructure is how you take a record apart
by field name.

---

## Destructure vs. value: the one rule that decides

Both pattern kinds 1 and 2/3 can use `[ ]` and `{ }`, so how does Sprout tell a
*value* pattern like `is [1, 2]` from a *destructure* pattern like `is [a, b]`?

> **The rule:** **bare names** inside `[ ]` or `{ }` mean *destructure*. Anything
> else — `[1, 2]`, `{a: 1}`, a literal, an expression — is a **value** compared
> with `==`.

So `is [1, 2]` matches the *exact list* `[1, 2]`, while `is [a, b]` matches *any*
2-item list and binds its items:

```sprout
task exact(xs):
    match xs:
        is [1, 2]:
            give "exactly [1,2]"
        is [a, b]:
            give "some pair"
        otherwise:
            give "no"

show exact([1, 2])
show exact([5, 6])
show exact([1, 2, 3])
```

```text
exactly [1,2]
some pair
no
```

`[1, 2]` hit the value arm; `[5, 6]` skipped it (not equal to `[1, 2]`) and
destructured into the second arm; `[1, 2, 3]` matched neither.

---

## Empty `[]` and `{}` patterns

`is []` and `is {}` are the value-compare case of the rule above: they have no names,
so they're literals, and they match **only** an empty list / empty map — *not* any
list or any map.

```sprout
task empties(v):
    match v:
        is {}:
            give "empty map"
        is []:
            give "empty list"
        otherwise:
            give "non-empty"

show empties({})
show empties({x: 1})
show empties([])
show empties([1])
```

```text
empty map
non-empty
empty list
non-empty
```

This is symmetric and easy to remember: `is []` is *the* empty list, `is {}` is *the*
empty map. To match "any list of two items" you write names — `is [a, b]`.

---

## First match wins

Arms are tried **top to bottom**, and the **first** one that fits runs — even if a
later arm would also have matched. Order your arms from most specific to most general,
and put `otherwise` last.

```sprout
task classify(n):
    match n:
        is 0:
            give "exactly zero"
        otherwise:
            give "something else"

show classify(0)
show classify(99)
```

```text
exactly zero
something else
```

In [the exact/some-pair example above](#destructure-vs-value-the-one-rule-that-decides),
`exact([1, 2])` returned `"exactly [1,2]"` rather than `"some pair"` precisely because
the specific `is [1, 2]` arm came first.

---

## `otherwise`, and no-match-without-`otherwise`

`otherwise:` is the catch-all arm. It's **optional**, and it must come **last**.

If no arm matches **and there's no `otherwise`**, the whole `match` simply does
nothing — no error, no output. This mirrors a [`when` with no
`otherwise`](control-flow.md#choices-when--orwhen--otherwise).

```sprout
make ran = "before"
match 42:
    is 1:
        set ran = "matched"
show "ran =", ran
```

```text
ran = before
```

The value `42` matched neither `is 1` nor any fallback, so the body never ran and
`ran` kept its original value. If you want a "none of these" path, add an
`otherwise`.

---

## Where bound names live (scope)

Names bound by a list- or map-destructure exist **only inside that one arm**. They
don't leak out of the `match`, and they don't overwrite an outer variable of the same
name — the binding *shadows* it for the duration of the arm, then the outer value is
back.

```sprout
make a = 999
match [1, 2]:
    is [a, b]:
        show "inside arm, a =", a, "b =", b
show "after match, a =", a
```

```text
inside arm, a = 1 b = 2
after match, a = 999
```

Inside the arm `a` is the destructured `1`; the moment the `match` is done, the outer
`a` is `999` again, untouched. (This is the same block-scoping that governs
`when`/`for each` bodies — see [scope in control flow](control-flow.md#scope-inside-a-block)
and [tasks and scope](tasks-and-lambdas.md).)

---

## Worked example: a tiny command interpreter

All three pattern kinds compose naturally. Here each command is a list whose first
item names the operation, and the match picks an arm by **arity** (how many items),
then branches on the op name inside:

```sprout
task evaluate(cmd):
    match cmd:
        is [op, x, y]:
            when op == "add":
                give x + y
            when op == "mul":
                give x * y
            give "unknown op: " + op
        is [op, x]:
            when op == "neg":
                give -x
            give "unknown op: " + op
        otherwise:
            give "bad command"

show evaluate(["add", 3, 4])
show evaluate(["mul", 6, 7])
show evaluate(["neg", 5])
show evaluate(["div", 1, 2])
show evaluate([])
```

```text
7
42
-5
unknown op: div
bad command
```

And here map-destructure dispatches a stream of event records, each shaped a little
differently:

```sprout
task handle(event):
    match event:
        is {kind, user}:
            give event["kind"] + " from " + user
        is {kind}:
            give "system event: " + kind
        otherwise:
            give "malformed event"

make log = [
    {kind: "login", user: "sam"},
    {kind: "heartbeat"},
    {note: "??"},
]
for each e in log:
    show handle(e)
```

```text
login from sam
system event: heartbeat
malformed event
```

The first event has both `kind` and `user`; the second has only `kind` (the
`{kind, user}` arm needs both, so it falls to `{kind}`); the third has neither and
hits `otherwise`. Note the multi-line list literal with a trailing comma — that's the
ordinary [collection syntax](collections.md), nothing match-specific.

---

## Gotchas & edge cases

- **`is` patterns are not assignments.** `is [a, b]` binds `a` and `b` *if the arm
  matches*; you never `make` them. They're local to the arm and vanish after it.
- **Destructure = bare names only.** `is [a, b]` and `is {name, age}` destructure;
  `is [1, 2]`, `is {a: 1}`, `is "x"`, `is 0` are *values* compared with `==`. Mixing
  isn't supported — `is [a, 2]` is not a "match-second-item-against-2" pattern, the
  whole bracket is read as one kind based on whether it's all bare names.
- **List-destructure length is exact.** `is [a, b]` matches a 2-item list and nothing
  else — there's no "rest"/spread pattern. To handle "two or more," match by length
  with separate arms (as in the calculator above) or fall to `otherwise`.
- **Map-destructure is "has at least these keys."** Extra keys are fine; missing keys
  fail the arm. `is {}` is the special case that means *exactly empty*.
- **A wrong-type value never errors here.** Matching a string against `is [a, b]`, or
  a number against `is {name}`, just fails that arm and tries the next. Pattern
  matching is for *dispatching*, not for asserting a type — if you need an error on a
  bad shape, use [`fail`](errors.md) inside `otherwise`.
- **No match and no `otherwise` does nothing** — by design, like a bare `when`.
- **`otherwise` goes last** and takes no pattern; it's the fallback, not an `is` arm.

---

## See also

- [Control flow](control-flow.md) — `when` / `orwhen` / `otherwise`, loops, and the
  block shape `match` shares
- [Collections](collections.md) — lists and maps, the values you destructure
- [Operators](operators.md) — how `==` (used by value patterns) compares deeply
- [Tasks and lambdas](tasks-and-lambdas.md) — `give`, parameters, and scope
- [Errors](errors.md) — `try` / `caught` / `fail` for turning a non-match into an error
- [Builtins reference](builtins-reference.md) — `keys`, `length`, `kind_of`, and the
  rest of the toolbox
- [Cheat sheet](cheatsheet.md) — the whole language on one page
