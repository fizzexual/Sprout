# Local deployment evidence

`tools/deployment_soak.py` runs a duration-based HTTP/SQLite exercise using a
frozen native interpreter, Python SDK, HTTP host, contacts app and harness. Each
input is copied into a new workspace and hashed before traffic starts; the final
success gate verifies those copies again. A running report has `passed: null`;
only a finished report with `passed: true` represents completed evidence.
Older frozen harnesses also need an independent coverage review: elapsed time
alone does not establish that traffic continued throughout the requested run.

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

Future-run cadence evidence uses both `monotonic` and wall-clock `time` readings.
The controller keeps an initial progress point, observes completed bursts, and
checks the pending gap during pacing and before final completion. Pacing polls
do not reset the last completed burst. Each host observes sampler captures,
including the final shutdown capture. The report retains only checkpoint counts,
first/last readings, last observed readings and maximum gaps for each clock;
it does not retain an ever-growing timestamp array.
The traffic start and deadline are anchored to that initial checkpoint before
opening the expected-data oracle, so a long setup pause also fails the guard.

`--max-gap-seconds` defaults to 60 seconds and must be finite and positive.
Either clock exceeding this controller progress or sampler gap, missing or
nonfinite readings, and backward clocks fail the run. The default leaves room
for legitimate combined restart, startup and request budgets; it is a test
coverage policy, not a service latency SLA. Planned `--burst / --rate` pacing
must fit the configured gap. Slower intentional traffic requires an explicitly
larger limit, which changes the scope of the evidence. Polling checks pending
gaps at most every 250 ms while pacing; blocking operations are checked at their
next progress boundary.

Newer runs retain their absolute monotonic start, nominal deadline, validated
deadline and observed traffic finish. When floating-point addition followed by
subtraction would encode less than the requested duration, the validated
deadline advances to the next representable value and the final pacing wait
actually reaches it. The raw measured duration must still meet the request;
completion also requires the observed finish to reach that exact deadline.
There is no duration tolerance or retrospective correction of older reports.

Periodic health probes retain their scheduled ten-second phase and also run
when due during traffic pacing. A delayed probe skips missed slots instead of
inventing catch-up counts. Each successful actual periodic request earns one
count; startup probes remain separate. New completion checks require at least
95% of requested contacts and 90% of nominal health and contention probes.
These are the existing coverage floors; the frozen v2 policy is unchanged.
Health activity does not reset the completed-burst cadence baseline.
Contact pacing derives deadlines from cumulative work at a fixed clock anchor,
avoiding repeated fractional-addition drift. Slow operations rebase that anchor
to their actual completion time rather than submitting an accumulated backlog.

Checking wall time alongside monotonic time detects suspension when a platform's
monotonic clock omits time asleep. This is deliberately conservative: a backward
wall-clock adjustment, or a forward adjustment large enough to exceed the gap,
also disqualifies the run even if the application remained healthy. These
observations bound recorded progress gaps; they do not establish uninterrupted
request traffic, capture every native resource peak or certify uptime.

## Run it

Use a new workspace for every run. Nothing is exposed beyond loopback, and the
fixture writes only inside that workspace.

