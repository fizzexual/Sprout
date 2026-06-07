// extensions/discord-bot/music/index.ts — the Music extension for discord-bot.
//
//   use "discord-bot"
//   use "discord-bot/music"
//   bot(secret("DISCORD_TOKEN"))
//
// Then in Discord:  !play <youtube link or search>   (also /play, !skip, !stop, !queue)
//
// Audio is grabbed by yt-dlp and decoded by ffmpeg (two external programs). The
// voice connection itself uses @discordjs/voice, because Discord now REQUIRES the
// DAVE end-to-end-encryption protocol to join voice, which can't be done with
// zero dependencies. All of this is installed by  tools/install-music.ps1  — the
// core Sprout language and the discord-bot library stay dependency-free; only
// this extension needs the extra packages, and only when you actually play.

import { spawn } from "node:child_process";
import type { Interpreter } from "../../../src/interpreter.ts";
import type { DiscordApi, CommandContext, SlashContext } from "../../../libraries/discord-bot/index.ts";

export interface Track { title: string; url: string; requestedBy: string; textChannelId: string; voiceChannelId: string; guildId: string; }

interface GuildMusic {
  connection: any | null;   // @discordjs/voice VoiceConnection
  player: any | null;       // @discordjs/voice AudioPlayer
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

// Lazy-load @discordjs/voice so the extension still loads (and !ping etc. work)
// even before the music packages are installed. Returns null if they're missing.
let voiceMod: any = null;
let voiceMissing = false;
async function loadVoice(): Promise<any> {
  if (voiceMod) return voiceMod;
  if (voiceMissing) return null;
  try {
    voiceMod = await import("@discordjs/voice");
    return voiceMod;
  } catch {
    voiceMissing = true;
    return null;
  }
}

// --- the extension -----------------------------------------------------------

export function create(_interp: Interpreter, library: { api: DiscordApi }) {
  const api = library.api;
  const guilds = new Map<string, GuildMusic>();

  const musicOf = (guildId: string): GuildMusic => {
    let gm = guilds.get(guildId);
    if (!gm) { gm = { connection: null, player: null, queue: [], current: null, procs: null }; guilds.set(guildId, gm); }
    return gm;
  };

  async function play(guildId: string, authorId: string, query: string, textChannelId: string, reply: (t: string) => void): Promise<void> {
    mlog(`play requested: "${query}" (guild ${guildId}, author ${authorId})`);
    if (!query) { reply("Tell me what to play:  `!play <youtube link or words>`"); return; }
    const voiceChannel = api.voiceChannelOf(guildId, authorId);
    mlog(voiceChannel ? `author is in voice channel ${voiceChannel}` : "author is NOT in a voice channel");
    if (!voiceChannel) { reply("Join a voice channel first, then ask me to play. 🎧"); return; }

    const V = await loadVoice();
    if (!V) {
      mlog("@discordjs/voice not installed");
      reply("🎵 Music isn't set up yet. Run **tools/install-music.ps1** (it installs the audio packages), then restart me.");
      return;
    }

    reply("🔎 Looking that up…");
    const found = await resolve(query);
    mlog(found ? `resolved: ${found.title}` : "resolve returned nothing (yt-dlp missing or failed)");
    if (!found) { reply("I couldn't find that (is **yt-dlp** installed?). Try a direct YouTube link."); return; }

    const gm = musicOf(guildId);
    gm.queue.push({ ...found, requestedBy: authorId, textChannelId, voiceChannelId: voiceChannel, guildId });

    if (gm.current) { reply(`➕ Added to the queue: **${found.title}**`); return; }

    if (!gm.connection) ensureConnection(gm, guildId, voiceChannel, V);
    playNext(guildId, V);
  }

  // Join the voice channel via @discordjs/voice (which handles UDP, encryption,
  // and the DAVE protocol), driven by our gateway through the library's adapter.
  function ensureConnection(gm: GuildMusic, guildId: string, voiceChannelId: string, V: any): void {
    gm.connection = V.joinVoiceChannel({
      channelId: voiceChannelId,
      guildId,
      adapterCreator: api.voiceAdapterCreator(guildId),
      selfDeaf: true,
      selfMute: false,
    });
    gm.player = V.createAudioPlayer({ behaviors: { noSubscriber: V.NoSubscriberBehavior.Play } });
    gm.connection.subscribe(gm.player);
    gm.connection.on("stateChange", (o: any, n: any) => mlog(`voice connection: ${o.status} -> ${n.status}`));
    gm.player.on("stateChange", (o: any, n: any) => mlog(`player: ${o.status} -> ${n.status}`));
    gm.connection.on("error", (e: Error) => console.error("🎵 voice connection error:", e?.message || e));
    gm.player.on("error", (e: Error) => {
      console.error("🎵 player error:", e?.message || e);
      playNext(guildId, V); // skip the broken track
    });
    // A track finishing puts the player back to Idle — advance the queue.
    gm.player.on(V.AudioPlayerStatus.Idle, () => playNext(guildId, V));
  }

  function playNext(guildId: string, V: any): void {
    const gm = guilds.get(guildId);
    if (!gm) return;
    if (gm.procs) { gm.procs.kill(); gm.procs = null; }
    gm.current = null;
    const track = gm.queue.shift();
    if (!track) { mlog("queue empty — leaving voice"); leave(guildId); return; }
    gm.current = track;
    mlog(`starting track: ${track.title}`);

    const piped = streamFor(track.url, (msg) => {
      api.send(track.textChannelId, msg);
      playNext(guildId, V); // skip a broken track
    });
    if (!piped) {
      api.send(track.textChannelId, "I need **ffmpeg** and **yt-dlp** installed to play audio.");
      leave(guildId);
      return;
    }
    gm.procs = piped;
    const resource = V.createAudioResource(piped.stream, { inputType: V.StreamType.OggOpus });
    gm.player.play(resource);
    api.send(track.textChannelId, `🎵 Now playing: **${track.title}**`);
  }

  function skip(guildId: string, reply: (t: string) => void): void {
    const gm = guilds.get(guildId);
    if (!gm || !gm.current) { reply("Nothing is playing."); return; }
    reply("⏭️ Skipping…");
    if (gm.procs) { gm.procs.kill(); gm.procs = null; }
    try { gm.player?.stop(true); } catch { /* player gone */ } // -> Idle -> playNext
  }

  function stop(guildId: string, reply: (t: string) => void): void {
    const gm = guilds.get(guildId);
    if (!gm) { reply("Nothing is playing."); return; }
    gm.queue = [];
    reply("⏹️ Stopped. Bye! 👋");
    leave(guildId);
  }

  function leave(guildId: string): void {
    const gm = guilds.get(guildId);
    if (!gm) return;
    if (gm.procs) { gm.procs.kill(); gm.procs = null; }
    try { gm.player?.stop(true); } catch { /* gone */ }
    try { gm.connection?.destroy(); } catch { /* gone */ }
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

// Always-on trace (only prints while a !play/​/play is being handled).
function mlog(msg: string): void { console.log(`🎵 [music] ${msg}`); }

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

// Spawn yt-dlp piped into ffmpeg, producing an Ogg/Opus stream for @discordjs/voice.
// Returns the stream + a kill() that stops both processes.
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
