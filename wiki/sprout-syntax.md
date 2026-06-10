# Sprout Syntax

Every part of the language, explained slowly. This covers Sprout **as it works
today** (the core); see the [roadmap](README.md#roadmap) for what's coming.

---

## Comments

A `~` starts a comment — everything after it on the line is ignored.

```sprout
~ this whole line is a note
make x = 5    ~ and this part too
```

## Values

Sprout has four kinds of value:

- **Numbers** — `3`, `-2`, `2.5`
- **Text** — `"hello"` (in double quotes; `\n`, `\t`, `\"`, `\\` work inside)
- **Yes / no** — `yes` and `no` (booleans; they print as `yes` / `no`)
- **Nothing** — `nothing`, the empty value

## Variables: make and set

`make` creates a variable. `set` changes one that already exists.

```sprout
make score = 0
set score = score + 10
```

Using a name you never `make`-d, or `set`-ting one that was never made, is a
friendly error.

## Showing things

`show` prints values. Commas join them with a space.

```sprout
make name = "Sam"
show "hi", name, 42      ~ ->  hi Sam 42
```

## Math and joining text

```sprout
show 2 + 3 * 4           ~ 14  (× and ÷ bind tighter than + and −)
show (2 + 3) * 4         ~ 20
show 10 / 4              ~ 2.5
show 10 % 3              ~ 1   (remainder)
```

`+` also joins text. If either side is text, the result is text:

```sprout
show "score: " + 10      ~ ->  score: 10
```

## Comparing and logic

```sprout
show 3 < 5               ~ yes
show 5 == 5              ~ yes
show 5 != 6              ~ yes
show yes and no          ~ no
show yes or no           ~ yes
show not no              ~ yes
```

## Choices: when / orwhen / otherwise

```sprout
make score = 5

when score > 8:
    show "great"
orwhen score == 5:
    show "okay"
otherwise:
    show "keep going"
```

The body of each branch is **indented** (4 spaces). `orwhen` and `otherwise` are
optional — you can have a `when` on its own.

## Loops: repeat

Two kinds. A fixed count:

```sprout
repeat 3 times:
    show "*"
```

…and "keep going while something is true":

```sprout
make n = 3
repeat while n > 0:
    show n
    set n = n - 1
```

## Lists

A list holds many values in order, written on one line. Positions start at **0**.

```sprout
make xs = [10, 20, 30]
show xs[0]                ~ 10  (read by position)
set xs[1] = 99            ~ change an item
add(xs, 40)              ~ add to the end
show length(xs)           ~ 4
show first(xs), last(xs)  ~ 10 40
```

## Maps

A map pairs keys with values, on one line. Look things up by key.

```sprout
make person = {name: "Sam", age: 3}
show person["name"]       ~ Sam
set person["age"] = 4     ~ change (or add) a value
show keys(person)         ~ [name, age]
```

A missing key gives back `nothing`, so `when person["x"] == nothing:` works.

## for each

Walk a list's items, a map's keys, or a text's letters. Pair it with `range` to count.

```sprout
for each item in [1, 2, 3]:
    show item

for each i in range(5):       ~ 0 1 2 3 4
    show i

for each k in {a: 1, b: 2}:   ~ the keys: a, b
    show k
```

## Built-in helpers

These work everywhere — call them like `length(xs)`:

| Call | Does |
| --- | --- |
| `length(x)` | how many items in a list/map, or letters in text |
| `add(list, x)` | add `x` to the end of a list |
| `keys(map)` | a list of the map's keys |
| `contains(coll, x)` | is `x` in the list / a map's keys / inside the text? `yes`/`no` |
| `first(list)` / `last(list)` | the first / last item (`nothing` if empty) |
| `range(n)` / `range(a, b)` | a list `0..n-1`, or `a..b-1` |

## Tasks: your own actions

`task` defines a named action; `give` hands a value back.

```sprout
task greet(name):
    give "Hello, " + name

show greet("Sam")        ~ ->  Hello, Sam
```

- A task can take any number of inputs, or none: `task tick():`.
- A task with no `give` returns `nothing`.
- You can call a task before it's defined — order doesn't matter.
- A task can call **itself** (recursion). Runaway recursion is caught with a
  friendly message instead of a crash.

```sprout
task fact(n):
    when n <= 1:
        give 1
    give n * fact(n - 1)

show fact(5)             ~ ->  120
```

### Scope

Each task call gets its own set of variables. A task can see the **global**
variables plus its own locals — but **not** the caller's locals. This keeps
recursion correct and tasks predictable.

---

See the [Cheat Sheet](cheatsheet.md) for the whole thing on one page, or
[How Sprout Works](architecture.md) for what happens under the hood.
