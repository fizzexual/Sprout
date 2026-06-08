// Sprout's test suite, using Node's built-in test runner (zero dependencies).
// Run with:  node --test test/sprout.test.ts   (or: npm test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenize } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { Interpreter } from "../src/interpreter.ts";
import { LangError } from "../src/errors.ts";
import { parseBloom, styleFor, windowStyle } from "../src/bloom.ts";
import { check } from "../src/checker.ts";
import { memoryStorage } from "../src/storage.ts";
import { memorySecrets, parseEnv } from "../src/secrets.ts";
import { create as discordBot } from "../libraries/discord-bot/index.ts";
import { create as networking } from "../libraries/networking/index.ts";
import { create as automations } from "../libraries/automations/index.ts";
import { create as screen } from "../libraries/screen/index.ts";
import { SList, NONE } from "../src/values.ts";
import { sealAudio, hchacha20, chooseMode, OggOpusDemuxer } from "../libraries/discord-bot/voice.ts";
import { isUrl, formatQueue, create as musicExt } from "../extensions/discord-bot/music/index.ts";
import { createDecipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { bundleStandalone } from "../src/bundle.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// Run the real `sprout` CLI on a freshly-written project folder and return its
// combined output — this exercises the multi-file module system end to end.
function runProject(files: Record<string, string>, command: "run" | "check", entry: string) {
  const dir = mkdtempSync(join(tmpdir(), "sprout-proj-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const r = spawnSync(process.execPath, [CLI, command, join(dir, entry)], { encoding: "utf8" });
    return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function problems(src: string): LangError[] {
  return check(parse(tokenize(src)));
}

// Run a snippet and capture everything `show` prints.
function run(src: string): string[] {
  const out: string[] = [];
  const interp = new Interpreter(src, (line) => out.push(line));
  interp.run(parse(tokenize(src)));
  return out;
}

// Run a snippet and return the interpreter (to inspect its GUI model).
function runApp(src: string): Interpreter {
  const interp = new Interpreter(src, () => {});
  interp.run(parse(tokenize(src)));
  return interp;
}

// Run a snippet that should fail, and return the error it raised.
function runErr(src: string): LangError {
  try {
    run(src);
  } catch (e) {
    if (e instanceof LangError) return e;
    throw e;
  }
  throw new Error("expected a LangError, but the program ran fine");
}

test("make + math precedence", () => {
  assert.deepEqual(run("make a = 2\nmake b = 3\nshow a + b * 2"), ["8"]);
});

test("parentheses override precedence", () => {
  assert.deepEqual(run("show (2 + 3) * 2"), ["10"]);
});

test("text joins with anything via +", () => {
  assert.deepEqual(run('show "n=" + 5'), ["n=5"]);
});

test("show prints several values space-separated", () => {
  assert.deepEqual(run('show "a", 1, yes'), ["a 1 yes"]);
});

test("set changes an existing variable", () => {
  assert.deepEqual(run("make x = 1\nset x = x + 4\nshow x"), ["5"]);
});

test("when / orwhen / otherwise picks the right branch", () => {
  const src = 'make x = 5\nwhen x > 9:\n    show "big"\norwhen x > 3:\n    show "mid"\notherwise:\n    show "small"';
  assert.deepEqual(run(src), ["mid"]);
});

test("repeat while counts", () => {
  assert.deepEqual(run("make i = 0\nrepeat while i < 3:\n    show i\n    set i = i + 1"), ["0", "1", "2"]);
});

test("repeat N times", () => {
  assert.deepEqual(run('repeat 3 times:\n    show "hi"'), ["hi", "hi", "hi"]);
});

test("fizzbuzz to 5", () => {
  const src =
    "make n = 1\nrepeat while n <= 5:\n" +
    "    when n % 15 == 0:\n        show \"FizzBuzz\"\n" +
    "    orwhen n % 3 == 0:\n        show \"Fizz\"\n" +
    "    orwhen n % 5 == 0:\n        show \"Buzz\"\n" +
    "    otherwise:\n        show n\n" +
    "    set n = n + 1";
  assert.deepEqual(run(src), ["1", "2", "Fizz", "4", "Buzz"]);
});

test("logic, comparisons, and yes/no", () => {
  assert.deepEqual(run("show 1 < 2 and 3 >= 3"), ["yes"]);
  assert.deepEqual(run("show not no"), ["yes"]);
  assert.deepEqual(run('show "a" == "a"'), ["yes"]);
  assert.deepEqual(run('show 1 == "1"'), ["no"]);
});

test("built-in functions", () => {
  assert.deepEqual(run("show sqrt(16)"), ["4"]);
  assert.deepEqual(run("show max(3, 9, 5)"), ["9"]);
  assert.deepEqual(run("show min(3, 9, 5)"), ["3"]);
  assert.deepEqual(run("show abs(-7)"), ["7"]);
  assert.deepEqual(run("show round(3.7)"), ["4"]);
  assert.deepEqual(run('show length("hello")'), ["5"]);
  assert.deepEqual(run('show upper("hi")'), ["HI"]);
  assert.deepEqual(run('show lower("HI")'), ["hi"]);
});

test("a comment with ~ is ignored", () => {
  assert.deepEqual(run('~ this is a note\nshow "ok"  ~ and so is this'), ["ok"]);
});

test("a task gives back a value", () => {
  assert.deepEqual(run("task add(a, b):\n    give a + b\nshow add(2, 3)"), ["5"]);
});

test("a task can be called as a procedure (no give)", () => {
  assert.deepEqual(run('task hi(name):\n    show "hi " + name\nhi("sam")'), ["hi sam"]);
});

test("recursion works (factorial)", () => {
  const src = "task fact(n):\n    when n <= 1:\n        give 1\n    give n * fact(n - 1)\nshow fact(5)";
  assert.deepEqual(run(src), ["120"]);
});

test("tasks can be called before they are defined", () => {
  assert.deepEqual(run("show twice(4)\ntask twice(n):\n    give n * 2"), ["8"]);
});

test("a task without give hands back nothing", () => {
  assert.deepEqual(run('task noop():\n    show "ran"\nmake r = noop()\nshow r'), ["ran", "nothing"]);
});

test("variables inside a task stay local", () => {
  const e = runErr("task f():\n    make secret = 1\n    give secret\nmake x = f()\nshow secret");
  assert.equal(e.kind, "Name");
});

test("error: wrong number of arguments to a task", () => {
  const e = runErr("task f(a):\n    give a\nshow f(1, 2)");
  assert.equal(e.kind, "Type");
});

test("error: give outside a task", () => {
  const e = runErr("give 5");
  assert.equal(e.kind, "Runtime");
});

test("gui: a program builds a window with widgets", () => {
  const interp = runApp('window("Counter")\nlabel("d", "Count: 0")\nbutton("Add", "add")\ntask add():\n    label("d", "x")');
  const gui = interp.getGui();
  assert.equal(gui.used, true);
  assert.equal(gui.title, "Counter");
  assert.equal(gui.widgets.length, 2);
  assert.equal(gui.widgets[0].kind, "label");
  assert.equal(gui.widgets[1].kind, "button");
  assert.equal(gui.widgets[1].onClick, "add");
});

test("gui: clicking a button runs its task and updates a label", () => {
  const interp = runApp('make n = 0\nwindow("C")\nlabel("d", "0")\nbutton("Add", "add")\ntask add():\n    set n = n + 1\n    label("d", "" + n)');
  interp.clickButton("add");
  interp.clickButton("add");
  const display = interp.getGui().widgets.find((w) => w.id === "d");
  assert.equal(display?.text, "2");
});

test("gui: textof reads a field's value", () => {
  const interp = runApp('window("G")\nfield("name", "name")\nlabel("hi", "Hello!")\nbutton("Go", "greet")\ntask greet():\n    label("hi", "Hello, " + textof("name") + "!")');
  interp.setFieldValues({ name: "Sam" });
  interp.clickButton("greet");
  const hi = interp.getGui().widgets.find((w) => w.id === "hi");
  assert.equal(hi?.text, "Hello, Sam!");
});

test("a plain program is not a GUI app", () => {
  const interp = runApp('show "hi"');
  assert.equal(interp.isGuiApp(), false);
});

test("bloom: parses selectors and properties", () => {
  const t = parseBloom("window:\n    background: #111\n    font: Segoe UI 14\nbutton:\n    background: #7bd88f");
  assert.equal(windowStyle(t).background, "#111");
  assert.equal(windowStyle(t).font, "Segoe UI 14");
  assert.equal(t.selectors["button"].background, "#7bd88f");
});

test("bloom: id styles override kind styles", () => {
  const t = parseBloom("label:\n    text: #fff\n#title:\n    text: #f00");
  assert.equal(styleFor(t, "label", "title").text, "#f00");
  assert.equal(styleFor(t, "label", "other").text, "#fff");
});

test("bloom: comments with ~ are ignored", () => {
  const t = parseBloom("~ a note\nbutton:\n    rounded: 12  ~ trailing note");
  assert.equal(t.selectors["button"].rounded, "12");
});

test('style "..." records the stylesheet path', () => {
  const interp = runApp('style "theme.bloom"\nwindow("W")\nlabel("a", "b")');
  assert.equal(interp.getGui().stylePath, "theme.bloom");
});

test("server() marks the app as a website", () => {
  const interp = runApp('server("Site")\nlabel("a", "b")');
  assert.equal(interp.getGui().mode, "server");
  assert.equal(interp.isGuiApp(), true);
});

test("window() marks the app as a native window", () => {
  const interp = runApp('window("App")\nlabel("a", "b")');
  assert.equal(interp.getGui().mode, "gui");
});

test("no style means no styling (raw)", () => {
  const interp = runApp('window("App")\nlabel("a", "b")');
  assert.equal(interp.getGui().stylePath, undefined);
});

test("checker: a clean program has no problems", () => {
  assert.equal(problems("make x = 1\nshow x + 2").length, 0);
});

test("checker: catches an undefined variable", () => {
  const p = problems('make name = "x"\nshow nme');
  assert.equal(p[0].kind, "Name");
});

test("checker: catches an unknown function", () => {
  assert.equal(problems("show sqrtt(9)")[0].kind, "Name");
});

test("checker: catches wrong arity (builtin and task)", () => {
  assert.equal(problems("show sqrt(1, 2)")[0].kind, "Type");
  assert.equal(problems("task f(a):\n    give a\nshow f(1, 2)")[0].kind, "Type");
});

test("checker: catches give outside a task and set before make", () => {
  assert.equal(problems("give 5")[0].kind, "Runtime");
  assert.equal(problems("set x = 5")[0].kind, "Name");
});

test("checker: no false positive for a conditionally-made variable", () => {
  const src = "make c = yes\nwhen c:\n    make x = 1\notherwise:\n    make x = 2\nshow x";
  assert.equal(problems(src).length, 0);
});

test("checker: a task's local is not visible outside it", () => {
  const src = "task f():\n    make secret = 1\n    give secret\nshow secret";
  assert.ok(problems(src).some((e) => e.kind === "Name"));
});

test("remember/recall persist across runs (shared storage)", () => {
  const store = memoryStorage();
  const s1 = 'remember("score", 42)';
  new Interpreter(s1, () => {}, { storage: store }).run(parse(tokenize(s1)));
  const out: string[] = [];
  const s2 = 'show recall("score", 0)';
  new Interpreter(s2, (l) => out.push(l), { storage: store }).run(parse(tokenize(s2)));
  assert.deepEqual(out, ["42"]);
});

test("recall returns the default when nothing is saved", () => {
  assert.deepEqual(run('show recall("missing", 7)'), ["7"]);
});

test("checker knows remember/recall arity", () => {
  assert.equal(problems("show recall()")[0].kind, "Type");
  assert.equal(problems('remember("k")')[0].kind, "Type");
});

test("get returns the response text (mocked net)", () => {
  const net = { get: () => '{"fact":"cats purr"}', post: () => "" };
  const out: string[] = [];
  const src = 'show get("http://x")';
  new Interpreter(src, (l) => out.push(l), { net }).run(parse(tokenize(src)));
  assert.match(out[0], /cats purr/);
});

test("get without internet gives a friendly error", () => {
  let kind = "";
  try { run('show get("http://x")'); } catch (e) { if (e instanceof LangError) kind = e.kind; }
  assert.equal(kind, "Runtime");
});

test("jsonpick reads a value out of JSON (nested)", () => {
  assert.deepEqual(run('show jsonpick("{\\"a\\":{\\"b\\":42}}", "a.b")'), ["42"]);
  assert.deepEqual(run('show jsonpick("{\\"a\\":1}", "missing")'), ["nothing"]);
});

test("checker knows get/post/jsonpick arity", () => {
  assert.equal(problems("show get()")[0].kind, "Type");
  assert.equal(problems('post("u")')[0].kind, "Type");
  assert.equal(problems('show jsonpick("x")')[0].kind, "Type");
});

test("explore lists every path in a JSON reply", () => {
  const text = run('show explore("{\\"a\\":1,\\"b\\":{\\"c\\":2}}")').join("\n");
  assert.match(text, /a = 1/);
  assert.match(text, /b\.c = 2/);
});

test("checker knows explore arity", () => {
  assert.equal(problems("show explore()")[0].kind, "Type");
});

test("get_api_points lists the field names of a JSON reply", () => {
  const out = run('show get_api_points("{\\"a\\":1,\\"b\\":{\\"c\\":2}}")').join("\n");
  assert.match(out, /This API has these/);
  assert.match(out, /^a$/m);
  assert.match(out, /^b\.c$/m);
});

test("checker knows get_api_points arity", () => {
  assert.equal(problems("show get_api_points()")[0].kind, "Type");
});

test("library builtins can be registered and called", () => {
  const out: string[] = [];
  const src = 'show greet("world")';
  const interp = new Interpreter(src, (l) => out.push(l));
  interp.registerLibraryBuiltins({ greet: (args) => "hi " + args[0] });
  interp.run(parse(tokenize(src)));
  assert.deepEqual(out, ["hi world"]);
});

test("runTask runs a top-level task by name", () => {
  const out: string[] = [];
  const src = 'task go():\n    show "ran"';
  const interp = new Interpreter(src, (l) => out.push(l));
  interp.run(parse(tokenize(src)));
  interp.runTask("go");
  assert.deepEqual(out, ["ran"]);
});

test('use "..." parses as a Use statement', () => {
  const prog = parse(tokenize('use "discord-bot"\nshow "ok"'));
  assert.equal(prog[0].type, "Use");
});

test("discord-bot library exposes its builtins", () => {
  const lib = discordBot({} as never);
  assert.ok(lib.names.includes("on_message"));
  assert.equal(lib.isActive(), false);
  lib.builtins.bot(["TOKEN"]);
  assert.equal(lib.isActive(), true);
  lib.builtins.on_message(["handle"]);
  assert.equal(lib.builtins.message([]), "");
});

test("secret() reads from the injected source", () => {
  const out: string[] = [];
  const src = 'show secret("TOKEN")';
  const interp = new Interpreter(src, (l) => out.push(l), { secrets: memorySecrets({ TOKEN: "abc123" }) });
  interp.run(parse(tokenize(src)));
  assert.deepEqual(out, ["abc123"]);
});

test("secret() gives a friendly error when it's missing", () => {
  const src = 'show secret("NOPE")';
  const interp = new Interpreter(src, () => {}, { secrets: memorySecrets({}) });
  assert.throws(() => interp.run(parse(tokenize(src))), /couldn't find a secret called 'NOPE'/);
});

test("checker knows secret arity", () => {
  assert.equal(problems("show secret()")[0].kind, "Type");
  assert.equal(problems('show secret("A", "B")')[0].kind, "Type");
  assert.deepEqual(problems('show secret("TOKEN")'), []);
});

test("parseEnv reads KEY = value lines, comments, and quotes", () => {
  const env = parseEnv('~ a comment\n# another\nDISCORD_TOKEN = abc\nQUOTED = "x y"\nEMPTY=\n');
  assert.equal(env.DISCORD_TOKEN, "abc");
  assert.equal(env.QUOTED, "x y");
  assert.equal(env.EMPTY, "");
  assert.equal("a comment" in env, false);
});

// --- voice transport (the music extension's hardest piece) ---

test("voice: chooseMode prefers AES-GCM, falls back to XChaCha, else null", () => {
  assert.equal(chooseMode(["aead_xchacha20_poly1305_rtpsize", "aead_aes256_gcm_rtpsize"]), "aead_aes256_gcm_rtpsize");
  assert.equal(chooseMode(["aead_xchacha20_poly1305_rtpsize"]), "aead_xchacha20_poly1305_rtpsize");
  assert.equal(chooseMode(["xsalsa20_poly1305"]), null);
});

test("voice: hchacha20 is deterministic and 32 bytes", () => {
  const key = Buffer.alloc(32, 1);
  const nonce = Buffer.alloc(16, 2);
  const a = hchacha20(key, nonce);
  const b = hchacha20(key, nonce);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, hchacha20(key, Buffer.alloc(16, 3)));
});

test("voice: AES-256-GCM packet seals and opens with the right AAD + nonce", () => {
  const key = Buffer.alloc(32, 7);
  const header = Buffer.from([0x80, 0x78, 0, 1, 0, 0, 0, 0, 0, 0, 0, 5]);
  const audio = Buffer.from("opus-frame-bytes");
  const sealed = sealAudio("aead_aes256_gcm_rtpsize", key, header, audio, 42);
  const nonce4 = sealed.subarray(sealed.length - 4);
  assert.equal(nonce4.readUInt32BE(0), 42);
  const tag = sealed.subarray(sealed.length - 20, sealed.length - 4);
  const ct = sealed.subarray(0, sealed.length - 20);
  const iv = Buffer.alloc(12);
  nonce4.copy(iv, 0);
  const dec = createDecipheriv("aes-256-gcm", key, iv);
  dec.setAAD(header);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(ct), dec.final()]);
  assert.equal(plain.toString(), "opus-frame-bytes");
});

test("voice: XChaCha20-Poly1305 packet seals and opens", () => {
  const key = Buffer.alloc(32, 9);
  const header = Buffer.from([0x80, 0x78, 0, 2, 0, 0, 3, 192, 0, 0, 0, 5]);
  const audio = Buffer.from("another-opus-frame");
  const sealed = sealAudio("aead_xchacha20_poly1305_rtpsize", key, header, audio, 123);
  const nonce4 = sealed.subarray(sealed.length - 4);
  const tag = sealed.subarray(sealed.length - 20, sealed.length - 4);
  const ct = sealed.subarray(0, sealed.length - 20);
  const xnonce = Buffer.alloc(24);
  nonce4.copy(xnonce, 0);
  const subkey = hchacha20(key, xnonce.subarray(0, 16));
  const chachaNonce = Buffer.alloc(12);
  xnonce.subarray(16, 24).copy(chachaNonce, 4);
  const dec = createDecipheriv("chacha20-poly1305", subkey, chachaNonce, { authTagLength: 16 });
  dec.setAAD(header);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(ct), dec.final()]);
  assert.equal(plain.toString(), "another-opus-frame");
});

