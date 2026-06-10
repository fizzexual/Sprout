<p align="center">
  <img src="images/banner.png" alt="Sprout" width="100%" />
</p>

<h1 align="center">🌱 Sprout</h1>

<p align="center"><b>The programming language that's kind to beginners.</b><br/>
Plain-English code, errors that actually help, and zero dependencies.</p>

<p align="center">
  <a href="https://github.com/fizzexual/Sprout/releases/latest"><img src="https://img.shields.io/badge/version-0.6.1-2ea043?style=flat-square" alt="version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/dependencies-0-2ea043?style=flat-square" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/built-from%20scratch-2ea043?style=flat-square" alt="built from scratch" />
</p>

<p align="center">
  <a href="https://github.com/fizzexual/Sprout/releases/latest">Download</a> ·
  <a href="wiki/getting-started.md">Get started</a> ·
  <a href="wiki/cheatsheet.md">Cheat sheet</a> ·
  <a href="wiki/architecture.md">How it works</a>
</p>

---

Most people quit programming in the first week — not because it's too hard, but
because the error messages are cruel. `SyntaxError: unexpected token` teaches you
nothing.

**Sprout is built around one idea: a language should help you learn it.** It's a
real, from-scratch interpreted language — its own lexer, parser, and interpreter,
no transpiling and nothing from npm — with the friendliest errors of any language.

When something's wrong, Sprout points at the exact spot and explains it like a
patient teacher:

```
🌱 Oops — name problem on line 2:

  2 | show "Hi, " + nme
    |               ^

  I don't know what 'nme' is.

  💡 Did you mean 'name'?
```

## Code you can read out loud

Sprout has its **own** vocabulary — `make`, `show`, `when`, `repeat`, `task` — so a
beginner can guess what a program does just by reading it. No `let`, no `print`,
no `if`.

```sprout
make name = "Sam"
make score = 8
show f"Nice work, {name} — you scored {score}/10!"

when score >= 9:
    show "outstanding 🌟"
orwhen score >= 7:
    show "great job"
otherwise:
    show "keep going"

task greet(who):
    give f"Hello, {who}!"

show greet("world")
```

```bash
sprout run hello.sprout
```

## What you get

- 🧠 **Errors that teach** — every mistake points at the spot, explains it in plain English, and often suggests the fix.
- 📦 **Zero dependencies** — a complete language in a handful of small files. Nothing to `npm install` to run it.
- ⚡ **Two engines, one language** — an instant interpreter for learning, and a compile-to-JavaScript mode that's **faster than Python**. Same file, your choice.
- 📤 **Ship a single `.exe`** — turn any program into one file that runs on a PC with **no Node and no Sprout** installed. Send it to a friend.
- 🪟 **Apps & websites** — the same code runs as a native desktop window *or* a website, styled with **Bloom** (Sprout's own mini-CSS).
- 🔌 **Real powers** — save data, call any web API, keep secrets out of your code, and add libraries (`discord-bot`, `networking`, `automations`).
- 🛠️ **Going native** — Sprout is being rebuilt in C so it can one day run with no Node at all ([`native/`](native)).

## Get started

**Windows** — download [`SproutSetup.exe`](https://github.com/fizzexual/Sprout/releases/latest/download/SproutSetup.exe) and run the wizard. It sets up the `sprout` command, file icons, and shortcuts.

**Any OS** (needs Node 23.6+) — Sprout runs its source directly, so there's no build step:

```bash
git clone https://github.com/fizzexual/Sprout.git
cd Sprout
npm link
sprout new myapp        # scaffold a starter program
sprout run myapp.sprout
```

## Fast when you need it

The same `.sprout` file runs two ways, and you choose per run:

- **`sprout run`** — a tree-walking interpreter. Instant, with the friendliest errors. The default for learning.
- **`sprout fast` / `sprout build`** — compiles your program to JavaScript on V8. **Beats CPython on every benchmark.**

<sub>Best-of-5 wall-clock, one machine (Node 25) — the same three programs in each language:</sub>

| Benchmark | `sprout run` | **`sprout build`** | Python 3.11 | Node | Go |
| --- | --- | --- | --- | --- | --- |
| `fib(30)` | 0.89s | **0.15s** | 0.25s | 0.09s | 0.03s |
| loop ×5,000,000 | 0.77s | **0.16s** | 0.62s | 0.10s | 0.03s |
| primes < 80,000 | 0.65s | **0.18s** | 0.22s | 0.09s | 0.04s |

Measure your own code with `sprout bench yourfile.sprout`. Reproduce: [`benchmarks/`](benchmarks).

## A taste of the commands

```
sprout run file.sprout       run a program            sprout build file.sprout   bundle it into one .exe
sprout fast file.sprout      run it compiled          sprout gui file.sprout     open it as a window
sprout check file.sprout     verify without running   sprout serve file.sprout   run it as a website
sprout explain file.sprout   narrate each step        sprout trace file.sprout   step through it live
sprout new myapp             start a new program      sprout modules             browse libraries
```

## Learn more

The **[wiki](wiki/README.md)** teaches the whole language and Bloom from scratch.
Start with the **[one-page cheat sheet](wiki/cheatsheet.md)**, or read
**[How Sprout Works](wiki/architecture.md)** to see the pipeline, the two engines,
and the native runtime under the hood. There's a **[VS Code extension](vscode-extension)**
too, and the test suite runs with `npm test` — still zero dependencies.

---

<p align="center"><sub>A real language, built from scratch — one slice at a time. 🌱</sub></p>
