# Modules & projects

A single `.sprout` file is perfect for a script. When a program grows, Sprout lets
you split it across many files — a **project** — with no build tool, no package
manager, and no config language to learn: one tiny `sprout.toml` and the `use`
keyword. This page covers everything: the manifest, the folder layout, importing
with `use`, namespaced access, `public` vs `private`, re-import safety, and the CLI
commands that scaffold and run a project.

## On this page

- [The one-minute version](#the-one-minute-version)
- [`sprout.toml` — the project file](#sprouttoml--the-project-file)
- [The `modules/` layout](#the-modules-layout)
- [`use` — import a module](#use--import-a-module)
- [Namespaced access — one dot only](#namespaced-access--one-dot-only)
- [`public` vs `private`](#public-vs-private)
- [`use system` — the built-in module](#use-system--the-built-in-module)
- [Re-import safety](#re-import-safety)
- [The CLI: `new`, `build`, `template`](#the-cli-new-build-template)
- [Errors & gotchas](#errors--gotchas)
- [See also](#see-also)

## The one-minute version

Two commands scaffold a real multi-file project and run it:

```bash
sprout new chat-app
cd chat-app
sprout build
```

`sprout new` writes the folder; `sprout build` reads `sprout.toml`, loads every
file, and runs your entry point last. Here is the whole shape of a project:

```
chat-app/
├─ sprout.toml            # the project: name, main file, files to include
├─ app.sprout             # the entry point (main)
├─ modules/
│   ├─ greeter.sprout      # task: greet(who)
│   └─ server.sprout       # tasks: start(), handle(user) — uses greeter
└─ tests/
    └─ test.sprout
```

Inside a file you import another with `use` and call its **public** parts through
its name:

```sprout
~ app.sprout
use greeter
use server

show greeter.greet("world")
server.start()
```

The rest of this page unpacks each piece, with runnable examples.

## `sprout.toml` — the project file

Every project has one `sprout.toml` at its root. It is plain text with three keys.
Comments start with `#` or `~`, and paths are relative to the folder the
`sprout.toml` lives in.

```toml
# This file ties the whole project together.
# Run everything with:  sprout build

project "demo"            # a friendly name (shown when you build)
main "app.sprout"         # the entry point — sprout build runs this LAST
include [                 # every other file that's part of the project
    "modules/greeter.sprout",
    "modules/server.sprout"
]
```

The three fields:

| Field | What it does |
| --- | --- |
| `project` | The project's name. Printed as `Building <name>` when you run `sprout build`. Optional — defaults to `project`. |
| `main` | The entry point. `sprout build` loads it **last**, after the modules. Optional — defaults to `app.sprout`. |
| `include [...]` | The list of files that make up the project. They are loaded **before** `main`, in the order you list them. Each path also registers a module name (its filename without `.sprout`), so `"modules/greeter.sprout"` becomes the module `greeter`. |

A few rules worth knowing:

- Values are double-quoted strings. A key with no string on its line is ignored —
  it can't accidentally grab the next line's value.
- The `include` list takes a trailing comma fine, and `#`/`~` comments may sit
  inside the brackets.
- `main` is registered as a module too, so a *library* file may `use` the entry
  point's name if it really needs to (rare, but allowed).

Here is a complete, runnable project. Create the four files, then run
`sprout build` **from inside the project folder** (module lookup is relative to
your current directory, so always `cd` into the project first):

```toml
# sprout.toml
project "demo"
main "app.sprout"

include [
    "modules/greeter.sprout",
    "modules/server.sprout"
]
```

```sprout
~ modules/greeter.sprout
public task greet(who):
    give f"Hello, {who}!"
```

```sprout
~ modules/server.sprout
use greeter
public task start():
    show greeter.greet("Ada")
```

```sprout
~ app.sprout
use greeter
use server
show greeter.greet("world")
server.start()
```

```bash
sprout build
```

```
  Building demo

Hello, world!
Hello, Ada!
```

## The `modules/` layout

You don't *have* to use a `modules/` folder, but it's the convention `sprout new`
sets up, and the loader looks there automatically. When you `use greeter`, Sprout
resolves the name in this order:

1. **The `include` map in `sprout.toml`.** If `greeter` is listed there (directly,
   or via its filename), that exact path wins.
2. **A folder search**, trying each of these in turn:
   `greeter.sprout`, `modules/greeter.sprout`, `src/greeter.sprout`,
   `lib/greeter.sprout`.

So dropping a file in `modules/` (or `src/` or `lib/`) is enough for `use` to find
it even before you list it in the manifest. Listing it in `include` is still what
makes `sprout build` *load* it as part of the whole program.

You can also point `use` straight at a file path — see the next section.

## `use` — import a module

Put `use <name>` near the top of a file to import another module. After that, the
module's **public** tasks and values are reachable through its name. A file can
**only** name modules it has `use`d — there is no hidden global sharing.

`use` accepts two forms:

| Form | Meaning |
| --- | --- |
| `use greeter` (or `use "greeter"`) | A **name**. Resolved through `sprout.toml` then the folder search above. Bare and quoted names behave identically. |
| `use "modules/config.sprout"` | A **path**. Anything containing `/`, `\`, or `.sprout` is taken literally and resolved from the project root, skipping the name search. |

Here is the path form with a config module that exposes a map and a list:

```sprout
~ modules/config.sprout
public make settings = {"host": "localhost", "port": 8080}
public make ports = [80, 443, 8080]
```

```sprout
~ app.sprout
use "modules/config.sprout"

show config.settings["host"]
show config.ports[2]
```

```
localhost
8080
```

Notice the module name is still `config` (the filename without `.sprout`), even
though you imported it by path.

## Namespaced access — one dot only

Across files you reach a module's public members with **exactly one dot**:
`module.name`. This is a deliberate limit that keeps the language simple and
predictable.

```sprout
use greeter
show greeter.greet("world")   ~ module.task(...)
show greeter.banner           ~ module.value
```

If you write a second dot, Sprout stops you with a clear message:

```sprout
use greeter
show greeter.greet.x("world")
```

```
  Sprout error in app.sprout (line 2): you can only use one '.' here (like module.name). To go deeper, store it first or use [ ].
```

To **go deeper**, do exactly what the message says — store the value first, or
index into it. A module's public value is a normal value once you've named it:

```sprout
~ modules/config.sprout
public make settings = {"host": "localhost", "port": 8080}
```

```sprout
~ app.sprout
use "modules/config.sprout"

~ index straight off the member (one dot, then [ ]):
show config.settings["port"]

~ or store it first, then use it freely:
make s = config.settings
show s["host"]
```

```
8080
localhost
```

## `public` vs `private`

By default, every `task` and every top-level `make` is **private** — it belongs to
its own file and is reachable only there, where you call it **bare**. Put
`public` in front to expose it on the module's name as `module.thing`.

```sprout
~ modules/greeter.sprout
public make banner = "== welcome =="   ~ reachable as greeter.banner

public task greet(who):                ~ reachable as greeter.greet(...)
    give f"Hello, {polish(who)}!"

task polish(text):                     ~ PRIVATE: only this file can call it, bare
    give trim(text)
```

```sprout
~ modules/server.sprout
use greeter

public task start():
    show handle("Ada")                 ~ bare: my own (private) task
    show handle("Lin")

task handle(user):                     ~ private helper
    give f"200 OK -> {greeter.greet(user)}"   ~ cross-file: greeter.greet
```

```sprout
~ app.sprout
use greeter
use server

show greeter.banner
show greeter.greet("world")
server.start()
```

Run `sprout build` (or `sprout run app.sprout` from the folder):

```
== welcome ==
Hello, world!
200 OK -> Hello, Ada!
200 OK -> Hello, Lin!
```

The rules, with no magic:

- **Within a file** you call your own tasks bare (`polish(...)`, `handle(...)`),
  whether they're public or private.
- **Across files** you go through the module name (`greeter.greet(...)`) — and only
  things marked `public` are reachable that way.
- `public make name = ...` exposes a *value* as `module.name`. Re-running it (for
  example, a `public make` inside a task that runs twice) just updates that one
  shared, file-level slot.
- Two files may each have a private task with the **same name** — no clash, because
  one is `a.thing` and the other `b.thing`, never both bare.
- `private` is the default, so the keyword is optional. You may write it for
  emphasis, but it's redundant. `public` and `private` may only sit in front of
  `make` or `task`.

Reaching for something that isn't public gives a precise error — note it names the
**kind** (`task` vs `value`):

```sprout
~ greeter.sprout has a private task: polish
use greeter
show greeter.polish("  x  ")
```

```
  Sprout error in app.sprout (line 2): the module 'greeter' has no public task called 'polish'.
```

## `use system` — the built-in module

`system` is a **reserved** built-in module — you can't define your own file named
`system`. You still write `use system`, which makes shell access explicit, and then
call `system.run(cmd)` to run an OS command and get its output as text:

```sprout
use system
show system.run("echo hello-from-shell")
```

```
hello-from-shell

```

Because `system.run` is an action, writing `system.run` without calling it is an
error (it nudges you to add the parentheses). And the whole `system` module is
switched **off** under `--sandbox` / `SPROUT_SANDBOX=1`, along with the
filesystem, the on-disk store, and the network — see
[sandbox & playground](sandbox-and-playground.md).

## Re-import safety

A file is loaded **exactly once**, no matter how many times it is `use`d. The
loader tracks each file by its canonical path, so `use greeter`, `use "greeter"`,
and `use "modules/greeter.sprout"` all resolve to the same single load.

This means two things you don't have to worry about:

- **Repeating `use` is a harmless no-op.** The second `use` does nothing — it
  doesn't re-run the module or error.
- **Circular uses terminate.** If A uses B and B uses A, loading finishes cleanly
  instead of looping forever.

```sprout
~ app.sprout
use greeter
show greeter.greet("world")

use greeter            ~ second use: a no-op, not an error
show "re-use is harmless"
```

```
Hello, world!
re-use is harmless
```

## The CLI: `new`, `build`, `template`

Four commands cover the whole project lifecycle.

### `sprout new <folder> [template]`

Scaffolds a brand-new project folder. It **never** wipes anything — if the folder
already exists and isn't empty, it refuses. With no template name it uses the full
`app` template (manifest + modules + tests).

```bash
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

Pass a template name to start from a different shape, e.g. `sprout new mygame game`
creates a one-file guess-the-number game. Pointing `new` at an existing non-empty
folder is refused on purpose:

```
  The folder 'chat-app' already exists and isn't empty.
  Pick another name, or use it in place:  sprout template load app
```

### `sprout build`

Run from inside a project folder. It reads `sprout.toml`, loads every `include`d
file (libraries first), then runs `main` last. If the project ran any tests via
`test`/`expect`, it reports them and sets the exit code.

```bash
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

With no `sprout.toml` present, `build` tells you how to start one. You can also run
a single file directly — `sprout run app.sprout` — and its `use` lines still pull
in whatever they need. (`sprout run` with no file behaves like `sprout build`.)

### `sprout template list`

Lists the built-in templates you can scaffold from.

```bash
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

### `sprout template load <name>`

Scaffolds a template into the **current** folder instead of a new one. Because it
**replaces everything in the folder**, it asks you to type `yes` to confirm before
it deletes anything:

```bash
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

> This command is destructive and interactive. Run it in an empty folder you don't
> mind losing, and answer the prompt. If it gets no `yes`, it aborts and changes
> nothing.

## Errors & gotchas

A quick tour of the messages you'll see and what triggers them.

**Calling a module you didn't `use`.** A file may only name modules it imported:

```sprout
~ app.sprout (no `use greeter`)
show greeter.greet("world")
```

```
  Sprout error in app.sprout (line 1): to call greeter.greet, add 'use greeter' at the top of this file.
```

**Two project files share a basename.** Module names must be unique, because the
module name comes from the filename. Two files both named `util.sprout` (even in
different folders) collide:

```
  Sprout error in lib/util.sprout: two files in this project are both named 'util' - module names must be unique. Rename one.
```

**A module that can't be found.** If `use widgets` resolves to nothing:

```
  Sprout error: I couldn't find a module called 'widgets' to use. (looked in sprout.toml, modules/, src/, lib/)
```

Other things to keep in mind:

- **Module lookup is relative to your current directory**, not the file's. Always
  `cd` into the project folder before `sprout build` or `sprout run app.sprout`.
- A **parse error in a `use`d module is never catchable** by a `try:` — a syntax
  mistake is a code bug, not a runtime condition. See [errors](errors.md).
- A module's top-level `give` doesn't return anything to whoever `use`d it; it just
  ends the module's top-level run.
- You can't name your own module `system` — it's reserved for OS access.

## See also

- [Getting started](getting-started.md) — build the interpreter and run your first file.
- [Tasks & lambdas](tasks-and-lambdas.md) — what `task`, `give`, and closures do inside a module.
- [Testing & learn mode](testing-and-learn.md) — `test`/`expect` and the `tests/` folder a project ships with.
- [Built-in functions](builtins-reference.md) — the 89 builtins every module gets for free.
- [Pattern matching](pattern-matching.md) — `match`/`is` for branching on shapes.
- [Sandbox & playground](sandbox-and-playground.md) — what `--sandbox` switches off (including `use system`).
- [Errors](errors.md) — the catchable error map `{message, kind, line}` and why parse errors aren't catchable.
- [Architecture](architecture.md) — how the loader, file scopes, and namespaces work under the hood.