test("voice: Ogg demuxer skips the 2 header packets and returns audio packets", () => {
  const oggPage = (segLens: number[], body: Buffer): Buffer => {
    const head = Buffer.alloc(27 + segLens.length);
    head.write("OggS", 0, "ascii");
    head[26] = segLens.length;
    for (let i = 0; i < segLens.length; i++) head[27 + i] = segLens[i];
    return Buffer.concat([head, body]);
  };
  const opusHead = Buffer.from("OpusHead");
  const opusTags = Buffer.from("OpusTags");
  const audio = Buffer.from("AUDIO1");
  const page = oggPage([8, 8, 6], Buffer.concat([opusHead, opusTags, audio]));
  const out = new OggOpusDemuxer().push(page);
  assert.equal(out.length, 1);
  assert.equal(out[0].toString(), "AUDIO1");
});

// --- music extension ---

test("music: isUrl recognises links vs search words", () => {
  assert.equal(isUrl("https://youtu.be/dQw4w9WgXcQ"), true);
  assert.equal(isUrl("never gonna give you up"), false);
});

test("music: formatQueue shows now-playing and the list", () => {
  const t = (title: string): { title: string; url: string; requestedBy: string; textChannelId: string } =>
    ({ title, url: "", requestedBy: "", textChannelId: "" });
  assert.match(formatQueue(null, []), /empty/i);
  const out = formatQueue(t("Song A"), [t("Song B"), t("Song C")]);
  assert.match(out, /Now playing.*Song A/);
  assert.match(out, /1\. Song B/);
  assert.match(out, /2\. Song C/);
});

