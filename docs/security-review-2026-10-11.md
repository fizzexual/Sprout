# Internal boundary review follow-up, 2026-10-11

This note records local engineering checks of the working tree on 2026-10-11.
It supplements the [2026-10-10 review](security-review-2026-10-10.md), whose
findings and remaining limits still apply. The checks used project-owned
temporary fixtures and local databases. They are not an independent security
audit, certification, or production readiness claim.

## Verified checks

| Check | Windows | Linux |
| --- | --- | --- |
| SQLite migration suite | 18 passed normally; 18 passed with GC stress | 18 passed normally; 18 passed with GC stress, both with UBSan |
| Boundary regression suite | 26 passed with GC stress | 26 passed with UBSan |
| Native standard-library suite | 20 passed with GC stress | 20 passed with UBSan |
| Build without SQLite | Built successfully; standard-library suite passed with four expected SQLite skips; both new APIs returned explicit unavailable results | Not checked locally in this follow-up |

The Linux build instrumented both the interpreter and the pinned SQLite
amalgamation with `-fsanitize=undefined,float-cast-overflow` and
`-fno-sanitize-recover=all`. No sanitizer diagnostic was reported by these runs.
The boundary and migration runners reject sanitizer diagnostics, process signal
deaths, and Windows crash statuses even in tests that expect an ordinary error.
A sanitizer abort therefore cannot pass as successful input rejection.
Local macOS and AddressSanitizer results are not asserted here; the repository
CI configuration includes separate native and sanitizer jobs.

Run the suites against an absolute path to a newly built native binary:

```text
python src/tests/sqlite_migrations_test.py /absolute/path/to/sprout
python src/tests/security_boundary_test.py /absolute/path/to/sprout
python src/tests/stdlib_production_test.py /absolute/path/to/sprout
```

Set `SPROUT_GC_STRESS=1` to repeat with collection stress. On Linux the local
instrumented build used the following commands, with a writable build directory:

```sh
gcc -O0 -fsanitize=undefined,float-cast-overflow -fno-sanitize-recover=all \
    -c src/vendor/sqlite/sqlite3.c -o /build/sqlite3-linux-ubsan.o
gcc -O1 -g -fsanitize=undefined,float-cast-overflow -fno-sanitize-recover=all \
    -DSPROUT_SQLITE -Isrc src/sprout.c /build/sqlite3-linux-ubsan.o \
    -o /build/sprout-migrations-ubsan -lm -pthread
```

## SQLite migration boundary

The [migration API](sqlite-migrations.md) accepts a complete ordered history of
positive integer versions and explicit SQL statement maps with bound parameters.
SHA-256 covers normalized versions, names, ordered SQL text, and typed parameter
values. Applied history must remain an unchanged prefix. All pending versions
and their ledger entries share one transaction.

The focused suite verifies changed/deleted/reordered history, exact int64
versions, parameter typing, SQL failure rollback, aggregate row and serialized
output caps, execution deadlines, bounded lock contention, and the pre-commit
CLI step-budget guard. It also checks transaction/ATTACH/PRAGMA/extension escape
attempts, ledger aliases/renames/triggers, ledger corruption, read-only handles,
literal reserved names passed as bound data, and recovery after rejection. The
documentation example was executed twice against a fresh private database: the
first run applied both versions and the second applied none.

An error cleanup hook finalizes abandoned statements and rolls back an active
adapter transaction before a runtime error unwinds execution. SQL preparation
and lock waits receive the remaining deadline rather than a previous operation's
timeout. The adapter installs the authorizer while supplied statements execute.
The reserved ledger namespace is also blocked by a conservative SQL-text check;
literal data containing that prefix must be bound as a parameter.

The ledger is not authenticated. Someone with external database/file access can
replace or rewrite it, and this check does not establish who authored a
migration. Completed commits and earlier side effects cannot be undone by a
later program error. SQLite progress checks, scheduling, and filesystem I/O can
add deadline overhead. There is no automatic down migration or existing-database
baseline adoption. The documented input and result caps are bounded operations,
not an operating-system memory or isolation guarantee.

## Data boundary follow-up

The saved boundary suite now checks invalid UTF-8 values and map keys during
JSON writing, malformed reserved singleton tags during both decoding and
writing, decoded duplicate keys, safe and unsafe float-to-int64 boundaries,
wide random spans, range/index/count rejection, exact overflow, and binary
round trips. Legacy `json()` retains its documented last-key-wins behavior;
strict `json_decode()` rejects duplicate decoded keys. These tests exercise the
runtime fixes together with the package/bundle regression fixtures from the
earlier review.
