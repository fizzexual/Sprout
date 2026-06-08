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

## Results (one machine: Windows, Node 25, best of 3, seconds)

| Benchmark | Sprout | Python 3.11 | Node 25 (JS) | Go | Java 21 |
| --- | --- | --- | --- | --- | --- |
| Recursion — `fib(30)` | 0.88 | 0.25 | 0.09 | 0.03 | 0.10 |
| Tight loop — 5,000,000× | 0.75 | 0.62 | 0.10 | 0.03 | 0.09 |
| Primes — < 80,000 | 0.64 | 0.22 | 0.09 | 0.04 | 0.11 |

**Startup floor** (a trivial "hello" program): Sprout 0.20 · Python 0.10 · Node
0.08 · Go 0.03 · Java 0.09. About 0.2 s of every Sprout run is fixed startup —
it re-parses its own interpreter each time, because there's no build step.

### Reading this honestly

Sprout is a from-scratch **tree-walking interpreter** — built for clarity, not
raw speed. It lands in the same ballpark as **Python** (roughly on par on a
simple loop, a few times slower on heavy recursion), and well behind
compiled/JIT languages (Go, Node, Java). That gap is the honest price of being a
tiny, zero-dependency, no-build language you can read end to end.

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
