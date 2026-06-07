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
import { basename, dirname, extname, join } from "node:path";

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { check } from "./checker.ts";
import { Interpreter } from "./interpreter.ts";
import { LangError, formatError, formatMessage } from "./errors.ts";
import { startNativeGui } from "./gui-native.ts";
import { startWebServer } from "./serve.ts";
import { emptyTheme, parseBloom } from "./bloom.ts";
import type { Theme } from "./bloom.ts";
import { fileStorage } from "./storage.ts";
import { nodeNet } from "./net.ts";
import { fileSecrets } from "./secrets.ts";
import { modulesCommand } from "./modules.ts";
import { describeJson } from "./explore.ts";

const VERSION = "Sprout v0.4.1";

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

interface LoadedLibrary {
  names: string[];
  isActive(): boolean;
  start(): void;
}
// What a library's create() returns; extensions return just names + builtins.
interface LibModule {
  create?: (interp: Interpreter, parent?: unknown) => {
    names?: string[];
    builtins?: Record<string, unknown>;
    isActive?: () => boolean;
    start?: () => void;
    api?: unknown;
  };
}

const NAME_PART = /^[a-z0-9-]+$/;

// Load everything a program `use`s. Plain names (`discord-bot`) are libraries;
// `library/extension` names (`discord-bot/music`) are extensions that hook into
// an already-loaded library. Returns the runnable libraries + the names they add
// (so the verifier knows them). Two passes so file order doesn't matter.
async function loadLibraries(program: ReturnType<typeof parse>, interp: Interpreter): Promise<{ libs: LoadedLibrary[]; names: Set<string> }> {
  const libs: LoadedLibrary[] = [];
  const names = new Set<string>();
  const loaded = new Map<string, ReturnType<NonNullable<LibModule["create"]>>>();

  const useNames = program.flatMap((s) => (s.type === "Use" ? [s.name] : []));

  // Pass 1: base libraries.
  for (const name of useNames) {
    if (name.includes("/")) continue;
    if (!NAME_PART.test(name)) fail(`'${name}' isn't a valid library name.`, "Library names use lowercase letters, numbers, and dashes.");
    if (loaded.has(name)) continue;
    let mod: LibModule | undefined;
    try {
      mod = await import(new URL(`../libraries/${name}/index.ts`, import.meta.url).href);
    } catch {
      fail(`I don't know a library called '${name}'.`, "Check the spelling, or look in the libraries/ folder.");
    }
    if (!mod || typeof mod.create !== "function") fail(`The library '${name}' isn't set up correctly (no 'create').`);
    const lib = mod!.create!(interp);
    interp.registerLibraryBuiltins((lib.builtins ?? {}) as never);
    for (const n of lib.names ?? []) names.add(n);
    loaded.set(name, lib);
    libs.push({ names: lib.names ?? [], isActive: lib.isActive ?? (() => false), start: lib.start ?? (() => {}) });
  }

  // Pass 2: extensions (library/extension), handed their parent library.
  for (const name of useNames) {
    if (!name.includes("/")) continue;
    const parts = name.split("/");
    if (parts.length !== 2 || !NAME_PART.test(parts[0]) || !NAME_PART.test(parts[1])) {
      fail(`'${name}' isn't a valid extension name.`, 'Use  library/extension , like  "discord-bot/music".');
    }
    const [libName, extName] = parts;
    const parent = loaded.get(libName);
    if (!parent) fail(`Add  use "${libName}"  before  use "${name}".`, `The '${extName}' extension needs the '${libName}' library.`);
    let mod: LibModule | undefined;
    try {
      mod = await import(new URL(`../extensions/${libName}/${extName}/index.ts`, import.meta.url).href);
    } catch {
      fail(`I don't know an extension called '${name}'.`, `Look in the extensions/${libName}/ folder.`);
    }
    if (!mod || typeof mod.create !== "function") fail(`The extension '${name}' isn't set up correctly (no 'create').`);
    const ext = mod!.create!(interp, parent);
    interp.registerLibraryBuiltins((ext.builtins ?? {}) as never);
    for (const n of ext.names ?? []) names.add(n);
  }

  return { libs, names };
}

