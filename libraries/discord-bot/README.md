# discord-bot

Make a **Discord bot** in Sprout — no libraries to install, it uses Node's
built-in WebSocket to talk to Discord.

## Setup

1. Go to <https://discord.com/developers/applications> → **New Application** → **Bot**.
2. Copy the bot's **Token**. Under **Bot**, turn ON **Message Content Intent**
   (without it Discord disconnects the bot with code `4014`).
3. Invite it to your server: **OAuth2 → URL Generator** → scope **`bot`** →
   pick **Send Messages** → open the generated link.
4. Put your token in a **`.env`** file next to your program (never in the code):

   ```
   DISCORD_TOKEN = your-real-token
   ```

   `.env` is git-ignored, so your token never reaches GitHub. Read it with
   [`secret(...)`](../../wiki/builtins.md#secrets-secret).

## Example

```sprout
use "discord-bot"

bot(secret("DISCORD_TOKEN"))
on_message("handle")

task handle():
    when message() == "!ping":
        reply("pong!")
    orwhen message() == "!hello":
        reply("Hi, " + author() + "!")
```

Run it: `sprout run yourbot.sprout`. It stays running and listens for messages
until you press **Ctrl+C**.

## What it gives you

| Function | What it does |
| --- | --- |
| `bot("token")` | log in with your bot token |
| `on_message("taskName")` | run that task whenever a message arrives |
| `message()` | the text of the message that just arrived |
| `author()` | the username of who sent it |
| `reply("text")` | reply in the same channel |
| `say("channelId", "text")` | send a message to a specific channel |

The bot ignores its own messages and other bots, so it won't talk to itself.

## Extensions & slash commands

This library powers **extensions** that add whole features. The first is
**[music](../../extensions/discord-bot/music)** — `use "discord-bot/music"` and
your bot can `!play` (and `/play`) YouTube audio in a voice channel. Extensions
register their own `!commands` and `/slash` commands; see
[`extensions/README.md`](../../extensions/README.md) to write your own.