test("music extension registers its commands on the discord api", () => {
  const commands: string[] = [];
  const slashes: string[] = [];
  const slashOptions: Record<string, Array<{ name: string }>> = {};
  const buttons: string[] = [];
  const actions: string[] = [];
  const fakeApi = {
    interp: null,
    onCommand: (w: string) => commands.push(w),
    onSlash: (n: string, _d: string, _h: unknown, opts: Array<{ name: string }> = []) => { slashes.push(n); slashOptions[n] = opts; },
    onButton: (id: string) => buttons.push(id),
    registerAction: (ref: string) => actions.push(ref),
    send: () => {},
    sendEmbed: () => {},
    voiceChannelOf: () => null,
    voiceAdapterCreator: () => () => ({ sendPayload: () => true, destroy: () => {} }),
    log: () => {},
  };
  musicExt(null as never, { api: fakeApi } as never);
  assert.deepEqual(commands.sort(), ["play", "queue", "skip", "stop"]);
  assert.ok(slashes.includes("play"));
  assert.equal(slashOptions.play[0].name, "song");   // /play has a "song" text field
  assert.ok(buttons.includes("music:playpause") && buttons.includes("music:volup")); // controller buttons
  assert.ok(actions.includes("discord-bot/music/play")); // wireable extension action
});

