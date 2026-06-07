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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Interpreter } from "../../../src/interpreter.ts";
import type { DiscordApi, CommandContext, SlashContext, ButtonContext } from "../../../libraries/discord-bot/index.ts";
import { createLavalinkEngine, readLavalinkConfig } from "./lavalink.ts";

export interface Track { title: string; url: string; thumbnail: string; channel: string; duration: string; requestedBy: string; textChannelId: string; voiceChannelId: string; guildId: string; }

interface GuildMusic {
  connection: any | null;   // @discordjs/voice VoiceConnection
  player: any | null;       // @discordjs/voice AudioPlayer
  queue: Track[];
  current: Track | null;
  procs: { kill(): void } | null;
  volume: number;           // 1.0 = 100% (live-adjustable via the 🔉/🔊 buttons)
  resource: any | null;     // current audio resource, kept so we can change volume live
  speed: number;            // 1.0 = normal (the 🐢/⏩ buttons; persists across songs)
  posBase: number;          // source seconds already consumed before the current segment (for speed restarts)
}

// --- pure helpers (unit-tested) ----------------------------------------------

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function isPlaylist(s: string): boolean {
  return isUrl(s) && /[?&]list=/.test(s);
}

// YouTube "player clients" to try, in order. android_vr serves opus WITHOUT the
// nsig puzzle (so it doesn't crash) and needs no login; default is the fallback.
// Trying several means we rarely need a signed-in account / cookies.
const YT_CLIENTS = "android_vr,default";

export function formatQueue(current: Track | null, queue: Track[]): string {
  if (!current && queue.length === 0) return "The queue is empty. Add a song with `!play <link>`.";
  const lines: string[] = [];
  if (current) lines.push(`🎶 **Now playing:** ${current.title}`);
  queue.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
  return lines.join("\n");
}

