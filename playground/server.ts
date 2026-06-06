#!/usr/bin/env node
// playground/server.ts — a tiny, zero-dependency web server for the Sprout
// playground. It serves the editor page and runs Sprout code on request,
// reusing the exact same interpreter the CLI uses.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tokenize } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { Interpreter } from "../src/interpreter.ts";
import { LangError, formatError } from "../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
}

function runSprout(code: string): RunResult {
  const lines: string[] = [];
  // A generous step limit keeps an accidental endless loop from hanging the
  // server — the interpreter stops itself and reports a friendly error.
  const interp = new Interpreter(code, (line) => lines.push(line), { maxSteps: 2_000_000 });
  try {
    interp.run(parse(tokenize(code)));
    return { ok: true, output: lines.join("\n") };
  } catch (err) {
    const partial = lines.join("\n");
    if (err instanceof LangError) return { ok: false, output: partial, error: formatError(err, code) };
    return { ok: false, output: partial, error: err instanceof Error ? err.message : String(err) };
  }
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/run") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let code = "";
      try {
        code = JSON.parse(body).code ?? "";
      } catch {
        /* leave code empty */
      }
      const result = runSprout(code);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Everything else serves the editor page.
  try {
    const html = readFileSync(join(here, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🌱 Sprout playground running at http://localhost:${PORT}`);
  console.log("   Open that link in your browser. Press Ctrl+C to stop.");
});
