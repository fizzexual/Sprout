# Release integrity and promotion

The tag-triggered workflow builds the native SQLite interpreter on Linux, macOS,
and Windows. Its tag must match the executable's `version` output exactly.
`0.2.0-dev` remains a development identifier: creating a tag does not establish
stable language compatibility or production readiness. Review the
[compatibility policy](compatibility.md) and [readiness gates](production-readiness.md)
before promoting a workload.

The workflow fails before asset upload on language, CLI, standard-library,
distribution, boundary, serialization, runtime, migration, workflow tools,
CLI library, ergonomics, native host, Node/Python host, and bounded workload
regressions. Publication additionally depends on the reusable full CI workflow
covering Go/.NET/Java/Paper, sanitizer and hardened container jobs, plus a separate
actual WebAssembly compilation and test workflow at the same tag revision.
Ordinary branch CI is not assumed to have run for an arbitrary tag. A release gate is not an overnight soak;
inspect the final commit's CI and frozen workload reports independently.

Each native asset has a platform record containing the source revision, version,
compiler, native format/architecture, SQLite source digest, and asset sizes and
SHA-256 digests. Windows records also pin the installer. The publisher verifies
the complete expected set, common tag/revision/SQLite source, native target,
and every digest before it can publish. A portable PE resource check requires
the Windows installer's embedded `SPROUT_EXE` bytes to match the tested native
Windows asset exactly, both when recording and before publication; it never
executes the installer. Missing, extra, renamed, corrupted, or
inconsistent files fail closed. `release-manifest.json` joins the platform
records, and `SHA256SUMS` covers binaries, installer, records, and that manifest.

Validate downloaded assets in a directory containing the release's files:

```sh
sha256sum -c SHA256SUMS
```

On Windows, compare `Get-FileHash -Algorithm SHA256 <asset>` with the recorded
digest. Keep the manifest and full source revision beside the installed runtime.
The checksum list must come from a release/source channel you trust: these are
unkeyed integrity checks, not publisher signatures, reproducible-build proof,
code signing, or an external security audit. A compromised publishing account
could replace both bytes and their hashes. Signed provenance, independently
reproduced builds, and a supported-release/backport policy remain separate gates.

The local tooling never uploads files:

```text
python src/tests/release_manifest_test.py
python tools/release_manifest.py platform <asset> --platform <Linux|macOS|Windows> --tag <version-tag> --revision <full-commit> --compiler <compiler>
python tools/release_manifest.py assemble <release-directory> --tag <version-tag> --revision <full-commit>
```

Windows platform recording additionally requires `--installer <installer>`.
The tools verify file identity and format, but successful local invocation does
not itself run the regression gates or prove deployment approval. The workflow
places recording after the checks and installer build. Only an explicitly
authorized version-tag push triggers publication; this review did not create
a tag, install a release, or publish one.
