// libraries/discord-bot/index.ts — make a Discord bot in Sprout.
//
//   use "discord-bot"
//   bot(secret("DISCORD_TOKEN"))
//   on_message("handle")
//   task handle():
//       when message() == "!ping":
//           reply("pong!")
//
// It connects to the Discord gateway with Node's built-in WebSocket (no
// dependencies). A library exports `create(interp)` returning the usual
// { names, builtins, isActive, start } plus an `api` that *extensions* (like
// the Music extension) hook into — see extensions/discord-bot/.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";

// GUILDS | GUILD_VOICE_STATES | GUILD_MESSAGES | MESSAGE_CONTENT
const INTENTS = 1 | 128 | 512 | 32768;

// The shape @discordjs/voice's gateway adapter calls back into (the music
// extension hands these to @discordjs/voice; we forward gateway voice events).
export interface VoiceAdapterMethods {
  onVoiceServerUpdate(data: unknown): void;
  onVoiceStateUpdate(data: unknown): void;
  destroy(): void;
}

// Voice-join trace on the gateway side — always on (only prints while joining a
// voice channel, so it's silent otherwise).
function vdebug(msg: string): void { console.log(`🎙️  [gateway] ${msg}`); }

export interface CommandContext {
  args: string;            // everything after "!word "
  author: string;          // username who sent it
  authorId: string;
  channelId: string;
  guildId: string;
  reply(text: string): void;
}

export interface SlashContext {
  name: string;
  option(name: string): string;   // a slash option's value as text
  author: string;
  authorId: string;
  channelId: string;
  guildId: string;
  reply(text: string): void;
}

// A slash command's typed inputs (type 3 = string). Discord shows them as fields.
export interface SlashOption { name: string; description: string; type: number; required: boolean; }

// What a button-click handler receives (for message buttons like the music controls).
export interface ButtonContext {
  customId: string;        // the button's custom_id, e.g. "music:skip"
  author: string;
  authorId: string;
  channelId: string;
  guildId: string;
}

interface PrefixCommand { word: string; handler: (ctx: CommandContext) => void; }
interface SlashCommand { name: string; description: string; options: SlashOption[]; handler: (ctx: SlashContext) => void; }

interface BotState {
  token: string;
  used: boolean;
  handler: string;         // the Sprout task wired via on_message
  selfId: string;
  appId: string;
  prefix: string;
  current: { content: string; author: string; channelId: string };
  currentReply: ((text: string) => void) | null;  // where reply() goes right now (a channel, or a slash)
  ws: WebSocket | null;
  prefixCommands: Map<string, PrefixCommand>;
  slashCommands: Map<string, SlashCommand>;
  voiceStates: Map<string, Map<string, string>>;             // guildId -> (userId -> channelId)
  voiceAdapters: Map<string, VoiceAdapterMethods>;           // guildId -> @discordjs/voice adapter
  listeners: Map<string, Array<(d: Record<string, unknown>) => void>>;
  buttonHandlers: Map<string, (ctx: ButtonContext) => void>; // custom_id -> handler (for message buttons)
}

// What an extension receives as its second argument: hooks into the live bot.
export interface DiscordApi {
  interp: Interpreter;
  onCommand(word: string, handler: (ctx: CommandContext) => void): void;
  onSlash(name: string, description: string, handler: (ctx: SlashContext) => void, options?: SlashOption[]): void;
  send(channelId: string, text: string): void;
  sendEmbed(channelId: string, embed: Record<string, unknown>, components?: unknown[]): void;
  onButton(customId: string, handler: (ctx: ButtonContext) => void): void;
  voiceChannelOf(guildId: string, userId: string): string | null;
  // A @discordjs/voice gateway adapter wired to THIS bot's gateway (for the music
  // extension): it sends voice payloads over our websocket and receives the
  // gateway's voice events. We use @discordjs/voice because Discord now requires
  // the DAVE end-to-end encryption protocol, which we can't do dependency-free.
  voiceAdapterCreator(guildId: string): (methods: VoiceAdapterMethods) => { sendPayload(payload: unknown): boolean; destroy(): void };
  slashCommandNames(): string[];
  log(msg: string): void;
}

