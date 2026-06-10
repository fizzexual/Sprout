# How Sprout works 🌱

This page explains Sprout from the inside — the pipeline a program flows through,
the two engines that run it, the new native runtime, and where every piece lives.
If you want to *use* Sprout, start with the [Cheat Sheet](cheatsheet.md); if you
want to *understand or extend* it, you're in the right place.

Sprout has **zero dependencies**. It's a real language — its own lexer, parser,
checker, and interpreter — written in a handful of small TypeScript files, plus a
from-scratch native runtime in C. Nothing is transpiled from another language and
nothing is pulled from npm to run it.

---

## The pipeline

Every Sprout program takes the same journey from text to output:

```
                    ┌─────────── shared front-end ───────────┐
  source.sprout  →  lexer  →  parser  →  checker  →  [ AST ]  →  ENGINE  →  output
                  (tokens)   (AST)     (friendly                  │
                                        errors)                  ├─ interpreter   (sprout run)
                                                                 └─ compiler → JS (sprout fast / build)
```

1. **Lexer** — turns the source text into a flat list of *tokens* (numbers, text,
   names, keywords, operators). It also handles indentation, emitting `INDENT` /
   `DEDENT` tokens so blocks work without braces.
2. **Parser** — turns tokens into an **AST** (Abstract Syntax Tree): a tree of
   `Stmt` and `Expr` nodes describing what the program *means*.
3. **Checker** — walks the AST before anything runs and catches mistakes early
   (unknown names, a `set` before its `make`, a loop that can never end), each as a
   friendly, pointing error.
4. **Engine** — the checked AST is then either **interpreted** directly or
   **compiled to JavaScript**. Same tree, same language, two ways to run it.

The lexer, parser, checker, AST, and error types are the **shared front-end** —
both engines use them, so the language behaves identically either way.

---

## The two engines (same language)

Sprout runs the *same* `.sprout` file two ways, and you pick per run:

| | `sprout run` | `sprout fast` / `sprout build` |
| --- | --- | --- |
| **How** | tree-walking interpreter | compiles the AST to JavaScript, runs on V8 |
| **Best for** | quick scripts, the kindest errors, no build step | speed, shipping an `.exe` |
| **Speed** | instant startup | **faster than Python** (real JS on V8) |

- The **interpreter** (`src/interp/`) walks the AST node by node. It's the friendly
  default — instant, and it powers `explain` (narrate each step) and `trace`.
