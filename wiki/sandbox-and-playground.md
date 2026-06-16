# Sandbox & the online playground

Run **untrusted** Sprout — a stranger's code, on **your** machine — without handing
them your filesystem, your shell, or your network. This page covers the `--sandbox`
flag (the language-level lock) and the Docker playground that wraps it for hosting.

## On this page

- [Why a sandbox](#why-a-sandbox)
- [Turning it on: `--sandbox` and `SPROUT_SANDBOX=1`](#turning-it-on---sandbox-and-sprout_sandbox1)
- [Exactly what gets turned off](#exactly-what-gets-turned-off)
- [What still works](#what-still-works)
- [Blocks are catchable errors](#blocks-are-catchable-errors)
- [A real blocked-op run](#a-real-blocked-op-run)
- [The probe: proving every door is shut](#the-probe-proving-every-door-is-shut)
- [Necessary but **not** sufficient](#necessary-but-not-sufficient)
- [The Docker playground](#the-docker-playground)
- [One container per submission](#one-container-per-submission)
- [Gotchas](#gotchas)
- [See also](#see-also)

---

## Why a sandbox

Sprout normally has real reach: it can read and write files, fetch URLs, save data to
disk, and (with `use system`) run shell commands. That's wonderful when **you** wrote the
program. It's a problem the moment you let a **stranger** run code on your server — say, an
online playground or a "try it in the browser" box. A one-line program like
`show read("/etc/passwd")` or `system.run("rm -rf ...")` would do exactly what it says.

The `--sandbox` flag closes every one of those outward doors while leaving the whole
*computational* language — math, text, lists, maps, tasks, `match`, the pipe — completely
intact. Untrusted code can still compute anything; it just can't touch the outside world.

## Turning it on: `--sandbox` and `SPROUT_SANDBOX=1`

There are two equivalent ways to switch it on. Both do the same thing.

**1. The flag** — pass `--sandbox` anywhere on the command line:

```sh
sprout --sandbox run untrusted.sprout
sprout run untrusted.sprout --sandbox     # position doesn't matter
```

**2. The environment variable** — set `SPROUT_SANDBOX` to anything:

```sh
SPROUT_SANDBOX=1 sprout run untrusted.sprout
```

The env var is the right choice for a server: bake it into the container's environment and
the sandbox holds even if something bypasses the entrypoint and calls `sprout` directly.
The Docker playground does exactly this (`ENV SPROUT_SANDBOX=1` in the image).

> The flag is **sticky to the whole process**, not to one call — once it's on, it's on for
> the entire run. There is no way for a program to turn it back off from the inside.

## Exactly what gets turned off

The sandbox blocks **11 outward operations**: nine builtins, one whole module, and one
statement. Everything in this list is *off*; nothing else changes.

| What | Operation(s) | Reach it removes |
| --- | --- | --- |
| **Filesystem** | [`read`](builtins-reference.md), `write`, `append`, `exists` | reading, writing, appending, and probing files on disk |
| **On-disk store** | `remember`, `recall`, `forget` | the per-folder key/value store (`sprout.data.json`) |
| **Network** | `get`, `explore` | fetching URLs / APIs — and the SSRF that comes with it |
| **The shell** | the whole **`system`** module (`system.run`) | running OS commands |
| **Loading files** | the **`use <module>`** statement | pulling another `.sprout` file off disk into the program |

That `use <module>` is blocked matters: `use` is a *statement*, not a builtin call, so it
would otherwise sneak past a builtin-only filter. Loading a file from disk is a filesystem
read, so the sandbox shuts it too. (Note: `use system` is blocked by the module rule above;
`use someFile` is blocked by this statement rule.)

Each of the 11 is hard-wired in the interpreter; there's no allow-list to misconfigure.

## What still works

Everything that only computes. None of these are touched by the sandbox:

- **Numbers & math** — `+ - * / %`, `abs`, `sqrt`, `pow`, `floor`, `ceil`, `round`,
  `min`, `max`, `random`, `number`, …
- **Text** — `upper`, `lower`, `trim`, `replace`, `split`, `join`, `words`, `lines`,
  `title`, `starts_with`, `ends_with`, f-strings, string indexing `s[i]`
- **Lists & maps** — `[..]`, `{..}`, `length`, `add`, `sort`, `sort_by`, `filter`, `map`,
  `reduce`, `keys`, `values`, `slice`, `unique`, `zip`, `flatten`, `copy`, …
- **Language features** — `when`/`orwhen`/`otherwise`, loops, [tasks & lambdas](syntax-basics.md),
  closures, ranges `a to b`, [list comprehensions](syntax-basics.md), `match`/`is`,
  the pipe `|>`, `or else`
- **Output & timing** — `show`, `color`, `now`, `today`, `wait`, `seed`
- **The garbage collector** keeps memory *bounded* the whole time (it's invisible)

Here is a program that exercises a good slice of the safe surface — run **under the
sandbox** — to prove the language itself is undiminished:

```sprout
~ All of this still works under the sandbox: math, text, lists, maps,
~ ranges, comprehensions, tasks, pipe, pattern matching.
make nums = 1 to 10
make evens = [n for each n in nums when n % 2 == 0]
show "evens:", evens
show "sum of squares:", nums |> map(task(n): n * n) |> sum
show "upper:", upper("hello from the sandbox")

task classify(n):
    match n:
        is 0:
            give "zero"
        otherwise:
            give "nonzero"
show classify(0), classify(7)
```

Run with `SPROUT_SANDBOX=1 sprout run safe.sprout`:

```
evens: [2, 4, 6, 8, 10]
sum of squares: 385
upper: HELLO FROM THE SANDBOX
zero nonzero
```

## Blocks are catchable errors

A blocked operation isn't a crash — it's a normal Sprout error, which means you can wrap it
in `try` / `caught` and keep going. The caught value is the usual error **map** with
`message`, `kind`, and `line` (read its fields with `["..."]`):

```sprout
try:
    make data = read("private.txt")
caught e:
    show "message:", e["message"]
    show "kind:", e["kind"]
    show "line:", e["line"]
show "the program keeps running"
```

Run with `SPROUT_SANDBOX=1 sprout run catch.sprout`:

```
message: 'read' is turned off in sandbox mode — file, shell, and network access are disabled here.
kind: error
line: 2
the program keeps running
```

A few things to notice:

- The error's **`kind` is `error`** (the generic kind), not `io`. It's a "this door is
  shut" error, not a "the disk failed" error.
- The program **continues** after the `caught` block — exactly like any other catch.
- Read the fields with `e["message"]`, **not** `e.message`. The single `.` is *module
  member access*; on a plain map it sends you down the wrong path (`e.message` makes
  Sprout ask you to `use e`). For maps, always index with `["..."]`. See
  [error handling](syntax-basics.md) for the full error model.

## A real blocked-op run

Without `try`, a blocked call stops the program with a clear message and a non-zero exit
code. Given `blocked.sprout`:

```sprout
show read("secrets.txt")
```

Run it **with** the sandbox and you get nothing back but the block:

```sh
sprout --sandbox run blocked.sprout
```

```
  Sprout error in blocked.sprout (line 1): 'read' is turned off in sandbox mode — file, shell, and network access are disabled here.
```

The exit code is `1`. Run the *same file without* `--sandbox` and `read` works normally —
the sandbox is the only difference.

The shell module and `use` give their own tailored messages. Given `sys.sprout`:

```sprout
use system
show system.run("echo hi")
```

```sh
sprout --sandbox run sys.sprout
```

```
  Sprout error in sys.sprout (line 2): the 'system' module is turned off in sandbox mode — no shell access here.
```

And given `helper.sprout` that just tries to load another file:

```sprout
use helper
```

```sh
sprout --sandbox run helper.sprout
```

```
  Sprout error in helper.sprout (line 1): 'use' is turned off in sandbox mode — a program can't load other files.
```

## The probe: proving every door is shut

The repo ships a self-checking program, `src/tests/sandbox/probe.sprout`, that *tries* all
11 dangerous operations inside `try`/`caught` and counts how many were blocked. It lives in
`tests/sandbox/` (not `tests/`) so the normal suite skips it — it only makes sense with the
sandbox on. Here is the shape of it:

```sprout
use system
make blocked = 0
make total = 11

try:
    read("x")
caught e:
    set blocked += 1
~ ... write, append, exists, remember, recall, forget,
~     get, explore, system.run, and `use somefile` ...

when blocked == total:
    show "ok: all " + total + " dangerous ops blocked"
otherwise:
    show "FAIL: only " + blocked + " of " + total + " blocked"
```

Run it under the sandbox:

```sh
SPROUT_SANDBOX=1 sprout run src/tests/sandbox/probe.sprout
```

```
ok: all 11 dangerous ops blocked
```

CI runs this probe on every job, so a regression that re-opens any door fails the build.

## Necessary but **not** sufficient

This is the most important caveat on the page. **`--sandbox` closes the *language's* outward
APIs — and nothing more.** It does not, and cannot, stop a program from:

- **looping forever** (`while yes:` ...),
- **burning CPU**, or
- **allocating a lot** of memory, or
- **flooding output** with `show`.

The garbage collector keeps a run's memory *bounded per program* — but bounded is not the
same as *small*. So a hosting server must **still** cap, at the OS / container level:

- **CPU time** — a wall-clock and/or CPU timeout (kill the process after N seconds),
- **memory** — a hard ceiling (`ulimit -v`, `--memory`),
- **output** — a byte cap on what you stream back,
- and ideally **process count** and an **unprivileged user**.

Run each submission as a **short-lived, unprivileged, resource-limited** process. The
sandbox flag is one layer; the OS limits are the other. Neither replaces the other. The
Docker playground below wires all of these together for you.

## The Docker playground

The playground is the operational layer on top of `--sandbox`: a minimal, non-root image
plus a resource-limited runner. The fastest way to stand one up is the bundled web editor.

Copy [`docker-compose.yml`](../docker-compose.yml) into **any empty folder** and run:

```sh
docker compose up --build
# then open http://localhost:8080
```

That's the whole setup — you don't even need to clone the repo. The compose file is
**self-contained**: it downloads the Sprout source from GitHub and builds the image itself
(via a `dockerfile_inline:` block), so the one YAML file is all you need. A sandboxed editor
with a **Run** button comes up at `http://localhost:8080`. A tiny dependency-free Python
server accepts code on `POST /run` and hands each submission to the same hardened runner.

Under the hood the compose file applies **defence in depth** — no single layer is trusted:

| Layer | What it stops |
| --- | --- |
| `SPROUT_SANDBOX=1` (baked into the image) | the *language's* doors: file, store, network, `system`, `use` |
| `--network none` / no egress | SSRF to internal services or the cloud metadata endpoint |
| `mem_limit` / `memswap_limit` | RAM exhaustion (the GC bounds a run, doesn't make it small) |
| CPU cap + wall-clock + CPU-time timeouts | infinite / busy loops |
| output byte cap | output floods |
| `pids_limit` | fork bombs (the shell is already off — this is extra) |
| `read_only` root + small `noexec` `tmpfs` | a writable root filesystem |
| non-root `runner` user + `cap_drop: ALL` + `no-new-privileges` | privilege escalation |

The behaviour is tunable through environment variables in `docker-compose.yml` — the
per-run wall-clock timeout (`SPROUT_WALL_SECONDS`, default 5s), CPU-time limit
(`SPROUT_CPU_SECONDS`), input/output byte caps (`SPROUT_MAX_INPUT_BYTES` → HTTP 413,
`SPROUT_MAX_OUTPUT_BYTES`), simultaneous runs (`SPROUT_MAX_CONCURRENT` → HTTP 429), and the
address-space limit (`SPROUT_VMEM_KB`, ~256 MB).

> **Shared-container trade-off.** With `docker compose up`, all submissions share **one**
> locked-down container, so isolation *between* submissions is weaker than the
> per-submission model below. It's still safe for the code it runs (sandbox + per-run
> timeout/limits + temp-file cleanup), and it's perfect for a demo, a class, or a personal
> playground. For hostile, high-volume, multi-tenant traffic, prefer one container per
> submission.

## One container per submission

The strongest isolation is a **fresh, ephemeral container per run** — your backend pipes
the code in on stdin and throws the container away (`--rm`) afterward, so nothing carries
between submissions. Build the image once (a CI/deploy step):

```sh
docker build -f playground/Dockerfile -t sprout-playground .
```

Then run each submission with the full set of limits:

```sh
echo 'show [n*n for each n in 1 to 5] |> sum' | docker run --rm -i \
  --network none \
  --memory 256m --memory-swap 256m \
  --cpus 0.5 \
  --pids-limit 64 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 10001:10001 \
  sprout-playground
# -> 55
```

A malicious submission gets nothing — the sandbox stops it at the language level, and the
flags stop it at the OS level:

```sh
echo 'show read("/etc/passwd")' | docker run --rm -i --network none sprout-playground
# -> Sprout error (...): 'read' is turned off in sandbox mode — ...
```

Wiring it into a backend is "shell out to `docker run` per request, code on stdin, return
stdout." Keep the `docker build` as a deploy step, run the *image* per submission, and give
the outer spawn its own timeout slightly above `SPROUT_WALL_SECONDS` as a backstop. See
[`playground/README.md`](../playground/README.md) for the full threat model, the
per-layer rationale, and notes on putting a reverse proxy (TLS, per-IP rate limiting) in
front for anything internet-facing.

## Gotchas

- **`--sandbox` is host-facing, not language-facing.** The frozen language is unchanged;
  only outward builtins/statements are restricted. A sandboxed program that never touches
  files/network/shell behaves *identically* to an unsandboxed one.
- **`kind` for a blocked op is `error`, not `io`.** Don't branch on `io` to detect the
  sandbox; check `e["kind"] == "error"` or just match on the message if you must.
- **The flag is sufficient for the *language*, not for the *host*.** Re-read
  [Necessary but not sufficient](#necessary-but-not-sufficient): you still need CPU,
  memory, and output limits at the OS level.
- **`use system` vs `use file`.** Both are blocked, but by different rules — the module is
  off, and loading any file is off. Either way the message tells you which.
- **Read error-map fields with `["..."]`, not `.`** — `.` is module access. See
  [error handling](syntax-basics.md).
- **Env var beats nothing-set.** `SPROUT_SANDBOX` is checked for *existence*, so
  `SPROUT_SANDBOX=0` still turns the sandbox **on** (the value isn't parsed). To leave the
  sandbox off, don't set the variable at all.

## See also

- [Built-in functions](builtins-reference.md) — the full builtin surface (and which ones the sandbox
  closes)
- [Sprout syntax](syntax-basics.md) — the language, including `try`/`caught`, the error
  map, and `match`
- [Getting started](getting-started.md) — installing and running Sprout
- [`playground/README.md`](../playground/README.md) — the complete Docker threat model
- [`README.md`](../README.md) — the authoritative language spec
