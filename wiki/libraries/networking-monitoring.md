# networking: uptime monitoring

Want to know the moment a website goes down — or when your own internet drops?
The **`networking/monitoring`** library watches sites for you and runs your tasks
on the way down and the way back up. It also gives you a handful of instant
one-shot checks: is a site down right now? how's the ping? is it healthy? Add it
with `use` at the top of your program:

```sprout
use "networking"
```

After that, all of its functions work just like the built-in ones.

There are two kinds of functions here:

- **Watchers** that keep running — `monitor`, `watchinternet`, and `logstatus`.
  They register a background job; when your program finishes, the library turns
  the jobs on (each on its own timer) and keeps Sprout alive, just like a bot's
  listen loop. Press **Ctrl+C** to stop.
- **Instant checks** that answer right away — `isdown`, `avgping`, `healthcheck`,
  and `uptime`. Call them any time and they hand back an answer immediately.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `monitor("url", "downTask", "upTask")` | watch a website; every ~30s probe it. When it goes **up → down** run `downTask`; when it comes **down → up** run `upTask`. *Keeps the program running.* | `monitor("https://example.com", "site_down", "site_up")` |
| `watchinternet("downTask", "upTask")` | watch **your** internet (checks google.com every ~10s). Runs `downTask` when the connection drops, `upTask` when it returns. *Keeps the program running.* | `watchinternet("offline", "online")` |
| `isdown("host")` | is a site down right now? → `yes` / `no`. Probes it itself, and if that fails double-checks with isitup.org before crying wolf. | `isdown("example.com")` |
| `avgping("host")` / `avgping("host", n)` | average round-trip ping in milliseconds (default 4 pings, or `n` of them). Gives back `nothing` if no replies come back. | `avgping("google.com", 6)` |
| `healthcheck("url")` | a quick health report as a list `[ok?, status, ms]` — `ok` is `yes`/`no`, `status` is the HTTP code, `ms` is how long the request took. | `healthcheck("https://example.com")` |
| `logstatus("url", "file")` | every ~60s append one line — `14:30 UP 84ms` or `14:31 DOWN 0ms` — to a file next to your program. *Keeps the program running.* | `logstatus("https://example.com", "uptime.log")` |
| `uptime("url")` / `uptime("url", "count")` | how well a **monitored** URL has held up: percent up by default (e.g. `99.8`), or the number of checks so far with `"count"`. Gives back `nothing` if that URL isn't being monitored. | `uptime("https://example.com")` |

A few friendly notes:

- You can pass a full URL (`"https://example.com"`) or a bare host
  (`"example.com"`) — the library adds `https://` for you when it needs to.
- `healthcheck` gives back a [list](../sprout-syntax.md), so you can read its
  parts: `make report = healthcheck("https://example.com")` then `show report`
  prints something like `[yes, 200, 84]`.
- For `uptime` to have anything to report, a `monitor` (or `watchinternet`) for
  that URL must be running. If you used `watchinternet`, you can also ask
  `uptime("internet")` as a friendly shortcut.

## Caveats

- **Counts need a running monitor.** `uptime` only knows about URLs you've passed
  to `monitor` or `watchinternet`, and the numbers grow as the timer keeps
  checking — a fresh program starts at 0 checks.
- **Best-effort network work.** Checks run as tiny background probes with short
  timeouts, so a slow or flaky connection can occasionally read as "down". That's
  why `isdown` cross-checks with isitup.org before answering `yes`.
- `avgping` reads your system's `ping` command, so the exact ping values depend on
  your machine and network.

## Examples

### Watch a website and shout when it changes

```sprout
use "networking"

task site_down():
    show "⚠️  The site just went DOWN!"

task site_up():
    show "✅ The site is back UP!"

monitor("https://example.com", "site_down", "site_up")
```

When you run this, Sprout does one baseline check, then keeps watching every ~30
seconds. The first time the site stops replying it runs `site_down`; when it
comes back it runs `site_up`. Press **Ctrl+C** to stop watching.

### A quick health dashboard (instant checks)

```sprout
use "networking"

make report = healthcheck("https://example.com")
show "ok?", report[1]        ~ yes / no
show "status", report[2]     ~ e.g. 200
show "took", report[3], "ms" ~ e.g. 84

show "down right now?", isdown("example.com")
show "average ping:", avgping("google.com"), "ms"
```

This program answers right away and then finishes — no watchers are running, so
Sprout doesn't stay alive.

### Keep a log and check on your own internet

```sprout
use "networking"

task offline():
    show "🔌 Internet dropped!"

task online():
    show "🌐 Back online — uptime:", uptime("internet"), "%"

watchinternet("offline", "online")
logstatus("https://example.com", "uptime.log")
```

Here two background jobs register: one watches your connection (every ~10s) and
one appends a status line to `uptime.log` next to your program (every ~60s). Both
keep running until you press **Ctrl+C**.

## See also

- [networking — talk to the network](../libraries.md#networking--talk-to-the-network-) — `ping`, `status`, `download`, and friends
- [automations — run tasks on a schedule](../libraries.md#automations--run-tasks-on-a-schedule-) — `every`, `after`, `at`
- [Libraries](../libraries.md) — how `use` and library functions work
