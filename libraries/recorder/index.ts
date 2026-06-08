// libraries/recorder/index.ts — record your mouse + keyboard, then replay it.
//
//   use "recorder"
//   record("my-macro.txt")     ~ records everything until you press ESC
//   play("my-macro.txt")       ~ does it all again, with the same timing
//
// It captures EVERY mouse move, click, and key press/hold (with timing) into a
// plain text file, then plays it back exactly. Great for repetitive tasks — fill
// the same form, do the same clicks, practise a routine. It records and sends
// real input; it never touches another program's memory.
//
// Windows only (uses Windows' own input APIs). Press ESC to stop recording.

import type { Interpreter } from "../../src/interpreter.ts";
import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

// Captures mouse position + every key/button up-down (global) until ESC, ~125x/s.
const RECORDER_PS = `param([string]$Path,[int]$Timeout=0)
$src=@'
using System;
using System.Runtime.InteropServices;
public class Rec {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
Add-Type -TypeDefinition $src
$sw=[System.Diagnostics.Stopwatch]::StartNew()
$state=New-Object 'bool[]' 256
$lx=-99999;$ly=-99999
$lines=New-Object System.Collections.Generic.List[string]
Write-Host "Recording your mouse + keyboard. Press ESC to stop."
while($true){
  $t=[int]$sw.ElapsedMilliseconds
  if(((([Rec]::GetAsyncKeyState(27)) -band 0x8000)) -ne 0){break}
  $p=New-Object Rec+POINT
  [void][Rec]::GetCursorPos([ref]$p)
  if($p.X -ne $lx -or $p.Y -ne $ly){$lines.Add("$t m $($p.X) $($p.Y)");$lx=$p.X;$ly=$p.Y}
  for($k=1;$k -le 254;$k++){
    if($k -eq 27){continue}
    $d=(((([Rec]::GetAsyncKeyState($k)) -band 0x8000)) -ne 0)
    if($d -ne $state[$k]){$state[$k]=$d; if($d){$lines.Add("$t d $k")}else{$lines.Add("$t u $k")}}
  }
  Start-Sleep -Milliseconds 8
  if($Timeout -gt 0 -and $sw.ElapsedMilliseconds -ge $Timeout){break}
}
Set-Content -Path $Path -Value $lines -Encoding ASCII
Write-Host "Saved $($lines.Count) events to $Path"
`;

// Replays a recorded file with the original timing.
const PLAYER_PS = `param([string]$Path,[int]$Times=1)
$src=@'
using System;
using System.Runtime.InteropServices;
public class Play {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint f,IntPtr e);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
}
'@
Add-Type -TypeDefinition $src
$lines=Get-Content -Path $Path
for($n=0;$n -lt $Times;$n++){
  $sw=[System.Diagnostics.Stopwatch]::StartNew()
  foreach($line in $lines){
    if([string]::IsNullOrWhiteSpace($line)){continue}
    $a=$line.Split(' ')
    $t=[int]$a[0];$ty=$a[1]
    while($sw.ElapsedMilliseconds -lt $t){Start-Sleep -Milliseconds 1}
    if($ty -eq 'm'){[void][Play]::SetCursorPos([int]$a[2],[int]$a[3])}
    elseif($ty -eq 'd'){
      $vk=[int]$a[2]
      if($vk -eq 1){[Play]::mouse_event(0x02,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 2){[Play]::mouse_event(0x08,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 4){[Play]::mouse_event(0x20,0,0,0,[IntPtr]::Zero)}
      else{$ext=(($vk -ge 33 -and $vk -le 46) -or $vk -eq 91 -or $vk -eq 92);$f=0;if($ext){$f=1};[Play]::keybd_event([byte]$vk,0,$f,[IntPtr]::Zero)}
    }
    elseif($ty -eq 'u'){
      $vk=[int]$a[2]
      if($vk -eq 1){[Play]::mouse_event(0x04,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 2){[Play]::mouse_event(0x10,0,0,0,[IntPtr]::Zero)}
      elseif($vk -eq 4){[Play]::mouse_event(0x40,0,0,0,[IntPtr]::Zero)}
      else{$ext=(($vk -ge 33 -and $vk -le 46) -or $vk -eq 91 -or $vk -eq 92);$f=2;if($ext){$f=3};[Play]::keybd_event([byte]$vk,0,$f,[IntPtr]::Zero)}
    }
  }
}
Write-Host "Replayed $($lines.Count) events."
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

  // Run one of the helper scripts (written to temp) with the console shared, so
  // the live "Recording..." message shows and ESC reaches the recorder.
  function runScript(script: string, args: string[], site: Site): void {
    if (process.platform !== "win32") winOnly(site);
    const ps = join(tmpdir(), `sprout-recorder-${process.pid}-${script === RECORDER_PS ? "rec" : "play"}.ps1`);
    writeFileSync(ps, script);
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, ...args], { stdio: "inherit" });
    if (r.error) throw new LangError("Runtime", "couldn't run the recorder: " + r.error.message, site?.line ?? 1, site?.col ?? 1);
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Record mouse + keyboard to a file until ESC (or after `seconds`, if given).
    record: (args, site) => {
      const file = filePath(args[0], site);
      const ms = Math.max(0, Math.round(num(args[1], 0) * 1000));
      runScript(RECORDER_PS, ["-Path", file, "-Timeout", String(ms)], site);
      return NONE;
    },
    // Replay a recorded file, optionally `times` times, with the original timing.
    play: (args, site) => {
      const file = filePath(args[0], site);
      const times = Math.max(1, Math.round(num(args[1], 1)));
      runScript(PLAYER_PS, ["-Path", file, "-Times", String(times)], site);
      return NONE;
    },
    // Pause for a few seconds — handy before a replay so you can switch windows.
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
