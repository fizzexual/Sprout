// extensions/discord-bot/music/lavalink.ts — a Lavalink v4 client engine.
//
// This is the "scale" backend. Instead of the bot spawning yt-dlp + ffmpeg on its
// own machine (one IP → rate-limited fast), it tells a Lavalink SERVER "play this
// in guild X". Lavalink does the extraction, the voice UDP, opus, and DAVE. You
// scale by running more Lavalink nodes (each its own host/IP), so 50 servers no
// longer share one IP's YouTube rate-limit.
//
// Turn it on by setting  lavalink host:  in  music/settings.bloom.
//
// Protocol: https://lavalink.dev/api/  (v4: WS /v4/websocket, REST /v4/sessions).

import type { DiscordApi } from "../../../libraries/discord-bot/index.ts";
import type { Track } from "./index.ts";

export interface LavalinkConfig { host: string; port: number; password: string; secure: boolean; }

// Read the Lavalink connection from music/settings.bloom. Returns null when the
// user hasn't set a host (so the bot uses the built-in local engine instead).
export function readLavalinkConfig(cfg: Record<string, string>): LavalinkConfig | null {
  const host = (cfg["lavalink host"] || "").trim();
  if (!host) return null;
  return {
    host,
    port: parseInt((cfg["lavalink port"] || "2333").trim(), 10) || 2333,
    password: (cfg["lavalink password"] || "youshallnotpass").trim(),
    secure: /^(yes|true|on|1|wss|https)$/i.test((cfg["lavalink secure"] || "").trim()),
  };
}

// Helpers the engine borrows from the music extension (shared embeds + config).
export interface MusicHelpers {
  nowPlayingEmbed(track: Track, cfg: Record<string, string>): Record<string, unknown>;
  playlistEmbed(title: string, count: number, requestedBy: string, cfg: Record<string, string>): Record<string, unknown>;
  controllerComponents(): unknown[];
  readConfig(): Record<string, string>;
  mlog(msg: string): void;
}

interface LLItem { encoded: string; track: Track; }
interface LLGuild {
  queue: LLItem[];
  current: LLItem | null;
  voiceChannelId: string;
  textChannelId: string;
  voice: { token?: string; endpoint?: string; sessionId?: string };
  voiceSent: boolean;
  volume: number;  // Lavalink player volume, 0–1000 (100 = normal)
  speed: number;   // timescale speed, 1 = normal
  adapter: { sendPayload(p: unknown): boolean; destroy(): void } | null;
}

const fmtTime = (ms: number): string => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};

