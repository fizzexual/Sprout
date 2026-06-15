# Sprout playground (Docker)

Run **untrusted** Sprout submissions on your server without handing strangers your
filesystem, shell, or network. This is the operational layer on top of the `--sandbox`
flag: a minimal, non-root image plus a resource-limited runner.

The model is **one ephemeral container per submission** — the safest design. Your web
backend pipes the code in on stdin and reads the (capped) output back.

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
