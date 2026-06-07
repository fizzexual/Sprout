// src/modules.ts — `sprout modules`: an interactive manager for Sprout's
// libraries ("modules") and their extensions. See what's installed, set one up
// (install its dependencies), uninstall, and test that it loads. Zero deps —
// just node:readline + ANSI colours, for a clean Claude-Code-style terminal.

import { createInterface } from "node:readline";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url))); // .../src/modules.ts -> repo root

// --- colours ---
const E = "\x1b[";
const bold = (s: string): string => `${E}1m${s}${E}0m`;
const dim = (s: string): string => `${E}2m${s}${E}0m`;
const green = (s: string): string => `${E}32m${s}${E}0m`;
const red = (s: string): string => `${E}31m${s}${E}0m`;
const yellow = (s: string): string => `${E}33m${s}${E}0m`;
const cyan = (s: string): string => `${E}36m${s}${E}0m`;

// --- the catalogue of modules ---
interface Extension {
  name: string;
  description: string;
  npm: string[];        // node packages it needs
  tools: string[];      // system programs it needs
  setup?: string;       // a PowerShell script that installs everything (Windows)
}
interface Module {
  name: string;
  description: string;
  extensions: Extension[];
}

const MODULES: Module[] = [
  {
    name: "discord-bot",
    description: "Make a Discord bot — chat + slash commands",
    extensions: [
      {
        name: "music",
        description: "Play YouTube audio in a voice channel",
        npm: ["@discordjs/voice", "@snazzah/davey", "libsodium-wrappers", "prism-media"],
        tools: ["ffmpeg", "yt-dlp"],
        setup: "tools/install-music.ps1",
      },
    ],
  },
];

// --- status checks ---
const libPath = (name: string): string => join(REPO, "libraries", name);
const extPath = (lib: string, ext: string): string => join(REPO, "extensions", lib, ext);
const libPresent = (name: string): boolean => existsSync(join(libPath(name), "index.ts"));
const extPresent = (lib: string, ext: string): boolean => existsSync(join(extPath(lib, ext), "index.ts"));
const npmInstalled = (pkg: string): boolean => existsSync(join(REPO, "node_modules", ...pkg.split("/")));

const toolCache = new Map<string, boolean>();
function toolPresent(tool: string): boolean {
  if (toolCache.has(tool)) return toolCache.get(tool)!;
  let ok = false;
  // No shell: on Windows CreateProcess finds tool.exe; avoids a deprecation warning.
  try { const r = spawnSync(tool, ["--version"], { stdio: "ignore", timeout: 8000 }); ok = !r.error && r.status === 0; }
  catch { ok = false; }
  toolCache.set(tool, ok);
  return ok;
}
function extMissing(e: Extension): string[] {
  const miss: string[] = [];
  for (const p of e.npm) if (!npmInstalled(p)) miss.push(p);
  for (const t of e.tools) if (!toolPresent(t)) miss.push(t);
  return miss;
}
const extReady = (e: Extension): boolean => extMissing(e).length === 0;

// --- rendering ---
function renderStatus(): void {
  console.clear();
  console.log("");
  console.log("  " + bold(cyan("🌱  Sprout Modules")) + "  " + dim("manage your libraries"));
  console.log("  " + dim("─".repeat(58)));
  console.log("");
  for (const m of MODULES) {
    const here = libPresent(m.name);
    console.log("  " + (here ? green("●") : dim("○")) + " " + bold(m.name) + "   " + dim(m.description));
    console.log("      " + dim("library — ") + (here ? green("installed") : dim("not installed")));
    for (const e of m.extensions) {
      if (!extPresent(m.name, e.name)) { console.log("      " + dim("└ " + m.name + "/" + e.name + " — not installed")); continue; }
      if (extReady(e)) {
        console.log("      " + green("✓") + " " + bold(m.name + "/" + e.name) + "   " + dim(e.description));
        console.log("          " + green("ready"));
      } else {
        console.log("      " + yellow("!") + " " + bold(m.name + "/" + e.name) + "   " + dim(e.description));
        console.log("          " + yellow("needs setup — missing: " + extMissing(e).join(", ")));
      }
    }
    console.log("");
  }
  console.log("  " + dim("─".repeat(58)));
  console.log("  " + bold("1") + " install / set up    " + bold("2") + " uninstall    " + bold("3") + " test    " + bold("4") + " quit");
  console.log("");
}

// --- actions ---
function runSetup(e: Extension): void {
  toolCache.clear();
  if (e.setup && process.platform === "win32") {
    const script = join(REPO, ...e.setup.split("/"));
    console.log("\n  " + cyan("Running " + e.setup + " …") + "\n");
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: "inherit" });
  } else {
    console.log("\n  Installing packages: " + e.npm.join(", ") + "\n");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    spawnSync(npmCmd, ["install", "--save-optional", ...e.npm], { stdio: "inherit", cwd: REPO });
    if (e.tools.length) console.log("\n  " + yellow("Also install these yourself and put them on PATH: " + e.tools.join(", ")));
  }
  console.log("\n  " + green("Done setting up " + e.name + "."));
}

type Ask = (q: string) => Promise<string>;

