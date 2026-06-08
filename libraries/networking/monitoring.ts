// libraries/networking/monitoring.ts — uptime monitoring & alerts for Sprout.
//
//   use "networking/monitoring"
//
//   task site_down():
//       show "⚠️  The site just went DOWN!"
//   task site_up():
//       show "✅ The site is back UP!"
//
//   monitor("https://example.com", "site_down", "site_up")
//   watchinternet("offline", "online")        ~ alerts when YOUR internet drops
//
//   ~ one-shot checks you can use any time:
//   show isdown("example.com")                 ~ yes / no
//   show avgping("google.com")                 ~ average ping in ms
//   show healthcheck("https://example.com")    ~ [yes, 200, 84]   (ok?, status, ms)
//   show uptime("https://example.com")         ~ 99.8  (% up, once monitor is running)
//   logstatus("https://example.com", "uptime.log")
//
// monitor / watchinternet / logstatus REGISTER a background job while the program
// runs; once the program finishes, the library's start() turns the jobs on (each
// on its own timer) and keeps Sprout alive — exactly like a bot's listen loop.
// The other builtins (isdown / avgping / healthcheck / uptime) answer instantly.

import { NONE, stringify, SList } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

// Strip "https://" and any path so "https://google.com/x" -> "google.com".
function bareHost(s: string): string {
  return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").trim();
}

// If the user gives a bare host ("example.com"), make a real URL we can fetch.
function asUrl(s: string): string {
  return /^[a-z]+:\/\//i.test(s) ? s : "https://" + s;
}

// Two-digit clock helper, e.g. 9 -> "09".
function two(n: number): string { return (n < 10 ? "0" : "") + n; }