export function create(interp: Interpreter) {
  const state: BotState = {
    token: "",
    used: false,
    handler: "",
    selfId: "",
    appId: "",
    prefix: "!",
    current: { content: "", author: "", channelId: "" },
    currentReply: null,
    ws: null,
    prefixCommands: new Map(),
    slashCommands: new Map(),
    voiceStates: new Map(),
    voiceAdapters: new Map(),
    listeners: new Map(),
    buttonHandlers: new Map(),
  };

  // reply() goes wherever we are right now: a slash command answers the
  // interaction; otherwise it's a normal message in the current channel.
  const replyNow = (text: string): void => {
    if (state.currentReply) state.currentReply(text);
    else send(state, state.current.channelId, text);
  };

  const builtins: Record<string, (args: Value[]) => Value> = {
    bot: (args) => { state.token = stringify(args[0] ?? NONE); state.used = true; return NONE; },
    on_message: (args) => { state.handler = stringify(args[0] ?? NONE); return NONE; },
    message: () => state.current.content,
    author: () => state.current.author,
    reply: (args) => { replyNow(stringify(args[0] ?? NONE)); return NONE; },
    say: (args) => { send(state, stringify(args[0] ?? NONE), stringify(args[1] ?? NONE)); return NONE; },
    // slash("name", "description", "taskName") — define your own /command in Sprout.
    slash: (args) => {
      const name = stringify(args[0] ?? NONE);
      const description = stringify(args[1] ?? NONE) || "A Sprout command";
      const task = stringify(args[2] ?? NONE);
      state.slashCommands.set(name, {
        name, description, options: [],
        handler: (ctx) => {
          state.current = { content: "", author: ctx.author, channelId: ctx.channelId };
          const prev = state.currentReply;
          state.currentReply = ctx.reply;
          try { interp.runTask(task); }
          catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
          state.currentReply = prev;
        },
      });
      return NONE;
    },
  };

  const api: DiscordApi = {
    interp,
    onCommand: (word, handler) => { state.prefixCommands.set(word.toLowerCase(), { word: word.toLowerCase(), handler }); },
    onSlash: (name, description, handler, options = []) => { state.slashCommands.set(name, { name, description, options, handler }); },
    send: (channelId, text) => send(state, channelId, text),
    sendEmbed: (channelId, embed, components) => sendEmbed(state, channelId, embed, components),
    onButton: (customId, handler) => { state.buttonHandlers.set(customId, handler); },
    voiceChannelOf: (guildId, userId) => state.voiceStates.get(guildId)?.get(userId) ?? null,
    voiceAdapterCreator: (guildId) => (methods) => {
      state.voiceAdapters.set(guildId, methods);
      return {
        sendPayload: (payload) => { try { state.ws?.send(JSON.stringify(payload)); return true; } catch { return false; } },
        destroy: () => { state.voiceAdapters.delete(guildId); },
      };
    },
    slashCommandNames: () => [...state.slashCommands.keys()],
    log: (msg) => console.log(msg),
  };

  return {
    names: ["bot", "on_message", "message", "author", "reply", "say", "slash"],
    builtins,
    isActive: () => state.used,
    start: () => connect(interp, state),
    api,
  };
}

// --- Discord REST (async fire-and-forget; keeps the audio loop smooth) --------

function rest(state: BotState, method: string, path: string, body: unknown, auth = true): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers["Authorization"] = "Bot " + state.token;
  return fetch("https://discord.com/api/v10" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
    .then((r) => r.json().catch(() => ({})))
    .catch(() => ({})) as Promise<Record<string, unknown>>;
}

function send(state: BotState, channelId: string, content: string): void {
  if (!channelId || !content) return;
  void rest(state, "POST", `/channels/${channelId}/messages`, { content });
}

function sendEmbed(state: BotState, channelId: string, embed: Record<string, unknown>, components?: unknown[]): void {
  if (!channelId || !embed) return;
  const body: Record<string, unknown> = { embeds: [embed] };
  if (components && components.length) body.components = components;
  void rest(state, "POST", `/channels/${channelId}/messages`, body);
}

