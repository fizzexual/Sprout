# Libraries

Sprout gains extra powers from **libraries**. Add one with `use` at the top of
your program:

```sprout
use "discord-bot"
```

After that, the library's functions work just like the built-in ones.

## Managing modules: `sprout modules`

Run **`sprout modules`** for an interactive manager (a full-screen terminal UI).
Type commands in the box: **`browse`** the catalogue, **`libinstall`** a library,
**`install`** an extension's tools, **`setup`** to see extra steps, **`uninstall`**,
or **`test`** that everything loads:

```
                              modules · v0.4

  libraries
    ● discord-bot      Make a Discord bot — chat + slash commands
        music          Play YouTube audio in voice          ready
        moderation     Auto-mod, kick / ban / timeout       🔜 coming soon
    ◌ twitch-bot       Make a Twitch chat bot               🔜 coming soon
    ◌ ai               Talk to an AI — chat & images        🔜 coming soon

  commands  browse  libinstall <name>  install <name>  setup <name>  uninstall <name>  test  quit
  ❯ install music
```

## Available libraries

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
(`DISCORD_TOKEN = ...`) and [`secret(...)`](builtins.md#secrets-secret) reads it
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
posts in the channel. A tiny slash command looks like:

```sprout
slash("hello", "Say hello", "sayHi")

task sayHi():
    reply("Hello from a Sprout slash command! 🌱")
```

Full setup is in the [library's README](../libraries/discord-bot/README.md)
(make a bot, copy its token, turn on the Message Content Intent, invite it).

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
**placeholders** today — the planned shape of the ecosystem:

| Library | Extensions |
| --- | --- |
| **discord-bot** ✅ | `music` ✅ · `moderation` 🔜 · `welcome` 🔜 · `economy` 🔜 |
| **twitch-bot** 🔜 | `alerts` · `commands` |
| **ai** 🔜 | `chat` · `image` |
| **web** 🔜 | `scrape` |
| **games** 🔜 | `trivia` |

Each would be a great first contribution — the contracts are tiny (see below).

## Adding your own

Libraries live in [`libraries/`](../libraries) (`create(interp)`); extensions
live in [`extensions/<library>/<name>/`](../extensions) (`create(interp, library)`
— they hook into the library's `api`). See
[`libraries/README.md`](../libraries/README.md) and
[`extensions/README.md`](../extensions/README.md) for the (tiny) contracts.
