# Built-in Functions

These come with Sprout — you can call them anywhere, no setup needed, like
`sqrt(16)` or `max(3, 9)`. They use the exact same `name(args)` syntax as your
own [tasks](sprout-syntax.md#tasks-functions), so once you've written a task
they'll feel completely familiar.

Every built-in checks its arguments and gives you the same friendly errors as
the rest of the language (see [Errors are friendly](#errors-are-friendly) at the
bottom).

Here's the whole toolbox, grouped by what it's for:

- [Numbers](#numbers) — `abs` `round` `floor` `ceil` `sqrt` `min` `max` `random` `number`
- [Text](#text) — `length` `upper` `lower`
- [Lists & maps](#lists--maps) — `length` `add` `contains` `keys` `range` `first` `last`
- [Asking the user](#asking-the-user-ask) — `ask`
- [Saving data](#saving-data-remember--recall) — `remember` `recall`
- [Talking to the internet](#talking-to-the-internet-get--post) — `get` `post` `jsonpick` `get_api_points` `explore`
- [Secrets](#secrets-secret) — `secret`

---

## Numbers

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `abs(n)` | distance from zero (drops the minus sign) | `abs(-7)` | `7` |
| `round(n)` | nearest whole number | `round(3.7)` | `4` |
| `floor(n)` | round down | `floor(3.7)` | `3` |
| `ceil(n)` | round up | `ceil(3.2)` | `4` |
| `sqrt(n)` | square root | `sqrt(144)` | `12` |
| `min(a, b, …)` | the smallest number | `min(3, 9, 5)` | `3` |
| `max(a, b, …)` | the largest number | `max(3, 9, 5)` | `9` |
| `random()` | a random number from 0 up to (but not including) 1 | `random()` | e.g. `0.4271` |
| `number(text)` | turn text into a number | `number("42")` | `42` |

A few friendly notes:

- `min` and `max` take **one or more** numbers — give them as many as you like.
- `sqrt` of a negative number is a kind error, not a crash.
- `number(...)` is perfect right after [`ask`](#asking-the-user-ask), because
  `ask` always hands you text. If the text isn't a number (like `"hello"` or
  `""`), `number(...)` gives back `nothing`. If you hand it a number already, you
  just get that number back.

```sprout
make answer = number("42") + 8
show answer                 ~ 50

make oops = number("banana")
show oops                   ~ nothing

~ random() is great for dice, shuffles, and games:
make roll = floor(random() * 6) + 1
show "You rolled a", roll
```

---

## Text

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `length(text)` | how many characters | `length("hello")` | `5` |
| `upper(text)` | make it UPPERCASE | `upper("hi")` | `"HI"` |
| `lower(text)` | make it lowercase | `lower("HI")` | `"hi"` |

```sprout
make name = "Sprout"
show upper(name)            ~ SPROUT
show length(name)          ~ 6
```

> `length` is a friendly multitasker — it also counts items in a list and keys
> in a map. See the next section.

---

## Lists & maps

Sprout writes lists as `[1, 2, 3]` and maps as `{name: "Sam", age: 9}`. For the
full story on `[ ]`, `{ }`, indexing, and `for each`, see
[Sprout Syntax](sprout-syntax.md#lists). These built-ins work on them:

| Function | What it does | Example | Result |
| --- | --- | --- | --- |
| `length(coll)` | items in a list, keys in a map, or letters in text | `length([1, 2, 3])` | `3` |
| `add(list, item)` | add an item to the end (this **changes** the list) | `add(xs, 4)` | the list |
| `contains(coll, x)` | is `x` in the list, a key of the map, or inside the text? | `contains([1, 2], 2)` | `yes` |
| `keys(map)` | a list of the map's keys | `keys({a: 1, b: 2})` | `["a", "b"]` |
| `range(n)` | the numbers `0` up to `n - 1` | `range(3)` | `[0, 1, 2]` |
| `range(a, b)` | the numbers `a` up to `b - 1` | `range(2, 5)` | `[2, 3, 4]` |
| `first(list)` | the first item (`nothing` if the list is empty) | `first([9, 8])` | `9` |
| `last(list)` | the last item (`nothing` if the list is empty) | `last([9, 8])` | `8` |

```sprout
make scores = [10, 20, 30]
add(scores, 40)            ~ scores is now [10, 20, 30, 40]
show length(scores)        ~ 4
show first(scores)         ~ 10
show last(scores)          ~ 40

~ range() pairs beautifully with "for each":
for each n in range(3):
    show n                 ~ 0, then 1, then 2

~ contains() works on lists, maps, AND text:
show contains(scores, 20)              ~ yes
show contains({name: "Sam"}, "name")   ~ yes  (checks the keys)
show contains("hello", "ell")          ~ yes
```

Good to know:

- `add` and `range` take exactly the values shown — `range` accepts **1 or 2**
  numbers, everything else here takes exactly the listed amount.
- `keys` only works on maps. `first` and `last` only work on lists.
- `range` uses whole numbers — decimals are rounded down first.

---

## Asking the user (ask)

```sprout
make name = ask("What's your name?")
show "Hi,", name

make age = number(ask("How old are you?"))   ~ ask gives text; number() converts it
show "Next year you'll be", age + 1
```

`ask("question")` prints the question, waits for a line typed at the console,
then hands back whatever was typed **as text**. The question is optional —
`ask()` just waits silently.

Because the answer is always text, wrap it in [`number(...)`](#numbers) whenever
you want to do math with it.

> **Caveat:** in a GUI window or a website app there's no console to type into,
> so `ask` simply gives back empty text (`""`). For those apps, collect input
> with a `field` widget instead — see [GUI & Servers](gui-and-servers.md).

---

## Saving data (remember / recall)

`remember` and `recall` save values that **last between runs** — no database, no
setup. Perfect for high scores, settings, or a counter that doesn't reset when
you close the program.

| Function | What it does | Example |
| --- | --- | --- |
| `remember("key", value)` | save a value under a name | `remember("score", 100)` |
| `recall("key")` | read it back (`nothing` if it was never saved) | `recall("score")` |
| `recall("key", default)` | read it back, or a default if it's missing | `recall("score", 0)` |

```sprout
make best = recall("highScore", 0)   ~ start at 0 the very first time
show "Best so far:", best
~ ... play the game, maybe beat it ...
remember("highScore", 150)
```

How it works: the values live in a small JSON file next to your program, so a
counter can remember its number even after you close and reopen it.

> **Caveat:** only simple values are saved — **numbers, text, and yes/no**.
> Trying to `remember` a list or a map quietly forgets that key instead of
> saving it. (You can always store a list as text and rebuild it on the way back
> if you need to.)

---

## Talking to the internet (get / post)

Call any web address and use what comes back — no libraries, no setup.

| Function | What it does | Example |
| --- | --- | --- |
| `get("https://...")` | fetch a page or API and return its text | `get("https://...")` |
| `post("https://...", body)` | send some text and return the reply | `post("https://...", "hi")` |
| `jsonpick(text, "key")` | pull one value out of a JSON reply | `jsonpick(info, "name")` |
| `get_api_points(text)` | list the **field names** an API offers | `get_api_points(info)` |
| `explore(text)` | like `get_api_points`, but shows each field's value too | `explore(info)` |

```sprout
make info = get("https://api.github.com/repos/fizzexual/Sprout-")
show "Stars:", jsonpick(info, "stargazers_count")
show explore(info)        ~ see everything else you could pick out
```

A few helpful details:

- **`jsonpick`** digs into nested JSON with dots: `jsonpick(info, "owner.login")`
  reaches inside `owner` to grab `login`. If the path isn't there (or the reply
  isn't JSON), you get `nothing`.
- **`get_api_points`** is your map of an API — it prints every field name
  (the path) you could read.
- **`explore`** is the same map, plus a preview of each value, so you can see
  what the data actually looks like before you pick it.
- `post` sends your text as the request body. The reply comes back as text, just
  like `get`.

> **Caveat:** `get` and `post` only work when you run your program with
> `sprout run`. In tests (or anywhere the internet isn't available) they give a
> friendly "the internet isn't available here" message. Requests time out after
> about 20 seconds.

### Verify & explore an API from the terminal

You don't even need to write a program to peek at an API. From your terminal:

```bash
sprout api https://api.github.com/repos/fizzexual/Sprout-
```

It connects, then prints **every field with its path** — exactly the path you'd
hand to `jsonpick`. It's the quickest way to learn what an API gives you before
you wire it into your code.

---

## Secrets (secret)

A token or password must **never** be typed into your `.sprout` file — if you
share the file or push it to GitHub, the whole world can see it. `secret("NAME")`
fetches it from somewhere safe instead.

| Function | What it does | Example |
| --- | --- | --- |
| `secret("NAME")` | read a secret value that's never written in your code | `secret("DISCORD_TOKEN")` |

It looks in two places, in this order:

1. an **environment variable** called `NAME` (nothing on disk — the safest), then
2. a **`.env`** file sitting next to your program:

```
~ .env  — this file is git-ignored, so it never reaches GitHub
DISCORD_TOKEN = your-real-token
```

Then your program just uses it by name — the token itself is nowhere in the code:

```sprout
use "discord-bot"
bot(secret("DISCORD_TOKEN"))     ~ the real token stays out of your file
```

If the secret is missing, Sprout tells you kindly and shows you exactly where to
put it: make a `.env` file next to your program with a line like
`DISCORD_TOKEN = your-value`, or set `DISCORD_TOKEN` as an environment variable.
Either way, it stays off GitHub.

> Tip: in a `.env` file, quotes around the value are optional, and a line
> starting with `~` or `#` is treated as a comment.

---

## Errors are friendly

Give a built-in the wrong **kind** of value, or the wrong **number** of values,
and Sprout tells you exactly what it wanted — pointing right at the spot:

```
🌱 Oops — type problem on line 1:

  1 | show sqrt("nope")
    |      ^

  'sqrt' needs a number for the first value, but got text.
```

Many errors even come with a hint, like a tiny example of how to call the
function correctly. You'll never be left guessing.

---

## See also

- [Sprout Syntax](sprout-syntax.md) — `make`, `show`, `for each`, lists, maps,
  and how to write your own tasks.
- [GUI & Servers](gui-and-servers.md) — the `window`, `label`, `button`,
  `field`, and `textof` functions for building windowed and web apps.
