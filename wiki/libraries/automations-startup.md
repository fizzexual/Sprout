# automations: run on PC startup

Want your Sprout program (or any app) to spring to life the moment you log in?
That's what this corner of the **automations** library is for. With one line you
can wire *this* project into Windows startup, check whether it's set, or turn it
back off again. You can also make *any* command run at every login. Everything
here is **per-user and needs no admin rights** — it just edits your own personal
"Run" list in Windows, the same one apps use to start with the PC.

Add the library at the top of your program:

```sprout
use "automations"
```

> These are **Windows-only** for now. On macOS or Linux they'll politely stop and
> ask you to add a startup item yourself.

## Two kinds of startup

There are two little families of functions here:

- **This project** — the `*_on_startup` functions link the `.sprout` file you're
  running to your login. No name needed; Sprout figures out the file for you.
- **Any command** — the `*_with_pc` functions let you give a *name* and a
  *command*, so you can start anything (an app, a script, a website) at login.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `run_on_startup()` | Make **this** project's file run every time you log in. | `run_on_startup()` |
| `run_on_startup(no)` | Stop this project from running at startup. | `run_on_startup(no)` |
| `runs_on_startup()` | Is this project set to start with the PC? → `yes` / `no` | `show runs_on_startup()` |
| `start_with_pc("name", "command")` | Run **any** command at every login, under a name you choose. | `start_with_pc("MyApp", "notepad")` |
| `stop_with_pc("name")` | Undo a `start_with_pc` — stop that named command from starting. | `stop_with_pc("MyApp")` |
| `starts_with_pc("name")` | Is something set to start with the PC under this name? → `yes` / `no` | `show starts_with_pc("MyApp")` |

A few friendly things to know:

- `run_on_startup()` with **no argument** turns startup **on**. Pass a `no` (or
  anything falsy) to turn it **off** — that's `run_on_startup(no)`.
- The startup entry for your project is named after your file, like
  `Sprout - mygame`, so you can spot it in Windows if you ever go looking.
- Turning things **off** is gentle: `run_on_startup(no)` and `stop_with_pc(...)`
  won't complain if the entry wasn't there to begin with.
- These are instant one-shots. They read or change a Windows setting and return
  right away — there's no background work, so they won't keep your program alive.

## Example: run this project at every login

```sprout
use "automations"

~ Turn on startup, but only if it isn't already set.
when not runs_on_startup():
    run_on_startup()
    show "All set — I'll start with your PC from now on. 🌱"
otherwise:
    show "Already running at startup."
```

Changed your mind? Flip it off:

```sprout
use "automations"

run_on_startup(no)
show "Startup turned off. I'll stay quiet next login."
```

## Example: start any app with the PC

```sprout
use "automations"

~ Launch Notepad every time you log in.
start_with_pc("Notepad", "notepad")

when starts_with_pc("Notepad"):
    show "Notepad will open when you start your PC."

~ ...and later, undo it:
stop_with_pc("Notepad")
```

## Caveats

- **Windows only.** macOS/Linux aren't supported yet — Sprout will stop with a
  friendly note if you try.
- **No admin needed.** Everything uses your per-user Run list, so you don't have
  to run as administrator.
- `run_on_startup()` needs to know which file is your project's main file, so run
  your program the normal way: `sprout run yourmain.sprout`.

## See also

- [Libraries](../libraries.md) — every library and how to `use` one.
- [Projects](../projects.md) — connecting `.sprout` files into one project.
- [Getting started](../getting-started.md) — your first Sprout program.
