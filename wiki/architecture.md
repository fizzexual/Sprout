# How Sprout works 🌱

Sprout is a real, from-scratch language — its own lexer, parser, and tree-walking
interpreter — written in **C**, in a single file ([`src/sprout.c`](../src/sprout.c)),
depending on nothing but the C standard library and the operating system. The same
shape as CPython or Lua, just smaller.

If you want to *use* Sprout, start with the [Cheat Sheet](cheatsheet.md). If you
want to *understand or extend* it, read on.

---

## The pipeline

Every program takes the same journey from text to output:

```
  program.sprout  →  lexer  →  parser  →  interpreter  →  output
                   (tokens)   (AST)      (walks the tree)
```

1. **Lexer** — turns the source text into a flat list of *tokens* (numbers, text,
   names, keywords, operators). It also tracks indentation, emitting `INDENT` /
   `DEDENT` tokens so blocks work without braces.
2. **Parser** — a recursive-descent parser turns tokens into an **AST** (a tree of
   `Expr` and `Stmt` nodes), respecting operator precedence
   (`or` → `and` → comparisons → `+ -` → `* / %` → unary → primary).
3. **Interpreter** — walks the AST and executes it directly.

It's all in one file, in that order: values → lexer → AST → parser → interpreter → `main`.

---

## Values

A Sprout value is a small tagged union — one of four kinds:

```c
typedef enum { V_NUM, V_STR, V_BOOL, V_NONE } VType;
typedef struct { VType type; double num; char *str; int boolean; } Value;
```

Numbers are doubles, text is a C string, `yes`/`no` is a boolean, and `nothing`
is its own kind. Helpers like `stringify`, `is_truthy`, and `values_equal` define
how values print, count as true/false, and compare — so the rules are in one place.

## Scopes (the environment)

Variables live in an **environment** — a list of name/value pairs with a pointer to
its parent:

```c
typedef struct Env { Var *vars; int n, cap; struct Env *parent; } Env;
```

The top-level program runs in the **global** env. Every task **call** gets a fresh
env whose parent is the global one — so a task sees the globals plus its own
locals, but never the caller's locals. Looking up a name walks from the current
env outward; `make` defines in the current env, `set` updates an existing one.

## Tasks, calls, and `give`

Top-level `task` definitions are **hoisted** into a small table before the program
runs, so you can call a task before it's defined. A call:

1. finds the task, checks the argument count,
2. makes a new env (parent = globals) and binds the arguments,
3. runs the body.

`give` doesn't use C's `return` directly — it sets a `returning` flag and a value
slot, which the statement loop and every loop honor, so `give` cleanly unwinds out
of nested blocks and loops. Recursion works; a runaway recursion is caught by a
depth guard (the binary is also linked with a large stack) and reported as a
friendly error instead of a crash.

## Friendly errors

Mistakes call `fail(line, message)`, which prints a plain-English message with the
line number and stops:

```
  Sprout error (line 2): I don't know what 'nme' is.
```

(The `^` pointer and "did you mean?" suggestions are on the [roadmap](README.md#roadmap).)

## Memory

For now, memory is **never freed** — a Sprout program is short-lived and the OS
reclaims everything on exit. A small garbage collector is a later slice; until
then this keeps the interpreter simple.

---

## Building

```
src/sprout.c  →  gcc -O2 -Wall -s  →  sprout.exe   (~34 KB)
```

The result links only against the operating system's own libraries (on Windows,
`KERNEL32` + the system C runtime — both ship with the OS). Drop the executable
anywhere and it runs; nothing to install.

## Adding a language feature

A new piece of syntax usually touches this trail — the same order as the pipeline:

1. **token kind** — add it to the `TokType` enum (and the keyword table if it's a word).
2. **lexer** — recognise it in the source text.
3. **AST** — add an `Expr`/`Stmt` shape for it.
4. **parser** — parse tokens into that node.
5. **interpreter** — execute it in `eval` / `exec`.
6. **a test** — add a `.sprout` smoke test under `src/tests/`.

---

See also: [Sprout Syntax](syntax-basics.md) · [Cheat Sheet](cheatsheet.md) ·
[the source readme](../src/README.md)
