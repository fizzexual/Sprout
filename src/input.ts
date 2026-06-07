// input.ts — asking the user a question (the `ask` builtin).
//
//   make name = ask("What's your name?")
//
// Like net/secrets, input is a capability the CLI injects, so the interpreter
// stays testable (tests pass a fake) and GUI/server programs just get "".

import { readSync } from "node:fs";

export interface Input {
  ask(prompt: string): string;
}

export const INPUT_BUILTINS = ["ask"];

// No console here (a GUI/web app, or the test runner): ask hands back empty text.
export function noInput(): Input {
  return { ask: () => "" };
}

// Reads one line from the real console, blocking until Enter. Used by `sprout run`.
export function consoleInput(): Input {
  return {
    ask(prompt: string): string {
      if (prompt) process.stdout.write(prompt + " ");
      return readLineSync();
    },
  };
}

function readLineSync(): string {
  let s = "";
  const buf = Buffer.alloc(1);
  for (;;) {
    let n = 0;
    try { n = readSync(0, buf, 0, 1, null); } catch { break; }
    if (n === 0) break;            // end of input
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch === "\r") continue;
    s += ch;
  }
  return s;
}
