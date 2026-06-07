# Libraries

Sprout gains extra powers from **libraries**. Add one with `use` at the top of
your program:

```sprout
use "discord-bot"
```

After that, the library's functions work just like the built-in ones.

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

It needs **yt-dlp** and **ffmpeg** installed (free, one-time) to fetch and decode
audio. Full details: [extensions/discord-bot/music](../extensions/discord-bot/music).
Example: [`examples/music-bot.sprout`](../examples/music-bot.sprout).

## Adding your own

Libraries live in [`libraries/`](../libraries) (`create(interp)`); extensions
live in [`extensions/<library>/<name>/`](../extensions) (`create(interp, library)`
— they hook into the library's `api`). See
[`libraries/README.md`](../libraries/README.md) and
[`extensions/README.md`](../extensions/README.md) for the (tiny) contracts.
