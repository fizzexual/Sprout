# Read-only project diagnosis

`tools/project_doctor.py` helps find missing project files, inconsistent package
pins and environment configuration problems before running an application.
It requires **Python 3.11+**, using only its standard library. This is a tool
requirement; it does not change the Python SDK's supported versions.

```sh
python tools/project_doctor.py /path/to/project
python tools/project_doctor.py /path/to/project --json
python tools/project_doctor.py /path/to/project --entry src/worker.sprout \
  --mode service --state-dir /existing/private/state --allow-io \
  --native /absolute/path/to/trusted/sprout
```

The default operation reads files and prints diagnostics. It does not repair
files, install packages, evaluate Sprout, discover commands on PATH, invoke a
toolchain, fetch dependencies, open a database, start a listener or change
registry/system settings. No write probe is performed in the project or state
directory. `--allow-io` records your intended worker permission; it grants none.

The tool checks the documented flat `sprout.toml` fields `project`, `main`,
`include` and `assets`. Without a config, `main.sprout` is the default;
`--entry` selects an explicit relative entry. Sources must be regular UTF-8
files without NUL bytes. Assets may contain binary bytes. Declared file
presence, path aliases/prefix collisions and module-basename collisions are
checked. No source AST, arbitrary `use`, task syntax or imported code is checked;
run `sprout check` separately for language/import diagnostics.

Config strings use raw double quotes and portable `/` paths, matching native
declarations. `#` and native `~` comments are accepted. Escaped strings,
single/triple quotes, nested tables, duplicate keys and invalid field types are
diagnosed as unsupported/ambiguous configuration. Unknown flat fields produce
a warning. This conservative diagnostic subset does not redefine the native
reader's more permissive behavior.

`sprout.packages` keeps its existing two-column `name source` format. Version-1
`sprout.lock` must begin with `# sprout.lock v1 sha256`; its records are
`name source sha256 installed-path`. The doctor checks name/path collisions,
manifest/source agreement, installed content digests and contained relative
local sources. Tree packages also check their `sprout.package` entry, explicit
files, dependencies, lock completeness and bounded dependency graph. A valid
commit-pinned remote source is reported as **remote content unverified**, not
fetched or treated as missing merely because network access was not attempted.
An installed remote file can still be verified against its lock locally.
Branch/tag dependency declarations can agree with a pinned lock for the same
repository/path; this cannot prove historical ref resolution.

Missing locks produce a review warning for legacy manifests. Missing or drifted
installed/local locked bytes produce errors with explicit restoration/re-add
actions. The doctor does not run those actions. Local source paths must stay
inside the project and use the portable relative form; external vendor sources
and traversal must be moved or reviewed separately.

`--native` records the exact file's SHA-256, bytes and recognized target
(ELF x86-64, PE x86-64 or Mach-O arm64). This identifies bytes/format, not the
publisher or all executable behavior. `--native-manifest` accepts a matching
schema-1 release **platform** record and reports its declared source/build/SQLite
profile. That is a declaration tied to the same digest, not feature execution,
a signature or a reproducible-build claim. Without a record, SQLite/build
profile is unknown. The shared `0.2.0-dev` version is not a capability handshake.

Only add `--probe-version` for an explicitly supplied **trusted interpreter**:

```sh
python tools/project_doctor.py /path/to/project \
  --native /absolute/path/to/trusted/sprout --probe-version --json
```

The optional probe invokes exactly `[native, "version"]`, with no shell or
project arguments. It caps combined stdout/stderr capture at 4096 bytes and
execution at three seconds, followed by a one-second owned-process exit wait
and two half-second reader joins. Startup, excessive output, timeout and
unconfirmed cleanup are failures with retained PID/cleanup diagnostics. The
tool never sends group/tree signals. It cannot guarantee descendant cleanup or
uninterruptible OS spawn/file-I/O latency. Known Sprout bundle footers are
refused before probing, since launching a bundle can execute its embedded
project even with `version` as an argument. A version result alone does not
identify SQLite support or certify application execution.

Worker/service observations describe the intended sandbox state and an
existing state directory. Without `--state-dir`, the entry's parent is used,
matching the Python host defaults. `os.access` observations do not establish
the eventual supervisor account's ACLs, directory creation, SQLite locking,
disk space/quotas, correct database contents or successful writes. `/health`
and application-data readiness are also outside this tool.

Every inspected path rejects symlinks/reparse points, including ancestor or
dangling aliases; supply an explicit physical path instead. Portable project
paths reject absolute/drive paths, parent traversal, ambiguous components,
Windows devices and glob syntax. The tool limits metadata to 4 MiB, inspected
project/package bytes to 64 MiB, distinct inspected files to 4096, declared or
locked files to 1024 and package names to 128. Tree dependency depth is capped
at 32; diagnostics at 2048, with a terminal error if truncated. Native files
are hashed separately with a 256 MiB limit. These inspection limits can stop
a larger valid native project; they are not a complete language specification.
Content identity is checked while reading and on cached reuse. This is not a
sandbox against an adversary concurrently replacing directories or files.

