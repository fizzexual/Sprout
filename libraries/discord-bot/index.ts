// libraries/discord-bot/index.ts — make a Discord bot in Sprout.
//
//   use "discord-bot"
//   bot("YOUR_TOKEN")
//   on_message("handle")
//   task handle():
//       when message() == "!ping":
//           reply("pong!")
//
// It connects to the Discord gateway with Node's built-in WebSocket (no
// dependencies) and sends messages with Discord's REST API. A library exports
// `create(interp)` returning { names, builtins, isActive, start }; the Sprout
// CLI loads it when a program says `use "discord-bot"`.

import { spawnSync } from "node:child_process";
import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";

interface BotState {
  token: string;
  used: boolean;
  handler: string;
  selfId: string;
  current: { content: string; author: string; channelId: string };
}

export function create(interp: Interpreter) {
  const state: BotState = {
    token: "",
    used: false,
    handler: "",
    selfId: "",
    current: { content: "", author: "", channelId: "" },
  };

  const builtins: Record<string, (args: Value[]) => Value> = {
    bot: (args) => { state.token = stringify(args[0] ?? NONE); state.used = true; return NONE; },
    on_message: (args) => { state.handler = stringify(args[0] ?? NONE); return NONE; },
    message: () => state.current.content,
    author: () => state.current.author,
    reply: (args) => { send(state, state.current.channelId, stringify(args[0] ?? NONE)); return NONE; },
    say: (args) => { send(state, stringify(args[0] ?? NONE), stringify(args[1] ?? NONE)); return NONE; },
  };

  return {
    names: ["bot", "on_message", "message", "author", "reply", "say"],
    builtins,
    isActive: () => state.used,
    start: () => connect(interp, state),
  };
}

// Send a message to a channel via Discord's REST API (a short-lived subprocess,
// so the call is synchronous — fits Sprout's simple model).
function send(state: BotState, channelId: string, content: string): void {
  if (!channelId || !content) return;
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const script =
    "(async()=>{try{const r=await fetch(process.argv[1],{method:'POST'," +
    "headers:{'Authorization':process.argv[2],'Content-Type':'application/json'}," +
    "body:JSON.stringify({content:process.argv[3]})});process.stdout.write(String(r.status));}" +
    "catch(e){process.stderr.write(String((e&&e.message)||e));}})()";
  spawnSync(process.execPath, ["-e", script, url, "Bot " + state.token, content], { encoding: "utf8", timeout: 15000 });
}

function connect(interp: Interpreter, state: BotState): void {
  if (!state.token || state.token === "PUT-YOUR-BOT-TOKEN-HERE" || state.token === "nothing") {
    console.error('\n🌱 Your bot needs a token. Put it in your program:  bot("your-token-here")');
    console.error("   Get one at https://discord.com/developers/applications");
    console.error("   (under Bot, copy the token and turn ON 'Message Content Intent').\n");
    process.exit(1);
  }

  // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
  const intents = 1 | 512 | 32768;
  let seq: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  console.log("🌱 Connecting your Sprout bot to Discord…");

  ws.addEventListener("message", (ev: { data: unknown }) => {
    let payload: { op: number; d: Record<string, unknown> & { user?: Record<string, unknown>; author?: Record<string, unknown>; heartbeat_interval?: number }; s: number | null; t: string | null };
    try {
      payload = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const { op, d, s, t } = payload;
    if (typeof s === "number") seq = s;

    if (op === 10) {
      heartbeat = setInterval(() => {
        try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch { /* ignore */ }
      }, Number(d.heartbeat_interval));
      ws.send(JSON.stringify({
        op: 2,
        d: { token: state.token, intents, properties: { os: "linux", browser: "sprout", device: "sprout" } },
      }));
    } else if (op === 0) {
      if (t === "READY") {
        state.selfId = String((d.user && d.user.id) || "");
        console.log(`🌱 Bot online as ${d.user && d.user.username}! Listening for messages — press Ctrl+C to stop.`);
      } else if (t === "MESSAGE_CREATE") {
        const author = d.author as { id?: string; username?: string; bot?: boolean } | undefined;
        if (!author || author.id === state.selfId || author.bot) return;
        state.current = {
          content: String(d.content || ""),
          author: String(author.username || ""),
          channelId: String(d.channel_id || ""),
        };
        if (state.handler) {
          try {
            interp.runTask(state.handler);
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
          }
        }
      }
    }
  });

  ws.addEventListener("close", (ev: { code: number }) => {
    if (heartbeat) clearInterval(heartbeat);
    console.log(`Disconnected from Discord (code ${ev.code}).`);
    process.exit(0);
  });
  ws.addEventListener("error", () => {
    console.error("There was a problem with the Discord connection.");
  });
}
