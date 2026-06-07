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
