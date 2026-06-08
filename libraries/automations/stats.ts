// libraries/automations/stats.ts — read how your PC is doing, and show pop-ups.
//
//   use "automations"
//   show cpu()              ~ how busy the processor is right now (0-100)
//   show ram()              ~ how much memory is in use (0-100)
//   show disk("C")          ~ how full the C: drive is (0-100)
//   show battery()          ~ battery charge left (0-100; desktops report 100)
//   notify("Done", "Tea is ready!")   ~ a little Windows toast pop-up
//   if confirm("Save now?"): save()   ~ a Yes/No box
//   watch_cpu(90, "warn_me")          ~ run a task when the CPU goes over 90%
//
// Almost everything here is a "read it now" number you can show or compare. The
// pop-ups (notify / popup / confirm / ask_box) put something on screen. The two
// watch_* builtins are the only background work: they keep a small loop running
// and fire a task the moment CPU/RAM climbs over the line you set.
//
// These all read or use Windows-only features, so the whole module is Windows-only.

import { NONE, stringify, SList } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // --- shared little helpers -------------------------------------------------

  // Every reader and pop-up here needs Windows. One friendly gate for them all.
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") {
      throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "These stats and pop-ups use Windows features.");
    }
  }

  // Run a short PowerShell command and hand back its stdout (trimmed).
  // -NoProfile keeps it fast; extraEnv lets us pass text safely via env vars
  // (so quotes/newlines in the user's text can never break the command).
  function powershell(command: string, site: Site, timeout = 10000, extraEnv?: Record<string, string>): { ok: boolean; out: string; err: string } {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      timeout,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    if (r.error) throw new LangError("Runtime", "I couldn't run that PC command: " + r.error.message, site?.line ?? 1, site?.col ?? 1, "Make sure PowerShell is available.");
    return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  }

  // Read a single number out of a PowerShell command. Returns NaN if it can't.
  function readNumber(command: string, site: Site, timeout = 10000): number {
    const r = powershell(command, site, timeout);
    if (!r.ok) return NaN;
    return Number((r.out.split(/\r?\n/)[0] || "").trim());
  }

  // Keep a number inside 0..100 and round it to a whole number.
  function clampPct(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // Normalise a drive letter the user typed ("c", "C:", "C:\") into "C:".
  function driveId(raw: string): string {
    const letter = (raw.trim().match(/[A-Za-z]/)?.[0] || "C").toUpperCase();
    return letter + ":";
  }

  // The CPU reader, shared by cpu() and the watch loop. Average load across cores.
  function readCpu(site: Site): number {
    // Win32_Processor.LoadPercentage is instant and reliable; Get-Counter is slow.
    const n = readNumber("(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average", site, 10000);
    return clampPct(n);
  }

  // The RAM reader, shared by ram() and the watch loop. Percent of memory in use.
  function readRam(site: Site): number {
    const n = readNumber(
      "$o = Get-CimInstance Win32_OperatingSystem; [Math]::Round(($o.TotalVisibleMemorySize - $o.FreePhysicalMemory) / $o.TotalVisibleMemorySize * 100)",
      site, 10000);
    return clampPct(n);
  }

  // --- background watch jobs --------------------------------------------------
  // watch_cpu / watch_ram push a job here. While any job exists, isActive() is
  // true and start() runs one ~5s loop that fires tasks on the UPWARD crossing.
  type Job = { kind: "cpu" | "ram"; pct: number; task: string };
  const jobs: Job[] = [];
  let watchTimer: ReturnType<typeof setInterval> | null = null;

  // Run one of the program's tasks, turning any error into a friendly note
  // instead of crashing the watch loop.
  function runTask(task: string): void {
    try { interp.runTask(task); }
    catch (e) { console.error("📊 watch '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
  }

  // Validate a 1-100 percent threshold for the watch_* builtins.
  function needPct(v: Value | undefined, name: string, site: Site): number {
    const pct = Math.round(Number(stringify(v ?? NONE)));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new LangError("Runtime", name + " needs a percent from 1 to 100.", site?.line ?? 1, site?.col ?? 1, 'Try: ' + name + '(90, "warn_me")');
    }
    return pct;
  }

  // Validate a task name for the watch_* builtins.
  function needTask(v: Value | undefined, name: string, site: Site): string {
    const task = stringify(v ?? NONE).trim();
    if (!task) throw new LangError("Runtime", name + " needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: ' + name + '(90, "warn_me")');
    return task;
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // --- live readings ------------------------------------------------------

    // How busy the processor is right now, 0-100. cpu()
    cpu: (_args, site) => {
      needWindows("cpu", site);
      return readCpu(site);
    },

    // How much memory is in use right now, 0-100. ram()
    ram: (_args, site) => {
      needWindows("ram", site);
      return readRam(site);
    },

    // How a disk is doing. disk()  -> C: used%   disk("D") -> D: used%
    //   disk("C", "free")  -> free space in GB     disk("C", "total") -> total GB
    disk: (args, site) => {
      needWindows("disk", site);
      const id = driveId(args.length > 0 ? stringify(args[0] ?? NONE) : "C");
      const mode = (args.length > 1 ? stringify(args[1] ?? NONE) : "").trim().toLowerCase();
      const r = powershell(
        "$d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='" + id + "'\"; if ($d) { \"$($d.FreeSpace)|$($d.Size)\" }",
        site, 10000);
      if (!r.ok || !r.out.includes("|")) {
        throw new LangError("Runtime", "I couldn't read the " + id + " drive.", site?.line ?? 1, site?.col ?? 1, 'Try a drive letter you have, like disk("C").');
      }
      const [freeStr, sizeStr] = r.out.split(/\r?\n/)[0].split("|");
      const free = Number(freeStr);
      const size = Number(sizeStr);
      if (!Number.isFinite(free) || !Number.isFinite(size) || size <= 0) {
        throw new LangError("Runtime", "I couldn't measure the " + id + " drive.", site?.line ?? 1, site?.col ?? 1, "That drive may not be ready.");
      }
      const GB = 1024 * 1024 * 1024;
      if (mode === "free") return Math.round((free / GB) * 10) / 10;   // GB free, 1 decimal
      if (mode === "total") return Math.round((size / GB) * 10) / 10;  // GB total, 1 decimal
      return clampPct(((size - free) / size) * 100);                   // default: used %
    },

    // Battery charge left, 0-100. Desktops with no battery report 100. battery()
    battery: (_args, site) => {
      needWindows("battery", site);
      const r = powershell(
        "$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { $b.EstimatedChargeRemaining }",
        site, 10000);
      if (!r.ok || r.out === "") return 100; // no battery (desktop) -> treat as full
      const n = Number((r.out.split(/\r?\n/)[0] || "").trim());
      return Number.isFinite(n) ? clampPct(n) : 100;
    },

    // Is the PC charging (or plugged in)? -> yes / no. Desktops report yes.
    charging: (_args, site) => {
      needWindows("charging", site);
      const r = powershell(
        "$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { $b.BatteryStatus } else { 'none' }",
        site, 10000);
      if (!r.ok) return true;
      const out = (r.out.split(/\r?\n/)[0] || "").trim();
      if (out === "" || out === "none") return true; // no battery = always on power
      const status = Number(out);
      // BatteryStatus: 2 = plugged in (AC), 6/7/8/9 = charging states. 1 = on battery.
      return status === 2 || status === 6 || status === 7 || status === 8 || status === 9;
    },

    // How long the PC has been on. pc_uptime() -> minutes   pc_uptime("hours") -> hours
    // (Named pc_uptime so it doesn't clash with networking's uptime().)
    pc_uptime: (args, site) => {
      needWindows("pc_uptime", site);
      const unit = (args.length > 0 ? stringify(args[0] ?? NONE) : "").trim().toLowerCase();
      // LastBootUpTime is a real DateTime; subtract from now for the elapsed minutes.
      const n = readNumber(
        "[Math]::Round(((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalMinutes)",
        site, 10000);
      if (!Number.isFinite(n) || n < 0) return 0;
      if (unit === "hours" || unit === "hour" || unit === "h") return Math.round((n / 60) * 10) / 10;
      return Math.round(n);
    },

    // The running programs. processes()      -> a sorted list of program names
    //   processes("chrome")  -> yes / no: is that program running?
    processes: (args, site) => {
      needWindows("processes", site);
      if (args.length > 0) {
        // Ask tasklist about this exact image; if it's listed, it's running.
        const name = stringify(args[0] ?? NONE).trim();
        const image = /\.exe$/i.test(name) ? name : name + ".exe";
        const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + image, "/NH"], { encoding: "utf8", timeout: 8000 });
        return (r.stdout || "").toLowerCase().includes(image.toLowerCase());
      }
      // No name: list every distinct program name, sorted.
      const r = powershell("Get-Process | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object", site, 12000);
      if (!r.ok) throw new LangError("Runtime", "I couldn't list the running programs.", site?.line ?? 1, site?.col ?? 1, "Try again in a moment.");
      const names = r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
      return new SList(names);
    },

    // How long since you last touched the mouse/keyboard, in seconds. idle_time()
    idle_time: (_args, site) => {
      needWindows("idle_time", site);
      // GetLastInputInfo gives the tick of the last input; subtract from now for the gap.
      const script =
        'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }\npublic class Idle { [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); [DllImport("kernel32.dll")] public static extern uint GetTickCount(); }\n"@\n' +
        "$l = New-Object LASTINPUTINFO; $l.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($l); [void][Idle]::GetLastInputInfo([ref]$l); [Idle]::GetTickCount() - $l.dwTime";
      const r = powershell(script, site, 10000);
      const ms = Number((r.out.split(/\r?\n/)[0] || "").trim());
      return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : 0;
    },

    // --- pop-ups ------------------------------------------------------------

    // Show a little Windows toast pop-up. notify("Title", "Message")
    notify: (args, site) => {
      needWindows("notify", site);
      const title = stringify(args[0] ?? NONE);
      const msg = stringify(args[1] ?? NONE);
      // Zero-dependency WinRT toast. We must load the WinRT types with explicit
      // accelerators first, then build the toast XML and show it. Title/message
      // come in via env vars so quotes/newlines in them can't break anything.
      const cmd =
        "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; " +
        "[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]; " +
        "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]; " +
        "$xml = \"<toast><visual><binding template='ToastGeneric'><text>$env:T_TITLE</text><text>$env:T_MSG</text></binding></visual></toast>\"; " +
        "$d = [Windows.Data.Xml.Dom.XmlDocument]::new(); $d.LoadXml($xml); " +
        "$t = [Windows.UI.Notifications.ToastNotification]::new($d); " +
        "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'; " +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($t)";
      powershell(cmd, site, 10000, { T_TITLE: title, T_MSG: msg });
      return NONE;
    },

    // Show a simple message box with an OK button. popup("All done!")
    popup: (args, site) => {
      needWindows("popup", site);
      const msg = stringify(args[0] ?? NONE);
      powershell(
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:MSG) | Out-Null",
        site, 600000, { MSG: msg });   // long timeout: it waits for the user to click OK
      return NONE;
    },

    // Ask a Yes/No question and get back the answer. confirm("Save now?") -> yes/no
    confirm: (args, site) => {
      needWindows("confirm", site);
      const msg = stringify(args[0] ?? NONE);
      const r = powershell(
        "Add-Type -AssemblyName System.Windows.Forms; [int][System.Windows.Forms.MessageBox]::Show($env:MSG, 'Sprout', 'YesNo')",
        site, 600000, { MSG: msg });   // long timeout: it waits for the user to choose
      // DialogResult.Yes = 6, No = 7.
      return (r.out.split(/\r?\n/)[0] || "").trim() === "6";
    },

    // Ask the user to type something. ask_box("Your name?") -> text, or nothing if empty/cancelled
    ask_box: (args, site) => {
      needWindows("ask_box", site);
      const prompt = stringify(args[0] ?? NONE);
      const r = powershell(
        "[void][Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); [Microsoft.VisualBasic.Interaction]::InputBox($env:PROMPT, 'Sprout', '')",
        site, 600000, { PROMPT: prompt });   // long timeout: it waits for the user to type
      const text = r.out;
      return text.length > 0 ? text : NONE;
    },

    // --- background watchers ------------------------------------------------

    // Run a task whenever the CPU climbs over this percent. watch_cpu(90, "warn_me")
    watch_cpu: (args, site) => {
      needWindows("watch_cpu", site);
      const pct = needPct(args[0], "watch_cpu", site);
      const task = needTask(args[1], "watch_cpu", site);
      jobs.push({ kind: "cpu", pct, task });
      return NONE;
    },

    // Run a task whenever memory use climbs over this percent. watch_ram(85, "warn_me")
    watch_ram: (args, site) => {
      needWindows("watch_ram", site);
      const pct = needPct(args[0], "watch_ram", site);
      const task = needTask(args[1], "watch_ram", site);
      jobs.push({ kind: "ram", pct, task });
      return NONE;
    },
  };

  // start() — if any watch_* job was registered, run one ~5s loop. For each job
  // we remember whether we're currently "over the line", and only fire on the
  // UPWARD crossing (re-arming once the reading drops back below the threshold).
  const start = (): void => {
    if (jobs.length === 0) return;
    const over = new Map<Job, boolean>();
    for (const j of jobs) over.set(j, false);

    watchTimer = setInterval(() => {
      // Read each signal at most once per tick, even if several jobs share it.
      let cpuNow = NaN;
      let ramNow = NaN;
      if (jobs.some((j) => j.kind === "cpu")) cpuNow = readCpu(undefined);
      if (jobs.some((j) => j.kind === "ram")) ramNow = readRam(undefined);
      for (const j of jobs) {
        const value = j.kind === "cpu" ? cpuNow : ramNow;
        if (!Number.isFinite(value)) continue;
        if (value > j.pct && !over.get(j)) { over.set(j, true); runTask(j.task); }  // crossed up = fire
        else if (value <= j.pct) over.set(j, false);                                // back below = re-arm
      }
    }, 5000);

    console.log("📊 Watching:");
    for (const j of jobs) console.log("   " + (j.kind === "cpu" ? "CPU" : "RAM") + " over " + j.pct + "% -> " + j.task);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: [
      "cpu", "ram", "disk", "battery", "charging", "pc_uptime",
      "processes", "idle_time",
      "notify", "popup", "confirm", "ask_box",
      "watch_cpu", "watch_ram",
    ],
    builtins,
    // Background work is on only while a watch_* job is registered.
    isActive: () => jobs.length > 0,
    start,
  };
}
