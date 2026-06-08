// libraries/automations/system.ts — control your Windows PC from Sprout.
//
//   use "automations"
//   volume(50)            ~ set the speakers to 50%
//   show volume()         ~ read the current volume (0-100)
//   mute()                ~ toggle mute on/off
//   darkmode(yes)         ~ switch Windows to dark mode
//   wallpaper("sky.jpg")  ~ set the desktop background
//   say("hello there")    ~ speak text out loud
//   keepawake(yes)        ~ stop the PC from sleeping until keepawake(no)
//
// Almost everything here is a one-shot "do it now" action that returns straight
// away. The one exception is keepawake, which keeps a tiny heartbeat going in the
// background (so isActive() stays true while it's on).

import { NONE, stringify, isTruthy } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // --- shared little helpers -------------------------------------------------

  // Everything in this module needs Windows. One friendly gate for them all.
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") {
      throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "These PC controls use Windows features.");
    }
  }

  // Run a short PowerShell command and hand back its stdout (trimmed).
  // We keep -NoProfile so it starts fast and ignores the user's profile script.
  function powershell(command: string, site: Site, timeout = 10000): { ok: boolean; out: string; err: string } {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", timeout });
    if (r.error) throw new LangError("Runtime", "I couldn't run that PC command: " + r.error.message, site?.line ?? 1, site?.col ?? 1, "Make sure PowerShell is available.");
    return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  }

  // Turn a number (seconds) or friendly text ("10 minutes", "2h", "1 day") into seconds.
  function parseDuration(v: Value | undefined, site: Site): number {
    if (typeof v === "number") return v;
    const s = stringify(v ?? NONE).trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
    if (!m) throw new LangError("Runtime", "I couldn't understand the time '" + s + "'.", site?.line ?? 1, site?.col ?? 1, 'Use seconds, or text like "10 minutes".');
    const n = Number(m[1]);
    const u = (m[2] || "s")[0];
    const mult = u === "d" ? 86400 : u === "h" ? 3600 : u === "m" ? 60 : 1;
    return n * mult;
  }

  // The C# snippet (used by volume) that reaches into Windows Core Audio so we can
  // read and set the master volume as a 0..1 scalar. Defined once, reused below.
  const AUDIO_CS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f1(); int f2(); int f3();
  int SetMasterVolumeLevel(float level, Guid ctx);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetMute(bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume ep); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f1(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class AudioCtl {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume ep; dev.Activate(ref iid, 1, IntPtr.Zero, out ep);
    return ep;
  }
  public static float Get() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v) { Vol().SetMasterVolumeLevelScalar(v, Guid.Empty); }
}
'@`;

  // We remember whether WE last muted the PC. Real mute state is awkward to read
  // reliably across devices, so this best-effort flag is what muted() reports.
  let mutedFlag = false;

  // --- keepawake background heartbeat ---------------------------------------
  // While "on", a timer fires every ~50s and tells Windows to stay awake. The
  // timer keeps the Node event loop alive, so isActive() reports true.
  let awakeTimer: ReturnType<typeof setInterval> | null = null;

  function pokeAwake(): void {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED = 0x80000003.
    // Each call resets the idle timers without permanently changing settings.
    spawnSync("powershell", ["-NoProfile", "-Command",
      "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name P -Namespace W; [W.P]::SetThreadExecutionState(0x80000003) | Out-Null"],
      { encoding: "utf8", timeout: 8000 });
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // --- speakers -----------------------------------------------------------

    // Read or set the speaker volume.
    //   volume()    -> the current level, a whole number 0-100
    //   volume(40)  -> set it to 40% (returns nothing)
    volume: (args, site) => {
      needWindows("volume", site);
      if (args.length === 0) {
        // READ: ask Core Audio for the 0..1 scalar and scale to 0-100.
        const r = powershell(AUDIO_CS + "; [Math]::Round([AudioCtl]::Get() * 100)", site);
        if (!r.ok) return NONE;   // reading volume can fail on some devices — give 'nothing', don't crash
        const n = Math.round(Number(r.out));
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : NONE;
      }
      // SET: clamp to 0-100, hand Core Audio a 0..1 scalar.
      let n = Math.round(Number(stringify(args[0] ?? NONE)));
      if (!Number.isFinite(n)) throw new LangError("Runtime", "volume needs a number from 0 to 100.", site?.line ?? 1, site?.col ?? 1, "Try: volume(50)");
      n = Math.max(0, Math.min(100, n));
      const r = powershell(AUDIO_CS + "; [AudioCtl]::Set(" + (n / 100) + ")", site);
      if (!r.ok) throw new LangError("Runtime", "I couldn't set the volume: " + (r.err || "audio error"), site?.line ?? 1, site?.col ?? 1, "Your audio device may not support this.");
      return NONE;
    },

    // Mute or unmute the speakers.
    //   mute()      -> toggle (flip whatever it is now)
    //   mute(yes)   -> mute ;  mute(no) -> unmute
    // Sends the system "mute" media key, which toggles. To force a state we only
    // tap the key when our tracked flag disagrees with what was asked for.
    mute: (args, site) => {
      needWindows("mute", site);
      const want = args.length === 0 ? !mutedFlag : isTruthy(args[0]);
      if (want !== mutedFlag) {
        // [char]173 is the "volume mute" virtual key; SendKeys toggles mute.
        powershell("(New-Object -ComObject WScript.Shell).SendKeys([char]173)", site);
        mutedFlag = want;
      }
      return NONE;
    },

    // Is the PC muted (as far as we know)? -> yes / no  (best-effort)
    muted: () => mutedFlag,

    // --- power & session ----------------------------------------------------

    // Shut the PC down after a delay, or cancel a pending shutdown.
    //   shutdown("5 minutes")  -> shut down in 5 minutes
    //   shutdown(no)           -> cancel the scheduled shutdown
    shutdown: (args, site) => {
      needWindows("shutdown", site);
      const a = args[0];
      if (a != null && !isTruthy(a)) { spawnSync("shutdown", ["/a"], { encoding: "utf8", timeout: 8000 }); return NONE; }
      const secs = Math.max(0, Math.round(parseDuration(a, site)));
      const r = spawnSync("shutdown", ["/s", "/t", String(secs)], { encoding: "utf8", timeout: 8000 });
      if (r.status !== 0) throw new LangError("Runtime", "I couldn't schedule the shutdown: " + ((r.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Try shutdown(no) to cancel a previous one first.");
      return NONE;
    },

    // Restart the PC after a delay, or cancel a pending restart.
    //   restart("1 minute")  ;  restart(no)  -> cancel
    restart: (args, site) => {
      needWindows("restart", site);
      const a = args[0];
      if (a != null && !isTruthy(a)) { spawnSync("shutdown", ["/a"], { encoding: "utf8", timeout: 8000 }); return NONE; }
      const secs = Math.max(0, Math.round(parseDuration(a, site)));
      const r = spawnSync("shutdown", ["/r", "/t", String(secs)], { encoding: "utf8", timeout: 8000 });
      if (r.status !== 0) throw new LangError("Runtime", "I couldn't schedule the restart: " + ((r.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Try restart(no) to cancel a previous one first.");
      return NONE;
    },

    // Put the PC to sleep right now.
    sleep: (_args, site) => {
      needWindows("sleep", site);
      spawnSync("rundll32", ["powrprof.dll,SetSuspendState", "0,1,0"], { encoding: "utf8", timeout: 8000 });
      return NONE;
    },

    // Lock the screen (like pressing Win+L).
    lock: (_args, site) => {
      needWindows("lock", site);
      spawnSync("rundll32", ["user32.dll,LockWorkStation"], { encoding: "utf8", timeout: 8000 });
      return NONE;
    },

    // --- appearance ---------------------------------------------------------

    // Read or switch Windows dark mode.
    //   darkmode()     -> yes if dark, no if light
    //   darkmode(yes)  -> turn dark mode on ;  darkmode(no) -> light mode
    // Windows stores this backwards: AppsUseLightTheme = 0 means DARK.
    darkmode: (args, site) => {
      needWindows("darkmode", site);
      const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
      if (args.length === 0) {
        const r = spawnSync("reg", ["query", KEY, "/v", "AppsUseLightTheme"], { encoding: "utf8", timeout: 8000 });
        // Find the trailing hex value; 0x0 => light theme OFF => dark mode ON.
        const m = (r.stdout || "").match(/0x([0-9a-fA-F]+)/);
        const light = m ? parseInt(m[1], 16) : 1;
        return light === 0; // dark mode is on when the "use light theme" flag is 0
      }
      const dark = isTruthy(args[0]);
      const val = dark ? "0" : "1"; // 0 = dark, 1 = light
      for (const name of ["AppsUseLightTheme", "SystemUsesLightTheme"]) {
        spawnSync("reg", ["add", KEY, "/v", name, "/t", "REG_DWORD", "/d", val, "/f"], { encoding: "utf8", timeout: 8000 });
      }
      return dark;
    },

    // Set the desktop wallpaper to an image file.
    //   wallpaper("photo.jpg")  -> returns the file name it used
    // The path is resolved next to your Sprout program, so a bare name works.
    wallpaper: (args, site) => {
      needWindows("wallpaper", site);
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) throw new LangError("Runtime", "wallpaper needs an image file.", site?.line ?? 1, site?.col ?? 1, 'Try: wallpaper("sky.jpg")');
      const abs = resolve(interp.programDir, name);
      // P/Invoke SystemParametersInfo: action 20 (SET DESKTOP WALLPAPER), flag 3
      // (update + save the change).
      const cmd =
        "Add-Type -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true)] public static extern bool SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);' -Name W -Namespace P; " +
        "if (-not (Test-Path -LiteralPath '" + abs.replace(/'/g, "''") + "')) { exit 7 }; " +
        "[P.W]::SystemParametersInfo(20, 0, '" + abs.replace(/'/g, "''") + "', 3) | Out-Null";
      const r = powershell(cmd, site);
      if (!r.ok) {
        throw new LangError("Runtime", "I couldn't find or set the wallpaper '" + name + "'.", site?.line ?? 1, site?.col ?? 1, "Make sure the image file sits next to your program.");
      }
      // Return just the file name (last path part) so it reads nicely.
      const base = abs.split(/[\\/]/).pop() || name;
      return base;
    },

    // --- clipboard ----------------------------------------------------------

    // Read or set the clipboard.
    //   clipboard()         -> the current clipboard text
    //   clipboard("hello")  -> copy text to the clipboard (returns nothing)
    clipboard: (args, site) => {
      needWindows("clipboard", site);
      if (args.length === 0) {
        const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], { encoding: "utf8", timeout: 8000 });
        if (r.error) throw new LangError("Runtime", "I couldn't read the clipboard: " + r.error.message, site?.line ?? 1, site?.col ?? 1);
        // Get-Clipboard adds a trailing newline; strip CR/LF from the end.
        return (r.stdout ?? "").replace(/\r?\n$/, "");
      }
      const text = stringify(args[0] ?? NONE);
      const r = spawnSync("clip", [], { input: text, encoding: "utf8", timeout: 8000 });
      if (r.error) throw new LangError("Runtime", "I couldn't set the clipboard: " + r.error.message, site?.line ?? 1, site?.col ?? 1);
      return NONE;
    },

    // --- screen brightness --------------------------------------------------

    // Read or set the screen brightness (laptops / supported monitors).
    //   brightness()    -> current brightness 0-100
    //   brightness(70)  -> set it to 70% (returns nothing)
    brightness: (args, site) => {
      needWindows("brightness", site);
      if (args.length === 0) {
        const r = powershell("(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness", site);
        if (!r.ok || r.out === "") throw new LangError("Runtime", "I couldn't read the brightness on this screen.", site?.line ?? 1, site?.col ?? 1, "Brightness control needs a laptop or supported monitor.");
        const n = Math.round(Number((r.out.split(/\r?\n/)[0] || "").trim()));
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
      }
      let n = Math.round(Number(stringify(args[0] ?? NONE)));
      if (!Number.isFinite(n)) throw new LangError("Runtime", "brightness needs a number from 0 to 100.", site?.line ?? 1, site?.col ?? 1, "Try: brightness(60)");
      n = Math.max(0, Math.min(100, n));
      const r = powershell("(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1," + n + ")", site);
      if (!r.ok) throw new LangError("Runtime", "I couldn't set the brightness on this screen.", site?.line ?? 1, site?.col ?? 1, "Brightness control needs a laptop or supported monitor.");
      return NONE;
    },

    // --- keep the PC awake (background) -------------------------------------

    // Stop the PC from sleeping or dimming until you turn it back off.
    //   keepawake(yes)  -> stay awake (a quiet heartbeat keeps Sprout running)
    //   keepawake(no)   -> let it sleep again
    keepawake: (args, site) => {
      needWindows("keepawake", site);
      const on = args.length === 0 ? true : isTruthy(args[0]);
      if (on) {
        if (!awakeTimer) {
          pokeAwake(); // do it now so there's no ~50s gap before the first poke
          awakeTimer = setInterval(pokeAwake, 50000);
        }
      } else if (awakeTimer) {
        clearInterval(awakeTimer);
        awakeTimer = null;
        // Clear the "keep awake" request so normal power settings resume.
        spawnSync("powershell", ["-NoProfile", "-Command",
          "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name P -Namespace W; [W.P]::SetThreadExecutionState(0x80000000) | Out-Null"],
          { encoding: "utf8", timeout: 8000 });
      }
      return NONE;
    },

    // --- speech -------------------------------------------------------------

    // Speak text out loud using the Windows voice.
    //   say("hello there")
    say: (args, site) => {
      needWindows("say", site);
      const text = stringify(args[0] ?? NONE);
      if (!text) return NONE;
      // Read the text from stdin so quotes/newlines in it can't break the command.
      const r = spawnSync("powershell", ["-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())"],
        { input: text, encoding: "utf8", timeout: 30000 });
      if (r.error) throw new LangError("Runtime", "I couldn't speak that: " + r.error.message, site?.line ?? 1, site?.col ?? 1, "Speech works on Windows.");
      return NONE;
    },
  };

  return {
    names: ["volume", "mute", "muted", "shutdown", "restart", "sleep", "lock", "darkmode", "wallpaper", "clipboard", "brightness", "keepawake", "say"],
    builtins,
    // Background work is on only while keepawake is running.
    isActive: () => awakeTimer !== null,
    start: () => {},
  };
}
