# automations: system stats & pop-ups 📊

The **automations** library can also tell you how your PC is *doing* — and pop a
little message on screen. Most functions here are "read it now" numbers: how busy
the processor is, how full a drive is, how much battery is left. You call them and
get a value straight back, perfect to `show` or compare. A few put something on
screen instead — a toast, a message box, a Yes/No question, or a text prompt. And
two of them, `watch_cpu` and `watch_ram`, quietly keep watch in the background and
run a task the moment things climb too high. Load it with the same `use` line:

```sprout
use "automations"

show cpu()              ~ how busy the processor is right now (0-100)
show ram()              ~ how much memory is in use (0-100)
notify("Done", "Tea is ready!")
```

> 🪟 **Windows only.** Every reading and pop-up here uses Windows features
> (PowerShell, WMI, toasts, and friends). On any other system they raise a
> friendly error instead of pretending to work. No admin needed.

## Functions

Almost everything is a number from `0` to `100` you can `show` or compare. The
pop-ups put something on screen and (for `confirm` / `ask_box`) hand back what the
user chose. The two `watch_*` functions are the only background work.

| Function | What it does | Example |
| --- | --- | --- |
| `cpu()` | how busy the processor is right now, `0`–`100` | `show cpu()` |
| `ram()` | how much memory is in use right now, `0`–`100` | `show ram()` |
| `disk()` / `disk("D")` | how full a drive is, `0`–`100` (defaults to `C`) | `show disk("C")` |
| `disk("C", "free")` | free space on that drive, in GB | `show disk("C", "free")` |
| `disk("C", "total")` | total size of that drive, in GB | `show disk("C", "total")` |
| `battery()` | battery charge left, `0`–`100` (desktops report `100`) | `show battery()` |
| `charging()` | is the PC plugged in or charging? → `yes` / `no` (desktops report `yes`) | `show charging()` |
| `pc_uptime()` | how long the PC has been on, in minutes | `show pc_uptime()` |
| `pc_uptime("hours")` | the same, but in hours | `show pc_uptime("hours")` |
| `processes()` | a sorted list of every running program name | `show processes()` |
| `processes("chrome")` | is that program running? → `yes` / `no` | `show processes("chrome")` |
| `idle_time()` | seconds since you last touched the mouse or keyboard | `show idle_time()` |
| `notify("Title", "Message")` | show a real Windows toast pop-up | `notify("Hi", "All done!")` |
| `popup("Message")` | show a message box with an **OK** button | `popup("Backup finished!")` |
| `confirm("Question?")` | ask a **Yes/No** question → `yes` / `no` | `when confirm("Save now?"): save()` |
| `ask_box("Prompt?")` | ask the user to type something → the text, or `nothing` | `make name to ask_box("Your name?")` |
| `watch_cpu(pct, "task")` | run a task whenever the CPU climbs over `pct`% | `watch_cpu(90, "warn_me")` |
| `watch_ram(pct, "task")` | run a task whenever memory use climbs over `pct`% | `watch_ram(85, "warn_me")` |

### A few friendly details

- **The readings are honest about missing hardware.** `battery()` on a desktop
  with no battery reports `100`, and `charging()` reports `yes` — they treat
  "always on power" as full and plugged in.
- **`disk` defaults to `C`.** A bare `disk()` reads your `C:` drive. You can pass
  any drive letter you have — `"c"`, `"C:"`, or `"C:\"` all work. Without a second
  word you get the **used percent**; add `"free"` or `"total"` for GB instead.
- **`processes("name")` is forgiving.** You can write `"chrome"` or `"chrome.exe"`
  — both check the same program. With no name, you get the full sorted list.
- **`notify` is a real toast.** It slides in from the corner and lands in the
  Action Center, just like a normal Windows notification.
- **Change the name & icon.** By default the toast says **Sprout** with the leaf
  icon. The first time you use `notify` (or `remind` / `timer`), a **`notify.bloom`**
  file appears next to your program — edit it to use your own name and picture:

  ```bloom
  ~ notify.bloom
  name: My Cool App
  icon: myicon.png      ~ a .png next to this file (blank = the Sprout leaf)
  ```
- **The pop-ups wait for you.** `popup`, `confirm`, and `ask_box` pause your
  program until you click or type, so the answer is ready the moment they return.
  `confirm` gives back `yes` / `no`; `ask_box` gives back the text you typed, or
  `nothing` if you leave it empty or hit Cancel.
- **`watch_cpu` / `watch_ram` keep running.** They fire only on the *upward*
  crossing — the moment the reading climbs past your line — and re-arm once it
  drops back below. While either is set, Sprout keeps a quiet ~5-second loop alive
  in the background, so your program stays running. Press **Ctrl+C** to stop. The
  percent must be `1`–`100`, and the task must already be defined.

## Example: a little health check

Read a handful of values and show them in one go.

```sprout
use "automations"

show "CPU:", cpu(), "%"
show "RAM:", ram(), "%"
show "C: drive used:", disk("C"), "%"
show "Battery:", battery(), "%"
show "Charging?", charging()
show "Up for", pc_uptime("hours"), "hours"

when disk("C") > 90:
    notify("Disk getting full", "Time for a tidy-up!")
```

## Example: ask, watch, and warn

Ask a quick question, then keep an eye on the CPU and pop a toast if it spikes.

```sprout
use "automations"

make name to ask_box("What's your name?")
when name is not nothing:
    popup("Hi " + name + "! I'll watch your PC for you.")

task warn_me():
    notify("Heads up", "Your CPU is running hot! 🔥")

watch_cpu(90, "warn_me")     ~ runs warn_me the moment CPU passes 90%
```

## See also

- [Libraries](../libraries.md) — `use`, the wider **automations** functions, and
  `sprout modules`
- [automations: system control](automations-system.md) — boss your PC around:
  volume, dark mode, sleep, lock, and more
- [automations: event triggers](automations-triggers.md) — run tasks the moment
  something changes in the real world
