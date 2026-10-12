# Production readiness gates

Sprout is currently `0.2.0-dev`. Readiness is assessed for a supported workload
and an exact build, rather than for every possible use of the language.

The initial supported profiles are trusted CLI automation, bounded application
rules through the host SDKs, checkpointed native workflows, and private
HTTP/SQLite applications behind the application's TLS and authentication layer.
Sandbox flags are capability restrictions, not an OS security boundary.

## Evidence and work in progress

The baseline is commit `76ba445adfb19cfb113c0624c56a3fec176873fa`, with Windows
binary SHA-256 `b64d4a01864f5d4c4ced0f75155334ecb58d76750df78365bb301b95b308e4a4`.
Its [native, sanitizer, SDK, Docker and Paper adapter CI](https://github.com/fizzexual/Sprout/actions/runs/38165530185)
and [WASM CI](https://github.com/fizzexual/Sprout/actions/runs/38165532282) passed.
The bounded [workload reports](soak-evidence.md) cover 50 lifecycle cycles and
200 contacts; they establish neither overnight stability nor arbitrary capacity.

On 2026-10-11, separate engineering agents resumed sustained deployment testing,
native data/runtime review, and service/SDK review. A new duration-based harness
freezes the interpreter, worker source and Python host
files, restarts service processes, induces bounded SQLite contention, measures
resources, and compares HTTP and database results with an independent oracle.
The thirty-minute frozen baseline run started at 19:13 UTC, with separately
recorded SDK/server hashes. It completed in 1,800.188 seconds with 7,168 contacts,
81 independent oracle checks, 29 contention recoveries, 59 duplicate checks and
11 cleanly stopped service epochs. Frozen inputs were unchanged and no invariant
errors were recorded in the [completed report](../benchmarks/deployment-2026-10-11-windows.json).
Its resource samples are observations; the corrected candidate harness also
enforces resource ceilings and rejects interrupted/incomplete runs. The first
candidate run was superseded after the service startup fix and retained as
interrupted evidence, with 4,960 exact contacts and verified owned-process cleanup.
The replacement eight-hour HTTP/SQLite run started at 20:14 UTC on frozen
`86ab3b4b0e6606a6d74a2e930483f5773ed84f6c` inputs, targeting 04:14 UTC on
October 12. It finished with failed qualification; the final findings are recorded
below. A 20.156-second candidate
smoke passed with 80 contacts and four cleanly stopped hosts, including all
completion, snapshot, resource and storage gates. Mutable working-tree tests do not count as a
single-build soak. See [deployment evidence](deployment-evidence.md).

The final security candidate `7902a5384a8fb81c74c5a08539cfa26bba1940ca` passed all
eight jobs in [cross-platform CI](https://github.com/fizzexual/Sprout/actions/runs/38171815745),
including Windows/Linux/macOS native and SDK checks, WASM, sanitizers, Docker
and Paper with the patched Jackson dependency. Its native/Python/harness sources
match the preceding `86ab3b4` service candidate, whose
[full CI](https://github.com/fizzexual/Sprout/actions/runs/38171134448) also passed.
The frozen HTTP/SQLite run retains the separately recorded native/Python inputs.
Evidence-only documentation commits do not change tested inputs. The separate
cadence and coverage candidate `fbd795d54eb7bdf829ba23015f048b18096b1f27`
passed all eight jobs in [fresh CI](https://github.com/fizzexual/Sprout/actions/runs/38177615020).
Its 20.000-second real native smoke passed with 80 exact contacts, three clean
hosts, all 89 native children exited and independently checked SQLite integrity.
It does not change the native interpreter or Python service/SDK sources.

A later evidence review reproduced a false pass in the frozen deployment
harness: advancing the clock by eight hours after one burst could satisfy its
duration check with only eight contacts. This finding concerns the test evidence,
not a reproduced service failure. The frozen run remains unchanged. Its
completion requires a separate [aggregate coverage audit](deployment-coverage.md)
under thresholds declared before the run finished; the original `passed` field
alone is insufficient. Newer harness runs record bounded controller and sampler
gaps in both monotonic and wall time and reject clock reversals or nonfinite
readings. The existing frozen run cannot establish a maximum traffic gap.

The October 12 operational review reproduced data loss when an existing store
could not be read, a leaked Python worker after I/O thread startup failed, and
a deployment mismatch where Compose fetched moving `main` sources while CI
tested a local image. The fixes fail closed on store read errors, clean up
partially started workers, and build the checkout through the actual loopback
Compose configuration. The integrated `d5ded754726bfe87ba12517630df9a62d179ba6e`
candidate passed all eight [CI jobs](https://github.com/fizzexual/Sprout/actions/runs/38181964754),
after one macOS rerun. The initial macOS .NET positive control failed with an
unexplained native startup error; a same-commit rerun passed. A separate bounded
Linux backend control passed 32 launches with complete child reaping. No
production ordering defect was substantiated and no budgets or statuses were
waived. Test-only diagnostics now identify the control, native status/system
code and elapsed time. The diagnostic/evidence revision
`adb2c25ede6e8215b256970ca14ef892673a1803` passed all eight
[fresh CI jobs](https://github.com/fizzexual/Sprout/actions/runs/38183104346)
on its first attempt; the earlier unexplained observation remains recorded.

A 20.000-second integrated native/SDK smoke passed with 80 exact contacts,
three clean service lifecycles, all 89 native workers exited and independent
SQLite integrity/value checks. The frozen `86ab3b4` eight-hour run
finished without qualification and cannot be attributed to these newer native/SDK fixes.
The existing Windows installation was updated to the tested normal binary
SHA256 `066095edef005a511b1e89e0351f2099edcce5ea5fafce1e89425ebc639c725f`.
Its installed copy passed the seven publication regression methods, with two
POSIX-only skips. It still reports `0.2.0-dev`; no stable release was published.

The original eight-hour report recorded `passed: false`: subtracting its
floating-point clock readings produced `28799.999999999993` seconds against a
28,800-second requirement. A bounded arithmetic reproduction shows that an
endpoint exactly equal to the computed absolute deadline can produce that
subtraction result. Independently, its 2,572 health probes missed the unchanged
2,592-probe coverage floor. Neither finding is waived. The fixed v2 auditor
rejected the failed report, and the final qualification checker refused it.
A separate read-only diagnostic verified all 115,200 exact contacts across
58 SQLite shards, all 117,933 native worker exits, 173 clean host lifecycles,
trusted frozen hashes and recorded resource/storage limits. This supports data
and cleanup observations; it does not qualify the original sustained run.

The corrected harness reaches a validated absolute deadline, retains the raw
measured duration, keeps actual health probes on their original phase, and
derives contact pacing from cumulative work to avoid an extra terminal burst.
It also enforces the existing 95% contact and 90% health/contention floors at
completion. All 40 focused harness regressions passed on Windows and Linux,
including genuine early-finish, failed-probe, missed-slot and fractional-rate
controls. The unchanged v2 auditor's 17 checks passed locally with one Windows
symlink skip. Full CI and a separate sustained run of the changed candidate
remain required before final workload qualification.

The intermediate `3814a48` native smoke also remained failed: its five actual
SQLite lock probes missed the six required by the 20-second/three-second
configuration. Independent checks verified its 80 exact rows, all 95 native
worker exits and timer/hash/resource limits. The subsequent correction anchors
contention probes to their scheduled phase as well, with actual request counts
checked by regressions. Failed smoke evidence is retained.

That intermediate candidate's [CI](https://github.com/fizzexual/Sprout/actions/runs/38205108189)
passed seven jobs but failed the macOS Python output-limit recovery test:
process-group `SIGKILL` returned `EPERM`, and cleanup raised before killing and
reaping the owned direct worker. The corrected SDK retains the request's
original failure code and exit status, reaps that worker, and records group
denial through immutable `cleanup_errors`; descendant termination remains
unconfirmed. Bounded live-worker controls cover output caps, cancellation,
timeouts, failed initialization, interrupts and next-request recovery. The
platform cause of that macOS denial is still unknown and is separate from the
earlier unexplained .NET startup observation. No failed job was rerun or marked
successful.

The integrated Windows Python suite passed 50 tests with one POSIX skip.
The Linux SDK/service suite passed 49 tests on its separately hashed existing
native fixture; three updated service transport controls also passed on Linux.
Those controls require complete header-only 413 JSON, retain an actual oversized
body request, and accept only reset/abort closure for unread rejected input while
requiring the actual 413 decision, no dispatch and native request recovery.
Trickling-input deadline assertions remain unchanged. The earlier two Windows
socket errors are preserved; no production service source was changed.

The `5d55dc8` real-native smoke passed: 80 exact contacts, seven actual lock
probes, five clean host lifecycles and all 97 native workers exited. Its timer,
cadence, source hashes, resource/storage limits and SQLite oracle were checked
independently. Its [macOS CI](https://github.com/fizzexual/Sprout/actions/runs/38206803609)
passed the cleanup controls and stopped on a test that expected the literal
413 reason phrase `Request Entity Too Large`; the observed Python 3.14.7 response
was a complete 413 `Content Too Large` response with the expected JSON body.
The follow-on correction checks the numeric status and response framing,
preserving JSON, no-dispatch, recovery and deadline assertions. Five focused
controls passed on Windows and Linux. Reason text is descriptive rather than a
reliable protocol field. [RFC 9112, section 4](https://www.rfc-editor.org/rfc/rfc9112.html#section-4)
describes the status-line contract. Runtime, SDK and harness inputs are unchanged
by this test-only correction; final full CI remains required.

The final test revision `d9c869895f34bed0d25bc1fed583570a7c187736` passed all
eight [fresh CI jobs](https://github.com/fizzexual/Sprout/actions/runs/38207716585)
on its first attempt. Its five measured deployment inputs match the passed
`5d55dc8` smoke exactly; that report retains its original commit attribution.
The separate final eight-hour run started at **2026-10-12 05:31:52 UTC** but
failed after **1,115.532 seconds**. Windows event logs confirm that time
synchronization moved the wall clock backward by **2.5843477 seconds**. Both
the controller and host sampler correctly rejected this under the unchanged
policy. The original report remains failed, the v2 audit rejected it, and the
strict final checker refused qualification. No restart or clock-setting change
was made.

A separate read-only diagnostic verified all 4,464 exact contacts across three
shards, all 4,570 native worker exits, seven physical host cleanups and unchanged
frozen/source/build hashes. The report retained six host summaries because its
failed-exit check discarded the available seventh summary. That host returned
to one thread, but the clock failure also prevented its final resource capture;
its earlier sample is not a final resource gate. New reporting corrections retain
available failed-host metrics and the first offending clock readings without
granting successful-close credit or relaxing the checks. All 49 focused harness
regressions passed on Windows and an offline Linux fixture; fresh cross-platform
CI remains required. Eight-hour qualification remains open and
requires an agreed stable-clock test environment; passing data checks cannot
replace it. The original failed runs retain their original results.

The review reproduced these issues and verified their fixes:

| Issue | Required behavior | State |
| --- | --- | --- |
| Deep/cyclic JSON can silently lose data | Reject before publishing a store; supported-depth values round-trip exactly | 13 Windows and Linux sanitizer regression tests passed |
| SDKs accept duplicate or non-finite worker JSON | Reject ambiguous keys, non-finite numbers and excessive nesting | Local regressions and final cross-platform CI passed |
| SDK strings differ from native text | Reject malformed wire text; accept valid Unicode pairs | Local regressions and final cross-platform CI passed |
| Shared input graphs expand before byte limits | Bound ordinary input preparation and serialized output across the SDKs | Node 24, Python host 22, Go 11, .NET 8 and Java 33 tests/groups passed; final CI passed |
| Java's pinned Jackson parser has current security advisories | Use the patched 2.21 line and verify early field-name limits and packaged dependencies | Jackson 2.21.7; Java 33 and Paper 20 tests, packaged native smoke, shaded verification and final CI passed; [dependency evidence](dependency-security-2026-10-11.md) |
| Native host accepts extra blank response lines | Exactly one JSON line with at most one terminal newline | 10 native ABI tests, with two Windows platform skips, passed |
| Node worker ignores graceful timeout termination | Force termination of the direct worker and recover the next request | Local and final Windows/POSIX CI passed |
| Paper reload snapshots accumulate | Delete inactive snapshots after all in-flight uses release them | Focused offline lifetime tests and final Paper CI passed |
| Service shutdown can wait indefinitely for trickling readers | Bound total header/body read time, drain dispatched workers and separate writable state | Python host/service suite has 42 tests, one Windows POSIX skip; local Linux and final platform CI passed |
| Service binding waits on reverse DNS before reporting readiness | Bind using the literal address and retain an actual health/startup probe | Updated Windows suite: 42 tests, one platform skip; focused Linux checks and actual macOS CI service/startup/workload checks passed |
| Release workflow omits newer contract gates | Fail closed on contract failures and publish checksums and provenance | Workflow and thirteen manifest regressions passed locally, including exact installer payload; no release published |
| Development tags can become a stable Latest release | Mark prerelease tags as prereleases and prevent Latest publication | Workflow classification checked for stable, prerelease and build-metadata tags; no release published |
| Elapsed time can falsely satisfy a sustained-run gate | Record bounded dual-clock controller/sampler progress from setup through cleanup | 29 focused local harness regressions, real native smoke and fresh cross-platform CI passed |
| Short host epochs can evade per-epoch sampling coverage | Require predeclared aggregate traffic, host-time and sample coverage, with exact lifecycle/data accounting | Auditor v2: 17 focused tests, one local Windows symlink skip; Linux and fresh cross-platform CI passed |
| An unreadable store is treated as empty and overwritten | Only an absent-path open initializes empty; later read errors preserve bytes and raise `io` | Publication and portable read/seek/close fault regressions passed on Windows/Linux; integrated d5 CI passed |
| Python cannot start I/O threads after launching a worker | Reap the owned worker, close available pipes, preserve interrupts and recover | Five lifecycle regressions and 47 combined Windows checks, one POSIX skip; integrated d5 CI passed |
| Compose deploys different source and exposes all interfaces | Build the reviewed checkout, publish loopback, and exercise shipped Compose in CI | Actual local Compose limits, output/recovery/cleanup checks and integrated d5 CI passed |

This is an independent agent review of other agents' code, not an external
professional audit. Sanitizer results and checks are reported for the exact
jobs that ran. A crash must never count as an expected input rejection.

## Release gates

- Cross-platform native, SDK, WASM, sanitizer and hardened Docker checks pass
  against the final commit. New regressions belong in CI and release checks.
- Immutable sustained-run reports record build/source/host hashes, duration,
  exact data oracles, contention and restart recovery, process exits and resource
  samples. Missing required platform metrics and exhausted retries fail the run.
  Duration must be supported by workload and sampling coverage. The existing
  frozen eight-hour profile additionally requires its separate predeclared
  aggregate qualification; newer runs require recorded controller/sampler gaps.
  If native or SDK source changes during a frozen run, retain that result under
  its original hashes and collect separate evidence for the changed candidate.
- Security findings have reproductions, fixes and regression evidence. Known
  deployment limits are documented, including descendant cleanup, memory
  boundaries, host authentication, data-file concurrency and filesystem behavior.
- Release artifacts have checksums and source provenance, all required files
  exist, and installed binaries match the reviewed build. No development binary
  is relabeled as a stable release to bypass evidence.
- Public data/SDK contracts, compatibility changes, storage behavior and upgrade
  instructions agree with the implementation and tested deployment profile.

Live Paper server testing still requires the server owner's Minecraft EULA
acceptance. Compiled adapter/JAR tests do not establish live server readiness.
Public hosting, paid infrastructure and a production release are separate
deployment decisions.

An hourly follow-up in the current chat checks active tests and this ledger,
continues authorized fixes, and reports meaningful changes. Stop requests take
precedence. Host-local run manifests and logs live under the workspace `work`
directory; they must be checked before starting duplicate long-running tests.
