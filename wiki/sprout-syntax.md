# Sprout Syntax — the whole language

Welcome! This one page covers **everything** in the Sprout language: how to make
values, do math, ask questions, make choices, loop, build lists and maps, and
write your own tasks. Every idea comes with a tiny example you can run.

Sprout reads like plain English and uses **indentation** for structure (just
like Python). Two rules to keep in mind the whole way through:

- A block starts with a `:` at the end of a line.
- The lines inside that block are indented **4 spaces** deeper.

That's it. Let's go.

---

## Comments

A comment starts with `~`. Sprout ignores everything from the `~` to the end of
the line. Use them to leave notes for yourself.

```sprout
~ this whole line is just a note
show "hi"   ~ and this part of the line is a note too
```

A line that is blank, or that only has a comment, is skipped completely — it
doesn't affect your indentation.

---

## Values (the kinds of things Sprout works with)

There are four basic values, plus two collections (lists and maps, further
down).

| Value | What it is | Examples |
| --- | --- | --- |
| **Number** | whole or decimal | `0`, `42`, `3.14`, `-7` |
| **Text** | letters in quotes | `"hello"`, `"line\nbreak"`, `""` |
| **Yes / No** | a true/false answer | `yes`, `no` |
| **Nothing** | "no value at all" | `nothing` |

`nothing` is what you get back from a task that didn't hand anything back, or
when you look up something that isn't there.

### Text and escapes

Text goes in double quotes. Inside text you can use these escapes:

| Escape | Means |
| --- | --- |
| `\n` | a new line |
| `\t` | a tab |
| `\"` | a `"` inside the text |
| `\\` | a `\` |

```sprout
show "first line\nsecond line"
```

---

## Variables: `make` and `set`

**Create** a new variable with `make`. **Change** an existing one with `set`.

```sprout
make score = 0
set score = score + 1
show score        ~ 1
```

- `make name = value` creates `name`.
- `set name = value` changes a variable that already exists.

Sprout gently corrects you if you mix these up: trying to `set` something you
never `make`-d is a friendly error, and so is writing `x = 5` with no word in
front (Sprout reminds you to start with `set` or `make`).

---

## Showing things: `show`

`show` prints a value. List several values separated by commas — they print on
one line with a **space** between each.

```sprout
show "the answer is", 42
~ the answer is 42
```

Each value is turned into friendly text first: `yes`/`no` for booleans,
`nothing` for nothing, and `[1, 2, 3]` / `{name: "Sam"}` for lists and maps.

---

## Math: `+ - * / %`

The five math operators work on numbers, with the usual precedence
(`* / %` happen before `+ -`). Use parentheses `()` to group.

```sprout
show 2 + 3 * 4      ~ 14
show (2 + 3) * 4    ~ 20
show 10 % 3         ~ 1   (the remainder)
show -5             ~ -5  (a minus sign in front)
```

`%` is the **remainder** (what's left after dividing). A couple of friendly
guards:

- Dividing by zero is a clear error, not a crash.
- Taking a remainder with zero is an error too.

---

## Joining text with `+`

When **either** side of `+` is text, Sprout glues both sides together as text.
This is the easy way to build messages.

```sprout
make n = 5
show "n = " + n        ~ n = 5
show "Hi " + "there"   ~ Hi there
```

So `+` does double duty: add two numbers, or join text to anything.

---

## Comparisons: `== != < <= > >=`

These ask a question and give back `yes` or `no`.

```sprout
show 3 < 5         ~ yes
show 5 <= 5        ~ yes
show "a" == "a"    ~ yes
show 1 == "1"      ~ no   (a number is never equal to text)
```

A few notes:

- `==` and `!=` compare **any** two values. Two lists (or two maps) are equal
  when their contents match.
- `<  <=  >  >=` compare **two numbers** or **two texts** (text compares
  alphabetically). Comparing two different kinds is a friendly error.

---

## Logic: `and`, `or`, `not`

```sprout
show yes and no        ~ no
show yes or no         ~ yes
show not no            ~ yes
```

`and`/`or` only check the right-hand side if they need to (so `no and ...` stops
early). They give back `yes` or `no`.

**What counts as true?** Everything *except* these "empty" values, which count
as false:

- the number `0`
- empty text `""`
- `no`
- `nothing`
- an empty list `[]` or empty map `{}`

So `when score:` is a quick way to ask "is score not zero?".

---

## Making choices: `when` / `orwhen` / `otherwise`

Run a block only if a condition is true. Add `orwhen` for more options, and
`otherwise` as a catch-all. The **first** matching branch runs, and the rest are
skipped.

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
~ prints: C
```

`orwhen` and `otherwise` are both optional. The simplest form is just a `when`:

```sprout
when score > 0:
    show "you have points!"
```

---

## Loops: `repeat`

Sprout has two loops, both starting with the word `repeat`.

### `repeat N times`

Run a block a fixed number of times.

```sprout
repeat 3 times:
    show "hi"
~ hi
~ hi
~ hi
```

The count must be a number (decimals are rounded down).

### `repeat while`

Run a block over and over **while** a condition stays true.

```sprout
make i = 1
repeat while i <= 5:
    show i
    set i = i + 1
~ 1 2 3 4 5  (each on its own line)
```

Make sure the condition eventually becomes false — Sprout watches for endless
loops and stops with a friendly message if one runs too long.

---

## Lists

A **list** holds many values in order. Write one with square brackets on a
single line.

```sprout
make songs = ["a", "b", "c"]
make empty = []
make mixed = [1, "two", yes]
```

