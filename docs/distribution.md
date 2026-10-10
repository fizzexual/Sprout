# Shipping and restoring Sprout projects

Run distribution commands from the project root. Commit `sprout.packages` and
`sprout.lock`; installed copies in `sprout_packages/` can be restored.

## Complete native bundles

```text
sprout bundle app.sprout -o myapp
sprout bundle src/app.sprout -o myapp --asset data/messages.json
```

The bundle contains the entry, every statically declared `use` reachable from it
(including imports in task bodies), declared `include` files, and project assets.
Builtin modules remain part of the interpreter. Declare assets explicitly:

```toml
project = "myapp"
main = "src/app.sprout"
include = ["modules/config.sprout"]
assets = ["data/messages.json", "images/logo.png"]
```

Asset declarations identify files; directory/glob expansion is not supported.
Binary assets are preserved. Every input must stay within the project root;
parent traversal, absolute archive paths, Windows device names, and reparse
points are rejected. A missing import or asset fails the build.

For the same interpreter and input bytes, bundles are byte-for-byte identical.
The sorted archive records SHA-256 digests and validates every file before
extracting anything. Checksums detect accidental damage; they are not a digital
signature or protection against someone replacing both content and its digest.

Launching a bundle extracts its project to a fresh temporary directory, runs
with that directory as its working directory, and cleans extracted files on
normal exit. Arguments are forwarded to `args()`. It runs from another directory
without source files or an installed Sprout. Relative file writes are temporary:
use explicit external paths for durable user output. Crashes or forced process
termination can leave a temporary directory. Bundles have the interpreter's
platform and architecture; build on each supported target. Limits are 1024
files and a 64 MiB archive. Existing version-1 single-file bundles remain readable.

Bundling a file follows `sprout run` semantics: `include` files are available for
resolution, but their top-level code is not implicitly executed as in
`sprout build`. Import initialization explicitly when the entry depends on it.

## Locked packages

```text
sprout add vendor/math.sprout math
sprout add https://example.org/math.sprout math
sprout add github:owner/math@v1.2.0 math
sprout add github:owner/math@0123456789abcdef0123456789abcdef01234567:src/math.sprout math
sprout install --locked
```

GitHub shorthand accepts `github:owner/repo@ref[:relative/path]`. A tag or branch
resolves through GitHub's API to a commit SHA before recording it. With no ref,
`main` is resolved; with no path, `<repo>.sprout` is used. Sources may not contain
whitespace. Package names use letters, digits, underscores, or hyphens.

`sprout add` writes installed content, updates the existing two-column manifest,
and records each exact source and SHA-256 content digest in `sprout.lock`.
Re-adding a package is the explicit update operation. Keep reviewable changes
to both files together.

`sprout install` creates a lockfile for legacy projects that do not have one.
Once a lock exists, installation verifies existing files and verifies freshly
fetched content before writing it. Source drift and installed-file tampering
fail; neither silently updates the lock. Remove a damaged installed file to
restore it from its original source. `--locked` additionally requires a lockfile,
so CI cannot accidentally create a new dependency resolution. A changed manifest
requires explicit `sprout add`, rather than an implicit update during installation.

All downloads and checksum checks finish before installed files are changed.
Writes use temporary files and atomic replacement per file. A multi-package
installation is not an all-or-nothing filesystem transaction: disk failures can
leave some verified files installed. Rerunning installation repairs missing files.

Local sources are restored relative to the project root; commit those vendor
sources or use immutable remote sources for projects shared with other computers.
HTTP downloads use the OS transport on Windows and existing `curl` on POSIX.
GitHub API access can fail due to authentication/rate limits; commit-pinned
sources do not need the ref-resolution API call.

## Packages with several files

A package directory contains a plain-text `sprout.package` manifest:

```text
entry main.sprout
file lib/helpers.sprout
file data/defaults.json
dependency formatting deps/formatting.sprout
dependency remote_util github:owner/util@v1.0.0
```

There must be exactly one `.sprout` entry. `entry` includes that file, so do not
also list it with `file`. Other files must be listed explicitly. Dependencies can
be local relative sources or HTTP/GitHub sources. Dependency names are project
wide; conflicting sources or cycles fail. Limits are 128 package names, 32
dependency levels, 1024 files, and 64 MiB total fetched content.

```text
sprout add vendor/toolbox toolbox
sprout add https://example.org/toolbox/sprout.package toolbox
sprout add github:owner/toolbox@v1.0.0:sprout.package toolbox
```

The files retain their layout under `sprout_packages/toolbox/`. Consumers write
`use toolbox` and call public members through `toolbox`, regardless of the entry
filename. Package entry code can write `use "lib/helpers.sprout"`; resolution
tries the importing file's directory first. Bare module names also try a sibling
`<name>.sprout` first, then the project include map and conventional directories,
then a multi-file package entry. The local-first rule allows packages to keep
private helpers without exporting project-wide filenames. Avoid reusing helper
basenames between simultaneously loaded packages because module namespaces are
currently registered by requested import name.

`sprout remove toolbox` removes its manifest and lock entries and tracked installed
files. Dependencies remain installed; automatic dependency pruning is not yet
implemented. An old single-file copy of the same name can shadow a tree package;
remove that copy when switching distribution layouts.

## Editor formatting

Editors can send an unsaved buffer without overwriting its saved file:

```text
sprout format path/to/document.sprout --stdin
```

Formatted source goes to stdout. `--stdin` cannot combine with `--write` or
`--check`, and rejects NUL bytes and inputs exceeding 64 MiB.
