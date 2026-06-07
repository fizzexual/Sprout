# Libraries

Sprout gains extra powers from **libraries**. Add one with `use` at the top of
your program:

```sprout
use "discord-bot"
```

After that, the library's functions work just like the built-in ones.

## Managing modules: `sprout modules`

Run **`sprout modules`** for an interactive manager (a little terminal UI) where
you can see what's installed, **set up** a library's extras (e.g. install the
packages the Music extension needs), **uninstall** one, and **test** that each
one loads:

```
🌱  Sprout Modules   manage your libraries
  ● discord-bot        Make a Discord bot — chat + slash commands
      ✓ discord-bot/music   ready
  1 install / set up   2 uninstall   3 test   4 quit
  ❯
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
| `slash("name", "description", "taskName")` | add a `/slash` command that runs a task |

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

The first extension is **discord-bot/music** — a real music player. Once it's
loaded, your bot understands new commands in Discord with no extra Sprout code:

| Command | What it does |
| --- | --- |
| `!play <link or words>` | join your voice channel and play YouTube audio (`/play` works too) |
| `!skip` / `!stop` / `!queue` | skip a song, stop & leave, or see what's queued |

Music is the one part of Sprout that needs extra software — `yt-dlp` + `ffmpeg`
to fetch/decode audio, and (because Discord now mandates the **DAVE** end-to-end
encryption protocol for voice) the `@discordjs/voice` packages. One command sets
it all up:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-music.ps1
```

The core language and the discord-bot library stay dependency-free; only the
music extension uses these, and only when you `!play`. Full details:
[extensions/discord-bot/music](../extensions/discord-bot/music).

## Adding your own

Libraries live in [`libraries/`](../libraries) (`create(interp)`); extensions
live in [`extensions/<library>/<name>/`](../extensions) (`create(interp, library)`
— they hook into the library's `api`). See
[`libraries/README.md`](../libraries/README.md) and
[`extensions/README.md`](../extensions/README.md) for the (tiny) contracts.
