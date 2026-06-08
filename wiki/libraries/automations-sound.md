# automations: sound, mic & windows 🔊

The **automations** library can make a little noise and tidy your screen, too.
Beep out a note, play a `.wav` file, mute or unmute your microphone, switch on
Do Not Disturb, flash to the desktop, minimize everything, or yank a window to
the front. Every helper here is a one-shot "do it now" action — you call it, it
does its thing on Windows, and hands an answer straight back. Nothing keeps
running in the background, so you can drop these into any program.

> 🪟 **Windows only.** These use Windows features (PowerShell, Core Audio, the
> notification registry, and friends). On any other system they raise a friendly
> error instead of pretending to work.

Add the library at the top of your program:

```sprout
use "automations"

beep()                   ~ a quick 880Hz beep
mute_mic(yes)            ~ mute the microphone
focus_window("Notepad")  ~ bring a window to the front
```

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `beep()` | a quick `880`Hz beep for about a fifth of a second | `beep()` |
| `beep(freq, ms)` | beep at `freq` Hz for `ms` milliseconds | `beep(440, 500)` |
| `play_sound("file")` | play a sound file (a `.wav` works best) and wait for it to finish | `play_sound("ding.wav")` |
| `mute_mic()` | toggle the microphone — flip whatever it is now | `mute_mic()` |
| `mute_mic(yes)` / `mute_mic(no)` | mute the mic, or unmute it | `mute_mic(yes)` |
| `mic_muted()` | is the microphone muted? → `yes` / `no` | `show mic_muted()` |
| `dnd()` | is Do Not Disturb on? → `yes` / `no` | `show dnd()` |
| `dnd(yes)` / `dnd(no)` | silence notifications, or allow them again | `dnd(yes)` |
| `show_desktop()` | flip to the desktop (call again to bring your windows back) | `show_desktop()` |
| `minimize_all()` | minimize every open window | `minimize_all()` |
| `focus_window("title")` | bring a window to the front by part of its title → `yes` if found | `focus_window("Notepad")` |

### A few friendly details

- **`beep` stays in a safe range.** The frequency is clamped to `37`–`32767` Hz
  and the length to `1`–`5000` ms (one to five seconds) — that's what Windows
  allows. Call it with no values for the default quick beep.
- **`play_sound` looks next to your program.** A bare name like `"ding.wav"` is
  resolved beside your Sprout file, so you don't need the full path. It waits for
  the sound to finish before moving on, and gives a clear "couldn't find that
  sound" error if the file isn't there.
- **`mute_mic` with no value toggles.** Pass `yes` to mute or `no` to unmute, or
  call it bare to flip the current state. It targets your default microphone.
- **`mic_muted()` can return `nothing`.** If there's no mic, or Windows won't say,
  you get `nothing` back instead of a crash.
- **`dnd` reads and sets.** With no value it tells you whether Do Not Disturb is
  on; with `yes` it silences notification toasts, and `no` lets them through. It
  hands back the value it just set.
- **`show_desktop()` is a toggle.** The first call dives to the desktop; call it
  again to bring all your windows back.
- **`focus_window` matches part of the title.** `"Notepad"` will find a window
  whose title contains "Notepad". You get `yes` if a match was found and raised,
  or `no` if nothing matched.

## Example: a tiny kitchen timer

Count down quietly, then make some noise when time's up.

```sprout
use "automations"

show "Three quick beeps, then we're done."

repeat 3 times:
    beep(660, 150)
    wait(0.4)

beep(440, 700)            ~ a lower note to finish
show "Time's up!"
```

## Example: focus mode

Hush the mic, silence notifications, clear the screen, then open your work.

```sprout
use "automations"

mute_mic(yes)            ~ no accidental hot mic
dnd(yes)                 ~ silence the pop-ups
minimize_all()           ~ clean slate

when focus_window("Notepad"):
    show "Back to Notepad."
otherwise:
    show "Notepad isn't open."
```

When you're done, undo it:

```sprout
use "automations"

mute_mic(no)             ~ mic back on
dnd(no)                  ~ notifications back on
show mic_muted()         ~ should say no
```

## See also

- [Libraries](../libraries.md) — how `use` works and what else **automations** offers
- [automations: system control](automations-system.md) — `volume`, `mute`, `say`, `lock`, and more PC controls
- [automations: launch & control apps](automations-apps.md) — `launch`, `running`, and `closeapp`
