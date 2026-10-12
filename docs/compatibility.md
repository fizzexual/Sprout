# Compatibility policy for 0.2.0-dev

Sprout currently reports `0.2.0-dev`. This is a development build identifier,
not a stable language release or a promise that every build with that identifier
is interchangeable. Pin the full source commit, native executable checksum,
target platform, and SDK revision. Run application fixtures before changing an
active worker to a new build.

## Current contracts

| Surface | Implemented behavior | Compatibility boundary |
| --- | --- | --- |
| Language and CLI | Existing numeric literals remain floating point; `integer` and `decimal` explicitly construct exact values. User tasks support named inputs/defaults. | The regression corpus is an upgrade check, not a complete specification. Parameter names are part of a named-call API. Builtins accept positional inputs. |
| Standard library | Documented native I/O operations return structured results; pure operations and imported namespaces have documented contracts. | Pin the runtime and consult [native library](native-library.md), [exact data](runtime-data.md), and [ergonomics](ergonomics.md). Native, sandboxed, and WebAssembly environments expose different capabilities. |
| Worker protocol | One UTF-8 JSON request on stdin, one JSON value on a single stdout line, diagnostics on stderr. Version 1 exact-value tags preserve integers, decimals, and bytes. | There is no version handshake or schema negotiation. Host and worker must agree on their application schema. SDK defaults, error codes, and exact-value conversion differ by binding. |
| C host ABI | `SPROUT_HOST_ABI_VERSION` is `1`; the original options prefix is accepted and an appended memory-limit option is size-gated. | A native process-launch ABI, not an interpreter heap or bytecode ABI. Match architecture/calling convention and use the supplied header and allocator functions. |
| Package lock | `sprout.lock` uses `# sprout.lock v1 sha256`, recording package name, pinned source, digest, and installed path. | Unsupported/corrupt headers are rejected. Locked installation verifies content and manifest agreement without silently updating dependencies. |
| Bundle | The writer emits `SPROUT_BUNDLE_02`; the reader also accepts legacy `SPROUT_BUNDLE_01` single-file payloads. | Bundles contain a native interpreter and are tied to its platform/architecture. Old interpreters do not thereby gain support for new archive formats. |

These numbers identify separate formats/interfaces. ABI 1, tagged JSON version
1, lock version 1, and bundle version 2 do not imply a stable Sprout 1.0 language
or a universal compatibility guarantee.

## Data and host boundaries

`json_encode` / `json_decode` reserve single-key maps named `$sprout.integer`,
`$sprout.decimal`, and `$sprout.bytes` for exact values. Their contents are text:
int64 decimal digits, decimal digits with an int64 coefficient and at most 18
fractional places, or hexadecimal bytes. Do not use these reserved single-key
shapes as ordinary application records. Legacy `json` retains ordinary JSON map
behavior, including last-key-wins for duplicate keys. The current `json_decode`
and persistence readers reject duplicate decoded keys and invalid UTF-8 instead
of accepting ambiguous data. Malformed JSON decodes to `nothing`; a reserved
singleton exact-value tag with a non-text payload raises a data error. Scripts
relying on previously permissive parsing need to validate or repair their inputs.

Ordinary JSON numbers pass through floating-point values, so they do not preserve
large identifiers or exact money. Use tagged types where the binding supports
them, or an agreed text representation. Node and Java currently expose raw JSON
values rather than automatically mapping every exact type to a host-native type.
JSON framing does not validate a business schema: the C SDK validates UTF-8 and
single-line framing; its caller must parse JSON and validate fields.

Trace records are bounded diagnostic previews, not a stable serialization of
interpreter state or a live debugger protocol. Human-readable error text,
formatter layout, trace previews, and internal AST/runtime structures are
development details. Prefer documented status codes and application schemas
over parsing those strings. Step counts measure interpreter actions; a runtime
change can alter the budget needed by the same program.

