# Native C host SDK (ABI 1)

`src/embed.h` and `src/embed.c` host Sprout workers in a separate native process.
The application keeps its own heap, threads, and crash boundary; the API does not
pretend the interpreter's global state is safe to embed concurrently in-process.
Each call launches a fresh bounded worker. Independent calls may run concurrently.

The protocol is a source file plus one UTF-8 JSON request on stdin, and exactly
one JSON value/line on stdout. Runtime diagnostics go to stderr. The caller must
parse JSON and apply its own schema validation; the C SDK validates the UTF-8,
single-line framing, and limits, not JSON syntax. Version 1 exact-value tags are
`$sprout.integer`, `$sprout.decimal`, and `$sprout.bytes` (hex).

Worker source:

```sprout
make request = json_decode(read_input())
show json_encode({message: "Hello", received: request})
```

Host application:

```c
#include "embed.h"
#include <stdio.h>

int main(void) {
    SproutHostOptions options;
    SproutHostResult result;
    sprout_host_options_init_sized(&options, sizeof options);
    options.executable = "/absolute/path/sprout";
    options.program = "/absolute/path/worker.sprout";
    options.request_json = "{\"name\":\"Ada\"}";
    SproutHostStatus status = sprout_host_run(&options, &result);
    if (status == SPROUT_HOST_OK) puts(result.output_json);
    else fprintf(stderr, "%s\n%s", result.error ? result.error : "worker failed",
                 result.diagnostics ? result.diagnostics : "");
    sprout_host_result_free(&result);
    return status == SPROUT_HOST_OK ? 0 : 1;
}
```

Compile the SDK into a host, without linking the interpreter:

```sh
cc -std=c11 -O2 -Isrc host.c src/embed.c -o host
```

Build a P/Invoke shared library:

```sh
# Linux (macOS: use -dynamiclib and libsprout_host.dylib)
cc -std=c11 -O2 -shared -fPIC src/embed.c -o libsprout_host.so
# Windows MinGW GCC; in PowerShell quote '-Wl,--export-all-symbols'
gcc -std=c11 -O2 -shared -Wl,--export-all-symbols src/embed.c -o sprout_host.dll
```

Initialize options with `sprout_host_options_init_sized(&options, sizeof options)`; initialize a fresh result for
each call and free it with `sprout_host_result_free`. Reusing an unfreed result
leaks caller-owned buffers. All paths must be absolute. Request size is at most
1 MiB and the explicit `request_length` never includes a terminator. The request
must be valid JSON; malformed JSON is for the worker/caller to reject.

Defaults: sandbox enabled, 5-second wall-clock limit, 10 million execution steps,
1 MiB capture per stream. Limits can rise to 1 hour, one trillion steps, and
16 MiB per stream. Set `SPROUT_HOST_ALLOW_IO` only for trusted worker code that
needs the filesystem/network/process APIs. Language sandboxing is an API gate,
not OS-level isolation. For hostile tenants, place workers in an OS sandbox.

`max_memory_bytes` is zero by default (no OS memory cap). A nonzero value must
be from 16 MiB to 64 TiB, within native `size_t`. Windows applies a total committed
memory limit to the job before resuming the worker. POSIX applies `RLIMIT_AS`
before `exec`, limiting each process's address space; descendants inherit that
limit. These are different accounting models, neither a resident-memory limit.
Allocation refusal produces child failure, or launch failure if the loader cannot
start within the limit. The SDK does not promise a distinct memory-limit status.
Choose a cap that covers native libraries and the workload, then verify it on the
deployment platform. The original ABI1 options prefix remains accepted; the
original `sprout_host_options_init` writes only that prefix and leaves the added
memory option disabled. New callers should use the sized initializer.

For asynchronous host cancellation, create `SproutHostCancel` with
`sprout_host_cancel_new`, pass it to `sprout_host_run_cancellable`, and call
`sprout_host_cancel_request` from the host's cancellation callback. The result
status is `SPROUT_HOST_CANCELLED`. After the run returns, join all callbacks
before `sprout_host_cancel_free`; the handle cannot be freed while a callback
is using it. Go and .NET bindings implement this lifetime rule.

The host passes literal argv, drains both pipes concurrently, and terminates its
owned process tree after timeout, overflow, or cancellation. Windows uses a job object; POSIX
uses a process group, which deliberately detached descendants can escape. The
executable is never searched on PATH. Native C/C++ callers can include the header;
the implementation compiles as C. The result status distinguishes malformed
arguments, launch failure, timeout, capture overflow, child failure, and bad
framing. Captured diagnostics preserve the child's encoding.

`src/tests/embed_test.py <binary>` compiles the standalone SDK and exercises the
actual JSON worker protocol, isolation, and limit behavior.
