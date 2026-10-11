# Bounded lifecycle soak evidence

Run the standard-library-only harness against a built native interpreter:

```text
python tools/soak.py src/sprout.exe --cycles 50 --seed 20261010 --report soak.json --artifacts soak-artifacts
```

On Linux/macOS use `src/sprout`. For a shorter run, add
`--duration-seconds 20`; the harness finishes its current cycle before stopping,
and never exceeds the requested cycle count. Every process and handshake has a
deadline. A failed invariant stops the run, returns a nonzero status, and retains
that cycle's sources, SQLite ledger, and checkpoints under the artifact directory.
The report records the actual completed scope, duration, seed, platform,
interpreter/harness/SDK/fixture hashes, limits, counts, and errors.
The current harness snapshots the executable once and verifies its hash again
after all cycles, so a concurrent rebuild of the original cannot mix runtimes.
The current whole-workflow deadline is 15 seconds with an 18-second outer
process bound; individual native fixture jobs still have a two-second limit.
The earlier five-second whole-workflow budget expired on a hosted Windows CI
runner during a complete multi-stage DAG. These bounds are recorded in each
report and do not define a throughput or latency SLA.

Each complete cycle exercises:

- A five-job DAG with three ready jobs competing for three workers, one deliberate
  failure followed by its permitted retry, and a final dependency join.
- A completed checkpoint resume that must launch no additional work and preserve
  both its results and checkpoint bytes.
- A permanent failure whose descendant must remain pending with zero attempts,
  including a second run that must not retry the failed operation.
- Abrupt interpreter termination after an idempotent effect is committed while
  the checkpoint still records `running`, followed by a successful resume.
- Native fail-fast cancellation after a worker has committed its operation,
  followed by a successful repeat using the same operation key.
- Python SDK cancellation during a bounded numeric loop, followed by a fresh
  arithmetic request with a separately calculated expected answer.

The oracle is outside Sprout's checkpoint implementation. Python worker fixtures
record execution starts, successful/failed finishes, and applied operations in a
transactional SQLite ledger. The harness checks dependency event ordering,
closed-form arithmetic results, exact attempt counts, absent blocked-job starts,
and one applied effect for each operation key. A cycle records twelve actual
native fixture executions and two SDK interpreter starts. It also checks that
SDK children exited, their pipes closed, and the host's thread count returned to
its baseline. Native cancellation workers are inspected by PID after the group
returns, before recovery begins.

The interrupted worker waits on a fixture-owned release gate. Windows normally
terminates it when the interpreter's kill-on-close job disappears. A POSIX orphan
may survive its parent; the harness explicitly releases the bounded fixture and
checks that it stops. A Linux zombie is considered stopped, not proof of reaping.
This test does **not** establish automatic descendant cleanup after every native
parent crash. The fixture performs no further side effects after its release.

Operation keys and transactions are implemented by the application fixture.
They demonstrate safe recovery when a job was explicitly designed to tolerate
repetition. They do not turn the workflow engine into an exactly-once system.
Cancellation can occur after an external effect was committed.

## Recorded sample

The original Windows sample report is `benchmarks/soak-2026-10-10-windows.json`. Read its
`passed`, `completed_cycles`, `counts`, and binary hash together; a successful
shorter or older run is not evidence for a larger scope or different build.

The recorded run completed all 50 cycles in 142.74 seconds with zero invariant
failures. It verified 600 native fixture executions, 100 SDK interpreter starts,
250 completed DAG jobs, 50 permitted retries, 50 blocked descendants that never
launched, 50 crash recoveries, and 50 cancellation/recovery pairs for each of the
native and SDK paths. All 350 operation keys had exactly one applied effect.
The longest observed SDK cancellation took 0.434 seconds, including process
shutdown; that local observation is not a latency guarantee. The report's binary
and harness hashes matched the files again after the run.

### Final snapshot sample, October 11

`benchmarks/soak-2026-10-11-windows.json` records the final optimized Windows
binary beginning `b64d4a01864f5d4c`. All 50 cycles completed in 82.84 seconds with
zero invariant failures: 400 native CLI starts, 600 external fixture executions,
100 SDK interpreter starts, 250 DAG jobs, 50 permitted retries, 50 completed
resumes, 50 blocked descendants, 50 crash recoveries, and 50 cancellation/recovery
pairs for each native and SDK path. Each of the 350 application-owned operation
keys had one applied effect. The median complete cycle took 1.634 seconds; the
longest observed SDK cancellation took 0.235 seconds.

