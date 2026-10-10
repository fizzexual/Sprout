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

`run` caps streamed stdout/stderr, stdin, interpreter steps, runtime deadline,
and host deadline. Pass a `threading.Event` as `cancel` for cancellation.
`SproutError.code` distinguishes runtime, protocol, cancellation and limit
failures; `stderr` is retained within its configured cap.

Sandbox mode defaults to enabled. Trusted applications that import files or
use native libraries can set `sandbox=False`; use a restricted OS identity or
container for hostile source. Windows native runners use kill-on-close jobs;
POSIX native runners use a guardian to kill their owned process group after
owner exit, including nested Sprout workers. Deliberately daemonized descendants
that create a different process group need a container or external supervisor
for descendant-wide termination. The host also kills its own POSIX group or
Windows process tree on cancellation.
