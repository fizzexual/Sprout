// src/modules.ts — `sprout modules`: a full-screen terminal app (TUI) for
// managing Sprout's libraries ("modules"). You type commands in the box at the
// bottom — install, uninstall, test — and the screen redraws live. Zero deps:
// raw-mode stdin + ANSI/truecolour, themed after Tokyonight.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = (() => { try { return readFileSync(join(REPO, "VERSION"), "utf8").trim(); } catch { return "0.4"; } })();

// --- theme (Tokyonight) -------------------------------------------------------
const ESC = "\x1b[";
const RESET = ESC + "0m";
const rgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const fg = (hex: string) => (s: string): string => `${ESC}38;2;${rgb(hex).join(";")}m${s}${RESET}`;
const T = {
  text: fg("#c0caf5"), blue: fg("#7aa2f7"), cyan: fg("#7dcfff"), purple: fg("#bb9af7"),
  green: fg("#9ece6a"), yellow: fg("#e0af68"), red: fg("#f7768e"), dim: fg("#565f89"),
};
const ALT_ON = ESC + "?1049h", ALT_OFF = ESC + "?1049l";
const HIDE = ESC + "?25l", SHOW = ESC + "?25h";
const CLEAR = ESC + "2J" + ESC + "H";

const vlen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

// A horizontal blue→purple→cyan gradient (matches the Sprout banner).
function gradient(text: string): string {
  const stops = ["#7aa2f7", "#bb9af7", "#7dcfff"].map(rgb);
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === " ") { out += " "; continue; }
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    const seg = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2);
    const lt = t * (stops.length - 1) - seg;
    const c = [0, 1, 2].map((k) => Math.round(stops[seg][k] + (stops[seg + 1][k] - stops[seg][k]) * lt));
    out += `${ESC}38;2;${c.join(";")}m${chars[i]}`;
  }
  return out + RESET;
}

const LOGO = [
  "███████╗██████╗ ██████╗  ██████╗ ██╗   ██╗████████╗",
  "██╔════╝██╔══██╗██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝",
  "███████╗██████╔╝██████╔╝██║   ██║██║   ██║   ██║   ",
  "╚════██║██╔═══╝ ██╔══██╗██║   ██║██║   ██║   ██║   ",
  "███████║██║     ██║  ██║╚██████╔╝╚██████╔╝   ██║   ",
  "╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ",
];

// --- the catalogue ------------------------------------------------------------
interface Extension { name: string; description: string; npm: string[]; tools: string[]; setup?: string; }
interface Module { name: string; description: string; extensions: Extension[]; }

const MODULES: Module[] = [
  {
    name: "discord-bot",
    description: "Make a Discord bot — chat + slash commands",
    extensions: [
      {
        name: "music",
        description: "Play YouTube audio in voice",
        npm: ["@discordjs/voice", "@snazzah/davey", "libsodium-wrappers", "prism-media"],
        tools: ["ffmpeg", "yt-dlp"],
        setup: "tools/install-music.ps1",
      },
    ],
  },
];

// --- status -------------------------------------------------------------------
const libPath = (n: string): string => join(REPO, "libraries", n);
const extPath = (l: string, e: string): string => join(REPO, "extensions", l, e);
const libPresent = (n: string): boolean => existsSync(join(libPath(n), "index.ts"));
const extPresent = (l: string, e: string): boolean => existsSync(join(extPath(l, e), "index.ts"));
const npmInstalled = (p: string): boolean => existsSync(join(REPO, "node_modules", ...p.split("/")));
const toolCache = new Map<string, boolean>();
function toolPresent(tool: string): boolean {
  if (toolCache.has(tool)) return toolCache.get(tool)!;
  let ok = false;
  try { const r = spawnSync(tool, ["--version"], { stdio: "ignore", timeout: 8000 }); ok = !r.error && r.status === 0; } catch { ok = false; }
  toolCache.set(tool, ok);
  return ok;
}
function extMissing(e: Extension): string[] {
  const m: string[] = [];
  for (const p of e.npm) if (!npmInstalled(p)) m.push(p);
  for (const t of e.tools) if (!toolPresent(t)) m.push(t);
  return m;
}

interface Found { mod: Module; ext: Extension; }
function findExtension(arg: string): Found | null {
  const a = arg.trim().toLowerCase().replace(/^.*\//, ""); // accept "music" or "discord-bot/music"
  for (const mod of MODULES) for (const ext of mod.extensions) if (ext.name === a) return { mod, ext };
  return null;
}

// --- screen -------------------------------------------------------------------
interface State { input: string; message: string[]; pendingUninstall: string | null; }

const col = (s: string, w: number): string => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));

