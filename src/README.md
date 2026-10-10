# Sprout interpreter

Sprout is a native interpreter written in one C file, `sprout.c`. The executable
needs only the operating system's libraries. The same interpreter compiles to
WebAssembly for the [browser playground](../playground/web/).

## Build

Windows, with MinGW GCC on PATH, from the repository root:

```powershell
.\src\build.cmd
.\install.ps1
```

`build.cmd` builds next to its source, regardless of the current working directory.
`install.ps1` copies the executable to `%LOCALAPPDATA%\Programs\Sprout` and adds
that directory to your user PATH. Open a new terminal afterward. A compiler is
needed to build, but never to run Sprout.

Linux or macOS, from the repository root:

```sh
cc -O2 -Wall -o src/sprout src/sprout.c -lm
./src/sprout version
./src/sprout src/hello.sprout
```

For Windows compiler setup, see [getting started](../wiki/getting-started.md).

## Test

From the repository root:

```sh
bash src/tests/run.sh
python src/tests/cli_test.py src/sprout          # use src/sprout.exe on Windows
node --test vscode-extension/tests/*.test.js playground/tests/*.test.js
```

The shell suite runs language tests, examples, sandbox probes, and error trace
checks. CLI regressions use Python's standard library; editor and playground
tests use Node's built-in test runner. Python and Node are development tools,
not dependencies of the Sprout executable.

## Current language

The interpreter supports collections, closures, objects and inheritance,
interfaces and optional type annotations, pattern matching, pipes, modules,
error handling, testing, and file/network/persistence builtins. A conservative
mark-sweep collector reclaims runtime strings, collections, environments, and
closures, including cycles.

- [Language guide](../wiki/README.md)
- [CLI reference](../wiki/cli-and-flags.md)
- [Examples](../examples/README.md)
- [Contribution and CI guide](../CONTRIBUTING.md)
