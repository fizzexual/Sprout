# Python host SDK

Copy `sprout_host.py` into a Python 3.10+ project. No third-party packages are
needed. Each call starts a separate interpreter with a strict JSON boundary.

```python
from decimal import Decimal
from sprout_host import run

result = run("price.sprout", {"price": Decimal("19.95"), "quantity": 3},
             command="/opt/sprout/sprout")
```

The program reads `json_decode(read_input())` and prints exactly one
`json_encode(result)` line. Plain `show` debugging violates the response
protocol. Python `int` above the safe floating range, `Decimal`, and `bytes`
round-trip through version 1 exact data tags. Integers must fit int64; decimals
use an int64 coefficient and at most 18 fractional places.
The boundary permits at most 128 nested wire containers, including exact-value
tag maps. Excessive nesting and malformed exact tags are rejected before launch
or reported as protocol errors. The service validates the complete request
envelope against its encoded input limit before creating a worker.
Strings and keys must be Unicode scalar text without NUL, matching native
Sprout text. Duplicate decoded keys and non-finite numbers are rejected.

`run` caps streamed stdout/stderr, stdin, interpreter steps, runtime deadline,
and host deadline. Pass a `threading.Event` as `cancel` for cancellation.
If local thread/task capacity prevents an I/O thread from starting after launch,
the SDK terminates and reaps the owned worker, closes available pipes, and raises
`SproutError` with code `io`. Thread objects are prepared before launch. An
initialization interrupt performs cleanup and retains its interrupt semantics.
`SproutError.code` distinguishes runtime, protocol, cancellation and limit
failures; `stderr` is retained within its configured cap.
Input encoding counts compact UTF-8 JSON bytes before expanding further shared
collections or creating binary hex text. `max_input_bytes` includes the final
newline and is clamped to the native reader's 1 MiB limit. An already-set cancel
event is checked before input traversal. Standalone `encode(value)` keeps its
existing behavior; `encode(value, max_bytes=N)` optionally applies the same
encoded-size budget without a line terminator. These caps do not provide an OS
memory limit or interrupt arbitrary Python methods supplied by the application.

Sandbox mode defaults to enabled. Trusted applications that import files or
use native libraries can set `sandbox=False`; use a restricted OS identity or
container for hostile source. Windows native runners use kill-on-close jobs;
POSIX native runners use a guardian to kill their owned process group after
owner exit, including nested Sprout workers. Deliberately daemonized descendants
that create a different process group need a container or external supervisor
for descendant-wide termination. The host also kills its own POSIX group or
Windows process tree on cancellation.

`sprout_service.py` is a bounded HTTP bridge with a fixed worker capacity and
strict request framing. Unsupported transfer encodings, ambiguous or malformed
content lengths, and malformed request targets return 400 before worker launch.
HEAD and 204/205/304 responses have no wire body. The contacts SQLite example
uses prepared parameters and a 250 ms database wait: a duplicate email returns
409, while schema, busy, and storage failures return 503 and can recover on a
later request. Deploy the bridge behind your application's HTTP/TLS and
authentication layer.

The CLI accepts `--workers`, `--timeout-ms` and `--max-body`; defaults are 8,
5000 ms and 65536 bytes. Use `--cwd /var/lib/sprout` to place relative application
data in an existing writable directory while keeping the source immutable.
Without `--cwd`, the worker uses the source file's directory.
Listener shutdown waits for accepted handlers to finish
within their configured worker/read/write limits. Headers and body share one
two-second absolute read deadline; trickling input does not extend it. The
response write timeout is separate, so dispatched workers can finish while
the service drains. POSIX SIGTERM and Ctrl+C stop the
listener and drain those requests; forced process termination does not promise
graceful drain. `/health` reports listener liveness, not worker/database readiness.
