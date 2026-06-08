// libraries/automations/startup.ts — make programs run when your PC turns on.
//
//   use "automations"
//   run_on_startup()              ~ run THIS Sprout project every time you log in
//   run_on_startup(no)            ~ stop it running at startup
//   show runs_on_startup()        ~ "yes" if this project is set to run at startup
//
//   start_with_pc("MyApp", "notepad")   ~ run ANY command at every login
//   stop_with_pc("MyApp")               ~ undo that
//   show starts_with_pc("MyApp")        ~ "yes" if it's set to start with the PC
//
// These are pure one-shots: they read or change a Windows setting and return
// right away, so there's no background work to keep alive. They use the per-user
// "Run" key in the registry, which means NO admin rights are needed.

import { NONE, stringify, isTruthy } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

type Site = { line: number; col: number } | undefined;

// Where Windows lists programs to run at every login (per-user key = no admin).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
// Absolute path to Sprout's CLI, so a startup entry needs nothing on the PATH.
const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export function register(interp: Interpreter) {
  // A friendly registry value name for THIS project, e.g. "Sprout - mygame".
  function startupName(): string {
    return "Sprout - " + basename(interp.programFile).replace(/\.sprout$/i, "");
  }
  // The exact command Windows should run at login to start this project.
  function startupCommand(): string {
    return '"' + process.execPath + '" "' + CLI_PATH + '" run "' + interp.programFile + '"';
  }
  // Make sure we're on Windows AND we know which file is the project's main file.
  function ensureWindowsProject(site: Site): void {
    if (process.platform !== "win32") {
      throw new LangError("Runtime", "run_on_startup works on Windows.", site?.line ?? 1, site?.col ?? 1, "On macOS/Linux, add a startup item yourself for now.");
    }
    if (!interp.programFile) {
      throw new LangError("Runtime", "I can't tell which file is this project's main file.", site?.line ?? 1, site?.col ?? 1, "Run it with:  sprout run yourmain.sprout");
    }
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // --- run THIS Sprout project on PC startup (Windows, no admin) ---
    // run_on_startup()      -> this program runs every time you log in
    // run_on_startup(no)    -> stop it running at startup
    run_on_startup: (args, site) => {
      ensureWindowsProject(site);
      const on = args.length === 0 ? true : isTruthy(args[0]);
      if (on) {
        // Add (or overwrite, with /f) a Run entry pointing at this project.
        const r = spawnSync("reg", ["add", RUN_KEY, "/v", startupName(), "/t", "REG_SZ", "/d", startupCommand(), "/f"], { encoding: "utf8", timeout: 8000 });
        if (r.status !== 0) throw new LangError("Runtime", "couldn't set up startup: " + ((r.stderr || "").trim() || "registry error"), site?.line ?? 1, site?.col ?? 1);
      } else {
        // Remove the entry (no error if it wasn't there — turning it off is gentle).
        spawnSync("reg", ["delete", RUN_KEY, "/v", startupName(), "/f"], { encoding: "utf8", timeout: 8000 });
      }
      return NONE;
    },

    // Is this project set to run on startup? -> yes / no
    runs_on_startup: () => {
      if (process.platform !== "win32" || !interp.programFile) return false;
      const r = spawnSync("reg", ["query", RUN_KEY, "/v", startupName()], { encoding: "utf8", timeout: 8000 });
      return r.status === 0 && (r.stdout || "").includes(startupName());
    },

    // --- run ANY command on PC startup (Windows, no admin) ---
    // Make a named command run every time this PC starts.
    // start_with_pc("MyApp", "notepad")
    start_with_pc: (args, site) => {
      if (process.platform !== "win32") {
        throw new LangError("Runtime", "start_with_pc works on Windows.", site?.line ?? 1, site?.col ?? 1, "On macOS/Linux, add a startup item yourself for now.");
      }
      const name = stringify(args[0] ?? NONE).trim();
      const cmd = stringify(args[1] ?? NONE).trim();
      if (!name || !cmd) {
        throw new LangError("Runtime", "start_with_pc needs a name and a command.", site?.line ?? 1, site?.col ?? 1, 'Try: start_with_pc("MyApp", "notepad")');
      }
      const r = spawnSync("reg", ["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", cmd, "/f"], { encoding: "utf8", timeout: 8000 });
      if (r.status !== 0) throw new LangError("Runtime", "couldn't set up startup: " + ((r.stderr || "").trim() || "registry error"), site?.line ?? 1, site?.col ?? 1);
      return NONE;
    },

    // Stop a named command from starting with the PC (undo start_with_pc).
    stop_with_pc: (args, site) => {
      if (process.platform !== "win32") {
        throw new LangError("Runtime", "stop_with_pc works on Windows.", site?.line ?? 1, site?.col ?? 1, "On macOS/Linux, remove the startup item yourself for now.");
      }
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) {
        throw new LangError("Runtime", "stop_with_pc needs a name.", site?.line ?? 1, site?.col ?? 1, 'Try: stop_with_pc("MyApp")');
      }
      // No error if it wasn't set — turning it off should always feel safe.
      spawnSync("reg", ["delete", RUN_KEY, "/v", name, "/f"], { encoding: "utf8", timeout: 8000 });
      return NONE;
    },

    // Is something set to start with the PC under this name? -> yes / no
    starts_with_pc: (args) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (process.platform !== "win32" || !name) return false;
      const r = spawnSync("reg", ["query", RUN_KEY, "/v", name], { encoding: "utf8", timeout: 8000 });
      return r.status === 0 && (r.stdout || "").includes(name);
    },
  };

  return {
    names: ["run_on_startup", "runs_on_startup", "start_with_pc", "stop_with_pc", "starts_with_pc"],
    builtins,
    isActive: () => false,  // pure one-shots — no background work to keep alive
    start: () => {},
  };
}
