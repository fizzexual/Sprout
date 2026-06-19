# Command-line interface & flags

Everything the `sprout` command can do — run a file, start a project, run
tests, scaffold from a template, peek at a web API, or just drop you into a
live playground. One small executable, a handful of plain-English commands.

This page is the complete reference for the CLI. For the language itself, start
with [getting started](getting-started.md) and the [cheatsheet](cheatsheet.md).

## On this page

- [The one-line summary](#the-one-line-summary)
- [`sprout` — the interactive screen](#sprout--the-interactive-screen)
- [`sprout <file.sprout>` and `sprout run <file>`](#sprout-filesprout-and-sprout-run-file)
- [`sprout new <folder>` — start a project](#sprout-new-folder--start-a-project)
- [`sprout build` — run the project here](#sprout-build--run-the-project-here)
- [`sprout test [file]` — run your tests](#sprout-test-file--run-your-tests)
- [`sprout bundle <file>` — make a standalone executable](#sprout-bundle-file--make-a-standalone-executable)
- [`sprout format <file>` — tidy your code](#sprout-format-file--tidy-your-code)
- [`sprout template list` / `template load`](#sprout-template-list--sprout-template-load-name)
- [`sprout api <url>` — peek at any web API](#sprout-api-url--peek-at-any-web-api)
- [`sprout version` and `sprout help`](#sprout-version-and-sprout-help)
- [`--sandbox` / `SPROUT_SANDBOX=1`](#--sandbox--sprout_sandbox1)
- [`SPROUT_GC_STRESS=1` (for testing)](#sprout_gc_stress1-for-testing)
- [Exit codes](#exit-codes)
- [Gotchas](#gotchas)

## The one-line summary

| Command | What it does |
| --- | --- |
| `sprout` | open the interactive screen (menu → live REPL, run a file, help) |
| `sprout <file.sprout>` | run a single program |
| `sprout run <file>` | run a single program (same thing, more explicit) |
| `sprout new <folder>` | create a new project folder |
| `sprout build` | run the project in the current folder (reads `sprout.toml`) |
| `sprout test [file]` | run tests — one file, or every `tests/*.sprout` |
| `sprout bundle <file>` | package a program into a **standalone executable** |
| `sprout format <file>` | tidy a program's formatting (`--write` to edit, `--check` for CI) |
| `sprout template list` | list the project templates |
| `sprout template load <name>` | scaffold a template **into the current folder** (wipes it) |
| `sprout api <url>` | print every field a web API returns |
| `sprout version` | print the version |
| `sprout help` | print the usage screen |

Flags & environment variables:

| Switch | What it does |
| --- | --- |
| `--sandbox` | run untrusted code with file/shell/network builtins turned off |
| `SPROUT_SANDBOX=1` | same as `--sandbox`, set via the environment |
| `SPROUT_GC_STRESS=1` | collect garbage after every statement (a test/debug aid) |

You build the `sprout` executable once with a C compiler; after that it needs
nothing but the operating system. See the README's **Build & run** section, or
just grab a release. Examples below assume `sprout` is on your `PATH` (on
Windows the file is `sprout.exe`).

## `sprout` — the interactive screen

Run `sprout` with **no arguments** and you get a friendly menu:

```
sprout
```

```
  Sprout v0.1.4  🌱
  a tiny language, written from scratch in C

  What would you like to do?

    1  Try Sprout live
    2  Run a program (.sprout file)
    3  Help
    4  Quit

  choose ▸
```

- **1 — Try Sprout live** drops you into a REPL. Type code, press Enter, and the
  value (if any) is echoed back. Start an indented block (like `when …:` or
  `task …:`) and Sprout keeps reading until you leave a **blank line**. Type
  `back` (or `quit`/`exit`) to return to the menu. The session keeps your
  variables, so you can build things up step by step and even re-`make` a name
  you already defined.
- **2 — Run a program** asks for a file path and runs it.
- **3 — Help** shows a one-screen language nutshell.
- **4 — Quit** (or `q`) exits.

A quick REPL session looks like this:

```
  sprout ▸ make x = 5
  sprout ▸ x * 2
10
  sprout ▸ when x > 3:
  ...... show "big"
  ......
big
  sprout ▸ back
```

The interactive screen is for exploring. For real work you'll usually run a file
or a project, which is everything below.

## `sprout <file.sprout>` and `sprout run <file>`

Run one program. These two forms are identical — `run` just makes it obvious you
mean "execute this file":

```sprout
make name = "world"
show f"Hello, {name}!"
show 2 + 2
```

```
sprout run hello.sprout
```

```
Hello, world!
4
```

Dropping the `run` works exactly the same:

```
sprout hello.sprout
```

```
Hello, world!
4
```

The file is parsed, every `task` in it is registered, and the top level runs top
to bottom. If the file has [tests](testing-and-learn.md) in it, they run too and
the exit code reflects whether they passed.

If the file can't be opened you get a clear message and exit code `1`:

```
sprout run nope.sprout
```

```
  I couldn't open the file: nope.sprout
```

> **Tip:** `sprout run` with **no file** doesn't error — it falls back to
> `sprout build` and tries to run a project in the current folder.

## `sprout new <folder>` — start a project

Scaffold a brand-new project folder. By default you get the full **app**
template (a `sprout.toml`, a couple of modules, and a test); pass a template name
as the third word to pick a different one.

```
sprout new chat-app
```

```
  Creating chat-app (app template)

    + chat-app/sprout.toml
    + chat-app/app.sprout
    + chat-app/modules/greeter.sprout
    + chat-app/modules/server.sprout
    + chat-app/tests/test.sprout
    + chat-app/README.md

  Done!  Next:
    cd chat-app
    sprout build
```

Pick a template explicitly with `sprout new <folder> <template>`, e.g.
`sprout new dice game`. The template names come from
[`sprout template list`](#sprout-template-list--sprout-template-load-name).

`sprout new` is the **safe** scaffolder: it refuses to touch a folder that
already exists and isn't empty, and it rejects absolute paths or `..` in the
name. (If you *want* to scaffold into the current folder, that's
[`sprout template load`](#sprout-template-list--sprout-template-load-name),
which is the one that wipes.)

## `sprout build` — run the project here

Run the project in the **current** folder. It reads `sprout.toml`, loads every
file listed under `include`, and runs the `main` file last so its top-level code
can call into the modules.

```
cd chat-app
sprout build
```

```
  Building MyApp

Welcome to MyApp!
Hello, world!
server: handling 2 requests...
  200 OK  ->  Hello, Ada!
  200 OK  ->  Hello, Lin!
```

If there's no `sprout.toml` in the folder, `build` tells you how to start one:

```
sprout build
```

```
  No sprout.toml here.  Start a project with:  sprout new myapp
  or run one file directly:  sprout run app.sprout
```

For how `sprout.toml`, `include`, `use`, and `public`/`private` fit together,
see [projects & modules](modules-and-projects.md).

## `sprout test [file]` — run your tests

Run your [tests](testing-and-learn.md). With **no argument** it runs every
`*.sprout` file in a `tests/` folder; with a file path it runs just that file.

A test file uses the `test`/`expect` keywords:

```sprout
task double(n):
    give n * 2

test "doubling":
    expect double(4) == 8
    expect double(0) == 0

test "list length":
    expect length([1, 2, 3]) == 3
```

```
sprout test math_test.sprout
```

```
  math_test.sprout
  ok  doubling
  ok  list length

  2 passed
```

A failing `expect` is reported and the run exits with code `1`:

```sprout
test "this one fails":
    expect 1 + 1 == 3
```

```
sprout test fail_test.sprout
```

```
  fail_test.sprout
  x  this one fails
        expected this to be true:  1 + 1 == 3

  0 passed, 1 failed
```

Run the whole suite (in a project with a `tests/` folder) by just typing
`sprout test`:

```
sprout test
```

```
  tests/test.sprout
PASS: greet() says hello
```

See [testing & learn mode](testing-and-learn.md) for `expect error`, the
`expect a == b` mismatch report, and more.

## `sprout bundle <file>` — make a standalone executable

Package a program into a **single executable** that runs on its own — no Sprout, no source
file, nothing to install. Hand someone the one file and it just runs.

```
$ sprout bundle greet.sprout
  Bundled greet.sprout into a standalone program:  greet.exe
  Run it directly — no Sprout needed.

$ ./greet.exe Ada
hello Ada
```

- The output is named after the script (`greet.exe` on Windows, `greet` elsewhere). Choose your
  own with `-o`: `sprout bundle greet.sprout -o hello`.
- It's a real native executable — Sprout copies itself, appends your script, and the bundled
  program runs that script at startup. (Arguments after the program name reach `args()` as usual.)
- **Single-file programs.** Built-in modules like `use system` still work, but a program that
  `use`s *other `.sprout` files* isn't bundled with them yet — keep a bundled program in one file.
- The file is the interpreter (~200 KB) plus your script, so it's small. Anti-virus tools
  occasionally flag freshly-appended executables; that's a false positive on an unsigned binary.

## `sprout format <file>` — tidy your code

Sprout's code formatter — like `gofmt` or `black`. It re-indents to **4 spaces per block level**,
trims trailing whitespace, collapses runs of blank lines, and ends the file with one newline. It's
**structure-preserving** (it only touches insignificant whitespace), **comment-preserving**, and
**idempotent** (running it twice changes nothing).

```
$ sprout format messy.sprout          # prints the tidy version to the screen
$ sprout format messy.sprout --write  # edit the file in place
$ sprout format messy.sprout --check  # exit 1 if it isn't already formatted (for CI)
```

- By **default it prints to stdout** and changes nothing — safe to preview. Pass `--write`
  (or `-w`) to edit the file.
- Lines inside a multi-line `( [ {` literal are left exactly as you wrote them, so your own
  alignment is respected.
- `--check` makes it a CI gate: it returns a non-zero exit code when a file would be reformatted.
- (`sprout fmt` is a shorthand for `sprout format`.)

## `sprout template list` / `sprout template load <name>`

`sprout template list` shows the built-in starting points:

```
sprout template list
```

```
  Sprout templates

    app       a full multi-file project (sprout.toml + modules + tests)
    starter   a tiny one-file project to start from
    api       fetch a web API and read it (get / json / explore)
    cli       an interactive command-line tool (ask + color)
    game      a guess-the-number game

  New project:    sprout new <folder> [template]
  In this folder: sprout template load <template>
```

`sprout template load <name>` scaffolds one of those **into the folder you're
standing in**. Because that means replacing whatever's there, it first **deletes
everything in the current folder** and asks you to confirm by typing `yes`:

```
sprout template load starter
```

```
  WARNING: this will DELETE everything in the current folder
  and replace it with the 'starter' template.

  Type yes to continue: yes
    + sprout.toml
    + app.sprout
    + README.md

  Created the 'starter' template.  Run it:  sprout build
```

Type anything other than `yes` and nothing changes:

```
  Type yes to continue: no
  Cancelled - nothing was changed.
```

> **`new` vs `load`.** Use `sprout new <folder>` to create a *fresh* folder
> (never destructive). Use `sprout template load <name>` only when you want a
> template dropped into the *current, empty-or-disposable* folder — it wipes
> first. When in doubt, reach for `new`.

## `sprout api <url>` — peek at any web API

Fetch a JSON API and print **every** readable field, with nested keys flattened
to dotted paths (`owner.login`, `owner.id`, …). It's the fastest way to see what
a service actually returns before you write any code against it.

```
sprout api https://api.github.com/repos/fizzexual/Sprout
```

```
  https://api.github.com/repos/fizzexual/Sprout
  106 readable fields:

    id = 1261582443
    node_id = R_kgDOSzI4aw
    name = Sprout
    full_name = fizzexual/Sprout
    private = no
    owner.login = fizzexual
    owner.id = 132170675
    owner.avatar_url = https://avatars.githubusercontent.com/u/132170675?v=4
    ...
    description = A lightweight, beginner-friendly, tree-walking interpreted programming language built completely from scratch.
    ...
```

(The real output lists all 106 fields; trimmed here.) Under the hood this is the
same machinery as the [`get`, `json`, and `explore` builtins](builtins-reference.md)
— `sprout api <url>` is just a one-liner over `explore(json(get(url)))`. If the
server can't be reached you get `Couldn't reach <url>` and exit code `1`.

Need a web address but didn't give one? Sprout reminds you:

```
sprout api
```

```
  api needs a web address:  sprout api https://...
```

> **Heads-up:** networking is one of the things [`--sandbox`](#--sandbox--sprout_sandbox1)
> turns off. `sprout api` reaches the network by design, so don't expose it in a
> sandboxed playground.

## `sprout version` and `sprout help`

`sprout version` prints the build's version and exits:

```
sprout version
```

```
Sprout v0.1.4
```

`sprout help` prints the full usage screen — the authoritative short reference,
straight from the executable:

```
sprout help
```

```
Sprout v0.1.4 - a small, friendly language, written from scratch in C.

  sprout                   open the interactive screen
  sprout new <folder>      create a new project folder
  sprout build             run the project here (reads sprout.toml)
  sprout test [file]       run tests (a file, or every tests/*.sprout)
  sprout <file.sprout>     run a single program
  sprout run <file>        run a single program
  sprout api <url>         show every field an API gives back
  sprout template list     list project templates
  sprout template load <name>   scaffold into THIS folder (wipes it)
  sprout version           show the version
  sprout help              show this help

  --sandbox                run untrusted code safely: turns OFF file, shell, and
                           network builtins (read/write/remember/get/system...).
                           Works anywhere on the line; or set SPROUT_SANDBOX=1.
```

Both commands also accept the conventional flag spellings:
`sprout --version` / `sprout -v`, and `sprout --help` / `sprout -h`.

## `--sandbox` / `SPROUT_SANDBOX=1`

Pass `--sandbox` when strangers run Sprout code on **your** machine (an online
playground, a shared server). It turns **off** every builtin that can reach
outside the program:

- the filesystem — `read`, `write`, `append`, `exists`
- the on-disk store — `remember`, `recall`, `forget`
- the network — `get`, `explore`
- the shell — the whole [`system` module](modules-and-projects.md)
- loading another file at runtime — `use <file>`

Everything else (math, text, lists, maps, tasks, `match`, the `|>` pipe, …)
works exactly as normal, and each **blocked** call is a clear, *catchable*
error — so a program can recover instead of crashing.

The flag works **anywhere on the line**, and `SPROUT_SANDBOX=1` in the
environment does the same thing:

```sprout
show "math still works:", 2 + 2
try:
    write("secret.txt", "oops")
caught e:
    show "blocked:", e["message"]
```

```
sprout --sandbox run safe.sprout
```

```
math still works: 4
blocked: 'write' is turned off in sandbox mode — file, shell, and network access are disabled here.
```

Setting it through the environment is identical:

```
SPROUT_SANDBOX=1 sprout run safe.sprout
```

```
math still works: 4
blocked: 'write' is turned off in sandbox mode — file, shell, and network access are disabled here.
```

> **Necessary, not sufficient.** The flag closes the *language's* outward APIs,
> but a hosting server must still cap **CPU time, memory, and output** at the
> OS/container level — a Sprout program can still loop forever or allocate a
> lot. Run each submission as a short-lived, unprivileged, resource-limited
> process.

Because the blocked builtins raise a normal Sprout error, the
[error kinds](errors.md) you'd catch (`io`, `name`, …) behave the way they
always do. For the full threat model, the hardened Docker recipe, and the web
playground, see [sandbox & playground](sandbox-and-playground.md).

## `SPROUT_GC_STRESS=1` (for testing)

Set `SPROUT_GC_STRESS=1` to make the garbage collector run **after every
statement** instead of only when memory grows. It makes programs slower but
proves the GC isn't freeing anything still in use — a value that survives under
stress mode is a value that's genuinely reachable. It's a development and
continuous-integration aid; it does **not** change what your program prints.

```sprout
make total = 0
for each i in range(5):
    make xs = [i, i * 2, i * 3]
    set total = total + sum(xs)
show "total:", total
```

```
sprout run gc.sprout
```

```
total: 60
```

The same program under stress mode produces the **identical** result — that's
the point:

```
SPROUT_GC_STRESS=1 sprout run gc.sprout
```

```
total: 60
```

If you ever see output change between the two runs, that's a bug worth filing.
You normally never need this flag; it's here for the curious and for the test
suite. See [architecture](architecture.md) for how the collector works.

## Exit codes

Sprout uses standard process exit codes so you can wire it into shell scripts
and CI:

| Code | When |
| --- | --- |
| `0` | the program (or build, or tests) ran and all tests passed |
| `1` | a file couldn't be opened, a build had no `sprout.toml`, an uncaught error stopped the run, or **a test failed** |

That last one matters for CI: `sprout test` (and a `sprout build`/`sprout run`
of a file containing tests) exits `1` if any test fails, so a red build fails
the pipeline automatically.

## Gotchas

- **`template load` wipes the folder; `new` never does.** Read the
  [`new` vs `load`](#sprout-template-list--sprout-template-load-name) note before
  running `template load` — it deletes everything in the current directory after
  you type `yes`.
- **`sprout run` with no file is `sprout build`.** Handy, but it means a typo'd
  filename that you accidentally drop won't error the way you'd expect — it'll
  try to build the project in the folder instead.
- **`--sandbox` goes anywhere on the line.** `sprout --sandbox run x.sprout` and
  `sprout run x.sprout --sandbox` are the same. The flag is stripped before the
  positional arguments are read.
- **`sprout api` needs the network**, which `--sandbox` turns off — they don't
  mix.
- **Files end in `.sprout`** and projects are driven by `sprout.toml`. Tests
  live in a `tests/` folder (or any file you point `sprout test` at).

---

**See also:** [getting started](getting-started.md) ·
[projects & modules](modules-and-projects.md) · [testing & learn mode](testing-and-learn.md) ·
[sandbox & playground](sandbox-and-playground.md) ·
[builtins reference](builtins-reference.md) · [errors](errors.md) ·
[cheatsheet](cheatsheet.md) · [architecture](architecture.md)
