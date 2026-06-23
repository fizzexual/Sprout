# Getting Started

Sprout is an interpreter written in C. You build it once into a tiny `sprout`
executable, then use that to run your `.sprout` programs. The executable needs
nothing installed to run.

## 0. Or just download it (no compiler needed)

The quickest way: grab a prebuilt binary for your OS from the
[**Releases**](https://github.com/fizzexual/Sprout/releases) page — `sprout-linux-x86_64`,
`sprout-macos-arm64`, or `sprout-windows-x86_64.exe`. Rename it to `sprout` (or `sprout.exe`),
put it on your `PATH`, and you're done — skip straight to step 3. To build from source instead,
read on.

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
# or build by hand:
gcc -O2 -Wall -s -Wl,--stack,67108864 -o sprout.exe sprout.c -lm -lurlmon   # Windows
cc  -O2 -Wall -o sprout sprout.c -lm                                         # macOS / Linux
```

This produces a **~175 KB** `sprout` executable that links only against the
operating system's own libraries. (On Windows the `-lurlmon` library powers the
network builtins, and the larger stack lets the interpreter report "nested too
deeply" cleanly instead of crashing on pathologically deep input.)

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
