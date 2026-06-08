// libraries/recorder/index.ts — record your mouse + keyboard, then replay it.
//
//   use "recorder"
//   record("my-macro.txt")     ~ records everything until you press ESC
//   play("my-macro.txt")       ~ does it all again, with the same timing
//
// It captures EVERY mouse move, click, and key press/hold (with timing) into a
// plain text file, then plays it back exactly. While it works, a small banner
// floats on top so you always know it's recording or replaying. It records and
// sends real input; it never touches another program's memory.
//
// Windows only. Press ESC to stop recording.

import type { Interpreter } from "../../src/interpreter.ts";
import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

// A small always-on-top, click-through banner so you can SEE the state.
// $Color is "Red" (recording) or "Lime" (playing); $Msg is the text.
const BANNER = `
$banner=New-Object System.Windows.Forms.Form
$banner.FormBorderStyle='None'; $banner.StartPosition='Manual'; $banner.TopMost=$true; $banner.ShowInTaskbar=$false
$banner.BackColor=[System.Drawing.Color]::FromArgb(18,18,18)
$banner.Size=New-Object System.Drawing.Size(360,42)
$scr=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$banner.Location=New-Object System.Drawing.Point([int]($scr.Width/2-180),14)
$bl=New-Object System.Windows.Forms.Label
$bl.Dock='Fill'; $bl.ForeColor=[System.Drawing.Color]::FromName($Color); $bl.TextAlign='MiddleCenter'
$bl.Font=New-Object System.Drawing.Font('Segoe UI',12,[System.Drawing.FontStyle]::Bold)
$bl.Text=$Msg
$banner.Controls.Add($bl)
$banner.Show()
$ex=[Native]::GetWindowLong($banner.Handle,-20)
[void][Native]::SetWindowLong($banner.Handle,-20,($ex -bor 0x80000 -bor 0x20))
[System.Windows.Forms.Application]::DoEvents()
`;

// Captures mouse + every key/button up-down (global) until ESC, ~125x/s.
const RECORDER_PS = `param([string]$Path,[int]$Timeout=0)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$src=@'
using System;
using System.Runtime.InteropServices;
public class Native {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h,int i,int v);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
Add-Type -TypeDefinition $src
$Color='Red'; $Msg='  * Recording -- press ESC to stop'
${BANNER}
$sw=[System.Diagnostics.Stopwatch]::StartNew()
$state=New-Object 'bool[]' 256
$lx=-99999;$ly=-99999
$lines=New-Object System.Collections.Generic.List[string]
while($true){
  [System.Windows.Forms.Application]::DoEvents()
  $t=[int]$sw.ElapsedMilliseconds
  if(((([Native]::GetAsyncKeyState(27)) -band 0x8000)) -ne 0){break}
  $p=New-Object Native+POINT
  [void][Native]::GetCursorPos([ref]$p)
  if($p.X -ne $lx -or $p.Y -ne $ly){$lines.Add("$t m $($p.X) $($p.Y)");$lx=$p.X;$ly=$p.Y}
  for($k=1;$k -le 254;$k++){
    if($k -eq 27){continue}
    $d=(((([Native]::GetAsyncKeyState($k)) -band 0x8000)) -ne 0)
    if($d -ne $state[$k]){$state[$k]=$d; if($d){$lines.Add("$t d $k")}else{$lines.Add("$t u $k")}}
  }
  Start-Sleep -Milliseconds 8
  if($Timeout -gt 0 -and $sw.ElapsedMilliseconds -ge $Timeout){break}
}
$banner.Close()
$tmp=[System.IO.Path]::GetTempFileName()
Set-Content -Path $tmp -Value $lines -Encoding ASCII
Move-Item -Path $tmp -Destination $Path -Force
`;

