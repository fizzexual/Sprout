# Built-in functions

These work everywhere — no setup, no imports. Call them like `sqrt(16)` or
`get("https://...")`. This is what normally takes a backend language *plus* an
HTTP library *plus* a JSON parser *plus* shell glue — in Sprout it's all built in.

## Numbers

| Call | Does | Example |
| --- | --- | --- |
| `sqrt(n)` | square root | `sqrt(16)` → `4` |
| `abs(n)` | drop the minus sign | `abs(-4)` → `4` |
| `round(n)` / `floor(n)` / `ceil(n)` | round nearest / down / up | `round(2.6)` → `3` |
| `min(...)` / `max(...)` | smallest / largest | `max(3, 9, 5)` → `9` |
| `random()` | a number from 0 up to 1 | `random()` → `0.42…` |
| `random(n)` / `random(a, b)` | a whole number `0..n-1` / `a..b` | `random(1, 6)` → `4` |
| `number(text)` | turn text into a number (`nothing` if it isn't one) | `number("42")` → `42` |

## Text

| Call | Does | Example |
| --- | --- | --- |
| `upper(t)` / `lower(t)` | change case | `upper("hi")` → `HI` |
| `trim(t)` | remove surrounding spaces | `trim("  x  ")` → `x` |
| `replace(t, find, with)` | swap every match | `replace("a-b", "-", "+")` → `a+b` |
| `split(t, sep)` | break into a list (empty `sep` = letters) | `split("a,b", ",")` → `[a, b]` |
| `join(list, sep)` | glue a list into text | `join([1,2,3], "-")` → `1-2-3` |
| `length(t)` | how many characters | `length("hi")` → `2` |

## Lists & maps

| Call | Does |
| --- | --- |
| `length(coll)` | how many items (list, map, or text) |
| `add(list, x)` | add `x` to the end |
| `keys(map)` | a list of the map's keys |
| `contains(coll, x)` | is `x` in the list / a map key / inside the text? |
| `first(list)` / `last(list)` | the ends (`nothing` if empty) |
| `range(n)` / `range(a, b)` | `0..n-1` / `a..b-1` as a list |

## Time

| Call | Does | Example |
| --- | --- | --- |
| `now()` | date + time, as text | `2026-06-10 14:30:00` |
| `today()` | just the date | `2026-06-10` |
| `wait(seconds)` | pause | `wait(2)` |

## Input & files

| Call | Does |
| --- | --- |
| `ask("question? ")` | print the question, return what the user types |
| `read("file")` | the file's contents as text (`nothing` if missing) |
| `write("file", text)` | write text to a file (replacing it) |
| `append("file", text)` | add text to the end of a file |
| `exists("file")` | `yes` / `no` |

## The superpowers 🌟

| Call | Does |
| --- | --- |
| `get("url")` | fetch a web page or API; gives back the text |
| `json(text)` | parse JSON into native Sprout lists & maps |
| `explore(value)` | list every `path = value` inside a value — point it at an API to see all its fields/targets |
| `color(name, text)` | wrap text in a terminal colour (`red` `green` `yellow` `blue` `magenta` `cyan` `white` `gray` `bold` `dim`) |
| `run("command")` | run any program, return its output |

```sprout
~ Call an API and use the result like a normal map — no libraries:
make repo = json(get("https://api.github.com/repos/fizzexual/Sprout"))
show repo["name"], "has", repo["stargazers_count"], "stars"

~ Read JSON from anywhere:
make person = json("{\"name\": \"Sam\", \"pets\": [\"cat\", \"dog\"]}")
show person["name"], person["pets"][0]

~ Drive your computer:
show run("echo hello from the shell")
write("notes.txt", "remember the milk")
show read("notes.txt")

~ Discover everything an API offers, and add some colour:
for each field in explore(json(get("https://api.github.com/repos/fizzexual/Sprout"))):
    show field
show color("green", "done!")
```

## Commands

| Command | Does |
| --- | --- |
| `sprout new <folder> [template]` | create a brand-new project folder (never wipes anything) |
| `sprout build` | run the project in this folder — reads `sprout.toml`, loads every file, runs `main` last |
| `sprout api <url>` | fetch a URL and print every field/target the API returns |
| `sprout template list` | list the built-in project templates |
| `sprout template load <name>` | scaffold a template into the **current** folder (asks before wiping it) |

## Projects (`sprout.toml` + `use`)

Bigger programs span many files. A `sprout.toml` ties them together, and
`use <name>` pulls another file in by name. Every file in a project shares one
space, so a `task` defined anywhere is callable everywhere. See
**[Projects & modules](projects.md)** for the full guide.

```toml
# sprout.toml
project "MyApp"
main "app.sprout"

include [
    "modules/greeter.sprout",
    "modules/server.sprout"
]
```

```sprout
~ app.sprout
use greeter        ~ loads modules/greeter.sprout
show greet("world")
```

