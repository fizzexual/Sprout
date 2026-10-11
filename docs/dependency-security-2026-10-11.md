# Dependency security review — 2026-10-11

This is a focused internal review of the dependencies declared by Sprout's
runtime and host integrations. It is not a security certification or a complete
audit of development tools, operating systems, language runtimes, or Paper.
Only repository manifests, actual parser calls, local bounded fixtures, and
official vendor advisory/release sources were used. No public service was
probed and no Minecraft server was started.

## Finding and fix

The Java SDK previously pinned `jackson-databind:2.21.2`, resolving
`jackson-core:2.21.2`. The SDK parses worker output with `readTree(String)`,
which uses `ReaderBasedJsonParser`. Plain `JsonNode` parsing therefore still
reaches the character-backed parser affected by
[GHSA-649p-m576-vr99](https://github.com/FasterXML/jackson-core/security/advisories/GHSA-649p-m576-vr99).
On affected versions, the property-name limit is checked after buffering the
complete name. The vendor lists the 2.21-line fix as 2.21.6.

Sprout's byte limit is applied before parsing output. The Java default is
1 MiB per call; Paper configures 64 KiB. These caps constrain the effect of the
bug, but do not make the affected parser implementation patched. Raising the
configured output limit also raises that independent bound.

The Java dependency is now pinned to `jackson-databind:2.21.7`, resolving
core/databind 2.21.7 and annotations 2.21. This retains the existing Jackson 2.21
line and includes the name-limit fix. The vendor also lists 2.21.7 as the patch
for the numeric-string coercion advisory
[GHSA-p6pp-m3f8-5c89](https://github.com/FasterXML/jackson-core/security/advisories/GHSA-p6pp-m3f8-5c89)
and the databind advisories
[GHSA-wv8q-qhhj-9h54](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-wv8q-qhhj-9h54)
and
[GHSA-cxp5-3px4-pw24](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-cxp5-3px4-pw24).
The SDK's plain-tree parsing and Paper's explicit type checks do not enable
those advisories' string-to-number coercion, polymorphic default-type fallback,
or identity-enabled POJO deserialization paths. Applications that obtain a
mapper copy and enable additional binding behavior must assess their own use.

The SDK does not use Jackson's async or `DataInput` parsers. The earlier
[document-length advisory](https://github.com/FasterXML/jackson-core/security/advisories/GHSA-2m67-wjpj-xhg9)
was already fixed in 2.21.2; it is not a new finding against the previous pin.

## Bounded evidence

The reproduction uses one JSON property name of 131,072 characters, not a
large-memory or public-network attack. The same mapper's reader input makes
the amount consumed before rejection observable:

| Resolved core | Configured name cap | Characters read before rejection | Result |
| --- | ---: | ---: | --- |
| 2.21.2 | 50,000 | 131,078 (entire document) | Regression fails |
| 2.21.7 | 50,000 | 56,000 | Regression passes |

`ProtocolSecurityTest` now checks early rejection without depending on an
exact buffer size, also rejects the equivalent string input, and runs an
oversized-name worker response followed by a healthy call on the same host.

Local Windows verification against the unchanged native binary with SHA-256
`B387BDBC62DA7AC777209BFD1B7E0630DE65D0C0DA1A09380BF5382AF624341F`:

- Java SDK: 33 tests passed, including the two new security regressions.
- Paper adapter: 20 tests passed using the patched SDK in a temporary Maven
  reactor; no local SDK installation or server launch was required.
- Shaded Paper JAR: embedded Maven metadata reports core/databind 2.21.7 and
  annotations 2.21. The relocated reader class is present and the original
  package is absent. Packaged native JSON rules smoke passed.
- Local shaded JAR SHA-256:
  `8C212AB92FE5D33EE998E738624AF37B9FAE3F3415CC037F4200916E3836ACE6`.

The final committed revision still requires the repository's full CI/release
gates. Earlier green jobs or an overnight Python/native workload do not
substitute for testing a later Java dependency change.

## Other declared runtime dependencies

| Component | Checked manifest/source | Review scope |
| --- | --- | --- |
| Python, Node, Go host SDKs | Standard-library-only application dependencies | Their installed language runtimes and OS components need operator updates; no external application dependency list is an all-clear advisory result. |
| .NET host library | `net8.0`, no `PackageReference` | Framework/runtime servicing remains the deployer's responsibility. |
| Native SQLite | Vendored 3.54.0, source ID dated 2026-10-09 | The official CVE page lists the recent 2026 FTS5 fixes in 3.53.2, preceding this pin. No newer affected-version entry was identified in this bounded vendor-page review. |
| Paper adapter | Provided Paper API 26.2.build.133-stable; relocated Java SDK dependencies | Unit and packaged-host checks do not audit or exercise a live Paper server. |

SQLite's
[official chronology](https://www.sqlite.org/chronology.html) records 3.54.0 on
2026-10-09. Its [CVE page](https://www.sqlite.org/cves.html) and
[security guidance](https://www.sqlite.org/security.html) remain the sources
for future SQLite review. Untrusted database files and arbitrary SQL require
their own application threat assessment; these dependency checks do not
establish an OS sandbox or authenticate the HTTP bridge.

The advisory review covered the official Jackson and SQLite pages available
on the review date. It did not run a comprehensive advisory-feed scanner,
inspect every transitive build/test dependency, or establish that no unknown
vulnerability exists.