Every cycle ran an immutable executable snapshot. Its hash matched again at the
end, and the original executable, harness and SDK hashes also matched the report
after the run. The earlier October 10 record is retained for its own build and
scope; differences in elapsed time between these samples are not a controlled
performance comparison.

This is a bounded local lifecycle exercise. It does not establish uptime under
production traffic, memory/RSS stability over hours, behavior during disk or
network failure, security isolation, or parity on a different OS. The workload
does not measure Sprout's SQLite API: its SQLite ledger is an independent Python
oracle. HTTP service load, sanitizer runs, and longer operational soak tests are
separate evidence.

## HTTP and native SQLite load method

`tools/service_load.py` exercises the real contacts example through the Python
HTTP host and Sprout's native SQLite module:

```text
python tools/service_load.py src/sprout.exe --contacts 200 --clients 8 --workers 4 --seed 20261011 --report service-load.json --artifacts service-load-artifacts
```

It copies the contacts source and snapshots the interpreter into a temporary
directory, so a concurrent rebuild cannot mix executables within a run. The
service binds only to an ephemeral loopback port. Eight clients issue unique
contact POSTs against four service workers. Names include Unicode, quotes, and
SQL-shaped text; expected names/emails are generated independently of database
results. Each attempt has a socket timeout, and every logical contact has a
deadline and retry limit. Exponential jittered backoff retries capacity 503,
database-busy 503, and transport failures using the same unique email. If an
ambiguous transport retry receives 409, it is accepted only subject to the final
exact row oracle. This is application-key reconciliation, not exactly-once HTTP
delivery.

Before the concurrent phase, an independent Python SQLite connection holds an
exclusive database lock. A real POST must receive an application 503; the same
email is then included in the unlocked concurrent workload. After all clients
finish, a deliberate duplicate with a changed name must return 409 without
changing its original row. Python `sqlite3` reads the complete database directly,
checks every expected name/email and unique positive ID, verifies the exact
count and `PRAGMA integrity_check`, and compares an HTTP GET against that same
independent dataset. A separate sequential phase replaces the temporary worker
with an intentional `fail`: it must return generic 502 without its internal
message/path, then recover after the original source is restored. Server capacity
must be fully released between phases and host threads must return to baseline.

Reports include binary/source/SDK/server/harness/dataset hashes, seed, platform,
Python and oracle SQLite version, limits, status/retry/transport counts, and
nearest-rank p50/p95/maximum latency. Attempt latency measures only concurrent
POST attempts, including 503 and transport failures. Logical contact latency
also includes their retries/backoff. The controlled busy response has a separate
duration; warm-up, verification GETs, deliberate duplicate, and failure/recovery
requests are outside concurrent POST status/latency totals. Failure artifacts
retain the copied source and database; a nonzero exit means an invariant failed.

This measures bounded local behavior with one native process per request and a
local database. It does not establish network deployment throughput, multi-host
durability, prolonged memory stability, a public-service security boundary, or a
latency SLA. Concurrent outcomes vary with scheduling even with a fixed dataset
and seed.

### Final HTTP sample, October 11

`benchmarks/service-load-2026-10-11-windows.json` records the same optimized binary
beginning `b64d4a01864f5d4c`, with Python 3.12.10 and the independent SQLite 3.49.1
reader. It completed all 200 expected contacts with zero invariant failures in
4.517 seconds overall, including 3.132 seconds for the concurrent write phase.

There were 435 concurrent POST attempts: 200 successful 201 responses, 210
capacity 503 responses and 25 transport resets. All retryable outcomes recovered
within the configured bounds; no ambiguous committed-write 409 was observed.
No database-busy 503 occurred during the concurrent phase. The separate exclusive
lock phase verified one real application 503 before retrying its stable email;
that request took 830 ms, including process/HTTP overhead and statement-level
waits. The 250 ms statement option is not a whole-request latency limit.

The deliberate duplicate 409 preserved the original name. Direct SQLite reads
and HTTP GET each matched all 200 exact expected names/emails and unique positive
IDs; `integrity_check` returned `ok`. An intentional worker failure produced
generic 502 without its private detail/path, then a following GET recovered with
unchanged rows. The host released all capacity and returned to its original
thread count.

Nearest-rank p50/p95/maximum logical-contact latency was 75.9/245.1/2470.6 ms,
including retries/backoff. For all concurrent POST attempts it was
3.27/77.40/108.28 ms. The attempt quantiles include fast capacity rejections and
transport failures; they are not successful-request latency. The report's binary,
copied source, SDK, HTTP host and harness hashes matched the current files after
the run. This fixed local sample does not establish a throughput or latency
guarantee for deployment.
