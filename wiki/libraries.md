# Libraries

Sprout gains extra powers from **libraries**. Add one with `use` at the top of
your program:

```sprout
use "discord-bot"
```

After that, the library's functions work just like the built-in ones.

> `use` with a name (`use "discord-bot"`) adds a built-in library. `use` with a
> path ending in `.sprout` (`use "scoring.sprout"`) pulls in **your own file** —
> see [Projects](projects.md) for connecting files together.

## Managing modules: `sprout modules`

Run **`sprout modules`** for an interactive manager (a full-screen terminal UI).
Type commands in the box: **`browse`** the catalogue, **`libinstall`** a library,
**`install`** an extension's tools, **`setup`** to see extra steps, **`uninstall`**,
or **`test`** that everything loads.

## Available libraries

| Library | What it does |
| --- | --- |
| **discord-bot** | make a real Discord bot — chat + `/slash` commands + a music player |
| **networking** | the internet & your network — speed, blocking, devices, sharing, uptime |
| **automations** | automate your PC — schedules, system control, macros, triggers, routines |

### discord-bot — make a Discord bot 🤖

```sprout
use "discord-bot"

bot(secret("DISCORD_TOKEN"))     ~ token lives in .env, never in your code
on_message("handle")

task handle():
    when message() == "!ping":
        reply("pong!")
    orwhen message() == "!hello":
        reply("Hi, " + author() + "!")
```

