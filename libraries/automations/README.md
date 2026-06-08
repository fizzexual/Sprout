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
