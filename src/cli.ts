#!/usr/bin/env node
// cli.ts — the `sprout` command.
//
//   sprout <file.sprout>        run a program (opens a window if it's a GUI app)
//   sprout run <file.sprout>    same as above
//   sprout gui <file.sprout>    open it as a native window
//   sprout serve <file.sprout>  run it as a website
//   sprout repl                 interactive prompt
//   sprout version

import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { check } from "./checker.ts";
import { compile } from "./compile.ts";
import { Interpreter } from "./interpreter.ts";
import { LangError, formatError, formatMessage } from "./errors.ts";
import { startNativeGui } from "./gui-native.ts";
import { startWebServer } from "./serve.ts";
import { emptyTheme, parseBloom } from "./bloom.ts";
import type { Theme } from "./bloom.ts";
import { fileStorage, memoryStorage } from "./storage.ts";
import { nodeNet, noNet } from "./net.ts";
import { fileSecrets } from "./secrets.ts";
import { consoleInput, noInput } from "./input.ts";
import { modulesCommand } from "./modules.ts";
import { describeJson } from "./explore.ts";
import { bundleStandalone } from "./bundle.ts";

const VERSION = "Sprout v0.6.1";

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
    if (name.endsWith(".sprout")) continue;   // that's a file import, not a library
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
    if (name.endsWith(".sprout")) continue;   // file import, handled separately
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

type SproutFile = { path: string; source: string; program: ReturnType<typeof parse> };

// Gather the entry file plus every .sprout file it `use`s (recursively), with
// each dependency BEFORE the files that import it, and the entry file last.
function gatherSproutFiles(entryPath: string): SproutFile[] {
  const files: SproutFile[] = [];
  const seen = new Set<string>();
  const load = (p: string): void => {
    let real = p;
    try { real = resolve(p); } catch { /* keep p */ }
    if (seen.has(real)) return;           // already loaded (handles cycles + repeats)
    seen.add(real);
    let source = "";
    try {
      source = readFileSync(real, "utf8");
    } catch {
      fail(`I couldn't open the imported file: ${p}`, "Check the path — it's relative to the file that 'use's it.");
    }
    let program: ReturnType<typeof parse>;
    try {
      program = parse(tokenize(source));
    } catch (err) {
      if (err instanceof LangError) { console.error("\n" + formatError(err, source) + `\n   (in ${basename(real)})\n`); process.exit(1); }
      fatal(err);
      return;
    }
    // Load THIS file's own imports first, so dependencies land before it.
    for (const s of program) {
      if (s.type === "Use" && s.name.endsWith(".sprout")) load(join(dirname(real), s.name));
    }
    files.push({ path: real, source, program });
  };
  load(entryPath);
  return files;
}

// Load a whole project: the entry file + every .sprout it `use`s. Wires up
// libraries (from any file), verifies each file with its OWN source (cross-file
// task calls allowed), and returns the merged program to run — every imported
// file contributes its tasks; the entry contributes everything.
async function loadProject(entryPath: string, interp: Interpreter): Promise<{ run: ReturnType<typeof parse>; libs: LoadedLibrary[]; problems: string[] }> {
  const files = gatherSproutFiles(entryPath);
  const entry = files[files.length - 1];

  const combined: ReturnType<typeof parse> = [];
  for (const f of files) for (const s of f.program) combined.push(s);
  const { libs, names: libNames } = await loadLibraries(combined, interp);

  // Every task name in the project, so a call to another file's task is "known".
  const allTasks = new Set<string>();
  for (const f of files) for (const s of f.program) if (s.type === "Task") allTasks.add(s.name);

  const problems: string[] = [];
  for (const f of files) {
    const own = new Set<string>();
    for (const s of f.program) if (s.type === "Task") own.add(s.name);
    const known = new Set<string>(libNames);
    for (const n of allTasks) if (!own.has(n)) known.add(n);  // other files' tasks: accept the name
    for (const p of check(f.program, known)) {
      problems.push(formatError(p, f.source) + (files.length > 1 ? `\n   (in ${basename(f.path)})` : ""));
    }
  }

  // Merge for running: imported files' tasks first, then the entry file in full.
  const run: ReturnType<typeof parse> = [];
  for (const f of files) {
    if (f === entry) continue;
    for (const s of f.program) if (s.type === "Task") run.push(s);
  }
  for (const s of entry.program) run.push(s);

  return { run, libs, problems };
}

type RunMode = "auto" | "gui" | "serve";

