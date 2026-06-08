// libraries/automations/index.ts — make Sprout do things on a schedule.
//
//   use "automations"
//   make count = 0
//   task tick():
//       set count = count + 1
//       show "tick", count, "at", now()
//   every("2 seconds", "tick")     ~ times can be a number OR friendly text
//   after("1 minute", "stop_all")
//   task stop_all():
//       stop()
//
// every / after / at / watch REGISTER a job while the program runs; once the
// program finishes, the library's start() turns the jobs on and keeps Sprout
// alive (like a bot's listen loop). run_on_startup() links THIS project's main
// file to Windows startup. wait / now / today / weekday are instant helpers.

import { NONE, stringify, isTruthy } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { watch as fsWatch } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

type Site = { line: number; col: number } | undefined;

// Where Windows lists programs to run at every login (per-user key = no admin).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
// Absolute path to Sprout's CLI, so a startup entry needs nothing on the PATH.
const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

function two(n: number): string { return (n < 10 ? "0" : "") + n; }
function imageName(name: string): string { return /\.exe$/i.test(name) ? name : name + ".exe"; }

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

// Parse an `at` time: "14:30", "8:30pm", "Monday 09:00", "fri 5:00 pm".
function parseAt(raw: string, site: Site): { hh: number; mm: number; dow: number | null } {
  let tokens = raw.trim().toLowerCase().split(/\s+/);
  let dow: number | null = null;
  if (tokens.length > 1 && DOW[tokens[0]] !== undefined) { dow = DOW[tokens[0]]; tokens = tokens.slice(1); }
  const m = tokens.join("").match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (!m) throw new LangError("Runtime", 'at needs a time like "14:30", "8:30pm", or "Monday 09:00".', site?.line ?? 1, site?.col ?? 1, 'Try: at("08:00", "wakeup")');
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (m[3] === "pm" && hh < 12) hh += 12;
  if (m[3] === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) throw new LangError("Runtime", "that's not a real time of day.", site?.line ?? 1, site?.col ?? 1, 'Hours are 0-23 (or 1-12 with am/pm).');
  return { hh, mm, dow };
}

type Job =
  | { kind: "every"; seconds: number; task: string; times: number | null }
  | { kind: "after"; seconds: number; task: string }
  | { kind: "at"; hh: number; mm: number; dow: number | null; task: string }
  | { kind: "watch"; file: string; task: string };

