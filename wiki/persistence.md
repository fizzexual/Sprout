# Persistence: remember / recall / forget

Save a value in one run and read it back in the next — Sprout's tiny built-in
key/value store. No database, no file handling, no JSON wrangling: `remember` a
name and a value, `recall` it later (even after the program has fully exited and
started again), and `forget` it when you're done. The whole thing lives in one
small file, `sprout.data.json`, in the folder you run from.

Every program on this page was run with the real interpreter, and each output
block below it is pasted **verbatim**.

New here? Start with [getting started](getting-started.md). For *every* built-in
see the [builtins reference](builtins-reference.md); for the error model see
[errors](errors.md).

## On this page

- [The 30-second version](#the-30-second-version)
- [`remember(key, value)` — save it](#rememberkey-value--save-it)
- [`recall(key)` — read it back](#recallkey--read-it-back)
- [`recall` of a missing key is `nothing`](#recall-of-a-missing-key-is-nothing)
- [`forget(key)` — remove it](#forgetkey--remove-it)
- [A real two-runs demo](#a-real-two-runs-demo)
- [What can be stored: every value kind round-trips](#what-can-be-stored-every-value-kind-round-trips)
- [Numbers round-trip *exactly*](#numbers-round-trip-exactly)
- [The store file: `sprout.data.json`](#the-store-file-sproutdatajson)
- [`recall` returns an independent copy](#recall-returns-an-independent-copy)
- [The read-modify-write pattern](#the-read-modify-write-pattern)
- [A persisted to-do list](#a-persisted-to-do-list)
- [Error cases](#error-cases)
- [The sandbox turns persistence off](#the-sandbox-turns-persistence-off)
- [Gotchas](#gotchas)
- [See also](#see-also)

---

## The 30-second version

```sprout
remember("score", 100)      ~ save a value under a name
show recall("score")        ~ read it back -> 100
forget("score")             ~ remove it
show recall("score")        ~ gone -> nothing
```

```
100
nothing
```

Three builtins, that's the whole feature:

| Call | Does | Gives back |
| --- | --- | --- |
| `remember(key, value)` | saves `value` under the name `key` (overwrites any old value) | `nothing` |
| `recall(key)` | reads the value saved under `key` | the value, or `nothing` if absent |
| `forget(key)` | removes `key` from the store | `yes` if it was there, `no` if it wasn't |

The `key` is always **text**. The value can be almost anything (see
[what can be stored](#what-can-be-stored-every-value-kind-round-trips)). The
magic part is that this survives between runs — close the program, run it again
tomorrow, and `recall` still has your value.

## `remember(key, value)` — save it

`remember` takes a **name** (text) and any **value**, and writes it to the store.
It returns `nothing` (it's a command — it acts, it doesn't compute a result).

```sprout
remember("greeting", "hello")
show "saved."
```

```
saved.
```

Calling `remember` again with the **same key overwrites** the old value — the
store holds one value per name:

```sprout
remember("k", "first")
remember("k", "second")
show recall("k")
```

```
second
```

## `recall(key)` — read it back

`recall` takes a name (text) and gives back whatever was saved there.

```sprout
remember("level", 7)
show recall("level")
```

```
7
```

That's it for the happy path. The interesting behaviour is what happens when the
name was never saved.

## `recall` of a missing key is `nothing`

This is the single most important rule of `recall`: **a name that was never
saved — or one you've since `forget`ten — gives back `nothing`.** It does not
error; it quietly returns the empty value.

```sprout
~ "never_set" was never remembered
show "raw:", recall("never_set")
show "is nothing?", recall("never_set") == nothing
show "with or else:", recall("never_set") or else "default"
```

```
raw: nothing
is nothing? yes
with or else: default
```

Because a missing key is `nothing`, the natural idiom is the
[`or else`](operators.md) nothing-coalescing operator to supply a default:

```sprout
make name = recall("name") or else "stranger"
show "Welcome,", name
```

```
Welcome, stranger
```

`recall("name") or else "stranger"` reads "the saved name, **or else** the word
stranger if there isn't one." This one line is the backbone of almost every real
use of persistence — see [the read-modify-write pattern](#the-read-modify-write-pattern).

## `forget(key)` — remove it

`forget` deletes a name from the store. Unlike the other two, it gives back a
useful answer: **`yes` if the name existed** (and was removed), **`no` if it
wasn't there** in the first place.

```sprout
remember("temp", 99)
show "before forget, recall:", recall("temp")
show "forget returns:", forget("temp")
show "after forget, recall:", recall("temp")
show "forget a missing key returns:", forget("temp")
```

```
before forget, recall: 99
forget returns: yes
after forget, recall: nothing
forget a missing key returns: no
```

So `forget` is also a clean "did this key exist?" check that cleans up as it goes.

## A real two-runs demo

Persistence only earns its name across **separate runs**. Here is a program that
counts how many times it has ever been run. Save it as `visits.sprout`:

```sprout
~ visits.sprout — counts how many times it has been run
make seen = recall("visits") or else 0
set seen = seen + 1
remember("visits", seen)
show "This program has run", seen, "time(s)."
```

Now run it three separate times, peeking at the store file in between:

```sh
sprout run visits.sprout      # run 1
cat sprout.data.json
sprout run visits.sprout      # run 2
sprout run visits.sprout      # run 3
cat sprout.data.json
```

```
This program has run 1 time(s).
{"visits":1}
This program has run 2 time(s).
This program has run 3 time(s).
{"visits":3}
```

The count is `1`, then `2`, then `3` — across three completely fresh runs of the
interpreter. Nothing was kept in memory between them; the number lives on disk in
`sprout.data.json`. That file is the whole store.

## What can be stored: every value kind round-trips

Persistence isn't limited to numbers. **Every Sprout value that *is* data
round-trips through the store** — numbers, text, `yes`/`no`, `nothing`, lists,
and maps (including nested ones). The one thing you can't store is a
[task](tasks-and-lambdas.md): a task is behaviour, not data, and it would come
back as `nothing`.

```sprout
~ every value kind round-trips through the store
remember("score", 42)
remember("pi", 1 / 3)
remember("name", "Sam")
remember("on", yes)
remember("nada", nothing)
remember("nums", [1, 2, 3])
remember("player", {"name": "Sam", "level": 3, "tags": ["x", "y"]})

show "score:", recall("score"), kind_of(recall("score"))
show "pi:", recall("pi")
show "pi * 3 ==", recall("pi") * 3
show "name:", recall("name")
show "on:", recall("on")
show "nada:", recall("nada"), kind_of(recall("nada"))
show "nums:", recall("nums")
show "player:", recall("player")
show "deep:", recall("player")["tags"][0]
```

```
score: 42 number
pi: 0.333333
pi * 3 == 1
name: Sam
on: yes
nada: nothing nothing
nums: [1, 2, 3]
player: {name: Sam, level: 3, tags: [x, y]}
deep: x
```

Notice the last line: a nested map-inside-a-map-with-a-list comes back fully
intact, so `recall("player")["tags"][0]` reaches all the way down to `"x"`.

## Numbers round-trip *exactly*

Look again at the `pi` line above. We stored `1 / 3` and `recall("pi") * 3` came
back as **exactly `1`** — not `0.999998` or some rounded-off near-miss.

That's deliberate, and it's a real subtlety. The way Sprout *displays* a number
(with `show`) is rounded for readability — that's why `recall("pi")` prints
`0.333333`. But the value the store writes to disk is the **full-precision**
number, so when you read it back you get the same double you put in. Sprout's
JSON writer is built from scratch precisely so it does **not** truncate to
display precision — it writes the shortest decimal that re-reads to the identical
value.

You can see it in the file itself. The `pi` key above is stored as:

```json
"pi":0.3333333333333333
```

— all 16 digits, not the 6 you see on screen. Store a fraction, recall it, and
arithmetic still works to the bit.

## The store file: `sprout.data.json`

The store is a single file named **`sprout.data.json`**, written in the folder
you run from. It's ordinary, human-readable JSON — you can open it, read it, even
hand-edit it (carefully). After the round-trip program above, the whole file is:

```json
{"score":42,"pi":0.3333333333333333,"name":"Sam","on":true,"nada":null,"nums":[1,2,3],"player":{"name":"Sam","level":3,"tags":["x","y"]}}
```

A few things this shows about how Sprout values map to JSON:

| Sprout value | In the file |
| --- | --- |
| number | a JSON number (full precision) |
| text | a JSON string |
| `yes` / `no` | `true` / `false` |
| `nothing` | `null` |
| list | a JSON array |
| map | a JSON object (keys keep their insertion order) |

A few facts worth knowing about the file:

- **It's per-folder.** Each working directory has its own `sprout.data.json`.
  Run a program in folder A and it can't see what was remembered in folder B —
  two separate stores. (Every program run in the *same* folder shares one store.)
- **It's created lazily.** `remember` and `forget` create/update it; a plain
  `recall` of a fresh folder never writes anything.
- **A missing or corrupt file reads as an empty store.** If `sprout.data.json`
  doesn't exist, or has been mangled into invalid JSON, Sprout treats it as if it
  were empty — `recall` returns `nothing` and the next `remember` writes a clean
  file. No crash:

```sprout
~ run this after deliberately corrupting sprout.data.json
show "recall on corrupt file:", recall("anything")
remember("fresh", 1)
show "now:", recall("fresh")
```

```
recall on corrupt file: nothing
now: 1
```

- **It's gitignored in real projects.** The store is local runtime data, not
  source — keep it out of version control.

## `recall` returns an independent copy

When you `recall` a list or a map, you get a **fresh, independent copy** — not a
live handle into the store. Changing what you got back does **not** change what's
saved. (This mirrors how [`copy`](builtins-reference.md) and the general
[shared-reference rules](collections.md) work for lists and maps.)

```sprout
remember("list", [1, 2, 3])
make mine = recall("list")
add(mine, 99)               ~ mutate my copy
show "my copy:", mine
show "the store still says:", recall("list")
```

```
my copy: [1, 2, 3, 99]
the store still says: [1, 2, 3]
```

The store stays `[1, 2, 3]` even though we added to `mine`. **To save a change,
you must `remember` it again** — there is no auto-sync. This is the safe default:
nothing you do to a recalled value can corrupt the store by accident.

## The read-modify-write pattern

Put the three rules together — *missing is nothing*, *recall is a copy*, *save by
remembering again* — and you get the one pattern you'll reach for constantly:

```sprout
make c = recall("counter") or else 0   ~ READ (default if absent)
set c = c + 1                          ~ MODIFY locally
remember("counter", c)                 ~ WRITE back
show "counter is now", c
```

```
counter is now 1
```

Run it again and it prints `2`, then `3`, and so on. **Read with a default,
change your local copy, remember it back.** That's persistence in three lines.

## A persisted to-do list

The same pattern with a list. Save it as `todo.sprout`:

```sprout
~ a to-do list that survives between runs
make items = recall("todo") or else []
add(items, "buy milk")
remember("todo", items)
show "you have", length(items), "item(s):"
for each item in items:
    show "  -", item
```

Run it twice:

```sh
sprout run todo.sprout      # run 1
sprout run todo.sprout      # run 2
```

```
you have 1 item(s):
  - buy milk
you have 2 item(s):
  - buy milk
  - buy milk
```

The list grows from one run to the next because `recall("todo")` reads back what
the previous run remembered. (`recall(...) or else []` gives an empty list the
very first time, before anything is saved.)

## Error cases

The store is forgiving — missing keys and bad files don't error. The only errors
are using the builtins **wrong**, and those are normal Sprout errors you can
[catch](errors.md).

**The key must be text.** Passing a number (or anything non-text) as the key is
an error:

```sprout
remember(42, "x")
```

```
  Sprout error in err.sprout (line 1): remember needs a name (text) and a value, like remember("score", 10).
```

**Wrong number of arguments** is an error too — `remember` needs two, `recall`
and `forget` need exactly one:

```sprout
show recall()
```

```
  Sprout error in err.sprout (line 1): recall needs a name (text), like recall("score").
```

Both stop the program with exit code `1`. As with any Sprout error you can wrap
the call in [`try` / `caught`](errors.md) and keep going. The caught value is the
usual error **map** `{message, kind, line}` — read its fields with `["..."]`:

```sprout
try:
    remember(42, "x")
caught e:
    show "kind:", e["kind"]
    show "message:", e["message"]
```

```
kind: error
message: remember needs a name (text) and a value, like remember("score", 10).
```

The `kind` here is `error` — the generic kind used for "you called a builtin
wrong" (argument count or argument type). If saving fails because the **disk
itself** won't accept the write, that's a different `io`-kind error
(`"I couldn't save to the data file (sprout.data.json)."`), but you'll rarely
meet it. See [errors](errors.md) for the full table of error kinds.

## The sandbox turns persistence off

Persistence touches your disk, so it's one of the outward-facing builtins the
**[sandbox](sandbox-and-playground.md)** closes. Running with `--sandbox` (or
`SPROUT_SANDBOX=1`) turns off `remember`, `recall`, **and** `forget` — alongside
the filesystem, network, and shell builtins. This protects a host that runs
untrusted code from having strangers read or scribble on its on-disk store.

```sprout
remember("x", 1)
```

```sh
sprout --sandbox run sb.sprout
```

```
  Sprout error in sb.sprout (line 1): 'remember' is turned off in sandbox mode — file, shell, and network access are disabled here.
```

The block is a normal catchable error (`kind` = `error`), so sandboxed code can
`try` it and fall back gracefully. Run the same file **without** `--sandbox` and
it works as shown everywhere else on this page. See
[sandbox & the playground](sandbox-and-playground.md) for the full list of what
the sandbox closes and why.

## Gotchas

- **Keys are text, values are nearly anything.** The key must always be a `"`
  text value. The value can be a number, text, `yes`/`no`, `nothing`, a list, or
  a map — but **not a task** (behaviour isn't data; it would come back as
  `nothing`).
- **Missing → `nothing`, not an error.** Always pair `recall` with
  `or else <default>` unless you genuinely want `nothing` for absent keys.
- **`recall` is a copy.** Mutating a recalled list/map doesn't save anything. To
  persist a change you must `remember` it back.
- **`remember` overwrites.** One value per key; the new value replaces the old.
- **The store is per-folder.** Different working directories have independent
  `sprout.data.json` files. Run from the same folder to share a store.
- **`show` rounds, the store doesn't.** A recalled number prints rounded but is
  stored at full precision, so arithmetic on recalled fractions is exact.
- **A missing/corrupt file is treated as empty** — no crash, just a fresh store
  on the next `remember`.
- **It's off under `--sandbox`.** Don't rely on persistence in sandboxed/
  playground code.

## See also

- [Built-in functions](builtins-reference.md) — the friendly tour of the whole builtin set
- [Builtins reference](builtins-reference.md) — the exact signatures of
  `remember` / `recall` / `forget` (and `copy`, `read`, `write`)
- [Operators](operators.md) — `or else`, the nothing-coalescing operator that
  pairs with `recall`
- [Collections](collections.md) — the shared-reference rules behind "recall
  returns a copy"
- [Errors](errors.md) — `try` / `caught`, the error map, and error kinds
- [Sandbox & the playground](sandbox-and-playground.md) — what `--sandbox` turns
  off, and why persistence is on that list
- [Tasks & lambdas](tasks-and-lambdas.md) — why a task is the one value you can't
  store
- [Cheatsheet](cheatsheet.md) — the one-page overview of the whole language
