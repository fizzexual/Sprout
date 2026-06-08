// libraries/automations/reminders.ts — reminders, timers & little life triggers.
//
//   use "automations"
//   remind("in 10 minutes", "Stretch your legs!")   ~ a toast pops up in 10 min
//   remind("at 8:30pm", "Dinner time")              ~ a toast at a clock time
//   timer("5 minutes", "Tea is ready!")             ~ a beep + toast when done
//   stopwatch()                                     ~ start counting
//   show elapsed()                                  ~ "3m 12s" since you started
//   on_lock("pause_music")                          ~ run a task when you lock the PC
//   on_unlock("welcome_back")                       ~ ...and when you come back
//   on_clipboard("save_it")                         ~ run a task when you copy something
//   on_low_disk("C:", "5 GB", "warn")               ~ run a task when a drive gets low
//
// Most of these are BACKGROUND watchers: they register a "job" while the program
// runs and return nothing. When the program finishes, start() turns the watchers
// on — each kind gets one polling loop that reads the world and fires on the
// EDGE (the change), running your task or popping a toast. State lives in
// closures, so nothing leaks between watchers.
//
// remind / timer / stopwatch / elapsed work anywhere; the on_* watchers and the
// toast pop-ups read Windows-only signals, so those need Windows.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { showToast } from "./_notify.ts";

type Site = { line: number; col: number } | undefined;

// ---------------------------------------------------------------------------
// Shared little helpers (kept self-contained — duplicated rather than imported).
// ---------------------------------------------------------------------------

// Turn a number (seconds) or friendly text ("10 minutes", "2h", "30s", "1 day")
// into a plain number of SECONDS. Throws a friendly error on anything else.
function parseDuration(v: Value | undefined, site: Site): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new LangError("Runtime", "that time needs to be zero or more.", site?.line ?? 1, site?.col ?? 1, 'Try a number of seconds, or text like "10 minutes".');
    return v;
  }
  const s = stringify(v ?? NONE).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) throw new LangError("Runtime", "I couldn't understand the time '" + s + "'.", site?.line ?? 1, site?.col ?? 1, 'Use seconds, or text like "10 minutes", "2 hours", "1 day", "30s".');
  const n = Number(m[1]);
  const u = (m[2] || "s")[0];
  const mult = u === "d" ? 86400 : u === "h" ? 3600 : u === "m" ? 60 : 1;
  return n * mult;
}

// Turn a clock time ("8:30", "08:30", "8:30pm", "8 pm") into { hh, mm } on a
// 24-hour clock. Throws a friendly error if it doesn't look like a time.
function parseAt(v: Value | undefined, site: Site): { hh: number; mm: number } {
  const raw = stringify(v ?? NONE).trim().toLowerCase().replace(/\s+/g, "");
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) throw new LangError("Runtime", "I couldn't understand the time '" + stringify(v ?? NONE).trim() + "'.", site?.line ?? 1, site?.col ?? 1, 'Use a clock time like "8:30", "08:00", or "8:30pm".');
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (ap === "pm" && hh < 12) hh += 12;       // 1pm -> 13, but 12pm stays 12 (noon)
  if (ap === "am" && hh === 12) hh = 0;       // 12am -> 0 (midnight)
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new LangError("Runtime", "that's not a real clock time.", site?.line ?? 1, site?.col ?? 1, 'Hours are 0–23 (or use am/pm), minutes 0–59.');
  return { hh, mm };
}

// Parse a size like "5 GB", "500 MB", "200kb", or a plain number of bytes.
function parseSize(v: Value | undefined, site: Site): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new LangError("Runtime", "that size needs to be zero or more.", site?.line ?? 1, site?.col ?? 1, 'Try text like "5 GB" or "500 MB".');
    return v;
  }
  const s = stringify(v ?? NONE).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g|tb|t)?$/);
  if (!m) throw new LangError("Runtime", "I couldn't understand the size '" + s + "'.", site?.line ?? 1, site?.col ?? 1, 'Use text like "5 GB", "500 MB", or a number of bytes.');
  const n = Number(m[1]);
  const u = m[2] || "b";
  const mult = u.startsWith("t") ? 1024 ** 4 : u.startsWith("g") ? 1024 ** 3 : u.startsWith("m") ? 1024 ** 2 : (u === "kb" || u === "k") ? 1024 : 1;
  return n * mult;
}

