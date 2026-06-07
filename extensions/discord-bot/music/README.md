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

## What you need installed — run the installer

Music is the one part of Sprout that needs extra software. There are two reasons:

1. **Audio tools** — YouTube audio has to be fetched (`yt-dlp`) and decoded
   (`ffmpeg`). Every music bot uses these.
2. **DAVE end-to-end encryption** — since **March 1, 2026**, Discord *requires*
   the [DAVE protocol](https://daveprotocol.com/) to join any voice channel.
   It's a heavyweight crypto protocol (MLS + AES‑128‑GCM); even discord.js uses a
   native package for it. So this extension uses **`@discordjs/voice`** (which
   pulls in **`@snazzah/davey`** for DAVE) for the actual voice connection.

One command installs all of it:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-music.ps1
```

That installs the npm packages (`@discordjs/voice`, `@snazzah/davey`,
`libsodium-wrappers`, `prism-media`) and, via `winget`, `ffmpeg` + `yt-dlp`.
**The rest of Sprout stays dependency-free** — the core language and the
discord-bot library import none of this; only the music extension does, and only
when you actually `!play`. If the packages are missing, the bot just tells you to
run the installer instead of crashing.

## Setup recap

1. Run `tools\install-music.ps1` (above). Open a **new** terminal afterwards.
2. Make a `.env` next to your program with `DISCORD_TOKEN = your-token`.
3. In the [Discord developer portal](https://discord.com/developers/applications),
   under **Bot**, turn ON **Message Content Intent**.
4. Invite the bot with the **`bot`** scope and **Connect** + **Speak** voice
   permissions.
5. `sprout run examples/music-bot.sprout`, join a voice channel, and `!play`.

## How it works (under the hood)

- The discord-bot library tracks who's in which voice channel (via
  `GUILD_VOICE_STATES`) and exposes a tiny `voiceAdapterCreator` — a bridge that
  lets `@discordjs/voice` send/receive voice events over *our* gateway websocket.
- `!play` finds your voice channel, has `@discordjs/voice` join it (handling UDP,
  encryption, **and DAVE**), and feeds it the `yt-dlp | ffmpeg` Ogg/Opus stream.
- A per-server **queue** drives `!skip` / `!stop` and auto-advances when a song
  ends (the audio player going idle pulls the next track).

> A from-scratch, zero-dependency voice transport also lives in
> [`voice.ts`](../../../libraries/discord-bot/voice.ts) — it was correct before
> DAVE became mandatory, and is kept as a reference (its cipher and Ogg/Opus
> demuxer are still unit-tested).

## Troubleshooting

The console prints a `🎵 [music]` and voice trace while a song plays. Common issues:

1. **"Music isn't set up yet"** → run `tools\install-music.ps1`, then restart the bot.
2. **`@snazzah/davey` failed to install** → it's a native package; you may need
   Windows "Visual Studio Build Tools" (C++), then re-run the installer.
3. **Joins but silent / ffmpeg error** → make sure `ffmpeg -encoders | findstr opus`
   lists `libopus`, and that `yt-dlp --version` works in a fresh terminal. Any
   `yt-dlp`/`ffmpeg` non-zero exit is printed to the console.