type RunMode = "auto" | "gui" | "serve";

async function runFile(path: string, mode: RunMode): Promise<void> {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    fail(`I couldn't open the file: ${path}`, "Check the name and that the file is there.");
  }

  // `remember`/`recall` persist to a JSON file next to the program; `secret(...)`
  // reads from the environment or a git-ignored ".env" file next to the program.
  const dataPath = join(dirname(path), basename(path, extname(path)) + ".data.json");
  const envPath = join(dirname(path), ".env");
  const interp = new Interpreter(source, undefined, {
    storage: fileStorage(dataPath),
    net: nodeNet(),
    secrets: fileSecrets(envPath),
    programDir: dirname(path),
  });

  // Parse, then verify the WHOLE program before running any of it.
  let program: ReturnType<typeof parse>;
  try {
    program = parse(tokenize(source));
  } catch (err) {
    if (err instanceof LangError) {
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    fatal(err);
  }

  const { libs, names: libNames } = await loadLibraries(program, interp);

  const problems = check(program, libNames);
  if (problems.length > 0) {
    for (const p of problems) console.error("\n" + formatError(p, source));
    console.error(`\nFound ${problems.length} problem(s) — fix these and try again.\n`);
    process.exit(1);
  }

  try {
    interp.run(program);
  } catch (err) {
    if (err instanceof LangError) {
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    fatal(err);
  }

  // A library may take over (e.g. a Discord bot keeps listening for messages).
  let runtimeStarted = false;
  for (const lib of libs) {
    if (lib.isActive()) { lib.start(); runtimeStarted = true; }
  }
  if (runtimeStarted) return;

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

// `sprout check <file>` — verify a program without running it.
async function checkFile(path: string): Promise<void> {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch {
    fail(`I couldn't open the file: ${path}`, "Check the name and that the file is there.");
  }
  let program: ReturnType<typeof parse>;
  try {
    program = parse(tokenize(source));
  } catch (err) {
    if (err instanceof LangError) {
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    fatal(err);
  }
  const interp = new Interpreter(source);
  const { names: libNames } = await loadLibraries(program, interp);

  const problems = check(program, libNames);
  if (problems.length === 0) {
    console.log("✓ Looks good — no problems found.");
    return;
  }
  for (const p of problems) console.error("\n" + formatError(p, source));
  console.error(`\nFound ${problems.length} problem(s).`);
  process.exit(1);
}

// `sprout api <url>` — connect to an API and list everything you can read.
function apiCommand(url: string): void {
  let body: string;
  try {
    body = nodeNet().get(url);
  } catch (e) {
    fail(`I couldn't reach ${url}.`, e instanceof Error ? e.message : "Check the address and your internet.");
  }
  console.log(`\n✓ Connected to ${url}\n`);
  console.log("Everything you can read (jsonpick the path on the left):\n");
  console.log(describeJson(body));
  console.log("");
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
      "  sprout check <file.sprout>  verify the program without running it",
      "  sprout api <url>            connect to an API and list everything it offers",
      "  sprout modules              install / uninstall / test libraries (interactive)",
      "  sprout repl                 start the interactive prompt",
      "  sprout version              show the version",
      "",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
try {
  if (args[0] === "run" && args[1]) {
    await runFile(args[1], "auto");
  } else if (args[0] === "gui" && args[1]) {
    await runFile(args[1], "gui");
  } else if (args[0] === "serve" && args[1]) {
    await runFile(args[1], "serve");
  } else if (args[0] === "check" && args[1]) {
    await checkFile(args[1]);
  } else if (args[0] === "api" && args[1]) {
    apiCommand(args[1]);
  } else if (args[0] === "modules" || args[0] === "libraries") {
    await modulesCommand();
  } else if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
  } else if (args[0] === "repl" || args.length === 0) {
    repl();
  } else if (args[0] && args[0].endsWith(".sprout")) {
    await runFile(args[0], "auto");
  } else {
    usage();
  }
} catch (err) {
  fatal(err);
}