// Replays a recorded file with the original timing, showing a "Playing" banner.
const PLAYER_PS = `param([string]$Path,[int]$Times=1)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$src=@'
using System;
using System.Runtime.InteropServices;
public class Native {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint f,IntPtr e);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h,int i,int v);
}
'@
Add-Type -TypeDefinition $src
$Color='Lime'; $Msg='  > Playing back...'
${BANNER}
$lines=Get-Content -Path $Path
for($n=0;$n -lt $Times;$n++){
  $sw=[System.Diagnostics.Stopwatch]::StartNew()
  foreach($line in $lines){
    if([string]::IsNullOrWhiteSpace($line)){continue}
    [System.Windows.Forms.Application]::DoEvents()
    $a=$line.Split(' ')
    $t=[int]$a[0];$ty=$a[1]
    while($sw.ElapsedMilliseconds -lt $t){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 1}
    if($ty -eq 'm'){[void][Native]::SetCursorPos([int]$a[2],[int]$a[3])}
    elseif($ty -eq 'd'){
      $vk=[int]$a[2]
      if($vk -eq 1){[Native]::mouse_event(0x02,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 2){[Native]::mouse_event(0x08,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 4){[Native]::mouse_event(0x20,0,0,0,[IntPtr]::Zero)}
      else{$ext=(($vk -ge 33 -and $vk -le 46) -or $vk -eq 91 -or $vk -eq 92);$f=0;if($ext){$f=1};[Native]::keybd_event([byte]$vk,0,$f,[IntPtr]::Zero)}
    }
    elseif($ty -eq 'u'){
      $vk=[int]$a[2]
      if($vk -eq 1){[Native]::mouse_event(0x04,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 2){[Native]::mouse_event(0x10,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 4){[Native]::mouse_event(0x40,0,0,0,[IntPtr]::Zero)}
      else{$ext=(($vk -ge 33 -and $vk -le 46) -or $vk -eq 91 -or $vk -eq 92);$f=2;if($ext){$f=3};[Native]::keybd_event([byte]$vk,0,$f,[IntPtr]::Zero)}
    }
  }
}
$banner.Close()
`;

export function register(interp: Interpreter) {
  const winOnly = (site: Site): never => {
    throw new LangError("Runtime", "the recorder library is Windows-only for now.", site?.line ?? 1, site?.col ?? 1, "It uses Windows' input APIs.");
  };
  const num = (v: Value | undefined, def: number): number => (typeof v === "number" ? v : def);
  const filePath = (v: Value | undefined, site: Site): string => {
    const name = stringify(v ?? NONE).trim();
    if (!name) throw new LangError("Runtime", "I need a file name.", site?.line ?? 1, site?.col ?? 1, 'Try: record("my-macro.txt")');
    return resolve(interp.programDir || process.cwd(), name);
  };

  // Run a helper script (written to temp). stderr is captured so a real error
  // surfaces; the floating banner is the user-facing feedback, so no console needed.
  function runScript(script: string, kind: string, args: string[], site: Site): void {
    if (process.platform !== "win32") winOnly(site);
    const ps = join(tmpdir(), `sprout-recorder-${process.pid}-${kind}.ps1`);
    writeFileSync(ps, script);
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps, ...args], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.error) throw new LangError("Runtime", "couldn't run the recorder: " + r.error.message, site?.line ?? 1, site?.col ?? 1);
    if (r.status !== 0) throw new LangError("Runtime", "the recorder had a problem: " + ((r.stderr || "").split("\n")[0] || "unknown"), site?.line ?? 1, site?.col ?? 1);
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    record: (args, site) => {
      const file = filePath(args[0], site);
      const ms = Math.max(0, Math.round(num(args[1], 0) * 1000));
      runScript(RECORDER_PS, "rec", ["-Path", file, "-Timeout", String(ms)], site);
      return NONE;
    },
    play: (args, site) => {
      const file = filePath(args[0], site);
      const times = Math.max(1, Math.round(num(args[1], 1)));
      runScript(PLAYER_PS, "play", ["-Path", file, "-Times", String(times)], site);
      return NONE;
    },
    wait: (args, site) => {
      const ms = Math.max(0, Math.round(num(args[0], 0) * 1000));
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return NONE;
    },
  };

  return { names: Object.keys(builtins), builtins, isActive: () => false, start: () => {} };
}

export function create(interp: Interpreter) {
  return register(interp);
}
