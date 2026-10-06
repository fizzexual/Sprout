# Contributing to Sprout

Thanks for your interest in Sprout. This guide covers how to build the interpreter,
run the tests, and send a change.

To report a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Prerequisites

- **A C compiler.** `cc` or `gcc` on Linux and macOS. On Windows, MinGW `gcc`, for
  example: `winget install --id BrechtSanders.WinLibs.POSIX.UCRT`
- **bash**, to run the test suite. CI runs it with bash on Linux, macOS and Windows.
- **Docker**, only if you work on the playground.

Sprout has no other dependencies. The whole interpreter is one file: `src/sprout.c`.

## Build

Linux and macOS, from the repo root:

```bash
cc -O2 -Wall -o src/sprout src/sprout.c -lm
```

Windows, from the repo root:

```bash
gcc -O2 -Wall -s -Wl,--stack,67108864 -o src/sprout.exe src/sprout.c -lm -lurlmon
```

Or run `build.cmd` from the `src` folder. It runs the same `gcc` command.

## Run

From the `src` folder:

```bash
./sprout run hello.sprout
./sprout version
```

## Test

```bash
bash src/tests/run.sh
```

This runs every file in `src/tests/` and every program in `examples/`:

- `*_test.sprout` files use the `test` / `expect` framework and run with `sprout test`.
  They fail on a non-zero exit code.
- Other test files are plain scripts run with `sprout run`. They fail if the output
  contains `sprout error` or `FAIL`.
- Each example must run without a `sprout error`.

When you fix a bug or add a feature, add a test in `src/tests/`.

To check memory safety the way CI does (Linux, with AddressSanitizer):

```bash
cc -O1 -g -fsanitize=address -fno-omit-frame-pointer -o src/sprout src/sprout.c -lm
ASAN_OPTIONS=detect_leaks=0:detect_stack_use_after_return=0:halt_on_error=1:abort_on_error=1 bash src/tests/run.sh
ASAN_OPTIONS=detect_leaks=0:detect_stack_use_after_return=0:halt_on_error=1:abort_on_error=1 SPROUT_GC_STRESS=1 bash src/tests/run.sh
```

The last line runs the garbage collector on every statement, which catches missing
GC roots.

## Formatting Sprout code

`sprout format` tidies `.sprout` files:

```bash
./sprout format file.sprout --write    # edit the file in place
./sprout format file.sprout --check    # exit 1 if the file is not formatted
```

## Playground

To build the playground images from your checkout, from the repo root:

```bash
docker build -f playground/Dockerfile -t sprout-playground .
docker build -f playground/Dockerfile.web -t sprout-web .
```

See [playground/README.md](playground/README.md) for how to run them.

## CI

The **CI** workflow (`.github/workflows/ci.yml`) runs on every pull request. All of
its jobs must pass:

- **build & test** on Linux, macOS and Windows: build, `sprout version`, the test
  suite, a `sprout bundle` round-trip, a check that `sprout format` is idempotent on
  every example and test file, and a package manager round-trip
  (`add` / `install` / `remove`).
- **memory safety**: the test suite under AddressSanitizer, then again with
  `SPROUT_GC_STRESS=1`.
- **playground image**: builds both Docker images, checks that safe code runs and
  that file, shell and network access are blocked, and validates `docker-compose.yml`.

## Proposing a change

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep the PR small and about one thing.
3. Add or update tests in `src/tests/`.
4. Run `bash src/tests/run.sh`. It must pass.
5. Open a pull request against `main`. Say what you changed and why.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
