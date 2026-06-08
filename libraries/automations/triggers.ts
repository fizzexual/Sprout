// libraries/automations/triggers.ts — run a task WHEN something happens.
//
// These are "event triggers": instead of a clock, they watch the real world
// and fire a task at the MOMENT something changes — the edge, not the level.
//
//   use "automations"
//   task locked():
//       show "Welcome back! 👋"
//   when_idle("5 minutes", "go_away")   ~ fires once when you've been away 5 min
//   when_back("locked")                 ~ fires the moment you touch the PC again
//   on_usb("backup")                    ~ a USB stick was plugged in
//   on_open("chrome", "focus_time")     ~ Chrome just started
//   on_wifi("HomeWifi", "sync")         ~ you joined the "HomeWifi" network
//   on_low_battery(20, "warn_me")       ~ battery just dropped under 20%
//   on_hotkey("F8", "screenshot")       ~ you tapped F8
//
// Each builtin REGISTERS a background watcher (a "job") while the program runs
// and returns nothing. When the program finishes, start() turns the watchers on
// — each kind of trigger gets one polling loop that reads the current state and,
// on the transition we care about, runs your task. All state lives in closures.
//
// Most of these read Windows-specific signals, so they're Windows-only. Idle
// time, USB drives, app open/close, wifi, battery and hotkeys are all things
// only Windows exposes the way we read them here.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";

type Site = { line: number; col: number } | undefined;

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

// Make sure a program name looks like "name.exe" (tasklist matches on the image).
function imageName(name: string): string { return /\.exe$/i.test(name) ? name : name + ".exe"; }

// Map a friendly key name ("F8", "a", "space") to a Windows virtual-key code.
// Letters and digits use their ASCII code; named keys have fixed VK numbers.
const NAMED_KEYS: Record<string, number> = {
  space: 0x20, enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};
function keyToVk(raw: string, site: Site): number {
  const k = raw.trim().toLowerCase();
  if (k in NAMED_KEYS) return NAMED_KEYS[k];
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);  // 'a'..'z', '0'..'9'
  throw new LangError("Runtime", "I don't know the key '" + raw + "'.", site?.line ?? 1, site?.col ?? 1, 'Try a letter ("a"), a number ("5"), "space", "enter", or "F1"–"F12".');
}

