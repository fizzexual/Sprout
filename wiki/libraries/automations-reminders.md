# automations: reminders & life triggers ⏰

The [`automations`](../libraries.md#automations--run-tasks-on-a-schedule-) library
can also nudge you and watch over your day. These are **reminders, timers, and
little life triggers**: pop a toast in 10 minutes, beep when the tea's ready, time
how long something takes, or run a task the moment you lock the PC, copy some text,
or a drive runs low on space. Load them with the usual `use` line:

```sprout
use "automations"
```

Here's the idea — set a reminder and a quick timer:

```sprout
use "automations"

remind("in 20 minutes", "Stretch your legs! 🦵")
timer("5 minutes", "Tea is ready! 🍵")

show "Reminders set. (press Ctrl+C to stop)"
```

> 🪟 **Windows only.** Everything here uses Windows features — the toast pop-ups,
> the beep, and the watchers that read the lock screen, clipboard, and disk space.
> On other systems they politely refuse with a friendly error. No admin needed.

## The functions

`remind`, `timer`, and the `on_*` watchers all **keep your program running** in
the background so they can fire later, and they pop a native Windows **toast** (or
run your task) when they do. `stopwatch` and `elapsed` act right away.

Times can be a number of seconds **or** friendly text like `"10 minutes"`,
`"2 hours"`, `"1 day"`, `"30s"`. Sizes can be a number of bytes **or** text like
`"5 GB"` or `"500 MB"`.

| Function | What it does | Example |
| --- | --- | --- |
| `remind(when, "message")` | pops a toast later — `"in 20 minutes"`, `"at 5pm"`, or just a duration | `remind("at 5pm", "Call mum 📞")` |
| `timer(time, "message")` | counts down, then **beeps** and pops a toast | `timer("5 minutes", "Tea! 🍵")` |
| `stopwatch()` | starts (or restarts) a stopwatch from now | `stopwatch()` |
| `elapsed()` | how long since `stopwatch()`, as friendly text like `"3m 12s"` | `show elapsed()` |
| `elapsed("seconds")` | the same, but as a plain number of seconds | `show elapsed("seconds")` |
| `on_lock("task")` | runs a task the moment you **lock** the PC | `on_lock("pause_music")` |
| `on_unlock("task")` | runs a task the moment you come back and **unlock** | `on_unlock("welcome_back")` |
| `on_clipboard("task")` | runs a task whenever you **copy** fresh text | `on_clipboard("save_it")` |
| `on_low_disk(drive, size, "task")` | runs a task when a drive's free space drops below a limit | `on_low_disk("C:", "5 GB", "warn_me")` |

A few friendly details:

- **`remind`** understands three shapes: `"in 20 minutes"` (a delay from now),
  `"at 5pm"` (the next time the clock hits that — today, or tomorrow if it's
  already passed), or a bare duration like `"30s"` treated as a delay.
- **Clock times** for `"at ..."` can look like `"8:30"`, `"08:00"`, or `"8:30pm"`.
- **`on_low_disk`** wants a drive like `"C:"` and a size like `"5 GB"`. It fires
  **once** as the free space dips under the line — not over and over while it
  stays low.

## A little example: a desk timer

Start a stopwatch, take a quick reading, then a longer countdown with a beep:

```sprout
use "automations"

stopwatch()
show "Working... ⏱️"

~ ...do some work...

show "You've been at it for", elapsed()      ~ e.g. "3m 12s"

timer("25 minutes", "Pomodoro done — take a break! ☕")
remind("in 5 minutes", "Quick posture check 🪑")

show "Timers running. Press Ctrl+C to stop."
```

When the program reaches the end, Sprout *keeps running* so the timer and reminder
can fire. It prints a little summary of what it's watching when there are watchers
to arm, like:

```
⏰ Reminders armed:
   on_lock -> pause_music
   on_clipboard -> save_it
   (press Ctrl+C to stop)
```

## A handy one: life triggers

Define a task, then point a watcher at it. Here, lock the PC and it pauses; copy
something and it saves; let `C:` get low and it warns you:

```sprout
use "automations"

task pause_music():
    show "🔒 Locked — pausing."

task welcome_back():
    show "👋 Welcome back!"

task save_it():
    show "📋 Copied something — saving it."

task warn_me():
    show "⚠️ Heads up: C: is getting low on space!"

on_lock("pause_music")
on_unlock("welcome_back")
on_clipboard("save_it")
on_low_disk("C:", "5 GB", "warn_me")

show "Watching... (press Ctrl+C to stop)"
```

## Good to know

- **Edge, not level.** The `on_*` watchers fire on the *change* — the moment you
  lock, copy, or cross the disk limit — not over and over while it stays true.
- **It keeps the program alive.** A pending `remind` / `timer`, or any `on_*`
  watcher, keeps your program running in the background. Press **Ctrl+C** to stop.
- **Best-effort timing.** Watchers check on a gentle loop (lock and clipboard
  every second or two; disk space every minute, to be kind to your machine), so a
  trigger fires a moment *after* the change, not the exact instant.
- **A wobbly trigger won't crash your program.** If a task hits a problem, Sprout
  prints a friendly note and keeps every other watcher running.
- **`elapsed()` needs a stopwatch.** Call `stopwatch()` first, or `elapsed()`
  will gently remind you to start one.

## See also

- [Libraries](../libraries.md) — all of Sprout's libraries, and `sprout modules`
- [automations: event triggers](automations-triggers.md) — watch USB, apps, wifi, battery, keys
- [automations: scheduling](automations-scheduling.md) — run tasks on a clock or repeat