async function runFile(path: string, mode: RunMode, explain = false): Promise<void> {
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
    programFile: resolve(path),
    input: consoleInput(),
    // explain mode: narrate each step in grey, the program's own output stays white.
    narrate: explain ? (m: string) => console.log("\x1b[90m" + m + "\x1b[0m") : undefined,
  });

  // Load the whole project — this file PLUS any .sprout files it `use`s — wire up
  // libraries, and verify every file before running a single line.
  const { run: program, libs, problems } = await loadProject(path, interp);
  if (problems.length > 0) {
    for (const p of problems) console.error("\n" + p);
    console.error(`\nFound ${problems.length} problem(s) — fix these and try again.\n`);
    process.exit(1);
  }

  if (explain) console.log("\x1b[90m🌱 explaining " + basename(path) + " — grey is me narrating, white is your program:\x1b[0m\n");
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

// `sprout check <file>` — verify a program (and any files it `use`s) without running.
async function checkFile(path: string): Promise<void> {
  const interp = new Interpreter("");
  const { problems } = await loadProject(path, interp);
  if (problems.length === 0) {
    console.log("✓ Looks good — no problems found.");
    return;
  }
  for (const p of problems) console.error("\n" + p);
  console.error(`\nFound ${problems.length} problem(s).`);
  process.exit(1);
}

// --- the fast build: compile a program to JavaScript and run it on V8 ---------
const RUNTIME_URL = new URL("./jsruntime.ts", import.meta.url).href;

// Parse + (multi-file) combine + compile. Gathers the entry plus every .sprout
// file it `use`s, merges their tasks, and compiles the whole project into one JS
// program. Returns {error} when the fast build can't cover it (a library, a
// styled GUI, ...). Verifies every file first, so mistakes get a kind error.
function compileProject(path: string, runtimeUrl: string = RUNTIME_URL): { js: string } | { error: string } {
  const files = gatherSproutFiles(path);  // reads + parses each file (errors itself)
  const entry = files[files.length - 1];

  // A library `use` can't be compiled — bail early with a friendly note.
  for (const f of files) for (const s of f.program) {
    if (s.type === "Use" && !s.name.endsWith(".sprout")) return { error: `it uses the '${s.name}' library, which the fast build doesn't cover — run it with: sprout run` };
  }

  // Verify every file (cross-file task calls are allowed).
  const allTasks = new Set<string>();
  for (const f of files) for (const s of f.program) if (s.type === "Task") allTasks.add(s.name);
  for (const f of files) {
    const problems = check(f.program, allTasks);
    if (problems.length) {
      for (const p of problems) console.error("\n" + formatError(p, f.source) + (files.length > 1 ? `\n   (in ${basename(f.path)})` : ""));
      console.error(`\nFound ${problems.length} problem(s) — fix these and try again.\n`);
      process.exit(1);
    }
  }

  // Merge: imported files' tasks first, then the entry file in full.
  const combined: ReturnType<typeof parse> = [];
  for (const f of files) if (f !== entry) for (const s of f.program) if (s.type === "Task") combined.push(s);
  for (const s of entry.program) combined.push(s);
  return compile(combined, runtimeUrl);
}

// Ask a numbered multiple-choice question on an existing readline and return the
// chosen index (0-based). Enter with no answer picks the first option.
function choose(rl: ReturnType<typeof createInterface>, question: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    const Y = "\x1b[93m", G = "\x1b[90m", R = "\x1b[0m", B = "\x1b[1m";
    console.log("\n  " + B + question + R);
    options.forEach((o, i) => console.log("    " + Y + (i + 1) + R + ")  " + o));
    let done = false;
    const finish = (i: number): void => { if (!done) { done = true; resolve(i); } };
    const onClose = (): void => finish(0);              // input ended (EOF) -> default to option 1
    rl.once("close", onClose);
    rl.question("\n  " + G + `Pick 1-${options.length} (Enter = 1): ` + R, (ans) => {
      rl.removeListener("close", onClose);
      const n = parseInt(ans.trim(), 10);
      finish(Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : 0);
    });
  });
}

