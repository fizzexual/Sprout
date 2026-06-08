// libraries/automations/scheduling.ts — Sprout's clock & scheduler.
//
//   use "automations"
//   task tick():
//       show "tick at", now()
//   every("2 seconds", "tick")          ~ repeat on a timer
//   after("1 minute", "wrap_up")        ~ run once, later
//   at("08:00", "good_morning")         ~ run at a clock time
//   countdown("10 seconds", "liftoff", "Launch in") ~ a live countdown
//   alarm("7:00am", "Time to wake up!") ~ beep + a message
//   on_days("weekdays", "09:00", "standup")
//   on_first("first", "Monday", "10:00", "report")
//   at_sunrise("greet_the_day")
//
// The interpreter is SYNCHRONOUS. So scheduling builtins just REGISTER a job
// (push onto jobs[]) while your program runs; once it finishes, start() turns
// the jobs on with real timers and keeps Sprout alive. wait/now/today/weekday
// are instant helpers that answer right away.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { watch as fsWatch } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

// Day-of-week names, indexed so 0 = Sunday … 6 = Saturday (matches JS getDay()).
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Friendly spellings a person might type, mapped to that same 0–6 number.
const DOW: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

// Two digits, zero-padded: 7 -> "07". Used everywhere we print clock times.
function two(n: number): string { return (n < 10 ? "0" : "") + n; }

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
// Returns the hour (0–23), minute, and an optional day-of-week (null = daily).
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

// The jobs this library knows how to keep alive. Each one is a tiny record;
// start() reads the kind and wires up the matching timer.
type Job =
  | { kind: "every"; seconds: number; task: string; times: number | null }
  | { kind: "after"; seconds: number; task: string }
  | { kind: "at"; hh: number; mm: number; dow: number | null; task: string }
  | { kind: "watch"; file: string; task: string }
  | { kind: "countdown"; seconds: number; task: string; label: string }
  | { kind: "alarm"; hh: number; mm: number; dow: number | null; msg: string }
  | { kind: "on_days"; hh: number; mm: number; days: Set<number>; task: string }
  | { kind: "on_first"; nth: number; dow: number; hh: number; mm: number; task: string }
  | { kind: "at_sun"; which: "rise" | "set"; task: string }
  | { kind: "catch_up"; hh: number; mm: number; task: string };

