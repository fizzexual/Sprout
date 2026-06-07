#!/usr/bin/env node
// cli.ts — the `sprout` command.
//
//   sprout <file.sprout>        run a program (opens a window if it's a GUI app)
//   sprout run <file.sprout>    same as above
//   sprout gui <file.sprout>    open it as a native window
//   sprout serve <file.sprout>  run it as a website
//   sprout repl                 interactive prompt
//   sprout version

import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { Interpreter } from "./interpreter.ts";
import { LangError, formatError, formatMessage } from "./errors.ts";
import { startNativeGui } from "./gui-native.ts";
import { startWebServer } from "./serve.ts";
import { emptyTheme, parseBloom } from "./bloom.ts";
import type { Theme } from "./bloom.ts";

const VERSION = "Sprout v0.3.0";

// Turn any unexpected (non-Sprout) error into a friendly message instead of a
// raw Node stack trace.
function fatal(err: unknown): never {
  if (err instanceof LangError) console.error("\n" + formatError(err, "") + "\n");
  else console.error("\n" + formatMessage(err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
}
function fail(message: string, hint?: string): never {
  console.error("\n" + formatMessage(message, hint) + "\n");
  process.exit(1);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

// Load the Bloom stylesheet a program asked for via `style "..."`, resolved
// next to the program. With no `style`, the look is raw — like HTML with no CSS.
function loadTheme(stylePath: string | undefined, sproutPath: string): Theme {
  if (!stylePath) return emptyTheme();
  const resolved = join(dirname(sproutPath), stylePath);
  if (!existsSync(resolved)) {
    fail(`I couldn't find the style file: ${stylePath}`, 'Check the name in your  style "..."  line.');
  }
  return parseBloom(readFileSync(resolved, "utf8"));
}

type RunMode = "auto" | "gui" | "serve";

function runFile(path: string, mode: RunMode): void {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    fail(`I couldn't open the file: ${path}`, "Check the name and that the file is there.");
  }

  const interp = new Interpreter(source);
  try {
    interp.run(parse(tokenize(source)));
  } catch (err) {
    if (err instanceof LangError) {
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    fatal(err);
  }

  const gui = interp.getGui();
  const theme = loadTheme(gui.stylePath, path);
  try {
    if (mode === "serve") {
      startWebServer(interp, theme, { open: true });
    } else if (mode === "gui") {
      startNativeGui(interp, theme);
    } else if (mode === "auto" && gui.used) {
      // Launch what the program declared: server(...) -> website, window(...) -> window.
      if (gui.mode === "server") startWebServer(interp, theme, { open: true });
      else startNativeGui(interp, theme);
    }
    // Otherwise it's a plain console program — nothing more to do.
  } catch (err) {
    if (err instanceof LangError) {
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    fatal(err);
  }
}

function repl(): void {
  console.log(`${VERSION} — type code below.`);
  console.log("Lines ending in ':' start a block; press Enter on a blank line to run it. Ctrl+C to quit.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const interp = new Interpreter("");
  let buffer: string[] = [];

  const setPrompt = () => {
    rl.setPrompt(buffer.length ? "...... " : "sprout> ");
    rl.prompt();
  };

  const evalSource = (src: string) => {
    interp.source = src;
    try {
      interp.run(parse(tokenize(src)));
    } catch (err) {
      if (err instanceof LangError) console.error(formatError(err, src));
      else console.error(err instanceof Error ? err.message : String(err));
    }
  };

  setPrompt();
  rl.on("line", (line) => {
    const blockOpen = buffer.length > 0;
    const startsBlock = line.trimEnd().endsWith(":");
    if (line.trim() === "") {
      if (buffer.length) {
        const src = buffer.join("\n");
        buffer = [];
        evalSource(src);
      }
    } else if (!blockOpen && !startsBlock) {
      evalSource(line);
    } else {
      buffer.push(line);
    }
    setPrompt();
  });
  rl.on("close", () => console.log("\nBye! 🌱"));
}

function usage(): void {
  console.log(
    [
      "🌱 Sprout — a small, friendly programming language.",
      "",
      "Usage:",
      "  sprout <file.sprout>        run a program (opens a window if it's a GUI app)",
      "  sprout run <file.sprout>    run a program",
      "  sprout gui <file.sprout>    open it as a native window",
      "  sprout serve <file.sprout>  run it as a website",
      "  sprout repl                 start the interactive prompt",
      "  sprout version              show the version",
      "",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
try {
  if (args[0] === "run" && args[1]) {
    runFile(args[1], "auto");
  } else if (args[0] === "gui" && args[1]) {
    runFile(args[1], "gui");
  } else if (args[0] === "serve" && args[1]) {
    runFile(args[1], "serve");
  } else if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
  } else if (args[0] === "repl" || args.length === 0) {
    repl();
  } else if (args[0] && args[0].endsWith(".sprout")) {
    runFile(args[0], "auto");
  } else {
    usage();
  }
} catch (err) {
  fatal(err);
}
