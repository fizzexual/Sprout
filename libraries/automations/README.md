# automations

Run tasks on a schedule, control the PC, react to events, and run your project
on startup. Add it with `use "automations"`.

```sprout
use "automations"
task tick():
    show "tick at", now("12h")
every("2 seconds", "tick")
```

The library is split into topic files so each part is easy to read:

| File | What's inside | Docs |
| --- | --- | --- |
| [`scheduling.ts`](scheduling.ts) | wait, now, today, weekday, every, after, at, watch, stop, countdown, alarm, snooze, on_days, sunrise/sunset | [Scheduling & clock](../../wiki/libraries/automations-scheduling.md) |
| [`startup.ts`](startup.ts) | run_on_startup, start_with_pc, starts_with_pc | [Run on PC startup](../../wiki/libraries/automations-startup.md) |
| [`apps.ts`](apps.ts) | launch, running, closeapp | [Launch & control apps](../../wiki/libraries/automations-apps.md) |
| [`system.ts`](system.ts) | volume, mute, shutdown, restart, sleep, lock, darkmode, wallpaper, clipboard, brightness, keepawake, say | [System control](../../wiki/libraries/automations-system.md) |
| [`macros.ts`](macros.ts) | type, press, screenshot, copy_text, movemouse, click, mousepos, typeto | [Keyboard / mouse / screenshot](../../wiki/libraries/automations-macros.md) |
| [`triggers.ts`](triggers.ts) | when_idle, on_usb, on_open, on_wifi, on_low_battery, on_hotkey | [Event triggers](../../wiki/libraries/automations-triggers.md) |
| [`routines.ts`](routines.ts) | workmode, pomodoro, morning, bedtime, routine | [One-word routines](../../wiki/libraries/automations-routines.md) |

`index.ts` just merges the topic modules together. Full reference:
**[wiki/libraries](../../wiki/libraries/README.md)**.

> The system, macro, trigger, and routine features are **Windows-focused**.
> Times accept seconds or friendly text like `"10 minutes"` / `"2h"` / `"1 day"`.
