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

## `use` — pull in a file by name

Put `use <name>` at the top of a file to load another module:

```sprout
~ app.sprout
use greeter        ~ loads the module whose file is greeter.sprout
use server

show greet("world")
start()
```

`use greeter` finds the file by:

1. its name in `sprout.toml`'s `include` list (so `greeter` → `modules/greeter.sprout`), then
2. a search of `greeter.sprout`, `modules/greeter.sprout`, `src/greeter.sprout`, `lib/greeter.sprout`.

You can also `use` an exact path: `use "modules/greeter.sprout"`.

A file is loaded **once**, no matter how many times it's `use`d, so circular
uses (A uses B, B uses A) are fine.

## One shared space

Every file in a project shares the same space. A `task` defined in any file is
callable from any other — the connection goes both ways. There's no `export`
and no `import list`; `use` just makes sure the other file is loaded.

```sprout
~ modules/greeter.sprout
task greet(who):
    give "Hello, " + who + "!"
```

```sprout
~ modules/server.sprout
use greeter

task start():
    show handle("Ada")

task handle(user):
    give "200 OK — " + greet(user)     ~ greet() comes from the greeter module
```

Two files can't define a task with the **same name** — Sprout will tell you
which file the clash is in.

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
