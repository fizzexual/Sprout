# Syntax basics: values, variables & comments

The ground floor of Sprout — the four kinds of value you work with, how to name
and change them, how to print them, and the handful of rules (truthiness,
equality, copying, scope) that everything else is built on. Every example below
was run with the real interpreter, and the output blocks are pasted verbatim.

New here? Start with [getting started](getting-started.md). For the whole
language on one page, see the [cheatsheet](cheatsheet.md).

## On this page

- [The four value types](#the-four-value-types)
- [Number literals (incl. scientific notation)](#number-literals)
- [Comments](#comments)
- [`make` — give a value a name](#make--give-a-value-a-name)
- [`set` — change an existing name](#set--change-an-existing-name)
- [Compound assignment (`+=` and friends)](#compound-assignment)
- [`show` — print values](#show--print-values)
- [Truthiness — what counts as true](#truthiness)
- [Equality with `==`](#equality-with-)
- [`copy()` vs shared references](#copy-vs-shared-references)
- [Block scope & shadowing](#block-scope--shadowing)
- [Reserved words](#reserved-words)
- [Quick gotchas](#quick-gotchas)
- [Where to go next](#where-to-go-next)

---

## The four value types

Sprout is dynamically typed — a name can hold any kind of value, and the kind
travels with the value, not the name. The four everyday value types are:

| Type | Looks like | Notes |
| --- | --- | --- |
| **number** | `42`, `2.5`, `0 - 7` | every number is an IEEE-754 double — there's no separate integer type |
| **text** | `"hello"` | UTF-8; double quotes; `\n` `\t` `\"` `\\` work inside |
| **yes / no** | `yes`, `no` | the booleans; they print as `yes` and `no` |
| **nothing** | `nothing` | the empty value — "there's nothing here" |

(There are two more *collection* types — **list** `[1, 2, 3]` and **map**
`{name: "Sam"}` — which get their own page,
[lists and maps](collections.md). This page is about the four above.)

You can ask any value its type with `kind_of`, which hands back the type's name
as text:

```sprout
show 42, 2.5, 0 - 7        ~ numbers
show "hello"               ~ text
show yes, no               ~ yes/no
show nothing               ~ nothing
show kind_of(42), kind_of("hi"), kind_of(yes), kind_of(nothing)
```

```
42 2.5 -7
hello
yes no
nothing
number text yes-no nothing
```

A couple of things to notice in that output:

- There's **no `-` literal**. To write a negative number, subtract — `0 - 7` —
  or negate a name with unary minus (`-x`). `kind_of(yes)` is the text
  `"yes-no"`, the name of the boolean type.
- Text prints **without quotes**. `show "hello"` writes `hello`, not `"hello"` —
  `show` renders a value the way a person would read it.

## Number literals

Every number is a double, so there's no `int` vs `float` split to think about.
That means `5 / 2` is `2.5`, not `2`. But whole-number values print **without a
trailing `.0`**, so the doubles-only choice stays invisible until you actually
divide:

```sprout
show 1e6, 2.5e-3, 1.5e3
show 1e21
show 5 / 2, 10 / 4
show range(3)
```

```
1000000 0.0025 1500
1e+21
2.5 2.5
[0, 1, 2]
```

What that shows:

- **Scientific-notation literals** are accepted: `1e6` is one million, `2.5e-3`
  is `0.0025`, `1.5e3` is `1500`. The form is `digits[.digits][e±digits]`.
- Whole numbers display cleanly (`range(3)` is `[0, 1, 2]`, not `[0.0, …]`).
- **Very large** whole numbers fall back to exponential form past about
  `1e15` — that's why `1e21` shows as `1e+21`.

For the full number rules (`%` sign behavior, divide-by-zero errors, precision),
see [errors](errors.md) and the [builtins reference](builtins-reference.md).

## Comments

A `~` (tilde) starts a comment. Everything after it on that line is ignored —
whether the `~` begins the line or trails some code.

```sprout
~ a whole-line comment
make x = 5    ~ trailing comment after code
show x
```

```
5
```

Comment-only lines and blank lines don't affect indentation, so you can annotate
freely inside an indented block without breaking it.

## `make` — give a value a name

`make` introduces a **brand-new name**. It takes exactly one value.

```sprout
make score = 0
make name = "Sam"
show name, score
```

```
Sam 0
```

`make` is deliberately **strict**: re-`make`ing a name that already exists in the
same scope is an error. This is so a typo'd `make` can't silently overwrite a
variable you meant to keep — when you want to *change* a value, that's `set`'s
job, and the error says so:

```sprout
make x = 1
make x = 2
```

```
  Sprout error in …/remake.sprout (line 2): 'x' already exists here - use 'set' to change it (make is only for new names).
```

## `set` — change an existing name

`set` changes a name that's already been `make`d. It searches outward through
enclosing scopes to find it, and errors if the name was never made:

```sprout
make score = 0
set score = score + 10
show score
```

```
10
```

Try to `set` a name that doesn't exist and Sprout points you at `make`:

```sprout
set y = 5
```

```
  Sprout error in …/setnever.sprout (line 1): I can't set 'y' because it was never made.

  Make it first, like:  make y = ...
```

The rule of thumb: **`make` creates, `set` changes.** A fresh name is `make`; an
existing one is `set`.

> One wrinkle worth flagging: a brand-new **map key** uses `set`, not `make`,
> because the *map* already exists — you're changing it, not introducing a new
> name. `set m["age"] = 3` adds the key. More in [lists and maps](collections.md).

## Compound assignment

`set x += e` is shorthand for `set x = x + e` — and there's one for each
arithmetic operator: `+=`, `-=`, `*=`, `/=`, `%=`. The target must already
exist; compound assignment never *creates* a name.

It also works **through an index** — into a list position or a map key — as long
as that position/key already exists:

```sprout
make x = 10
set x += 5
set x -= 3
set x *= 2
set x /= 4
set x %= 5
show x

make s = "ha"
set s += "!"
show s

make xs = [1, 2, 3]
set xs[0] += 10
show xs

make m = {a: 1}
set m["a"] += 9
show m
```

```
1
ha!
[11, 2, 3]
{a: 10}
```

Walking the first line: `10 + 5 = 15`, `- 3 = 12`, `* 2 = 24`, `/ 4 = 6`,
`% 5 = 1`. And because `+=` keeps `+`'s meaning, `set s += "!"` *appends text* —
the `+` joins strings whenever either side is text.

## `show` — print values

`show` prints. Separate several values with **commas**, and `show` puts a single
space between each:

```sprout
show "a", "b", "c"
show 1, 2, 3
show "x =", 42, "done"
```

```
a b c
1 2 3
x = 42 done
```

This is the one place a comma list is allowed. **`make` and `set` each take a
single value** — `make x = 1, 2` is a syntax error — so commas are a `show`
thing, not a general "multiple values" thing:

```sprout
make x = 1, 2
```

```
  Sprout error in …/makecomma.sprout (line 1): I didn't expect this at the start of a line.
```

Every value renders through the **same** display function — `show`, f-strings
(`f"{x}"`), and `+` all produce identical text. So a list shows the same way
whether you print it or splice it into a string:

```sprout
show "L=" + [1, 2]
show f"{nothing}"
show f"{2 + 3}"
```

```
L=[1, 2]
nothing
5
```

(`f"{2 + 3}"` is `5`, not `23`, because each `{…}` keeps its own operator
meaning and only the final result is turned into text.)

## Truthiness

`when`, `repeat while`, and the logical operators (`and`, `or`, `not`) ask a
value whether it's "true." Five things are **falsey** — `no`, `nothing`, `0`,
the empty text `""`, and an empty list or map. Everything else is truthy:

```sprout
when not "":
    show "empty text is falsy"
when not 0:
    show "zero is falsy"
when not []:
    show "empty list is falsy"
when not {}:
    show "empty map is falsy"
when not nothing:
    show "nothing is falsy"
when not no:
    show "no is falsy"
when "hi":
    show "non-empty text is truthy"
when 3:
    show "non-zero number is truthy"
```

```
empty text is falsy
zero is falsy
empty list is falsy
empty map is falsy
nothing is falsy
no is falsy
non-empty text is truthy
non-zero number is truthy
```

`and` and `or` short-circuit (they stop as soon as the answer is known), and
**`and` binds tighter than `or`** — so `a or b and c` means `a or (b and c)`.
More on conditions and loops in [control flow](control-flow.md).

## Equality with `==`

`==` tests whether two values are equal; `!=` is "not equal." Equality is
**structural and deep** — two different lists or maps with the same contents are
equal — and it **never crashes**, even across different types:

```sprout
show 2 == 2, 2 != 3
show "x" == "x", "x" == "y"
show 5 == "5"
show [1, 2] == [1, 2]
show {a: 1, b: 2} == {b: 2, a: 1}
show nothing == nothing
```

```
yes yes
yes no
no
yes
yes
yes
```

Two things to lock in:

- **Different types are never equal.** `5 == "5"` is `no` — a number and a piece
  of text are different kinds of value, so they're unequal rather than an error.
- **Map key order doesn't affect equality.** `{a: 1, b: 2}` equals
  `{b: 2, a: 1}`, even though Sprout *preserves* insertion order when you iterate.

(The ordered comparisons `< <= > >=` are separate — they compare two numbers or
two pieces of text, and don't chain. See [control flow](control-flow.md).)

## `copy()` vs shared references

This is the one rule that trips people up, so it's worth slowing down for.

**Numbers, text, `yes`/`no`, and `nothing` are immutable value types** — copying
one just copies the value, and there's nothing to share. But **lists and maps are
shared references.** `make b = a` does *not* duplicate the list; `a` and `b`
become two names for the *same* list. Change it through one name and you see the
change through the other:

```sprout
make a = [1, 2, 3]
make b = a
add(b, 4)
show "a is", a
show "b is", b

make c = [1, 2, 3]
make d = copy(c)
add(c, 99)
show "c is", c
show "d is", d
```

```
a is [1, 2, 3, 4]
b is [1, 2, 3, 4]
c is [1, 2, 3, 99]
d is [1, 2, 3]
```

`add(b, 4)` changed `a` too, because they're the same list. When you want an
**independent snapshot**, use `copy(x)` — it makes a deep copy, so later changes
to the original (`add(c, 99)`) leave the copy (`d`) untouched.

Maps work the same way, and `copy` is deep — it copies nested lists and maps too:

```sprout
make m = {name: "Sam"}
make n = m
set n["age"] = 3
show "m is", m

make snap = copy(m)
set m["name"] = "Alex"
show "snap is", snap
show "m is", m
```

```
m is {name: Sam, age: 3}
snap is {name: Sam, age: 3}
m is {name: Alex, age: 3}
```

`set n["age"]` showed up in `m` (same map). But `snap`, taken with `copy`, kept
the old name after `m` was renamed. The same sharing applies when you pass a list
or map **into a task** — the task can mutate the caller's value, which is often
exactly what you want. See [tasks and lambdas](tasks-and-lambdas.md).

## Block scope & shadowing

Each block — a `when` branch, a loop body, a `try` — has **its own scope.** A
name `make`d inside a block lives only there and is gone when the block ends. If
its name matches an outer one, it **shadows** the outer name for the duration of
the block, without touching it. But `set` still reaches *outward* to change an
enclosing variable:

```sprout
make x = 1
when yes:
    make x = 99
    show "inside block, x is", x
show "outside block, x is", x

make total = 0
when yes:
    set total = total + 5
show "set reaches outward, total is", total
```

```
inside block, x is 99
outside block, x is 1
set reaches outward, total is 5
```

So the inner `make x = 99` created a fresh `x` that shadowed the outer one inside
the block; once the block ended, the original `x` (still `1`) was back. The `set
total` reached out and changed the outer `total`. (A `for each` loop variable is
also block-scoped — each turn gets a fresh one, and it doesn't exist after the
loop. Tasks are stricter still: a task sees the file's top-level names plus its
own locals, *not* the caller's locals. Both are covered in
[control flow](control-flow.md) and [tasks and lambdas](tasks-and-lambdas.md).)

## Reserved words

Identifiers (names) start with a letter or `_`, then letters, digits, or `_`
(ASCII), and are **case-sensitive** — `Name` and `name` are different names.

The following **keywords** are reserved — you can't use them as names:

```
make set show when orwhen otherwise repeat while times task give
for each in to match is use public private learn test expect and or not
yes no nothing try caught fail stop skip
```

Try to use one as a name and you get a friendly error:

```sprout
make set = 5
```

```
  Sprout error in …/reserved.sprout (line 1): I expected a name here.
```

One deliberate non-reservation: **`else` is *not* a keyword.** It's only special
right after `or` (the `or else` nothing-coalescing operator); anywhere else it's
an ordinary name you can use freely:

```sprout
make else = 7
show else
```

```
7
```

> **Built-in function names** (like `length`, `sqrt`, `add`, `keys`) are *not*
> reserved — you *may* shadow one with your own variable, and the function stays
> callable, but it's clearer not to. The full list is in the
> [builtins reference](builtins-reference.md).

## Quick gotchas

- **Negative numbers** have no literal form — write `0 - 7`, or negate a name
  with `-x`.
- **`5 / 2` is `2.5`.** Numbers are doubles; there's no integer division. Whole
  results still print without a `.0`.
- **`make` is strict** — re-`make` in the same scope is an error. Use `set` to
  change a value.
- **A new map key uses `set`, not `make`** — the map already exists.
- **Lists and maps are shared** — `make b = a` aliases; use `copy(a)` for an
  independent snapshot.
- **`make`/`set` take one value; only `show` takes a comma list.**
- **`5 == "5"` is `no`** — different types are never equal, never an error.

## Where to go next

- [Control flow](control-flow.md) — `when`/`orwhen`/`otherwise`, the loops,
  comparisons, and `match`.
- [Lists and maps](collections.md) — the two collection types in depth.
- [Tasks and lambdas](tasks-and-lambdas.md) — your own actions, closures, and
  first-class tasks.
- [Pattern matching](pattern-matching.md) — `match` / `is` with destructuring.
- [Builtins reference](builtins-reference.md) — every built-in function.
- [Errors](errors.md) — `try` / `caught` / `fail` and the error kinds.
- [Testing and learn](testing-and-learn.md) — `test` / `expect` and `learn` mode.
- [Cheatsheet](cheatsheet.md) — the whole language on one page.