export function register(interp: Interpreter) {
  const jobs: Job[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let stopped = false;
  // The task currently being fired — snooze() re-runs THIS one.
  let currentTask: string | null = null;

  // Run a Sprout task by name, tracking it for snooze() and never crashing the
  // whole scheduler if the task throws.
  const run = (task: string): void => {
    if (stopped) return;
    const prev = currentTask;
    currentTask = task;
    try { interp.runTask(task); }
    catch (e) { console.error("🕒 automation '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
    finally { currentTask = prev; }
  };

  // A task name is required and must not be empty.
  function needTask(v: Value | undefined, site: Site): string {
    const name = stringify(v ?? NONE);
    if (!name) throw new LangError("Runtime", "this automation needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: every(5, "tick")');
    return name;
  }
  // A duration that must be strictly positive (the word "zero" stays in the message).
  function needSeconds(v: Value | undefined, site: Site): number {
    const n = parseDuration(v, site);
    if (n <= 0) throw new LangError("Runtime", "this automation needs a time greater than zero.", site?.line ?? 1, site?.col ?? 1, 'Try: every(5, "tick")  or  every("10 minutes", "tick")');
    return n;
  }

  // Milliseconds from now until the next hh:mm — daily (dow=null) or weekly.
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

  // --- the "nth weekday of the month" math (used by on_first) ---------------
  // nth: 1=first … 4=fourth, or 0 meaning "last". Returns ms until that day's hh:mm,
  // searching this month first and rolling into later months as needed.
  function nextNthDow(nth: number, dow: number, hh: number, mm: number): number {
    const now = new Date();
    for (let ahead = 0; ahead < 24; ahead++) {       // look up to two years out (safety)
      const y = now.getFullYear();
      const month = now.getMonth() + ahead;
      const target = nthWeekdayDate(y, month, nth, dow);
      const fire = new Date(target.getFullYear(), target.getMonth(), target.getDate(), hh, mm, 0, 0);
      if (fire.getTime() > now.getTime()) return fire.getTime() - now.getTime();
    }
    return 24 * 60 * 60 * 1000;   // unreachable in practice; keep something sane
  }

  // The actual date of the nth (or last) given weekday in a month.
  function nthWeekdayDate(year: number, month: number, nth: number, dow: number): Date {
    if (nth === 0) {
      // "last": walk back from the final day until the weekday matches.
      const last = new Date(year, month + 1, 0);
      while (last.getDay() !== dow) last.setDate(last.getDate() - 1);
      return last;
    }
    const first = new Date(year, month, 1);
    let day = 1 + ((dow - first.getDay() + 7) % 7);  // first matching weekday
    day += (nth - 1) * 7;                            // then jump nth-1 weeks
    return new Date(year, month, day);
  }

  // --- sunrise / sunset (NOAA solar position, pure trig) --------------------
  // We use a fixed location fallback (see latLon). Returns "HH:MM" in LOCAL time,
  // or NONE for the rare polar case where the sun never rises/sets that day.
  const RAD = Math.PI / 180;

  // Best-effort location. There's no reliable synchronous geolocation, so we use
  // a sensible default (roughly the US east coast). You can think of this as
  // "near New York" until real coordinates are wired in.
  function latLon(): { lat: number; lon: number; guessed: boolean } {
    return { lat: 40.0, lon: -74.0, guessed: true };
  }

  // Compute sunrise ("rise") or sunset ("set") for today at our location.
  function solarTime(which: "rise" | "set"): string | null {
    const { lat, lon } = latLon();
    const now = new Date();
    // Day of the year (1–366).
    const start = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86400000);
    // Fractional year (radians), then equation of time + solar declination.
    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + 0.5);
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)); // minutes
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma); // radians
    // Hour angle for the sun at the horizon (90.833° accounts for refraction).
    const cosH = (Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl))) - Math.tan(lat * RAD) * Math.tan(decl);
    if (cosH > 1 || cosH < -1) return null; // sun never rises (or never sets) today
    const ha = Math.acos(cosH) / RAD; // degrees
    // Minutes from local midnight (UTC), then shift into the machine's local zone.
    const noonUTC = 720 - 4 * lon - eqTime; // solar noon in UTC minutes
    const minsUTC = which === "rise" ? noonUTC - 4 * ha : noonUTC + 4 * ha;
    const offsetMin = -now.getTimezoneOffset(); // local minus UTC, in minutes
    let local = minsUTC + offsetMin;
    local = ((local % 1440) + 1440) % 1440; // wrap into 0..1439
    let hh = Math.floor(local / 60);
    let mm = Math.round(local % 60);
    if (mm === 60) { mm = 0; hh = (hh + 1) % 24; } // rounding 59.6 -> carry the minute
    return two(hh) + ":" + two(mm);
  }

  // --- the small "last run" stamp file (used by catch_up) -------------------
  // A tiny JSON file kept next to the program: { "catch_up:task": "2026-06-08" }.
  function stampPath(): string { return resolve(interp.programDir, ".sprout-automations.json"); }
  function readStamps(): Record<string, string> {
    try { const o = JSON.parse(readFileSync(stampPath(), "utf8")); return o && typeof o === "object" ? o : {}; }
    catch { return {}; }
  }
  function writeStamp(key: string, value: string): void {
    const all = readStamps();
    all[key] = value;
    try { writeFileSync(stampPath(), JSON.stringify(all, null, 2)); } catch { /* best effort */ }
  }
  function todayStamp(): string { const d = new Date(); return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); }

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

    // A live countdown. countdown("10 seconds", "liftoff", "Launch in").
    // Shows a ticking T-MM:SS on one line, then runs the task at zero.
    countdown: (args, site) => {
      const seconds = needSeconds(args[0], site);
      const task = needTask(args[1], site);
      const label = args[2] != null ? stringify(args[2]) : "T-";
      jobs.push({ kind: "countdown", seconds, task, label });
      return NONE;
    },

    // Set an alarm: at the time, beep and print your message.
    // alarm("7:00am", "Time to wake up!") — time can also be "Monday 09:00".
    alarm: (args, site) => {
      const t = parseAt(stringify(args[0] ?? NONE), site);
      const msg = stringify(args[1] ?? "Alarm!");
      jobs.push({ kind: "alarm", hh: t.hh, mm: t.mm, dow: t.dow, msg });
      return NONE;
    },

    // Make a sound right now — a beep, plus the Windows alarm chime if available.
    ring: () => {
      spawnSync("powershell", ["-NoProfile", "-Command", "[console]::beep(880,500);try{(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').PlaySync()}catch{}"], { timeout: 8000 });
      return NONE;
    },

    // Re-run the CURRENT task after a delay. Call snooze() from inside an alarm's
    // task to remind yourself again later: snooze("9 minutes").
    snooze: (args, site) => {
      const seconds = needSeconds(args[0], site);
      if (!currentTask) throw new LangError("Runtime", "snooze only works from inside a task that an automation started.", site?.line ?? 1, site?.col ?? 1, 'Call snooze() inside the task you set with alarm() or at().');
      const task = currentTask; // capture now; currentTask changes between runs
      timers.push(setTimeout(() => run(task), Math.max(0, seconds) * 1000));
      return NONE;
    },

    // Run a task on certain days at a clock time.
    // on_days("weekdays", "09:00", "standup"), on_days("weekends", "11:00", "brunch"),
    // on_days("Monday, Thursday", "18:00", "gym").
    on_days: (args, site) => {
      const days = parseDaySet(stringify(args[0] ?? NONE), site);
      const t = parseAt(stringify(args[1] ?? NONE), site);
      jobs.push({ kind: "on_days", hh: t.hh, mm: t.mm, days, task: needTask(args[2], site) });
      return NONE;
    },

    // Run a task on, say, the first Monday of every month at a time.
    // on_first("first", "Monday", "10:00", "report"). nth: first/second/third/fourth/last.
    on_first: (args, site) => {
      const nth = parseNth(stringify(args[0] ?? NONE), site);
      const dowName = stringify(args[1] ?? NONE).trim().toLowerCase();
      const dow = DOW[dowName];
      if (dow === undefined) throw new LangError("Runtime", "on_first needs a day name like Monday.", site?.line ?? 1, site?.col ?? 1, 'Try: on_first("first", "Monday", "10:00", "report")');
      const t = parseAt(stringify(args[2] ?? NONE), site);
      jobs.push({ kind: "on_first", nth, dow, hh: t.hh, mm: t.mm, task: needTask(args[3], site) });
      return NONE;
    },

    // Today's sunrise time, "HH:MM" (or nothing on a polar day).
    sunrise: () => { const t = solarTime("rise"); return t === null ? NONE : t; },

    // Today's sunset time, "HH:MM" (or nothing on a polar day).
    sunset: () => { const t = solarTime("set"); return t === null ? NONE : t; },

    // Run a task at sunrise / at sunset (the time is recomputed each day).
    at_sunrise: (args, site) => { jobs.push({ kind: "at_sun", which: "rise", task: needTask(args[0], site) }); return NONE; },
    at_sunset: (args, site) => { jobs.push({ kind: "at_sun", which: "set", task: needTask(args[0], site) }); return NONE; },

    // "If we missed it, do it now." On start, if it's already past `time` today
    // and we haven't run the task yet today, run it once and remember that.
    catch_up: (args, site) => {
      const t = parseAt(stringify(args[0] ?? NONE), site);
      jobs.push({ kind: "catch_up", hh: t.hh, mm: t.mm, task: needTask(args[1], site) });
      return NONE;
    },

    // Stop all automations and let the program end.
    stop: () => {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      setTimeout(() => process.exit(0), 50);
      return NONE;
    },
  };

  // Turn "weekdays" / "weekends" / "Mon, Thu" into a set of 0–6 day numbers.
  function parseDaySet(raw: string, site: Site): Set<number> {
    const s = raw.trim().toLowerCase();
    if (s === "weekday" || s === "weekdays") return new Set([1, 2, 3, 4, 5]);
    if (s === "weekend" || s === "weekends") return new Set([0, 6]);
    const out = new Set<number>();
    for (const part of s.split(/[,\s]+/).filter(Boolean)) {
      const d = DOW[part];
      if (d === undefined) throw new LangError("Runtime", "I couldn't understand the days '" + raw + "'.", site?.line ?? 1, site?.col ?? 1, 'Try "weekdays", "weekends", or a list like "Monday, Thursday".');
      out.add(d);
    }
    if (out.size === 0) throw new LangError("Runtime", "on_days needs at least one day.", site?.line ?? 1, site?.col ?? 1, 'Try "weekdays" or "Monday, Thursday".');
    return out;
  }

  // Turn "first"/"1" … "fourth"/"4" or "last" into 1–4, or 0 for "last".
  function parseNth(raw: string, site: Site): number {
    const s = raw.trim().toLowerCase();
    const map: Record<string, number> = { first: 1, "1": 1, "1st": 1, second: 2, "2": 2, "2nd": 2, third: 3, "3": 3, "3rd": 3, fourth: 4, "4": 4, "4th": 4, last: 0 };
    if (!(s in map)) throw new LangError("Runtime", "on_first needs first/second/third/fourth or last.", site?.line ?? 1, site?.col ?? 1, 'Try: on_first("first", "Monday", "10:00", "report")');
    return map[s];
  }

  // Start watching a file for changes (debounced — saves often fire twice).
  function startWatch(path: string, fire: () => void): void {
    let busy = false;
    try {
      fsWatch(path, () => {
        if (busy) return;
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
      } else if (job.kind === "countdown") {
        // Tick once a second on one line, then run the task at zero.
        let left = Math.max(0, Math.round(job.seconds));
        const draw = (): void => {
          const mm = Math.floor(left / 60);
          const ss = left % 60;
          process.stdout.write("\r" + job.label + " " + two(mm) + ":" + two(ss));
        };
        draw();
        const id = setInterval(() => {
          left -= 1;
          if (left <= 0) {
            process.stdout.write("\r" + job.label + " " + two(0) + ":" + two(0));
            process.stdout.write("\n");
            clearInterval(id);
            run(job.task);
            return;
          }
          draw();
        }, 1000);
        timers.push(id);
        summary.push("countdown " + job.seconds + "s -> " + job.task);
      } else if (job.kind === "alarm") {
        // One-shot like `at`, but it rings and prints the message.
        const fireAlarm = (): void => {
          (builtins.ring as (a: Value[]) => Value)([]);
          console.log(job.msg);
        };
        const period = job.dow === null ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        timers.push(setTimeout(() => { fireAlarm(); timers.push(setInterval(fireAlarm, period)); }, nextOccurrence(job.hh, job.mm, job.dow)));
        summary.push("alarm at " + (job.dow !== null ? DAY_NAMES[job.dow] + " " : "") + two(job.hh) + ":" + two(job.mm) + ' "' + job.msg + '"');
      } else if (job.kind === "on_days") {
        // Fire daily at hh:mm, but only actually run on the chosen weekdays.
        const fire = (): void => { if (job.days.has(new Date().getDay())) run(job.task); };
        timers.push(setTimeout(() => { fire(); timers.push(setInterval(fire, 24 * 60 * 60 * 1000)); }, nextOccurrence(job.hh, job.mm, null)));
        summary.push("on_days [" + [...job.days].map((d) => DAY_NAMES[d].slice(0, 3)).join(",") + "] " + two(job.hh) + ":" + two(job.mm) + " -> " + job.task);
      } else if (job.kind === "on_first") {
        // Self-rescheduling: after each fire, compute the NEXT monthly occurrence.
        const schedule = (): void => {
          timers.push(setTimeout(() => { run(job.task); schedule(); }, nextNthDow(job.nth, job.dow, job.hh, job.mm)));
        };
        schedule();
        const nthName = job.nth === 0 ? "last" : ["", "first", "second", "third", "fourth"][job.nth];
        summary.push("on " + nthName + " " + DAY_NAMES[job.dow] + " " + two(job.hh) + ":" + two(job.mm) + " -> " + job.task);
      } else if (job.kind === "at_sun") {
        // Compute the time from sunrise()/sunset(), then reschedule for tomorrow.
        const schedule = (): void => {
          const t = solarTime(job.which);
          if (t === null) { timers.push(setTimeout(schedule, 24 * 60 * 60 * 1000)); return; } // polar day: try again tomorrow
          const [hh, mm] = t.split(":").map(Number);
          timers.push(setTimeout(() => { run(job.task); schedule(); }, nextOccurrence(hh, mm, null)));
        };
        schedule();
        const t = solarTime(job.which);
        summary.push("at " + (job.which === "rise" ? "sunrise" : "sunset") + (t ? " (~" + t + ")" : "") + " -> " + job.task);
      } else if (job.kind === "catch_up") {
        // If today's time already passed and we haven't run since, run now.
        const now = new Date();
        const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), job.hh, job.mm, 0, 0);
        const key = "catch_up:" + job.task + ":" + two(job.hh) + two(job.mm);
        if (now.getTime() >= due.getTime() && readStamps()[key] !== todayStamp()) {
          run(job.task);
          writeStamp(key, todayStamp());
        }
        // Going forward it behaves like a normal daily `at`, stamping each run.
        const fire = (): void => { run(job.task); writeStamp(key, todayStamp()); };
        timers.push(setTimeout(() => { fire(); timers.push(setInterval(fire, 24 * 60 * 60 * 1000)); }, nextOccurrence(job.hh, job.mm, null)));
        summary.push("catch_up " + two(job.hh) + ":" + two(job.mm) + " -> " + job.task);
      }
    }
    if (summary.length === 0) return;
    console.log("🕒 Automations running:");
    for (const s of summary) console.log("   " + s);
    if (latLon().guessed && jobs.some((j) => j.kind === "at_sun")) {
      console.log("   (sunrise/sunset use a default location near 40.0,-74.0)");
    }
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: [
      "wait", "now", "today", "weekday", "every", "after", "at", "watch", "stop",
      "countdown", "alarm", "ring", "snooze", "on_days", "on_first",
      "sunrise", "sunset", "at_sunrise", "at_sunset", "catch_up",
    ],
    builtins,
    isActive: () => jobs.length > 0,
    start,
  };
}
