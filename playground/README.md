# Sprout playground (Docker)

Run **untrusted** Sprout submissions on your server without handing strangers your
filesystem, shell, or network. This is the operational layer on top of the `--sandbox`
flag: a minimal, non-root image plus a resource-limited runner.

There are **two ways to run it**:

1. **The web playground (one command)** — `docker compose up` gives you a browser-based
   editor at `http://localhost:8080`. One shared, locked-down container serves everyone.
   Easiest to self-host; good for a demo, a class, or a personal playground.
2. **One ephemeral container per submission** — the strongest isolation (a fresh container
   per run, `--network none`). Best for hostile, high-volume, multi-tenant traffic. Your
   backend pipes code in on stdin. Documented further down.

Both run untrusted code under `sprout --sandbox` (no files, shell, or network) with a
timeout and an output cap; they differ only in isolation between submissions.

## The web playground (`docker compose up`)

From the **repository root**:

```sh
docker compose up --build
# then open http://localhost:8080
```

That's it — a sandboxed editor with a Run button. Under the hood `docker-compose.yml`
applies the full hardening (non-root, read-only root + `tmpfs`, `--cap-drop ALL`,
`no-new-privileges`, memory/CPU/pids limits); a tiny dependency-free Python server
(`server.py`) accepts code on `POST /run` and hands each submission to the **same** runner
(`run.sh`) used below. Output is capped, runs time out, and at most
`SPROUT_MAX_CONCURRENT` run at once (excess requests get HTTP 429).

> **Shared-container trade-off:** submissions share one container, so isolation *between*
> submissions is weaker than the per-submission model below. It's still safe for the code
> it runs (sandbox + per-run timeout/limits + temp-file cleanup), but for hostile
> multi-tenant traffic prefer one container per submission.

Tunables (set in `docker-compose.yml` under `environment:`):

| Var | Default | Meaning |
| --- | --- | --- |
| `SPROUT_WALL_SECONDS` | `5` | per-run wall-clock timeout |
| `SPROUT_CPU_SECONDS` | `5` | per-run CPU-time limit |
| `SPROUT_MAX_INPUT_BYTES` | `65536` | reject programs larger than this (HTTP 413) |
| `SPROUT_MAX_OUTPUT_BYTES` | `65536` | output cap |
| `SPROUT_MAX_CONCURRENT` | `4` | simultaneous runs; excess get HTTP 429 |
| `SPROUT_VMEM_KB` | `262144` | per-run address-space limit (~256 MB) |

## One ephemeral container per submission

## Build

From the **repository root** (the build compiles `src/sprout.c`):

```sh
docker build -f playground/Dockerfile -t sprout-playground .
```

## Run a submission

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

A malicious submission gets nothing:

```sh
echo 'show read("/etc/passwd")' | docker run --rm -i --network none sprout-playground
# -> Sprout error (...): 'read' is turned off in sandbox mode — ...
```

## Why each layer is there (defence in depth)

No single mechanism is trusted on its own:

| Layer | What it stops |
| --- | --- |
| `--sandbox` (env `SPROUT_SANDBOX=1`, baked into the image) | the *language's* doors: `read`/`write`/`append`/`exists`, `remember`/`recall`/`forget`, `get`/`explore`, and the whole `system` shell module |
| `--network none` | any network egress — SSRF to internal services / the cloud metadata endpoint (also covered by the sandbox, but belt-and-suspenders) |
| `--memory` / `--memory-swap` | RAM exhaustion (the GC keeps a run *bounded*, not *small*) |
| `--cpus`, `SPROUT_WALL_SECONDS`, `ulimit -t` | infinite / busy loops — wall-clock **and** CPU timeouts |
| `SPROUT_MAX_OUTPUT_BYTES` + `ulimit -f` | output floods (capped, and the temp file is size-limited) |
| `--pids-limit`, `ulimit -u` | fork bombs (the shell is already blocked, so this is extra) |
| `--read-only` + `--tmpfs /tmp` | a writable root filesystem; the only writable spot is a small, `noexec` tmpfs |
| non-root `runner` user + `--cap-drop ALL` + `no-new-privileges` | privilege escalation and host-level capabilities |
| `--rm` (ephemeral, one container per run) | state carrying between submissions |

## Tuning (env vars)

Override the Dockerfile defaults per run with `-e`:

| Var | Default | Meaning |
| --- | --- | --- |
| `SPROUT_WALL_SECONDS` | `5` | wall-clock timeout |
| `SPROUT_CPU_SECONDS` | `5` | CPU-time limit (`ulimit -t`) |
| `SPROUT_MAX_OUTPUT_BYTES` | `65536` | output cap |
| `SPROUT_VMEM_KB` | `262144` | address-space limit (`ulimit -v`, ~256 MB) |
| `SPROUT_PROCS` | `64` | process/thread limit (`ulimit -u`) |

```sh
echo "$code" | docker run --rm -i -e SPROUT_WALL_SECONDS=3 --network none --memory 128m sprout-playground
```

## Wiring it into a backend

Per request, shell out to `docker run` with the flags above and the code on stdin. Keep
the `docker build` as a CI/deploy step and run the *image* per submission — never run the
backend and the submission in the same process. A 30-line example in any language:
`spawn("docker", ["run","--rm","-i","--network","none", ...], { stdin: code, timeout: 8000 })`,
then return stdout. (Give the outer spawn its own timeout slightly above `SPROUT_WALL_SECONDS`
as a backstop in case Docker itself stalls.)

> **Still your responsibility:** keep Docker and the base image patched, rate-limit
> submissions per user, and run the host with user namespaces / a seccomp profile if you
> can. This setup is secure-by-default for the *code* it runs; it is not a substitute for
> normal server hygiene.

### Hardening the web server for the public internet

The bundled `server.py` already defends itself against the obvious denial-of-service: it
caps simultaneous connections (`SPROUT_MAX_CONNECTIONS`), force-closes any single request
after `SPROUT_REQUEST_DEADLINE` seconds (so slow-drip *slowloris* clients can't tie up
threads), caps concurrent runs (`SPROUT_MAX_CONCURRENT` → HTTP 429), and rejects oversized
bodies (HTTP 413). That's enough for a demo, a class, or a low-traffic playground.

For anything internet-facing, still put a **reverse proxy** (nginx, Caddy, a CDN) in front
to add TLS, per-IP rate limiting, and request-timeout/buffering — the standard front line
for a public HTTP service. The Python server is deliberately tiny and single-purpose, not a
hardened edge server.
