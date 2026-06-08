// libraries/screen/index.ts — let Sprout SEE the screen and REACT to it.
//
//   use "screen"
//
// Take a snapshot of the screen, read pixels, find a colour, wait for something
// to appear — then move the mouse, click, or type. That's the engine behind
// watch-and-react helpers: auto-clickers, idle-game minders, accessibility
// scripts, and simple UI bots. It READS the screen and SENDS input (it never
// touches another program's memory).
//
//   use "screen"
//   make spot = find_color("#ff0000")     ~ where's the first red pixel?
//   when spot != nothing:
//       click(spot[0], spot[1])           ~ click it
//
// Windows only (uses System.Drawing to grab the screen). Captures the PRIMARY
// monitor. A snapshot takes ~0.4s, so loops poll a few times a second.

import type { Interpreter } from "../../src/interpreter.ts";
import { NONE, SList, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Site = { line: number; col: number } | undefined;

export function register(_interp: Interpreter) {
  const winOnly = (site: Site): never => {
    throw new LangError("Runtime", "the screen library is Windows-only for now.", site?.line ?? 1, site?.col ?? 1, "It uses Windows to grab the screen.");
  };

  // --- the current snapshot ------------------------------------------------
  type Frame = { w: number; h: number; off: number; rowSize: number; bytes: number; buf: Buffer };
  let frame: Frame | null = null;
  const bmpPath = join(tmpdir(), `sprout-screen-${process.pid}.bmp`);

  // Grab the primary screen into a 24-bit BMP, then read it back as raw pixels.
  function capture(site: Site): Frame {
    if (process.platform !== "win32") winOnly(site);
    const ps =
      "Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; " +
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height,([System.Drawing.Imaging.PixelFormat]::Format24bppRgb); " +
      "$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); " +
      "$bmp.Save(" + JSON.stringify(bmpPath) + ",[System.Drawing.Imaging.ImageFormat]::Bmp)";
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 });
    if (r.status !== 0 || !existsSync(bmpPath)) {
      throw new LangError("Runtime", "I couldn't take a snapshot of the screen.", site?.line ?? 1, site?.col ?? 1, "Make sure you're on a desktop (not a locked/headless session).");
    }
    const buf = readFileSync(bmpPath);
    if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
      throw new LangError("Runtime", "the screen snapshot came back unreadable.", site?.line ?? 1, site?.col ?? 1);
    }
    const off = buf.readUInt32LE(10), w = buf.readInt32LE(18), h = buf.readInt32LE(22), bpp = buf.readUInt16LE(28);
    const rowSize = Math.floor((bpp * w + 31) / 32) * 4, bytes = bpp / 8;
    frame = { w, h, off, rowSize, bytes, buf };
    return frame;
  }
  const current = (site: Site): Frame => frame ?? capture(site);
  // Pixel (x,y) as [r,g,b]. BMP rows are bottom-up.
  function rgbAt(f: Frame, x: number, y: number): [number, number, number] {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return [0, 0, 0];
    const i = f.off + (f.h - 1 - y) * f.rowSize + x * f.bytes;
    return [f.buf[i + 2], f.buf[i + 1], f.buf[i]];
  }

  // --- colours -------------------------------------------------------------
  const hex2 = (n: number): string => (n < 16 ? "0" : "") + n.toString(16);
  const toHex = (rgb: [number, number, number]): string => "#" + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
  const NAMED: Record<string, [number, number, number]> = {
    red: [255, 0, 0], green: [0, 128, 0], lime: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255],
    black: [0, 0, 0], yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128],
    pink: [255, 192, 203], cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128],
  };
  function parseColor(v: Value, site: Site): [number, number, number] {
    if (v instanceof SList && v.items.length >= 3) return [Number(v.items[0]) | 0, Number(v.items[1]) | 0, Number(v.items[2]) | 0];
    const s = stringify(v).trim().toLowerCase();
    if (s in NAMED) return NAMED[s];
    const hex = s.replace(/^#/, "");
    if (/^[0-9a-f]{6}$/.test(hex)) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    if (/^[0-9a-f]{3}$/.test(hex)) return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
    const parts = s.split(",").map((p) => parseInt(p.trim(), 10));
    if (parts.length === 3 && parts.every((n) => n >= 0 && n <= 255)) return [parts[0], parts[1], parts[2]];
    throw new LangError("Type", `I don't understand the colour ${JSON.stringify(stringify(v))}.`, site?.line ?? 1, site?.col ?? 1, 'Try a name ("red"), hex ("#ff0000"), or "255,0,0".');
  }
  const close = (a: [number, number, number], r: number, g: number, b: number, tol: number): boolean =>
    Math.abs(a[0] - r) <= tol && Math.abs(a[1] - g) <= tol && Math.abs(a[2] - b) <= tol;
  const num = (v: Value | undefined, def: number): number => (typeof v === "number" ? v : def);

  // Scan the current frame for the first pixel matching a colour.
  function scan(color: Value, tol: number, site: Site): [number, number] | null {
    const f = current(site);
    const [r, g, b] = parseColor(color, site);
    for (let y = 0; y < f.h; y++) {
      const rowStart = f.off + (f.h - 1 - y) * f.rowSize;
      for (let x = 0; x < f.w; x++) {
        const i = rowStart + x * f.bytes;
        if (Math.abs(f.buf[i + 2] - r) <= tol && Math.abs(f.buf[i + 1] - g) <= tol && Math.abs(f.buf[i] - b) <= tol) return [x, y];
      }
    }
    return null;
  }

  const sleep = (ms: number): void => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

  // --- input (move / click / type) — uses Windows to send real input -------
  function runPs(ps: string, site: Site): string {
    if (process.platform !== "win32") winOnly(site);
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 15000 });
    return (r.stdout || "").trim();
  }
  const MOUSE =
    "$s='[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);" +
    "[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);';" +
    "Add-Type -MemberDefinition $s -Name M -Namespace Win -PassThru | Out-Null;";
  function moveMouse(x: number, y: number, site: Site): void { runPs(MOUSE + `[Win.M]::SetCursorPos(${x | 0},${y | 0})`, site); }
  function clickAt(args: Value[], down: number, up: number, site: Site): void {
    let move = "";
    if (args.length >= 2 && typeof args[0] === "number" && typeof args[1] === "number") move = `[Win.M]::SetCursorPos(${args[0] | 0},${args[1] | 0}); Start-Sleep -Milliseconds 20; `;
    runPs(MOUSE + move + `[Win.M]::mouse_event(${down},0,0,0,0); [Win.M]::mouse_event(${up},0,0,0,0)`, site);
  }
  // SendKeys needs special chars escaped: + ^ % ~ ( ) { } [ ]
  const escKeys = (t: string): string => t.replace(/[+^%~(){}\[\]]/g, (c) => "{" + c + "}");

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Take a fresh snapshot of the screen. Other 'seeing' words use the latest one.
    look: (_args, site) => { capture(site); return NONE; },
    screen_width: (_args, site) => current(site).w,
    screen_height: (_args, site) => current(site).h,

    // The colour at a point, as hex ("#1a2b3c").
    pixel: (args, site) => { const f = current(site); return toHex(rgbAt(f, num(args[0], 0) | 0, num(args[1], 0) | 0)); },

    // Where is the first pixel of this colour?  -> [x, y]  (or nothing)
    find_color: (args, site) => { const hit = scan(args[0] ?? NONE, num(args[1], 16), site); return hit ? new SList([hit[0], hit[1]]) : NONE; },

    // Is this colour anywhere on screen right now?  -> yes / no
    sees_color: (args, site) => scan(args[0] ?? NONE, num(args[1], 16), site) !== null,

    // How many pixels match this colour (handy for "how much red is showing?").
    count_color: (args, site) => {
      const f = current(site); const [r, g, b] = parseColor(args[0] ?? NONE, site); const tol = num(args[1], 16); let n = 0;
      for (let y = 0; y < f.h; y++) {
        const rowStart = f.off + (f.h - 1 - y) * f.rowSize;
        for (let x = 0; x < f.w; x++) { const i = rowStart + x * f.bytes; if (Math.abs(f.buf[i + 2] - r) <= tol && Math.abs(f.buf[i + 1] - g) <= tol && Math.abs(f.buf[i] - b) <= tol) n++; }
      }
      return n;
    },

    // Keep snapshotting until the colour shows up.  -> [x, y]  (or nothing on timeout)
    wait_for_color: (args, site) => {
      const tol = num(args[1], 16); const secs = num(args[2], 10); const tries = Math.max(1, Math.round(secs * 4));
      for (let t = 0; t < tries; t++) { capture(site); const hit = scan(args[0] ?? NONE, tol, site); if (hit) return new SList([hit[0], hit[1]]); sleep(250); }
      return NONE;
    },

    // --- reacting ---
    move_to: (args, site) => { moveMouse(num(args[0], 0) | 0, num(args[1], 0) | 0, site); return NONE; },
    click: (args, site) => { clickAt(args, 0x02, 0x04, site); return NONE; },           // left down/up
    right_click: (args, site) => { clickAt(args, 0x08, 0x10, site); return NONE; },      // right down/up
    double_click: (args, site) => { clickAt(args, 0x02, 0x04, site); clickAt([], 0x02, 0x04, site); return NONE; },
    mouse: (_args, site) => {
      const out = runPs("Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output \"$($p.X),$($p.Y)\"", site);
      const [x, y] = out.split(",").map((n) => parseInt(n, 10) || 0);
      return new SList([x || 0, y || 0]);
    },
    press: (args, site) => { runPs("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(" + JSON.stringify("{" + stringify(args[0] ?? NONE).toUpperCase() + "}") + ")", site); return NONE; },
    type: (args, site) => { runPs("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(" + JSON.stringify(escKeys(stringify(args[0] ?? NONE))) + ")", site); return NONE; },

    // Pause (handy inside watch loops). Seconds.
    wait: (args, site) => { sleep(Math.max(0, Math.round(num(args[0], 0) * 1000))); return NONE; },
  };

  return {
    names: Object.keys(builtins),
    builtins,
    isActive: () => false,  // one-shots — no background work
    start: () => {},
  };
}

// The CLI expects each library to expose create(interp).
export function create(interp: Interpreter) {
  return register(interp);
}
