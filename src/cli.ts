#!/usr/bin/env node
// cli.ts — the `sprout` command. Runs a file, or starts an interactive prompt.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { Interpreter } from "./interpreter.ts";
import { LangError, formatError } from "./errors.ts";
import { startGuiServer } from "./gui-server.ts";

const VERSION = "Sprout v0.1.0";

function runFile(path: string, forceGui = false): void {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.error(`I couldn't open the file: ${path}`);
    process.exit(1);
  }

  const interp = new Interpreter(source);
  try {
    const program = parse(tokenize(source));
    interp.run(program);
    // If the program built a GUI (or `sprout gui` was used), open the window.
    if (forceGui || interp.isGuiApp()) {
      startGuiServer(interp, { open: true });
    }
  } catch (err) {
    if (err instanceof LangError) {
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    throw err;
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
      "  sprout <file.sprout>       run a Sprout program",
      "  sprout run <file.sprout>   run a Sprout program",
      "  sprout gui <file.sprout>   run a Sprout GUI app in your browser",
      "  sprout repl                start the interactive prompt",
      "  sprout version             show the version",
      "",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
if (args[0] === "run" && args[1]) {
  runFile(args[1]);
} else if (args[0] === "gui" && args[1]) {
  runFile(args[1], true);
} else if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
  console.log(VERSION);
} else if (args[0] === "repl" || args.length === 0) {
  repl();
} else if (args[0] && args[0].endsWith(".sprout")) {
  // Python-style shortcut: `sprout hello.sprout`
  runFile(args[0]);
} else {
  usage();
}