function interactionRespond(state: BotState, id: string, token: string, content: string): void {
  void rest(state, "POST", `/interactions/${id}/${token}/callback`, { type: 4, data: { content } }, false);
}

// Acknowledge a button click with no visible change (type 6), so Discord doesn't
// show "This interaction failed" — the actual effect happens in the handler.
function interactionAck(state: BotState, id: string, token: string): void {
  void rest(state, "POST", `/interactions/${id}/${token}/callback`, { type: 6 }, false);
}

function registerGuildCommands(state: BotState, guildId: string): void {
  if (!state.appId || state.slashCommands.size === 0) return;
  const cmds = [...state.slashCommands.values()].map((c) => ({ name: c.name, description: c.description, type: 1, options: c.options ?? [] }));
  void rest(state, "PUT", `/applications/${state.appId}/guilds/${guildId}/commands`, cmds);
}

// --- gateway event hub (extensions + voice subscribe here) --------------------

function onGateway(state: BotState, type: string, cb: (d: Record<string, unknown>) => void): () => void {
  const arr = state.listeners.get(type) ?? [];
  arr.push(cb);
  state.listeners.set(type, arr);
  return () => { const a = state.listeners.get(type); if (a) a.splice(a.indexOf(cb), 1); };
}

function emitGateway(state: BotState, type: string, d: Record<string, unknown>): void {
  const arr = state.listeners.get(type);
  if (arr) for (const cb of arr.slice()) cb(d);
}

function gatewaySend(state: BotState, op: number, d: unknown): void {
  try { state.ws?.send(JSON.stringify({ op, d })); } catch { /* socket closing */ }
}

// --- the gateway connection ---------------------------------------------------

function connect(interp: Interpreter, state: BotState): void {
  if (!state.token || state.token === "PUT-YOUR-BOT-TOKEN-HERE" || state.token === "nothing") {
    console.error('\n🌱 Your bot needs a token. Put it in a .env file:  DISCORD_TOKEN = your-token');
    console.error("   Get one at https://discord.com/developers/applications");
    console.error("   (under Bot, copy the token and turn ON 'Message Content Intent').\n");
    process.exit(1);
  }

  let seq: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  state.ws = ws;
  console.log("🌱 Connecting your Sprout bot to Discord…");

  ws.addEventListener("message", (ev: { data: unknown }) => {
    let payload: { op: number; d: Record<string, unknown>; s: number | null; t: string | null };
    try { payload = JSON.parse(String(ev.data)); } catch { return; }
    const { op, d, s, t } = payload;
    if (typeof s === "number") seq = s;

    if (op === 10) {
      heartbeat = setInterval(() => {
        try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch { /* ignore */ }
      }, Number((d as { heartbeat_interval?: number }).heartbeat_interval));
      ws.send(JSON.stringify({
        op: 2,
        d: { token: state.token, intents: INTENTS, properties: { os: "linux", browser: "sprout", device: "sprout" } },
      }));
    } else if (op === 0 && t) {
      dispatch(interp, state, t, d);
    }
  });

  ws.addEventListener("close", (ev: { code: number }) => {
    if (heartbeat) clearInterval(heartbeat);
    console.log(`Disconnected from Discord (code ${ev.code}).`);
    process.exit(0);
  });
  ws.addEventListener("error", () => console.error("There was a problem with the Discord connection."));
}

