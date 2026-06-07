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

`min` and `max` take **two or more** numbers. `sqrt` of a negative number is a
friendly error.

## Text

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `length(text)` | how many characters | `length("hello")` | `5` |
| `upper(text)` | UPPERCASE | `upper("hi")` | `"HI"` |
| `lower(text)` | lowercase | `lower("HI")` | `"hi"` |

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

The data lives in a small JSON file next to your program. See
[`examples/savecounter.sprout`](../examples/savecounter.sprout) — a counter that
remembers its value after you close it.

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
`jsonpick`. See [`examples/internet.sprout`](../examples/internet.sprout).

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
