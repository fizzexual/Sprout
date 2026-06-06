// Sprout's test suite, using Node's built-in test runner (zero dependencies).
// Run with:  node --test test/sprout.test.ts   (or: npm test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenize } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { Interpreter } from "../src/interpreter.ts";
import { LangError } from "../src/errors.ts";

// Run a snippet and capture everything `show` prints.
function run(src: string): string[] {
  const out: string[] = [];
  const interp = new Interpreter(src, (line) => out.push(line));
  interp.run(parse(tokenize(src)));
  return out;
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