// Build the "now playing" Discord embed from the USER'S config (the music/ folder
// next to their program). The extension provides behavior; the user owns the look.
// yt-dlp prints "NA" for fields it doesn't have — skip those.
export function nowPlayingEmbed(track: Track, cfg: Record<string, string> = {}): Record<string, unknown> {
  const on = (key: string): boolean => { const v = cfg[key]; return v === undefined ? true : /^(yes|true|on|1)$/i.test(v); };
  const ok = (s: string): boolean => !!s && s !== "NA";
  const color = parseInt((cfg.color || "#77dd77").replace(/^#/, ""), 16);
  const fields: Array<Record<string, unknown>> = [];
  if (on("channel") && ok(track.channel)) fields.push({ name: "Channel", value: track.channel, inline: true });
  if (on("duration") && ok(track.duration)) fields.push({ name: "Duration", value: track.duration, inline: true });
  if (on("requested by") && track.requestedBy) fields.push({ name: "Requested by", value: `<@${track.requestedBy}>`, inline: true });
  const embed: Record<string, unknown> = {
    color: Number.isNaN(color) ? 0x77dd77 : color,
    author: { name: cfg.title || "🎵 Now Playing" },
    title: track.title || "Unknown",
    url: ok(track.url) ? track.url : undefined,
    fields,
    footer: { text: cfg.footer || "Sprout 🌱 music" },
  };
  if (on("thumbnail") && /^https?:\/\//i.test(track.thumbnail)) embed.image = { url: track.thumbnail }; // big video preview
  return embed;
}

// The special card shown when a whole playlist is queued (distinct blurple look).
export function playlistEmbed(title: string, count: number, requestedBy: string, cfg: Record<string, string> = {}): Record<string, unknown> {
  const fields: Array<Record<string, unknown>> = [];
  if (requestedBy) fields.push({ name: "Requested by", value: `<@${requestedBy}>`, inline: true });
  return {
    color: 0x5865f2, // a distinct "playlist" blurple, separate from the now-playing card
    author: { name: "📃 Playlist added" },
    title: title && title !== "NA" ? title : "Playlist",
    description: `Queued **${count}** song${count === 1 ? "" : "s"}. 🎶`,
    fields,
    footer: { text: cfg.footer || "Sprout 🌱 music" },
  };
}

// The row of control buttons shown under the Now-Playing card. Discord button:
// type 2; style 2 = grey, 4 = red. custom_id is what the click sends back.
export function controllerComponents(): unknown[] {
  const btn = (id: string, emoji: string, style = 2): Record<string, unknown> => ({ type: 2, style, custom_id: id, emoji: { name: emoji } });
  return [
    {
      type: 1, // action row 1: transport + volume
      components: [
        btn("music:playpause", "⏯️"),
        btn("music:skip", "⏭️"),
        btn("music:stop", "⏹️", 4),
        btn("music:voldown", "🔉"),
        btn("music:volup", "🔊"),
      ],
    },
    {
      type: 1, // action row 2: speed
      components: [
        btn("music:slower", "🐢"),
        btn("music:faster", "⏩"),
      ],
    },
  ];
}

// --- the editable design folder ("music/" next to the user's program) ---------
// The idea: an extension ships the functionality, but the user controls the
// design. So `use "discord-bot/music"` drops a "music" folder beside the running
// .sprout program holding a Bloom-style config they can freely edit.

const DEFAULT_CONFIG = `~ now-playing.bloom — the "Now Playing" card your music bot shows.
~ Made for you by  use "discord-bot/music".  Edit a line and save and it applies
~ on the very next song (no restart needed). Lines starting with ~ are notes.
~ Turn a part on or off with  yes  or  no.

color: #77dd77
title: 🎵 Now Playing
thumbnail: yes
channel: yes
duration: yes
requested by: yes
footer: Sprout 🌱 music
`;

const DEFAULT_SETTINGS = `~ settings.bloom — how the music bot fetches songs from YouTube.
~
~ YouTube may say "Sign in to confirm you're not a bot". To get past it, give
~ yt-dlp your YouTube login. Pick ONE, then restart the bot:
~
~ 1) A cookies FILE (most reliable). In your browser add the extension
~    "Get cookies.txt LOCALLY", open youtube.com while logged in, export, then:
~      cookies file: C:\\Users\\you\\Downloads\\youtube.com_cookies.txt
~
~ 2) Straight from a browser — but CLOSE the browser first, and note Chrome/Edge
~    often fail (new cookie encryption); Firefox works best:
~      cookies browser: firefox     (or edge, brave, opera, vivaldi, chromium)
~
~ Leave both blank to fetch without cookies (fine until YouTube blocks you).
~
~ ─────────────────────────────────────────────────────────────────────────
~ SCALE — Lavalink. Run a Lavalink server and the bot offloads ALL audio to it
~ (extraction + voice + the YouTube fetching), so many servers don't share one
~ IP's rate limit — add more Lavalink nodes to grow. Set the host to switch the
~ music engine to Lavalink (otherwise the built-in yt-dlp+ffmpeg engine is used):
~   lavalink host: localhost
~   lavalink port: 2333
~   lavalink password: youshallnotpass
~   lavalink secure: no        (yes if the node is wss/https)

lavalink host:
lavalink port: 2333
lavalink password: youshallnotpass
lavalink secure: no
`;

// The music config folder next to the running program. Set by create(); used by
// cookiesArgs() so the yt-dlp helpers (module-level) can read the cookie setting.
let musicDir = "";

// Make sure  <programDir>/music/  has its config files (without ever clobbering the
// user's edits), and return the now-playing card's path.
function ensureMusicConfig(programDir: string): string {
  if (!programDir) return ""; // no known program dir (e.g. tests) — fall back to built-in defaults
  const folder = join(programDir, "music");
  const card = join(folder, "now-playing.bloom");
  const settings = join(folder, "settings.bloom");
  try {
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    if (!existsSync(card)) writeFileSync(card, DEFAULT_CONFIG, "utf8");
    if (!existsSync(settings)) writeFileSync(settings, DEFAULT_SETTINGS, "utf8");
  } catch { /* read-only filesystem — we just fall back to the built-in defaults */ }
  return card;
}

// yt-dlp args to authenticate with the user's YouTube cookies (from
// music/settings.bloom). This is what gets past "confirm you're not a bot".
function cookiesArgs(): string[] {
  if (!musicDir) return [];
  const cfg = readMusicConfig(join(musicDir, "settings.bloom"));
  const file = (cfg["cookies file"] || "").trim();
  if (file) return ["--cookies", file];
  const browser = (cfg["cookies browser"] || "").trim().toLowerCase();
  if (browser) return ["--cookies-from-browser", browser];
  return [];
}

// Read the Bloom-style "key: value" config (with ~ comments). Read fresh each
// time so the user sees their edits on the next song.
function readMusicConfig(file: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("~")) continue;
      const i = line.indexOf(":");
      if (i > 0) cfg[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  } catch { /* missing/unreadable — built-in defaults */ }
  return cfg;
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

export function create(interp: Interpreter, library: { api: DiscordApi }) {
  const api = library.api;
  const guilds = new Map<string, GuildMusic>();

  // Drop an editable "music/" design folder next to the user's program. They own
  // the look of the Now-Playing card; we read it fresh on every song.
  const configFile = ensureMusicConfig(interp?.programDir ?? "");
  musicDir = interp?.programDir ? join(interp.programDir, "music") : "";

  const musicOf = (guildId: string): GuildMusic => {
    let gm = guilds.get(guildId);
    if (!gm) { gm = { connection: null, player: null, queue: [], current: null, procs: null, volume: 1, resource: null, speed: 1, posBase: 0 }; guilds.set(guildId, gm); }
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

    const gm = musicOf(guildId);

    // A playlist URL → queue every song quickly (metadata is fetched lazily as each
    // one plays) and show the special playlist card.
    if (isPlaylist(query)) {
      reply("📃 Loading playlist…");
      const pl = await resolvePlaylist(query);
      if (!pl || pl.entries.length === 0) { api.send(textChannelId, "I couldn't read that playlist — try a single video link."); return; }
      mlog(`playlist "${pl.title}" — ${pl.entries.length} songs`);
      const wasIdle = !gm.current;
      for (const e of pl.entries) {
        gm.queue.push({ title: e.title, url: e.url, thumbnail: "", channel: "", duration: "", requestedBy: authorId, textChannelId, voiceChannelId: voiceChannel, guildId });
      }
      api.sendEmbed(textChannelId, playlistEmbed(pl.title, pl.entries.length, authorId, readMusicConfig(configFile)));
      if (!gm.connection) ensureConnection(gm, guildId, voiceChannel, V);
      if (wasIdle) void playNext(guildId, V);
      return;
    }

    reply("🔎 Looking that up…");
    const found = await resolve(query);
    mlog(found ? `resolved: ${found.title}` : "resolve returned nothing (yt-dlp missing or failed)");
    if (!found) {
      reply("I couldn't fetch that. If YouTube is asking to **confirm you're not a bot**, open **music/settings.bloom** and set up cookies (a `cookies file:` is most reliable), then restart me. Otherwise check the link / that **yt-dlp** is installed.");
      return;
    }

    gm.queue.push({ ...found, requestedBy: authorId, textChannelId, voiceChannelId: voiceChannel, guildId });

    if (gm.current) { reply(`➕ Added to the queue: **${found.title}**`); return; }

    if (!gm.connection) ensureConnection(gm, guildId, voiceChannel, V);
    void playNext(guildId, V);
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
      debug: true, // surfaces the DAVE end-to-end-encryption handshake (see below)
    });
    gm.player = V.createAudioPlayer({ behaviors: { noSubscriber: V.NoSubscriberBehavior.Play } });
    gm.connection.subscribe(gm.player);
    gm.connection.on("stateChange", (o: any, n: any) => {
      mlog(`voice connection: ${o.status} -> ${n.status}`);
      if (n.status === "ready") reportDave(gm.connection);
    });
    gm.player.on("stateChange", (o: any, n: any) => mlog(`player: ${o.status} -> ${n.status}`));
    // Discord now ENFORCES DAVE E2E encryption on voice. The bot must finish an MLS
    // key handshake before its audio can be decrypted by anyone. If that doesn't
    // complete (no "[DAVE] Transition executed (v0 -> v1…)", or a "[DAVE] Session
    // downgraded"), our opus goes out unencrypted and Discord drops it — the bot
    // looks like it's "playing" but the channel hears silence. These lines show it:
    gm.connection.on("debug", (m: string) => {
      const line = String(m).replace(/\s+/g, " ").trim();
      if (line.includes("[bin]")) return; // skip the noisy per-packet dumps
      if (line.includes("[DAVE]") || /encryption mode|secret_key|select protocol|sessionDescription/i.test(line))
        mlog(`🔐 ${line.slice(0, 240)}`);
    });
    gm.connection.on("error", (e: Error) => console.error("🎵 voice connection error:", e?.message || e));
    gm.player.on("error", (e: Error) => {
      console.error("🎵 player error:", e?.message || e);
      playNext(guildId, V); // skip the broken track
    });
    // A track finishing puts the player back to Idle — advance the queue.
    gm.player.on(V.AudioPlayerStatus.Idle, () => playNext(guildId, V));
  }

  // Snapshot the DAVE session so "joins but silent" is diagnosable. A protocol
  // version of 0, or a session that never becomes ready, means our audio is being
  // sent UNENCRYPTED — which Discord now drops. We check at "ready" and again a few
  // seconds later (the handshake can finish just after the UDP link comes up).
  function reportDave(connection: any): void {
    const snap = (label: string): void => {
      try {
        const net = connection?.state?.networking;
        const dave = net?.state?.dave;
        const connected = net?.state?.connectionData?.connectedClients;
        const connList = connected ? [...connected] : [];
        if (!dave) { mlog(`🔐 DAVE ${label}: no session yet (connectedClients=${connList.length})`); return; }
        const v = dave.protocolVersion;
        const ready = !!dave.session?.ready;
        // The real test isn't "is the session ready" — it's "is anyone else in the
        // encryption group". A 1-member group means only the bot can decrypt its own
        // audio, so every listener hears silence even though everything says "ready".
        const ids = dave.session?.getUserIds?.() ?? [];
        const epoch = dave.session?.epoch;
        mlog(`🔐 DAVE ${label}: v${v} ready=${ready} epoch=${epoch} groupMembers=${ids.length} [${ids.join(", ")}]  connectedClients=${connList.length} [${connList.join(", ")}]`);
        if (ready && ids.length <= 1)
          mlog(`🔐 DAVE ${label}: ⚠ only the bot is in the encryption group — listeners can't decrypt = SILENCE. Workaround: a listener leaves & rejoins the voice channel.`);
      } catch (e) { mlog(`🔐 DAVE ${label}: couldn't inspect (${e instanceof Error ? e.message : String(e)})`); }
    };
    snap("at-ready");
    setTimeout(() => snap("after-3s"), 3000);
  }

  async function playNext(guildId: string, V: any): Promise<void> {
    const gm = guilds.get(guildId);
    if (!gm) return;
    if (gm.procs) { gm.procs.kill(); gm.procs = null; }
    gm.current = null;
    const track = gm.queue.shift();
    if (!track) { mlog("queue empty — leaving voice"); leave(guildId); return; }
    gm.current = track;
    gm.posBase = 0; // fresh track starts at the beginning (speed carries over)
    mlog(`starting track: ${track.title}`);

    // Playlist songs are queued with only title+url — fetch the rest now so their
    // Now-Playing card still gets a thumbnail/channel/duration.
    if (!track.thumbnail) {
      const meta = await resolve(track.url);
      if (gm.current !== track) return; // a skip/stop happened while we were resolving
      if (meta) { track.title = meta.title || track.title; track.thumbnail = meta.thumbnail; track.channel = meta.channel; track.duration = meta.duration; }
    }

    const piped = streamFor(track.url, (msg) => {
      api.send(track.textChannelId, msg);
      void playNext(guildId, V); // skip a broken track
    }, { startSec: 0, speed: gm.speed });
    if (!piped) {
      api.send(track.textChannelId, "I need **ffmpeg** and **yt-dlp** installed to play audio.");
      leave(guildId);
      return;
    }
    gm.procs = piped;
    // Feed raw PCM and let @discordjs/voice encode the opus itself (needs an opus
    // library — opusscript). This is the path working music bots use; the older
    // Ogg-passthrough relied on demuxing ffmpeg's output, which could hand the
    // encoder subtly-broken packets — encrypted fine by DAVE, but silent to listeners.
    let resource: any;
    try {
      // inlineVolume lets the 🔉/🔊 buttons change loudness live (a VolumeTransformer).
      resource = V.createAudioResource(piped.stream, { inputType: V.StreamType.Raw, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(gm.volume);
      gm.resource = resource;
    } catch (e) {
      // Without an opus encoder, prism-media throws here (before playback) — which
      // used to look like mysterious silence. Say so out loud instead.
      const msg = e instanceof Error ? e.message : String(e);
      mlog(`createAudioResource failed: ${msg}`);
      api.send(track.textChannelId, /opus/i.test(msg)
        ? "I can't encode audio — the **opusscript** package is missing. Run `npm run install:music` (or tools/install-music.ps1) and restart me."
        : "I couldn't start audio: " + msg);
      playNext(guildId, V);
      return;
    }
    gm.player.play(resource);
    // A rich "now playing" card: the video's thumbnail (so you SEE it), title as a
    // clickable YouTube link, channel + duration. Styled by the user's editable
    // music/now-playing.bloom (read fresh so edits apply on the next song). Real
    // bots can't stream video to voice (that needs a ToS-breaking selfbot), so this
    // is the safe way to "watch" what's playing.
    api.sendEmbed(track.textChannelId, nowPlayingEmbed(track, readMusicConfig(configFile)), controllerComponents());
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

  // Live volume change (the 🔉/🔊 buttons). 1.0 = 100%, clamped to 10%–200%.
  function changeVolume(guildId: string, factor: number, channelId: string): void {
    const gm = guilds.get(guildId);
    if (!gm || !gm.current) { api.send(channelId, "Nothing is playing."); return; }
    gm.volume = Math.max(0.1, Math.min(2, Math.round(gm.volume * factor * 100) / 100));
    try { gm.resource?.volume?.setVolume(gm.volume); } catch { /* no inline volume on this resource */ }
    api.send(channelId, `🔊 Volume: **${Math.round(gm.volume * 100)}%**`);
  }

  // Restart the CURRENT song from gm.posBase at gm.speed (used by the speed buttons).
  function restartCurrent(guildId: string, V: any): void {
    const gm = guilds.get(guildId);
    if (!gm || !gm.current || !gm.player) return;
    if (gm.procs) { gm.procs.kill(); gm.procs = null; }
    const track = gm.current;
    const piped = streamFor(track.url, (msg) => { api.send(track.textChannelId, msg); }, { startSec: gm.posBase, speed: gm.speed });
    if (!piped) return;
    gm.procs = piped;
    try {
      const resource = V.createAudioResource(piped.stream, { inputType: V.StreamType.Raw, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(gm.volume);
      gm.resource = resource;
      gm.player.play(resource);
    } catch (e) { mlog(`restart failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Change speed (the 🐢/⏩ buttons): note where we are in the source, then restart
  // the song from there at the new speed. ffmpeg's atempo keeps the pitch natural.
  // It's a re-encode, so there's a brief gap — the honest cost of live speed change.
  async function changeSpeed(guildId: string, factor: number, channelId: string): Promise<void> {
    const gm = guilds.get(guildId);
    if (!gm || !gm.current || !gm.player) { api.send(channelId, "Nothing is playing."); return; }
    const V = await loadVoice();
    if (!V) return;
    const playedOut = (gm.resource?.playbackDuration ?? 0) / 1000;  // output seconds heard in this segment
    gm.posBase = gm.posBase + playedOut * gm.speed;                 // -> source seconds consumed so far
    gm.speed = Math.max(0.5, Math.min(2, Math.round(gm.speed * factor * 100) / 100));
    restartCurrent(guildId, V);
    api.send(channelId, `${factor >= 1 ? "⏩" : "🐢"} Speed: **${gm.speed}×** _(brief skip while it re-encodes)_`);
  }

  // Pause/resume for the local engine (extracted so it routes like the rest).
  function localPauseToggle(guildId: string, channelId: string): void {
    const gm = guilds.get(guildId);
    if (!gm || !gm.player) { api.send(channelId, "Nothing is playing."); return; }
    if (gm.player.state?.status === "paused") { gm.player.unpause(); api.send(channelId, "▶️ Resumed."); }
    else { gm.player.pause(); api.send(channelId, "⏸️ Paused."); }
  }

  // Pick the audio engine: Lavalink if music/settings.bloom sets a host (scales
  // across nodes, no shared IP rate-limit), else the built-in local yt-dlp+ffmpeg.
  const llConfig = musicDir ? readLavalinkConfig(readMusicConfig(join(musicDir, "settings.bloom"))) : null;
  const ll = llConfig
    ? createLavalinkEngine(api, llConfig, { nowPlayingEmbed, playlistEmbed, controllerComponents, readConfig: () => readMusicConfig(configFile), mlog })
    : null;
  if (ll) mlog("engine: Lavalink @ " + llConfig!.host + ":" + llConfig!.port + " — audio offloaded (scales across nodes)");

  // One surface the commands + buttons call; routes to whichever engine is active.
  const eng = {
    play: (g: string, a: string, q: string, c: string, r: (t: string) => void) => { if (ll) void ll.play(g, a, q, c, r); else void play(g, a, q, c, r); },
    skip: (g: string, r: (t: string) => void) => (ll ? ll.skip(g, r) : skip(g, r)),
    stop: (g: string, r: (t: string) => void) => (ll ? ll.stop(g, r) : stop(g, r)),
    pause: (g: string, c: string) => (ll ? ll.pauseToggle(g, c) : localPauseToggle(g, c)),
    vol: (g: string, f: number, c: string) => (ll ? ll.changeVolume(g, f, c) : changeVolume(g, f, c)),
    speed: (g: string, f: number, c: string) => { if (ll) ll.changeSpeed(g, f, c); else void changeSpeed(g, f, c); },
    queue: (g: string): { current: Track | null; queue: Track[] } => { if (ll) return ll.queueText(g); const gm = guilds.get(g); return { current: gm?.current ?? null, queue: gm?.queue ?? [] }; },
  };

  // --- wire up Discord commands (prefix + slash) ---
  // Handlers defined once so they can be auto-registered AND exposed as actions.
  const songOpt = [{ name: "song", description: "A YouTube link or search words", type: 3, required: true }];
  const playAction = (ctx: SlashContext) => eng.play(ctx.guildId, ctx.authorId, ctx.option("song"), ctx.channelId, ctx.reply);
  const skipAction = (ctx: SlashContext) => eng.skip(ctx.guildId, ctx.reply);
  const stopAction = (ctx: SlashContext) => eng.stop(ctx.guildId, ctx.reply);
  const queueAction = (ctx: SlashContext) => { const q = eng.queue(ctx.guildId); ctx.reply(formatQueue(q.current, q.queue)); };

  api.onCommand("play", (ctx: CommandContext) => eng.play(ctx.guildId, ctx.authorId, ctx.args, ctx.channelId, ctx.reply));
  api.onCommand("skip", (ctx: CommandContext) => eng.skip(ctx.guildId, ctx.reply));
  api.onCommand("stop", (ctx: CommandContext) => eng.stop(ctx.guildId, ctx.reply));
  api.onCommand("queue", (ctx: CommandContext) => { const q = eng.queue(ctx.guildId); ctx.reply(formatQueue(q.current, q.queue)); });

  // Auto-register the slash commands so a bot works out of the box…
  api.onSlash("play", "Play a YouTube link or search in your voice channel", playAction, songOpt);
  api.onSlash("skip", "Skip the current song", skipAction);
  api.onSlash("stop", "Stop the music and leave", stopAction);

  // …and expose them as actions, so a Sprout program can wire its OWN commands:
  //   slash("play", "play some music", "discord-bot/music/play")
  api.registerAction("discord-bot/music/play", playAction, songOpt);
  api.registerAction("discord-bot/music/skip", skipAction);
  api.registerAction("discord-bot/music/stop", stopAction);
  api.registerAction("discord-bot/music/queue", queueAction);

  // --- the controller buttons under the Now-Playing card ---
  api.onButton("music:playpause", (ctx: ButtonContext) => eng.pause(ctx.guildId, ctx.channelId));
  api.onButton("music:skip", (ctx: ButtonContext) => eng.skip(ctx.guildId, (t) => api.send(ctx.channelId, t)));
  api.onButton("music:stop", (ctx: ButtonContext) => eng.stop(ctx.guildId, (t) => api.send(ctx.channelId, t)));
  api.onButton("music:voldown", (ctx: ButtonContext) => eng.vol(ctx.guildId, 0.8, ctx.channelId));
  api.onButton("music:volup", (ctx: ButtonContext) => eng.vol(ctx.guildId, 1.25, ctx.channelId));
  api.onButton("music:slower", (ctx: ButtonContext) => eng.speed(ctx.guildId, 0.8, ctx.channelId));
  api.onButton("music:faster", (ctx: ButtonContext) => eng.speed(ctx.guildId, 1.25, ctx.channelId));

  return { names: [], builtins: {} };
}

// --- audio plumbing (yt-dlp + ffmpeg) ----------------------------------------

// Always-on trace (only prints while a !play/​/play is being handled).
function mlog(msg: string): void { console.log(`🎵 [music] ${msg}`); }

// Resolve a link or search words into track metadata (title, url, thumbnail,
// channel, duration) using yt-dlp. The single-line fields print first and the
// title last, so a title that rarely contains a newline can't shift the others.
function resolve(query: string): Promise<{ title: string; url: string; thumbnail: string; channel: string; duration: string } | null> {
  const target = isUrl(query) ? query : `ytsearch1:${query}`;
  return new Promise((res) => {
    let out = "";
    let err = "";
    let started = false;
    try {
      const p = spawn("yt-dlp", [...cookiesArgs(), "--no-warnings", "--extractor-args", "youtube:player_client=" + YT_CLIENTS,
        "-f", "bestaudio", "--skip-download",
        "--print", "%(webpage_url)s", "--print", "%(thumbnail)s", "--print", "%(channel)s",
        "--print", "%(duration_string)s", "--print", "%(title)s", target], { stdio: ["ignore", "pipe", "pipe"] });
      started = true;
      p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      p.stderr.on("data", (c: Buffer) => { err += c.toString(); });
      p.on("error", () => res(null));
      p.on("close", () => {
        const lines = out.split("\n").map((l) => l.trim());
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        if (lines.length < 5) {
          if (/not a bot|Sign in to confirm/i.test(err)) mlog("YouTube wants a sign-in (anti-bot). Set 'cookies browser' in music/settings.bloom, then restart.");
          else if (err.trim()) mlog("yt-dlp: " + err.trim().slice(-200));
          res(null); return;
        }
        const [url, thumbnail, channel, duration, ...titleParts] = lines;
        res({ title: titleParts.join(" ").trim() || "Unknown", url, thumbnail, channel, duration });
      });
    } catch {
      if (!started) res(null);
    }
  });
}

// List a playlist's songs (title + url) quickly with --flat-playlist (capped at
// 100 so radio/mix playlists don't queue forever). Full per-song metadata is
// fetched lazily when each song plays.
function resolvePlaylist(url: string): Promise<{ title: string; entries: Array<{ title: string; url: string }> } | null> {
  return new Promise((res) => {
    let out = "";
    try {
      const p = spawn("yt-dlp", [...cookiesArgs(), "--no-warnings", "--flat-playlist", "--playlist-end", "100",
        "--print", "%(playlist_title)s|||%(id)s|||%(url)s|||%(title)s", url], { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
      p.on("error", () => res(null));
      p.on("close", () => {
        const entries: Array<{ title: string; url: string }> = [];
        let title = "Playlist";
        for (const line of out.split("\n")) {
          const parts = line.trim().split("|||");
          if (parts.length < 4) continue;
          if (parts[0] && parts[0] !== "NA") title = parts[0];
          let vurl = parts[2];
          if (!/^https?:\/\//i.test(vurl) && parts[1] && parts[1] !== "NA") vurl = `https://www.youtube.com/watch?v=${parts[1]}`;
          if (/^https?:\/\//i.test(vurl)) entries.push({ url: vurl, title: parts[3] || "Unknown" });
        }
        res(entries.length ? { title, entries } : null);
      });
    } catch { res(null); }
  });
}

// Spawn yt-dlp piped into ffmpeg, producing an Ogg/Opus stream for @discordjs/voice.
// Returns the stream + a kill() that stops both processes.
function streamFor(url: string, onError: (msg: string) => void, opts: { startSec?: number; speed?: number } = {}): { stream: NodeJS.ReadableStream; kill(): void } | null {
  try {
    // Prefer webm/opus: it streams cleanly through a pipe. (m4a/mp4 keeps its
    // index at the END of the file, so ffmpeg would have to seek — which a pipe
    // can't do — and it reads nothing. That's the classic "joins but silent".)
    const format = "bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio";
    // Try several YouTube clients (YT_CLIENTS). android_vr serves opus WITHOUT the
    // "n challenge" (nsig) puzzle — so yt-dlp can't crash mid-download solving it —
    // and needs no login; default is the fallback. Trying several is what lets this
    // work without a signed-in account most of the time.
    const ytArgs = [...cookiesArgs(), "-q", "--no-playlist", "--extractor-args", "youtube:player_client=" + YT_CLIENTS, "-f", format, "-o", "-", url];
    // Build ffmpeg args. -ss AFTER -i is output-seeking (decodes from the start and
    // discards) — reliable on a pipe — used to resume at the current spot after a
    // speed change. -af atempo changes speed without changing pitch (valid 0.5–2.0).
    const ffArgs = ["-hide_banner", "-loglevel", "warning", "-i", "pipe:0", "-vn"];
    if (opts.startSec && opts.startSec > 0) ffArgs.push("-ss", String(Math.floor(opts.startSec)));
    if (opts.speed && opts.speed !== 1) ffArgs.push("-af", `atempo=${opts.speed}`);
    ffArgs.push("-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1");
    mlog(`yt-dlp(${YT_CLIENTS}) -> ffmpeg(PCM 48k stereo${opts.speed && opts.speed !== 1 ? `, ${opts.speed}×` : ""}${opts.startSec ? `, from ${Math.floor(opts.startSec)}s` : ""}) for ${url}`);
    const ytdlp = spawn("yt-dlp", ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
    // Decode to raw PCM (s16le, 48kHz, stereo) — @discordjs/voice encodes the opus.
    const ffmpeg = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "pipe", "pipe"] });
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
