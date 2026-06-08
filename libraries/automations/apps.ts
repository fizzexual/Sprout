// libraries/automations/apps.ts — launch & control apps from Sprout.
//
//   use "automations"
//   launch("notepad")                 ~ start a program, file, or website
//   if running("notepad"):            ~ is it open right now? -> yes / no
//       show "Notepad is open!"
//   closeapp("notepad")               ~ close it -> yes / no
//
// These are instant, one-shot helpers — they do their thing and return right
// away. They register no background work, so isActive() is always false.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawn, spawnSync } from "node:child_process";

type Site = { line: number; col: number } | undefined;

// A Windows process is matched by its image name, which always ends in ".exe".
// "notepad" -> "notepad.exe", but "chrome.exe" is left alone.
function imageName(name: string): string {
  return /\.exe$/i.test(name) ? name : name + ".exe";
}

export function register(_interp: Interpreter) {
  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Start a program, app, file, or website in the background.
    // On Windows we use `start` so Windows picks the right app for any path or
    // URL; elsewhere we run the command through the shell.
    launch: (args, site) => {
      const cmd = stringify(args[0] ?? NONE).trim();
      if (!cmd) throw new LangError("Runtime", "launch needs something to start.", site?.line ?? 1, site?.col ?? 1, 'Try: launch("notepad")');
      try {
        const child = process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", cmd], { detached: true, stdio: "ignore", windowsHide: true })
          : spawn(cmd, { detached: true, stdio: "ignore", shell: true });
        child.unref(); // let the program live on its own, even after Sprout ends
      } catch (e) {
        throw new LangError("Runtime", "couldn't start '" + cmd + "': " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1);
      }
      return NONE;
    },

    // Is a program/app running right now? -> yes / no
    // Windows: ask `tasklist` for that image name. Elsewhere: `pgrep`.
    running: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) return false;
      if (process.platform === "win32") {
        const img = imageName(name);
        const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + img, "/NH"], { encoding: "utf8", timeout: 8000 });
        return (r.stdout || "").toLowerCase().includes(img.toLowerCase());
      }
      const r = spawnSync("pgrep", ["-f", name], { encoding: "utf8", timeout: 8000 });
      return (r.stdout || "").trim().length > 0;
    },

    // Close a running program/app. -> yes / no (yes if it was closed)
    // Windows: `taskkill /F`. Elsewhere: `pkill`.
    closeapp: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) return false;
      if (process.platform === "win32") {
        const r = spawnSync("taskkill", ["/IM", imageName(name), "/F"], { encoding: "utf8", timeout: 8000 });
        return r.status === 0;
      }
      const r = spawnSync("pkill", ["-f", name], { encoding: "utf8", timeout: 8000 });
      return r.status === 0;
    },
  };

  return {
    names: ["launch", "running", "closeapp"],
    builtins,
    isActive: () => false, // pure one-shots — no background work to keep alive
    start: () => {},
  };
}
