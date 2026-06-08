# automations: launch & control apps

Sometimes you want your program to open a real app, peek at whether something is
already running, or close a program for you. The **automations** library gives
you three tiny helpers for exactly that: `launch`, `running`, and `closeapp`.
They're instant, one-shot helpers — each one does its thing and hands back an
answer right away. They don't keep your program running in the background, so you
can sprinkle them into any script.

Add the library with `use` at the top of your program:

```sprout
use "automations"
```

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `launch("name")` | start a program, app, file, or website in the background | `launch("notepad")` |
| `running("name")` | is that program running right now? → `yes` / `no` | `running("notepad")` |
| `closeapp("name")` | close a running program → `yes` if it was closed, else `no` | `closeapp("notepad")` |

A few honest notes:

- **`launch` gives back `nothing`.** It just starts the thing and moves on — it
  doesn't tell you whether the app actually opened. If the name is empty, you get
  a friendly error instead.
- **Names auto-grow an `.exe` on Windows.** When you ask about or close a
  program, `"notepad"` is treated as `notepad.exe`. If you already wrote
  `"chrome.exe"`, it's left as-is. (This `.exe` handling only applies to
  `running` and `closeapp`, not to `launch`.)
- **`launch` is the flexible one.** On Windows it uses the system `start`, so it
  happily opens a program (`"notepad"`), a file (`"notes.txt"`), or a website
  (`"https://example.com"`) — Windows picks the right app for each.
- **Cross-platform, with Windows in mind.** On Windows these use the built-in
  `tasklist` (running), `taskkill /F` (closeapp), and `start` (launch). On other
  systems they fall back to `pgrep`, `pkill`, and your shell. No administrator
  rights are needed.
- **`closeapp` force-closes.** It tells the program to quit immediately, so it
  won't ask you to save first. Use it on things that are safe to close.
- **Best-effort.** `running` and `closeapp` ask the system and report back what
  it says — if the program wasn't there, `closeapp` just gives `no`.

## Example: open Notepad if it isn't open yet

```sprout
use "automations"

when running("notepad"):
    show "Notepad is already open."
otherwise:
    show "Opening Notepad..."
    launch("notepad")
```

## Example: a tiny "close it for me" helper

```sprout
use "automations"

make name = "notepad"

when running(name):
    make closed = closeapp(name)
    when closed:
        show name, "is now closed."
    otherwise:
        show "Couldn't close", name
otherwise:
    show name, "wasn't running."
```

You can also open a website or a file the same way:

```sprout
use "automations"

launch("https://example.com")   ~ opens in your default browser
launch("notes.txt")             ~ opens in your default text editor
```

## See also

- [Libraries](../libraries.md) — how `use` works and what else `automations` offers
- [Built-in Functions](../builtins.md) — the helpers that come with Sprout
- [Sprout syntax](../sprout-syntax.md) — `when` / `otherwise`, `make`, and friends