function dispatch(interp: Interpreter, state: BotState, type: string, d: Record<string, unknown>): void {
  if (type === "READY") {
    state.selfId = String(((d.user as { id?: string }) || {}).id || "");
    state.appId = String(((d.application as { id?: string }) || {}).id || state.selfId);
    console.log(`🌱 Bot online as ${(d.user as { username?: string }).username}! Listening — press Ctrl+C to stop.`);
  } else if (type === "GUILD_CREATE") {
    const guildId = String(d.id || "");
    const voiceStates = (d.voice_states as Array<{ user_id: string; channel_id: string }>) || [];
    const map = new Map<string, string>();
    for (const vs of voiceStates) if (vs.channel_id) map.set(vs.user_id, vs.channel_id);
    state.voiceStates.set(guildId, map);
    registerGuildCommands(state, guildId);
  } else if (type === "VOICE_STATE_UPDATE") {
    const guildId = String(d.guild_id || "");
    const userId = String(d.user_id || "");
    if (guildId) {
      const map = state.voiceStates.get(guildId) ?? new Map<string, string>();
      const channelId = d.channel_id ? String(d.channel_id) : "";
      if (channelId) map.set(userId, channelId); else map.delete(userId);
      state.voiceStates.set(guildId, map);
      if (userId === state.selfId) { vdebug("forwarding our VOICE_STATE_UPDATE to the voice adapter"); state.voiceAdapters.get(guildId)?.onVoiceStateUpdate(d); }
    }
  } else if (type === "VOICE_SERVER_UPDATE") {
    const guildId = String(d.guild_id || "");
    vdebug(`forwarding VOICE_SERVER_UPDATE (endpoint ${d.endpoint}) to the voice adapter`);
    state.voiceAdapters.get(guildId)?.onVoiceServerUpdate(d);
  } else if (type === "MESSAGE_CREATE") {
    const author = d.author as { id?: string; username?: string; bot?: boolean } | undefined;
    if (!author || author.id === state.selfId || author.bot) { emitGateway(state, type, d); return; }
    const content = String(d.content || "");
    state.current = { content, author: String(author.username || ""), channelId: String(d.channel_id || "") };
    runPrefixCommand(state, content, {
      author: String(author.username || ""),
      authorId: String(author.id || ""),
      channelId: String(d.channel_id || ""),
      guildId: String(d.guild_id || ""),
    });
    if (state.handler) {
      try { interp.runTask(state.handler); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
    }
  } else if (type === "INTERACTION_CREATE") {
    handleInteraction(state, d);
  }
  emitGateway(state, type, d);
}

function runPrefixCommand(
  state: BotState,
  content: string,
  who: { author: string; authorId: string; channelId: string; guildId: string },
): void {
  if (!content.startsWith(state.prefix)) return;
  const rest = content.slice(state.prefix.length);
  const sp = rest.indexOf(" ");
  const word = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
  const args = sp === -1 ? "" : rest.slice(sp + 1).trim();
  const cmd = state.prefixCommands.get(word);
  if (!cmd) return;
  cmd.handler({
    args,
    author: who.author,
    authorId: who.authorId,
    channelId: who.channelId,
    guildId: who.guildId,
    reply: (text) => send(state, who.channelId, text),
  });
}

function handleInteraction(state: BotState, d: Record<string, unknown>): void {
  const itype = Number(d.type);
  const id = String(d.id || "");
  const token = String(d.token || "");
  const member = d.member as { user?: { id?: string; username?: string } } | undefined;
  const user = (member && member.user) || (d.user as { id?: string; username?: string }) || {};

  // A button (message component) click.
  if (itype === 3) {
    const customId = String((d.data as { custom_id?: string })?.custom_id || "");
    interactionAck(state, id, token); // ACK first (within 3s) so the click doesn't fail
    const handler = state.buttonHandlers.get(customId);
    if (handler) {
      try {
        handler({
          customId,
          author: String(user.username || ""),
          authorId: String(user.id || ""),
          channelId: String(d.channel_id || ""),
          guildId: String(d.guild_id || ""),
        });
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
    }
    return;
  }

  if (itype !== 2) return; // only application (slash) commands below
  const data = (d.data as { name?: string; options?: Array<{ name: string; value: unknown }> }) || {};
  const cmd = state.slashCommands.get(String(data.name || ""));
  const options = data.options || [];
  const ctx: SlashContext = {
    name: String(data.name || ""),
    option: (name) => {
      const found = options.find((o) => o.name === name);
      return found ? String(found.value) : "";
    },
    author: String(user.username || ""),
    authorId: String(user.id || ""),
    channelId: String(d.channel_id || ""),
    guildId: String(d.guild_id || ""),
    reply: (text) => interactionRespond(state, id, token, text),
  };
  if (cmd) cmd.handler(ctx);
  else interactionRespond(state, id, token, "That command isn't set up.");
}
