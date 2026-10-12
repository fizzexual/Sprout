# Host protocol and deployment review — 2026-10-11

This is an internal engineering review of repository code and private fixtures,
not a formal security audit or certification. No public service, release tag,
Minecraft server, public certificate issuance, or system service installation was performed.
The production decision remains workload-specific; see
[production readiness](production-readiness.md), [deployment examples](../deploy/README.md),
and [release gates](releases.md).

## Findings and corrections

| Reproduction | Correction and regression evidence |
| --- | --- |
| A worker emitted `{"allow":false,"allow":true}` or its escaped-key equivalent, changing the decision when a permissive decoder kept the last key. | Python/Node/Go/.NET/Java reject duplicate decoded keys. Nested and escaped variants are tested with an independent raw worker or native `show`, followed by a healthy request. |
| Output contained `1e999`, a 129th empty container, NUL, or a lone escaped surrogate. Some host parsers normalized or accepted these values. | Host input/output checks reject non-finite numbers, excess nesting, and text outside the native Unicode scalar/non-NUL contract. Valid surrogate pairs, literal backslash-u text, U+FFFD, and ordinary large finite numbers remain accepted. |
| Go invalid UTF-8 and .NET lone UTF-16 surrogates could be replaced by the serializer before validation. | Plain request strings and keys are validated before normal serialization; the actual encoded wire is checked too. Application serialization callbacks remain responsible for their transformations. |
| Native C framing removed arbitrary leading/trailing newlines, accepting extra blank response lines. | It strips at most one optional LF/CRLF terminator and horizontal whitespace. Extra CR/LF is rejected. The Go copy is synchronized and its source-equality test passes. |
| A Node fixture ignored SIGTERM and would write a delayed marker after the host deadline. | Timeout forcibly terminates the direct worker. The test observes startup, waits past the delayed effect, verifies no marker, and runs a healthy request afterward. It passes on Linux and Windows. |
| Paper accumulated snapshots after successful reloads. Deleting immediately would instead invalidate queued/running readers. | Snapshot leases now retain immutable files until actual work finishes, including work that ignores interruption. Superseded/rejected/stale preparations and canceled queued work release files. Tests cover 40 reloads, stale ordering, in-flight replacement, close and queued cancellation. |
| A small shared host graph expanded past its request cap before Go/Java/.NET applied the cap to a completed serialization. | Go applies byte and traversal budgets before ordinary serialization; Java budgets each subtree use and writes to a capped stream; .NET writes through a capped stream and checks ordinary text/DOM values. Regressions observe that an oversized alias request never serializes a trailing callback or materializes the full Java root. Exact ASCII and UTF-8 request boundaries have positive controls. |
| A supervisor working directory did not override the Python worker's source-directory cwd, preventing relative SQLite writes beside immutable installed source. | The bridge accepts an explicit existing state directory. The unit uses `--cwd /var/lib/sprout`; a live test verifies database data stays outside the source directory. |
| A client could keep a socket read alive by sending one byte before each timeout. | Header and body reads now share an absolute deadline; buffered bytes cannot bypass the pre-dispatch check. Regression clients trickle headers and bodies, observe bounded closure, and verify the native worker is never launched. Shutdown drains accepted workers. |
| The inherited HTTP server constructor performs reverse DNS before publishing readiness, outside the worker deadline. | Binding uses the literal address and port. A constructor regression makes any reverse DNS call fail; the POSIX CLI test still requires actual health readiness and SIGTERM drain, with bounded failure stack diagnostics. Actual macOS CI startup and HTTP workload checks passed. |
| A development tag would default to a stable GitHub release and could become Latest. | Publication explicitly marks prerelease tags and excludes them from Latest, distinguishing hyphens in build metadata. No release was published. |
| Java's pinned Jackson 2.21.2 character parser buffered an entire oversized name before enforcing its limit. | Jackson 2.21.7 rejects earlier; a bounded reader regression fails on the old pin and passes patched, followed by a real SDK rejection/recovery check. Java 33 and Paper 20 tests plus packaged native smoke passed; shaded core/databind versions were verified. See the [dependency review](dependency-security-2026-10-11.md) for advisory scope and sources. |

Native C validates UTF-8, line framing and byte/lifecycle limits. Its caller must
parse JSON and validate the schema. Go/.NET/Java/Node keep version 1 exact-value
tags as explicit objects; Python's codec interprets and validates them. Ordinary
finite JSON numbers are not all int64 values: rejecting every large ordinary
number would reject legitimate floating-point worker output. Applications must
choose their numeric and tag schema explicitly.

## Verification evidence

The Windows interpreter used for the final SDK checks was `src/sprout.exe`,
SHA-256 `B387BDBC62DA7AC777209BFD1B7E0630DE65D0C0DA1A09380BF5382AF624341F`.
Independent Linux builds used current repository source with vendored SQLite:

- Optimized native SHA-256: `62ee7dfe3e0ea67d2e349b21889f7127d47bbb108a060dd31f690c248d629b09`.
- UBSan/checked floating conversions SHA-256: `f92c387e30d0945ff5920b5b98200c91a785ea7bb9a85f76418c9024625e8f59`.