### Reading an item — `xs[0]`

Items are numbered starting at `0`. Reading a spot that doesn't exist gives back
`nothing` (it won't crash).

```sprout
show songs[0]     ~ a
show songs[2]     ~ c
show songs[99]    ~ nothing
```

### Changing an item — `set xs[i] = v`

```sprout
set songs[1] = "B"     ~ change the 2nd item
show songs             ~ ["a", "B", "c"]
```

Tip: setting the spot **one past the end** adds a new item there. (To grow a
list more naturally, the `add` built-in is the friendly way.)

### Joining lists with `+`

Two lists join into one longer list.

```sprout
show [1, 2] + [3, 4]   ~ [1, 2, 3, 4]
```

For list helpers like `add`, `length`, `first`, `last`, `contains`, and
`range`, see the [built-in functions](builtins.md).

---

## Maps

A **map** holds values **by name**. The names (keys) are always text. Write one
with curly braces on a single line; keys can be bare words or quoted text.

```sprout
make person = {name: "Sam", age: 3}
make empty = {}
```

### Reading by key — `m["key"]`

```sprout
show person["name"]    ~ Sam
show person["age"]     ~ 3
show person["nope"]    ~ nothing   (missing key gives nothing)
```

### Changing or adding — `set m["key"] = v`

Setting a key that doesn't exist yet **adds** it.

```sprout
set person["age"] = 4
set person["city"] = "Leeds"   ~ adds a new key
```

To list a map's keys, use the `keys` [built-in](builtins.md).

---

## Going through everything: `for each`

`for each` walks through a collection one item at a time. It works on three
things:

- a **list** → each item
- a **map** → each **key** (text)
- **text** → each letter

```sprout
make songs = ["a", "b", "c"]
for each song in songs:
    show "playing", song

make person = {name: "Sam", age: 3}
for each key in person:
    show key, "=", person[key]

for each letter in "hi":
    show letter
~ h
~ i
```

The collection is snapshotted at the start, so changing it inside the loop won't
upset the walk. To loop over a range of numbers, pair `for each` with the
`range` [built-in](builtins.md):

```sprout
for each n in range(3):   ~ range(3) is [0, 1, 2]
    show n
```

---

## Tasks (your own functions)

A **task** is a reusable block of steps with a name. Define it with `task`, list
its inputs in `()`, and call it like `name(args)`.

```sprout
task greet(person):
    show "Hello, " + person + "!"

greet("world")     ~ Hello, world!
```

### Handing a value back: `give`

`give value` hands a result back to whoever called the task **and stops the
task right there**.

```sprout
task double(n):
    give n * 2

show double(21)    ~ 42
```

- A task with **no** `give` hands back `nothing`.
- A bare `give` (with nothing after it) also hands back `nothing`.

### Calling tasks anywhere in the file

Top-level tasks are found before your program runs, so you can call a task
**above** the line that defines it.

```sprout
show triple(4)     ~ 12  (defined below, still works)

task triple(n):
    give n * 3
```

### Local variables

Variables you `make` inside a task live only inside that task. They disappear
when the task finishes, and don't clash with names elsewhere.

### Recursion (a task that calls itself)

A task can call itself — just make sure there's a `when` that eventually stops
it.

```sprout
task factorial(n):
    when n <= 1:
        give 1
    give n * factorial(n - 1)

show factorial(5)     ~ 120
```

If a task calls itself forever, Sprout stops it with a friendly message instead
of crashing.

> **Note:** tasks are defined at the **top level** (the left margin), not nested
> inside another block. Each task must be given exactly the number of inputs it
> declares, or you'll get a clear error.

---

## Asking the user: `ask`

`ask` shows a prompt and reads one line the person types. It always hands back
**text** (use a built-in like `number` if you need a number).

```sprout
make name = ask("What's your name?")
show "Hi, " + name + "!"
```

Caveat: `ask` only reads from a real console (when you `sprout run` a program).
In a GUI or web app it simply hands back empty text `""`.

---

## Bringing in more: `use`

`use "..."` pulls in extra code. The quotes decide what kind:

```sprout
use "discord-bot"        ~ a built-in library (no .sprout)
use "scoring.sprout"     ~ your own file (ends in .sprout)
```

- `use "name"` (no `.sprout`) loads a built-in [library](libraries.md) that adds
  new powers.
- `use "file.sprout"` loads **your own** file, so its tasks become callable in
  this one. This is how you split a big program into tidy pieces — see
  [Projects](projects.md) for the full story.

---

## Indentation rules (the one thing to get right)

Blocks are made by indentation, so keeping it tidy matters. The rules are
simple:

- Start a block with `:` at the end of the header line (`when`, `repeat`,
  `for each`, `task`).
- Indent the lines inside the block **4 more spaces** than the header.
- Use **spaces**, not tabs. (A tab for spacing is a friendly error.)
- Line everything in a block up at the same depth.
- One statement per line.

```sprout
when ready:
    show "go!"          ~ 4 spaces in
    repeat 2 times:
        show "again"    ~ 8 spaces in (a block inside a block)
```

Indenting a line that isn't inside a block, or lining up with nothing above it,
is caught with a clear message pointing at the line.

---

## See also

- [Built-in functions](builtins.md) — ready-made helpers like `length`, `round`, `range`, `upper`
- [Projects](projects.md) — split your program across files with `use "file.sprout"`
- [Cheat Sheet](cheatsheet.md) — the whole language on one page