test("discord-bot library exposes an extension api", () => {
  const lib = discordBot({} as never);
  assert.equal(typeof lib.api.onCommand, "function");
  assert.equal(typeof lib.api.onSlash, "function");
  assert.equal(typeof lib.api.voiceAdapterCreator, "function");
  assert.equal(lib.api.voiceChannelOf("g", "u"), null);
});

test("discord-bot: slash() registers a Sprout-defined slash command", () => {
  const interp = new Interpreter("", () => {});
  const lib = discordBot(interp as never);
  assert.deepEqual(lib.api.slashCommandNames(), []);
  lib.builtins.slash(["hello", "Say hi", "onHello"]);
  assert.ok(lib.api.slashCommandNames().includes("hello"));
});

test("discord-bot: slash() can wire a command to an extension action", () => {
  const interp = new Interpreter("", () => {});
  const lib = discordBot(interp as never);
  lib.api.registerAction("discord-bot/music/play", () => {});
  // Wiring with an "lib/ext/fn" ref registers the command against that action.
  lib.builtins.slash(["play", "play some music", "discord-bot/music/play"]);
  assert.ok(lib.api.slashCommandNames().includes("play"));
});

test("nothing is a value you can write and compare", () => {
  assert.deepEqual(run("show nothing"), ["nothing"]);
  assert.deepEqual(run('make x = nothing\nwhen x == nothing:\n    show "empty"'), ["empty"]);
});

