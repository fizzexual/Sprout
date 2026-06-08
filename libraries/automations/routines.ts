// libraries/automations/routines.ts — one-word "modes" that compose everything.
//
//   use "automations/routines"
//   routine("study", "open_notes")     ~ give a name to one of YOUR tasks
//   run_routine("study")               ~ ...then run it by that friendly name
//
//   workmode()        ~ block distractions, open your work apps, mute -> focus!
//   workmode(no)      ~ undo: unblock those sites again
//   pomodoro()        ~ 25 min focus / 5 min break, on a loop (blocks during focus)
//   morning()         ~ open your apps + speak today's weather out loud
//   bedtime("30 min") ~ dim the screen, block distractions, schedule a shutdown
//
// This module is deliberately SELF-CONTAINED: it carries its own tiny copies of
// the hosts-block writer, the app launcher, and the speak helper, so it works on
// its own without leaning on the other library files. Sprout's interpreter is
// synchronous, so anything that waits (the weather fetch) runs in a short Node
// subprocess, and the timed loops (pomodoro) live in start() as real timers.

import { NONE, stringify, isTruthy } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

type Site = { line: number; col: number } | undefined;

// The default list of "distraction" sites a focus mode turns off. Friendly and short.
const DISTRACTIONS = [
  "youtube.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "netflix.com",
];

// The small set of apps a "work" / "morning" routine opens for you.
const WORK_APPS = ["code", "https://www.google.com"];
const MORNING_APPS = ["https://mail.google.com", "https://calendar.google.com"];

// Where the system keeps its hosts file (the place that maps names -> addresses).
const HOSTS = process.platform === "win32"
  ? (process.env.SystemRoot || "C:\\Windows") + "\\System32\\drivers\\etc\\hosts"
  : "/etc/hosts";
const TAG = "# sprout-block";                                  // our marker — we only ever touch tagged lines
const NL = process.platform === "win32" ? "\r\n" : "\n";

// ----------------------------------------------------------------------------
// Tiny self-contained helpers (duplicated on purpose so this file stands alone)
// ----------------------------------------------------------------------------

// Turn a number (seconds) or friendly text ("10 minutes", "2h", "1 day") into seconds.
function parseDuration(v: Value | undefined, site: Site): number {
  if (typeof v === "number") return v;
  const s = stringify(v ?? NONE).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) throw new LangError("Runtime", "I couldn't understand the time '" + s + "'.", site?.line ?? 1, site?.col ?? 1, 'Use seconds, or text like "10 minutes", "2 hours", "1 day".');
  const n = Number(m[1]);
  const u = (m[2] || "s")[0];
  const mult = u === "d" ? 86400 : u === "h" ? 3600 : u === "m" ? 60 : 1;
  return n * mult;
}

// A synchronous pause (used between hosts retries; the interpreter is synchronous anyway).
function sleepMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

// Pull a Node-style error code ("EBUSY", "EPERM"...) out of an unknown thrown thing.
function errCode(e: unknown): string {
  return (e && typeof e === "object" && "code" in e) ? String((e as { code: unknown }).code) : "";
}

// "https://www.Example.com/page" -> "example.com"
function cleanDomain(s: string): string {
  return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").trim().toLowerCase();
}

// Does this hosts line block this exact domain (apex or www)? (only our own tagged lines)
function lineBlocks(line: string, domain: string): boolean {
  return line.includes(TAG) && (line.includes(" " + domain + " ") || line.includes(" www." + domain + " "));
}

function readHosts(): string {
  try { return readFileSync(HOSTS, "utf8"); } catch { return ""; }
}

// Refresh the name cache so a just-blocked site stops loading immediately.
function flushDns(): void {
  try { if (process.platform === "win32") spawnSync("ipconfig", ["/flushdns"], { stdio: "ignore", timeout: 5000 }); } catch { /* best effort */ }
}

// The hosts file is often briefly LOCKED right after a change (antivirus scans it,
// the DNS service reloads it), so a plain overwrite can fail with EBUSY. We retry,
// and under a lock we delete + recreate the file to get a fresh, unlocked handle.
function writeHosts(text: string, site: Site): void {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      if (attempt > 0) { try { unlinkSync(HOSTS); } catch { /* may be missing or momentarily locked */ } }
      writeFileSync(HOSTS, text);
      flushDns();
      return;
    } catch (e) {
      lastErr = e;
      const code = errCode(e);
      // A real permission problem (not elevated) shows up on the very first try.
      if ((code === "EPERM" || code === "EACCES") && attempt === 0) throw adminError(site);
      sleepMs(Math.min(120 + attempt * 40, 500));   // EBUSY / locked: wait, then retry
    }
  }
  throw new LangError("Runtime", "the hosts file stayed locked by another program (" + (lastErr instanceof Error ? lastErr.message : String(lastErr)) + ").", site?.line ?? 1, site?.col ?? 1, "Pause real-time antivirus or close any hosts editor, then try again.");
}

