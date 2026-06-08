# automations — do things on a schedule

`use "automations"` lets your program run tasks over time — every few seconds,
after a delay, at a clock time, or whenever a file changes.

```sprout
use "automations"

make count = 0
task tick():
    set count = count + 1
    show "tick", count
    when count >= 5:
        stop()

every(1, "tick")        ~ run tick once a second, until it stops itself
```

| Function | What it does |
| --- | --- |
| `every(seconds, "task")` | run a task again and again, every N seconds |
| `after(seconds, "task")` | run a task once, after N seconds |
| `at("HH:MM", "task")` | run a task every day at a clock time |
| `watch("file", "task")` | run a task whenever a file changes on disk |
| `wait(seconds)` | pause the program (fractions are fine: `wait(0.5)`) |
| `now()` | the time right now, e.g. `"14:30:05"` |
| `today()` | today's date, e.g. `"2026-06-08"` |
| `stop()` | stop all automations and end the program |

`every` / `after` / `at` / `watch` keep your program running in the background
(like a bot's listen loop) — press **Ctrl+C**, or call `stop()` from a task, to
end it. `wait` / `now` / `today` are instant and work in any program.

## Apps & your PC

Start programs, check what's running, close them, and decide what runs when the
computer boots.

```sprout
use "automations"

launch("notepad")                        ~ start an app in the background
when running("chrome"):                  ~ is Chrome open?
    show "Chrome is open"
closeapp("notepad")                      ~ close it again

start_with_pc("MyBot", "node C:\\bot.js")  ~ run this every time the PC starts
show "auto-starts?", starts_with_pc("MyBot")
stop_with_pc("MyBot")                       ~ undo it
```

| Function | What it does |
| --- | --- |
| `launch("program")` | start a program, app, file, or website in the background |
| `running("name")` | is that program running right now? → `yes` / `no` |
| `closeapp("name")` | close a running program |
| `start_with_pc("name", "command")` | run a command every time the PC starts |
| `stop_with_pc("name")` | stop it from starting with the PC |
| `starts_with_pc("name")` | is it set to start with the PC? → `yes` / `no` |

`start_with_pc` uses your **per-user** Windows startup list, so it needs **no
administrator rights** — a program can register itself. (These app/PC tools are
Windows-focused.)
