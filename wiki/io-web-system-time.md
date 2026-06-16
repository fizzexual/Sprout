# Files, web, system & time

How a Sprout program talks to the world: reading and writing files, fetching
web pages and APIs, running shell commands, telling the time, and adding colour
to your output — all built in, no libraries.

These are the parts of Sprout that reach *outside* the program. That power is
real, so a single flag (`--sandbox`) can switch every one of them off when you
host strangers' code. See [sandbox & playground](sandbox-and-playground.md).

## On this page

- [Files: read, write, append, exists](#files-read-write-append-exists)
- [Web: get, json, explore](#web-get-json-explore)
- [The `sprout api` command](#the-sprout-api-command)
- [System: use system → system.run](#system-use-system--systemrun)
- [Time: now, today, wait](#time-now-today-wait)
- [Output colour: color](#output-colour-color)
- [What `--sandbox` turns off](#what---sandbox-turns-off)
- [Quick reference](#quick-reference)
- [See also](#see-also)

A note on the examples: every complete program below was run with the real
interpreter, and the output block under it is its actual output. A few use the
clock or the live network, so those exact numbers will differ when you run them
— that's called out where it matters.

---

## Files: read, write, append, exists

Four builtins cover everyday file work. They all take a **file path as text**,
relative to wherever you run the program from.

| Call | Does | Returns |
| --- | --- | --- |
| `read(path)` | the file's whole contents as text | the text, or `nothing` if the file is missing/unreadable |
| `write(path, text)` | write `text`, **replacing** the file | `nothing` |
| `append(path, text)` | add `text` to the **end** of the file | `nothing` |
| `exists(path)` | is there a readable file there? | `yes` / `no` |

`write` and `append` create the file if it doesn't exist. `write` truncates an
existing file; `append` keeps what's already there. The value you pass is
stringified the same way `show` prints it, so you can hand them numbers, lists,
or maps and you'll get their text form.

Here's a full round-trip — write a file, check it's there, append to it, read it
back, then look for one that doesn't exist:

```sprout
write("note.txt", "remember the milk")
show exists("note.txt")
append("note.txt", "\nand the eggs")
show read("note.txt")
show exists("nope.txt")
show read("nope.txt")
```

```
yes
remember the milk
and the eggs
no
nothing
```

### Reading a missing file is not an error

`read` returns `nothing` when the file isn't there — it doesn't fail. That makes
"load it if it exists, otherwise start fresh" a one-liner with
[`or else`](operators.md):

```sprout
make saved = read("config.txt") or else "default settings"
show saved
```

```
default settings
```

### Gotchas and edge cases

- **A folder is not a file.** `read("some_folder")` gives `nothing`, and
  `exists("some_folder")` gives `no` — these builtins only see regular files.

  ```sprout
  show read("adir")
  show exists("adir")
  ```

  ```
  nothing
  no
  ```

- **Writing where you can't is a catchable `io` error.** If the folder doesn't
  exist (or you lack permission), `write`/`append` raise the `io` error kind,
  which you can `try`/`caught` like any other (see [errors](errors.md)):

  ```sprout
  try:
      write("nodir/x.txt", "hi")
  caught e:
      show e["kind"], "-", e["message"]
  ```

  ```
  io - I couldn't open that file to write.
  ```

- **Wrong argument shape is a plain error.** `read(42)` or `write("f")` (missing
  the text) fail with a friendly message — paths must be text, and `write`/
  `append` need exactly two arguments.

> Looking for *persistence* without managing file paths yourself? Sprout also has
> `remember` / `recall` / `forget`, a per-folder key/value store kept in
> `sprout.data.json`. Those are covered in [builtins reference](builtins-reference.md).

---

## Web: get, json, explore

Three builtins turn Sprout into an HTTP + JSON client with no setup at all.

| Call | Does | Returns |
| --- | --- | --- |
| `get(url)` | fetch a web page or API over HTTP(S) | the response **body as text**, or `nothing` if the request fails |
| `json(text)` | parse JSON text into Sprout lists & maps | a native value (map / list / text / number / `yes`/`no` / `nothing`) |
| `explore(value)` | flatten a value into a list of `path = value` lines | a list of text lines |

The classic pattern is `json(get(url))` — fetch, then parse — and from there the
result is an ordinary Sprout map you index with `["key"]`.

### get + json against a live API

This one hits the live GitHub API (so it needs a network connection; the names
will be whatever the repo says today):

```sprout
make repo = json(get("https://api.github.com/repos/fizzexual/Sprout"))
show repo["name"], "by", repo["owner"]["login"]
```

```
Sprout by fizzexual
```

If the request can't be made — no network, a bad host, a non-2xx response —
`get` returns `nothing` rather than crashing, so you can guard it:

```sprout
make body = get("https://example.invalid/nope")
show "unreachable gives:", body
```

```
unreachable gives: nothing
```

A robust fetch checks for that:

```sprout
make body = get("https://example.invalid/nope")
when body == nothing:
    show "couldn't reach the server"
otherwise:
    show json(body)["whatever"]
```

```
couldn't reach the server
```

### json works offline too

`json` is just a parser — it takes **any** JSON text, whether from `get`, a
file, or a literal string. (Inside Sprout text you escape the inner quotes with
`\"`.)

```sprout
make person = json("{\"name\": \"Sam\", \"pets\": [\"cat\", \"dog\"], \"age\": 3}")
show person["name"]
show person["pets"][0]
show person["age"]
```

```
Sam
cat
3
```

### explore — see everything inside a value

`explore(value)` returns a **list** where each item is a `path = value` line,
one per leaf in the structure. It's how you discover what an API gives you
without printing a wall of raw JSON. If you hand `explore` a JSON **string**, it
parses it for you first.

```sprout
make person = json("{\"name\": \"Sam\", \"pets\": [\"cat\", \"dog\"], \"age\": 3}")
for each field in explore(person):
    show field
```

```
name = Sam
pets[0] = cat
pets[1] = dog
age = 3
```

Because it returns a real list, you can filter it like any other — e.g. only the
paths that mention `pet`:

```sprout
make person = json("{\"name\": \"Sam\", \"pets\": [\"cat\", \"dog\"]}")
for each field in explore(person):
    when contains(field, "pet"):
        show field
```

```
pets[0] = cat
pets[1] = dog
```

---

## The `sprout api` command

`explore(json(get(url)))` is so handy for poking at an API that there's a CLI
shortcut for it. From your terminal:

```
sprout api <url>
```

It fetches the URL, parses the JSON, and prints every `path = value` field — the
same flattening `explore` does, but straight from the command line with no
program to write. Running it against the GitHub repo above produces (trimmed):

```
  https://api.github.com/repos/fizzexual/Sprout
  106 readable fields:

    id = 1261582443
    name = Sprout
    full_name = fizzexual/Sprout
    private = no
    owner.login = fizzexual
    owner.html_url = https://github.com/fizzexual
    ...
```

So: **`explore` is the function**, **`sprout api` is the one-line command** that
fetches a URL and prints `explore`'s output. Use the command to discover an
endpoint's fields, then reach for them by name in a program with `["..."]`.

See [the CLI overview](getting-started.md) for the rest of the `sprout`
commands.

---

## System: use system → system.run

Running an OS command is the most powerful thing a program can do, so Sprout
keeps it **explicit**. It lives in a built-in module you have to opt into:

```sprout
use system
make out = system.run("echo hello from the shell")
show trim(out)
```

```
hello from the shell
```

`system.run(command)` runs the command through your shell and returns whatever it
printed (its standard output) as **text**. The raw output usually ends with the
shell's newline, so `trim` is handy. Because it's just text, you can search it,
split it, or test it like anything else:

```sprout
use system
show contains(system.run("echo abc"), "abc")
```

```
yes
```

The rules:

- **`use system` is required.** Calling `system.run(...)` without it is a name
  error telling you to add the `use` line. The module name and the function name
  are separated by **one dot** — `system.run`.
- **It takes exactly one piece of text** — the command line. `system.run(42)` or
  `system.run("a", "b")` fail with a clear message.
- **`run` on its own is not a builtin.** Writing `run("...")` (no `system.`)
  gives a message pointing you to `use system` then `system.run(...)`.
- **The command runs in your real shell** (`cmd`/`sh`), so it inherits your
  working directory and environment. With great power, etc. — this is exactly why
  `--sandbox` removes the whole module.

`system` is the only built-in module. User-written modules work the same
`module.name` way after `use <file>` — see [modules & projects](modules-and-projects.md).

---

## Time: now, today, wait

Three builtins for the clock. `now` and `today` take **no arguments** and return
**text** (not a number) in a fixed, sortable format. `wait` pauses.

| Call | Does | Returns |
| --- | --- | --- |
| `now()` | the current date **and** time | text, `YYYY-MM-DD HH:MM:SS` (19 chars) |
| `today()` | just the current date | text, `YYYY-MM-DD` (10 chars) |
| `wait(seconds)` | pause for `seconds` (fractions allowed) | `nothing` |

```sprout
show "today is", today()
make stamp = now()
show "length of now():", length(stamp)
show "first 10 chars match today:", slice(stamp, 0, 10) == today()
show "pausing half a second..."
wait(0.5)
show "done"
```

```
today is 2026-06-16
length of now(): 19
first 10 chars match today: yes
pausing half a second...
done
```

(The date will be whatever day you run it — the *shape* is what's guaranteed.)

Notes:

- The format is **local time**, in `YYYY-MM-DD HH:MM:SS` order — which means it
  also **sorts correctly as plain text**. Two timestamps compare with `<` / `>`
  the way you'd expect, and `slice(now(), 0, 10)` gives you the same string as
  `today()`.
- `wait` accepts fractions of a second (`wait(0.5)`) and treats `0` or a negative
  number as "don't pause." It needs exactly one number — `wait("soon")` fails.
- These are *text*, not numbers, so you can't subtract two `now()` values to get a
  duration. They're for timestamps and display.

### Time + files: a tiny timestamped logger

The pieces compose. Here `append` and `now` build a real log file:

```sprout
task log(line):
    append("app.log", now() + "  " + line + "\n")

log("server started")
log("user signed in")
show read("app.log")
```

```
2026-06-16 19:47:28  server started
2026-06-16 19:47:28  user signed in
```

(Your timestamps will be the moment you run it.)

---

## Output colour: color

`color(name, text)` wraps `text` in a terminal colour and returns the wrapped
**text** — it doesn't print anything itself, so you `show` the result (or join it
into a bigger string).

```sprout
show color("green", "done!")
show color("red", "error") + " " + color("yellow", "warn")
```

When you run that in a terminal you see **done!** in green, **error** in red and
**warn** in yellow. Under the hood it's wrapping the text in ANSI escape codes —
the actual bytes produced are:

```
␛[32mdone!␛[0m
␛[31merror␛[0m ␛[33mwarn␛[0m
```

(`␛[32m` turns green on, `␛[0m` turns it back off.) That means if you pipe the
output to a file or a tool that doesn't understand colour, you'll see those codes
literally — colour is for the terminal.

The colour names are a fixed set:

| Category | Names |
| --- | --- |
| Colours | `red` `green` `yellow` `blue` `magenta` (also `purple`) `cyan` `white` `gray` (also `grey`) |
| Styles | `bold` `dim` |

An unknown name like `color("rainbow", "hi")` is a (catchable) error listing the
valid names. Both arguments must be text.

---

## What `--sandbox` turns off

If you ever run **untrusted** code (a web playground, a "try it" box, a bot that
executes user snippets), pass `--sandbox` on the command line, or set the
environment variable `SPROUT_SANDBOX=1`. It switches off every outward-facing
builtin on this page:

| Turned off in sandbox mode | Why |
| --- | --- |
| `read` `write` `append` `exists` | filesystem access |
| `remember` `recall` `forget` | the on-disk key/value store |
| `get` `explore` | the network (and SSRF) |
| the **whole `system` module** (`system.run`) | shell / OS access |
| `use <file>` | loading other files from disk |

Everything else — math, text, lists, maps, tasks, `match`, the pipe, **and the
time builtins `now`/`today`/`wait` and `color`** — keeps working normally. Each
blocked call is a **clear, catchable error**, so a playground can show a friendly
message instead of crashing:

```sprout
try:
    write("x.txt", "hi")
caught e:
    show e["kind"], "-", e["message"]
```

Run with `--sandbox`, that prints:

```
error - 'write' is turned off in sandbox mode — file, shell, and network access are disabled here.
```

And `system.run` under `--sandbox`:

```sprout
use system
try:
    show system.run("echo hi")
caught e:
    show e["kind"], "-", e["message"]
```

```
error - the 'system' module is turned off in sandbox mode — no shell access here.
```

> **The flag is necessary but not sufficient.** It closes the *language's*
> outward doors, but it can't cap CPU, memory, or output — a program can still
> loop forever. A real host must also run each submission as a short-lived,
> resource-limited process. The full story (plus the Docker playground) is in
> [sandbox & playground](sandbox-and-playground.md).

---

## Quick reference

```sprout
~ Files
write(path, text)      ~ replace the file (creates it); -> nothing
append(path, text)     ~ add to the end (creates it);   -> nothing
read(path)             ~ contents as text, or nothing if missing
exists(path)           ~ yes / no

~ Web
get(url)               ~ HTTP body as text, or nothing on failure
json(text)             ~ JSON text -> Sprout map/list/...
explore(value)         ~ list of "path = value" lines (parses JSON text too)

~ System (opt in first)
use system
system.run(command)    ~ run a shell command, return its output as text

~ Time
now()                  ~ "YYYY-MM-DD HH:MM:SS"  (text)
today()                ~ "YYYY-MM-DD"           (text)
wait(seconds)          ~ pause (fractions ok);  -> nothing

~ Output
color(name, text)      ~ text wrapped in a terminal colour
```

CLI shortcut: `sprout api <url>` = fetch + parse + print every field.

Errors you may catch here (`caught e` gives a map `{message, kind, line}`):

| `kind` | When |
| --- | --- |
| `io` | `write`/`append` couldn't open the file |
| `error` | wrong argument shape/count; an unknown `color`; a sandbox-blocked call |
| `name` | calling `system.run` without `use system` (a hard error) |

See [errors](errors.md) for the full error model and the `try` / `caught` /
`fail` keywords.

---

## See also

- [Builtins reference](builtins-reference.md) — every builtin, including the
  `remember` / `recall` / `forget` store
- [Collections](collections.md) — working with the lists & maps `json` returns
- [Text](text.md) — `trim`, `split`, `contains`, `slice`, f-strings for shaping
  command output and file contents
- [Operators](operators.md) — `or else` for "value or a default", `|>` for
  piping a fetched value through tasks
- [Tasks & lambdas](tasks-and-lambdas.md) — wrapping these into reusable actions
- [Errors](errors.md) — catching `io` and the rest
- [Sandbox & playground](sandbox-and-playground.md) — running untrusted code
- [Getting started](getting-started.md) · [Cheat sheet](cheatsheet.md) ·
  [How Sprout works](architecture.md)
