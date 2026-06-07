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