export function register(interp: Interpreter) {
  // Every registered watcher lives here. While jobs is non-empty, Sprout stays
  // alive after the program ends so the watchers can keep firing.
  type Job =
    | { kind: "idle"; ms: number; task: string }
    | { kind: "back"; task: string }
    | { kind: "usb"; task: string }
    | { kind: "usb_removed"; task: string }
    | { kind: "open"; image: string; task: string }
    | { kind: "close"; image: string; task: string }
    | { kind: "wifi"; ssid: string; task: string }
    | { kind: "offline"; task: string }
    | { kind: "low_battery"; pct: number; task: string }
    | { kind: "charging"; task: string }
    | { kind: "hotkey"; vk: number; key: string; task: string };

  const jobs: Job[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // Run one of the program's tasks, turning any error into a friendly note
  // instead of crashing the whole watcher loop.
  const run = (task: string): void => {
    try { interp.runTask(task); }
    catch (e) { console.error("⚡ trigger '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
  };

  // --- small validators, shared by every builtin ---
  function needTask(v: Value | undefined, site: Site): string {
    const name = stringify(v ?? NONE).trim();
    if (!name) throw new LangError("Runtime", "this trigger needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: on_usb("backup")');
    return name;
  }
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "These triggers read Windows-only signals.");
  }

  // ---------------------------------------------------------------------------
  // The builtins. Each one validates its inputs, pushes a job, and returns
  // NONE. The actual watching happens later, in start().
  // ---------------------------------------------------------------------------
  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Fire once when you've been away from the PC for this long.
    // when_idle("5 minutes", "go_away")  or  when_idle(300, "go_away")
    when_idle: (args, site) => {
      needWindows("when_idle", site);
      const ms = Math.max(1000, Math.round(parseDuration(args[0], site) * 1000));
      jobs.push({ kind: "idle", ms, task: needTask(args[1], site) });
      return NONE;
    },

    // Fire the moment you come back to the PC after being idle. when_back("locked")
    when_back: (args, site) => {
      needWindows("when_back", site);
      jobs.push({ kind: "back", task: needTask(args[0], site) });
      return NONE;
    },

    // Fire when a USB / removable drive is plugged in. on_usb("backup")
    on_usb: (args, site) => {
      needWindows("on_usb", site);
      jobs.push({ kind: "usb", task: needTask(args[0], site) });
      return NONE;
    },

    // Fire when a USB / removable drive is unplugged. on_usb_removed("safe")
    on_usb_removed: (args, site) => {
      needWindows("on_usb_removed", site);
      jobs.push({ kind: "usb_removed", task: needTask(args[0], site) });
      return NONE;
    },

    // Fire when a program starts. on_open("chrome", "focus_time")
    on_open: (args, site) => {
      needWindows("on_open", site);
      const image = imageName(stringify(args[0] ?? NONE).trim());
      if (image === ".exe") throw new LangError("Runtime", "on_open needs a program name.", site?.line ?? 1, site?.col ?? 1, 'Try: on_open("notepad", "ready")');
      jobs.push({ kind: "open", image, task: needTask(args[1], site) });
      return NONE;
    },

    // Fire when a program closes. on_close("game", "back_to_work")
    on_close: (args, site) => {
      needWindows("on_close", site);
      const image = imageName(stringify(args[0] ?? NONE).trim());
      if (image === ".exe") throw new LangError("Runtime", "on_close needs a program name.", site?.line ?? 1, site?.col ?? 1, 'Try: on_close("notepad", "done")');
      jobs.push({ kind: "close", image, task: needTask(args[1], site) });
      return NONE;
    },

    // Fire when you join a particular wifi network. on_wifi("HomeWifi", "sync")
    on_wifi: (args, site) => {
      needWindows("on_wifi", site);
      const ssid = stringify(args[0] ?? NONE).trim();
      if (!ssid) throw new LangError("Runtime", "on_wifi needs a network name.", site?.line ?? 1, site?.col ?? 1, 'Try: on_wifi("HomeWifi", "sync")');
      jobs.push({ kind: "wifi", ssid, task: needTask(args[1], site) });
      return NONE;
    },

    // Fire when you lose your wifi / network connection. on_offline("pause")
    on_offline: (args, site) => {
      needWindows("on_offline", site);
      jobs.push({ kind: "offline", task: needTask(args[0], site) });
      return NONE;
    },

    // Fire when the battery drops below a percent. on_low_battery(20, "warn_me")
    on_low_battery: (args, site) => {
      needWindows("on_low_battery", site);
      const pct = Math.round(Number(stringify(args[0] ?? NONE)));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new LangError("Runtime", "on_low_battery needs a percent from 1 to 100.", site?.line ?? 1, site?.col ?? 1, "Try: on_low_battery(20, \"warn_me\")");
      jobs.push({ kind: "low_battery", pct, task: needTask(args[1], site) });
      return NONE;
    },

    // Fire when you plug the charger in. on_charging("nice")
    on_charging: (args, site) => {
      needWindows("on_charging", site);
      jobs.push({ kind: "charging", task: needTask(args[0], site) });
      return NONE;
    },

    // Fire when you tap a key anywhere. on_hotkey("F8", "screenshot")
    on_hotkey: (args, site) => {
      needWindows("on_hotkey", site);
      const keyText = stringify(args[0] ?? NONE).trim();
      const vk = keyToVk(keyText, site);
      jobs.push({ kind: "hotkey", vk, key: keyText, task: needTask(args[1], site) });
      return NONE;
    },
  };

  // ===========================================================================
  // State readers — tiny spawnSync calls that report the CURRENT state. Each is
  // wrapped so a transient failure (e.g. a slow PowerShell start) just returns a
  // safe "nothing changed" value instead of throwing inside a timer.
  // ===========================================================================

  // Milliseconds since the user last touched mouse/keyboard, via GetLastInputInfo.
  function readIdleMs(): number {
    const script =
      'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }\npublic class Idle { [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); [DllImport("kernel32.dll")] public static extern uint GetTickCount(); }\n"@\n' +
      "$l = New-Object LASTINPUTINFO; $l.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($l); [void][Idle]::GetLastInputInfo([ref]$l); [Idle]::GetTickCount() - $l.dwTime";
    const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 8000 });
    const n = Number((r.stdout || "").trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  // The set of removable-drive letters currently present (e.g. {"E:", "F:"}).
  function readUsbDrives(): Set<string> {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object -ExpandProperty DeviceID"], { encoding: "utf8", timeout: 8000 });
    const set = new Set<string>();
    for (const line of (r.stdout || "").split(/\r?\n/)) { const d = line.trim(); if (d) set.add(d.toUpperCase()); }
    return set;
  }

  // Is a program with this image name running right now?
  function readRunning(image: string): boolean {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + image, "/NH"], { encoding: "utf8", timeout: 8000 });
    return (r.stdout || "").toLowerCase().includes(image.toLowerCase());
  }

  // Current wifi state: { connected, ssid }. ssid is "" when not on wifi.
  function readWifi(): { connected: boolean; ssid: string } {
    const r = spawnSync("netsh", ["wlan", "show", "interfaces"], { encoding: "utf8", timeout: 8000 });
    const out = r.stdout || "";
    let connected = false;
    let ssid = "";
    for (const line of out.split(/\r?\n/)) {
      // Match "State : connected" but not "Hosted network status".
      const st = line.match(/^\s*State\s*:\s*(.+?)\s*$/i);
      if (st) connected = /connected/i.test(st[1]) && !/disconnected/i.test(st[1]);
      // Match "SSID : Name" but not "BSSID".
      const ss = line.match(/^\s*SSID\s*:\s*(.+?)\s*$/i);
      if (ss) ssid = ss[1].trim();
    }
    if (!connected) ssid = "";
    return { connected, ssid };
  }

  // Current battery: { present, pct, charging }. Desktops report present=false.
  function readBattery(): { present: boolean; pct: number; charging: boolean } {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Battery | Select-Object -First 1 | ForEach-Object { \"$($_.EstimatedChargeRemaining)|$($_.BatteryStatus)\" }"], { encoding: "utf8", timeout: 8000 });
    const text = (r.stdout || "").trim();
    if (!text || !text.includes("|")) return { present: false, pct: 100, charging: false };
    const [pctStr, statusStr] = text.split("|");
    const pct = Number(pctStr.trim());
    const status = Number(statusStr.trim());
    if (!Number.isFinite(pct)) return { present: false, pct: 100, charging: false };
    // Win32_Battery.BatteryStatus: 2 = plugged in (AC), 6/7/8/9 = charging states.
    // 1 = discharging on battery. Anything that isn't "1" means power is coming in.
    const charging = status === 2 || status === 6 || status === 7 || status === 8 || status === 9;
    return { present: true, pct, charging };
  }

  // Is a virtual key currently held down? Uses GetAsyncKeyState's high bit.
  function readKeyDown(vk: number): boolean {
    const script =
      'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class Keys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }\n"@\n' +
      "if (([Keys]::GetAsyncKeyState(" + vk + ") -band 0x8000) -ne 0) { '1' } else { '0' }";
    const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 8000 });
    return (r.stdout || "").trim() === "1";
  }

  // ===========================================================================
  // start() — turn the registered jobs into live polling loops. We group jobs by
  // what they watch so we only read each signal once per tick, then fan the
  // result out to every job of that kind. Each loop keeps its own "last seen"
  // memory in a closure so it can detect the EDGE (the change), not the level.
  // ===========================================================================
  const start = (): void => {
    if (jobs.length === 0) return;

    const idleJobs = jobs.filter((j): j is Extract<Job, { kind: "idle" }> => j.kind === "idle");
    const backJobs = jobs.filter((j): j is Extract<Job, { kind: "back" }> => j.kind === "back");
    const usbJobs = jobs.filter((j): j is Extract<Job, { kind: "usb" }> => j.kind === "usb");
    const usbRemovedJobs = jobs.filter((j): j is Extract<Job, { kind: "usb_removed" }> => j.kind === "usb_removed");
    const openJobs = jobs.filter((j): j is Extract<Job, { kind: "open" }> => j.kind === "open");
    const closeJobs = jobs.filter((j): j is Extract<Job, { kind: "close" }> => j.kind === "close");
    const wifiJobs = jobs.filter((j): j is Extract<Job, { kind: "wifi" }> => j.kind === "wifi");
    const offlineJobs = jobs.filter((j): j is Extract<Job, { kind: "offline" }> => j.kind === "offline");
    const lowBattJobs = jobs.filter((j): j is Extract<Job, { kind: "low_battery" }> => j.kind === "low_battery");
    const chargingJobs = jobs.filter((j): j is Extract<Job, { kind: "charging" }> => j.kind === "charging");
    const hotkeyJobs = jobs.filter((j): j is Extract<Job, { kind: "hotkey" }> => j.kind === "hotkey");

    const summary: string[] = [];

    // --- idle / back: read idle ms once a second, share it with both loops ---
    if (idleJobs.length > 0 || backJobs.length > 0) {
      // Per idle-job memory: have we already fired for this stretch of idleness?
      const firedIdle = new Map<Extract<Job, { kind: "idle" }>, boolean>();
      for (const j of idleJobs) firedIdle.set(j, false);
      let wasIdle = false;   // for when_back: were we idle on the previous tick?
      timers.push(setInterval(() => {
        const ms = readIdleMs();
        // when_idle: fire once as idle crosses the threshold; re-arm when active again.
        for (const j of idleJobs) {
          if (ms >= j.ms && !firedIdle.get(j)) { firedIdle.set(j, true); run(j.task); }
          else if (ms < j.ms) firedIdle.set(j, false);
        }
        // when_back: fire when idle drops back near zero AFTER having been idle.
        const idleNow = ms >= 3000;             // "idle" once away for ~3s+
        if (wasIdle && ms < 1500) for (const j of backJobs) run(j.task);
        if (idleNow) wasIdle = true;
        else if (ms < 1500) wasIdle = false;
      }, 1000));
      for (const j of idleJobs) summary.push("when_idle " + Math.round(j.ms / 1000) + "s -> " + j.task);
      for (const j of backJobs) summary.push("when_back -> " + j.task);
    }

    // --- USB plugged / unplugged: diff the set of removable drives every ~2s ---
    if (usbJobs.length > 0 || usbRemovedJobs.length > 0) {
      let lastDrives = readUsbDrives();   // start from "what's already here"
      timers.push(setInterval(() => {
        const now = readUsbDrives();
        // A letter that's here now but wasn't before = a drive was plugged in.
        for (const d of now) if (!lastDrives.has(d)) { for (const j of usbJobs) run(j.task); break; }
        // A letter that was here but is gone now = a drive was unplugged.
        for (const d of lastDrives) if (!now.has(d)) { for (const j of usbRemovedJobs) run(j.task); break; }
        lastDrives = now;
      }, 2000));
      for (const j of usbJobs) summary.push("on_usb -> " + j.task);
      for (const j of usbRemovedJobs) summary.push("on_usb_removed -> " + j.task);
    }

    // --- app open / close: per-program running flag, checked every ~2s ---
    if (openJobs.length > 0 || closeJobs.length > 0) {
      // Track each distinct image only once, even if several jobs watch it.
      const watched = new Set<string>([...openJobs, ...closeJobs].map((j) => j.image.toLowerCase()));
      const lastRunning = new Map<string, boolean>();
      for (const img of watched) lastRunning.set(img, readRunning(img));   // seed with the current state
      timers.push(setInterval(() => {
        for (const img of watched) {
          const now = readRunning(img);
          const before = lastRunning.get(img) ?? false;
          if (now && !before) for (const j of openJobs) { if (j.image.toLowerCase() === img) run(j.task); }
          if (!now && before) for (const j of closeJobs) { if (j.image.toLowerCase() === img) run(j.task); }
          lastRunning.set(img, now);
        }
      }, 2000));
      for (const j of openJobs) summary.push("on_open " + j.image + " -> " + j.task);
      for (const j of closeJobs) summary.push("on_close " + j.image + " -> " + j.task);
    }

    // --- wifi joined / went offline: parse netsh every ~3s ---
    if (wifiJobs.length > 0 || offlineJobs.length > 0) {
      let last = readWifi();
      timers.push(setInterval(() => {
        const now = readWifi();
        // on_wifi: fire when the SSID becomes the one we're watching (it wasn't before).
        for (const j of wifiJobs) {
          if (now.connected && now.ssid === j.ssid && last.ssid !== j.ssid) run(j.task);
        }
        // on_offline: fire on the edge from connected -> not connected.
        if (last.connected && !now.connected) for (const j of offlineJobs) run(j.task);
        last = now;
      }, 3000));
      for (const j of wifiJobs) summary.push('on_wifi "' + j.ssid + '" -> ' + j.task);
      for (const j of offlineJobs) summary.push("on_offline -> " + j.task);
    }

    // --- battery low / charging: read EstimatedChargeRemaining every ~30s ---
    if (lowBattJobs.length > 0 || chargingJobs.length > 0) {
      let last = readBattery();
      timers.push(setInterval(() => {
        const now = readBattery();
        if (now.present) {
          // on_low_battery: fire on the downward crossing of the threshold.
          for (const j of lowBattJobs) {
            if (now.pct < j.pct && (!last.present || last.pct >= j.pct)) run(j.task);
          }
          // on_charging: fire on the edge from not-charging -> charging.
          if (now.charging && (!last.present || !last.charging)) for (const j of chargingJobs) run(j.task);
        }
        last = now;
      }, 30000));
      for (const j of lowBattJobs) summary.push("on_low_battery " + j.pct + "% -> " + j.task);
      for (const j of chargingJobs) summary.push("on_charging -> " + j.task);
    }

    // --- hotkeys: poll GetAsyncKeyState fast (~120ms) for a press edge ---
    if (hotkeyJobs.length > 0) {
      const wasDown = new Map<Extract<Job, { kind: "hotkey" }>, boolean>();
      for (const j of hotkeyJobs) wasDown.set(j, false);
      timers.push(setInterval(() => {
        for (const j of hotkeyJobs) {
          const down = readKeyDown(j.vk);
          if (down && !wasDown.get(j)) run(j.task);   // not-pressed -> pressed = a tap
          wasDown.set(j, down);
        }
      }, 120));
      for (const j of hotkeyJobs) summary.push("on_hotkey " + j.key + " -> " + j.task);
    }

    console.log("⚡ Triggers armed:");
    for (const s of summary) console.log("   " + s);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: [
      "when_idle", "when_back",
      "on_usb", "on_usb_removed",
      "on_open", "on_close",
      "on_wifi", "on_offline",
      "on_low_battery", "on_charging",
      "on_hotkey",
    ],
    builtins,
    isActive: () => jobs.length > 0,
    start,
  };
}
