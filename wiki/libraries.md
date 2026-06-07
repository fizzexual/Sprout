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
| `reply("text")` | reply in the same channel |
| `say("channelId", "text")` | send to a specific channel |

Full setup is in the [library's README](../libraries/discord-bot/README.md)
(make a bot, copy its token, turn on the Message Content Intent, invite it).

## Adding your own

Libraries live in the [`libraries/`](../libraries) folder — each is a folder
with an `index.ts` that exports a `create(interp)` function. See
[`libraries/README.md`](../libraries/README.md) for the (tiny) contract.
