# 🌱 Sprout

**A small, friendly programming language — built completely from scratch.**

Sprout is a real interpreted language with its own lexer, parser, and
tree-walking interpreter. No transpiling, no frameworks, **no dependencies** —
just source text turning into a running program.

Its one big idea: **be the kindest language to learn programming with.** Where
most languages throw cryptic errors, Sprout points at the exact spot and
explains the problem in plain English.

```
🌱 Oops — name problem on line 2:

  2 | show "Hi, " + nme
    |               ^

  I don't know what 'nme' is.

  💡 Did you mean 'name'?
```

## A taste

Sprout has its **own** vocabulary — it doesn't borrow `let`, `print`, or `if`
from anyone:

```sprout
make name = "world"
show "Hello, " + name + "!"

~ Count to 20 — FizzBuzz
make n = 1
repeat while n <= 20:
    when n % 15 == 0:
        show "FizzBuzz"
    orwhen n % 3 == 0:
        show "Fizz"
    orwhen n % 5 == 0:
        show "Buzz"
    otherwise:
        show n
    set n = n + 1
```

## Install the `sprout` command

Sprout needs **Node 23.6+** (it runs the TypeScript source directly — no build
step). Link the `sprout` command so you can use it anywhere, just like `python`:

```bash
git clone https://github.com/fizzexual/Sprout-.git
cd Sprout-
npm link          # creates the global `sprout` command
```

Then:

```bash
sprout version
sprout examples/hello.sprout        # run a program (Python-style)
sprout run examples/primes.sprout   # the same, but explicit
sprout repl                         # interactive prompt
```

Sprout programs use the **`.sprout`** extension. There are more to try in
[`examples/`](examples): `hello`, `fizzbuzz`, `triangle`, `math`, `primes`, and
`functions`.

> Don't want to install anything? You can always run it directly:
> `node src/cli.ts run examples/hello.sprout`

### Double-click to run (Windows)

Make `.sprout` files runnable straight from Explorer — double-click one and it
runs, showing its output in a window:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1
```

This is per-user only (no admin needed) and reversible:

```powershell
powershell -ExecutionPolicy Bypass -File tools\uninstall-file-association.ps1
```

## Playground (a GUI in your browser)

Sprout comes with a little playground — a code editor with a **Run** button and
live output, served by a zero-dependency Node server:

```bash
npm run play      # then open http://localhost:3000
```

Type a program, hit **Run** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>), and see the
output instantly. There's a dropdown of examples to start from, and runaway
loops are stopped automatically.

## Tests

Sprout has a test suite that runs real programs and checks their output, using
Node's built-in test runner — still **no dependencies**:

```bash
npm test          # or: node --test test/sprout.test.ts
```

## The language so far (v0.2)

| Feature | Sprout |
| --- | --- |
| Create a variable | `make score = 0` |
| Change a variable | `set score = score + 1` |
| Print | `show "hi", name, 1 + 2` |
| Math | `+ - * / %` and parentheses |
| Text | `"a" + "b"`, joins with anything |
| Comparisons | `== != < <= > >=` |
| Logic | `and`, `or`, `not` |
| Conditions | `when` / `orwhen` / `otherwise` |
| Loops | `repeat while cond:` and `repeat N times:` |
| Tasks (functions) | `task greet(name):` … `give value` (with recursion) |
| Booleans | `yes` / `no` |
| Built-in functions | `sqrt(16)`, `max(3, 9)`, `length("hi")`, `upper(s)` |
| Comments | `~ like this` |
| Kind errors | points at the spot, suggests fixes |

**Built-ins so far:** `abs` · `round` · `floor` · `ceil` · `sqrt` · `min` · `max` · `length` · `upper` · `lower` · `random`

## How it works

```
source text
   │  lexer.ts        →  tokens (words & symbols, with indentation)
   ▼
 tokens
   │  parser.ts       →  a syntax tree (AST)
   ▼
syntax tree
   │  interpreter.ts  →  walks the tree and runs it
   ▼
output
```

| File | Job |
| --- | --- |
| `src/lexer.ts` | Turn text into tokens (handles indentation → INDENT/DEDENT) |
| `src/parser.ts` | Recursive-descent parser → AST |
| `src/interpreter.ts` | Tree-walking evaluator |
| `src/errors.ts` | The friendly error type + pretty-printer |
| `src/cli.ts` | The `sprout` command (run a file, or REPL) |

## Roadmap

- [x] **v0.1** — original syntax (`make`/`set`/`show`/`when`/`repeat`), math, text, built-ins, tests, kind errors
- [x] **v0.2** — functions: `task greet(name):` and `give` (return), plus recursion
- [x] **GUI** — a browser playground (`npm run play`)
- [ ] **v0.3** — lists & a `for each` loop
- [ ] **v0.4** — `ask` for input + a bigger standard library
- [ ] **v0.5** — host the playground online (try Sprout with one click)
- [ ] **v0.6** — an editor extension (syntax highlighting + inline errors)

---

Made from scratch, one slice at a time. 🌱