- The **compiler** (`src/compile/`) emits a JavaScript program that imports a small
  shared **runtime** (`jsruntime.ts`). The runtime reuses the interpreter's own
  value helpers, so `1/0`, list indexing, and text rules behave the same on both
  engines. `sprout build --standalone` then *inlines* that program and the whole
  runtime into one self-contained `.js` (see [Building an .exe](#building-an-exe)).

> Compile mode covers the core language. A program that opens a GUI or `use`s a
> library simply runs on the interpreter — you never have to choose by hand.

---

## The native runtime (C)

`sprout run` and `sprout fast` both need **Node** installed. The [`native/`](../native)
folder is the long-term answer: a Sprout interpreter written from scratch in **C**,
so Sprout has its *own* runtime — no Node, no JavaScript, nothing but the OS. This
is the path CPython and Lua took.

```
native/sprout.c  →  gcc  →  sprout.exe   (~32 KB, links only KERNEL32 + Windows UCRT)
```

It's being ported one slice at a time. Today it runs the core language (variables,
math, text, `when`, `repeat`) plus `task` / `give`, function calls, and recursion.
See [native/README.md](../native/README.md) for the current state and roadmap.

The C interpreter mirrors the same pipeline (lexer → parser → tree-walking eval),
so the design carries straight over from the TypeScript version.

---

## Where everything lives

```
src/
  cli.ts             the `sprout` command — parses argv, wires everything together
  modules.ts         the library/extension loader (sprout modules)

  lang/              the shared front-end: source text -> a checked AST
    token.ts           token kinds
    lexer.ts           text  -> tokens (+ indentation)
    ast.ts             the Stmt / Expr node shapes
    parser.ts          tokens -> AST
    checker.ts         catches mistakes before running (friendly errors)
    errors.ts          the LangError type + the "points at the spot" formatter

  interp/            the tree-walking engine (sprout run)
    interpreter.ts     walks the AST and executes it
    values.ts          Sprout's values (numbers, text, lists, maps) + their rules
    builtins.ts        the built-in functions (sqrt, length, upper, get, ...)
    explore.ts         JSON exploration helpers (explore, jsonpick)

  compile/           the compile-to-JS engine (sprout fast / build)
    compile.ts         AST -> JavaScript source
    jsruntime.ts       the tiny runtime the compiled JS imports (reuses values.ts)
    bundle.ts          inline program + runtime into one self-contained .js

  services/          host services the builtins call into
    storage.ts         remember / recall (saved between runs)
    secrets.ts         secret("NAME") from env / .env
    net.ts             get / post (the internet)
    input.ts           ask (read from the user)

  ui/                native GUI + website, and styling
    gui.ts             the GuiModel — the widgets/state, engine-agnostic
    gui-native.ts      launches the native window...
    gui-host.ps1       ...a PowerShell WinForms host (JSON over stdin/stdout)
    serve.ts           the same app, served as a website
    bloom.ts           Bloom — Sprout's tiny CSS — parser + theming

native/              the from-scratch C runtime (no Node)
libraries/           installable libraries (discord-bot, networking, automations)
extensions/          add-ons that sit on top of a library (e.g. discord-bot/music)
wiki/                this documentation
test/                the test suite (node --test, zero deps)
installer/           the Windows installer (Inno Setup)
benchmarks/          the speed comparisons in the README
```

---

## GUI & servers

A Sprout program becomes an **app** the moment it calls `window(...)` or
`server(...)`. Both build the same engine-agnostic **`GuiModel`** in
[`ui/gui.ts`](../src/ui/gui.ts) — a description of the widgets (labels, buttons,
fields) and their state. Then:

- **`window(...)`** → [`gui-native.ts`](../src/ui/gui-native.ts) spawns
  [`gui-host.ps1`](../src/ui/gui-host.ps1), a Windows Forms host. They talk in
  **one JSON line per message** over stdin/stdout: Sprout sends the widget tree,
  the host sends back `click` events, Sprout runs the wired task and sends updates.
- **`server(...)`** → [`serve.ts`](../src/ui/serve.ts) serves the same model as a
  web page from a tiny built-in HTTP server.

Either way the look comes from the same **Bloom** theme ([`bloom.ts`](../src/ui/bloom.ts)),
so an app renders the same as a window or a website. See [GUI & Servers](gui-and-servers.md).

---

## Libraries

A plain `use "name"` (no `.sprout`) loads a **library** from
[`libraries/<name>/index.ts`](../libraries). Each library exports a `create(interp)`
that returns:

```ts
{ names: string[],          // the builtin names it adds to the language
  builtins: { ... },        // the implementations
  isActive?: () => boolean,  // is it doing background work? (keeps the process alive)
  start?: () => void }       // kick off background work
```

The loader ([`modules.ts`](../src/modules.ts)) calls `create`, registers the
builtins on the interpreter, and tracks `isActive` / `start`. **Extensions**
(like `discord-bot/music`) layer extra builtins on top of a library. Manage them
from a terminal UI with `sprout modules`. Full list: [Libraries](libraries.md).

---

## Friendly errors

Sprout's defining feature is that mistakes are *kind*. Every error is a
`LangError` ([`lang/errors.ts`](../src/lang/errors.ts)) carrying a message, a line,
and a column. The formatter prints the offending line, points a `^` at the spot,
explains it in plain English, and often suggests a fix:

```
🌱 Oops — name problem on line 2:

  2 | show "Hi, " + nme
    |               ^

  I don't know what 'nme' is.

  💡 Did you mean 'name'?
```

Most are caught by the **checker** before the program runs; the rest surface from
the interpreter with the same formatting.

---

## Building an .exe

`sprout build` turns a program into a single `.exe`, two ways:

- **No Node needed** (`--standalone`) — `compile.ts` emits JS, `bundle.ts` inlines
  it *and* the whole runtime into one self-contained `.js`, which is embedded into
  the Node binary with [Node SEA](https://nodejs.org/api/single-executable-applications.html)
  (`postject`) and compressed with UPX. Result: a ~20 MB `.exe` that runs anywhere.
- **Tiny** (`--needs-node`) — a ~40 KB launcher (compiled with the system's C#
  compiler) that runs the program on the recipient's installed Node.

`sprout build` with no flag asks which you want.

---

## Adding a language feature

A new piece of syntax usually touches this trail — the same order as the pipeline:

1. **`lang/token.ts`** — a new token kind, if needed.
2. **`lang/lexer.ts`** — recognise it in the source text.
3. **`lang/ast.ts`** — a node shape for it.
4. **`lang/parser.ts`** — parse tokens into that node.
5. **`lang/checker.ts`** — validate it (and add friendly errors).
6. **`interp/interpreter.ts`** — execute it (the `run` engine).
7. **`compile/compile.ts`** (+ `jsruntime.ts`) — compile it (the `fast`/`build` engine).
8. **`test/sprout.test.ts`** — a test proving both engines agree.
9. The same feature in **`native/sprout.c`**, when that slice comes.

`f"..."` string interpolation is a recent end-to-end example of exactly this trail.

---

See also: [Sprout Syntax](sprout-syntax.md) · [Built-in Functions](builtins.md) ·
[GUI & Servers](gui-and-servers.md) · [Bloom](bloom-syntax.md) ·
[the native runtime](../native/README.md)
