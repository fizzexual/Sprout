# Go host SDK

This package uses cgo to compile the small native host backend into the Go
application. It does not link the interpreter or SQLite into the application's
heap. A native Sprout executable is supplied separately. A C compiler and
`CGO_ENABLED=1` are required when building; no extra host DLL is needed afterward.

```go
host, err := sprouthost.New("/absolute/path/sprout", sprouthost.Options{})
if err != nil { panic(err) }
result, err := host.Run(context.Background(), "/absolute/path/rules.sprout",
    map[string]any{"quantity": 4, "unit_price": sprouthost.Decimal("12.50")})
if err != nil { panic(err) }
var response map[string]any
if err := result.Decode(&response); err != nil { panic(err) }
```

`Host` is immutable and safe for concurrent calls. Each run creates a fresh
worker. Defaults: language sandbox on, 5 seconds, 10 million steps, 1 MiB per
output stream. Options permit a working directory, explicit trusted `AllowIO`,
and larger bounded limits. `MaxMemoryBytes` optionally caps total committed job
memory on Windows or per-process address space on POSIX; zero disables that cap.
These limits do not measure resident memory. `context` cancellation joins the native cancellation
callback and terminates the owned process tree. Every source/executable/cwd path
must be absolute. Requests are at most 1 MiB of JSON; output is validated JSON.
Nonzero worker exits produce a `Failure` with status, diagnostics and exit code;
timeouts/cancellation wrap Go context errors.

`Integer`, `Decimal`, and `Bytes` encode version 1 exact-value tags. Decode uses
`json.Number`; tags stay explicit maps unless the application defines a custom
decoder. Decimal arithmetic follows Sprout's signed 64-bit coefficient and
18-decimal-place limits, so not every Go string is a representable decimal.

The checked-in `embed.c`, `embed.h`, and `process_native.h` are byte-for-byte
copies of the shared native SDK source at `src/`, allowing this module to build
independently from a Go module archive. Run `sync_native.py` after changing the
shared SDK; the tests reject stale copies. The platform lifecycle boundary is
the native SDK's Windows job object / POSIX process group, not an OS tenant
sandbox. Deliberately detached POSIX descendants can escape a process group.

Run real worker tests:

```sh
SPROUT_BINARY=/absolute/path/sprout CGO_ENABLED=1 go test ./...
```

Windows can set `CC` to its MinGW GCC executable. `examples/rules.sprout`
demonstrates moving pricing rules into Sprout while Go continues serving requests.
