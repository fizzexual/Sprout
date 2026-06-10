# Sprout, natively 🌱

This folder is the **native rewrite of Sprout in C** — a `sprout` interpreter that
depends on *nothing but the operating system*. No Node, no JavaScript, no runtime
to install. The same path Python (CPython) and Lua took.

> The main interpreter (in [`../src`](../src)) is written in TypeScript and runs on
> Node. That's how Sprout grows new features fastest. This native build is the
> long-term goal: Sprout's *own* runtime. We're porting it one slice at a time.

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

## What runs today (slice 1 — the core language)

- Values: numbers, text, `yes` / `no`, `nothing`
- `make`, `set`, `show` (commas join with spaces)
- Math `+ - * / %` with precedence and `( )`; `+` also joins text
- Compare `== != < <= > >=`, logic `and` `or` `not`
- `when` / `orwhen` / `otherwise`
- `repeat N times`, `repeat while`
- Comments (`~`), indentation-based blocks, friendly errors with line numbers

```sprout
make score = 5
when score > 8:
    show "great"
orwhen score == 5:
    show "okay"
repeat 3 times:
    show "*"
```

Run the smoke test: `sprout.exe tests/core.sprout`

## The roadmap (later slices)

1. ✅ **Core** — variables, math, text, `when`, `repeat` *(this slice)*
2. `task` / `give`, function calls, recursion
3. Lists `[...]`, maps `{...}`, indexing, `for each`, `range`
4. f-strings (`f"..."`), the built-in toolbox (`length`, `upper`, `sqrt`, ...)
5. `ask` / input, `remember` / `recall`
6. A small garbage collector (today memory is never freed — fine for short programs)
7. The GUI, the internet, libraries

Built from scratch, one slice at a time. 🌱
