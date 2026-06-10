// libraries/automations/macros.ts — keyboard, mouse & screenshot macros.
//
//   use "automations"
//   type("Hello from Sprout!")        ~ types text into whatever has focus
//   press("ctrl+s")                   ~ press a key combo
//   screenshot("shot.png")            ~ snap the whole screen to a file
//   movemouse(400, 300)               ~ move the mouse pointer
//   click()                           ~ left-click (or click("right"))
//   make where = mousepos()           ~ -> [x, y]
//   copy_text("copied!")              ~ put text on the clipboard
//   show clipboard()                  ~ read the clipboard back
//   typeto("Notepad", "hi there")     ~ type into a named window
//
// Every macro here is a one-shot: it runs, does its thing on Windows, and
// returns. Nothing runs in the background, so isActive() is always false.
// These drive real Windows input, so they only work on Windows.

import { NONE, stringify, SList } from "../../src/interp/values.ts";
import type { Value } from "../../src/interp/values.ts";
import type { Interpreter } from "../../src/interp/interpreter.ts";
import { LangError } from "../../src/lang/errors.ts";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // Every macro is Windows-only — stop early with a friendly message elsewhere.
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") {
      throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "These macros drive real Windows keyboard/mouse input.");
    }
  }

  // Run a PowerShell command. We pass text in via stdin (so quoting never bites
  // us) and surface any error as a friendly Sprout error.
  function runPS(args: string[], input: string | undefined, site: Site, what: string): string {
    const res = spawnSync("powershell", args, { input, encoding: "utf8", timeout: 15000, windowsHide: true });
    if (res.error) {
      throw new LangError("Runtime", what + " didn't work: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Make sure PowerShell is available.");
    }
    if (res.status !== 0) {
      const msg = (res.stderr || "").trim() || "it failed";
      throw new LangError("Runtime", what + " didn't work: " + msg, site?.line ?? 1, site?.col ?? 1, "Try again, or run Sprout as the active desktop user.");
    }
    return res.stdout ?? "";
  }

  // SendKeys treats { } ( ) + ^ % ~ [ ] as special. To type them literally we
  // wrap each one in braces, e.g. "+" becomes "{+}". Everything else is sent as-is.
  function escapeSendKeys(text: string): string {
    let out = "";
    for (const ch of text) {
      if ("{}()+^%~[]".includes(ch)) out += "{" + ch + "}";
      else out += ch;
    }
    return out;
  }

  // Friendly key names -> the SendKeys token for that key.
  const NAMED_KEYS: Record<string, string> = {
    enter: "{ENTER}", return: "{ENTER}", esc: "{ESC}", escape: "{ESC}", tab: "{TAB}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
    f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
    up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
    home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
    del: "{DELETE}", delete: "{DELETE}", backspace: "{BACKSPACE}", back: "{BACKSPACE}",
    space: "{SPACE}", insert: "{INSERT}",
  };

  // Turn "ctrl+shift+s" into the SendKeys string "^+s". Modifiers become
  // ^ (ctrl) % (alt) + (shift); the last part is a named key or a literal char.
  function comboToSendKeys(combo: string, site: Site): string {
    const parts = combo.split("+").map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
    if (parts.length === 0) {
      throw new LangError("Runtime", "press needs a key or combo.", site?.line ?? 1, site?.col ?? 1, 'Try: press("ctrl+s")  or  press("enter")');
    }
    let prefix = "";
    let key = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      if (p === "ctrl" || p === "control") prefix += "^";
      else if (p === "alt") prefix += "%";
      else if (p === "shift") prefix += "+";
      else if (p === "win" || p === "windows") {
        // SendKeys can't press the Windows key; gently let the user know.
        throw new LangError("Runtime", "the Windows key isn't supported by press.", site?.line ?? 1, site?.col ?? 1, "Try a combo like ctrl, alt, or shift plus a key.");
      } else if (last) {
        key = NAMED_KEYS[p] ?? escapeSendKeys(p);
      } else {
        throw new LangError("Runtime", "I didn't understand the key '" + p + "'.", site?.line ?? 1, site?.col ?? 1, 'Use ctrl, alt, shift, or a key like "s" or "enter".');
      }
    }
    if (!key) {
      throw new LangError("Runtime", "press needs an actual key, not just modifiers.", site?.line ?? 1, site?.col ?? 1, 'Try: press("ctrl+s")');
    }
    return prefix + key;
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Type text into whatever window has focus, one keystroke at a time.
    type: (args, site) => {
      needWindows("type", site);
      const text = escapeSendKeys(stringify(args[0] ?? NONE));
      runPS(
        ["-NoProfile", "-STA", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([Console]::In.ReadToEnd())"],
        text, site, "type",
      );
      return NONE;
    },

    // Press a key combo like "ctrl+s", "alt+f4", or a single key like "enter".
    press: (args, site) => {
      needWindows("press", site);
      const keys = comboToSendKeys(stringify(args[0] ?? NONE), site);
      runPS(
        ["-NoProfile", "-STA", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([Console]::In.ReadToEnd())"],
        keys, site, "press",
      );
      return NONE;
    },

    // Save a screenshot to a file in the project folder. With no region it grabs
    // the whole (virtual) screen; with x, y, w, h it grabs just that rectangle.
    //   screenshot("shot.png")
    //   screenshot("corner.png", 0, 0, 200, 200)
    screenshot: (args, site) => {
      needWindows("screenshot", site);
      const file = stringify(args[0] ?? NONE).trim();
      if (!file) throw new LangError("Runtime", "screenshot needs a file name.", site?.line ?? 1, site?.col ?? 1, 'Try: screenshot("shot.png")');
      const path = resolve(interp.programDir, file);

      const hasRegion = args.length >= 5 && [1, 2, 3, 4].every((i) => typeof args[i] === "number" || !isNaN(Number(stringify(args[i] ?? NONE))));
      const num = (i: number): number => Math.round(Number(stringify(args[i] ?? NONE)));

      // Pass the geometry + path to PowerShell via stdin as four/five lines.
      let stdin: string;
      let script: string;
      if (hasRegion) {
        stdin = num(1) + "\n" + num(2) + "\n" + num(3) + "\n" + num(4) + "\n" + path + "\n";
        script =
          "Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; " +
          "$lines=@(); while(($l=[Console]::In.ReadLine()) -ne $null){$lines+=$l}; " +
          "$x=[int]$lines[0]; $y=[int]$lines[1]; $w=[int]$lines[2]; $h=[int]$lines[3]; $p=$lines[4]; " +
          "if($w -le 0 -or $h -le 0){throw 'width and height must be positive'}; " +
          "$bmp=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($bmp); " +
          "$g.CopyFromScreen($x,$y,0,0,(New-Object System.Drawing.Size($w,$h))); " +
          "$bmp.Save($p,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()";
      } else {
        stdin = path + "\n";
        script =
          "Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; " +
          "$p=[Console]::In.ReadLine(); " +
          "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
          "$bmp=New-Object System.Drawing.Bitmap $vs.Width,$vs.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); " +
          "$g.CopyFromScreen($vs.Left,$vs.Top,0,0,(New-Object System.Drawing.Size($vs.Width,$vs.Height))); " +
          "$bmp.Save($p,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()";
      }
      runPS(["-NoProfile", "-STA", "-Command", script], stdin, site, "screenshot");
      return file;
    },

    // Put text onto the Windows clipboard.
    copy_text: (args, site) => {
      needWindows("copy_text", site);
      const text = stringify(args[0] ?? NONE);
      runPS(
        ["-NoProfile", "-STA", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText([Console]::In.ReadToEnd())"],
        text, site, "copy_text",
      );
      return NONE;
    },

    // Read the current clipboard text. Empty clipboard -> nothing.
    clipboard: (args, site) => {
      needWindows("clipboard", site);
      const out = runPS(
        ["-NoProfile", "-STA", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; $t=[System.Windows.Forms.Clipboard]::GetText(); [Console]::Out.Write($t)"],
        undefined, site, "clipboard",
      );
      return out.length > 0 ? out : NONE;
    },

    // Move the mouse pointer to an absolute screen position.
    movemouse: (args, site) => {
      needWindows("movemouse", site);
      const x = Math.round(Number(stringify(args[0] ?? NONE)));
      const y = Math.round(Number(stringify(args[1] ?? NONE)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new LangError("Runtime", "movemouse needs an x and a y number.", site?.line ?? 1, site?.col ?? 1, "Try: movemouse(400, 300)");
      }
      const stdin = x + "\n" + y + "\n";
      const script =
        "Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic class SproutMouse{[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);}\n'@; " +
        "$x=[int][Console]::In.ReadLine(); $y=[int][Console]::In.ReadLine(); [void][SproutMouse]::SetCursorPos($x,$y)";
      runPS(["-NoProfile", "-Command", script], stdin, site, "movemouse");
      return NONE;
    },

    // Click the mouse where it is now. click() = left, click("right") = right.
    click: (args, site) => {
      needWindows("click", site);
      const button = stringify(args[0] ?? NONE).trim().toLowerCase();
      const right = button === "right" || button === "r";
      // mouse_event flags: LEFTDOWN=0x02 LEFTUP=0x04 RIGHTDOWN=0x08 RIGHTUP=0x10
      const down = right ? "0x08" : "0x02";
      const up = right ? "0x10" : "0x04";
      const script =
        "Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic class SproutClick{[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);}\n'@; " +
        "[SproutClick]::mouse_event(" + down + ",0,0,0,[IntPtr]::Zero); [SproutClick]::mouse_event(" + up + ",0,0,0,[IntPtr]::Zero)";
      runPS(["-NoProfile", "-Command", script], undefined, site, "click");
      return NONE;
    },

    // Where is the mouse right now? -> [x, y].
    mousepos: (args, site) => {
      needWindows("mousepos", site);
      const out = runPS(
        ["-NoProfile", "-STA", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; [Console]::Out.Write(\"$($p.X) $($p.Y)\")"],
        undefined, site, "mousepos",
      ).trim();
      const parts = out.split(/\s+/);
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      return new SList([Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0]);
    },

    // Bring a window to the front by (part of) its title, then type into it.
    //   typeto("Notepad", "Hello!")
    typeto: (args, site) => {
      needWindows("typeto", site);
      const title = stringify(args[0] ?? NONE).trim();
      const text = escapeSendKeys(stringify(args[1] ?? NONE));
      if (!title) throw new LangError("Runtime", "typeto needs a window title to aim at.", site?.line ?? 1, site?.col ?? 1, 'Try: typeto("Notepad", "Hello!")');
      // Pass the title on line 1 and the (already escaped) keys on line 2.
      const stdin = title + "\n" + text + "\n";
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic class SproutWin{[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);}\n'@; " +
        "$title=[Console]::In.ReadLine(); $keys=[Console]::In.ReadLine(); " +
        "$p=Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like \"*$title*\" } | Select-Object -First 1; " +
        "if(-not $p){ [Console]::Error.Write('no window titled like that'); exit 3 }; " +
        "[void][SproutWin]::SetForegroundWindow($p.MainWindowHandle); Start-Sleep -Milliseconds 200; " +
        "[System.Windows.Forms.SendKeys]::SendWait($keys)";
      const res = spawnSync("powershell", ["-NoProfile", "-STA", "-Command", script], { input: stdin, encoding: "utf8", timeout: 15000, windowsHide: true });
      if (res.error) throw new LangError("Runtime", "typeto didn't work: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Make sure PowerShell is available.");
      if (res.status === 3) throw new LangError("Runtime", "I couldn't find a window titled like '" + title + "'.", site?.line ?? 1, site?.col ?? 1, "Open the app first, then check the window's title.");
      if (res.status !== 0) throw new LangError("Runtime", "typeto didn't work: " + ((res.stderr || "").trim() || "it failed"), site?.line ?? 1, site?.col ?? 1, "Try again, or run as the active desktop user.");
      return NONE;
    },
  };

  return {
    names: ["type", "press", "screenshot", "copy_text", "clipboard", "movemouse", "click", "mousepos", "typeto"],
    builtins,
    isActive: () => false,
    start: () => {},
  };
}
