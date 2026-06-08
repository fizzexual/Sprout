// libraries/automations/index.ts — make Sprout do things on a schedule.
//
//   use "automations"
//   make count = 0
//   task tick():
//       set count = count + 1
//       show "tick", count
//       when count >= 5:
//           stop()
//   every(1, "tick")          ~ run tick once a second, until it stops itself
//
// every / after / at / watch REGISTER a job while the program runs; once the
// program finishes, the library's start() turns the jobs on and keeps Sprout
// alive (just like a bot's listen loop). wait / now / today are instant helpers.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { watch as fsWatch } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

// Where Windows lists programs to run at every login (no admin needed — it's
// the per-user key, so a program registers ITSELF without elevation).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// Strip "name.exe" -> "name.exe", "chrome" -> "chrome.exe" (Windows image name).
function imageName(name: string): string {
  return /\.exe$/i.test(name) ? name : name + ".exe";
}

type Job =
  | { kind: "every"; seconds: number; task: string }
  | { kind: "after"; seconds: number; task: string }
  | { kind: "at"; hh: number; mm: number; task: string }
  | { kind: "watch"; file: string; task: string };

function two(n: number): string { return (n < 10 ? "0" : "") + n; }

export function create(interp: Interpreter) {
  const jobs: Job[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let stopped = false;

  const run = (task: string): void => {
    if (stopped) return;
    try { interp.runTask(task); }
    catch (e) { console.error("🕒 automation '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
  };

  function needSeconds(v: Value | undefined, site: Site): number {
    const n = Number(stringify(v ?? NONE));
    if (!Number.isFinite(n) || n <= 0) throw new LangError("Runtime", "this automation needs a positive number of seconds.", site?.line ?? 1, site?.col ?? 1, 'Try: every(5, "tick")');
    return n;
  }
  function needTask(v: Value | undefined, site: Site): string {
    const name = stringify(v ?? NONE);
    if (!name) throw new LangError("Runtime", "this automation needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: every(5, "tick")');
    return name;
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Pause the program for a while (seconds; fractions are fine, e.g. wait(0.5)).
    wait: (args) => {
      const secs = Number(stringify(args[0] ?? NONE));
      const ms = Math.max(0, Math.round((Number.isFinite(secs) ? secs : 0) * 1000));
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return NONE;
    },

    // The time right now as text, e.g. "14:30:05".
    now: () => { const d = new Date(); return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()); },

    // Today's date as text, e.g. "2026-06-08".
    today: () => { const d = new Date(); return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); },

    // Run a task again and again, every N seconds.
    every: (args, site) => { jobs.push({ kind: "every", seconds: needSeconds(args[0], site), task: needTask(args[1], site) }); return NONE; },

    // Run a task once, after N seconds.
    after: (args, site) => { jobs.push({ kind: "after", seconds: needSeconds(args[0], site), task: needTask(args[1], site) }); return NONE; },

    // Run a task every day at a clock time like "08:00".
    at: (args, site) => {
      const t = stringify(args[0] ?? NONE).trim();
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new LangError("Runtime", 'at needs a time like "14:30".', site?.line ?? 1, site?.col ?? 1, 'Try: at("08:00", "wakeup")');
      jobs.push({ kind: "at", hh: Number(m[1]), mm: Number(m[2]), task: needTask(args[1], site) });
      return NONE;
    },

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

    // --- apps & the PC ---

    // Start a program, app, file, or website in the background (it keeps running on its own).
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

    // Close a running program/app. -> yes / no (whether one was closed)
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

    // Make a command run automatically every time this PC starts (Windows, no admin).
    start_with_pc: (args, site) => {
      if (process.platform !== "win32") throw new LangError("Runtime", "start_with_pc works on Windows.", site?.line ?? 1, site?.col ?? 1, "On macOS/Linux, add a startup item yourself for now.");
      const name = stringify(args[0] ?? NONE).trim();
      const cmd = stringify(args[1] ?? NONE).trim();
      if (!name || !cmd) throw new LangError("Runtime", "start_with_pc needs a name and a command.", site?.line ?? 1, site?.col ?? 1, 'Try: start_with_pc("MyApp", "notepad")');
      const r = spawnSync("reg", ["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", cmd, "/f"], { encoding: "utf8", timeout: 8000 });
      if (r.status !== 0) throw new LangError("Runtime", "couldn't set up startup: " + ((r.stderr || "").trim() || "registry error"), site?.line ?? 1, site?.col ?? 1);
      return NONE;
    },

    // Stop a program from starting with the PC (undo start_with_pc).
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

  function scheduleAt(hh: number, mm: number, fire: () => void): void {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    timers.push(setTimeout(() => { fire(); timers.push(setInterval(fire, 24 * 60 * 60 * 1000)); }, next.getTime() - now.getTime()));
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
        timers.push(setInterval(() => run(job.task), Math.max(1, job.seconds) * 1000));
        summary.push("every " + job.seconds + "s → " + job.task);
      } else if (job.kind === "after") {
        timers.push(setTimeout(() => run(job.task), Math.max(0, job.seconds) * 1000));
        summary.push("after " + job.seconds + "s → " + job.task);
      } else if (job.kind === "at") {
        scheduleAt(job.hh, job.mm, () => run(job.task));
        summary.push("at " + two(job.hh) + ":" + two(job.mm) + " → " + job.task);
      } else if (job.kind === "watch") {
        startWatch(resolve(interp.programDir, job.file), () => run(job.task));
        summary.push("watch " + job.file + " → " + job.task);
      }
    }
    console.log("🕒 Automations running:");
    for (const s of summary) console.log("   " + s);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: ["wait", "now", "today", "every", "after", "at", "watch", "stop", "launch", "running", "closeapp", "start_with_pc", "stop_with_pc", "starts_with_pc"],
    builtins,
    isActive: () => jobs.length > 0,
    start,
  };
}
