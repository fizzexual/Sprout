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
Twelve independent reporting/resource/deadline/storage regressions include interruption,
missing measurements, exceeded ceilings, incomplete duration, timeout clamping
and rejection of a late successful response. The Windows sampler caches its
ctypes API and structure once; a regression checks that repeated sampling does
not retain new pointer types.

Storage is measured on progress saves and at successful completion. Defaults
are 256 MiB for the workspace and 4 MiB for one report; `--max-workspace-mib`
and `--max-report-mib` configure these limits. Crossing a threshold stops the
test and preserves a failed report. These are periodic detection thresholds,
not filesystem allocation quotas: traffic between checks and the final failure
report can cause bounded overshoot. Shard databases, the expected-data oracle,
frozen files and host metrics are all counted. At 28 minutes, the baseline
workspace occupied about 3.2 MB and its report about 14.6 kB. The default
eight-hour workload has about 115,000 contacts, 58 shards and 160 process epochs;
the 256 MiB workspace limit leaves substantial room above that measured rate
of growth.

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

The completed report is `benchmarks/deployment-2026-10-11-windows.json`. The run
finished successfully in **1,800.188 seconds**, with **zero invariant failures**.
It completed 7,168 exact contacts in 896 bursts, 172 health checks, 81 independent
database/HTTP checks, 29 exclusive-lock 503/recovery probes and 59 duplicate-email
409 checks. Eleven independent service processes started and stopped cleanly;
7,351 native interpreter starts matched 7,351 exits, with at most four active
native workers. Every service returned to one Python thread.

All four retained databases matched the independent expected-data oracle again
after completion: 2,000, 2,000, 2,000 and 1,168 rows respectively, each with
`integrity_check: ok`. The final frozen hashes matched the initial snapshot.
The workspace is `D:/Codex/Kestrel/work/deployment-76ba445-30min-20261011`.

Concurrent contact traffic made 19,135 POST attempts: 7,168 successful 201s,
11,119 retryable 503s and 848 transport failures (835 connection aborts and 13
resets). All contacts recovered within the retry bounds, with no ambiguous
committed-write 409 observed. The 503 total combines capacity and application
database-busy responses; forced lock probes are counted separately.

Logical-contact p50/p95/maximum latency was **110/235/7,094 ms**, including retries
and backoff. POST-attempt p50/p95/maximum was **0/94/2,094 ms**, including fast
rejections and transport failures. The baseline clock limitation above applies
to those figures; zero means below its tick resolution.

There were 16,716 resource samples. Sampled host RSS reached 51,990,528 bytes
(49.6 MiB), and maximum retained RSS growth in one epoch was 21,577,728 bytes
(20.6 MiB), including the disclosed observer allocation. Sampled native child
RSS reached 9,068,544 bytes (8.65 MiB). Host handles peaked at 288 and ended at
190–193 per epoch, compared with 140 initially. Python threads peaked at 19 and
returned to one. These observations were not produced under the newer
resource-ceiling gate and do not establish uninterrupted process memory
stability.

## Corrected candidate smoke

After the baseline exited, a 20.141-second local smoke exercised the corrected
harness against the `1cb378b` candidate binary beginning `b387bdbc62da7ac7` and
its frozen SDK/server. It passed with 80 contacts, five clean service processes,
three lock recoveries and ten independent data checks. Completion-duration,
snapshot, native/thread cleanup, required resource measurements and configured
resource/storage ceilings all passed. Its report is retained outside published
long-run evidence at
`D:/Codex/Kestrel/work/deployment-candidate-smoke-20261011-final.json`. This smoke
validates harness mechanics; hours-long candidate evidence remains pending.

This exercise covers sustained local traffic, controlled SQLite contention,
data preservation across graceful restarts and worker cleanup. It does not
certify public deployment security, uninterrupted uptime, network conditions,
power loss, crash recovery during a commit, high availability, multi-host
database behavior, or a throughput/latency SLA. The separate workflow soak
documents application-key crash recovery; that property is not implied by this
HTTP test.