test("recall of a missing key equals nothing", () => {
  assert.deepEqual(run('when recall("missing") == nothing:\n    show "absent"'), ["absent"]);
});

test("security: only a button's task can be triggered", () => {
  const src = 'task danger():\n    show "boom"\ntask ok():\n    label("d", "hi")\nwindow("X")\nlabel("d", "")\nbutton("Go", "ok")';
  const interp = runApp(src);
  interp.clickButton("ok"); // wired to a button -> allowed
  let blocked = false;
  try { interp.clickButton("danger"); } catch (e) { blocked = e instanceof LangError; }
  assert.ok(blocked, "an un-wired task must not be runnable from a click");
});

test("error: unknown name suggests the closest one", () => {
  const e = runErr('make name = "x"\nshow nme');
  assert.equal(e.kind, "Name");
  assert.match(e.hint ?? "", /name/);
});

test("error: changing a variable without making it first", () => {
  const e = runErr("set x = 5");
  assert.equal(e.kind, "Name");
});

test("error: forgetting set nudges you", () => {
  const e = runErr("make x = 1\nx = 2");
  assert.equal(e.kind, "Syntax");
  assert.match(e.hint ?? "", /set/);
});

test("error: divide by zero", () => {
  const e = runErr("show 1 / 0");
  assert.equal(e.kind, "Runtime");
});

test("error: missing colon is a syntax error", () => {
  const e = runErr('when 1 < 2\n    show "x"');
  assert.equal(e.kind, "Syntax");
});

test("error: stray indentation", () => {
  const e = runErr('show "a"\n    show "b"');
  assert.equal(e.kind, "Indentation");
});

test("error: unterminated string points at the start", () => {
  const e = runErr('show "hello');
  assert.equal(e.kind, "Syntax");
  assert.equal(e.line, 1);
});

test("error: wrong argument type to a builtin", () => {
  const e = runErr('show sqrt("nope")');
  assert.equal(e.kind, "Type");
});

test("error: unknown function suggests a builtin", () => {
  const e = runErr("show sqrtt(9)");
  assert.equal(e.kind, "Name");
  assert.match(e.hint ?? "", /sqrt/);
});

// --- v0.5: lists, maps & for each -------------------------------------------

test("lists: literal, index, length, first/last", () => {
  assert.deepEqual(run("make xs = [3, 1, 2]\nshow xs\nshow xs[1]\nshow length(xs)\nshow first(xs), last(xs)"),
    ["[3, 1, 2]", "1", "3", "3 2"]);
});

test("lists: add mutates, set by index, out-of-range reads nothing", () => {
  assert.deepEqual(run("make xs = [1]\nadd(xs, 2)\nset xs[0] = 9\nshow xs\nshow xs[5]"),
    ["[9, 2]", "nothing"]);
});

test("lists: contains, concat, deep equality", () => {
  assert.deepEqual(run("show contains([1,2,3], 2)\nshow [1,2] + [3]\nshow [1,2] == [1,2]"),
    ["yes", "[1, 2, 3]", "yes"]);
});

test("for each: over a list sums; range() makes a list", () => {
  assert.deepEqual(run("make t = 0\nfor each n in [1,2,3,4]:\n    set t = t + n\nshow t\nshow range(3)"),
    ["10", "[0, 1, 2]"]);
});

test("for each: over text iterates characters", () => {
  assert.deepEqual(run('make out = ""\nfor each c in "hi":\n    set out = out + c + "."\nshow out'),
    ["h.i."]);
});

