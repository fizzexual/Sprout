// secrets.ts — secret("NAME"): use a token or password WITHOUT hardcoding it.
//
// A secret must never live inside your .sprout file — you might share that file
// or push it to GitHub, and then the whole internet can see your token. Instead
// `secret("NAME")` reads it from somewhere safe:
//
//   1. an environment variable        (set DISCORD_TOKEN=... in your shell), or
//   2. a ".env" file next to the program:
//
//        ~ .env  (this file is git-ignored, so it never leaves your computer)
//        DISCORD_TOKEN = your-real-token
//
// Your program just says  bot(secret("DISCORD_TOKEN"))  — the token itself is
// nowhere in the code. Hacker-safe and GitHub-proof.

import { existsSync, readFileSync } from "node:fs";
import { LangError } from "../lang/errors.ts";

export interface Secrets {
  get(name: string): string | null;
}

export const SECRET_BUILTINS = ["secret"];

// Used by tests and when no source is attached (e.g. the checker).
export function noSecrets(): Secrets {
  return { get: () => null };
}

// In-memory, for tests.
export function memorySecrets(values: Record<string, string>): Secrets {
  return { get: (name) => (name in values ? values[name] : null) };
}

// The real source: an environment variable first (nothing on disk — the safest
// option), then a ".env" file next to the program. The file is git-ignored so
// secrets never get committed.
export function fileSecrets(envPath: string): Secrets {
  let cache: Record<string, string> | null = null;
  const fromFile = (): Record<string, string> => {
    if (cache) return cache;
    cache = {};
    try {
      if (existsSync(envPath)) cache = parseEnv(readFileSync(envPath, "utf8"));
    } catch {
      /* a missing or unreadable .env just means "no secrets here" */
    }
    return cache;
  };
  return {
    get(name) {
      const fromEnv = process.env[name];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      const file = fromFile();
      return name in file ? file[name] : null;
    },
  };
}

// Friendly error when a secret can't be found — points the user at a .env file.
export function missingSecret(name: string, line: number, col: number): LangError {
  return new LangError(
    "Runtime",
    `I couldn't find a secret called '${name}'.`,
    line,
    col,
    `Put it in a '.env' file next to your program:  ${name} = your-value-here\n   (that file stays off GitHub), or set ${name} as an environment variable.`,
  );
}

// Parse "KEY = value" lines. A line starting with '~' or '#' is a comment;
// surrounding quotes on the value are optional and stripped.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("~") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}
