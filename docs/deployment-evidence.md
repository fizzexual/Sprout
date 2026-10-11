# Local deployment evidence

`tools/deployment_soak.py` runs a duration-based HTTP/SQLite exercise using a
frozen native interpreter, Python SDK, HTTP host, contacts app and harness. Each
input is copied into a new workspace and hashed before traffic starts; the final
success gate verifies those copies again. A running report has `passed: null`;
only a finished report with `passed: true` represents completed evidence.

## Method

The controller starts a separate Python service process bound to an ephemeral
`127.0.0.1` port. The default workload sends eight concurrent contact writes to
four service workers, pacing new contacts at four per second. Each request
starts a native interpreter through the real SDK. Unicode, quotes and SQL-shaped
names are included in the independently generated data.

Each logical contact uses a stable unique email, at most 32 POST attempts and a
15-second retry budget. Socket attempts have a six-second timeout clamped to the
remaining logical budget. Responses arriving after that budget are rejected.
Capacity 503,
database-busy 503 and transport failures use bounded jittered backoff. A 409
after an ambiguous transport failure is reconciled by the exact data oracle;
there is no exactly-once delivery claim. An operation already in progress can
complete after a socket timeout, so the oracle and unique keys still matter.

The independent controller records the expected name and email in its own
SQLite oracle before submitting a contact. Direct Python `sqlite3` reads check
all stored values, exact counts, unique positive IDs and `integrity_check`. HTTP
GET contents must match the same expected dataset. Checks run periodically,
before and after service restarts, and at completion. Deliberate duplicate
emails must return 409 and preserve their original values.

Every 60 seconds, an independent SQLite connection holds `BEGIN EXCLUSIVE`
while a real POST must return application 503. The lock is then released and
that same contact is submitted through the normal workload. Every 180 seconds,
the controller stops the service and starts a new process against the retained
database. Stop includes server shutdown, native child exit accounting and a
thread return-to-baseline gate. These are graceful restarts between completed
write bursts; traffic is not submitted during the deliberate stop interval.

Database shards rotate after 2,000 contacts, before this example's all-rows GET
could exceed its response byte limit. Each shard is retained in the workspace
and verified before rotation. A shard remains in use across several service
restarts. This rotation tests repeated process lifecycle and bounded data sets,
not an unbounded growing database.

The host samples resources every 100 ms and writes live metrics once per second.
Each process epoch records initial, final and maximum sampled RSS/private bytes,
threads, Windows handles or POSIX file descriptors, native child start/exit
counts and maximum concurrent native children. Windows thread figures count
Python threads; Linux uses the process status thread count. Missing platform
metrics remain null. Native child samples can miss short-lived peaks. Windows
handles and POSIX descriptors have different meanings; POSIX enumeration can
include the probe's own descriptor. Resources are observations, not a leak-free
proof or enforced memory budget.

The JSON report includes every frozen input hash, seed, environment, configured
limits, status and retry counts, independent checks and per-host resource
summaries. POST-attempt latency includes capacity rejections and transport
failures; logical-contact latency includes retries and backoff. Health probes,
GET verification, forced lock requests and deliberate duplicates are counted
separately and excluded from those latency distributions. Failure reports and
databases are retained; a failed invariant exits nonzero. The current harness
uses `perf_counter` for latency and records its implementation and resolution.

## Run it

Use a new workspace for every run. Nothing is exposed beyond loopback, and the
fixture writes only inside that workspace.

```powershell
python tools/deployment_soak.py src/sprout.exe --duration-seconds 1800 --workspace D:/Codex/Kestrel/work/deployment-30min-NEW --report benchmarks/deployment-NEW.json
python tools/deployment_soak.py src/sprout.exe --duration-seconds 28800 --workspace D:/Codex/Kestrel/work/deployment-8hr-NEW --report benchmarks/deployment-8hr-NEW.json
```

On POSIX systems, pass the native binary path instead of `src/sprout.exe`.
`--rate`, `--clients`, `--workers`, `--burst`, `--restart-seconds`,
`--contention-seconds` and `--shard-contacts` configure the workload. Use a small
duration and short intervals to verify the harness before a long run. Increasing
traffic or shard size changes the tested scope and can hit application output
limits. An hours-long run still performs deliberate restarts; it is not a claim
that one process ran uninterrupted for those hours.

