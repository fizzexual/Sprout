# automations: scheduling & clock

The `automations` library gives Sprout a sense of time. It can tell you what time
it is right now, and it can run your tasks *later* — on a timer, at a clock time,
on certain days, even at sunrise. Sprout runs one thing at a time, so the
scheduling functions don't block your program: they quietly **register** a job
while your code runs, then once your program finishes the scheduler turns the
timers on and keeps Sprout alive in the background. The "answer right now"
helpers (`wait`, `now`, `today`, `weekday`, `sunrise`, `sunset`) reply instantly.

Add it at the top of your program:

```sprout
use "automations"
```

## Friendly time strings

You almost never have to count seconds. Two kinds of friendly text show up a lot:

- **Durations** — a plain number is *seconds*, or write text like
  `"30 seconds"`, `"10 minutes"`, `"2 hours"`, `"1 day"`. Short forms work too:
  `"30s"`, `"10m"`, `"2h"`, `"1d"`. Used by `wait`, `every`, `after`,
  `countdown`, and `snooze`.
- **Clock times** — `"08:00"`, `"8:30pm"`, `"14:30"`, even with a day name like
  `"Monday 09:00"` or `"fri 5:00 pm"`. A day name makes it *weekly*; no day name
  means *every day*. Used by `at`, `alarm`, `on_days`, `on_first`, and `catch_up`.

If Sprout can't make sense of the time you typed, it stops and tells you, with an
example of what it expected. 

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `wait(time)` | pause the program right here | `wait("0.5")` · `wait("2 minutes")` |
| `now()` | the time now, as `"14:30:05"` | `show now()` |
| `now("12h")` | the time now in 12-hour form, `"2:30 PM"` | `show now("12h")` |
| `today()` | today's date, `"2026-06-08"` | `show today()` |
| `weekday()` | the day name, `"Monday"` | `show weekday()` |
| `every(time, "task")` | run a task again and again on a timer | `every(5, "tick")` |
| `every(time, "task", count)` | …but only `count` times, then stop | `every(5, "tick", 3)` |
| `after(time, "task")` | run a task once, after a delay | `after("1 minute", "wrap_up")` |
| `at("time", "task")` | run at a clock time — daily, or weekly with a day name | `at("08:00", "wakeup")` |
| `watch("file", "task")` | run a task whenever a file changes on disk | `watch("notes.txt", "reload")` |
| `countdown(time, "task", "label")` | a live ticking `T-MM:SS` countdown, then run the task | `countdown("10 seconds", "liftoff", "Launch in")` |
| `alarm("time", "message")` | at the time, beep and print your message | `alarm("7:00am", "Time to wake up!")` |
| `ring()` | make a sound right now (a beep) | `ring()` |
| `snooze(time)` | from inside a task, run *this same task* again later | `snooze("9 minutes")` |
| `on_days("days", "time", "task")` | run on certain days at a clock time | `on_days("weekdays", "09:00", "standup")` |
| `on_first("nth", "day", "time", "task")` | run on, say, the first Monday of each month | `on_first("first", "Monday", "10:00", "report")` |
| `sunrise()` | today's sunrise time, `"HH:MM"` | `show sunrise()` |
| `sunset()` | today's sunset time, `"HH:MM"` | `show sunset()` |
| `at_sunrise("task")` | run a task at sunrise (recomputed daily) | `at_sunrise("greet_the_day")` |
| `at_sunset("task")` | run a task at sunset (recomputed daily) | `at_sunset("dim_lights")` |
| `catch_up("time", "task")` | if today's time already passed and we missed it, run once now | `catch_up("09:00", "report")` |
| `stop()` | stop all automations and end the program | `stop()` |

A task name is always written as text, like `"tick"`, and points at a `task` you
defined. Sprout needs the task to have a name, and durations must be greater than
zero.

## A few details worth knowing

**`every` with a count.** Pass a third number to limit the repeats. After that
many runs, that timer stops on its own:

```sprout
every(2, "ping", 3)    ~ runs "ping" three times, two seconds apart
```

**`at` — daily vs. weekly.** With just a time it fires every day. Add a day name
and it fires once a week on that day:

```sprout
at("08:00", "wakeup")           ~ every day at 8am
at("Monday 09:00", "standup")   ~ only on Mondays at 9am
```

**`countdown`** prints a ticking `T-MM:SS` on a single line (you can change the
`"T-"` label), then runs the task when it hits zero. If you skip the label it
defaults to `"T-"`.

**`alarm` and `ring`.** `alarm` waits for the time, then beeps and prints your
message. `ring()` beeps immediately — handy on its own, or to confirm a sound
works.

**`snooze`** only works *inside* a task that an automation started (like an
`alarm` or `at` task). It re-runs that same task after the delay you give:

```sprout
task wake():
    show "Good morning!"
    snooze("9 minutes")    ~ nudge me again in 9 minutes
```

**`on_days`** accepts `"weekdays"`, `"weekends"`, or a list of day names like
`"Monday, Thursday"`. **`on_first`** takes `"first"`, `"second"`, `"third"`,
`"fourth"`, or `"last"` (numbers like `"1"` / `"2nd"` work too), plus a day name.

**`catch_up`** is the "if we missed it, do it now" helper. When your program
starts, if today's time has already gone by and the task hasn't run yet today, it
runs it once and remembers that in a tiny `.sprout-automations.json` file next to
your program. After that it behaves like a normal daily `at`.

**Keeping Sprout alive.** Anything that schedules future work (`every`, `after`,
`at`, `watch`, `countdown`, `alarm`, `on_days`, `on_first`, `at_sunrise`,
`at_sunset`, `catch_up`) keeps the program running in the background. Press
**Ctrl+C**, or call `stop()` from a task, to end it. When jobs start, Sprout
prints a friendly summary of everything that's scheduled.

## Caveats (honest notes)

- **Sounds are Windows-flavoured.** `ring()` (and `alarm`) play a console beep and
  try the Windows alarm chime (`C:\Windows\Media\Alarm01.wav`) via PowerShell. The
  beep is best-effort; the chime is skipped if it isn't there.
- **Sunrise/sunset use a default location.** There's no instant way to know where
  you are, so the math uses a fixed spot near `40.0, -74.0` (roughly the US east
  coast / "near New York"). Times are approximate, and Sprout prints a note saying
  so. On the rare polar day where the sun never rises or sets, `sunrise()` /
  `sunset()` return `nothing`.
- **`watch` paths** are relative to your program's folder. File saves often fire
  twice, so the watcher waits a moment to avoid running your task double.

## Example: a tiny ticker

```sprout
use "automations"

make count = 0

task tick():
    set count = count + 1
    show "tick", count, "at", now()
    when count >= 5:
        show "Done!"
        stop()

every("2 seconds", "tick")    ~ run tick over and over, every 2 seconds
```

This counts to five — printing the time on each tick — then stops itself.

## Example: a morning routine

```sprout
use "automations"

task standup():
    show "Stand-up time! 🧍"
    ring()

task report():
    show "Monthly report due today 📋"

on_days("weekdays", "09:00", "standup")          ~ Mon–Fri at 9am
on_first("first", "Monday", "10:00", "report")   ~ first Monday each month
catch_up("09:00", "standup")                     ~ ran late today? do it now
```

Leave this running and it nudges you every weekday morning, files a reminder on
the first Monday of the month, and catches up if you started it after 9am.

## See also

- [Libraries](../libraries.md) — how `use` works and what else is built in
- [Built-in functions](../builtins.md) — the everyday functions Sprout ships with
- [Getting started](../getting-started.md) — write and run your first program
