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
October 12. Its running report is pending evidence. A 20.156-second candidate
smoke passed with 80 contacts and four cleanly stopped hosts, including all
completion, snapshot, resource and storage gates. Mutable working-tree tests do not count as a
single-build soak. See [deployment evidence](deployment-evidence.md).

The service/harness candidate `86ab3b4` passed all eight jobs in
[cross-platform CI](https://github.com/fizzexual/Sprout/actions/runs/38171134448),
including Windows/Linux/macOS native and SDK checks, WASM, sanitizers, Docker
and Paper. The subsequent Java-only Jackson dependency fix passed local Java,
Paper and packaged-host checks and requires its own final committed CI run.
The frozen HTTP/SQLite run retains the separately recorded native/Python inputs.

The review has reproduced these issues and fixes are under validation:

| Issue | Required behavior | State |
| --- | --- | --- |
| Deep/cyclic JSON can silently lose data | Reject before publishing a store; supported-depth values round-trip exactly | 13 Windows and Linux sanitizer regression tests passed |
| SDKs accept duplicate or non-finite worker JSON | Reject ambiguous keys, non-finite numbers and excessive nesting | Node/Go/.NET/Java local regressions passed; final CI pending |
| SDK strings differ from native text | Reject malformed wire text; accept valid Unicode pairs | Local SDK regressions passed; final CI pending |
| Shared input graphs expand before byte limits | Bound ordinary input preparation and serialized output across the SDKs | Node 24, Python 22, Go 11, .NET 8 and Java 31 local test groups passed |
| Java's pinned Jackson parser has current security advisories | Use the patched 2.21 line and verify early field-name limits and packaged dependencies | Jackson 2.21.7; Java 33 and Paper 20 tests, packaged native smoke and shaded dependency verification passed; [dependency evidence](dependency-security-2026-10-11.md); final CI pending |
| Native host accepts extra blank response lines | Exactly one JSON line with at most one terminal newline | 10 native ABI tests, with two Windows platform skips, passed |
| Node worker ignores graceful timeout termination | Force termination of the direct worker and recover the next request | Fix passed local test; POSIX CI validation pending |
| Paper reload snapshots accumulate | Delete inactive snapshots after all in-flight uses release them | Focused offline lifetime tests passed; final CI pending |
| Service shutdown can wait indefinitely for trickling readers | Bound total header/body read time, drain dispatched workers and separate writable state | Windows host/service 40 passed with one POSIX skip; Linux signal/read-deadline checks passed |
| Service binding waits on reverse DNS before reporting readiness | Bind using the literal address and retain an actual health/startup probe | Updated Windows suite: 42 tests, one platform skip; focused Linux checks and actual macOS CI service/startup/workload checks passed |
| Release workflow omits newer contract gates | Fail closed on contract failures and publish checksums and provenance | Workflow and thirteen manifest regressions passed locally, including exact installer payload; no release published |
| Development tags can become a stable Latest release | Mark prerelease tags as prereleases and prevent Latest publication | Workflow classification checked for stable, prerelease and build-metadata tags; no release published |

This is an independent agent review of other agents' code, not an external
professional audit. Sanitizer results and checks are reported for the exact
jobs that ran. A crash must never count as an expected input rejection.

## Release gates

- Cross-platform native, SDK, WASM, sanitizer and hardened Docker checks pass
  against the final commit. New regressions belong in CI and release checks.
- Immutable sustained-run reports record build/source/host hashes, duration,
  exact data oracles, contention and restart recovery, process exits and resource
  samples. Missing required platform metrics and exhausted retries fail the run.
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