Your token goes in a git-ignored `.env` file next to the program
(`DISCORD_TOKEN = ...`) and [`secret(...)`](builtins.md#secrets) reads it
— so it never reaches GitHub.

| Function | What it does |
| --- | --- |
| `bot("token")` | log in with your bot token |
| `on_message("taskName")` | run that task whenever a message arrives |
| `message()` | the text that just arrived |
| `author()` | who sent it |
| `reply("text")` | reply in the same channel (or answer a slash command) |
| `say("channelId", "text")` | send to a specific channel |
| `slash("name", "description", handler)` | add a `/slash` command — `handler` is a task name, or an extension action like `"discord-bot/music/play"` |

`reply` is smart: inside a slash task it answers the slash command, otherwise it
posts in the channel. Full setup is in the
[library's README](../libraries/discord-bot/README.md) (make a bot, copy its
token, turn on the Message Content Intent, invite it).

### networking — the internet & your network 🌐

`use "networking"` adds friendly network tools. It's split into topic pages so
each part is easy to find:

| Page | What's inside |
| --- | --- |
| **[Info & diagnostics](libraries/networking-info.md)** | `hostname` · `localip` · `myip` · `online` · `status` · `ping` · `download` · `speedtest` · `whereis` · `wifi` · `isopen` · `hops` · `whois` |
| **[Blocking websites](libraries/networking-blocking.md)** | `block` · `unblock` · `blocked` · `unblock_all` · `block_category` · `block_until` |
| **[Your local network](libraries/networking-devices.md)** | `devices` · `router` · `devicename` · `find` · `isup` · `wake` |
| **[Uptime monitoring](libraries/networking-monitoring.md)** | `monitor` · `watchinternet` · `isdown` · `avgping` · `healthcheck` · `logstatus` · `uptime` |
| **[Sharing to your phone](libraries/networking-sharing.md)** | `share` · `serve` · `sharetext` · `sendphone` · `qr` |

```sprout
use "networking"
show "This computer:", hostname(), "  IP:", localip()
when online():
    show "ping google:", ping("google.com"), "ms"
```

### automations — automate your PC ⏰

`use "automations"` runs tasks on a schedule, controls the PC, reacts to events,
and can run your project on startup. Its topic pages:

| Page | What's inside |
| --- | --- |
| **[Scheduling & clock](libraries/automations-scheduling.md)** | `every` · `after` · `at` · `watch` · `wait` · `now` · `today` · `weekday` · `countdown` · `alarm` · `snooze` · `on_days` · `sunrise`/`sunset` |
| **[Run on PC startup](libraries/automations-startup.md)** | `run_on_startup` · `runs_on_startup` · `start_with_pc` · `stop_with_pc` · `starts_with_pc` |
| **[Launch & control apps](libraries/automations-apps.md)** | `launch` · `running` · `closeapp` |
| **[System control](libraries/automations-system.md)** | `volume` · `mute` · `shutdown` · `restart` · `sleep` · `lock` · `darkmode` · `wallpaper` · `clipboard` · `brightness` · `keepawake` · `say` |
| **[Keyboard / mouse / screenshot](libraries/automations-macros.md)** | `type` · `press` · `screenshot` · `copy_text` · `movemouse` · `click` · `mousepos` · `typeto` |
| **[Event triggers](libraries/automations-triggers.md)** | `when_idle` · `on_usb` · `on_open` · `on_wifi` · `on_low_battery` · `on_hotkey` |
| **[One-word routines](libraries/automations-routines.md)** | `workmode` · `pomodoro` · `morning` · `bedtime` · `routine` |

```sprout
use "automations"
task tick():
    show "tick at", now("12h")
every("2 seconds", "tick")
```

> Most of the system, macro, trigger, and routine features are **Windows-focused**.

## Extensions — libraries for libraries

An **extension** plugs extra powers into a library. Load one with a
`library/extension` path:

```sprout
use "discord-bot"
use "discord-bot/music"     ~ a music player, built on the discord-bot library
```

### discord-bot/music — a real music player 🎵

Once it's loaded, your bot understands these in Discord — no extra Sprout code:

| Command | What it does |
| --- | --- |
| `!play <link / words>` | join your voice channel and play a song, a **playlist**, or search words |
| `/play song:<…>` | the same, as a slash command |
| `!skip` · `!stop` · `!queue` | skip, stop & leave, or list the queue |

Every **now-playing** message carries **buttons** — ⏯️ pause/resume, ⏭️ skip,
⏹️ stop, 🔉/🔊 volume, 🐢/⏩ speed — so listeners control it without typing.

**You own the look.** A `music/` folder appears next to your program with
`now-playing.bloom` — edit the colour, title, footer, or show/hide the
thumbnail and it applies on the next song. Fetch + scale options live in
`music/settings.bloom`.

**Wire your own commands.** Point a slash command straight at the extension's
function instead of using the built-in:

```sprout
slash("play", "play some music", "discord-bot/music/play")
```

**Setup.** Music needs `yt-dlp` + `ffmpeg` and the voice packages (Discord now
mandates the **DAVE** end-to-end-encryption protocol for voice). One command —
or just run `sprout modules` and type `install music`:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-music.ps1
```

**Scale to many servers.** One bot fetches YouTube from a single IP, which gets
rate-limited at scale. Point it at a **Lavalink** server (set `lavalink host:` in
`music/settings.bloom`) and it offloads *all* audio — extraction, voice, DAVE — to
the node; add more nodes (each its own IP) to grow. The core language and the
discord-bot library stay dependency-free; only music uses extras, only when you play.
Full details: [extensions/discord-bot/music](../extensions/discord-bot/music).

## Coming soon 🔜

Run `sprout modules` → `browse` to see where Sprout is headed. These are
**placeholders** today, and they're deliberately the **genuinely hard** things —
the kind where Sprout's whole value is "we did the painful part for you" (like
music's voice + DAVE + yt-dlp + Lavalink saga).

| Library | Extensions (planned) | Why it's hard |
| --- | --- | --- |
| **discord-bot** ✅ | `music` ✅ · `tts` · `transcribe` · `voice-ai` · `soundboard` | voice + DAVE E2EE + audio/AI pipelines |
| **whatsapp-bot** 🔜 | `media` | the unofficial multi-device protocol |
| **browser** 🔜 | `scrape` · `screenshot` | driving a real headless browser |

## Adding your own

Libraries live in [`libraries/`](../libraries) (`create(interp)`); extensions
live in [`extensions/<library>/<name>/`](../extensions) (`create(interp, library)`
— they hook into the library's `api`). See
[`libraries/README.md`](../libraries/README.md) and
[`extensions/README.md`](../extensions/README.md) for the (tiny) contracts.
