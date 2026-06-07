# Built-in Functions

These come with Sprout — call them anywhere, like `sqrt(16)`. They use the same
`name(args)` syntax as your own [tasks](sprout-syntax.md#tasks-functions).

## Numbers

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `abs(n)` | distance from zero | `abs(-7)` | `7` |
| `round(n)` | nearest whole number | `round(3.7)` | `4` |
| `floor(n)` | round down | `floor(3.7)` | `3` |
| `ceil(n)` | round up | `ceil(3.2)` | `4` |
| `sqrt(n)` | square root | `sqrt(144)` | `12` |
| `min(a, b, …)` | smallest | `min(3, 9, 5)` | `3` |
| `max(a, b, …)` | largest | `max(3, 9, 5)` | `9` |
| `random()` | a number from 0 up to 1 | `random()` | e.g. `0.4271` |
| `number(text)` | turn text into a number (`nothing` if it isn't one) | `number("42")` | `42` |

`min` and `max` take **two or more** numbers. `sqrt` of a negative number is a
friendly error.

## Asking the user (ask)

```sprout
make name = ask("What's your name?")
show "Hi,", name
make age = number(ask("How old are you?"))   ~ ask gives text; number() converts it
```

`ask("question")` prints the question and waits for a line typed at the console,
then hands back what was typed (as text). In a GUI/website app there's no
console, so `ask` gives back empty text — use a `field` widget there instead.

## Text

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `length(text)` | how many characters | `length("hello")` | `5` |
| `upper(text)` | UPPERCASE | `upper("hi")` | `"HI"` |
| `lower(text)` | lowercase | `lower("HI")` | `"hi"` |

## Lists & maps

See [Sprout Syntax](sprout-syntax.md#lists) for `[ ]`, `{ }`, indexing and
`for each`. These functions work on them:

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `length(coll)` | items in a list / keys in a map / letters in text | `length([1, 2, 3])` | `3` |
| `add(list, item)` | add an item to the end (changes the list) | `add(xs, 4)` | the list |
| `contains(coll, x)` | is `x` in the list, a key of the map, or inside the text? | `contains([1, 2], 2)` | `yes` |
| `keys(map)` | a list of the map's keys | `keys({a: 1, b: 2})` | `["a", "b"]` |
| `range(n)` / `range(a, b)` | a list of numbers `0..n-1` (or `a..b-1`) | `range(3)` | `[0, 1, 2]` |
| `first(list)` / `last(list)` | the first / last item (`nothing` if empty) | `first([9, 8])` | `9` |

## Saving data (remember / recall)

`remember` and `recall` save values that **last between runs** — no database, no
setup. Great for scores, settings, or a counter that doesn't reset.

| Function | What it does | Example |
| --- | --- | --- |
| `remember("key", value)` | save a value under a name | `remember("score", 100)` |
| `recall("key")` | read it back (`nothing` if unset) | `recall("score")` |
| `recall("key", default)` | read it back, or a default | `recall("score", 0)` |

```sprout
make score = recall("highScore", 0)
~ ... play the game ...
remember("highScore", score)
```

The data lives in a small JSON file next to your program — so a counter can
remember its value even after you close it.

## Talking to the internet (get / post)

Call any web address and use what comes back — no libraries, no setup.

| Function | What it does |
| --- | --- |
| `get("https://...")` | fetch a page or API and return its text |
| `post("https://...", body)` | send data and return the reply |
| `jsonpick(text, "key")` | pull a value out of a JSON reply (use `"a.b"` for nested keys) |
| `get_api_points(text)` | list the **field names** an API offers |
| `explore(text)` | like `get_api_points`, but shows each field's value too |

```sprout
make info = get("https://api.github.com/repos/fizzexual/Sprout-")
show "Stars:", jsonpick(info, "stargazers_count")
show explore(info)        ~ see everything else you could pick
```

**Verify & explore an API from the terminal:**

```bash
sprout api https://api.github.com/repos/fizzexual/Sprout-
```

It connects and prints every field with its path — so you know exactly what to
`jsonpick`.

## Secrets (secret)

A token or password must **never** be typed into your `.sprout` file — if you
share the file or push it to GitHub, the whole world can see it. `secret("NAME")`
fetches it from somewhere safe instead.

| Function | What it does |
| --- | --- |
| `secret("NAME")` | read a secret value, never written in your code |

It looks in two places, in order:

1. an **environment variable** called `NAME` (nothing on disk — the safest), then
2. a **`.env`** file next to your program:

```
~ .env  — this file is git-ignored, so it never reaches GitHub
DISCORD_TOKEN = your-real-token
```

Then your program just says:

```sprout
use "discord-bot"
bot(secret("DISCORD_TOKEN"))     ~ the token itself is nowhere in the code
```

If the secret is missing, Sprout tells you kindly and shows you exactly where to
put it. Just make a `.env` file next to your program with a line like
`DISCORD_TOKEN = your-value` (it stays off GitHub).

## Errors are friendly

Giving a builtin the wrong kind of value, or the wrong number of values, tells
you exactly what it wanted:

```
🌱 Oops — type problem on line 1:

  1 | show sqrt("nope")
    |      ^

  'sqrt' needs a number for the first value, but got text.
```

## See also

- [GUI & Servers](gui-and-servers.md) — the `window`, `label`, `button`, `field`,
  and `textof` functions for building apps.
