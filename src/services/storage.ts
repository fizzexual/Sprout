// storage.ts — where `remember` / `recall` keep their data.
//
// `remember("score", 10)` saves a value; `recall("score")` reads it back, even
// after the program closes and reopens. No database, no setup.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Value } from "../interp/values.ts";

export interface Storage {
  load(): Record<string, Value>;
  save(data: Record<string, Value>): void;
}

export const PERSIST_BUILTINS = ["remember", "recall"];

// In-memory only — used by tests and when no file is attached.
export function memoryStorage(): Storage {
  let data: Record<string, Value> = {};
  return { load: () => data, save: (d) => { data = d; } };
}

// Backed by a JSON file on disk — used by the CLI.
export function fileStorage(path: string): Storage {
  return {
    load() {
      try {
        if (existsSync(path)) return sanitize(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        /* ignore a missing or corrupt data file */
      }
      return {};
    },
    save(data) {
      try {
        writeFileSync(path, JSON.stringify(data, null, 2));
      } catch {
        /* ignore write errors */
      }
    },
  };
}

// Only keep simple, JSON-safe values.
function sanitize(obj: unknown): Record<string, Value> {
  const out: Record<string, Value> = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}