// `sprout build <file>` with no flags, in a terminal: a friendly wizard. Always
// produces an .exe — the questions just decide which kind.
async function buildWizard(path: string): Promise<void> {
  console.log(`\n  🌱  Building ${basename(path)} into an .exe — a couple of quick questions:`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const needsNode = await choose(rl, "Does the computer that runs it need Node installed?", [
      "No  — works on any Windows PC, but a bigger .exe (~20–90 MB)",
      "Yes — a tiny .exe (~40 KB), but that PC must have Node installed",
    ]);
    if (needsNode === 1) { rl.close(); await buildFile(path, ["--needs-node"]); return; } // tiny .exe, uses system Node

    const size = await choose(rl, "How small should the standalone .exe be?", [
      "Smallest — about 20 MB, fits Discord (a rare antivirus may warn on packed apps)",
      "Biggest  — about 90 MB, largest but the most antivirus-friendly",
    ]);
    rl.close();
    await buildFile(path, size === 0 ? ["--standalone"] : ["--standalone", "--no-compress"]);
  } finally {
    rl.close();
  }
}

// Route `sprout build`: ask interactively when no flags + a real terminal (the
// SPROUT_FORCE_WIZARD env lets tests drive it). Otherwise build per the flags.
async function buildCommand(path: string, flags: string[]): Promise<void> {
  const scripted = flags.some((f) => f.startsWith("-"));
  if (!scripted && (process.stdin.isTTY || process.env.SPROUT_FORCE_WIZARD)) { await buildWizard(path); return; }
  await buildFile(path, flags);
}

// `sprout build <file>` — write a fast .mjs you run with node.
// `sprout build <file> --standalone` — one no-Node .exe (embeds the engine).
// `sprout build <file> --needs-node` — a tiny .exe that uses the installed Node.
async function buildFile(path: string, flags: string[] = []): Promise<void> {
  const standalone = flags.includes("--standalone") || flags.includes("--exe");
  const needsNode = flags.includes("--needs-node");

  // Plain .mjs — the scripted / non-interactive default.
  if (!standalone && !needsNode) {
    const result = compileProject(path);
    if ("error" in result) fail("Can't fast-build this program: " + result.error);
    const outPath = join(dirname(path), basename(path, extname(path)) + ".mjs");
    writeFileSync(outPath, result.js);
    console.log(`✓ Built ${basename(outPath)} — run it with:  node "${outPath}"`);
    return;
  }

  // Both .exe kinds share the same self-contained bundle.
  const result = compileProject(path, "@runtime");
  if ("error" in result) fail("Can't build an .exe from this program: " + result.error);
  const bundle = bundleStandalone(result.js);
  const stem = basename(path, extname(path));
  const exePath = join(dirname(path), stem + (process.platform === "win32" ? ".exe" : ""));

  // A tiny .exe that runs on the system's Node (must be installed to run it).
  if (needsNode) {
    const exe = buildNeedsNodeExe(bundle, exePath);
    if (exe.ok) {
      const kb = (statSync(exe.path).size / 1024).toFixed(0);
      console.log(`✓ Built ${basename(exe.path)} (${kb} KB) — a tiny app. The PC that runs it must have Node installed (free at https://nodejs.org).`);
      console.log("  Double-click it, or send it to a friend who has Node.");
    } else {
      const cjs = join(dirname(path), stem + ".cjs"); writeFileSync(cjs, bundle);
      console.log(`✓ Bundled ${basename(cjs)} — run it with:  node "${cjs}"`);
      console.log(`  (Couldn't build the tiny .exe: ${exe.why}.)`);
    }
    return;
  }

  // A standalone .exe that needs no Node at all — embeds the engine via SEA.
  const cjsPath = join(dirname(path), stem + ".cjs");
  writeFileSync(cjsPath, bundle);
  const exe = buildExe(bundle, exePath);
  if (exe.ok) {
    try { rmSync(cjsPath, { force: true }); } catch { /* keep it if we can't remove it */ }
    // Shrink it ~4x with upx (still standalone) unless the user opted out.
    const compressed = flags.includes("--no-compress") ? false : compressExe(exe.path);
    const mb = (statSync(exe.path).size / (1024 * 1024)).toFixed(0);
    console.log(`✓ Built ${basename(exe.path)} (${mb} MB) — a standalone program that needs no Node installed.`);
    if (compressed) console.log("  Compressed with upx. (If a friend's antivirus flags it, that's a false positive for packed apps — rebuild with --no-compress to avoid it.)");
    console.log(`  ${process.platform === "win32" ? "Double-click it, or send it to a friend to run." : "Run it directly, or send it to a friend."}`);
  } else {
    console.log(`✓ Bundled ${basename(cjsPath)} — one self-contained file. Run it with:  node "${cjsPath}"`);
    console.log(`  (Couldn't build the no-Node .exe: ${exe.why}. The single file above still works wherever Node is installed.)`);
  }
}

