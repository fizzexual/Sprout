# automations: event triggers ⚡

The [`automations`](../libraries.md#automations--run-tasks-on-a-schedule-) library
also knows how to watch the **real world**. These **event triggers** don't run on
a clock — they fire a task the *moment* something changes: you walk away, a USB
stick goes in, an app opens, you join wifi, the battery dips, or you tap a key.
Each one runs a task **when** something happens, and your program keeps running in
the background so the watchers can keep firing. Load them with the same `use` line:

```sprout
use "automations"
```

Here's the idea — define a task, then tell a trigger to run it:

```sprout
use "automations"

task locked():
    show "Welcome back! 👋"

when_back("locked")     ~ runs the moment you touch the PC again
```

> 🪟 **Windows only.** These triggers read Windows-specific signals (idle time,
> USB drives, running apps, wifi, battery, keys). On other systems they politely
> refuse with a friendly error. No admin needed.

## The triggers

Every trigger takes the **name of a task** (in quotes) to run when it fires. Some
take an extra detail first — a duration, an app name, a wifi name, a percent, or a
key. Times can be a number of seconds **or** friendly text like `"5 minutes"`,
`"2 hours"`, `"1 day"` (short forms `5m` / `2h` / `1d` also work).

| Function | What it does | Example |
| --- | --- | --- |
| `when_idle(time, "task")` | runs once when you've been away from the PC for that long | `when_idle("5 minutes", "go_away")` |
| `when_back("task")` | runs the moment you come back after being idle | `when_back("locked")` |
| `on_usb("task")` | runs when a USB / removable drive is plugged in | `on_usb("backup")` |
| `on_usb_removed("task")` | runs when a USB / removable drive is unplugged | `on_usb_removed("safe")` |
| `on_open("program", "task")` | runs when a program starts | `on_open("chrome", "focus_time")` |
| `on_close("program", "task")` | runs when a program closes | `on_close("game", "back_to_work")` |
| `on_wifi("network", "task")` | runs when you join that wifi network | `on_wifi("HomeWifi", "sync")` |
| `on_offline("task")` | runs when you lose your wifi / network connection | `on_offline("pause")` |
| `on_low_battery(percent, "task")` | runs when the battery drops below that percent (1–100) | `on_low_battery(20, "warn_me")` |
| `on_charging("task")` | runs when you plug the charger in | `on_charging("nice")` |
| `on_hotkey("key", "task")` | runs when you tap a key, anywhere | `on_hotkey("F8", "screenshot")` |

A few friendly details:

- **App names** for `on_open` / `on_close` are the program's name, like `"chrome"`
  or `"notepad"` — you can leave off the `.exe`, Sprout adds it for you.
- **Keys** for `on_hotkey` can be a letter (`"a"`), a number (`"5"`), a named key
  (`"space"`, `"enter"`, `"escape"`, `"tab"`, the arrows…), or a function key
  (`"F1"`–`"F12"`).
- **`on_low_battery`** wants a percent from **1 to 100**. Desktops without a
  battery simply never fire it.

## A little example

A friendly desk buddy — it greets you when you come back, cheers when you plug in,
and warns you when the battery's getting low:

```sprout
use "automations"

task hello_again():
    show "Welcome back! 👋"

task plugged_in():
    show "Nice — charging now. 🔌"

task battery_warning():
    show "Heads up: battery under 20%! 🪫"

when_back("hello_again")
on_charging("plugged_in")
on_low_battery(20, "battery_warning")

show "Watching... (press Ctrl+C to stop)"
```

When the program reaches the end, Sprout *keeps running* and arms the watchers. It
even prints a little summary of what it's watching, like:

```
⚡ Triggers armed:
   when_back -> hello_again
   on_charging -> plugged_in
   on_low_battery 20% -> battery_warning
   (press Ctrl+C to stop)
```

## A handy one: a screenshot hotkey

Tap **F8** anywhere and run whatever task you like — here, a tiny message:

```sprout
use "automations"

make shots = 0

task snap():
    set shots = shots + 1
    show "📸 click! that's", shots, "so far"

on_hotkey("F8", "snap")
show "Tap F8 to count a snap. Ctrl+C to quit."
```

## Good to know

- **Edge, not level.** Each trigger fires on the *change* — the moment you cross
  the line — not over and over while the condition stays true. `when_idle` fires
  *once* when you pass the idle time, then re-arms after you become active again.
- **It keeps the program alive.** Any trigger keeps your program running in the
  background so it can watch. Press **Ctrl+C** to stop, or call
  [`stop()`](../libraries.md#automations--run-tasks-on-a-schedule-) from a task.
- **Best-effort timing.** Watchers check on a gentle loop (hotkeys are fastest;
  battery is checked the least often, to be kind to your machine), so a trigger
  fires a moment *after* the change, not the exact instant.
- **A wobbly trigger won't crash your program.** If a task hits a problem, Sprout
  prints a friendly note and keeps every other watcher running.

## See also

- [Libraries](../libraries.md) — all of Sprout's libraries, and `sprout modules`
- [Sprout Syntax](../sprout-syntax.md) — `task`, `make`/`set`, `when`, and more