function contentBlock(): string[] {
  const lines: string[] = [];
  lines.push(T.dim("  libraries"));
  for (const m of MODULES) {
    const here = libPresent(m.name);
    lines.push("    " + (here ? T.green("●") : T.dim("○")) + " " + T.text(col(m.name, 16)) + T.dim(m.description));
    for (const e of m.extensions) {
      if (!extPresent(m.name, e.name)) { lines.push("        " + T.dim(col(e.name, 14) + "not installed")); continue; }
      const ready = extMissing(e).length === 0;
      const badge = ready ? T.green("ready") : (T.yellow("needs setup") + T.dim(" → type ") + T.cyan("install " + e.name));
      lines.push("        " + T.cyan(col(e.name, 14)) + T.dim(col(e.description, 30)) + badge);
    }
  }
  lines.push("");
  lines.push(T.dim("  commands  ") + T.blue("browse") + T.dim("   ") + T.blue("install ") + T.dim("<name>   ") + T.blue("uninstall ") + T.dim("<name>   ") + T.blue("test") + T.dim("   ") + T.blue("quit"));
  return lines;
}

// The full catalogue — every library Sprout offers, installed or not.
function browseReport(): string[] {
  const out: string[] = [T.text("catalogue — every Sprout library:"), ""];
  for (const m of MODULES) {
    const here = libPresent(m.name);
    out.push("  " + (here ? T.green("● " + m.name) + T.dim("   installed, ready to ") + T.cyan("use \"" + m.name + "\"")
                            : T.dim("○ " + m.name) + T.yellow("   available")));
    out.push("      " + T.dim(m.description));
    for (const e of m.extensions) {
      const ready = extPresent(m.name, e.name) && extMissing(e).length === 0;
      out.push("      " + T.dim("+ ") + T.cyan(col(e.name, 10)) + T.dim(col(e.description, 30)) +
        (ready ? T.green("ready") : T.yellow("needs setup") + T.dim(" (") + T.cyan("install " + e.name) + T.dim(")")));
    }
    out.push("");
  }
  out.push(T.dim("  ‘needs setup’ = it works once you run its install (gets extra tools/packages)."));
  out.push(T.dim("  Want more? Add your own library — see libraries/README.md."));
  return out;
}

function renderScreen(state: State): string {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const center = (s: string): string => " ".repeat(Math.max(0, Math.floor((cols - vlen(s)) / 2))) + s;

  const top: string[] = ["", ""];
  for (const l of LOGO) top.push(center(gradient(l)));
  top.push(center(T.dim("modules · v" + VERSION)));
  top.push("");
  for (const l of contentBlock()) top.push(l);
  if (state.message.length) { top.push(""); for (const l of state.message) top.push("  " + l); }

  // input box, pinned near the bottom
  const boxW = Math.min(cols - 6, 76);
  const lp = " ".repeat(Math.max(0, Math.floor((cols - boxW) / 2)));
  const promptText = " " + T.cyan("❯") + " " + T.text(state.input) + T.blue("█");
  const inner = promptText + " ".repeat(Math.max(0, boxW - 2 - vlen(promptText)));
  const box = [
    lp + T.dim("╭" + "─".repeat(boxW - 2) + "╮"),
    lp + T.dim("│") + inner + T.dim("│"),
    lp + T.dim("╰" + "─".repeat(boxW - 2) + "╯"),
    lp + T.dim("enter run") + "   " + T.dim("·") + "   " + T.dim("type ") + T.blue("help") + T.dim(" for commands"),
  ];

  const used = top.length + box.length;
  const pad = Math.max(1, rows - used - 1);
  return CLEAR + top.join("\n") + "\n".repeat(pad) + box.join("\n");
}

// --- actions ------------------------------------------------------------------
function testReport(): string[] {
  const out: string[] = [T.text("test:")];
  for (const m of MODULES) {
    if (!libPresent(m.name)) { out.push("  " + T.dim("○ " + m.name + " — not installed")); continue; }
    out.push("  " + T.green("✓ ") + T.text(m.name) + T.dim("  library loads"));
    for (const e of m.extensions) {
      if (!extPresent(m.name, e.name)) continue;
      const miss = extMissing(e);
      out.push("    " + (miss.length === 0 ? T.green("✓ " + e.name + " — ready") : T.yellow("! " + e.name + " — missing: " + miss.join(", "))));
    }
  }
  return out;
}

function runSetup(e: Extension): void {
  if (e.setup && process.platform === "win32") {
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO, ...e.setup.split("/"))], { stdio: "inherit" });
  } else {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    spawnSync(npm, ["install", "--save-optional", ...e.npm], { stdio: "inherit", cwd: REPO });
    if (e.tools.length) console.log("\nAlso install and PATH these: " + e.tools.join(", "));
  }
}

