// extensions/discord-bot/music/index.ts — the Music extension for discord-bot.
//
//   use "discord-bot"
//   use "discord-bot/music"
//   bot(secret("DISCORD_TOKEN"))
//
// Then in Discord:  !play <youtube link or search>   (also /play, !skip, !stop, !queue)
//
// Audio is produced by two external programs you install once — yt-dlp (grabs
// the audio) and ffmpeg (turns it into Opus). That's the same "shell out to a
// system tool" approach Sprout already uses for GUIs and the internet, so the
// library itself stays dependency-free.

import { spawn } from "node:child_process";
import type { Interpreter } from "../../../src/interpreter.ts";
import type { DiscordApi, CommandContext, SlashContext } from "../../../libraries/discord-bot/index.ts";
import type { VoicePlayer } from "../../../libraries/discord-bot/voice.ts";

export interface Track { title: string; url: string; requestedBy: string; textChannelId: string; }

interface GuildMusic {
  player: VoicePlayer | null;
  queue: Track[];
  current: Track | null;
  procs: { kill(): void } | null;
}

// --- pure helpers (unit-tested) ----------------------------------------------

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function formatQueue(current: Track | null, queue: Track[]): string {
  if (!current && queue.length === 0) return "The queue is empty. Add a song with `!play <link>`.";
  const lines: string[] = [];
  if (current) lines.push(`🎶 **Now playing:** ${current.title}`);
  queue.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
  return lines.join("\n");
}

// --- the extension -----------------------------------------------------------

export function create(_interp: Interpreter, library: { api: DiscordApi }) {
  const api = library.api;
  const guilds = new Map<string, GuildMusic>();

  const musicOf = (guildId: string): GuildMusic => {
    let gm = guilds.get(guildId);
    if (!gm) { gm = { player: null, queue: [], current: null, procs: null }; guilds.set(guildId, gm); }
    return gm;
  };

  async function play(guildId: string, authorId: string, query: string, textChannelId: string, reply: (t: string) => void): Promise<void> {
    if (!query) { reply("Tell me what to play:  `!play <youtube link or words>`"); return; }
    const voiceChannel = api.voiceChannelOf(guildId, authorId);
    if (!voiceChannel) { reply("Join a voice channel first, then ask me to play. 🎧"); return; }

    reply("🔎 Looking that up…");
    const found = await resolve(query);
    if (!found) { reply("I couldn't find that (is **yt-dlp** installed?). Try a direct YouTube link."); return; }

    const gm = musicOf(guildId);
    gm.queue.push({ ...found, requestedBy: authorId, textChannelId });

    if (gm.current) { reply(`➕ Added to the queue: **${found.title}**`); return; }

    if (!gm.player) {
      try { gm.player = await api.joinVoice(guildId, voiceChannel); }
      catch { reply("I couldn't join your voice channel."); gm.queue = []; return; }
      gm.player.onFinish(() => playNext(guildId));
    }
    playNext(guildId);
  }

  function playNext(guildId: string): void {
    const gm = guilds.get(guildId);
    if (!gm) return;
    gm.procs = null;
    gm.current = null;
    const track = gm.queue.shift();
    if (!track) { leave(guildId); return; }
    gm.current = track;

    const piped = streamFor(track.url, (msg) => {
      api.send(track.textChannelId, msg);
      playNext(guildId); // skip a broken track
    });
    if (!piped) {
      api.send(track.textChannelId, "I need **ffmpeg** and **yt-dlp** installed to play audio.");
      leave(guildId);
      return;
    }
    gm.procs = piped;
    gm.player!.playOgg(piped.stream);
    api.send(track.textChannelId, `🎵 Now playing: **${track.title}**`);
  }

  function skip(guildId: string, reply: (t: string) => void): void {
    const gm = guilds.get(guildId);
    if (!gm || !gm.current) { reply("Nothing is playing."); return; }
    reply("⏭️ Skipping…");
    if (gm.procs) gm.procs.kill();   // stream ends -> onFinish -> playNext
    else playNext(guildId);
  }

  function stop(guildId: string, reply: (t: string) => void): void {
    const gm = guilds.get(guildId);
    if (!gm) { reply("Nothing is playing."); return; }
    gm.queue = [];
    reply("⏹️ Stopped. Bye! 👋");
    if (gm.procs) gm.procs.kill();
    else leave(guildId);
  }

  function leave(guildId: string): void {
    const gm = guilds.get(guildId);
    if (!gm) return;
    if (gm.procs) gm.procs.kill();
    gm.player?.destroy();
    guilds.delete(guildId);
  }

  // --- wire up Discord commands (prefix + slash) ---
  api.onCommand("play", (ctx: CommandContext) => void play(ctx.guildId, ctx.authorId, ctx.args, ctx.channelId, ctx.reply));
  api.onCommand("skip", (ctx: CommandContext) => skip(ctx.guildId, ctx.reply));
  api.onCommand("stop", (ctx: CommandContext) => stop(ctx.guildId, ctx.reply));
  api.onCommand("queue", (ctx: CommandContext) => {
    const gm = guilds.get(ctx.guildId);
    ctx.reply(formatQueue(gm?.current ?? null, gm?.queue ?? []));
  });

  api.onSlash("play", "Play a YouTube link or search in your voice channel", (ctx: SlashContext) =>
    void play(ctx.guildId, ctx.authorId, ctx.option("song"), ctx.channelId, ctx.reply),
    [{ name: "song", description: "A YouTube link or search words", type: 3, required: true }]);
  api.onSlash("skip", "Skip the current song", (ctx: SlashContext) => skip(ctx.guildId, ctx.reply));
  api.onSlash("stop", "Stop the music and leave", (ctx: SlashContext) => stop(ctx.guildId, ctx.reply));

  return { names: [], builtins: {} };
}