The workspace retains `manifest.json`, live `progress.json`, per-host metrics,
frozen inputs, shard databases and the separate expected-data oracle. The report
records the controller PID and current service PID so a later monitor can
collect results. Its state and actual elapsed duration must be checked before
reporting completion.

The current harness also rejects interrupted or incomplete runs, requires the
requested traffic duration and final snapshot verification, and applies resource
gates after every service epoch. Host initial/final/maximum RSS and thread
measurements are required; Windows also requires handle counts and Linux requires
FD counts. Default sampled host RSS is capped at 128 MiB, retained RSS growth at
64 MiB, Windows handles at 512 with retained growth of 128, and Linux FDs at 128
with retained growth of 32. These configurable ceilings are deliberately above
the observed fixture measurements; they are test limits, not product memory
guarantees. Maximum observed native worker concurrency must fit `--workers`.
Ten independent reporting/resource/deadline regressions include interruption,
missing measurements, exceeded ceilings, incomplete duration, timeout clamping
and rejection of a late successful response. The Windows sampler caches its
ctypes API and structure once; a regression checks that repeated sampling does
not retain new pointer types.

## October 11 baseline run

The 30-minute run started at **2026-10-11 19:13:13 UTC** with the optimized
`76ba445` binary. Its SDK was frozen from the working tree after an additional
SDK fix, so the label is `76ba445-binary-baseline-frozen-sdk`. The hashes below
identify the actual tested inputs; the label does not assert that all source
files are pristine copies of that commit.

This frozen baseline uses the earlier harness: it checks database, HTTP and
process/thread cleanup invariants, but its resource measurements are
**observation-only**. It does not contain the newer interruption, explicit
completion-duration or resource-ceiling gates. A successful baseline result must
therefore also have its actual elapsed duration and complete cleanup inspected;
it must not be cited as passing the newer resource release gate. The frozen
harness is retained in the run workspace even when the repository harness
changes.

The baseline's fixed six-second socket timeout was not clamped to the remaining
15-second logical retry budget, so a final in-progress attempt could exceed
that budget. Its latency clock was `monotonic` on Windows Python 3.12.10:
`GetTickCount64` with 15.625 ms resolution. Reported zero-millisecond attempts
mean they completed within a clock tick, not instantaneous requests. The
corrected candidate uses `QueryPerformanceCounter` here, with 0.1 microsecond
clock resolution; resolution is not a claim of measurement accuracy.

The earlier Windows sampler also defined a fresh ctypes memory structure per
sample. ctypes retained the resulting pointer types, so host RSS includes
observer allocation growth. An isolated 1,000-sample reproduction grew that
pointer cache by 1,000 entries and RSS by 8,781,824 bytes. Native child RSS is
sampled externally and does not include these host allocations. The corrected
sampler reuses one structure; baseline host RSS growth must not be attributed
solely to the SDK/application or used as leak-free evidence.

| Frozen input | SHA256 |
| --- | --- |
| Native binary | `b64d4a01864f5d4c4ced0f75155334ecb58d76750df78365bb301b95b308e4a4` |
| Harness | `e9698006dd2724590c24885f6e0db3b12d297dc653258e3222dc3d769a583345` |
| Python SDK | `e6ed319ff4fe021be53a49876ab2df05510d832bedf9545a9a95d5bd86486ed4` |
| Python HTTP host | `6ca8dc88a3d08d9d96ef4576c03eb6b467229a9233c95bae518964dfc19957c8` |
| Contacts app | `0e5ce19d5427241b414c1654b1ae5da06ef013df13d0dbc2659c4327f3867f7b` |

The report is `benchmarks/deployment-2026-10-11-windows.json`. The run is in
progress; completed duration, latency and resource observations will be added
after its final oracle and cleanup gates. Its workspace is
`D:/Codex/Kestrel/work/deployment-76ba445-30min-20261011`.

This exercise covers sustained local traffic, controlled SQLite contention,
data preservation across graceful restarts and worker cleanup. It does not
certify public deployment security, uninterrupted uptime, network conditions,
power loss, crash recovery during a commit, high availability, multi-host
database behavior, or a throughput/latency SLA. The separate workflow soak
documents application-key crash recovery; that property is not implied by this
HTTP test.