For native hosts, check `sprout_host_abi_version()` and initialize options with
`sprout_host_options_init_sized(&options, sizeof options)`. The original
initializer writes only the original ABI 1 prefix and disables the added memory
option. Free results with `sprout_host_result_free`; do not share interpreter
objects across processes or free returned buffers with a different allocator.
The header defines layout and ownership. See the [C host
documentation](../integrations/native/README.md) for cancellation lifetime,
platform resource limits, and cleanup behavior.

Commit both `sprout.packages` and `sprout.lock`, and deploy with
`sprout install --locked`. Checksums detect content drift; they do not establish
publisher identity or sign an executable. Bundles extract collected modules and
assets into a fresh temporary project and normally remove it after execution.
Keep durable outputs outside that project. See [distribution](distribution.md)
for limits, assets, and path rules.

Back up `sprout.data.json` and workflow checkpoints before a runtime upgrade.
Exact types can introduce tagged records that an older runtime does not interpret
the same way. There is no general persistent-data migration or downgrade tool;
test restoration with the runtime selected for rollback as well as the new one.

## Changes during development

Windows CLI arguments and native file paths now use UTF-8 with the operating
system's Unicode APIs. This fixes filenames and arguments containing characters
outside the active Windows code page, including Chinese text and emoji. Existing
ASCII commands keep their encoding. The bounded bundle path scanner rejects
normalized paths that exceed its 1,024-byte buffer; this does not promise general
long-path support.

An older Windows build could write code-page bytes into `sprout.packages` and
`sprout.lock` when a local package source contained an accented filename. The
corrected build rejects that invalid UTF-8 metadata without changing it. Preserve
both metadata files and the original package source before upgrading. Re-add each
affected known source with its original alias using the corrected build, for
example `sprout add package-café.sprout local`, then verify the resulting digest
and run `sprout install --locked`. A bounded migration fixture verified this
repair and exact installed contents. Do not guess the original encoding or
silently reinterpret invalid bytes; use a pinned prior runtime and backups to
inspect unknown historical metadata.

The HTTP bridge's aggregate metrics are opt-in through `--metrics`. Enabling
them reserves GET/HEAD `/metrics`; an application using that route should leave
the option disabled or choose a different application route. See
[service metrics](services.md) for counter meanings and limitations.

Maintainers aim to retain tested source behavior and documented interfaces.
Regression fixes, security fixes, and development changes can still reject inputs
previously accepted or change unfinished APIs. For example, numeric controls and
indexes now reject values outside the checked signed-64-bit range before native
casts, and the strict JSON reader rejects ambiguous keys. There is no fixed deprecation
window, supported-release lifetime, or backport commitment today. Releases must
describe incompatible changes and migrations; matching `0.2.0-dev` labels alone
does not establish compatibility.

Language, SDK, extension, and package versions are independent. The experimental
numeric bytecode path has no persistent bytecode compatibility contract. Rebuild
native artifacts, bundles, and WebAssembly from pinned source rather than treating
outputs from different commits as equivalent.

## Evidence and promotion

Native regression, exact-data, ergonomics, distribution, host, and library suites
exercise real contracts. Editor/browser harnesses exercise their adapters; a fresh
WebAssembly build needs separate runtime verification. Passing a suite establishes
its tested cases on its tested platform, not complete language conformance,
old-script compatibility, server integration, or operational reliability.

Before promoting a stable language/API line, publish the contracts, choose
versioning/deprecation rules, preserve an independently maintained compatibility
corpus, and demonstrate:

- Repeatable native/WebAssembly artifacts with pinned dependencies and results
  for each claimed platform.
- Cross-version source, tagged-data, ABI-prefix, lock, and bundle reader tests,
  with explicit rejection or documented migration of unsupported formats.
- Representative migrations with behavioral parity and rollback.
- Crash/recovery, cancellation, resource, soak, and security evidence for each
  claimed workload, plus measured performance budgets.

The [production roadmap](../PRODUCTION_ROADMAP.md) tracks the remaining gates.
This policy records the development boundary; it does not declare them complete.