// The friendly "you need admin" message — focus modes edit a protected system file.
function adminError(site: Site): LangError {
  return new LangError("Runtime", "Turning on a focus mode needs administrator rights.", site?.line ?? 1, site?.col ?? 1,
    process.platform === "win32"
      ? "Close this, right-click your terminal (or VS Code), choose 'Run as administrator', and run your program again."
      : "Run your program with sudo so it can edit the hosts file.");
}

// Block a whole list of domains in ONE write (kinder to the locked-file dance).
function blockList(domains: string[], site: Site): void {
  let kept = readHosts().split(/\r?\n/).filter((l) => !domains.some((d) => lineBlocks(l, d)));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  for (const d of domains) {
    kept.push("127.0.0.1 " + d + " " + TAG);
    kept.push("127.0.0.1 www." + d + " " + TAG);
  }
  writeHosts(kept.join(NL) + NL, site);
}

// Unblock a whole list of domains in one write (only removes our tagged lines).
function unblockList(domains: string[], site: Site): void {
  const kept = readHosts().split(/\r?\n/).filter((l) => !domains.some((d) => lineBlocks(l, d)));
  writeHosts(kept.join(NL), site);
}

// Start an app, file, or website in the background (best effort — never crashes the routine).
function launch(cmd: string): void {
  const what = cmd.trim();
  if (!what) return;
  try {
    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", what], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn(what, { detached: true, stdio: "ignore", shell: true });
    child.unref();
  } catch { /* best effort: keep the routine going even if one app won't open */ }
}

// Speak text out loud through Windows' built-in voice (same trick as system.ts:
// pipe the words into PowerShell's System.Speech on stdin so quotes are safe).
function speak(text: string): void {
  const words = text.trim();
  if (!words || process.platform !== "win32") return;
  const ps = "Add-Type -AssemblyName System.Speech;" +
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
    "$t=[Console]::In.ReadToEnd();$s.Speak($t);";
  try { spawnSync("powershell", ["-NoProfile", "-Command", ps], { input: words, encoding: "utf8", timeout: 15000 }); } catch { /* best effort */ }
}

// Mute the system volume (best effort: tap the mute key via PowerShell SendKeys).
function muteSound(): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("powershell", ["-NoProfile", "-Command",
      "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"], { encoding: "utf8", timeout: 6000 });
  } catch { /* best effort */ }
}

// Dim the screen as low as it will go (best effort via WMI; many desktops ignore this).
function dimScreen(): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("powershell", ["-NoProfile", "-Command",
      "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,15)"],
      { encoding: "utf8", timeout: 6000 });
  } catch { /* best effort: not every monitor supports software brightness */ }
}

