# Sprout — the interpreter (C) 🌱

This is **Sprout, written from scratch in C** — an interpreter that depends on
*nothing but the operating system*. No Node, no JavaScript, no runtime to install.
The same path Python (CPython) and Lua took.

> Sprout began life as a TypeScript-on-Node implementation. That has been **retired**
> in favour of this native C runtime — Sprout's *own* engine. The language is being
> rebuilt here one slice at a time (see the roadmap below); git history keeps the old
> TS version if it's ever needed.

## Build it

You need a C compiler **once** (to build). The `sprout.exe` it produces needs nothing.

```bat
winget install --id BrechtSanders.WinLibs.POSIX.UCRT   :: get gcc (one time)
build.cmd                                               :: -> sprout.exe
sprout.exe hello.sprout
```

Or directly: `gcc -O2 -Wall -s -o sprout.exe sprout.c -lm`

The result is a **~32 KB** native executable. It links only against `KERNEL32.dll`
and the Windows system C runtime (`api-ms-win-crt-*`) — both ship with Windows.

## What runs today (slices 1-4)

- Values: numbers, text, `yes` / `no`, `nothing`
- `make`, `set`, `show` (commas join with spaces)
- Math `+ - * / %` with precedence and `( )`; `+` also joins text
- Compare `== != < <= > >=`, logic `and` `or` `not`
- `when` / `orwhen` / `otherwise`
- `repeat N times`, `repeat while`
- `task` / `give`, function calls, **recursion**, lexical scope (a task sees globals + its own locals)
- Lists `[1, 2, 3]` and maps `{name: "Sam"}` — indexing `xs[0]` / `m["k"]`, `set xs[i] = …`, `for each x in …`, `range`
- Toolbox: `length` `add` `keys` `contains` `first` `last` `range` `sqrt` `abs` `round` `floor` `ceil` `min` `max` `random` `number` `upper` `lower` `trim` `replace` `split` `join` `now` `today` `wait` `ask`
- **Superpowers (built in):** `get(url)` (web), `json(text)` (parse to native lists/maps), `read`/`write`/`append`/`exists` (files), `run(command)` (shell)
- Comments (`~`), indentation-based blocks, friendly errors with line numbers

```sprout
task fib(n):
    when n < 2:
        give n
    give fib(n - 1) + fib(n - 2)

repeat 10 times:
    show "*"
show "fib(10) =", fib(10)
```

Run the smoke tests: `sprout.exe tests/core.sprout` and `sprout.exe tests/tasks.sprout`

## The roadmap (later slices)

1. ✅ **Core** — variables, math, text, `when`, `repeat`
2. ✅ **Tasks** — `task` / `give`, function calls, recursion, scope
3. ✅ **Collections** — lists `[...]`, maps `{...}`, indexing, `for each`, `range`
4. ✅ **Superpowers** — toolbox (math/text), files, web (`get`), JSON, `run`, `ask`
5. f-strings (`f"..."`) + `remember` / `recall` *(next)*
6. A small garbage collector (today memory is never freed — fine for short programs)
7. The GUI, the internet, libraries

Built from scratch, one slice at a time. 🌱