```powershell
python tools/deployment_soak.py src/sprout.exe --duration-seconds 1800 --workspace D:/Codex/Kestrel/work/deployment-30min-NEW --report benchmarks/deployment-NEW.json
python tools/deployment_soak.py src/sprout.exe --duration-seconds 28800 --workspace D:/Codex/Kestrel/work/deployment-8hr-NEW --report D:/Codex/Kestrel/work/deployment-8hr-NEW.json --stop-file D:/Codex/Kestrel/work/deployment-8hr-NEW/STOP
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

For an unattended run, `--stop-file` names an initially absent control path.
Creating that path requests cancellation; its contents are not interpreted.
The controller checks it before launching a host, between completed traffic
bursts and at most every 250 ms while pacing. An already dispatched burst is
allowed to finish within its logical request budgets before the controller
verifies the partial dataset and sends `STOP` to its owned host. Host shutdown
then drains accepted requests and checks native exits and the final thread
count. Cancellation records `state: interrupted`, `passed: false` and
`workload_completed: false`; it never becomes completed duration evidence.
An inaccessible control path also fails closed. Keep the control path outside
the frozen input tree so cancellation does not alter the tested source hashes.
Completed and interrupted private reports can be reviewed before publishing
them as evidence. A controller killed externally cannot perform these gates;
its partial report requires a separate, explicitly recorded cleanup review.

The current harness also rejects interrupted or incomplete runs, requires the
requested traffic duration and final snapshot verification, and applies resource
gates after every service epoch. Host initial/final/maximum RSS and thread
measurements are required; Windows also requires handle counts and Linux requires
FD counts. Default sampled host RSS is capped at 128 MiB, retained RSS growth at
64 MiB, Windows handles at 512 with retained growth of 128, and Linux FDs at 128
with retained growth of 32. These configurable ceilings are deliberately above
the observed fixture measurements; they are test limits, not product memory
guarantees. Maximum observed native worker concurrency must fit `--workers`.
Twenty-nine independent reporting/resource/deadline/storage/control regressions include interruption,
missing measurements, exceeded ceilings, incomplete duration, timeout clamping
and rejection of a late successful response, preexisting stop controls that
prevent host launch, inaccessible controls and cancellation during pacing.
Cadence regressions include a real SQLite oracle with bounded fake clocks and
transport: the older frozen harness passes an eight-hour request after one
eight-contact burst when the first pacing sleep advances by 28,801 seconds;
the new harness rejects the identical workload specifically for its controller
gap, with valid sampler telemetry and owned cleanup. A wall-only jump also
fails, while normal paced bursts and 45-second operations pass. Separate tests
cover backward clocks, missing/nonfinite readings, final sampler coverage and
JSON reports that contain no NaN or Infinity after a clock failure.
Actual controller-path fixtures check excessive and healthy oracle setup and
an explicitly enlarged limit for intentionally slow pacing.
The Windows sampler caches its
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

## Candidate controls and original run outcome

The later operational candidate `d5ded754726bfe87ba12517630df9a62d179ba6e`
passed a separate 20.000-second native/SDK smoke (20.188 seconds through final
verification): 80 exact contacts, three clean hosts, three lock recoveries and
six oracles. All 89 native children exited and every host returned to one thread.
The maximum recorded controller gap was below 3.477 seconds on either clock;
the maximum host sampler gap was below 0.142 seconds. Completion, cadence,
resource/storage and independent read-only SQLite value/integrity checks passed.
Owned process command lines were checked after a numeric PID was reused by the
older run; no unrelated process was signaled.

| Operational smoke input | SHA256 |
| --- | --- |
| Windows native | `066095edef005a511b1e89e0351f2099edcce5ea5fafce1e89425ebc639c725f` |
| Harness | `3fcb9d093e0ec66f6829aa8ec278f297214d897a21c6c197b292ac3d45898cd7` |
| Python SDK | `8e6b7f72eb243c91a82537d3dc05fd1b5cdae127d940797b111fc3ae8a154192` |
| Python HTTP host | `326e5b35929ae1f9340a45612af201dfacf7f339883f391fef6333a75c3aa4e4` |
| Contacts app | `0e5ce19d5427241b414c1654b1ae5da06ef013df13d0dbc2659c4327f3867f7b` |

All copied source files matched candidate Git blobs and all five frozen inputs
were unchanged. The native source checkout digest is
`698ba61085fc9e59eb7e54638ba4df3416e30063d334e4a17cf205fe8b8c4e7b`;
normalizing its CRLF endings to LF equals the exact Git blob digest
`fb2a8f8da6d2d2cefc9acc958513f4dfd3efdf85796e32c53bd50e6c86747749`.
This is source correspondence, not a reproducible-build attestation.
Private results are `D:/Codex/Kestrel/work/deployment-d5ded75-smoke-20261012.json`
and its separate `deployment-d5ded75-smoke-20261012-verification.json`.
These newer native/SDK inputs differ from the original eight-hour run below;
this short check does not qualify them for eight hours.

The later cadence candidate `fbd795d54eb7bdf829ba23015f048b18096b1f27`
passed all eight [native/SDK, WASM, sanitizer, Docker and Paper CI jobs](https://github.com/fizzexual/Sprout/actions/runs/38177615020)
and one real native loopback smoke: 20.000 seconds of traffic, 20.110 seconds
including final checks, 80 exact contacts, three clean hosts, three lock
recoveries and six independent oracles. All 89 native children exited and every
host returned to one thread. The largest recorded controller gap was 3.313
seconds on the monotonic clock and 3.311 seconds on wall time; the host sampler
gap was below 0.111 seconds. Completion, cadence, resource and storage gates
passed. An additional read-only SQLite check matched every expected row and
returned `integrity_check: ok`.

Its harness SHA256 is
`3fcb9d093e0ec66f6829aa8ec278f297214d897a21c6c197b292ac3d45898cd7`.
The other four input hashes match the frozen `86ab3b4` inventory below; all five
were unchanged at completion and all four source files matched candidate Git
blobs. The private report is
`D:/Codex/Kestrel/work/deployment-fbd795d-smoke-20261011.json`, with a separate
`deployment-fbd795d-smoke-20261011-verification.json` record. This short run
verifies guard mechanics and cleanup; it is not an eight-hour qualification.

The `86ab3b4b0e6606a6d74a2e930483f5773ed84f6c` candidate passed a real
stop-file cancellation check after 80 contacts and ten traffic bursts. The
report recorded `interrupted`, `passed: false`, `workload_completed: false`
and `partial_dataset_verified: true`; the only error was the requested
cancellation. Its host reaped all 83 native children and returned to one
thread. A separate 20.156-second completion check passed with 80 contacts,
four clean host lifecycles, three lock recoveries and eight independent data
checks. These private smoke reports verify control mechanics, not sustained
deployment readiness.

The earlier `3f656ae` eight-hour attempt was deliberately superseded before
completion. Its exact owned controller was stopped, its host shut down through
the control-pipe EOF cleanup path, and all eight host summaries showed native
exit accounting and final thread cleanup. An independent final SQLite check
found 4,960 stored contacts matching their scheduled values. The private report
and separate manual-interruption record preserve it as interrupted evidence;
it must not be presented as an eight-hour pass.

The replacement eight-hour run started at **2026-10-11 20:14:15 UTC**, with a
target end of **2026-10-12 04:14:15 UTC**. Its source hashes were independently
compared with the Git blobs of the full `86ab3b4` commit. The workspace is
`D:/Codex/Kestrel/work/deployment-86ab3b4-8h-20261011`; its final failed report remains
private at `D:/Codex/Kestrel/work/deployment-86ab3b4-8h-20261011.json`. A dedicated
`STOP` control path can interrupt it without changing frozen source files.
Its frozen harness predates the dual-clock cadence guard. Its inputs and report
remain unchanged. Successful completion additionally requires a separate final
audit of traffic volume, probe counts, epoch durations and sample coverage.
The [v2 aggregate policy](deployment-coverage.md) was declared at 21:41:33 UTC,
before the run finishes, with SHA256
`e0fa18931226ba2c181d2700dea0da3e91fc9cba878c551232298cb9342bd0ee`.
Aggregate metrics can disqualify gross gaps but cannot reconstruct the largest
traffic gap; this run cannot be described as passing the newer cadence gate.

| Frozen input | SHA256 |
| --- | --- |
| Native binary | `b387bdbc62da7ac777209bfd1b7e0630de65d0c0da1a09380bf5382af624341f` |
| Harness | `a0bad015faf1384a61ad8e2c3f4363a5d0cd1321989c00418d8390c687e0340a` |
| Python SDK | `fe1c07db6982c88356b9c4942899ef0e6e13ee27d2b671bd500f2a4220af34a8` |
| Python HTTP host | `326e5b35929ae1f9340a45612af201dfacf7f339883f391fef6333a75c3aa4e4` |
| Contacts app | `0e5ce19d5427241b414c1654b1ae5da06ef013df13d0dbc2659c4327f3867f7b` |

At the first completed restart, the service retained 728 contacts, reaped all
745 native children and returned to one Python thread. Sampled host RSS peaked
at 33,546,240 bytes; retained RSS growth was 2,174,976 bytes. Handles peaked at
244 and ended at 150, compared with 140 initially. At the 192.157-second
progress snapshot, 776 contacts and four lock recoveries had completed with no
errors. These initial observations do not establish full-duration resource
stability or uptime.

The final report was **failed and unqualified**, with SHA256
`71b549a9ae1e526585def16996e4f0cd8868d2e60ccbe93ff97dfc1c51045fb8`.
It completed 115,200 contacts and 173 host lifecycles, but recorded traffic
duration `28799.999999999993` against 28,800 seconds. The final elapsed duration,
including checks and shutdown, was `28800.344000000005`. A deterministic
arithmetic reproduction shows that subtracting a fractional start from its
computed absolute deadline can encode a slightly smaller duration; the original
failed report is retained without changing its result. Its 2,572 health probes
also missed the predeclared 2,592 minimum. Startup health requests are not added
retroactively to that count.

The fixed v2 auditor returned `invalid_report` because original `passed` was
false. The private final qualification checker rejected the unsuccessful report
without producing a final qualification artifact. A separate read-only failed-run
diagnostic verified every exact expected row across 58 retained shards, unique
positive IDs and emails, SQLite integrity, all 117,933 native starts/exits,
173 host metrics files, final one-thread baselines and absence of owned processes.
It independently matched all frozen hashes and source Git blobs and confirmed
the resource/storage limits. The maximum sampled RSS was 34,988,032 bytes,
retained RSS growth at most 4,071,424 bytes, and handles at most 244 with retained
growth at most ten. These are diagnostic observations of a failed run, not
successful eight-hour coverage, maximum-gap evidence or uptime certification.
The separate private record is
`D:/Codex/Kestrel/work/deployment-86ab3b4-8h-20261011-failure-independent-review.json`.

This exercise covers sustained local traffic, controlled SQLite contention,
data preservation across graceful restarts and worker cleanup. It does not
certify public deployment security, uninterrupted uptime, network conditions,
power loss, crash recovery during a commit, high availability, multi-host
database behavior, or a throughput/latency SLA. The separate workflow soak
documents application-key crash recovery; that property is not implied by this
HTTP test.
