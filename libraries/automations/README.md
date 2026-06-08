# automations — do things on a schedule

`use "automations"` lets your program run tasks over time, control apps, and even
run your whole project automatically every time the PC starts.

## Scheduling

```sprout
use "automations"

make count = 0
task tick():
    set count = count + 1
    show "tick", count, "at", now()

every("2 seconds", "tick")      ~ a number of seconds, OR friendly text
after("1 minute", "wrapup")
task wrapup():
    show "time's up!"
    stop()
```

Times can be a plain number of seconds, or text like `"30 seconds"`,
`"10 minutes"`, `"2 hours"`, `"1 day"` (short forms `30s` / `10m` / `2h` / `1d`
work too).

| Function | What it does |
| --- | --- |
| `every(time, "task")` | run a task again and again |
| `every(time, "task", count)` | …but only `count` times, then stop |
| `after(time, "task")` | run a task once, after a delay |
| `at("time", "task")` | run a task at a clock time — daily, or weekly |
| `watch("file", "task")` | run a task whenever a file changes |
| `wait(time)` | pause the program (e.g. `wait("0.5")`, `wait("2 minutes")`) |
| `stop()` | stop all automations and end the program |

`at` understands `"08:00"`, `"8:30pm"`, and a weekday like `"Monday 09:00"`
(which then repeats weekly).

## Clock helpers

| Function | What it does |
| --- | --- |
| `now()` | the time now, `"14:30:05"` — or `now("12h")` → `"2:30 PM"` |
| `today()` | today's date, `"2026-06-08"` |
| `weekday()` | the day name, `"Monday"` |

## Run your project on startup

Make **this Sprout project** run every time you log in — perfect for a bot or a
reminder that should always be on. It links your exact `.sprout` main file, so it
keeps working even if `sprout` isn't on the PATH.

```sprout
use "automations"

run_on_startup()                 ~ this project now starts with the PC
show "auto-start on?", runs_on_startup()
~ run_on_startup(no)            ~ ...turn it back off
```

| Function | What it does |
| --- | --- |
| `run_on_startup()` | run this project's main file every time the PC starts |
| `run_on_startup(no)` | stop it running at startup |
| `runs_on_startup()` | is this project set to start with the PC? → `yes` / `no` |

This uses your **per-user** Windows startup list, so it needs **no admin**.

## Apps & the PC

| Function | What it does |
| --- | --- |
| `launch("program")` | start a program, app, file, or website in the background |
| `running("name")` | is that program running right now? → `yes` / `no` |
| `closeapp("name")` | close a running program |
| `start_with_pc("name", "command")` | run any command at startup |
| `stop_with_pc("name")` | undo a `start_with_pc` |
| `starts_with_pc("name")` | is that command set to start with the PC? → `yes` / `no` |

`every` / `after` / `at` / `watch` keep the program running in the background
(like a bot's listen loop) — press **Ctrl+C**, or call `stop()` from a task, to
end it. `wait` / `now` / `today` / `weekday` are instant and work in any program.
(The app/PC tools are Windows-focused.)