async function doInstall(ask: Ask): Promise<void> {
  const items: Array<{ label: string; run: () => void }> = [];
  for (const m of MODULES) {
    if (!libPresent(m.name)) {
      items.push({
        label: m.name + dim("  — not in this Sprout"),
        run: () => {
          console.log("\n  " + yellow(m.name + " isn't installed here."));
          console.log("  " + dim("Add it by re-running SproutSetup.exe and ticking it, or copy its"));
          console.log("  " + dim("folder into libraries/ from the repo."));
        },
      });
    }
    for (const e of m.extensions) {
      if (extPresent(m.name, e.name) && !extReady(e)) {
        items.push({ label: m.name + "/" + e.name + dim("  — install " + extMissing(e).join(", ")), run: () => runSetup(e) });
      }
    }
  }
  console.log("");
  if (items.length === 0) { console.log("  " + green("Everything is already set up. 🌱")); await ask(dim("\n  press Enter ")); return; }
  console.log("  " + bold("Install / set up which?"));
  items.forEach((it, i) => console.log("    " + bold(String(i + 1)) + "  " + it.label));
  console.log("    " + bold("0") + "  back");
  const idx = parseInt((await ask("\n  " + cyan("❯") + " ")).trim(), 10);
  if (idx >= 1 && idx <= items.length) {
    items[idx - 1].run();
    await ask(dim("\n  press Enter to continue "));
  }
}

async function doUninstall(ask: Ask): Promise<void> {
  const items: Array<{ label: string; lib: string; ext?: string }> = [];
  for (const m of MODULES) {
    for (const e of m.extensions) if (extPresent(m.name, e.name)) items.push({ label: m.name + "/" + e.name + dim("  (extension)"), lib: m.name, ext: e.name });
    if (libPresent(m.name)) items.push({ label: m.name + dim("  (library + its extensions)"), lib: m.name });
  }
  console.log("");
  if (items.length === 0) { console.log("  Nothing installed to remove."); await ask(dim("\n  press Enter ")); return; }
  console.log("  " + bold("Uninstall which?"));
  items.forEach((it, i) => console.log("    " + bold(String(i + 1)) + "  " + it.label));
  console.log("    " + bold("0") + "  back");
  const idx = parseInt((await ask("\n  " + cyan("❯") + " ")).trim(), 10);
  if (idx < 1 || idx > items.length) return;
  const it = items[idx - 1];
  const what = it.ext ? it.lib + "/" + it.ext : it.lib;

  if (existsSync(join(REPO, ".git"))) {
    console.log("\n  " + yellow("⚠  This is the Sprout source repo — removing this deletes its source files."));
  }
  const sure = (await ask("\n  Delete " + bold(what) + "? " + dim("(y/N) "))).trim().toLowerCase();
  if (sure !== "y" && sure !== "yes") { console.log("  " + dim("Cancelled.")); await ask(dim("\n  press Enter ")); return; }
  try {
    rmSync(it.ext ? extPath(it.lib, it.ext) : libPath(it.lib), { recursive: true, force: true });
    if (!it.ext) { const e = join(REPO, "extensions", it.lib); if (existsSync(e)) rmSync(e, { recursive: true, force: true }); }
    console.log("  " + green("Removed " + what + ".") + dim("  (any installed packages stay — they're shared)"));
  } catch (err) {
    console.log("  " + red("Couldn't remove it: " + (err instanceof Error ? err.message : String(err))));
  }
  await ask(dim("\n  press Enter to continue "));
}

async function doTest(ask: Ask): Promise<void> {
  console.log("\n  " + bold("Testing installed modules…") + "\n");
  for (const m of MODULES) {
    if (!libPresent(m.name)) { console.log("  " + dim("○ " + m.name + " — not installed")); continue; }
    let ok = false;
    let err = "";
    try {
      const mod = await import(pathToFileURL(join(libPath(m.name), "index.ts")).href);
      ok = typeof (mod as { create?: unknown }).create === "function";
      if (!ok) err = "no create() export";
    } catch (e) { err = e instanceof Error ? e.message : String(e); }
    console.log("  " + (ok ? green("✓") : red("✗")) + " " + bold(m.name) + (ok ? green("  loads OK") : red("  " + err)));
    for (const e of m.extensions) {
      if (!extPresent(m.name, e.name)) { console.log("      " + dim("○ " + e.name + " — not installed")); continue; }
      const miss = extMissing(e);
      if (miss.length === 0) console.log("      " + green("✓ " + e.name + " — ready"));
      else console.log("      " + yellow("! " + e.name + " — missing: " + miss.join(", ")));
    }
  }
  await ask(dim("\n  press Enter to continue "));
}

export async function modulesCommand(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Treat end-of-input (Ctrl+D / piped EOF) as "quit", so a pending prompt always settles.
  let closed = false;
  let pending: ((s: string) => void) | null = null;
  rl.on("close", () => { closed = true; if (pending) { const p = pending; pending = null; p("4"); } });
  const ask: Ask = (q) => new Promise((res) => {
    if (closed) { res("4"); return; }
    pending = res;
    rl.question(q, (a) => { pending = null; res(a); });
  });
  try {
    let running = true;
    while (running) {
      renderStatus();
      const choice = (await ask("  " + cyan("❯") + " ")).trim().toLowerCase();
      if (choice === "1") await doInstall(ask);
      else if (choice === "2") await doUninstall(ask);
      else if (choice === "3") await doTest(ask);
      else if (choice === "4" || choice === "q" || choice === "quit" || choice === "exit") running = false;
    }
  } finally {
    rl.close();
  }
  console.log("  " + green("Bye 🌱"));
}
