# automations: system control 🖥️

The **automations** library can also reach out and gently boss your PC around.
Turn the volume up, flip on dark mode, set the wallpaper, lock the screen, put the
computer to sleep, copy text to the clipboard, or have Windows read something out
loud. Almost every function is a one-shot "do it now" action — you call it and it
happens straight away. The one exception is `keepawake`, which leaves a tiny
heartbeat running in the background to stop the PC from dozing off.

> 🪟 **Windows only.** These controls use Windows features (PowerShell, the
> registry, Core Audio, and friends). On any other system they raise a friendly
> error instead of pretending to work.

Add it to the top of your program:

```sprout
use "automations"

volume(50)            ~ set the speakers to 50%
darkmode(yes)         ~ switch Windows to dark mode
say("hello there")    ~ speak text out loud
```

## Functions

Many of these do **two** jobs: call them with **no value** to *read* the current
state, or **with a value** to *set* it.

| Function | What it does | Example |
| --- | --- | --- |
| `volume()` | read the current speaker volume, a whole number `0`–`100` | `show volume()` |
| `volume(n)` | set the speaker volume to `n` percent (clamped to `0`–`100`) | `volume(40)` |
| `mute()` | toggle mute on / off | `mute()` |
| `mute(yes)` / `mute(no)` | force mute on, or off | `mute(yes)` |
| `muted()` | are we muted, as far as Sprout knows? → `yes` / `no` (best-effort) | `show muted()` |
| `shutdown(time)` | shut the PC down after a delay | `shutdown("5 minutes")` |
| `shutdown(no)` | cancel a shutdown you scheduled earlier | `shutdown(no)` |
| `restart(time)` | restart the PC after a delay | `restart("1 minute")` |
| `restart(no)` | cancel a scheduled restart | `restart(no)` |
| `sleep()` | put the PC to sleep right now | `sleep()` |
| `lock()` | lock the screen (like pressing Win+L) | `lock()` |
| `darkmode()` | is Windows in dark mode? → `yes` / `no` | `show darkmode()` |
| `darkmode(yes)` / `darkmode(no)` | turn dark mode on, or back to light | `darkmode(yes)` |
| `wallpaper("file")` | set the desktop background; gives back the file name it used | `wallpaper("sky.jpg")` |
| `clipboard()` | read the current clipboard text | `show clipboard()` |
| `clipboard("text")` | copy text to the clipboard | `clipboard("hello")` |
| `brightness()` | read the screen brightness `0`–`100` | `show brightness()` |
| `brightness(n)` | set the screen brightness to `n` percent | `brightness(70)` |
| `keepawake(yes)` | stop the PC from sleeping or dimming | `keepawake(yes)` |
| `keepawake(no)` | let it sleep normally again | `keepawake(no)` |
| `say("text")` | speak text out loud with the Windows voice | `say("done!")` |

### A few friendly details

- **Times are friendly.** `shutdown` and `restart` take a number of *seconds*
  **or** plain text: `"30 seconds"`, `"10 minutes"`, `"2 hours"`, `"1 day"`
  (short forms `30s` / `10m` / `2h` / `1d` work too).
- **`shutdown(no)` / `restart(no)`** cancel a *pending* countdown. Schedule one
  first; if a previous shutdown is already queued, cancel it before scheduling a
  new one.
- **`wallpaper` looks next to your program.** A bare name like `"sky.jpg"` is
  resolved beside your Sprout file, so you don't need the full path. It hands back
  just the file name it used.
- **`mute` is best-effort.** Windows makes the true mute state awkward to read
  reliably, so Sprout remembers whether *it* last muted, and that's what `muted()`
  reports. `mute()` with no value just toggles.
- **`brightness` needs the right hardware.** It works on laptops and supported
  monitors. On a desktop with a screen that doesn't expose brightness control,
  reading or setting it raises a friendly error.
- **`volume()` can return `nothing`.** Reading the level fails gracefully on a few
  audio devices — you get `nothing` back instead of a crash.
- **`keepawake` keeps Sprout running.** While it's on, a quiet heartbeat fires
  about every 50 seconds to keep Windows awake, which keeps your program alive in
  the background. Call `keepawake(no)` to stop it and let normal power settings
  resume.

## Example: a little "focus mode"

Dim the world, copy a reminder, and let the PC know you're staying put.

```sprout
use "automations"

darkmode(yes)               ~ easy on the eyes
volume(20)                  ~ quiet, but not silent
brightness(60)
keepawake(yes)              ~ no sleeping while I work
clipboard("Back at 3pm.")   ~ ready to paste
say("Focus mode on.")
```

When you're done:

```sprout
use "automations"

keepawake(no)               ~ let it rest again
darkmode(no)
say("All finished.")
```

## Example: gentle goodnight

Read a couple of values back, then schedule a shutdown — with an easy out.

```sprout
use "automations"

show "Volume is", volume()
show "Dark mode?", darkmode()

mute(yes)                   ~ silence first
shutdown("10 minutes")      ~ shut down in 10
say("Shutting down in ten minutes. Sleep well.")

~ changed your mind? run this instead:
~ shutdown(no)
```

## See also

- [Libraries](../libraries.md) — `use`, the wider **automations** scheduling
  functions (`every`, `after`, `at`, `launch`), and `sprout modules`
- [Built-in Functions](../builtins.md) — the functions every Sprout program has
- [Sprout Syntax](../sprout-syntax.md) — `make`, `set`, `show`, `when`, and the rest