// Run a tiny async Node script and return its stdout (friendly errors). Used for the weather.
function runNode(script: string, args: string[], site: Site): string {
  const res = spawnSync(process.execPath, ["-e", script, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 20000 });
  if (res.error) throw new LangError("Runtime", "Network problem: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Check your connection.");
  if (res.status !== 0) throw new LangError("Runtime", "Network problem: " + ((res.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Check the address.");
  return res.stdout ?? "";
}

// ----------------------------------------------------------------------------

export function register(interp: Interpreter) {
  // Your saved routines: a friendly name -> the Sprout task to run for it.
  const routines = new Map<string, string>();

  // Background work for pomodoro lives here. While this is non-empty, Sprout
  // stays alive after the program ends (like a bot's listen loop).
  const pomodoros: Array<{ focusSec: number; breakSec: number }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // --- naming & running your own routines -------------------------------

    // Give one of YOUR tasks a friendly routine name.  routine("study", "open_notes")
    routine: (args, site) => {
      const name = stringify(args[0] ?? NONE).trim().toLowerCase();
      const task = stringify(args[1] ?? NONE).trim();
      if (!name || !task) throw new LangError("Runtime", "routine needs a name and a task to run.", site?.line ?? 1, site?.col ?? 1, 'Try: routine("study", "open_notes")');
      routines.set(name, task);
      return NONE;
    },

    // Run a routine you saved earlier.  run_routine("study")
    run_routine: (args, site) => {
      const name = stringify(args[0] ?? NONE).trim().toLowerCase();
      const task = routines.get(name);
      if (!task) {
        const known = [...routines.keys()];
        throw new LangError("Runtime", "I don't know a routine called '" + name + "'.", site?.line ?? 1, site?.col ?? 1,
          known.length ? "You've saved: " + known.join(", ") + "." : 'Make one first: routine("study", "open_notes")');
      }
      try { interp.runTask(task); }
      catch (e) { console.error("🌱 routine '" + name + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
      return NONE;
    },

    // --- ready-made modes --------------------------------------------------

    // Focus! Block distractions + open your work apps + mute. workmode(no) undoes the block.
    workmode: (args, site) => {
      const on = args.length === 0 ? true : isTruthy(args[0]);
      if (on) {
        blockList(DISTRACTIONS, site);
        for (const app of WORK_APPS) launch(app);
        muteSound();
        console.log("💼 Work mode on — distractions blocked, your apps are opening.");
        speak("Work mode on. Time to focus.");
      } else {
        unblockList(DISTRACTIONS, site);
        console.log("💼 Work mode off — distractions unblocked. Nice work!");
        speak("Work mode off. Nice work.");
      }
      return NONE;
    },

    // A Pomodoro loop: focus then break, over and over. pomodoro() = 25 min / 5 min.
    // During focus we block distractions and say "Focus!"; on break we unblock and say "Break time".
    pomodoro: (args, site) => {
      const focusSec = args[0] != null ? parseDuration(args[0], site) : 25 * 60;
      const breakSec = args[1] != null ? parseDuration(args[1], site) : 5 * 60;
      if (focusSec <= 0 || breakSec <= 0) throw new LangError("Runtime", "a pomodoro needs focus and break times greater than zero.", site?.line ?? 1, site?.col ?? 1, 'Try: pomodoro("25 minutes", "5 minutes")');
      pomodoros.push({ focusSec, breakSec });
      console.log("🍅 Pomodoro armed: " + Math.round(focusSec / 60) + " min focus / " + Math.round(breakSec / 60) + " min break. (Ctrl+C to stop.)");
      return NONE;
    },

    // Good morning! Open your apps, then speak a one-line forecast out loud.
    // morning() uses your location; morning("Tokyo") forecasts that city.
    morning: (args, site) => {
      for (const app of MORNING_APPS) launch(app);
      console.log("🌅 Good morning! Opening your apps…");
      const city = stringify(args[0] ?? NONE).trim();
      // wttr.in/<city>?format=3 returns one tidy line; with no city it uses your IP.
      const url = "https://wttr.in/" + encodeURIComponent(city) + "?format=3";
      let line = "";
      try {
        line = runNode(
          "(async()=>{try{const r=await fetch(process.argv[1]);process.stdout.write((await r.text()).trim());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
          [url],
          site,
        ).trim();
      } catch {
        line = "";   // weather is a nicety — never let a network hiccup break the morning
      }
      if (line) { console.log("🌤️  " + line); speak("Good morning. " + line); }
      else { console.log("🌤️  (Couldn't fetch the weather right now.)"); speak("Good morning!"); }
      return NONE;
    },

    // Wind down: dim the screen, block distractions, and schedule a shutdown.
    // bedtime() shuts down in 30 minutes; bedtime("1 hour") gives you longer.
    bedtime: (args, site) => {
      const secs = Math.max(0, Math.round(parseDuration(args[0] ?? "30 minutes", site)));
      dimScreen();
      try { blockList(DISTRACTIONS, site); } catch (e) {
        // If we can't block (not admin), still let the rest of bedtime work.
        console.log("🌙 (Couldn't block distractions: " + (e instanceof LangError ? e.message : String(e)) + ")");
      }
      const mins = Math.round(secs / 60);
      if (process.platform === "win32") {
        spawnSync("shutdown", ["/a"], { encoding: "utf8", timeout: 6000 });        // cancel any pending shutdown first
        const r = spawnSync("shutdown", ["/s", "/t", String(secs)], { encoding: "utf8", timeout: 6000 });
        if (r.status !== 0) console.log("🌙 (Couldn't arm the shutdown: " + ((r.stderr || "").trim() || "try running as administrator") + ")");
      } else {
        console.log("🌙 (Automatic shutdown is a Windows feature — set one yourself tonight.)");
      }
      console.log("🌙 Bedtime: screen dimmed, distractions blocked, shutting down in about " + mins + " minute" + (mins === 1 ? "" : "s") + ".");
      speak("Bedtime. Shutting down in about " + mins + " minutes. Sleep well.");
      return NONE;
    },

    // Speak any text out loud (Windows voice).  say("Hello there!")
    say: (args) => {
      speak(stringify(args[0] ?? NONE));
      return NONE;
    },
  };

  // Turn one armed pomodoro into a real focus/break loop using timers.
  function startPomodoro(p: { focusSec: number; breakSec: number }): void {
    // Begin in a focus block right away.
    const enterFocus = (): void => {
      try { blockList(DISTRACTIONS, undefined); } catch { /* not admin: still announce */ }
      console.log("🍅 Focus! (" + Math.round(p.focusSec / 60) + " min)");
      speak("Focus!");
      timers.push(setTimeout(enterBreak, p.focusSec * 1000));
    };
    const enterBreak = (): void => {
      try { unblockList(DISTRACTIONS, undefined); } catch { /* best effort */ }
      console.log("☕ Break time! (" + Math.round(p.breakSec / 60) + " min)");
      speak("Break time.");
      timers.push(setTimeout(enterFocus, p.breakSec * 1000));
    };
    enterFocus();
  }

  // Called after the program finishes: wire up any background pomodoros.
  const start = (): void => {
    if (pomodoros.length === 0) return;
    for (const p of pomodoros) startPomodoro(p);
    console.log("🍅 Pomodoro running — press Ctrl+C to stop (it'll leave sites blocked, run workmode(no) to clear).");
  };

  return {
    names: ["routine", "run_routine", "workmode", "pomodoro", "morning", "bedtime", "say"],
    builtins,
    isActive: () => pomodoros.length > 0,   // pomodoro keeps Sprout alive; the other modes are one-shot
    start,
  };
}
