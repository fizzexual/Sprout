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
import { sealAudio, hchacha20, chooseMode, OggOpusDemuxer } from "../libraries/discord-bot/voice.ts";
import { isUrl, formatQueue, create as musicExt } from "../extensions/discord-bot/music/index.ts";
import { createDecipheriv } from "node:crypto";

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