export function createLavalinkEngine(api: DiscordApi, config: LavalinkConfig, h: MusicHelpers) {
  const httpBase = `${config.secure ? "https" : "http"}://${config.host}:${config.port}`;
  const wsUrl = `${config.secure ? "wss" : "ws"}://${config.host}:${config.port}/v4/websocket`;
  const authHeader = { Authorization: config.password };
  const guilds = new Map<string, LLGuild>();

  let ws: any = null;
  let sessionId = "";          // Lavalink session id (from the "ready" op)
  let connected = false;
  let connecting = false;
  let readyResolve: ((ok: boolean) => void) | null = null;

  const gOf = (id: string): LLGuild => {
    let g = guilds.get(id);
    if (!g) { g = { queue: [], current: null, voiceChannelId: "", textChannelId: "", voice: {}, voiceSent: false, volume: 100, speed: 1, adapter: null }; guilds.set(id, g); }
    return g;
  };

  async function rest(method: string, path: string, body?: unknown): Promise<any> {
    try {
      const r = await fetch(httpBase + path, { method, headers: { ...authHeader, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 204) return {};
      return await r.json().catch(() => ({}));
    } catch (e) { h.mlog("lavalink REST failed: " + (e instanceof Error ? e.message : String(e))); return null; }
  }

  async function loadTracks(identifier: string): Promise<any> {
    try {
      const r = await fetch(httpBase + "/v4/loadtracks?identifier=" + encodeURIComponent(identifier), { headers: authHeader });
      return await r.json();
    } catch (e) { h.mlog("lavalink loadtracks failed: " + (e instanceof Error ? e.message : String(e))); return null; }
  }

  // Connect (once) to the Lavalink node. Resolves true once the "ready" op lands.
  async function ensureConnected(): Promise<boolean> {
    if (connected) return true;
    if (connecting) return new Promise((res) => { const prev = readyResolve; readyResolve = (ok) => { prev?.(ok); res(ok); }; });
    connecting = true;
    const botId = api.botId();
    if (!botId) { connecting = false; h.mlog("lavalink: bot isn't ready yet — try again in a second"); return false; }
    let WS: any;
    try { WS = (await import("ws")).default; } catch { connecting = false; h.mlog("lavalink: the 'ws' package is missing — run install music"); return false; }
    return new Promise((resolve) => {
      readyResolve = resolve;
      const fail = (why: string) => { connecting = false; h.mlog("lavalink: " + why); if (readyResolve) { readyResolve(false); readyResolve = null; } };
      try {
        ws = new WS(wsUrl, { headers: { Authorization: config.password, "User-Id": botId, "Client-Name": "Sprout/0.4" } });
      } catch (e) { fail("couldn't open WS: " + (e instanceof Error ? e.message : String(e))); return; }
      const timer = setTimeout(() => { if (!connected) fail("timed out connecting to " + config.host); }, 10000);
      ws.on("open", () => h.mlog("lavalink: socket open to " + config.host));
      ws.on("message", (d: any) => onMessage(String(d)));
      ws.on("error", (e: any) => h.mlog("lavalink WS error: " + (e?.message || e)));
      ws.on("close", (c: number) => { connected = false; connecting = false; ws = null; clearTimeout(timer); h.mlog("lavalink: socket closed (" + c + ")"); });
      const origResolve = readyResolve;
      readyResolve = (ok) => { clearTimeout(timer); origResolve?.(ok); };
    });
  }

  function onMessage(raw: string): void {
    let msg: any; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.op === "ready") {
      sessionId = String(msg.sessionId || ""); connected = true; connecting = false;
      h.mlog("lavalink: ready ✓ (session " + sessionId + ")");
      if (readyResolve) { readyResolve(true); readyResolve = null; }
    } else if (msg.op === "event") {
      onEvent(msg);
    }
  }

  function onEvent(msg: any): void {
    const guildId = String(msg.guildId || "");
    const g = guilds.get(guildId); if (!g) return;
    if (msg.type === "TrackEndEvent") {
      // Advance only when the track finished or failed on its own. "stopped",
      // "replaced" and "cleanup" are things WE did (skip/stop) — don't double-advance.
      if (msg.reason === "finished" || msg.reason === "loadFailed") void playNext(guildId);
    } else if (msg.type === "TrackExceptionEvent" || msg.type === "TrackStuckEvent") {
      api.send(g.textChannelId, "⚠️ Trouble with that track — skipping.");
      void playNext(guildId);
    } else if (msg.type === "WebSocketClosedEvent") {
      h.mlog("lavalink voice closed: code " + msg.code + " (" + msg.reason + ")");
    }
  }

  // --- voice: join the channel via our gateway, hand the voice info to Lavalink ---
  function connectVoice(guildId: string, channelId: string): void {
    const g = gOf(guildId);
    g.voiceChannelId = channelId;
    g.voice = {}; g.voiceSent = false;
    g.adapter = api.voiceAdapterCreator(guildId)({
      onVoiceServerUpdate: (d: any) => { g.voice.token = d?.token; g.voice.endpoint = d?.endpoint; void sendVoice(guildId); },
      onVoiceStateUpdate: (d: any) => { g.voice.sessionId = d?.session_id; void sendVoice(guildId); },
    });
    g.adapter.sendPayload({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: true } });
  }

  async function sendVoice(guildId: string): Promise<void> {
    const g = guilds.get(guildId); if (!g || g.voiceSent) return;
    if (!g.voice.token || !g.voice.endpoint || !g.voice.sessionId || !sessionId) return;
    g.voiceSent = true;
    await rest("PATCH", `/v4/sessions/${sessionId}/players/${guildId}?noReplace=false`, { voice: { token: g.voice.token, endpoint: g.voice.endpoint, sessionId: g.voice.sessionId } });
    if (!g.current) void playNext(guildId); // voice is up — start the first song
  }

  function trackFrom(t: any, authorId: string, textChannelId: string, voiceChannelId: string, guildId: string): Track {
    const i = t.info || {};
    return {
      title: i.title || "Unknown", url: i.uri || "", thumbnail: i.artworkUrl || "",
      channel: i.author || "", duration: i.isStream ? "LIVE" : fmtTime(i.length || 0),
      requestedBy: authorId, textChannelId, voiceChannelId, guildId,
    };
  }

  async function playNext(guildId: string): Promise<void> {
    const g = guilds.get(guildId); if (!g) return;
    const item = g.queue.shift();
    if (!item) { g.current = null; leave(guildId); return; }
    g.current = item;
    await rest("PATCH", `/v4/sessions/${sessionId}/players/${guildId}?noReplace=false`, {
      track: { encoded: item.encoded }, volume: Math.round(g.volume), filters: { timescale: { speed: g.speed, pitch: 1, rate: 1 } },
    });
    api.sendEmbed(g.textChannelId, h.nowPlayingEmbed(item.track, h.readConfig()), h.controllerComponents());
  }

  function leave(guildId: string): void {
    const g = guilds.get(guildId); if (!g) return;
    if (sessionId) void rest("DELETE", `/v4/sessions/${sessionId}/players/${guildId}`);
    try { g.adapter?.sendPayload({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false } }); } catch { /* gone */ }
    try { g.adapter?.destroy(); } catch { /* gone */ }
    guilds.delete(guildId);
  }

  // --- the public surface the commands + buttons call (matches the local engine) ---
  return {
    async play(guildId: string, authorId: string, query: string, textChannelId: string, reply: (t: string) => void): Promise<void> {
      const voiceChannel = api.voiceChannelOf(guildId, authorId);
      if (!voiceChannel) { reply("Join a voice channel first. 🎧"); return; }
      if (!query) { reply("Tell me what to play:  `!play <link or words>`"); return; }
      if (!(await ensureConnected())) { reply("I can't reach the Lavalink server — check `lavalink host` in music/settings.bloom."); return; }
      reply("🔎 Looking that up…");
      const identifier = /^https?:\/\//i.test(query.trim()) ? query.trim() : "ytsearch:" + query.trim();
      const res = await loadTracks(identifier);
      if (!res) { api.send(textChannelId, "Couldn't reach Lavalink."); return; }
      if (res.loadType === "error") { api.send(textChannelId, "That couldn't be loaded: " + (res.data?.message || "error")); return; }
      const cfg = h.readConfig();
      const mk = (t: any): LLItem => ({ encoded: t.encoded, track: trackFrom(t, authorId, textChannelId, voiceChannel, guildId) });
      let added: LLItem[] = [];
      if (res.loadType === "track") added = [mk(res.data)];
      else if (res.loadType === "search") added = res.data && res.data.length ? [mk(res.data[0])] : [];
      else if (res.loadType === "playlist") added = (res.data?.tracks || []).map(mk);
      if (added.length === 0) { api.send(textChannelId, "I couldn't find that."); return; }

      const g = gOf(guildId);
      g.textChannelId = textChannelId;
      const wasIdle = !g.current;
      g.queue.push(...added);
      if (res.loadType === "playlist") api.sendEmbed(textChannelId, h.playlistEmbed(res.data?.info?.name || "Playlist", added.length, authorId, cfg));
      else if (!wasIdle) reply(`➕ Added to the queue: **${added[0].track.title}**`);

      if (!g.voiceSent) connectVoice(guildId, voiceChannel); // sendVoice() will start playback
      else if (wasIdle) void playNext(guildId);
    },
    skip(guildId: string, reply: (t: string) => void): void {
      const g = guilds.get(guildId);
      if (!g || !g.current) { reply("Nothing is playing."); return; }
      reply("⏭️ Skipping…");
      void playNext(guildId); // replaces the current track (old end-event reason = "replaced", ignored)
    },
    stop(guildId: string, reply: (t: string) => void): void {
      const g = guilds.get(guildId);
      if (!g) { reply("Nothing is playing."); return; }
      g.queue = []; g.current = null;
      reply("⏹️ Stopped. Bye! 👋");
      leave(guildId);
    },
    pauseToggle(guildId: string, channelId: string): void {
      const g = guilds.get(guildId);
      if (!g || !g.current) { api.send(channelId, "Nothing is playing."); return; }
      (g as any)._paused = !(g as any)._paused;
      void rest("PATCH", `/v4/sessions/${sessionId}/players/${guildId}?noReplace=false`, { paused: !!(g as any)._paused });
      api.send(channelId, (g as any)._paused ? "⏸️ Paused." : "▶️ Resumed.");
    },
    changeVolume(guildId: string, factor: number, channelId: string): void {
      const g = guilds.get(guildId);
      if (!g || !g.current) { api.send(channelId, "Nothing is playing."); return; }
      g.volume = Math.max(0, Math.min(200, Math.round(g.volume * factor)));
      void rest("PATCH", `/v4/sessions/${sessionId}/players/${guildId}?noReplace=false`, { volume: g.volume });
      api.send(channelId, `🔊 Volume: **${g.volume}%**`);
    },
    changeSpeed(guildId: string, factor: number, channelId: string): void {
      const g = guilds.get(guildId);
      if (!g || !g.current) { api.send(channelId, "Nothing is playing."); return; }
      g.speed = Math.max(0.5, Math.min(2, Math.round(g.speed * factor * 100) / 100));
      void rest("PATCH", `/v4/sessions/${sessionId}/players/${guildId}?noReplace=false`, { filters: { timescale: { speed: g.speed, pitch: 1, rate: 1 } } });
      api.send(channelId, `${factor >= 1 ? "⏩" : "🐢"} Speed: **${g.speed}×** _(Lavalink — no skip)_`);
    },
    queueText(guildId: string): { current: Track | null; queue: Track[] } {
      const g = guilds.get(guildId);
      return { current: g?.current?.track ?? null, queue: (g?.queue ?? []).map((i) => i.track) };
    },
  };
}
