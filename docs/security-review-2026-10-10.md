# Internal boundary review, 2026-10-10

This internal engineering review began at revision `cd01cb3` and used temporary
fixtures owned by the project. It is not an independent security audit,
certification, or claim that arbitrary hostile programs are safe to execute.
No third-party systems were tested. HTTP fixtures listened only on loopback.

## Reproduced findings and fixes

| Boundary | Reproduction at the starting revision | Fix and regression |
| --- | --- | --- |
| Package text metadata | A valid lock or package list followed by NUL and invalid records was accepted because parsing stopped at NUL. Metadata larger than 4 MiB was accepted. | Bounded metadata reads reject embedded NUL and files exceeding 4 MiB. |
| Package destination aliases | Two remote files named `main.sprout` and `MAIN.sprout` were both installed, overwriting the entry on Windows. Adding `ONE` overwrote installed `one`. | Package names and destinations reject ASCII case aliases before writes. |
| Package file/directory conflicts | An `asset` file followed by `asset/item` failed after earlier package files had been written. | Plans reject file/directory prefix conflicts before installation. Bundles use the same check. |
| Existing metadata validation | Adding a new package to a malformed existing package list wrote its files before failing to update metadata. | `add` validates existing metadata before applying its file plan. |
| Local package source links | A declared relative entry followed a symlinked directory outside the local source tree. | Local package fetches reject symlink/reparse components, including Windows junctions. |
| Applied package dependency declarations | Altering the top-level manifest and lock dependency source, while keeping the checksummed tree's original dependency declaration, passed locked verification. | Locked dependency roots must agree with declared sources. GitHub mutable-ref declarations retain the immutable lock's commit authority, with matching repository and path; pinned declarations must match their commit. |
| Reserved JSON tag types | Singleton integer, decimal, or bytes tags with non-text payloads passed through as ordinary maps. | `json_decode` and tagged output reject malformed reserved singleton tags. Multi-key maps remain ordinary maps. |
| JSON text and duplicate keys | Invalid raw UTF-8 was accepted and re-emitted. Duplicate decoded keys kept the last value even at strict data boundaries. | Strict decoding rejects invalid UTF-8 and duplicate decoded keys; serialization rejects invalid UTF-8 values and keys. Legacy `json()` retains last-key-wins behavior. |
| Floating-point conversion | Encoding `1e100` cast it to `long long` before checking its magnitude. Linux UBSan reported float-cast-overflow. Similar casts existed in index/count/range functions. | Conversion checks precede casts and use a half-open int64 range. Range lengths and inclusive random spans avoid signed subtraction overflow. |

`src/tests/security_boundary_test.py` exercises the failures above, checks a valid
crafted bundle as a positive control, and tests malformed archive counts,
truncated data, traversal, device paths, embedded NUL, reserved characters,
int64 edges, exact arithmetic overflow, and binary round trips. Its runner rejects
sanitizer diagnostics and process crash statuses even where ordinary rejection
is expected, so a sanitizer abort cannot count as a passing rejection.

## Contracts and remaining limits

- Checksums detect damage or changes relative to a trusted lock. They are
  unkeyed and do not establish who authored a package or bundle. Someone who can
  rewrite both content and its digest can produce a matching artifact.
- Bundles execute their contained program with the caller's permissions.
  Legacy v1 single-file bundles remain readable and have no v2 file checksums.
- The portable alias check folds ASCII case and rejects file/directory prefixes.
  It does not implement every filesystem's Unicode normalization or case rules.
  Use distinct portable names for cross-platform artifacts.
- Path checks reject existing links. They do not defend a workspace against a
  different process concurrently replacing its directory components between
  checking and opening. Use a workspace whose directories are controlled by the
  deploying user; this review did not claim protection against filesystem races.
- Package replacement is atomic per file, not a transaction over the whole
  project. I/O failures can leave a partially updated set of files. Dependency
  pruning and old-file pruning remain explicit operations.
- Sprout's sandbox disables language I/O capabilities; it is not OS isolation.
  Process ownership, output bounds and deadlines do not undo already completed
  effects. Container/OS controls remain the host's responsibility.
- Exact values use a signed int64 coefficient and at most 18 decimal places.
  Ordinary numeric literals keep floating-point behavior. Binary bytes are
  separate from UTF-8 text. Tagged JSON preserves exact and binary values;
  general serialization still has its documented depth and value-type limits.

## Repeating the checks

```text
python src/tests/security_boundary_test.py /absolute/path/to/sprout
python src/tests/distribution_test.py /absolute/path/to/sprout
sprout test src/tests/exact_numbers_test.sprout
sprout test src/tests/binary_values_test.sprout
```

For Linux numeric boundary verification, build the interpreter with
`-fsanitize=undefined,float-cast-overflow -fno-sanitize-recover=all` and run the
same suite. Windows tests include a temporary junction source fixture. The
existing destination-symlink test may skip when file symlink creation is not
available. macOS validation is left to the native CI job; no local macOS test
result is asserted here.
