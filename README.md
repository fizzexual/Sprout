# 🌱 Sprout

**A small, friendly programming language — built completely from scratch.**

Sprout is a real interpreted language with its own lexer, parser, and
tree-walking interpreter. No transpiling, no frameworks, **no dependencies** —
just source text turning into a running program.

Its one big idea: **be the kindest language to learn programming with.** Where
most languages throw cryptic errors, Sprout points at the exact spot and
explains the problem in plain English.

```
🌱 Oops — name problem on line 3:

  3 | say "Hi, " + nme
                   ^
  I don't know what 'nme' is.

  💡 Did you mean 'name'?
```

## A taste

```sprout
let name = "world"
say "Hello, " + name + "!"

# Count to 20 — FizzBuzz
let n = 1
while n <= 20:
    if n % 15 == 0:
        say "FizzBuzz"
    elif n % 3 == 0:
        say "Fizz"
    elif n % 5 == 0:
        say "Buzz"
    else:
        say n
    n = n + 1
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
[`examples/`](examples): `hello`, `fizzbuzz`, `triangle`, `math`, and `primes`.

> Don't want to install anything? You can always run it directly:
> `node src/cli.ts run examples/hello.sprout`

## Tests

Sprout has a test suite that runs real programs and checks their output, using
Node's built-in test runner — still **no dependencies**:

```bash
npm test          # or: node --test test/sprout.test.ts
```

## The language so far (v0.1)

| Feature | Example |
| --- | --- |
| Variables | `let score = 0` then `score = score + 1` |
| Printing | `say "hi", name, 1 + 2` |
| Math | `+ - * / %` and parentheses |
| Text | `"a" + "b"`, joins with anything |
| Comparisons | `== != < <= > >=` |
| Logic | `and`, `or`, `not` |
| Conditions | `if` / `elif` / `else` |
| Loops | `while cond:` and `repeat N times:` |
| Built-in functions | `sqrt(16)`, `max(3, 9)`, `length("hi")`, `upper(s)` |
| Comments | `# like this` |
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

- [x] **v0.1** — variables, math, text, `if`/`while`/`repeat`, built-ins, tests, kind errors
- [ ] **v0.2** — functions (`function greet(name):`) and `return`
- [ ] **v0.3** — lists & a `for each` loop
- [ ] **v0.4** — `ask` for input + a small standard library
- [ ] **v0.5** — a browser playground (try Sprout with one click)
- [ ] **v0.6** — an editor extension (syntax highlighting + inline errors)

---

Made from scratch, one slice at a time. 🌱
