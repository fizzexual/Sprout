// gui-native.ts — opens a Sprout GUI as a real native window using Windows'
// built-in .NET (WinForms) via PowerShell. No browser, no dependencies.
//
// Node runs the interpreter; PowerShell shows the window. They talk over
// stdin/stdout: PowerShell sends a "click" when a button is pressed, Node runs
// the matching task and sends back the updated widgets.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LangError, formatError } from "../lang/errors.ts";
import { styleFor, windowStyle } from "./bloom.ts";
import type { Theme } from "./bloom.ts";
import type { Interpreter } from "../interp/interpreter.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function startNativeGui(interp: Interpreter, theme: Theme): void {
  if (process.platform !== "win32") {
    throw new LangError(
      "Runtime",
      "Native windows currently work on Windows only.",
      1,
      1,
      "On other systems, run it as a website instead:  sprout serve <file>",
    );
  }

  const host = join(here, "gui-host.ps1");
  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", host],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  // Send the initial window description.
  ps.stdin.write(JSON.stringify({ type: "init", spec: buildSpec(interp, theme) }) + "\n");

  let buffer = "";
  ps.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleMessage(ps, interp, line);
    }
  });

  ps.on("error", () => {
    console.error("\n" + formatError(
      new LangError("Runtime", "I couldn't start the window (PowerShell wasn't found).", 1, 1,
        "This feature needs Windows PowerShell."),
      interp.source,
    ) + "\n");
    process.exit(1);
  });
  ps.on("exit", () => process.exit(0));

  console.log("🌱 Your Sprout window is open. Close it to stop.");
}

function handleMessage(ps: ReturnType<typeof spawn>, interp: Interpreter, line: string): void {
  let msg: { type?: string; button?: string; fields?: Record<string, string> };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore any non-protocol output
  }
  if (msg.type !== "click") return;

  if (msg.fields) interp.setFieldValues(msg.fields);
  let error: string | undefined;
  try {
    if (msg.button) interp.clickButton(String(msg.button));
  } catch (e) {
    error = e instanceof LangError ? formatError(e, interp.source) : e instanceof Error ? e.message : String(e);
  }
  const reply = { type: "update", widgets: interp.getGui().widgets, error };
  ps.stdin?.write(JSON.stringify(reply) + "\n");
}

// Bundle the widget model + resolved Bloom styles into one spec for the window.
function buildSpec(interp: Interpreter, theme: Theme) {
  const gui = interp.getGui();
  return {
    title: gui.title,
    window: windowStyle(theme),
    topMost: gui.topMost ?? false,
    widgets: gui.widgets.map((w) => ({ ...w, style: styleFor(theme, w.kind, w.id) })),
  };
}
