# automations: one-word routines

Some mornings you just want to type **one word** and have your whole setup spring
to life. That's what this little module is for. It bundles up the big jobs —
blocking distractions, opening your apps, and speaking out loud — into friendly
one-word "modes" like `workmode`, `pomodoro`, `morning`, and `bedtime`. You can
also give one of **your own** tasks a name with `routine`, then `run_routine` it
later.

Add it at the top of your program:

```sprout
use "automations"
```

After that, all the functions below work just like the built-in ones.

> **Heads up — this is a Windows toy.** The speaking, muting, screen-dimming, and
> the bedtime shutdown all use Windows tools, so on other systems those steps
> quietly do nothing. And because focus modes edit a protected system file (the
> **hosts file**), you need to **run as administrator** for the blocking to work —
> right-click your terminal or VS Code and choose "Run as administrator".

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `routine("name", "taskName")` | give one of **your** tasks a friendly routine name | `routine("study", "open_notes")` |
| `run_routine("name")` | run a routine you saved earlier | `run_routine("study")` |
| `workmode()` | focus! block distractions, open your work apps, and mute | `workmode()` |
| `workmode(no)` | undo it — unblock those sites again | `workmode(no)` |
| `pomodoro()` | a focus/break loop, on repeat (blocks during focus) | `pomodoro()` |
| `pomodoro(focus, break)` | …with your own focus and break times | `pomodoro("25 minutes", "5 minutes")` |
| `morning()` | open your apps, then speak today's weather out loud | `morning()` |
| `morning("city")` | …forecast a specific city instead of your location | `morning("Tokyo")` |
| `bedtime()` | wind down: dim the screen, block distractions, schedule a shutdown | `bedtime()` |
| `bedtime("time")` | …shut down after a longer (or shorter) wait | `bedtime("1 hour")` |
| `say("text")` | speak any text out loud (Windows voice) | `say("Hello there!")` |

### A little more on each one

**`workmode()`** turns on focus: it blocks a built-in list of distracting sites
(YouTube, Twitter/X, Reddit, Instagram, TikTok, Facebook, Netflix), opens your
work apps (your code editor and Google), mutes the sound, and announces it out
loud. Call **`workmode(no)`** to unblock those sites again when you're done.

**`pomodoro()`** arms a focus/break loop — **25 minutes** of focus, then a
**5 minute** break, over and over. During each focus block it blocks distractions
and says "Focus!"; on each break it unblocks them and says "Break time." Pass your
own times like `pomodoro("50 minutes", "10 minutes")`. The loop keeps Sprout
running in the background — press **Ctrl+C** to stop it. (It leaves the sites
blocked, so run `workmode(no)` afterwards to clear them.)

**`morning()`** opens your morning apps (Gmail and Google Calendar), then fetches
a tidy one-line forecast and reads it to you. With no city it uses your location;
`morning("Tokyo")` forecasts that city. The weather is just a nicety — if the
network hiccups, your morning carries on without it.

**`bedtime()`** dims the screen, blocks distractions, and schedules a Windows
shutdown in about **30 minutes**. Give yourself longer with `bedtime("1 hour")`.
If it can't block sites (not running as admin) it tells you and keeps going with
the rest. Automatic shutdown is a Windows-only feature.

> Times can be a plain number of **seconds** or friendly text — `"30 seconds"`,
> `"10 minutes"`, `"2 hours"`, `"1 day"` (short forms `30s` / `10m` / `2h` / `1d`).

> The speaking, muting, and screen-dimming are all **best effort** — if your
> machine can't do one (some monitors ignore software brightness, for example),
> that step is skipped and the routine keeps going.

## Examples

### A one-word focus session

```sprout
use "automations"

workmode()       ~ blocks distractions, opens your apps, mutes, says "Focus!"

~ ...do your deep work...

workmode(no)     ~ all done — unblock the sites again
```

### Name your own morning routine

`routine` lets you bundle **your own** task behind a friendly name, then trigger
it with `run_routine`:

```sprout
use "automations"

task open_study():
    show "Books open. Let's go!"
    say("Study time. You've got this.")

routine("study", "open_study")   ~ remember this task by the name "study"

run_routine("study")             ~ ...and run it whenever you like
```

## See also

- [Libraries](../libraries.md) — how `use` works and what else is built in
- [automations](../libraries.md#automations--run-tasks-on-a-schedule-) — the schedule + app-launching toolkit this mode-pack sits beside
- [Sprout syntax](../sprout-syntax.md) — `task`, `when`, and the rest of the language
