<p align="center">
  <img src="images/banner.png" alt="Sprout" width="100%" />
</p>

<h1 align="center">🌱 Sprout</h1>

<p align="center">A small, friendly programming language — built from scratch, with zero dependencies.</p>

<p align="center">
  <a href="https://github.com/fizzexual/Sprout/releases/latest"><img src="https://img.shields.io/badge/version-0.6.1-2ea043?style=flat-square" alt="version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?style=flat-square" alt="zero dependencies" />
</p>

<p align="center">
  <a href="https://github.com/fizzexual/Sprout/releases/latest">Download</a> ·
  <a href="wiki/README.md">Docs</a> ·
  <a href="wiki/cheatsheet.md">Cheat sheet</a> ·
  <a href="wiki/architecture.md">How it works</a>
</p>

---

Sprout is a **real** interpreted language — its own lexer, parser, and tree-walking
interpreter, no transpiling and no dependencies. It has one goal: **be the kindest
language to learn programming with.**

Where most languages throw cryptic errors, Sprout points at the exact spot and
explains it in plain English:

```
🌱 Oops — name problem on line 2:

  2 | show "Hi, " + nme
    |               ^

  I don't know what 'nme' is.

  💡 Did you mean 'name'?
```

## Hello, Sprout

```sprout
make name = "world"
show f"Hello, {name}!"
```

```bash
sprout run hello.sprout
```

Sprout has its own vocabulary — `make`, `set`, `show`, `when`, `repeat`, `task` —
it doesn't borrow `let`, `print`, or `if` from anyone.

## Why Sprout

- 🧠 **The kindest errors** — every mistake points at the spot and explains it, often with a fix.
- 📦 **Zero dependencies** — a real language in a handful of small files; nothing from npm to run it.
- ⚡ **Two engines, one language** — an instant interpreter *and* a compile-to-JavaScript mode that's **faster than Python**. Same `.sprout` file, your choice.
- 📤 **Ship a single `.exe`** — `sprout build` bundles your program so it runs on a PC with **no Node and no Sprout** installed.
- 🪟 **Apps & websites** — the same code runs as a native window *or* a website, styled with **Bloom** (Sprout's own CSS).
- 🌐 **Batteries included** — save data, call any API, keep secrets safe, and add powers with libraries (`discord-bot`, `networking`, `automations`).
- 🛠️ **A native runtime in the works** — Sprout is being reimplemented in C so it can run with no Node at all (see [`native/`](native)).

## Install

**Windows** — download [`SproutSetup.exe`](https://github.com/fizzexual/Sprout/releases/latest/download/SproutSetup.exe) and run the wizard. It registers the `sprout` command, file types, and shortcuts.

**From source** (any OS, needs Node 23.6+) — Sprout runs its TypeScript directly, so there's no build step:

```bash
git clone https://github.com/fizzexual/Sprout.git
cd Sprout
npm link
```

## Commands

```
sprout run file.sprout          run a program
sprout fast file.sprout         run it compiled to JavaScript (faster than Python)
sprout build file.sprout        build an .exe (asks how): a no-Node standalone, or a tiny needs-Node one
sprout bench file.sprout        time it on both engines and compare
sprout gui file.sprout          open it as a native window
sprout serve file.sprout        run it as a website
sprout check file.sprout        verify it without running
sprout explain file.sprout      run it and narrate each step
sprout trace file.sprout        step through it line-by-line, watching variables
sprout new myapp                create a starter program
sprout modules                  install / browse libraries
sprout repl                     interactive prompt
```

## How fast is it?

Sprout has **two engines for the same language**: `sprout run` (a tuned
tree-walking interpreter — instant, friendliest errors) and `sprout fast` /
`sprout build` (compiles to JavaScript and runs on V8 — **faster than Python**).

Best-of-5 wall-clock, one machine (Node 25). Same three programs in each language:

| Benchmark | `sprout run` | **`sprout build`** | Python 3.11 | Node (JS) | Go | Java 21 |
| --- | --- | --- | --- | --- | --- | --- |
| Recursion — `fib(30)` | 0.89s | **0.15s** | 0.25s | 0.09s | 0.03s | 0.10s |
| Tight loop — 5,000,000× | 0.77s | **0.16s** | 0.62s | 0.10s | 0.03s | 0.10s |
| Primes — < 80,000 | 0.65s | **0.18s** | 0.22s | 0.09s | 0.04s | 0.11s |

Compiled Sprout beats CPython on every benchmark. Measure your own code with
`sprout bench yourfile.sprout`. Reproduce: [`benchmarks/`](benchmarks).

## How it works

```
source → lexer → parser → checker → [ interpreter | compiler ] → output
```

A small, dependency-free pipeline shared by both engines — and a from-scratch C
runtime taking shape in [`native/`](native). The full tour is in
**[How Sprout Works](wiki/architecture.md)**.

## Documentation

The **[wiki](wiki/README.md)** teaches the whole language and Bloom; the
[cheat sheet](wiki/cheatsheet.md) is the one-page tour, and
[How Sprout Works](wiki/architecture.md) is the architecture. A **VS Code
extension** ([`vscode-extension/`](vscode-extension)) adds highlighting, snippets,
and run buttons. Tests run with `npm test` — still zero dependencies.

---

<p align="center"><sub>Made from scratch, one slice at a time. 🌱</sub></p>