These are platform-specific test executables, not reproducibility attestations.
Linux runs used cached local containers with external networking disabled and
repository source mounted read-only. An initial Node native smoke lacked the
UBSan runtime in its slim image; the optimized native executable subsequently
passed the full suite.

| Suite | Observed result |
| --- | --- |
| Python host and live HTTP service, Linux/full SQLite/UBSan | Prior suite: 37 passed, including actual CLI SIGTERM drain, lock recovery and explicit state directory. Optimized Linux suite before the bind change: 41 passed, including absolute source paths and native input ceiling. Updated Windows suite: 42 tests, one POSIX-specific skip; seven focused Linux startup/signal/read-deadline tests passed. macOS native foundation and HTTP workload CI steps passed on `86ab3b4`. |
| Node host, Windows and Linux/optimized native | Final suite: 24 passed on each platform, no skips; includes the native input ceiling. |
| Go host, Windows and Linux/optimized native | 11 top-level tests passed on each platform; native source sync, cancellation, concurrency and new alias-boundary tests included. |
| .NET host, Windows/native ABI | 8 console groups passed, including new ambiguity, text, bounded stream and recovery cases. Cached restore metadata emitted NU1900 because the vulnerability feed was unavailable; it did not skip execution. |
| Java host, Windows | 33 JUnit cases passed, including parser depth constraints, byte-boundary controls, alias preflight, native input ceiling and patched early name-limit rejection/recovery. |
| Paper adapter, Windows | 20 passed, including snapshot lifetime, action policy, queue/reload and native worker tests; patched shaded Jackson metadata/relocation and packaged native smoke also passed. No live server/EULA test was run. |
| Native C host, Linux | 10 passed, including owner SIGKILL and cancellation preventing a nested grandchild's delayed side effect. |
| Proxy example | nginx 1.24 `nginx -t` passed with temporary localhost TLS/password fixtures; no proxy listener or systemd service was installed. |

Reproduce using the current executable and SDK toolchains:

```sh
SPROUT_COMMAND=/absolute/sprout python -m unittest discover -s integrations/python -p 'test_*.py'
SPROUT_COMMAND=/absolute/sprout node --test integrations/node/tests/*.test.js
SPROUT_BINARY=/absolute/sprout CGO_ENABLED=1 go test -count=1 ./... # integrations/go
SPROUT_BINARY=/absolute/sprout SPROUT_HOST_LIBRARY=/absolute/libsprout_host.so dotnet run --project integrations/dotnet/tests
SPROUT_COMMAND=/absolute/sprout mvn test # integrations/java; Paper needs Java25 and the built Java SDK
python src/tests/embed_test.py /absolute/sprout
```

Final-commit native/SDK/sanitizer/container/WASM verification is a required
release dependency. The candidate `7902a5384a8fb81c74c5a08539cfa26bba1940ca`
passed all eight jobs in [final CI](https://github.com/fizzexual/Sprout/actions/runs/38171815745),
including macOS, Linux .NET/Java/Paper and the patched Jackson dependency.
Subsequent evidence-only documentation commits preserve the tested source.
These checks do not replace the duration/data-oracle deployment gates.
The release manifest checks source/version/target/assets before publication;
checksums alone do not authenticate the release or prove reproducible builds.

## Remaining boundaries

- Worker time/OS memory limits do not impose a hard CPU limit on host getters,
  iterators, custom marshalers/converters or custom `JsonNode` behavior. Such
  callbacks are trusted application code. Host-created objects and serializer
  buffers can occupy additional memory beyond the JSON wire cap. Go's ordinary
  struct estimate is conservative around embedded fields and serialization tags.
- Java and Node/Python cancellation terminate the direct worker. Native C/Go/.NET
  use Windows jobs or POSIX ownership-pipe guardians to clean ordinary nested
  Sprout groups. Intentionally detached `setsid`/`setpgid` descendants, external
  fork descriptor retention and already-performed effects require stronger
  supervisor/application controls. No SDK is an OS tenant sandbox.
  A later macOS Python check exposed denied group termination (`EPERM`): the
  SDK must still terminate/reap the direct owned worker and retain the primary
  failure code. Its separate cleanup diagnostic records the denial; successful
  descendant termination is not implied by direct-worker cleanup.
- The private HTTP bridge requires an authenticated TLS proxy, an unprivileged
  identity, immutable code and writable state limits. `/health` is liveness;
  application/database readiness needs an external application probe. There is
  no per-user identity/permission envelope, online source reload or complete
  audit trail in this bridge. The later opt-in [aggregate metrics](services.md#aggregate-service-metrics)
  expose fixed-category operational counters without retaining request contents;
  they do not replace authentication, database readiness or sustained evidence.
- Client disconnect or worker timeout does not imply a database mutation was
  rolled back. Use durable application idempotency keys before enabling retries.
- Paper cleanup depends on readers finishing and filesystem deletion succeeding.
  Abrupt host death or persistent deletion errors can leave temporary snapshots;
  cleanup must happen while the server is stopped. Live Paper/Folia behavior is
  not covered by these fixtures.
