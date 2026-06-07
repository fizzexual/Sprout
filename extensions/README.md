# Sprout extensions

An **extension** adds features to a **library**. Where a library is loaded with
`use "name"`, an extension is loaded with `use "library/extension"`:

```sprout
use "discord-bot"
use "discord-bot/music"     ~ the Music extension, built on discord-bot
```

The extension hooks into the library that's already running — it doesn't add new
Sprout words, it teaches the library new tricks (here: `!play`, `/play`, a song
queue, and voice playback).

| Extension | Library | What it adds |
| --- | --- | --- |
| [discord-bot/music](discord-bot/music) | discord-bot | play YouTube audio in voice (`!play`, `!skip`, `!stop`, `!queue`, `/play`) |

## How an extension works

Each extension is a folder `extensions/<library>/<extension>/` with an `index.ts`
that exports `create(interp, library)`. The `library` argument is the live
library instance, and it carries an **`api`** the extension hooks into:

```ts
export function create(interp, library) {
  const api = library.api;

  api.onCommand("hello", (ctx) => ctx.reply("Hi, " + ctx.author + "!"));   // !hello
  api.onSlash("hello", "Say hi", (ctx) => ctx.reply("Hi!"));               // /hello

  return { names: [], builtins: {} };   // an extension can add Sprout words too, if it wants
}
```

When a program says `use "discord-bot/music"`, the Sprout CLI loads the
`discord-bot` library first, then loads the extension and hands it that library.
The library exposes (see [`libraries/discord-bot`](../libraries/discord-bot)):

| `api` method | What it does |
| --- | --- |
| `onCommand(word, handler)` | run `handler(ctx)` when someone types `!word` |
| `onSlash(name, description, handler)` | register & handle a `/name` slash command |
| `send(channelId, text)` | send a message to a channel |
| `voiceChannelOf(guildId, userId)` | which voice channel a user is in (or null) |
| `joinVoice(guildId, channelId)` | join a voice channel, returns a voice player |

That's the whole contract — drop in a new folder to add your own.
