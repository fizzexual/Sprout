# Testing & learn mode

Two teaching features built into the language, in plain words. **Built-in testing**
lets you write `test "name":` blocks with `expect` checks and run them with
`sprout test`. **Learn mode** (`learn on`) narrates each step of your program as it
runs — the values, which `when` branch fired, every loop turn, and each task call.
They are completely separate: one *checks* your code, the other *explains* it.

> Every complete program below was run with the real interpreter, and the second
> code block is its **actual** output (with the terminal's colours stripped — on a
> real terminal `ok` is green and a failing `x` is red). Try them yourself:
>
> ```
> sprout run yourfile.sprout
> sprout test yourfile.sprout
> ```

## On this page

- [Part 1 — Built-in testing](#part-1--built-in-testing)
  - [`test "name":` and `expect`](#test-name-and-expect)
  - [Running tests: `sprout test`](#running-tests-sprout-test)
  - [`sprout test` with no arguments — the `tests/` folder](#sprout-test-with-no-arguments--the-tests-folder)
  - [The summary line and the exit code](#the-summary-line-and-the-exit-code)
  - [When a test fails](#when-a-test-fails)
  - [`expect error` — asserting that a block *should* fail](#expect-error--asserting-that-a-block-should-fail)
  - [`expect error "kind"` — checking *which* error](#expect-error-kind--checking-which-error)
  - [A typo inside a test stops just that test](#a-typo-inside-a-test-stops-just-that-test)
  - [Testing gotchas](#testing-gotchas)
- [Part 2 — Learn mode](#part-2--learn-mode)
  - [`learn on` / `learn off`](#learn-on--learn-off)
  - [What it narrates: make / set / show](#what-it-narrates-make--set--show)
  - [Narrating control flow: `when`, loops, and task calls](#narrating-control-flow-when-loops-and-task-calls)
  - [`for each key, value`](#for-each-key-value)
  - [Learn-mode rules and gotchas](#learn-mode-rules-and-gotchas)
- [The two features side by side](#the-two-features-side-by-side)
- [See also](#see-also)

---

# Part 1 — Built-in testing

Testing isn't a separate library you install — it's two keywords, `test` and
`expect`, baked into Sprout. You write checks in the same plain English as the rest
of the language, and one command runs them all.

## `test "name":` and `expect`

A `test` block has a name (text, in quotes) and a body. Inside it, every
`expect <condition>` checks that the condition is **true**. If every `expect` in the
block holds, the test passes; if any one is false, the test fails.

```sprout
test "math works":
    expect 2 + 2 == 4
    expect 10 / 2 == 5

test "text and lists":
    expect upper("hi") == "HI"
    expect length([1, 2, 3]) == 3
    expect "hello"[0] == "h"

task double(n):
    give n * 2

test "my own task":
    expect double(21) == 42
```

`expect` takes any expression that evaluates to a yes/no value — usually a
comparison (`==`, `!=`, `<`, `<=`, `>`, `>=`), but `and`, `or`, `not`, `in`, and a
call that returns `yes`/`no` all work too. A `test` can call your own [tasks](tasks-and-lambdas.md),
make local variables, loop — anything a normal block can do. (Tasks defined anywhere
in the file are visible to every test, so define them once and check them many ways.)

## Running tests: `sprout test`

Point `sprout test` at a file to run just that file's tests:

```
sprout test example_test.sprout
```

Running the file above (it lives at `src/tests/example_test.sprout` in the repo):

```
  src/tests/example_test.sprout
  ok  math works
  ok  text and lists
  ok  my own task

  3 passed
```

Each `test` block prints one line: `ok` followed by its name when it passes. The
file path is printed once as a dim header, and a bold summary follows at the end.

## `sprout test` with no arguments — the `tests/` folder

Run `sprout test` **with no file** and Sprout looks for a `tests/` folder in the
current directory and runs **every** `*.sprout` file inside it. This is the normal
way to run a project's whole suite. Given a `tests/` folder with two files:

```
tests/
├─ math_test.sprout
└─ text_test.sprout
```

```sprout
~ tests/math_test.sprout
test "addition":
    expect 2 + 2 == 4
    expect 10 - 3 == 7

test "lists":
    expect length([1, 2, 3]) == 3
    expect first([10, 20]) == 10
```

```sprout
~ tests/text_test.sprout
test "upper and lower":
    expect upper("hi") == "HI"
    expect lower("BYE") == "bye"
```

Running `sprout test` from the folder that contains `tests/`:

```
  tests/math_test.sprout
  ok  addition
  ok  lists

  tests/text_test.sprout
  ok  upper and lower

  3 passed
```

Notice the count is **3 passed** — that's three `test` blocks across two files. The
files run in their own scopes, so a variable or task in one test file can't leak into
another.

If there's no `tests/` folder (and you gave no file), Sprout tells you where to put
them and exits with a failure code:

```
  No tests found. Put them in a tests/ folder, or run one:  sprout test mytests.sprout
```

> By convention the names end in `_test.sprout` (like `math_test.sprout`), but
> `sprout test` runs **every** `*.sprout` file in `tests/` regardless of name.

## The summary line and the exit code

After the last test, Sprout prints a one-line summary and **sets its exit code** so a
CI script or build pipeline can tell pass from fail:

| Result | Summary line | Exit code |
| --- | --- | --- |
| All tests passed | `N passed` | **0** |
| Some failed | `N passed, M failed` | **1** |
| No tests found (no file, no `tests/`) | `No tests found…` | **1** |

That exit code is the whole point of testing in a pipeline: `sprout test` in your CI
fails the build the moment a check goes red. (The project's own continuous
integration runs the suite in `src/tests/` on Linux, macOS, and Windows exactly this
way.)

## When a test fails

A failing `expect` prints a red `x`, the test's name, and the condition it expected
to be true. If the expression contains variables or calls, it also prints the same
expression **with the values filled in**, so you can see what it actually was:

```sprout
task triple(n):
    give n * 3

test "triple is correct":
    make x = 5
    expect triple(x) == 16
```

```
  x  triple is correct
        expected this to be true:  triple(x) == 16
        but it was:                triple(5) == 16

  0 passed, 1 failed
```

The `but it was:` line substitutes the real values (`x` became `5`), which usually
makes the bug obvious. If the expression has no variables to substitute (like
`2 + 2 == 5`), the `but it was:` line is omitted because it would just repeat itself:

```sprout
test "this one passes":
    expect 1 + 1 == 2

test "this one fails":
    expect 2 + 2 == 5
```

```
  ok  this one passes
  x  this one fails
        expected this to be true:  2 + 2 == 5

  1 passed, 1 failed
```

A failed `expect` **stops the rest of that test block** (so you don't get a cascade of
follow-on failures from one broken step) but moves straight on to the next `test` —
one red check never aborts the whole run.

## `expect error` — asserting that a block *should* fail

Sometimes the correct behaviour *is* an error — bad input should be rejected, a
divide-by-zero should blow up. `expect error:` flips the assertion: the indented
block under it is expected to **fail**. If it fails, the test passes; if it runs
cleanly, *that's* the failure.

```sprout
test "any error at all":
    expect error:
        make xs = [1, 2]
        show xs[99]
```

```
  ok  any error at all
```

`expect error` catches **soft** errors — the catchable runtime conditions (bad input,
divide-by-zero, a missing file, an out-of-range index, your own `fail`). These are
the same errors a `try` / `caught` block catches; see [errors](errors.md) for the
full story.

## `expect error "kind"` — checking *which* error

Add a kind in quotes to assert not just *that* it failed but *how*. The
[error kind](errors.md#the-full-error-kind-table) is one of a fixed, stable set:
`error`, `name`, `type`, `math`, `index`, `io`, `fail`.

```sprout
test "expect error checks the kind":
    expect error "math":
        show 5 / 0
    expect error "index":
        make xs = [1, 2]
        show xs[99]
    expect error "fail":
        fail "nope"

test "expect error works with a fail-map's custom kind":
    expect error "http":
        fail {kind: "http", status: 404, message: "Not found"}
```

```
  ok  expect error checks the kind
  ok  expect error works with a fail-map's custom kind
```

Because a `fail` can carry a map with its own `kind`, `expect error "http"` matches a
custom kind too — handy for testing a library that raises its own error types.

If the block *does* fail but with the **wrong** kind, the test reports the mismatch:

```sprout
test "wrong kind reported":
    expect error "index":
        show 5 / 0
```

```
  x  wrong kind reported
        expected an error of kind "index", but got kind "math"

  0 passed, 1 failed
```

And if the block doesn't fail at all when you said it should:

```
  x  some test
        expected an error here, but the steps succeeded
```

## A typo inside a test stops just that test

Sprout splits errors into two tiers (see [hard vs soft](errors.md#hard-vs-soft-errors-typos-are-uncatchable-on-purpose)).
**Soft** errors are catchable; **hard** errors — an unknown variable, task, or module
(the "did you mean?" mistakes) and parse errors — deliberately are *not*. A `try`
can't swallow a typo, and neither can `expect error`.

But a `test` block is a **system boundary**: it catches *everything*, soft and hard
alike, so one typo fails just that test and the suite keeps going. The typo's full
diagnostic still surfaces so you can fix it:

```sprout
test "a typo stops just this test":
    show notdefined

test "the next test still runs":
    expect 1 + 1 == 2
```

```
  Sprout error in typo_test.sprout (line 2): I don't know what 'notdefined' is.

  Variables are made with 'make', like:
      make notdefined = "Sam"


  typo_test.sprout
  x  a typo stops just this test (stopped by an error)
  ok  the next test still runs

  1 passed, 1 failed
```

The broken test is marked `(stopped by an error)` and counts as a failure (so the
exit code is still 1), but `the next test still runs` proves the suite didn't abort.

> This is why `expect error` is for *soft* errors only. To assert that a typo is a
> typo you don't write a test — the language refuses to run the code, which is the
> check.

## Testing gotchas

- **`expect` wants a yes/no.** `expect 5` isn't meaningful — write a comparison like
  `expect count > 0`. (Sprout treats most values as truthy, but a comparison says
  what you mean.)
- **One file, one scope per file.** Tasks and variables made at the top level of a
  test file are shared by every `test` in that file, but not across files.
- **`sprout test` needs the `tests/` folder in the *current* directory.** Run it from
  your project root (where `tests/` lives), or pass a file path explicitly.
- **A failed `expect` skips the rest of its block.** Put independent checks in
  separate `test` blocks if you want to see all their results at once.

---

# Part 2 — Learn mode

Learn mode is Sprout's teaching narrator. Flip it on and the interpreter explains
*itself* — printing each step's values as it runs, so a beginner can watch the
program think. It changes **nothing** about what your program computes; it only adds
narration alongside the real output.

## `learn on` / `learn off`

`learn` is a keyword; `learn on` and `learn off` are statements that flip a single
**global** narration flag. While it's on, Sprout narrates each step; `learn off`
stops the narration. Off by default.

```sprout
learn on
make a = 2
make b = 3
show a + b
set a = 10
show a
learn off
show "ok: learn mode ran"
```

```
  Created variable a = 2

  Created variable b = 3

  Evaluating:
      a + b

      2 + 3 = 5

  Output:
      5

  Updated a to 10

  Evaluating:
      a

  Output:
      10

ok: learn mode ran
```

Notice the last line, `ok: learn mode ran`, has **no** narration around it — that's
because `learn off` was hit first. The narration lines are indented and dim; the
program's real `show` output (`5`, `10`, and the final line) is the plain text.

## What it narrates: make / set / show

The basic value-level narration:

- **`make name = value`** prints `Created variable name = value`.
- **`set name = value`** prints `Updated name to value`.
- **`show expr`** prints `Evaluating:` with the source expression, then — for a math,
  comparison, or logic expression — the same expression with the values substituted
  and its result (e.g. `2 + 3 = 5`), then `Output:` with the final value.

So learn mode answers the beginner's constant question, *"what is this variable right
now, and how did that line get its answer?"* — without reaching for a debugger.

## Narrating control flow: `when`, loops, and task calls

Learn mode also explains the *flow*: which `when` branch ran, every loop turn, and
each task call plus what it gave back.

```sprout
task double(n):
    give n * 2

learn on
make score = 7

when score > 5:
    show "high"
otherwise:
    show "low"

repeat 2 times:
    show double(score)

for each item in ["a", "b"]:
    show item
learn off
```

```
  Created variable score = 7

  Checking 7 > 5 -> yes; running this branch

  Evaluating:
      "high"

  Output:
      high

  Repeat turn 1 of 2

  Evaluating:
      double(score)

  Calling double(7)

  double gave back 14

  Output:
      14

  Repeat turn 2 of 2

  Evaluating:
      double(score)

  Calling double(7)

  double gave back 14

  Output:
      14

  Loop turn: item = a

  Evaluating:
      item

  Output:
      a

  Loop turn: item = b

  Evaluating:
      item

  Output:
      b
```

Every control-flow construct gets a line:

- **`when` / `orwhen` / `otherwise`** — `Checking 7 > 5 -> yes; running this branch`.
  When no branch matches, you'll see `Checking when -> no branch was true; doing
  nothing` (or `; running otherwise` if there's an `otherwise`).
- **`repeat N times`** — `Repeat turn 1 of 2`, `Repeat turn 2 of 2`, …
- **`while`** — `While-loop turn 1 (the test was true)`, and so on each turn.
- **`for each`** — `Loop turn: item = a` with the loop variable's current value.
- **Task calls** — `Calling double(7)` on the way in, and `double gave back 14` on
  the way out, with the real argument and return values.

## `for each key, value`

When you loop over a map (or use the two-variable form), learn mode shows **both**
loop variables each turn:

```sprout
learn on
make scores = {alice: 1, bob: 2}
for each name, points in scores:
    show name
learn off
```

```
  Created variable scores = {alice: 1, bob: 2}

  Loop turn: name = alice, points = 1

  Evaluating:
      name

  Output:
      alice

  Loop turn: name = bob, points = 2

  Evaluating:
      name

  Output:
      bob
```

Each `Loop turn:` line binds both names, so you can watch `name` and `points` move
together through the map.

## Learn-mode rules and gotchas

- **It's a single global flag — it does *not* nest or scope.** The most recent
  `learn on` / `learn off` wins, and the setting **persists across files** in a
  multi-file run. Turn it off when you're done watching.
- **`learn on` / `learn off` are the only forms.** `learn` always needs `on` or
  `off` after it.
- **Narration is extra output, not a change in behaviour.** Your program computes the
  exact same results with learn mode on or off — only the surrounding explanation
  appears (and disappears) with the flag.
- **It pairs with friendly errors.** If a line goes wrong while learn mode is on,
  you still get Sprout's normal "did you mean…?" diagnostic — the narration just
  helps you see how far the program got first.
- **Great in the [REPL](cli-and-flags.md).** Type `learn on` once and every line you
  enter afterward is narrated until you type `learn off`.

---

## The two features side by side

| | **Testing** | **Learn mode** |
| --- | --- | --- |
| Keywords | `test`, `expect` (`expect error`) | `learn on`, `learn off` |
| Purpose | *Check* that code is correct | *Explain* what code is doing |
| How you run it | `sprout test [file]` | `learn on` inside any program / the REPL |
| Output | `ok` / `x` per test + a pass/fail summary | step-by-step narration of values & flow |
| Affects exit code? | **Yes** — 0 if all pass, 1 if any fail | No |
| Changes the result? | No | No |

They're independent and can even be combined — turn `learn on` inside a `test` block
and you'll watch the narration *and* get the pass/fail verdict.

## See also

- [Errors: try / caught / fail](errors.md) — the soft/hard tiers and the full error
  `kind` table that `expect error "kind"` checks against.
- [Tasks & lambdas](tasks-and-lambdas.md) — defining the `task`s your tests exercise.
- [CLI & flags](cli-and-flags.md) — every `sprout` subcommand, including `test`, and
  the `--sandbox` / `SPROUT_GC_STRESS` flags.
- [Projects & modules](modules-and-projects.md) — laying out a project with a
  `tests/` folder and `sprout build`.
- [Cheat sheet](cheatsheet.md) — the whole language on one page.
- [Built-ins reference](builtins-reference.md) — the `upper`, `length`, `first`, …
  used in the examples above.
