# Projects & modules

A single `.sprout` file is great for a script. When a program grows, you split
it across many files — a **project**. Sprout projects need no build tool, no
package manager, no config language to learn: one tiny `sprout.toml` and the
`use` keyword.

## Make one in two commands

```bash
sprout new chat-app
cd chat-app
sprout build
```

`sprout new` creates a folder (it never touches anything outside it):

```
chat-app/
├─ sprout.toml            # the project
├─ app.sprout            # the entry point (main)
├─ modules/
│   ├─ greeter.sprout     # task: greet(who)
│   └─ server.sprout      # tasks: start(), handle(user) — uses greeter
└─ tests/
    └─ test.sprout
```

## `sprout.toml` — the project file

```toml
project "chat-app"        # a friendly name
main "app.sprout"         # the file that runs last (your entry point)

include [                 # every file that's part of the project
    "modules/greeter.sprout",
    "modules/server.sprout"
]
```

- `project` — the project's name (shown when you build).
- `main` — the entry point. `sprout build` runs this **last**, after the
  modules are loaded.
- `include` — the files that make up the project. They're loaded before `main`.

Comments start with `#` (or `~`). Paths are relative to the folder the
`sprout.toml` lives in.

## `use` — import a module, then call it by name

Put `use <name>` at the top of a file to import another module, then reach its
**public** tasks and values through its name, `module.thing`:

```sprout
~ app.sprout
use greeter        ~ import the module whose file is greeter.sprout
use server

show greeter.greet("world")
server.start()
```

There's **no hidden sharing** between files: a file can only name a module it has
`use`d, and only that module's `public` parts are reachable.

`use greeter` finds the file by:

1. its name in `sprout.toml`'s `include` list (so `greeter` → `modules/greeter.sprout`), then
2. a search of `greeter.sprout`, `modules/greeter.sprout`, `src/greeter.sprout`, `lib/greeter.sprout`.

You can also `use` an exact path: `use "modules/greeter.sprout"`.

A file is loaded **once**, no matter how many times it's `use`d, so circular
uses (A uses B, B uses A) are fine.

## public and private

By default, a `task` or a top-level variable is **private** — it belongs to its
own file and is only reachable there (call it bare). Put **`public`** in front to
expose it on the module's name, `module.thing`:

```sprout
~ modules/greeter.sprout
public task greet(who):        ~ reachable as greeter.greet(...)
    give f"Hello, {polish(who)}!"

task polish(text):             ~ private: only greeter.sprout can call it (bare)
    give trim(text)
```

```sprout
~ modules/server.sprout
use greeter

public task start():           ~ reachable as server.start()
    show handle("Ada")

task handle(user):                              ~ private helper, called bare
    give f"200 OK — {greeter.greet(user)}"      ~ greet is from another module
```

The rules — predictable, no magic:

- **Within a file** you call your own tasks bare (`polish(...)`, `handle(...)`).
- **Across files** you go through the module name (`greeter.greet(...)`) — and only
  for things marked `public`.
- A `make name = ...` in one file never clobbers a `name` in another; each file
  keeps its own. `public make config = ...` exposes it as `module.config`.
- Two files can each have a private task with the **same name**; no clash (they're
  `a.thing` and `b.thing`, never both bare).

Think of `public` as your module's front door: the short list of things other
files are allowed to reach.

## Running a project

| You want to… | Run |
| --- | --- |
| run the whole project | `sprout build` (from the project folder) |
| run one file on its own | `sprout run app.sprout` — its `use` lines still pull in what they need |
| run a quick test | `sprout run tests/test.sprout` |

## Growing the project

Add a file, drop it in a folder, and list it under `include`:

```toml
include [
    "modules/greeter.sprout",
    "modules/server.sprout",
    "modules/database.sprout"     # new
]
```

Then `use database` wherever you need it.
