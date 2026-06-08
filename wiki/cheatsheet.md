# Sprout Cheat Sheet (one page)

The whole language on one page. Skim it, copy a snippet, change a number, run it. That's how you learn Sprout. 🌱

Every example below is real, runnable Sprout — nothing here is made up.

---

## The basics

```sprout
~ this is a comment

make x = 10           ~ create a variable
set x = x + 1         ~ change one you already made

show "hi", x          ~ print (commas join with spaces)  ->  hi 11
```

**Values:** numbers (`3`, `2.5`), text (`"hello"`), `yes` / `no` (booleans), and `nothing` (the empty value).

**Math:** `+  -  *  /  %`  — use `(` `)` to group.

**Compare:** `==  !=  <  <=  >  >=`

**Logic:** `and`  `or`  `not`

```sprout
when 3 + 4 * 2 == 11:
    show "math works!"
```

---

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

`orwhen` and `otherwise` are both optional. Indent the body (4 spaces is the Sprout style).

---

## Repeating

```sprout
repeat 3 times:        ~ a fixed number of times
    show "*"

make n = 3
repeat while n > 0:    ~ keep going while something is true
    show n
    set n = n - 1
```

---

## Lists

A list holds many values in order. Counting starts at **0**.

```sprout
make xs = [1, 2, 3]   ~ lists are written on one line
show xs[0]            ~ read by position  ->  1
set xs[1] = 9         ~ change an item
add(xs, 4)            ~ stick a value on the end
show length(xs)       ~ how many  ->  4
```

---

## Maps

A map pairs **keys** with **values**.

```sprout
make person = {name: "Sam", age: 3}   ~ maps are one line too
show person["name"]                   ~ look up by key  ->  Sam
set person["age"] = 4                 ~ change a value
show keys(person)                     ~ all the keys  ->  [name, age]
```

---

## for each

Walk a list's items, a map's keys, or the letters of some text.

```sprout
for each item in [10, 20, 30]:
    show item

for each k in {a: 1, b: 2}:   ~ gives you the keys
    show k

for each letter in "hi":
    show letter
```

Pair it with `range(n)` to count:

```sprout
for each i in range(3):   ~ 0, 1, 2
    show i
```

---

## Tasks

A task is your own named action. `give` hands a value back to whoever called it.

```sprout
task greet(name):
    give "Hello, " + name

show greet("Sam")     ~ ->  Hello, Sam
```

Tasks can take any number of inputs, or none. A task without a `give` simply returns `nothing`.

```sprout
task countdown(from):
    repeat while from > 0:
        show from
        set from = from - 1
```

> Tasks are defined at the **top level** (the far-left margin), not inside another block.

---

## ask — get input from the user

`ask("question")` prints the question and returns whatever the user types, as **text**.

```sprout
make name = ask("What's your name? ")
show "Hi, " + name
```

Typed-in text is always text. Turn it into a number with `number(...)`:

```sprout
make age = number(ask("Your age? "))
when age == nothing:
    show "that wasn't a number!"
```

---

## use — pull in more code

```sprout
use "scoring.sprout"   ~ another .sprout FILE (path is relative to this file)
use "discord-bot"      ~ no .sprout = a built-in LIBRARY
```

- A name **ending in `.sprout`** imports that file's tasks. Imports can chain, and order doesn't matter.
- A **plain name** (`"discord-bot"`) loads a library. Browse and install libraries with `sprout modules`.
- A `library/extension` name (like `"discord-bot/music"`) adds an extension on top of a library — put the `use "discord-bot"` line first.

---

## Built-in functions

These work everywhere — no `use` needed. You call them like `sqrt(16)` or `max(3, 9)`.

### Numbers

| Function | What it does | Example |
| --- | --- | --- |
| `abs(n)` | Distance from zero (drops the minus sign) | `abs(-4)` → `4` |
| `round(n)` | Round to the nearest whole number | `round(2.6)` → `3` |
| `floor(n)` | Round **down** to a whole number | `floor(2.9)` → `2` |
| `ceil(n)` | Round **up** to a whole number | `ceil(2.1)` → `3` |
| `sqrt(n)` | Square root (errors on a negative number) | `sqrt(16)` → `4` |
| `min(...)` | Smallest of the numbers you give | `min(3, 9, 5)` → `3` |
| `max(...)` | Largest of the numbers you give | `max(3, 9, 5)` → `9` |
| `random()` | A random number from 0 up to (not including) 1 | `random()` → `0.42...` |

### Text

| Function | What it does | Example |
| --- | --- | --- |
| `upper(text)` | Make it ALL CAPS | `upper("hi")` → `HI` |
| `lower(text)` | Make it all lowercase | `lower("HI")` → `hi` |
| `number(text)` | Turn text into a number; `nothing` if it isn't one | `number("42")` → `42` |

### Lists & maps

| Function | What it does | Example |
| --- | --- | --- |
| `length(coll)` | How many items — works on a list, map, or text | `length([1, 2, 3])` → `3` |
| `add(list, x)` | Add `x` to the end of the list | `add(xs, 4)` |
| `contains(coll, x)` | Is `x` in the list/map keys/text? → `yes`/`no` | `contains([1, 2], 2)` → `yes` |
| `keys(map)` | A list of the map's keys | `keys({a: 1})` → `[a]` |
| `first(list)` | The first item (`nothing` if empty) | `first([7, 8])` → `7` |
| `last(list)` | The last item (`nothing` if empty) | `last([7, 8])` → `8` |
| `range(n)` | A list `0..n-1`; `range(a, b)` gives `a..b-1` | `range(3)` → `[0, 1, 2]` |