test("maps: literal, index read/write, keys, for each over keys", () => {
  assert.deepEqual(run('make p = {name: "Sam", age: 3}\nset p["age"] = 4\nshow p["name"], p["age"]\nshow keys(p)\nshow contains(p, "name")'),
    ["Sam 4", '["name", "age"]', "yes"]);
});

test("maps: missing key reads nothing; deep equality", () => {
  assert.deepEqual(run('make p = {a: 1}\nshow p["nope"]\nshow {a: 1} == {a: 1}\nshow {a: 1} == {a: 2}'),
    ["nothing", "yes", "no"]);
});

test("error: for each over a number is a Type error", () => {
  const e = runErr("for each x in 5:\n    show x");
  assert.equal(e.kind, "Type");
});

test("error: indexing a number is a Type error", () => {
  const e = runErr("make n = 5\nshow n[0]");
  assert.equal(e.kind, "Type");
});

test("checker: the for-each item name is in scope", () => {
  assert.deepEqual(problems("for each x in [1,2]:\n    show x"), []);
});

test("checker: add() arity is enforced", () => {
  const errs = problems("make xs = [1]\nshow add(xs)");
  assert.equal(errs.length, 1);
  assert.equal(errs[0].kind, "Type");
});

// --- v0.5.1: ask, number, explain, infinite-loop detector -------------------

test("number() converts text; gives nothing when it isn't a number", () => {
  assert.deepEqual(run('show number("42") + 1\nshow number("oops")'), ["43", "nothing"]);
});

test("ask() returns whatever the input capability provides", () => {
  const src = 'make n = ask("name?")\nshow "hi", n';
  const out: string[] = [];
  const interp = new Interpreter(src, (l) => out.push(l), { input: { ask: () => "Sam" } });
  interp.run(parse(tokenize(src)));
  assert.deepEqual(out, ["hi Sam"]);
});

test("sprout explain narrates variable changes", () => {
  const src = "make x = 1\nset x = x + 1";
  const narration: string[] = [];
  const interp = new Interpreter(src, () => {}, { narrate: (m) => narration.push(m.trim()) });
  interp.run(parse(tokenize(src)));
  assert.ok(narration.some((l) => l.includes("x is 1")));
  assert.ok(narration.some((l) => l.includes("x is now 2")));
});

test("checker flags a repeat while that can never stop", () => {
  const errs = problems('repeat while yes:\n    show "hi"');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].kind, "Runtime");
});

test("checker leaves a normal repeat while alone", () => {
  assert.deepEqual(problems("make i = 0\nrepeat while i < 3:\n    set i = i + 1"), []);
});

test("give returns early out of a loop", () => {
  assert.deepEqual(run("task f(xs):\n    for each x in xs:\n        when x > 2:\n            give x\n    give 0\nshow f([1, 2, 5, 9])"), ["5"]);
});

test("give unwinds out of nested loops", () => {
  assert.deepEqual(run('task f():\n    repeat 5 times:\n        for each y in [1, 2, 3]:\n            when y == 2:\n                give "hit"\n    give "miss"\nshow f()'), ["hit"]);
});

test("give early out of a repeat while", () => {
  assert.deepEqual(run("task f(limit):\n    make i = 0\n    repeat while i < 1000:\n        set i = i + 1\n        when i >= limit:\n            give i\n    give -1\nshow f(4)"), ["4"]);
});

test("a give in one task does not leak into the next", () => {
  assert.deepEqual(run('task a():\n    give "A"\ntask b():\n    give "B"\nshow a(), b()'), ["A B"]);
});