// --- audio plumbing (yt-dlp + ffmpeg) ----------------------------------------

// Resolve a link or search words into a { title, url } using yt-dlp.
function resolve(query: string): Promise<{ title: string; url: string } | null> {
  const target = isUrl(query) ? query : `ytsearch1:${query}`;
  return new Promise((res) => {
    let out = "";
    let started = false;
    try {
      const p = spawn("yt-dlp", ["--no-warnings", "-f", "bestaudio", "--skip-download", "--print", "%(title)s\n%(webpage_url)s", target], { stdio: ["ignore", "pipe", "ignore"] });
      started = true;
      p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      p.on("error", () => res(null));
      p.on("close", () => {
        const lines = out.trim().split("\n").filter(Boolean);
        if (lines.length >= 2) res({ title: lines[0], url: lines[lines.length - 1] });
        else res(null);
      });
    } catch {
      if (!started) res(null);
    }
  });
}

const MUSIC_DEBUG = process.env.SPROUT_VOICE_DEBUG === "1" || process.env.SPROUT_VOICE_DEBUG === "true";
function mlog(msg: string): void { if (MUSIC_DEBUG) console.log(`🎵 [music] ${msg}`); }

// Spawn yt-dlp piped into ffmpeg, producing an Ogg/Opus stream for the voice
// connection. Returns the stream + a kill() that stops both processes.
function streamFor(url: string, onError: (msg: string) => void): { stream: NodeJS.ReadableStream; kill(): void } | null {
  try {
    // Prefer webm/opus: it streams cleanly through a pipe. (m4a/mp4 keeps its
    // index at the END of the file, so ffmpeg would have to seek — which a pipe
    // can't do — and it reads nothing. That's the classic "joins but silent".)
    const format = "bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio";
    mlog(`yt-dlp ${format} -> ffmpeg(libopus) for ${url}`);
    const ytdlp = spawn("yt-dlp", ["-q", "--no-playlist", "-f", format, "-o", "-", url], { stdio: ["ignore", "pipe", "pipe"] });
    const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-f", "opus", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    let ytErr = "";
    let ffErr = "";
    ytdlp.stderr.on("data", (d: Buffer) => { ytErr += d.toString(); });
    ffmpeg.stderr.on("data", (d: Buffer) => { ffErr += d.toString(); });
    ytdlp.on("error", () => onError("I couldn't run **yt-dlp** — is it installed and on your PATH?"));
    ffmpeg.on("error", () => onError("I couldn't run **ffmpeg** — is it installed and on your PATH?"));
    ytdlp.on("close", (code) => { if (code) console.error(`🎵 yt-dlp exited ${code}: ${ytErr.trim().slice(-400)}`); });
    ffmpeg.on("close", (code) => { if (code) console.error(`🎵 ffmpeg exited ${code}: ${ffErr.trim().slice(-400)}`); });
    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on("error", () => { /* yt-dlp ended early — fine */ });
    return {
      stream: ffmpeg.stdout,
      kill: () => { try { ytdlp.kill("SIGKILL"); } catch { /* gone */ } try { ffmpeg.kill("SIGKILL"); } catch { /* gone */ } },
    };
  } catch {
    return null;
  }
}
