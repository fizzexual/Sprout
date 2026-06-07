# discord-bot / music

Play **YouTube audio in a Discord voice channel** from a Sprout bot.

```sprout
use "discord-bot"
use "discord-bot/music"

bot(secret("DISCORD_TOKEN"))
```

Then join a voice channel and type, in any text channel:

| Command | Slash | What it does |
| --- | --- | --- |
| `!play <link or words>` | `/play song:<...>` | join your voice channel and play it (or queue it) |
| `!skip` | `/skip` | skip to the next song |
| `!stop` | `/stop` | stop and leave the channel |
| `!queue` | — | show what's playing and what's next |

## What you need installed

Discord requires audio as encrypted **Opus**, and YouTube audio has to be
fetched and decoded — no language does that in-process. Like every music bot,
this shells out to two free command-line tools (install once, put them on your
PATH):

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — grabs the audio from YouTube
- **[ffmpeg](https://ffmpeg.org)** — converts it to Opus

Sprout itself stays dependency-free — it just runs these the same way it runs
PowerShell for GUIs or Node for `get`/`post`. If they're missing, the bot tells
you in chat instead of crashing.

## Setup recap

1. Make a `.env` next to your program with `DISCORD_TOKEN = your-token`.
2. In the [Discord developer portal](https://discord.com/developers/applications),
   under **Bot**, turn ON **Message Content Intent** (and the **Server Members**/
   **Voice** related intents are covered automatically).
3. Invite the bot with the **`bot`** scope and **Connect** + **Speak** voice
   permissions.
4. `sprout run examples/music-bot.sprout`, join a voice channel, and `!play`.

## How it works (under the hood)

- The library tracks who's in which voice channel (via `GUILD_VOICE_STATES`).
- `!play` finds your voice channel, joins it (Discord voice gateway → UDP), and
  streams `yt-dlp | ffmpeg` output as encrypted Opus frames every 20ms.
- A per-server **queue** drives `!skip` / `!stop` and auto-advances when a song
  ends. See [`voice.ts`](../../../libraries/discord-bot/voice.ts) for the
  transport (RTP + AES-256-GCM / XChaCha20-Poly1305 + Ogg/Opus demuxing).