test("networking library: registers its builtins; hostname/localip work offline", () => {
  const lib = networking(new Interpreter(""));
  assert.ok(["hostname", "localip", "myip", "online", "status", "ping", "download", "block", "unblock", "isblocked", "blocked"].every((n) => lib.names.includes(n)));
  assert.equal(typeof lib.builtins.hostname([]), "string");
  assert.match(String(lib.builtins.localip([])), /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(lib.isActive(), false);   // pure builtins, no long-running runtime
});

test("networking library: isblocked is false for an unblocked site; blocked() is a list", () => {
  const lib = networking(new Interpreter(""));
  assert.equal(lib.builtins.isblocked(["definitely-not-blocked-xyz12345.test"]), false);
  assert.ok(lib.builtins.blocked([]) instanceof SList);
});

test("automations library: app/startup builtins are registered", () => {
  const lib = automations(new Interpreter(""));
  assert.ok(["launch", "running", "closeapp", "start_with_pc", "stop_with_pc", "starts_with_pc"].every((n) => lib.names.includes(n)));
  assert.equal(lib.builtins.running(["totally-fake-app-name-987"]), false);
  assert.equal(lib.builtins.starts_with_pc(["SproutNonexistentStartupXYZ"]), false);
});

test("automations library: friendly time strings, weekday, and a 12-hour clock", () => {
  const lib = automations(new Interpreter(""));
  assert.match(String(lib.builtins.now(["12h"])), /^\d{1,2}:\d\d (AM|PM)$/);
  assert.ok(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(String(lib.builtins.weekday([]))));
  lib.builtins.every(["10 minutes", "tick"], { line: 1, col: 1 });   // text duration is accepted
  lib.builtins.at(["Monday 09:00", "wake"], { line: 1, col: 1 });    // weekday + time
  lib.builtins.at(["8:30pm", "dinner"], { line: 1, col: 1 });        // 12-hour am/pm
  assert.equal(lib.isActive(), true);
  assert.throws(() => lib.builtins.after(["soon-ish", "t"], { line: 1, col: 1 }), /time/);
});

test("automations library: run_on_startup links the project (needs a known main file)", () => {
  const lib = automations(new Interpreter(""));
  assert.ok(["run_on_startup", "runs_on_startup", "weekday"].every((n) => lib.names.includes(n)));
  assert.equal(lib.builtins.runs_on_startup([]), false);                           // nothing registered
  assert.throws(() => lib.builtins.run_on_startup([], { line: 1, col: 1 }));        // no main file known -> friendly error
});

test("automations library: now/today format, and scheduling marks it active", () => {
  const lib = automations(new Interpreter(""));
  assert.match(String(lib.builtins.now([])), /^\d\d:\d\d:\d\d$/);
  assert.match(String(lib.builtins.today([])), /^\d{4}-\d\d-\d\d$/);
  assert.equal(lib.isActive(), false);
  lib.builtins.every([2, "tick"], { line: 1, col: 1 });
  assert.equal(lib.isActive(), true);     // a job was scheduled -> start() will run
});

test("automations library: at() rejects a bad time, every() rejects a bad interval", () => {
  const lib = automations(new Interpreter(""));
  assert.throws(() => lib.builtins.at(["25:00", "x"], { line: 1, col: 1 }), /time/);
  assert.throws(() => lib.builtins.every([0, "tick"], { line: 1, col: 1 }), /zero/);
});

test("modules: a file can use another file's task", () => {
  const { out, code } = runProject(
    {
      "helper.sprout": "task double(n):\n    give n * 2\n",
      "main.sprout": 'use "helper.sprout"\nshow double(21)\n',
    },
    "run",
    "main.sprout",
  );
  assert.equal(code, 0);
  assert.match(out, /42/);
});

test("modules: imports chain (A uses B uses C)", () => {
  const { out, code } = runProject(
    {
      "c.sprout": "task base():\n    give 10\n",
      "b.sprout": 'use "c.sprout"\ntask mid():\n    give base() + 5\n',
      "a.sprout": 'use "b.sprout"\nshow mid()\n',
    },
    "run",
    "a.sprout",
  );
  assert.equal(code, 0);
  assert.match(out, /15/);
});

test("modules: check reports which file a problem is in", () => {
  const { out, code } = runProject(
    {
      "helper.sprout": "task greet():\n    show nope\n",   // 'nope' is undefined
      "main.sprout": 'use "helper.sprout"\ngreet()\n',
    },
    "check",
    "main.sprout",
  );
  assert.notEqual(code, 0);
  assert.match(out, /helper\.sprout/);
});

// --- Every command is wired up ----------------------------------------------
// "Add a test to every command": each command a library advertises must actually
// be a registered, callable function. This catches the whole "command silently
// not working because it's mis-wired / typo'd / a module failed to load" class
// across ALL ~180 commands at once. (Behaviour of side-effecting commands like
// launch/shutdown can't be safely auto-run, but this proves none are missing.)
for (const [libName, make, atLeast] of [
  ["networking", networking, 30],
  ["automations", automations, 60],
  ["discord-bot", discordBot, 5],
  ["screen", screen, 12],
] as const) {
  test(`every ${libName} command is registered and callable`, () => {
    const lib = make(new Interpreter(""));
    assert.ok(lib.names.length >= atLeast, `${libName} exposed only ${lib.names.length} commands — did a module fail to load?`);
    assert.equal(new Set(lib.names).size, lib.names.length, `${libName} has a duplicate command name`);
    for (const name of lib.names) {
      assert.equal(typeof lib.builtins[name], "function", `${libName} command '${name}' is advertised but not a registered function`);
    }
  });
}

// Safe, deterministic commands return the right kind of value (no network, no
// side effects) — a fast health check that the common ones actually work.
test("safe info/time commands return sensible values", () => {
  const net = networking(new Interpreter(""));
  assert.equal(typeof net.builtins.hostname([]), "string");
  assert.match(String(net.builtins.localip([])), /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(net.builtins.isblocked(["definitely-not-blocked-xyz.test"]), false);

  const auto = automations(new Interpreter(""));
  assert.match(String(auto.builtins.now([])), /^\d\d:\d\d:\d\d$/);
  assert.match(String(auto.builtins.today([])), /^\d{4}-\d\d-\d\d$/);
  assert.ok(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(String(auto.builtins.weekday([]))));
  assert.equal(auto.builtins.running(["totally-fake-app-987"]), false);
});

// The trace safety denylist must name REAL commands, or it would silently fail
// to silence them while tracing.
test("trace-silenced commands all exist as real automations commands", () => {
  const have = new Set(automations(new Interpreter("")).names);
  for (const n of ["type", "press", "typeto", "click", "movemouse", "shutdown", "restart", "sleep", "lock"]) {
    assert.ok(have.has(n), `the trace denylist names '${n}', but no such command exists`);
  }
});

// --- new in v0.6.1: standalone bundle, bench, new ---------------------------
function runCli(args: string[], cwd?: string, env?: Record<string, string>): { out: string; code: number | null } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd, env: env ? { ...process.env, ...env } : process.env });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status };
}