// Find the C# compiler that ships with the .NET Framework (present on Windows).
function findCsc(): string | null {
  const win = process.env.WINDIR || "C:\\Windows";
  for (const arch of ["Framework64", "Framework"]) {
    const p = join(win, "Microsoft.NET", arch, "v4.0.30319", "csc.exe");
    if (existsSync(p)) return p;
  }
  const w = spawnSync("where", ["csc"], { encoding: "utf8" });
  if (w.status === 0) { const p = (w.stdout || "").split(/\r?\n/)[0].trim(); if (p && existsSync(p)) return p; }
  return null;
}

// Build a TINY .exe (~40 KB) that carries the program inside it and runs it on
// the system's Node (which must be installed). A small C# launcher — compiled
// with the .NET csc that's already on Windows — extracts the bundle and runs
// `node` on it, inheriting the console so interactive programs work.
function buildNeedsNodeExe(bundle: string, outPath: string): { ok: true; path: string } | { ok: false; why: string } {
  if (process.env.SPROUT_SKIP_EXE) return { ok: false, why: "skipped" };
  if (process.platform !== "win32") return { ok: false, why: "the tiny needs-Node .exe is Windows-only for now" };
  const csc = findCsc();
  if (!csc) return { ok: false, why: "couldn't find the C# compiler (csc) that ships with Windows" };
  const b64 = Buffer.from(bundle, "utf8").toString("base64");
  const cs = [
    "using System;using System.Diagnostics;using System.IO;",
    "class P{static int Main(){",
    "  string b64=\"" + b64 + "\";",
    "  string tmp=Path.Combine(Path.GetTempPath(),\"sprout_\"+Guid.NewGuid().ToString(\"N\")+\".cjs\");",
    "  File.WriteAllBytes(tmp,Convert.FromBase64String(b64));",
    "  try{",
    "    var psi=new ProcessStartInfo(\"node\",\"\\\"\"+tmp+\"\\\"\"){UseShellExecute=false};",
    "    var p=Process.Start(psi);p.WaitForExit();",
    "    try{File.Delete(tmp);}catch{}",
    "    return p.ExitCode;",
    "  }catch{",
    "    Console.Error.WriteLine(\"This program needs Node.js installed — get it free at https://nodejs.org\");",
    "    Console.Error.Write(\"Press Enter to close.\");Console.In.ReadLine();return 1;",
    "  }",
    "}}",
  ].join("\n");
  const work = mkdtempSync(join(tmpdir(), "sprout-csc-"));
  try {
    const csFile = join(work, "launcher.cs");
    writeFileSync(csFile, cs);
    const r = spawnSync(csc, ["-nologo", "-optimize+", "-target:exe", "-out:" + outPath, csFile], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(outPath)) return { ok: false, why: "the C# launcher didn't compile" };
    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Find the `postject` build tool, installing it once if it's missing — so
// `sprout build --standalone` is a single command with no separate setup step.
// Returns its path, or null if it isn't there and couldn't be installed.
function ensurePostject(): string | null {
  if (process.env.SPROUT_SKIP_EXE) return null; // tests: skip the (large, slow) .exe build entirely
  try { return createRequire(import.meta.url).resolve("postject/dist/cli.js"); } catch { /* not installed */ }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log("  First standalone build — setting up the .exe tool (one time)…\n");
  // shell:true is required on Windows: Node refuses to spawn npm's .cmd directly
  // (EINVAL). The args are fixed (no user input), so there's no injection risk.
  const realEmitWarning = process.emitWarning;
  process.emitWarning = () => {}; // hush the shell-option deprecation note
  let r;
  try { r = spawnSync("npm", ["run", "install:exe"], { cwd: root, stdio: "inherit", shell: true }); }
  finally { process.emitWarning = realEmitWarning; }
  if (!r || r.status !== 0) return null;
  try { return createRequire(import.meta.url).resolve("postject/dist/cli.js"); } catch { return null; }
}

// Wrap a JS bundle into a single executable using Node's built-in Single
// Executable Applications (SEA): generate a blob from the bundle, copy the node
// runtime, and inject the blob with `postject` (installed automatically once).
function buildExe(bundle: string, outPath: string): { ok: true; path: string } | { ok: false; why: string } {
  const postject = ensurePostject();
  if (!postject) return { ok: false, why: "couldn't set up the 'postject' build tool (the first .exe build needs internet)" };

  const work = mkdtempSync(join(tmpdir(), "sprout-exe-"));
  try {
    const appJs = join(work, "app.js");
    const cfg = join(work, "sea-config.json");
    const blob = join(work, "sea.blob");
    writeFileSync(appJs, bundle);
    writeFileSync(cfg, JSON.stringify({ main: appJs, output: blob, disableExperimentalSEAWarning: true }));
    const gen = spawnSync(process.execPath, ["--experimental-sea-config", cfg], { encoding: "utf8" });
    if (gen.status !== 0 || !existsSync(blob)) return { ok: false, why: "couldn't generate the program blob" };
    copyFileSync(process.execPath, outPath);
    const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
    const args = [postject, outPath, "NODE_SEA_BLOB", blob, "--sentinel-fuse", fuse];
    if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
    const inj = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (inj.status !== 0) return { ok: false, why: "couldn't inject the program into the executable" };
    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Find the `upx` compressor — on PATH, or where winget's `upx` alias lives.
function findUpx(): string | null {
  const w = spawnSync(process.platform === "win32" ? "where" : "which", ["upx"], { encoding: "utf8" });
  if (w.status === 0) { const p = (w.stdout || "").split(/\r?\n/)[0].trim(); if (p && existsSync(p)) return p; }
  // winget installs a launcher alias here, which this just-started process's PATH may not see yet.
  const local = process.env.LOCALAPPDATA;
  if (local) { const link = join(local, "Microsoft", "WinGet", "Links", "upx.exe"); if (existsSync(link)) return link; }
  return null;
}

// Get upx, installing it once via winget if needed (like the music deps do).
function ensureUpx(): string | null {
  let upx = findUpx();
  if (upx) return upx;
  if (process.platform !== "win32") return null; // elsewhere: user installs upx via their package manager
  console.log("  Setting up the compressor (upx) to shrink the .exe (one time)…\n");
  const realEmitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try { spawnSync("winget", ["install", "--id", "UPX.UPX", "-e", "--accept-package-agreements", "--accept-source-agreements"], { stdio: "inherit", shell: true }); }
  finally { process.emitWarning = realEmitWarning; }
  upx = findUpx();
  return upx;
}

// Compress an executable in place with upx (keeps it standalone — it just
// self-extracts in memory when run). Returns whether it shrank.
function compressExe(exePath: string): boolean {
  const upx = ensureUpx();
  if (!upx) return false;
  console.log("  Compressing… (one-time, ~20s)\n");
  const r = spawnSync(upx, ["--best", "--lzma", "-q", exePath], { encoding: "utf8" });
  return r.status === 0;
}

// `sprout fast <file>` — compile + run on V8 (much faster); falls back to the
// interpreter for programs the fast build doesn't cover, so it's always correct.
async function fastFile(path: string): Promise<void> {
  const result = compileProject(path);
  if ("error" in result) { await runFile(path, "auto"); return; }   // fall back, always correct
  // Run the compiled module in THIS process (one startup; the runtime is already
  // loaded), so `sprout fast` is genuinely fast, not two node launches.
  const tmp = join(tmpdir(), `sprout-fast-${process.pid}-${basename(path, extname(path))}.mjs`);
  writeFileSync(tmp, result.js);
  await import(pathToFileURL(tmp).href);
}

// --- the benchmark: `sprout bench <file>` ------------------------------------
// Times a program on BOTH engines (the interpreter and the compiled build) and
// prints how much faster compiling makes it — a hands-on lesson in the
// difference between interpreted and compiled code, using your own program.
function fmtMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(3) + " s " : ms.toFixed(1) + " ms";
}
function meanSd(times: number[]): { mean: number; sd: number } {
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
  return { mean, sd: Math.sqrt(variance) };
}
// Pick a run count from how long one run took, so fast programs still get a
// stable average and slow ones don't take forever.
function runCount(firstMs: number, fixed: number): number {
  if (fixed > 0) return fixed;
  if (firstMs < 5) return 100;
  if (firstMs < 50) return 40;
  if (firstMs < 250) return 15;
  if (firstMs < 1000) return 8;
  return 5;
}

async function benchFile(path: string, runsArg?: string): Promise<void> {
  let source = "";
  try { source = readFileSync(path, "utf8"); }
  catch { fail(`I couldn't open the file: ${path}`, "Check the name and that the file is there."); }
  let program: ReturnType<typeof parse>;
  try { program = parse(tokenize(source)); }
  catch (err) {
    if (err instanceof LangError) { console.error("\n" + formatError(err, source) + "\n"); process.exit(1); }
    fatal(err); return;
  }
  const problems = check(program);
  if (problems.length) { for (const p of problems) console.error("\n" + formatError(p, source)); console.error(`\nFound ${problems.length} problem(s) — fix these and try again.\n`); process.exit(1); }

  const fixed = runsArg && /^\d+$/.test(runsArg) ? parseInt(runsArg, 10) : 0;
  const silent = (): void => {};
  const G = "\x1b[90m", Y = "\x1b[93m", B = "\x1b[1m", GR = "\x1b[92m", R = "\x1b[0m";

  // --- interpreter: run in-process, output suppressed, fresh state each run ---
  const runOnce = (): void => { new Interpreter(source, silent, { storage: memoryStorage(), net: noNet(), input: noInput() }).run(program); };
  let warm: number;
  try { const a = process.hrtime.bigint(); runOnce(); warm = Number(process.hrtime.bigint() - a) / 1e6; }
  catch (err) {
    if (err instanceof LangError) { console.error("\n" + formatError(err, source) + "\n  (bench runs your program for real — it needs to finish without errors)\n"); process.exit(1); }
    fatal(err); return;
  }
  const interpN = runCount(warm, fixed);
  const interpTimes: number[] = [];
  for (let i = 0; i < interpN; i++) { const a = process.hrtime.bigint(); runOnce(); interpTimes.push(Number(process.hrtime.bigint() - a) / 1e6); }
  const interp = meanSd(interpTimes);

  // --- compiled: import the .mjs in-process, cache-busted, output suppressed ---
  let comp: { mean: number; sd: number } | null = null;
  let compN = 0;
  const compiled = compile(program, RUNTIME_URL);
  if (!("error" in compiled)) {
    const tmp = join(tmpdir(), `sprout-bench-${process.pid}.mjs`);
    writeFileSync(tmp, compiled.js);
    const base = pathToFileURL(tmp).href;
    const realLog = console.log;
    console.log = silent;
    try {
      const a = process.hrtime.bigint(); await import(base + "?b=0"); const firstMs = Number(process.hrtime.bigint() - a) / 1e6;
      compN = runCount(firstMs, fixed);
      const ts: number[] = [];
      for (let i = 1; i <= compN; i++) { const x = process.hrtime.bigint(); await import(base + "?b=" + i); ts.push(Number(process.hrtime.bigint() - x) / 1e6); }
      comp = meanSd(ts);
    } finally { console.log = realLog; }
  }

  // --- report ---
  const peak = Math.max(interp.mean, comp ? comp.mean : 0) || 1;
  const W = 40;
  const bar = (mean: number, color: string): string => { const n = Math.max(1, Math.round((mean / peak) * W)); return color + "█".repeat(n) + G + "░".repeat(W - n) + R; };
  const row = (label: string, s: { mean: number; sd: number }, n: number, color: string): string =>
    "  " + color + label.padEnd(13) + R + fmtMs(s.mean).padStart(9) + G + "  ± " + s.sd.toFixed(s.mean >= 1000 ? 3 : 1).padStart(5) + "  (" + n + " runs)" + R + "  " + bar(s.mean, color);
  console.log("");
  console.log("  🌱  " + B + "sprout bench" + R + "  " + basename(path) + G + "   (execution time)" + R);
  console.log("");
  console.log(row("interpreter", interp, interpN, Y));
  if (comp) {
    console.log(row("compiled", comp, compN, GR));
    console.log("");
    const x = interp.mean / comp.mean;
    console.log("  " + GR + "→ compiled ran " + B + x.toFixed(1) + "×" + R + GR + " faster than the interpreter" + R);
  } else {
    console.log("  " + G + "compiled      not available — this program uses features the fast build doesn't cover (libraries, GUI)" + R);
  }
  console.log("");
}

// `sprout new <name>` — drop a friendly starter program so a beginner can go
// from nothing to a running program in one command.
function newFile(rawName: string): void {
  const name = rawName.endsWith(".sprout") ? rawName : rawName + ".sprout";
  const target = resolve(name);
  if (existsSync(target)) fail(`"${name}" already exists.`, "Pick a different name so nothing gets overwritten.");
  const stem = basename(name, ".sprout");
  const starter = [
    `~ ${stem}.sprout — made with Sprout 🌱`,
    `~ Lines starting with ~ are notes. Change anything and run it again!`,
    ``,
    `make name = "world"`,
    `show f"Hello, {name}!"`,
    ``,
    `make total = 0`,
    `repeat 5 times:`,
    `    set total = total + 1`,
    `show f"I counted to {total}"`,
    ``,
    `task greet(who):`,
    `    give f"Nice to meet you, {who}!"`,
    `show greet("friend")`,
    ``,
  ].join("\n");
  writeFileSync(target, starter);
  console.log(`✓ Created ${name}`);
  console.log(`  Run it:    sprout run ${name}`);
  console.log(`  Watch it:  sprout trace ${name}`);
}

// --- the step debugger: `sprout trace <file>` --------------------------------
// One recorded step: the line that ran, the variables right after it, and how
// much output existed by then.
type TraceFrame = { line: number; vars: [string, string][]; outLen: number };

// Is this source line a wait() call? wait() is dropped from a trace entirely —
// not shown, not stepped, not run. Matches `wait(...)` at the start, any indent.
function isSkipLine(src: string | undefined): boolean {
  return !!src && /^\s*wait\s*\(/.test(src);
}

// Draw the split screen: source (with a → on the current line) | the variables.
function renderTrace(lines: string[], cur: number, vars: [string, string][], output: string[], done: boolean, nav?: { step: number; total: number }): void {
  const W = process.stdout.columns || 90;
  const leftW = Math.max(28, Math.min(58, W - 34));
  const G = "\x1b[90m", Y = "\x1b[93m", B = "\x1b[1m", R = "\x1b[0m";
  let s = "\x1b[2J\x1b[H\x1b[?25l"; // clear, home, hide cursor
  let help: string;
  if (done) help = G + "finished — " + R + Y + "up" + R + G + " to review   " + R + Y + "q" + R + G + " quit" + R;
  else help = Y + "space" + R + G + " next   " + R + Y + "up" + R + G + " back   " + R + Y + "q" + R + G + " quit" + R + (nav ? G + `   (step ${nav.step}/${nav.total})` + R : "");
  s += "  " + B + "sprout trace" + R + "   " + help + "\n\n";
  // wait() lines are dropped — the source pane simply doesn't include them
  // (every other line keeps its real number).
  const display: Array<{ n: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) if (!isSkipLine(lines[i])) display.push({ n: i + 1, text: lines[i] });
  const rows = Math.max(display.length, vars.length + 2);
  for (let i = 0; i < rows; i++) {
    let cell: string;
    if (i < display.length) {
      const ln = display[i].n;
      let txt = ` ${ln === cur ? "→" : " "} ${String(ln).padStart(2)}  ${display[i].text}`;
      txt = txt.length > leftW ? txt.slice(0, leftW - 1) + "…" : txt.padEnd(leftW);
      cell = ln === cur ? Y + txt + R : G + txt.slice(0, 4) + R + txt.slice(4);
    } else cell = " ".repeat(leftW);
    let right = "";
    if (i === 0) right = B + "Variables" + R;
    else if (i === 1) right = G + "───────────" + R;
    else { const v = vars[i - 2]; if (v) right = v[0] + G + " = " + R + v[1]; }
    s += cell + G + " │ " + R + right + "\n";
  }
  if (output.length) { s += "\n" + G + "  output" + R + "\n"; for (const o of output.slice(-8)) s += "  " + o + "\n"; }
  process.stdout.write(s);
}

// Play a recorded trace back. Keys are read with raw-mode 'data' EVENTS — the
// standard, reliable way to read keys in Node. There's no per-key subprocess and
// no synchronous polling, so keys can't arrive out of order, nothing flushes
// from a stale buffer, and the cursor never moves on its own.
function playTrace(lines: string[], frames: TraceFrame[], output: string[]): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let i = 0;
    let done = false;

    const draw = (): void => {
      if (i >= frames.length) {
        const last = frames.length ? frames[frames.length - 1] : null;
        renderTrace(lines, last ? last.line : -1, last ? last.vars : [], output, true);
      } else {
        const f = frames[i];
        renderTrace(lines, f.line, f.vars, output.slice(0, f.outLen), false, { step: i + 1, total: frames.length });
      }
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", finish);
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\x1b[?25h\n"); // show the cursor again
      resolve();
    };

    const forward = (): void => { if (i < frames.length) { i++; draw(); } else finish(); };
    const back = (): void => { if (i > 0) { i--; draw(); } };

    // Walk the bytes of each event. A real terminal sends one keypress per event
    // (arrow keys arrive as a 3-byte escape sequence); piped input (tests) is a
    // run of bytes — either way we handle every key, in order.
    const onData = (data: Buffer): void => {
      if (done) return;
      const str = data.toString("utf8");
      let p = 0;
      while (p < str.length && !done) {
        if (str[p] === "\x1b") {
          const seq = str.substr(p, 3);
          if (seq === "\x1b[A" || seq === "\x1b[D") { back(); p += 3; continue; }    // up / left
          if (seq === "\x1b[B" || seq === "\x1b[C") { forward(); p += 3; continue; } // down / right
          finish(); return;                                                          // a lone Esc quits
        }
        const ch = str[p];
        if (ch === "q" || ch === "\x03") finish();
        else if (ch === "k" || ch === "u" || ch === "w") back();
        else if (ch === " " || ch === "j" || ch === "s" || ch === "\r" || ch === "\n") forward();
        // anything else is ignored — never advances on its own
        p += 1;
      }
    };

    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", finish); // piped input ran out
    draw();
  });
}

// `sprout trace <file>` — watch a program run one line at a time. It runs once to
// record every step (the line + the variables right after it), then you scrub
// through it with reliable keys: space / down = next, up = back, q = quit. wait()
// lines are dropped. Side-effecting actions (type/press/click, launch, shutdown,
// hosts blocking, ...) are NOT performed during a trace, so recording it can't
// type into your terminal, open apps, or change your system.
async function traceFile(path: string): Promise<void> {
  let source = "";
  try { source = readFileSync(path, "utf8"); }
  catch { fail(`I couldn't open the file: ${path}`, "Check the name and that the file is there."); }
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  const frames: TraceFrame[] = [];
  let pending: number | null = null; // a statement that ran; its result lands at the next step
  const MAX_FRAMES = 50000;          // a teaching trace, not a profiler — bound the memory

  const dataPath = join(dirname(path), basename(path, extname(path)) + ".data.json");
  const interp = new Interpreter(source, (l) => output.push(l), {
    storage: fileStorage(dataPath),
    net: nodeNet(),
    secrets: fileSecrets(join(dirname(path), ".env")),
    programDir: dirname(path),
    programFile: resolve(path),
    input: consoleInput(),
    // Record only — never blocks. Each frame is a statement + the state right
    // AFTER it ran (its result is the state captured at the next step). Returns
    // truthy to skip running a statement entirely (wait() lines).
    onStep: (line, vars) => {
      if (pending !== null) {
        if (frames.length < MAX_FRAMES) frames.push({ line: pending, vars, outLen: output.length });
        pending = null;
      }
      if (line < 0) return;                         // end-of-program signal
      if (isSkipLine(lines[line - 1])) return true; // wait() — never run it
      pending = line;
      return;
    },
  });

  const { run: program, problems } = await loadProject(path, interp);
  if (problems.length > 0) { for (const p of problems) console.error("\n" + p); process.exit(1); }

  try {
    interp.run(program); // record (instant — side effects are silenced)
  } catch (err) {
    if (err instanceof LangError) {
      await playTrace(lines, frames, output);     // let them step up to where it failed
      console.error("\n" + formatError(err, source) + "\n");
      process.exit(1);
    }
    fatal(err);
  }
  await playTrace(lines, frames, output);
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
      "  sprout fast <file.sprout>   run it the fast way (compiled to JavaScript)",
      "  sprout build <file.sprout>  build an .exe (asks how) — no-Node standalone, or a tiny needs-Node one",
      "  sprout build <file> --standalone   no-Node .exe (+ --no-compress)   ·   --needs-node = tiny .exe",
      "  sprout bench <file.sprout>  time it on both engines and compare the speed",
      "  sprout explain <file>       run it and narrate every step in plain English",
      "  sprout trace <file>         step through it line-by-line, watching variables",
      "  sprout new <name>           create a starter program to get going fast",
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
  } else if (args[0] === "fast" && args[1]) {
    await fastFile(args[1]);
  } else if (args[0] === "build" && args[1]) {
    await buildCommand(args[1], args.slice(2));
  } else if (args[0] === "bench" && args[1]) {
    await benchFile(args[1], args[2]);
  } else if (args[0] === "new" && args[1]) {
    newFile(args[1]);
  } else if (args[0] === "explain" && args[1]) {
    await runFile(args[1], "auto", true);
  } else if (args[0] === "trace" && args[1]) {
    await traceFile(args[1]);
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
