// Sprout's test suite, using Node's built-in test runner (zero dependencies).
// Run with:  node --test test/sprout.test.ts   (or: npm test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenize } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { Interpreter } from "../src/interpreter.ts";
import { LangError } from "../src/errors.ts";

// Run a snippet and capture everything `say` prints.
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

test("variables and math precedence", () => {
  assert.deepEqual(run("let a = 2\nlet b = 3\nsay a + b * 2"), ["8"]);
});

test("parentheses override precedence", () => {
  assert.deepEqual(run("say (2 + 3) * 2"), ["10"]);
});

test("text joins with anything via +", () => {
  assert.deepEqual(run('say "n=" + 5'), ["n=5"]);
});

test("say prints several values space-separated", () => {
  assert.deepEqual(run('say "a", 1, true'), ["a 1 true"]);
});

test("if / elif / else picks the right branch", () => {
  const src = 'let x = 5\nif x > 9:\n    say "big"\nelif x > 3:\n    say "mid"\nelse:\n    say "small"';
  assert.deepEqual(run(src), ["mid"]);
});

test("while loop counts", () => {
  assert.deepEqual(run("let i = 0\nwhile i < 3:\n    say i\n    i = i + 1"), ["0", "1", "2"]);
});

test("repeat N times", () => {
  assert.deepEqual(run('repeat 3 times:\n    say "hi"'), ["hi", "hi", "hi"]);
});

test("fizzbuzz to 5", () => {
  const src =
    'let n = 1\nwhile n <= 5:\n' +
    "    if n % 15 == 0:\n        say \"FizzBuzz\"\n" +
    "    elif n % 3 == 0:\n        say \"Fizz\"\n" +
    "    elif n % 5 == 0:\n        say \"Buzz\"\n" +
    "    else:\n        say n\n" +
    "    n = n + 1";
  assert.deepEqual(run(src), ["1", "2", "Fizz", "4", "Buzz"]);
});

test("logic and comparisons", () => {
  assert.deepEqual(run("say 1 < 2 and 3 >= 3"), ["true"]);
  assert.deepEqual(run("say not false"), ["true"]);
  assert.deepEqual(run('say "a" == "a"'), ["true"]);
  assert.deepEqual(run('say 1 == "1"'), ["false"]);
});

test("built-in functions", () => {
  assert.deepEqual(run("say sqrt(16)"), ["4"]);
  assert.deepEqual(run("say max(3, 9, 5)"), ["9"]);
  assert.deepEqual(run("say min(3, 9, 5)"), ["3"]);
  assert.deepEqual(run("say abs(-7)"), ["7"]);
  assert.deepEqual(run("say round(3.7)"), ["4"]);
  assert.deepEqual(run('say length("hello")'), ["5"]);
  assert.deepEqual(run('say upper("hi")'), ["HI"]);
  assert.deepEqual(run('say lower("HI")'), ["hi"]);
});

test("error: unknown name suggests the closest one", () => {
  const e = runErr('let name = "x"\nsay nme');
  assert.equal(e.kind, "Name");
  assert.match(e.hint ?? "", /name/);
});

test("error: divide by zero", () => {
  const e = runErr("say 1 / 0");
  assert.equal(e.kind, "Runtime");
});

test("error: missing colon is a syntax error", () => {
  const e = runErr('if 1 < 2\n    say "x"');
  assert.equal(e.kind, "Syntax");
});

test("error: stray indentation", () => {
  const e = runErr('say "a"\n    say "b"');
  assert.equal(e.kind, "Indentation");
});

test("error: unterminated string points at the start", () => {
  const e = runErr('say "hello');
  assert.equal(e.kind, "Syntax");
  assert.equal(e.line, 1);
});

test("error: wrong argument type to a builtin", () => {
  const e = runErr('say sqrt("nope")');
  assert.equal(e.kind, "Type");
});

test("error: unknown function suggests a builtin", () => {
  const e = runErr("say sqrtt(9)");
  assert.equal(e.kind, "Name");
  assert.match(e.hint ?? "", /sqrt/);
});