JSON output has `schema: 1`, `diagnostics_only: true`, a `checks` list of stable
`code`, `severity`, `message`, `action` and optional `path/details` fields,
plus `project`, `packages`, `native`, `environment`, `execution`, `limits` and
`summary` observations when available. Status is `diagnostics_clear`,
`attention` or `blocked`. Exit 0 means no diagnostic errors (warnings can
remain), exit 1 means errors/incomplete checks, and exit 2 means invalid CLI
arguments. None of these statuses certifies production readiness or removes
the separate stable-environment/sustained qualification gate.

An explicit compiled-capability preflight uses **schema 2**:

```sh
python tools/project_doctor.py /path/to/project \
  --native /absolute/path/to/trusted/sprout --probe-capabilities \
  --require-feature intrinsic_calls_v1 --require-feature sqlite_adapter_v1 --json
```

This launches exactly `[native, "--capabilities-json"]` once, with stdin closed
and the executable's parent as cwd. **Only supply an executable you explicitly
trust to run.** An older runtime can treat this new flag as a program filename;
an unrecognized legacy bundle or other executable may run code or access the
network. File format/hash inspection and the chosen argv do not prevent that.
Known bundle footers, symlink/reparse aliases and mismatching supplied release
records are refused before launch. No PATH lookup, version fallback, automatic
worker startup, tool installation, dependency request or feature execution is
performed by the doctor.

`--require-feature` is repeatable but requires that explicit capability opt-in.
Names are the six fixed schema-1 names: `intrinsic_calls_v1`,
`sqlite_adapter_v1`, `native_processes_v1`, `http_request_v1`,
`workflow_plan_v1` and `workflow_run_v1`. Unknown or duplicate names are invalid
CLI arguments. Requirements are never inferred from imports, mode, a version
or a build record. An accepted false flag means unavailable; a failed query,
unknown schema, invalid response, target disagreement or identity drift means
unknown. These diagnostics do not establish all application dependencies.

The response has a 1,024-byte protocol cap, one LF/CRLF-terminated JSON line,
strict UTF-8, depth 8 and at most 64 object members. BOM/NUL, duplicate decoded
keys (including escaped duplicates), extra lines, unknown fields, invalid exact
types, nonfinite values and contradictory target/transport/operation flags are
rejected. SQLite's boolean is independent of native/WASM kind; it follows the
producer's compiled adapter definition. The doctor currently inspects native
PE x86-64, ELF x86-64 and Mach-O arm64 files only, so a WASM self-report from
one of those native files is an identity disagreement. Interpreter metadata
must say the separately built C host library is absent, with ABI null; this is
not an SDK protocol or C ABI substitute.

Combined pipe capture is capped at 4,096 bytes. The absolute execution/I/O
budget is three seconds, followed by bounded direct-child reaping and reader
joins. Readings must be finite and never step backward from the previous
accepted reading; the deadline stays anchored to the initial reading.
Nonzero exit, stderr, capture overflow, deadline, reader/startup failure
and unconfirmed cleanup reject the observation. The recorded byte counts are
retained capture sizes, not total output after truncation. Live reader pipes
are retained with an explicit failure instead of a potentially blocking close.
There are no group/tree kills or descendant-cleanup guarantees; OS spawn and
file operations can remain unpreemptible. Probe errors and cleanup errors stay
separate. Exact native digest/size/target are checked again immediately before
and after probing, including after a failed query; this detects drift without
eliminating adversarial filesystem races or authenticating the bytes.

Schema 2 retains project/package/environment diagnostics and separates doctor
actions from external behavior. Once a launch is attempted,
`execution.external_probe.behavior` is `unverified`, and its
`project_code_executed`/`network_accessed` fields are null. They are not reset
to false when the direct child exits. `native.capabilities` contains a compiled
self-report only after clean capture/cleanup, valid schema and unchanged
identity; `required_features` records available, unavailable or unknown.
Permissions/state readiness, curl presence, publisher/provenance, application
compatibility and production certification remain separate. A matching
manifest that declares SQLite while the reply says false produces a retained
disagreement diagnostic; neither observation silently overwrites the other.

Without `--probe-capabilities`, schema 1 and the existing default read-only
behavior remain unchanged. If both explicit probe options are supplied, the
capability query runs first; the requested version probe runs once only after
accepted capability metadata. It cannot rescue an unsuccessful capability
query. No repairs or write-readiness probes are performed by the doctor.

Dedicated capability controls (synthetic/fake, with three bounded owned Python
children for supervisor lifecycle behavior; no Sprout query):

```sh
python src/tests/project_doctor_capabilities_test.py -v
```

The consumer's producer dependency is qualified on `1992c9a` in
[CI 38315637983](https://github.com/fizzexual/Sprout/actions/runs/38315637983).
One separate sealed Windows profile checked exactly two explicit diagnostics:
full1544 accepted all six required features; minimalCB1 rejected required SQLite.
The doctor executed no project code or version fallback; its reports keep
external effects unverified. Consumer revision `a3e11de` passed all eight jobs in
[CI 38319793595](https://github.com/fizzexual/Sprout/actions/runs/38319793595),
including25 capability controls on each native platform. Local fake/Python-child
evidence does not qualify a runtime release.

Synthetic regressions:

```sh
python src/tests/project_doctor_test.py -v
```

They use private fixtures, static fake native headers and mocked version
processes. They do not execute the synthetic Sprout source, access the network,
install anything or rerun sustained/recovery workloads. Platform-specific
symlink/FIFO controls report a skip when the host cannot create those fixtures.