// The standalone bundler inlines the whole runtime into one file that runs
// identically — this is the custom part, so test it directly and deterministically.
test("standalone bundle: inlines the runtime into one runnable file", () => {
  const compiled = compile(parse(tokenize("make x = 6\nshow x * 7\n")), "@runtime");
  assert.ok(!("error" in compiled), "a core program should compile");
  const js = bundleStandalone((compiled as { js: string }).js);
  assert.doesNotMatch(js, /\bimport\b|\bexport\b/, "the bundle must have no ESM import/export left");
  const dir = mkdtempSync(join(tmpdir(), "sprout-bundle-"));
  try {
    const f = join(dir, "out.cjs");
    writeFileSync(f, js);
    const r = spawnSync(process.execPath, [f], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout ?? "", /42/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build --standalone: command succeeds and emits a self-contained artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprout-sa-"));
  try {
    writeFileSync(join(dir, "p.sprout"), "show 6 * 7\n");
    // SPROUT_SKIP_EXE: skip the heavy .exe build in tests — we only check the bundle.
    const r = runCli(["build", join(dir, "p.sprout"), "--standalone"], undefined, { SPROUT_SKIP_EXE: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Bundled|Built/);
    // either a portable .cjs (no postject) or a real .exe (postject present)
    assert.ok(existsSync(join(dir, "p.cjs")) || existsSync(join(dir, "p.exe")) || existsSync(join(dir, "p")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build: compiles a MULTI-FILE project that uses ask() into one program", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprout-proj-build-"));
  try {
    writeFileSync(join(dir, "data.sprout"), "task double(n):\n    give n * 2\n");
    writeFileSync(join(dir, "main.sprout"), 'use "data.sprout"\nmake x = ask("n?")\nshow double(number(x))\n');
    const built = runCli(["build", join(dir, "main.sprout")]);
    assert.equal(built.code, 0, built.out);
    const mjs = join(dir, "main.mjs");
    assert.ok(existsSync(mjs), "the merged project should compile to one .mjs");
    const r = spawnSync(process.execPath, [mjs], { encoding: "utf8", input: "21\n" });
    assert.match(r.stdout ?? "", /42/); // cross-file task + ask() both work in the compiled program
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The wizard ALWAYS produces an .exe — never a needs-Node .mjs — whichever way
// you answer "does it need Node?".
test("build wizard: 'no Node' answer takes the standalone .exe path (never .mjs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprout-wiz-"));
  try {
    writeFileSync(join(dir, "w.sprout"), "show 6 * 7\n");
    // "1" = no Node, "1" = smallest. SPROUT_SKIP_EXE makes the heavy SEA exe fall back to the bundle.
    const r = spawnSync(process.execPath, [CLI, "build", join(dir, "w.sprout")], {
      encoding: "utf8", input: "1\n1\n", env: { ...process.env, SPROUT_FORCE_WIZARD: "1", SPROUT_SKIP_EXE: "1" },
    });
    assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? ""));
    assert.ok(existsSync(join(dir, "w.cjs")) || existsSync(join(dir, "w.exe")), "should produce a standalone bundle/exe");
    assert.ok(!existsSync(join(dir, "w.mjs")), "must NOT produce a needs-Node .mjs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("build wizard: 'needs Node' answer makes an .exe, not a .mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprout-wiz2-"));
  try {
    writeFileSync(join(dir, "w.sprout"), "show 6 * 7\n");
    // "2" = needs Node -> the tiny csc launcher .exe (fast). On non-Windows it falls back to .cjs.
    const r = spawnSync(process.execPath, [CLI, "build", join(dir, "w.sprout")], {
      encoding: "utf8", input: "2\n", env: { ...process.env, SPROUT_FORCE_WIZARD: "1" },
    });
    assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? ""));
    assert.ok(existsSync(join(dir, "w.exe")) || existsSync(join(dir, "w.cjs")), "needs-Node should produce an .exe (or .cjs fallback off Windows)");
    assert.ok(!existsSync(join(dir, "w.mjs")), "needs-Node must NOT produce a .mjs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bench: times both engines and reports a speedup", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprout-bench-"));
  try {
    writeFileSync(join(dir, "b.sprout"), "make t = 0\nrepeat 2000 times:\n    set t = t + 1\nshow t\n");
    const r = runCli(["bench", join(dir, "b.sprout"), "3"]); // 3 runs each = fast
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /interpreter/);
    assert.match(r.out, /compiled/);
    assert.match(r.out, /faster/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new: scaffolds a starter program that runs, and won't overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprout-new-"));
  try {
    const made = runCli(["new", "hello.sprout"], dir);
    assert.equal(made.code, 0, made.out);
    assert.ok(existsSync(join(dir, "hello.sprout")));
    const ran = runCli(["run", join(dir, "hello.sprout")]);
    assert.match(ran.out, /Hello, world!/);
    const again = runCli(["new", "hello.sprout"], dir);
    assert.notEqual(again.code, 0); // refuses to clobber
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// During a trace, dangerous commands become no-ops; in a normal run they run.
test("a trace silences dangerous commands, a normal run does not", () => {
  const traced = new Interpreter("type()\n", () => {}, { onStep: () => {} });
  let ranInTrace = false;
  traced.registerLibraryBuiltins({ type: () => { ranInTrace = true; return NONE; } });
  traced.run(parse(tokenize("type()\n")));
  assert.equal(ranInTrace, false, "type() must NOT run during a trace");

  const normal = new Interpreter("type()\n", () => {});
  let ranNormally = false;
  normal.registerLibraryBuiltins({ type: () => { ranNormally = true; return NONE; } });
  normal.run(parse(tokenize("type()\n")));
  assert.equal(ranNormally, true, "type() must run during a normal run");
});
