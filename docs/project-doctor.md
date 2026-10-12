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

Synthetic regressions:

```sh
python src/tests/project_doctor_test.py -v
```

They use private fixtures, static fake native headers and mocked version
processes. They do not execute the synthetic Sprout source, access the network,
install anything or rerun sustained/recovery workloads. Platform-specific
symlink/FIFO controls report a skip when the host cannot create those fixtures.
