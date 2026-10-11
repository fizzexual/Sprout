# Sprout API worker example

The Python service host accepts HTTP, executes bounded Sprout workers, and
validates a structured response. Sprout owns application rules and parameterized
database queries; Python owns sockets and request lifecycle. No extra Python
packages are needed.

```sh
python integrations/python/sprout_service.py examples/services/contacts.sprout --allow-io
curl -X POST http://127.0.0.1:8080/contacts -d '{"name":"Ada","email":"ada@example.test"}'
curl http://127.0.0.1:8080/contacts
```

The example creates a SQLite database beside its source. POST validates bounded
text fields; unique email collisions return 409. GET returns column/value rows.
Database waits are capped at 250 ms per call. Failed schema setup, busy databases,
and storage errors return 503; they do not masquerade as duplicate emails.
All parameters are bound independently of SQL text. `/health` reports the host's
protocol; it does not prove database health.

Host concurrency defaults to eight requests, with a 32-connection backlog,
two-second total request-read deadline, 64 KiB body limit, and bounded worker output.
The read deadline covers headers and body together; trickling bytes cannot reset
it. A complete buffered request must still meet the deadline before dispatch.
Responses have a separate two-second socket write timeout.
Excess work returns 503. Runtime failures return a short 502/504 response without
exposing interpreter diagnostics. Content-Length ambiguity, oversized bodies,
invalid JSON and response header injection are rejected. Response JSON retains
Sprout's exact numeric tags. Native binaries must be built with SQLite support.
Unsupported transfer encoding and malformed request targets also return 400
before worker launch. HEAD and 204/205/304 responses carry no wire body.

This is a tested service integration example, not a completed internet hosting
platform. Deploy behind an HTTP server that provides TLS, authentication,
rate limiting, logs and request monitoring. The host defaults to loopback. Keep
trusted worker programs in protected paths and use OS/container limits where
untrusted code is accepted. A new interpreter per request favors isolation and
simple rules; measure latency before choosing it for high-throughput APIs.

Configure CLI limits with `--workers`, `--timeout-ms` and `--max-body`. Listener
close waits for accepted requests to finish; POSIX SIGTERM and Ctrl+C drain those
handlers. Configure a supervisor shutdown grace longer than the worker timeout
plus the read/write limits and scheduling overhead. Forced termination
can still interrupt work. See [deployment evidence](deployment-evidence.md) and
[production readiness gates](production-readiness.md) before promoting a build.
Use `--cwd /var/lib/sprout` to keep relative SQLite files and stores in a writable
state directory while the installed worker source stays read-only. The directory
must already exist; by default it is the worker source's directory.