export function create(interp: Interpreter) {
  const jobs: Job[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let stopped = false;

  const run = (task: string): void => {
    if (stopped) return;
    try { interp.runTask(task); }
    catch (e) { console.error("🕒 automation '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
  };

  function needTask(v: Value | undefined, site: Site): string {
    const name = stringify(v ?? NONE);
    if (!name) throw new LangError("Runtime", "this automation needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: every(5, "tick")');
    return name;
  }
  function needSeconds(v: Value | undefined, site: Site): number {
    const n = parseDuration(v, site);
    if (n <= 0) throw new LangError("Runtime", "this automation needs a time greater than zero.", site?.line ?? 1, site?.col ?? 1, 'Try: every(5, "tick")  or  every("10 minutes", "tick")');
    return n;
  }

  // --- run THIS project's main file on startup ---
  function startupName(): string { return "Sprout - " + basename(interp.programFile).replace(/\.sprout$/i, ""); }
  function startupCommand(): string { return '"' + process.execPath + '" "' + CLI_PATH + '" run "' + interp.programFile + '"'; }
  function ensureWindowsProject(site: Site): void {
    if (process.platform !== "win32") throw new LangError("Runtime", "run_on_startup works on Windows.", site?.line ?? 1, site?.col ?? 1, "On macOS/Linux, add a startup item yourself for now.");
    if (!interp.programFile) throw new LangError("Runtime", "I can't tell which file is this project's main file.", site?.line ?? 1, site?.col ?? 1, "Run it with:  sprout run yourmain.sprout");
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Pause the program. Number = seconds, or friendly text: wait("0.5"), wait("2 minutes").
    wait: (args, site) => {
      const ms = Math.max(0, Math.round(parseDuration(args[0] ?? 0, site) * 1000));
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return NONE;
    },

    // The time right now. now() -> "14:30:05" ; now("12h") -> "2:30 PM".
    now: (args) => {
      const d = new Date();
      if (stringify(args[0] ?? NONE).toLowerCase().includes("12")) {
        let h = d.getHours();
        const ap = h < 12 ? "AM" : "PM";
        h = h % 12; if (h === 0) h = 12;
        return h + ":" + two(d.getMinutes()) + " " + ap;
      }
      return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
    },

    // Today's date, e.g. "2026-06-08".
    today: () => { const d = new Date(); return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); },

    // The day of the week, e.g. "Monday".
    weekday: () => DAY_NAMES[new Date().getDay()],

    // Run a task again and again. every(5, "tick") or every("10 minutes", "tick").
    // An optional 3rd value limits how many times: every(5, "tick", 3).
    every: (args, site) => {
      const times = args[2] != null ? Math.max(1, Math.round(Number(stringify(args[2])))) : null;
      jobs.push({ kind: "every", seconds: needSeconds(args[0], site), task: needTask(args[1], site), times: Number.isFinite(times as number) ? times : null });
      return NONE;
    },

    // Run a task once, after a delay. after(30, "go") or after("1 hour", "go").
    after: (args, site) => { jobs.push({ kind: "after", seconds: needSeconds(args[0], site), task: needTask(args[1], site) }); return NONE; },

    // Run a task at a clock time — daily, or weekly with a day name.
    // at("08:00", "t"), at("8:30pm", "t"), at("Monday 09:00", "t").
    at: (args, site) => { const t = parseAt(stringify(args[0] ?? NONE), site); jobs.push({ kind: "at", hh: t.hh, mm: t.mm, dow: t.dow, task: needTask(args[1], site) }); return NONE; },

    // Run a task whenever a file changes on disk.
    watch: (args, site) => { jobs.push({ kind: "watch", file: stringify(args[0] ?? NONE), task: needTask(args[1], site) }); return NONE; },

    // Stop all automations and let the program end.
    stop: () => {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      setTimeout(() => process.exit(0), 50);
      return NONE;
    },

    // --- run THIS Sprout project on PC startup (Windows, no admin) ---
    // run_on_startup()      -> this program runs every time you log in
    // run_on_startup(no)    -> stop it running at startup
    run_on_startup: (args, site) => {
      ensureWindowsProject(site);
      const on = args.length === 0 ? true : isTruthy(args[0]);
      if (on) {
        const r = spawnSync("reg", ["add", RUN_KEY, "/v", startupName(), "/t", "REG_SZ", "/d", startupCommand(), "/f"], { encoding: "utf8", timeout: 8000 });
        if (r.status !== 0) throw new LangError("Runtime", "couldn't set up startup: " + ((r.stderr || "").trim() || "registry error"), site?.line ?? 1, site?.col ?? 1);
      } else {
        spawnSync("reg", ["delete", RUN_KEY, "/v", startupName(), "/f"], { encoding: "utf8", timeout: 8000 });
      }
      return NONE;
    },

    // Is this project set to run on startup? -> yes / no
    runs_on_startup: () => {
      if (process.platform !== "win32" || !interp.programFile) return false;
      const r = spawnSync("reg", ["query", RUN_KEY, "/v", startupName()], { encoding: "utf8", timeout: 8000 });
      return r.status === 0 && (r.stdout || "").includes(startupName());
    },

    // --- apps & the PC ---

    // Start a program, app, file, or website in the background.
    launch: (args, site) => {
      const cmd = stringify(args[0] ?? NONE).trim();
      if (!cmd) throw new LangError("Runtime", "launch needs something to start.", site?.line ?? 1, site?.col ?? 1, 'Try: launch("notepad")');
      try {
        const child = process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", cmd], { detached: true, stdio: "ignore", windowsHide: true })
          : spawn(cmd, { detached: true, stdio: "ignore", shell: true });
        child.unref();
      } catch (e) {
        throw new LangError("Runtime", "couldn't start '" + cmd + "': " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1);
      }
      return NONE;
    },

    // Is a program/app running right now? -> yes / no
    running: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) return false;
      if (process.platform === "win32") {
        const img = imageName(name);
        const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + img, "/NH"], { encoding: "utf8", timeout: 8000 });
        return (r.stdout || "").toLowerCase().includes(img.toLowerCase());
      }
      const r = spawnSync("pgrep", ["-f", name], { encoding: "utf8", timeout: 8000 });
      return (r.stdout || "").trim().length > 0;
    },

    // Close a running program/app. -> yes / no
    closeapp: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) return false;
      if (process.platform === "win32") {
        const r = spawnSync("taskkill", ["/IM", imageName(name), "/F"], { encoding: "utf8", timeout: 8000 });
        return r.status === 0;
      }
      const r = spawnSync("pkill", ["-f", name], { encoding: "utf8", timeout: 8000 });
      return r.status === 0;
    },

    // Make ANY command run every time this PC starts (Windows, no admin).
    start_with_pc: (args, site) => {
      if (process.platform !== "win32") throw new LangError("Runtime", "start_with_pc works on Windows.", site?.line ?? 1, site?.col ?? 1, "On macOS/Linux, add a startup item yourself for now.");
      const name = stringify(args[0] ?? NONE).trim();
      const cmd = stringify(args[1] ?? NONE).trim();
      if (!name || !cmd) throw new LangError("Runtime", "start_with_pc needs a name and a command.", site?.line ?? 1, site?.col ?? 1, 'Try: start_with_pc("MyApp", "notepad")');
      const r = spawnSync("reg", ["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", cmd, "/f"], { encoding: "utf8", timeout: 8000 });
      if (r.status !== 0) throw new LangError("Runtime", "couldn't set up startup: " + ((r.stderr || "").trim() || "registry error"), site?.line ?? 1, site?.col ?? 1);
      return NONE;
    },

    // Stop a command from starting with the PC (undo start_with_pc).
    stop_with_pc: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (process.platform === "win32" && name) spawnSync("reg", ["delete", RUN_KEY, "/v", name, "/f"], { encoding: "utf8", timeout: 8000 });
      return NONE;
    },

    // Is something set to start with the PC under this name? -> yes / no
    starts_with_pc: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (process.platform !== "win32" || !name) return false;
      const r = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8", timeout: 8000 });
      return r.status === 0 && (r.stdout || "").includes(name);
    },
  };

  function nextOccurrence(hh: number, mm: number, dow: number | null): number {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (dow === null) {
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    } else {
      let add = (dow - next.getDay() + 7) % 7;
      if (add === 0 && next.getTime() <= now.getTime()) add = 7;
      next.setDate(next.getDate() + add);
    }
    return next.getTime() - now.getTime();
  }

  function startWatch(path: string, fire: () => void): void {
    let busy = false;
    try {
      fsWatch(path, () => {
        if (busy) return;          // file changes often fire twice; debounce
        busy = true;
        setTimeout(() => { busy = false; fire(); }, 120);
      });
    } catch (e) {
      console.error("🕒 couldn't watch '" + path + "': " + (e instanceof Error ? e.message : String(e)));
    }
  }

  const start = (): void => {
    const summary: string[] = [];
    for (const job of jobs) {
      if (job.kind === "every") {
        let left = job.times;
        const id = setInterval(() => {
          run(job.task);
          if (left !== null) { left -= 1; if (left <= 0) clearInterval(id); }
        }, Math.max(0.1, job.seconds) * 1000);
        timers.push(id);
        summary.push("every " + job.seconds + "s -> " + job.task + (job.times !== null ? " (x" + job.times + ")" : ""));
      } else if (job.kind === "after") {
        timers.push(setTimeout(() => run(job.task), Math.max(0, job.seconds) * 1000));
        summary.push("after " + job.seconds + "s -> " + job.task);
      } else if (job.kind === "at") {
        const period = job.dow === null ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        timers.push(setTimeout(() => { run(job.task); timers.push(setInterval(() => run(job.task), period)); }, nextOccurrence(job.hh, job.mm, job.dow)));
        summary.push("at " + (job.dow !== null ? DAY_NAMES[job.dow] + " " : "") + two(job.hh) + ":" + two(job.mm) + " -> " + job.task);
      } else if (job.kind === "watch") {
        startWatch(resolve(interp.programDir, job.file), () => run(job.task));
        summary.push("watch " + job.file + " -> " + job.task);
      }
    }
    if (summary.length === 0) return;
    console.log("🕒 Automations running:");
    for (const s of summary) console.log("   " + s);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: ["wait", "now", "today", "weekday", "every", "after", "at", "watch", "stop", "run_on_startup", "runs_on_startup", "launch", "running", "closeapp", "start_with_pc", "stop_with_pc", "starts_with_pc"],
    builtins,
    isActive: () => jobs.length > 0,
    start,
  };
}
