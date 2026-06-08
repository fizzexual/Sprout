# Benchmarks

The same three programs written in **Sprout, Python, JavaScript (Node), Go, and
Java**, so you can compare honestly. All five produce identical output.

| Program | What it stresses |
| --- | --- |
| `fib` | recursion — `fib(30)` (~2.7M calls) |
| `loop` | a tight loop — 5,000,000 iterations |
| `primes` | nested loops — count primes below 80,000 by trial division |

## Run it

```bash
bash benchmarks/bench.sh
```

It times each language best-of-3 (wall-clock) and prints a table. Go and Java
are compiled first (compile time excluded); Sprout, Python, and Node are run
as-is, so their numbers include parsing/startup — the real "run this script"
experience.

## Results (one machine: Windows, Node 25, best of 5, seconds)

| Benchmark | `sprout run` | **`sprout build`** (compiled) | Python 3.11 | Node 25 (JS) | Go | Java 21 |
| --- | --- | --- | --- | --- | --- | --- |
| Recursion — `fib(30)` | 0.89 | **0.15** | 0.25 | 0.09 | 0.03 | 0.10 |
| Tight loop — 5,000,000× | 0.77 | **0.16** | 0.62 | 0.10 | 0.03 | 0.10 |
| Primes — < 80,000 | 0.65 | **0.18** | 0.22 | 0.09 | 0.04 | 0.11 |

### Two engines, one language

- **`sprout run`** — a tuned tree-walking interpreter. Friendliest errors, no
  build step. In Python's ballpark (on par on a loop, a few times slower on
  recursion).
- **`sprout fast` / `sprout build`** — compiles the program to JavaScript and
  runs it on V8 (`sprout build x.sprout` → `node x.mjs`). **Beats CPython on
  every benchmark**, because it's running as real JS. It lands within ~2× of
  native Node, and well ahead of Python. Compile mode covers the core language;
  programs that `use` a library or open a GUI just run on the interpreter.

So Sprout is *both*: the kindest interpreter to learn with, and — when you want
it — faster than Python.

### A recent optimization pass

The engine was tuned (return-via-flag instead of exceptions, an inline call
cache, single-walk variable lookup):

| Benchmark | Before | After | Speed-up |
| --- | --- | --- | --- |
| `fib(30)` | 2.55 s | 0.88 s | **2.9×** |
| `loop` | 0.89 s | 0.75 s | 1.2× |
| `primes` | 0.79 s | 0.64 s | 1.25× |

Recursion-heavy code improved most, because `give` no longer throws an exception
on every return.