### Remembering things (saved between runs)

`remember`/`recall` save simple values (numbers, text, `yes`/`no`) to a small file next to your program, so they survive after it stops.

| Function | What it does | Example |
| --- | --- | --- |
| `remember("key", value)` | Save a value under a name | `remember("score", 10)` |
| `recall("key", default?)` | Load it back; use the default if it was never saved | `recall("score", 0)` |

```sprout
make best = recall("best", 0)
show "your best so far:", best
remember("best", best + 1)
```

### The internet

| Function | What it does | Example |
| --- | --- | --- |
| `get("url")` | Fetch a web address; gives back the text/response | `get("https://example.com")` |
| `post("url", body)` | Send `body` to a web address | `post(url, "hello")` |
| `jsonpick(text, "a.b")` | Pull one value out of JSON text by path | `jsonpick(reply, "user.name")` |
| `explore(text)` | Show every path inside some JSON, so you know what's there | `explore(reply)` |
| `get_api_points(text)` | List the readable points an API offers | `get_api_points(reply)` |

```sprout
make reply = get("https://api.example.com/me")
show jsonpick(reply, "name")
```

### Secrets

`secret("NAME")` reads a token by name from your environment, or from a git-ignored `.env` file next to your program — so passwords never end up inside your code. It errors clearly if the secret is missing.

```sprout
make token = secret("DISCORD_TOKEN")
```

---

## GUI & server widgets

A Sprout program becomes an **app** the moment it calls one of these. The very same code can run as a native window or as a website — you just pick which with `window(...)` or `server(...)`.

```sprout
window("Counter")             ~ a native desktop window...
~ server("Counter")          ~ ...or swap to a website

make count = 0
label("display", "0")         ~ show some text

task bump():                  ~ a button runs a task when clicked
    set count = count + 1
    label("display", count)   ~ same id again = update that label

button("Add one", "bump")
```

| Function | What it does | Example |
| --- | --- | --- |
| `window("Title")` | Run this app as a native window | `window("My App")` |
| `server("Title")` | Run this app as a website instead | `server("My App")` |
| `label("id", "text")` | Show text; call the same `id` again to update it | `label("score", count)` |
| `button("text", "taskName")` | A button that runs that task on click | `button("Go", "onGo")` |
| `field("id", "hint")` | A text box to type in (the hint is optional) | `field("name", "Your name")` |
| `textof("id")` | Read what's currently typed in a field | `textof("name")` |

> A button can only run **its own** task. Helper tasks not wired to a button can't be triggered from the page — that keeps your app safe.

---

## Bloom — styling (`.bloom`)

Bloom is Sprout's tiny version of CSS. Point at a Bloom file with `style` (it's optional — leave it out and the app looks raw, like a page with no CSS).

```sprout
style "theme.bloom"           ~ relative to your .sprout file
window("My App")
```

A `.bloom` file is **selectors** with indented **properties**:

```bloom
window:               ~ the whole window/page
    background: #1a1030
    text: #f0e9ff
    font: Segoe UI 14

button:               ~ every button
    background: #8a5cff
    text: #ffffff
    rounded: 12

#display:             ~ one widget, picked by its id
    size: 26
```

**Selectors:** `window`, `label`, `button`, `field`, or `#id` (a single widget). An `#id` style layers on top of the widget-kind style.

**Properties Bloom understands:**

| Property | Does | Example |
| --- | --- | --- |
| `background` | Background colour | `background: #1a1030` |
| `text` | Text colour | `text: #f0e9ff` |
| `font` | Font family, with an optional size | `font: Segoe UI 14` |
| `size` | Text size, in points | `size: 26` |
| `rounded` | Rounded-corner amount | `rounded: 12` |
| `border` | A border in this colour | `border: #28321f` |
| `padding` | Space inside the widget | `padding: 8` |
| `width` | Fixed width | `width: 200` |

Comments in Bloom use `~`, just like Sprout. The same theme is used by both the window and the website, so your app looks the same either way.

---

## Commands

Run these in your terminal.

| Command | What it does |
| --- | --- |
| `sprout file.sprout` | Run a program (opens a window if it's a GUI app) |
| `sprout run file.sprout` | Same as above — run the program |
| `sprout gui file.sprout` | Force it open as a native window |
| `sprout serve file.sprout` | Run it as a website and open the browser |
| `sprout check file.sprout` | Verify the program (and files it `use`s) **without** running |
| `sprout explain file.sprout` | Run it and narrate every step in plain English |
| `sprout api <url>` | Connect to an API and list everything you can read |
| `sprout modules` | Install / uninstall / test libraries (interactive) |
| `sprout repl` | Start the interactive prompt (also runs with no arguments) |
| `sprout version` | Show the version |

In the **repl**, type a line and press Enter to run it. A line ending in `:` starts a block — keep typing, then press Enter on a blank line to run the whole block. Ctrl+C quits.

---

## See also

- [Sprout Syntax](sprout-syntax.md) — every statement, explained slowly
- [Bloom](bloom-syntax.md) — the full styling guide
- [GUI & Servers](gui-and-servers.md) — building windows and websites
