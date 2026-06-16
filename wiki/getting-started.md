# Getting Started

Sprout is an interpreter written in C. You build it once into a tiny `sprout`
executable, then use that to run your `.sprout` programs. The executable needs
nothing installed to run.

## 1. Get a C compiler (one time)

You only need this to *build* Sprout — not to run it.

**Windows** (gcc via WinLibs):

```bash
winget install --id BrechtSanders.WinLibs.POSIX.UCRT
```

**macOS / Linux** already have a C compiler (`cc` / `gcc` / `clang`).

## 2. Build the interpreter

```bash
git clone https://github.com/fizzexual/Sprout.git
cd Sprout/src
build.cmd          # Windows
# or, any OS:
gcc -O2 -Wall -s -o sprout.exe sprout.c -lm
```

This produces a **~34 KB** `sprout` executable that links only against the
operating system's own libraries.

## 3. Write your first program

Create `hello.sprout`:

```sprout
make name = "world"
show "Hello, " + name + "!"
```

Run it:

```bash
sprout.exe hello.sprout
```

```
Hello, world!
```

## What if I make a mistake?

Sprout tries to explain problems in plain English and tell you which line:

```
  Sprout error (line 2): I don't know what 'nme' is.
```

## Next

- The **[Cheat Sheet](cheatsheet.md)** — the whole language on one page.
- **[Sprout Syntax](syntax-basics.md)** — every part, explained slowly.
- Try the smoke tests that ship with the source: `sprout.exe tests/core.sprout`.
