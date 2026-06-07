# Sprout Syntax

The complete language. Sprout uses **indentation** (4 spaces) for blocks, and a
`:` to start one.

## Comments

Start with `~`. They can be on their own line or at the end of a line.

```sprout
~ this whole line is a comment
show "hi"   ~ and this part is too
```

## Values (types)

| Type | Examples |
| --- | --- |
| Number | `0`, `42`, `3.14`, `-7` |
| Text | `"hello"`, `"line\nbreak"`, `""` |
| Yes / No (boolean) | `yes`, `no` |
| Nothing | `nothing` (what a task gives back when it has no `give`) |

Text supports the escapes `\n` (newline), `\t` (tab), `\"` (quote), `\\` (backslash).

## Variables

**Create** a variable with `make`, and **change** it later with `set`:

```sprout
make score = 0
set score = score + 1
show score        ~ 1
```

Trying to `set` a variable you never `make`-d is a friendly error (and so is
forgetting `set`).

## Printing

`show` prints a value. Separate several values with commas — they print with
spaces between them:

```sprout
show "the answer is", 42
~ the answer is 42
```

## Math

`+  -  *  /  %` with the usual precedence; use `()` to group.

```sprout
show 2 + 3 * 4      ~ 14
show (2 + 3) * 4    ~ 20
show 10 % 3         ~ 1   (remainder)
```

Dividing by zero is a friendly error rather than a crash.

## Text joining

`+` glues text to **anything** — handy for messages:

```sprout
make n = 5
show "n = " + n        ~ n = 5
```

(If *either* side of `+` is text, the result is text.)

## Comparisons

`==`  `!=`  `<`  `<=`  `>`  `>=` — they give back `yes` or `no`.

```sprout
show 3 < 5         ~ yes
show "a" == "a"    ~ yes
show 1 == "1"      ~ no   (a number is never equal to text)
```

## Logic

`and`, `or`, `not`:

```sprout
show yes and no        ~ no
show yes or no         ~ yes
show not no            ~ yes
```

What counts as "true": everything except `0`, `""` (empty text), `no`, and `nothing`.

## Conditions: when / orwhen / otherwise

```sprout
make score = 75

when score >= 90:
    show "A"
orwhen score >= 80:
    show "B"
orwhen score >= 70:
    show "C"
otherwise:
    show "try again"
```

`orwhen` and `otherwise` are optional. The first matching branch runs.

## Loops

Two kinds, both built on the word `repeat`:

```sprout
~ repeat a fixed number of times
repeat 3 times:
    show "hi"

~ repeat while something is true
make i = 1
repeat while i <= 5:
    show i
    set i = i + 1
```

## Lists

A **list** holds many values in order. Make one with square brackets, read an
item by its number (starting at `0`), and change it with `set`:

```sprout
make songs = ["a", "b", "c"]
show songs[0]            ~ a
set songs[1] = "B"      ~ change the 2nd item
add(songs, "d")         ~ add to the end
show length(songs)       ~ 4
show first(songs), last(songs)
show contains(songs, "a")
show [1, 2] + [3, 4]     ~ join two lists -> [1, 2, 3, 4]
```

Reading a spot that doesn't exist gives `nothing` (it won't crash).

## Maps

A **map** holds values by name (the keys are text):

```sprout
make person = {name: "Sam", age: 3}
show person["name"]      ~ Sam
set person["age"] = 4
show keys(person)        ~ ["name", "age"]
```

## For each

Walk through every item of a list (or a map's keys, or a text's letters):

```sprout
for each song in songs:
    show "playing", song

for each key in person:
    show key, "=", person[key]

for each n in range(3):   ~ range(3) is [0, 1, 2]
    show n
```

## Tasks (functions)

Define a reusable task with `task`, and hand back a result with `give`:

```sprout
task greet(person):
    show "Hello, " + person + "!"
    give upper(person)

make loud = greet("world")    ~ prints the greeting, loud = "WORLD"
```

- Parameters go in the `()`. Call with `name(args)`.
- `give value` returns a value and stops the task.
- A task with no `give` hands back `nothing`.
- Tasks can call **themselves** (recursion):

```sprout
task factorial(n):
    when n <= 1:
        give 1
    give n * factorial(n - 1)

show factorial(5)     ~ 120
```

- You can call a task **before** it's defined in the file (top-level tasks are
  found first).
- Variables `make`-d inside a task are **local** to that task.

## What's next

- The [built-in functions](builtins.md) you can call (`sqrt`, `max`, …)
- Making it visual: [GUI & Servers](gui-and-servers.md)
