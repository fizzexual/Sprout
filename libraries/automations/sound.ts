// libraries/automations/sound.ts — make sounds and tweak Windows from Sprout.
//
//   use "automations"
//   beep()                   ~ a quick 880Hz beep
//   beep(440, 500)           ~ a lower note for half a second
//   play_sound("ding.wav")   ~ play a .wav file sitting next to your program
//   mute_mic(yes)            ~ mute the microphone ;  mute_mic() toggles
//   show mic_muted()         ~ yes if the mic is muted
//   dnd(yes)                 ~ turn on Do Not Disturb (silence notifications)
//   show_desktop()           ~ flip to the desktop (and back) ; minimize_all()
//   focus_window("Notepad")  ~ bring a window to the front
//
// Everything here is a one-shot "do it now" action through PowerShell — it runs,
// does its thing on Windows, and returns. Nothing runs in the background, so
// isActive() is always false. These use Windows features, so they need Windows.

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
      throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "These sound & PC controls use Windows features.");
    }
  }

  // Run a short PowerShell command and hand back its stdout (trimmed).
  // We keep -NoProfile so it starts fast and ignores the user's profile script.
  function powershell(command: string, site: Site, timeout = 10000): { ok: boolean; out: string; err: string } {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", timeout });
    if (r.error) throw new LangError("Runtime", "I couldn't run that PC command: " + r.error.message, site?.line ?? 1, site?.col ?? 1, "Make sure PowerShell is available.");
    return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  }

  // Turn a Sprout value into a finite number, or a fallback when it isn't one.
  function asNumber(v: Value | undefined, fallback: number): number {
    const n = Math.round(Number(stringify(v ?? NONE)));
    return Number.isFinite(n) ? n : fallback;
  }

  // The C# snippet that reaches into Windows Core Audio. This is the SAME shape
  // as system.ts's AUDIO_CS, with one change: GetDefaultAudioEndpoint uses
  // flow=1 (eCapture) instead of 0 (eRender), so it targets the MICROPHONE.
  //
  // IMPORTANT: IAudioEndpointVolume must declare EXACTLY three placeholder
  // methods (f1/f2/f3 — really RegisterControlChangeNotify,
  // UnregisterControlChangeNotify and GetChannelCount) before the real methods,
  // so SetMute/GetMute land at the correct vtable slots.
  const MIC_CS = `
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
  int c1(); int c2(); int c3(); int c4();
  int SetMute(bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume ep); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f1(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class MicCtl {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; e.GetDefaultAudioEndpoint(1, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume ep; dev.Activate(ref iid, 1, IntPtr.Zero, out ep);
    return ep;
  }
  public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
  public static void SetMute(bool m) { Vol().SetMute(m, Guid.Empty); }
}
'@`;

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // --- beeps & sounds -----------------------------------------------------

    // Make the PC beep.
    //   beep()           -> a quick 880Hz beep for 200ms
    //   beep(440, 500)   -> a 440Hz note for half a second
    // Frequency is clamped to 37..32767 Hz; length to 1..5000 ms (what Beep allows).
    beep: (args, site) => {
      needWindows("beep", site);
      let freq = asNumber(args[0], 880);
      let ms = asNumber(args[1], 200);
      freq = Math.max(37, Math.min(32767, freq));
      ms = Math.max(1, Math.min(5000, ms));
      const r = powershell("[Console]::Beep(" + freq + "," + ms + ")", site);
      if (!r.ok) throw new LangError("Runtime", "I couldn't beep: " + (r.err || "audio error"), site?.line ?? 1, site?.col ?? 1, "Your system may not have a beep device.");
      return NONE;
    },

    // Play a sound file (a .wav works best) and wait for it to finish.
    //   play_sound("ding.wav")
    // The path is resolved next to your Sprout program, so a bare name works.
    play_sound: (args, site) => {
      needWindows("play_sound", site);
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) throw new LangError("Runtime", "play_sound needs a sound file.", site?.line ?? 1, site?.col ?? 1, 'Try: play_sound("ding.wav")');
      const abs = resolve(interp.programDir, name);
      const safe = abs.replace(/'/g, "''");
      // Check the file exists first (clear "couldn't find" error), then play it
      // synchronously so the beep/clip finishes before we return.
      const cmd =
        "if (-not (Test-Path -LiteralPath '" + safe + "')) { exit 7 }; " +
        "(New-Object System.Media.SoundPlayer '" + safe + "').PlaySync()";
      const r = powershell(cmd, site, 30000);
      if (!r.ok) {
        throw new LangError("Runtime", "I couldn't find that sound '" + name + "'.", site?.line ?? 1, site?.col ?? 1, "Make sure the .wav file sits next to your program.");
      }
      return NONE;
    },

    // --- microphone ---------------------------------------------------------

    // Mute or unmute the microphone.
    //   mute_mic()      -> toggle (flip whatever it is now)
    //   mute_mic(yes)   -> mute ;  mute_mic(no) -> unmute
    mute_mic: (args, site) => {
      needWindows("mute_mic", site);
      // No argument -> toggle the current state; otherwise use yes/no.
      const want = args.length === 0 ? "(-not [MicCtl]::GetMute())" : (isTruthy(args[0]) ? "$true" : "$false");
      const r = powershell(MIC_CS + "; [MicCtl]::SetMute(" + want + ")", site);
      if (!r.ok) throw new LangError("Runtime", "I couldn't change the mic: " + (r.err || "audio error"), site?.line ?? 1, site?.col ?? 1, "Make sure a microphone is connected.");
      return NONE;
    },

    // Is the microphone muted? -> yes / no
    mic_muted: (_args, site) => {
      needWindows("mic_muted", site);
      const r = powershell(MIC_CS + "; [MicCtl]::GetMute()", site);
      if (!r.ok) return NONE;   // no mic / not readable -> 'nothing', don't crash
      // PowerShell prints booleans as "True"/"False".
      return /true/i.test(r.out);
    },

    // --- notifications ------------------------------------------------------

    // Read or switch Do Not Disturb (silence Windows notification toasts).
    //   dnd()      -> yes if Do Not Disturb is on, no if notifications are allowed
    //   dnd(yes)   -> turn DND on (silence) ;  dnd(no) -> allow notifications
    // Windows stores ToastEnabled: 0 means toasts OFF, i.e. DND is ON.
    dnd: (args, site) => {
      needWindows("dnd", site);
      const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications";
      if (args.length === 0) {
        const r = spawnSync("reg", ["query", KEY, "/v", "ToastEnabled"], { encoding: "utf8", timeout: 8000 });
        // Find the trailing hex value; 0x0 => toasts off => DND on.
        const m = (r.stdout || "").match(/0x([0-9a-fA-F]+)/);
        const enabled = m ? parseInt(m[1], 16) : 1;
        return enabled === 0; // DND is on when notifications are disabled
      }
      const on = isTruthy(args[0]);
      const val = on ? "0" : "1"; // 0 = silence (DND on), 1 = allow notifications
      spawnSync("reg", ["add", KEY, "/v", "ToastEnabled", "/t", "REG_DWORD", "/d", val, "/f"], { encoding: "utf8", timeout: 8000 });
      return on;
    },

    // --- windows & desktop --------------------------------------------------

    // Show the desktop (toggle — call again to bring your windows back).
    show_desktop: (_args, site) => {
      needWindows("show_desktop", site);
      const r = powershell("(New-Object -ComObject Shell.Application).ToggleDesktop()", site);
      if (!r.ok) throw new LangError("Runtime", "I couldn't show the desktop: " + (r.err || "it failed"), site?.line ?? 1, site?.col ?? 1, "Try again in a moment.");
      return NONE;
    },

    // Minimize every open window.
    minimize_all: (_args, site) => {
      needWindows("minimize_all", site);
      const r = powershell("(New-Object -ComObject Shell.Application).MinimizeAll()", site);
      if (!r.ok) throw new LangError("Runtime", "I couldn't minimize the windows: " + (r.err || "it failed"), site?.line ?? 1, site?.col ?? 1, "Try again in a moment.");
      return NONE;
    },

    // Bring a window to the front by (part of) its title.
    //   focus_window("Notepad")  -> yes if a matching window was found and raised
    focus_window: (args, site) => {
      needWindows("focus_window", site);
      const title = stringify(args[0] ?? NONE).trim();
      if (!title) throw new LangError("Runtime", "focus_window needs a window title to aim at.", site?.line ?? 1, site?.col ?? 1, 'Try: focus_window("Notepad")');
      // Pass the title on stdin so quotes in it can't break the command.
      const stdin = title + "\n";
      const script =
        "Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic class SproutFocus{[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);}\n'@; " +
        "$title=[Console]::In.ReadLine(); " +
        "$p=Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like \"*$title*\" } | Select-Object -First 1; " +
        "if(-not $p){ exit 3 }; " +
        "[void][SproutFocus]::SetForegroundWindow($p.MainWindowHandle)";
      const res = spawnSync("powershell", ["-NoProfile", "-Command", script], { input: stdin, encoding: "utf8", timeout: 10000, windowsHide: true });
      if (res.error) throw new LangError("Runtime", "focus_window didn't work: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Make sure PowerShell is available.");
      if (res.status === 3) return false; // no matching window — just report "no"
      if (res.status !== 0) throw new LangError("Runtime", "focus_window didn't work: " + ((res.stderr || "").trim() || "it failed"), site?.line ?? 1, site?.col ?? 1, "Try again, or run as the active desktop user.");
      return true;
    },
  };

  return {
    names: ["beep", "play_sound", "mute_mic", "mic_muted", "dnd", "show_desktop", "minimize_all", "focus_window"],
    builtins,
    // Nothing here runs in the background.
    isActive: () => false,
    start: () => {},
  };
}