// --- the app ------------------------------------------------------------------
export function modulesCommand(): Promise<void> {
  const stdin = process.stdin;
  const out = (s: string): void => { process.stdout.write(s); };

  // Non-interactive (piped/redirected) — just draw once and leave.
  if (!stdin.isTTY || !stdin.setRawMode) {
    console.log(renderScreen({ input: "", message: [], pendingUninstall: null }).replace(CLEAR, ""));
    console.log("\n" + T.dim("(run this in a real terminal for the interactive UI)"));
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const state: State = { input: "", message: [], pendingUninstall: null };
    let active = true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    out(ALT_ON + HIDE);
    const draw = (): void => { if (active) out(renderScreen(state)); };

    const leave = (): void => {
      if (!active) return;
      active = false;
      stdin.off("data", onData);
      stdin.setRawMode!(false);
      stdin.pause();
      out(SHOW + ALT_OFF);
      resolve();
    };

    // Run an installer outside the alt-screen, then come back.
    const installAndReturn = (e: Extension): void => {
      stdin.setRawMode!(false);
      out(SHOW + ALT_OFF);
      console.log("\n  Setting up " + e.name + "…\n");
      try { runSetup(e); } catch { /* shown via stdio */ }
      toolCache.clear();
      out(ALT_ON + HIDE);
      stdin.setRawMode!(true);
      state.message = [T.green("✓ done setting up " + e.name + ".")];
      draw();
    };

    const run = (line: string): void => {
      const parts = line.trim().split(/\s+/);
      const verb = (parts[0] || "").toLowerCase();
      const arg = parts.slice(1).join(" ");

      if (state.pendingUninstall) {
        const target = state.pendingUninstall;
        state.pendingUninstall = null;
        if (verb === "yes" || verb === "y") {
          try {
            const f = findExtension(target);
            if (f) { rmSync(extPath(f.mod.name, f.ext.name), { recursive: true, force: true }); state.message = [T.green("✓ removed " + target + ".")]; }
            else if (libPresent(target)) { rmSync(libPath(target), { recursive: true, force: true }); const ex = join(REPO, "extensions", target); if (existsSync(ex)) rmSync(ex, { recursive: true, force: true }); state.message = [T.green("✓ removed " + target + ".")]; }
            else state.message = [T.yellow("nothing called '" + target + "'.")];
          } catch (e) { state.message = [T.red("couldn't remove: " + (e instanceof Error ? e.message : String(e)))]; }
        } else state.message = [T.dim("uninstall cancelled.")];
        return;
      }

      if (verb === "" ) { state.message = []; return; }
      if (verb === "quit" || verb === "exit" || verb === "q") { leave(); return; }
      if (verb === "test") { state.message = testReport(); return; }
      if (verb === "browse" || verb === "list" || verb === "store") { state.message = browseReport(); return; }
      if (verb === "help") {
        state.message = [
          T.text("commands:"),
          "  " + T.blue("browse") + T.dim("            see every library you can install"),
          "  " + T.blue("install <name>") + T.dim("    set it up — installs its extra tools/packages (e.g. install music)"),
          "  " + T.blue("uninstall <name>") + T.dim("  remove a library/extension"),
          "  " + T.blue("test") + T.dim("              check what's installed and that it loads"),
          "  " + T.blue("quit") + T.dim("              leave  (or Esc / Ctrl+C)"),
        ];
        return;
      }
      if (verb === "install" || verb === "add") {
        const f = findExtension(arg);
        if (!f) { state.message = [T.red("nothing to install called '" + arg + "'.") + T.dim("  try: install music")]; return; }
        if (extMissing(f.ext).length === 0) { state.message = [T.green(f.ext.name + " is already set up. 🌱")]; return; }
        installAndReturn(f.ext);
        return;
      }
      if (verb === "uninstall" || verb === "remove") {
        const f = findExtension(arg);
        const name = f ? f.ext.name : arg.trim();
        if (!f && !libPresent(name)) { state.message = [T.red("nothing called '" + arg + "'.")]; return; }
        state.pendingUninstall = name;
        state.message = [T.yellow("remove " + name + "?") + T.dim("  type ") + T.text("yes") + T.dim(" to confirm, anything else to cancel")];
        return;
      }
      state.message = [T.red("unknown command: " + verb) + T.dim("   type ") + T.blue("help")];
    };

    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === "\x03" || ch === "\x1b") { leave(); return; }   // Ctrl+C / Esc
        if (ch === "\r" || ch === "\n") { const line = state.input; state.input = ""; run(line); draw(); if (!active) return; }
        else if (ch === "\x7f" || ch === "\b") { state.input = state.input.slice(0, -1); draw(); }
        else if (ch >= " ") { state.input += ch; draw(); }
      }
    };

    stdin.on("data", onData);
    draw();
  });
}