export function register(interp: Interpreter) {
  // Everything below needs Windows. One friendly gate for the lot.
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") {
      throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "This uses Windows-only features.");
    }
  }

  function needTask(v: Value | undefined, site: Site): string {
    const name = stringify(v ?? NONE).trim();
    if (!name) throw new LangError("Runtime", "this watcher needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: on_lock("pause_music")');
    return name;
  }

  // -------------------------------------------------------------------------
  // toast(title, msg) — pop a native Windows notification with ZERO modules.
  //
  // We load the three WinRT "accelerator" assemblies by name, pull the built-in
  // ToastGeneric template, fill in the two text lines, and show it under a
  // friendly AppId. The title/message are passed as ENVIRONMENT VARIABLES so
  // quotes, newlines or emoji in them can never break the PowerShell command.
  // -------------------------------------------------------------------------
  function toast(title: string, msg: string): void {
    // The toast's app name + icon come from notify.bloom next to the program
    // (defaults to "Sprout" + the leaf icon) — shared with notify(); see _notify.ts.
    showToast(interp.programDir, title, msg);
  }

  // -------------------------------------------------------------------------
  // Background bookkeeping. Reminders & timers live as one-shot setTimeouts;
  // the on_* watchers live as polling setIntervals. We keep them all in `timers`
  // so isActive() can report whether anything is still pending.
  // -------------------------------------------------------------------------
  type Job =
    | { kind: "lock"; task: string }
    | { kind: "unlock"; task: string }
    | { kind: "clipboard"; task: string }
    | { kind: "low_disk"; drive: string; bytes: number; task: string };

  const jobs: Job[] = [];                                   // the polling watchers
  const timers: Array<ReturnType<typeof setTimeout>> = [];  // every live timer/interval

  // Run one of the program's tasks, turning any error into a friendly note so a
  // single bad run doesn't kill the whole watcher loop.
  const run = (task: string): void => {
    try { interp.runTask(task); }
    catch (e) { console.error("⏰ watcher '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
  };

  // A short beep through the PC speaker (used by timer()).
  function beep(): void {
    if (process.platform !== "win32") return;
    spawnSync("powershell", ["-NoProfile", "-Command", "[console]::beep(880,500)"], { encoding: "utf8", timeout: 4000 });
  }

  // -------------------------------------------------------------------------
  // State readers — tiny spawnSync calls reporting the CURRENT state. Each is
  // wrapped so a transient failure just returns a safe value, never throwing
  // inside a timer.
  // -------------------------------------------------------------------------

  // Is the lock screen showing? LogonUI.exe runs exactly while the PC is locked.
  function readLocked(): boolean {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"], { encoding: "utf8", timeout: 8000 });
    return (r.stdout || "").toLowerCase().includes("logonui.exe");
  }

  // The current clipboard TEXT (empty string if it's empty or not text).
  function readClipboard(): string {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", timeout: 8000 });
    return (r.stdout ?? "").replace(/\r?\n$/, "");
  }

  // Free bytes on a drive ("C:") via Win32_LogicalDisk. Returns -1 if unknown.
  function readFree(drive: string): number {
    const id = drive.toUpperCase().replace(/[\\/]+$/, "");   // "C:\" -> "C:"
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      "(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='" + id.replace(/'/g, "") + "'\").FreeSpace"],
      { encoding: "utf8", timeout: 8000 });
    const n = Number((r.stdout || "").trim());
    return Number.isFinite(n) ? n : -1;
  }

  // -------------------------------------------------------------------------
  // Stopwatch state — a single closure timestamp, reset each time stopwatch()
  // is called. elapsed() reads it. NONE/0 means "not started yet".
  // -------------------------------------------------------------------------
  let stopwatchStart = 0;   // ms timestamp of the last stopwatch() call (0 = unstarted)

  // Format a number of seconds as friendly text: "42s", "3m 12s", "1h 04m".
  function formatElapsed(totalSec: number): string {
    const s = Math.floor(totalSec);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    const h = Math.floor(m / 60);
    return h + "h " + String(m % 60).padStart(2, "0") + "m";
  }

  // ===========================================================================
  // The builtins. Each validates its inputs, then either acts now (stopwatch /
  // elapsed), schedules a one-shot (remind / timer), or registers a watcher job
  // (on_lock / on_unlock / on_clipboard / on_low_disk) and returns NONE.
  // ===========================================================================
  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // ~ Pop a reminder later. "in 10 minutes", "at 8:30pm", or just a duration.
    remind: (args, site) => {
      needWindows("remind", site);
      const msg = stringify(args[1] ?? NONE);
      if (!msg.trim()) throw new LangError("Runtime", "remind needs something to remind you about.", site?.line ?? 1, site?.col ?? 1, 'Try: remind("in 10 minutes", "Stretch!")');
      const whenText = stringify(args[0] ?? NONE).trim();
      const lower = whenText.toLowerCase();

      let ms: number;
      if (lower.startsWith("in ")) {
        // "in 10 minutes" -> a delay from now.
        ms = parseDuration(whenText.slice(3).trim(), site) * 1000;
      } else if (lower.startsWith("at ")) {
        // "at 8:30pm" -> the next time the clock hits that, today or tomorrow.
        const { hh, mm } = parseAt(whenText.slice(3).trim(), site);
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);   // already passed today -> tomorrow
        ms = target.getTime() - now.getTime();
      } else {
        // Bare time text, treated as a delay: remind("30s", "...").
        ms = parseDuration(whenText, site) * 1000;
      }

      ms = Math.max(0, Math.round(ms));
      const t = setTimeout(() => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);   // this one-shot is done — let the program exit if nothing else is pending
        toast("Reminder", msg);
      }, ms);
      timers.push(t);
      return NONE;
    },

    // ~ A countdown timer. When it ends: beep + a toast. timer("5 minutes", "Tea!")
    timer: (args, site) => {
      needWindows("timer", site);
      const secs = parseDuration(args[0], site);
      const msg = (stringify(args[1] ?? NONE).trim()) || "Timer done!";
      const ms = Math.max(0, Math.round(secs * 1000));
      const t = setTimeout(() => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
        beep();
        toast("Timer", msg);
      }, ms);
      timers.push(t);
      return NONE;
    },

    // ~ Start (or restart) the stopwatch from now.
    stopwatch: (_args, _site) => {
      stopwatchStart = Date.now();
      return NONE;
    },

    // ~ How long since stopwatch()? elapsed() -> "3m 12s"; elapsed("seconds") -> a number.
    elapsed: (args, site) => {
      if (stopwatchStart === 0) throw new LangError("Runtime", "the stopwatch hasn't been started yet.", site?.line ?? 1, site?.col ?? 1, "Call stopwatch() first, then elapsed().");
      const sec = (Date.now() - stopwatchStart) / 1000;
      const unit = stringify(args[0] ?? NONE).trim().toLowerCase();
      if (unit === "seconds" || unit === "second" || unit === "secs" || unit === "sec" || unit === "s") return Math.floor(sec);
      return formatElapsed(sec);
    },

    // ~ Run a task the moment you lock the PC. on_lock("pause_music")
    on_lock: (args, site) => {
      needWindows("on_lock", site);
      jobs.push({ kind: "lock", task: needTask(args[0], site) });
      return NONE;
    },

    // ~ Run a task the moment you unlock the PC. on_unlock("welcome_back")
    on_unlock: (args, site) => {
      needWindows("on_unlock", site);
      jobs.push({ kind: "unlock", task: needTask(args[0], site) });
      return NONE;
    },

    // ~ Run a task whenever you copy fresh text to the clipboard. on_clipboard("save_it")
    on_clipboard: (args, site) => {
      needWindows("on_clipboard", site);
      jobs.push({ kind: "clipboard", task: needTask(args[0], site) });
      return NONE;
    },

    // ~ Run a task when a drive's free space drops below a limit.
    //   on_low_disk("C:", "5 GB", "warn_me")
    on_low_disk: (args, site) => {
      needWindows("on_low_disk", site);
      const drive = stringify(args[0] ?? NONE).trim();
      if (!/^[a-zA-Z]:?$/.test(drive.replace(/[\\/]+$/, ""))) throw new LangError("Runtime", "on_low_disk needs a drive like \"C:\".", site?.line ?? 1, site?.col ?? 1, 'Try: on_low_disk("C:", "5 GB", "warn_me")');
      const letter = drive.replace(/[\\/]+$/, "").replace(/:$/, "") + ":";   // normalise "C" / "C:\" -> "C:"
      const bytes = parseSize(args[1], site);
      jobs.push({ kind: "low_disk", drive: letter.toUpperCase(), bytes, task: needTask(args[2], site) });
      return NONE;
    },
  };

  // ===========================================================================
  // start() — turn the registered watcher jobs into live polling loops. We group
  // jobs by what they watch so we only read each signal once per tick, then fan
  // the result out to every job of that kind. Each loop keeps its own "last seen"
  // memory in a closure so it fires on the EDGE (the change), not the level.
  //
  // Reminders & timers are already-live setTimeouts, so there's nothing to set
  // up for them here — they just keep the event loop alive until they fire.
  // ===========================================================================
  const start = (): void => {
    if (jobs.length === 0) return;

    const lockJobs = jobs.filter((j): j is Extract<Job, { kind: "lock" }> => j.kind === "lock");
    const unlockJobs = jobs.filter((j): j is Extract<Job, { kind: "unlock" }> => j.kind === "unlock");
    const clipboardJobs = jobs.filter((j): j is Extract<Job, { kind: "clipboard" }> => j.kind === "clipboard");
    const lowDiskJobs = jobs.filter((j): j is Extract<Job, { kind: "low_disk" }> => j.kind === "low_disk");

    const summary: string[] = [];

    // --- lock / unlock: watch LogonUI.exe every ~1.5s for a state flip ---
    if (lockJobs.length > 0 || unlockJobs.length > 0) {
      let wasLocked = readLocked();   // seed with the current state so we only fire on a CHANGE
      timers.push(setInterval(() => {
        const now = readLocked();
        if (now && !wasLocked) for (const j of lockJobs) run(j.task);     // unlocked -> locked
        if (!now && wasLocked) for (const j of unlockJobs) run(j.task);   // locked -> unlocked
        wasLocked = now;
      }, 1500));
      for (const j of lockJobs) summary.push("on_lock -> " + j.task);
      for (const j of unlockJobs) summary.push("on_unlock -> " + j.task);
    }

    // --- clipboard: poll the text every ~1s; fire when it changes to something ---
    if (clipboardJobs.length > 0) {
      let last = readClipboard();   // seed so an unchanged clipboard at start doesn't fire
      timers.push(setInterval(() => {
        const now = readClipboard();
        if (now !== last && now !== "") for (const j of clipboardJobs) run(j.task);
        last = now;
      }, 1000));
      for (const j of clipboardJobs) summary.push("on_clipboard -> " + j.task);
    }

    // --- low disk: read free space every ~60s; fire only on the DOWNWARD cross ---
    if (lowDiskJobs.length > 0) {
      // Remember each job's last reading so we fire exactly once, as it dips under.
      const lastFree = new Map<Extract<Job, { kind: "low_disk" }>, number>();
      for (const j of lowDiskJobs) lastFree.set(j, readFree(j.drive));   // seed with current free space
      timers.push(setInterval(() => {
        for (const j of lowDiskJobs) {
          const free = readFree(j.drive);
          const before = lastFree.get(j) ?? -1;
          if (free >= 0) {
            // Downward crossing only: now under the line, but it wasn't before.
            if (free < j.bytes && (before < 0 || before >= j.bytes)) run(j.task);
            lastFree.set(j, free);
          }
        }
      }, 60000));
      for (const j of lowDiskJobs) summary.push("on_low_disk " + j.drive + " < " + j.bytes + "B -> " + j.task);
    }

    console.log("⏰ Reminders armed:");
    for (const s of summary) console.log("   " + s);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: [
      "remind", "timer",
      "stopwatch", "elapsed",
      "on_lock", "on_unlock",
      "on_clipboard", "on_low_disk",
    ],
    builtins,
    // Stay alive while any reminder/timer is pending OR any watcher is registered.
    isActive: () => timers.length > 0 || jobs.length > 0,
    start,
  };
}