// Run a tiny async Node script and return its stdout (throws a friendly error).
// This is how the synchronous interpreter does network work — a short subprocess.
function runNode(script: string, args: string[], site: Site): string {
  const res = spawnSync(process.execPath, ["-e", script, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 20000,
  });
  if (res.error) throw new LangError("Runtime", "Network problem: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Check your connection.");
  if (res.status !== 0) throw new LangError("Runtime", "Network problem: " + ((res.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Check the address.");
  return res.stdout ?? "";
}

// A quick HEAD probe in a subprocess. Prints "1" if the site replied with a
// status below 500 (online-style: even a 404 means the server is up), else "0".
// Never throws — a connection failure simply reads back as "0" (down).
function probeUp(url: string): boolean {
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      "(async()=>{try{const r=await fetch(process.argv[1],{method:'HEAD'});process.stdout.write(r.status<500?'1':'0');}catch{process.stdout.write('0');}})()",
      url,
    ],
    { encoding: "utf8", timeout: 8000 },
  );
  return (res.stdout || "").trim() === "1";
}

export function register(interp: Interpreter) {
  // The jobs we'll wake up on a timer once the program finishes.
  type MonitorJob = {
    kind: "monitor";
    url: string;
    downTask: string;
    upTask: string;
    lastUp: boolean | null;   // null = haven't checked yet
    checks: number;
    ups: number;
    everyMs: number;
  };
  type LogJob = { kind: "log"; url: string; file: string; everyMs: number };
  type Job = MonitorJob | LogJob;

  const jobs: Job[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // Shared tally board so uptime("...") can read the latest counts of any
  // monitored URL, even though the counting happens inside the timer loop.
  const tallies = new Map<string, { checks: number; ups: number }>();

  // Bump the running tally for a URL after one probe.
  function tally(url: string, wasUp: boolean): void {
    let t = tallies.get(url);
    if (!t) { t = { checks: 0, ups: 0 }; tallies.set(url, t); }
    t.checks += 1;
    if (wasUp) t.ups += 1;
  }

  // Fire a Sprout task by name, turning any error into a friendly log line so a
  // single bad alert task never crashes the whole monitor loop.
  function fire(taskName: string): void {
    if (!taskName) return;
    try { interp.runTask(taskName); }
    catch (e) { console.error("📡 monitor task '" + taskName + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
  }

  // Read a task name argument, complaining kindly if it's missing.
  function needTask(v: Value | undefined, site: Site, example: string): string {
    const name = stringify(v ?? NONE).trim();
    if (!name) throw new LangError("Runtime", "this monitor needs a task name to run.", site?.line ?? 1, site?.col ?? 1, example);
    return name;
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Watch a website. Every ~30s we probe it; when it goes from up -> down we
    // run downTask, and when it comes back down -> up we run upTask.
    //   monitor("https://example.com", "site_down", "site_up")
    monitor: (args, site) => {
      const url = asUrl(stringify(args[0] ?? NONE).trim());
      if (!url || url === "https://") throw new LangError("Runtime", "monitor needs a website to watch.", site?.line ?? 1, site?.col ?? 1, 'Try: monitor("https://example.com", "site_down", "site_up")');
      const downTask = needTask(args[1], site, 'Define a task, then: monitor("https://example.com", "site_down", "site_up")');
      const upTask = needTask(args[2], site, 'Define a task, then: monitor("https://example.com", "site_down", "site_up")');
      jobs.push({ kind: "monitor", url, downTask, upTask, lastUp: null, checks: 0, ups: 0, everyMs: 30000 });
      tallies.set(url, { checks: 0, ups: 0 });
      return NONE;
    },

    // Watch YOUR internet connection (target: google.com). Polls ~10s. When the
    // connection drops we run downTask; when it returns we run upTask.
    //   watchinternet("offline", "online")
    watchinternet: (args, site) => {
      const url = "https://www.google.com";
      const downTask = needTask(args[0], site, 'Define a task, then: watchinternet("offline", "online")');
      const upTask = needTask(args[1], site, 'Define a task, then: watchinternet("offline", "online")');
      jobs.push({ kind: "monitor", url, downTask, upTask, lastUp: null, checks: 0, ups: 0, everyMs: 10000 });
      tallies.set(url, { checks: 0, ups: 0 });
      return NONE;
    },

    // Is a host down right now? -> yes / no. ONE-SHOT, instant answer.
    // First we probe it ourselves; if that fails, we double-check with the public
    // isitup.org service so a glitch on our side doesn't cry wolf.
    isdown: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) throw new LangError("Runtime", "isdown needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: isdown("example.com")');
      // Our own probe says it's reachable -> definitely not down.
      if (probeUp(asUrl(host))) return false;
      // Our probe failed. Cross-check with isitup.org (status_code 3 = down).
      try {
        const out = runNode(
          "(async()=>{try{const r=await fetch('https://isitup.org/'+encodeURIComponent(process.argv[1])+'.json',{headers:{'User-Agent':'sprout-monitor'}});const j=await r.json();process.stdout.write(String(j.status_code));}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
          [host],
          site,
        ).trim();
        // status_code 1 = up, 3 = down. If the service agrees it's down, say yes.
        return out === "3";
      } catch {
        // The cross-check itself didn't work — fall back to our own probe result.
        return true;
      }
    },

    // Average round-trip ping to a host, in milliseconds. avgping("google.com")
    // or avgping("google.com", 6). Returns nothing if no replies came back.
    avgping: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) throw new LangError("Runtime", "avgping needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: avgping("google.com")');
      const n = args[1] != null ? Math.max(1, Math.round(Number(stringify(args[1])))) : 4;
      const count = Number.isFinite(n) ? n : 4;
      const isWin = process.platform === "win32";
      const cmdArgs = isWin ? ["-n", String(count), host] : ["-c", String(count), host];
      const out = spawnSync("ping", cmdArgs, { encoding: "utf8", timeout: 6000 + count * 2000 });
      const text = (out.stdout || "") + (out.stderr || "");
      // Pull every "time=NNms" / "time<NNms" the ping printed and average them.
      const times: number[] = [];
      const re = /time[=<]\s*(\d+(?:\.\d+)?)\s*ms/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) times.push(Number(m[1]));
      if (times.length === 0) return NONE;
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      return Math.round(avg * 10) / 10;
    },

    // A quick health report for a URL: [ok?, status, ms].
    //   healthcheck("https://example.com")  ->  [yes, 200, 84]
    // ok is yes/no, status is the HTTP code, ms is how long the request took.
    healthcheck: (args, site) => {
      const url = asUrl(stringify(args[0] ?? NONE).trim());
      if (!url || url === "https://") throw new LangError("Runtime", "healthcheck needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: healthcheck("https://example.com")');
      const out = runNode(
        "(async()=>{try{const t=performance.now();const r=await fetch(process.argv[1]);const ms=Math.round(performance.now()-t);process.stdout.write((r.status<400?'1':'0')+' '+r.status+' '+ms);}catch(e){process.stdout.write('0 0 0');}})()",
        [url],
        site,
      ).trim();
      const parts = out.split(/\s+/);
      const ok = parts[0] === "1";
      const status = Number(parts[1]);
      const ms = Number(parts[2]);
      return new SList([ok, Number.isFinite(status) ? status : 0, Number.isFinite(ms) ? ms : 0]);
    },

    // Keep a running log of a site's status. Every ~60s we append one line —
    //   "14:30 UP 84ms"  or  "14:31 DOWN 0ms"  — to a file next to your program.
    //   logstatus("https://example.com", "uptime.log")
    logstatus: (args, site) => {
      const url = asUrl(stringify(args[0] ?? NONE).trim());
      const file = stringify(args[1] ?? NONE).trim();
      if (!url || url === "https://") throw new LangError("Runtime", "logstatus needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: logstatus("https://example.com", "uptime.log")');
      if (!file) throw new LangError("Runtime", "logstatus needs a filename to write to.", site?.line ?? 1, site?.col ?? 1, 'Try: logstatus("https://example.com", "uptime.log")');
      jobs.push({ kind: "log", url, file, everyMs: 60000 });
      return NONE;
    },

    // How well has a monitored URL held up? Reads the live tallies the monitor
    // loop keeps. uptime(url) -> percent up (e.g. 99.8). uptime(url, "count") ->
    // how many checks have happened. Returns nothing if the URL isn't monitored.
    uptime: (args, site) => {
      const raw = stringify(args[0] ?? NONE).trim();
      const url = asUrl(raw);
      // Accept either the exact URL the user passed to monitor, or a bare host.
      const t = tallies.get(url) ?? tallies.get(raw);
      if (!t) {
        // Internet watcher stores under the google URL — let watchinternet users
        // ask uptime("internet") too, for friendliness.
        if (/^internet$/i.test(raw)) {
          const gt = tallies.get("https://www.google.com");
          if (gt) return uptimeResult(gt, args[1], site);
        }
        return NONE;
      }
      return uptimeResult(t, args[1], site);
    },
  };

  // Shared math for uptime(): percent up by default, or the raw check count when
  // the caller passes the "count" mode.
  function uptimeResult(t: { checks: number; ups: number }, mode: Value | undefined, _site: Site): Value {
    if (mode != null && stringify(mode).trim().toLowerCase() === "count") return t.checks;
    if (t.checks === 0) return 0;
    return Math.round((t.ups / t.checks) * 1000) / 10;
  }

  // One probe for a monitor job: tally it, and fire the right task on a
  // transition (up->down or down->up). The very first check sets the baseline.
  function runMonitorOnce(job: MonitorJob): void {
    const up = probeUp(job.url);
    job.checks += 1;
    if (up) job.ups += 1;
    tally(job.url, up);
    if (job.lastUp === null) {
      // First reading: remember it, but don't alert (we have nothing to compare).
      job.lastUp = up;
      return;
    }
    if (job.lastUp && !up) fire(job.downTask);        // was up, now down
    else if (!job.lastUp && up) fire(job.upTask);     // was down, now back up
    job.lastUp = up;
  }

  // One log tick: append "HH:MM UP|DOWN NNms" to the file next to the program.
  function runLogOnce(job: LogJob): void {
    const t0 = Date.now();
    const up = probeUp(job.url);
    const ms = Date.now() - t0;
    const d = new Date();
    const line = two(d.getHours()) + ":" + two(d.getMinutes()) + " " + (up ? "UP" : "DOWN") + " " + ms + "ms\n";
    try { appendFileSync(resolve(interp.programDir, job.file), line); }
    catch (e) { console.error("📡 couldn't write to '" + job.file + "': " + (e instanceof Error ? e.message : String(e))); }
  }

  // Turn every registered job on, each with its own repeating timer.
  const start = (): void => {
    if (jobs.length === 0) return;
    const summary: string[] = [];
    for (const job of jobs) {
      if (job.kind === "monitor") {
        // Do a baseline check right away, then keep checking on the interval.
        runMonitorOnce(job);
        const id = setInterval(() => runMonitorOnce(job), job.everyMs);
        timers.push(id);
        summary.push("watch " + job.url + " (every " + Math.round(job.everyMs / 1000) + "s) -> " + job.downTask + " / " + job.upTask);
      } else {
        runLogOnce(job);
        const id = setInterval(() => runLogOnce(job), job.everyMs);
        timers.push(id);
        summary.push("log " + job.url + " -> " + job.file + " (every " + Math.round(job.everyMs / 1000) + "s)");
      }
    }
    console.log("📡 Monitoring:");
    for (const s of summary) console.log("   " + s);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: ["monitor", "watchinternet", "isdown", "avgping", "healthcheck", "logstatus", "uptime"],
    builtins,
    isActive: () => jobs.length > 0,
    start,
  };
}
