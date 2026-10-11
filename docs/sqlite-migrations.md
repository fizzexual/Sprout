# SQLite migrations

Native builds with SQLite support expose `sqlite.migrate` and `sqlite.migrations`.
They use an existing checked database handle. Like other SQLite operations,
they are disabled in Sprout sandbox mode. Minimal/WASM builds return the existing
explicit SQLite-unavailable result; they do not download a database library.

```sprout
use sqlite
make opened = sqlite.open("contacts.db")
when not opened.ok:
    fail opened.error

make history = [
    {version: 1, name: "create contacts", statements: [
        {sql: "CREATE TABLE contacts(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"}
    ]},
    {version: 2, name: "seed contact", statements: [
        {sql: "INSERT INTO contacts(name) VALUES(?)", params: ["Alex ' literal"]}
    ]}
]
make changed = sqlite.migrate(opened.handle, history, {timeout_ms: 5000})
when not changed.ok:
    fail changed.error
show changed
show sqlite.migrations(opened.handle)
make closed = sqlite.close(opened.handle)
```

`sqlite.migrate(handle, history, options?)` (`sql_migrate` globally) takes the
complete ordered history, including already-applied versions. Each entry has
`version`, optional `name`, and a nonempty `statements` list. Each statement is a
map with `sql` and optional positional `params`. SQL values bind separately;
each map must contain exactly one SQL statement. Use the existing parameter
types: text, finite floating numbers, exact integers/decimals, booleans, nothing,
and bytes; byte lists remain supported for compatibility.

Versions are positive, strictly increasing signed int64 integers. Gaps are
allowed. Ordinary numeric versions must be whole values in the safe floating
integer range, at most `9007199254740991`; use `integer("...")` for larger
versions. A literal `1` and `integer("1")` identify the same migration.
An omitted name means empty text; an omitted params list means `[]`.

For each version, SHA-256 covers its normalized exact version, name, ordered SQL
text, and typed parameter values. Changing whitespace, parameter values or types,
statement order, or a name changes the checksum. A previously applied version
must be an unchanged prefix of the supplied history. Removing applied entries,
inserting a version before them, or editing their content fails before pending
SQL runs. Append a new version to evolve a deployed database.

All pending versions run in one `BEGIN IMMEDIATE` transaction. Their schema/data
changes and ledger entries commit together. SQL errors, result limits, or
deadlines detected before commit roll the whole pending batch back. Already
committed versions remain in place. Repeating an unchanged full history applies
nothing. Empty history succeeds only when there are no recorded versions; it
does not create the ledger. A compatible applied history can be verified on a
read-only handle, but pending versions cannot be recorded there.

Success has `ok`, `error`, `code`, exact `current_version`, an `applied` list of
exact versions, and `results` for pending user statements. Each statement result
includes its `migration_version` and zero-based `statement` index, plus the
existing columns/rows/changed/last_id/bytes fields. An unchanged history returns
empty applied/results lists. No history means exact `current_version` zero.
Failures after BEGIN include `rolled_back`. A failed user statement also includes
its version/index; preflight or ledger failures may have no statement index.
Invalid arguments raise ordinary Sprout errors. Exhausted CLI execution budgets
remain hard runtime errors; the adapter cleans up an active transaction before
the runtime exits or catches a different soft error.

`sqlite.migrations(handle, options?)` (`sql_migrations` globally) reads history
without creating it. Its result includes `entries`, exact `current_version`,
`exists`, and `bytes`, alongside `ok/error/code`. Entries contain exact `version`,
`checksum`, `name`, exact `statement_count`, and UTC `applied_at` text. It works
with read-only handles. An incompatible ledger schema, invalid rows/checksums,
or unexpected ledger triggers produces an explicit error.

Both calls accept `timeout_ms` (default 30000, 1..3600000), `max_rows` (default
10000, 1..100000), and `max_bytes` (default 1 MiB, 1..16 MiB). Migration rows and
captured bytes apply across all pending statement results. The successful
serialized migration response must also fit `max_bytes` before commit. Ledger
reads are bounded independently to at most 128 entries and must fit the byte
budget. Deadlines cover validation, lock waits, SQL preparation/execution, ledger
operations, and commit; the runtime's remaining deadline clamps them. SQLite
progress checks and OS scheduling can add small overhead. A commit that has
already completed cannot be undone by a later program error or deadline.

Input limits are 128 versions, 10,000 total statements, 1 MiB per SQL string,
1000 params per statement, and 256 UTF-8 bytes per name. Canonical input is capped
at 16 MiB; preflight also uses conservative serialized-size estimates to bound
temporary allocations. Text must be UTF-8 without NUL; use bytes for binary data.

The reserved ledger is `main._sprout_migrations`. Supplied SQL cannot read or
change its reserved namespace, including through aliases, triggers, indexes,
or rename targets. SQL text containing `_sprout_migrations` in any casing is
rejected, even inside comments or string literals; bind such literal data as a
parameter. Use `sqlite.migrations` to read the ledger. Migration SQL also cannot
issue PRAGMA, COMMIT/ROLLBACK/SAVEPOINT, ATTACH/DETACH, or load extensions. The
authorizer remains installed while statements run, including re-preparation.
See SQLite's [authorizer contract](https://www.sqlite.org/c3ref/set_authorizer.html)
and [action codes](https://www.sqlite.org/c3ref/c_alter_table.html).

The ledger/checksums detect inconsistent supplied history relative to the
database. They are not signatures or protection against someone who can edit the
database through another tool, replace its files, or rewrite both history and
checksums. Keep a backup before deployment. There is no automatic down migration,
existing-database baseline adoption, or separate migration-file discovery.

Run the focused native suite with:

```text
python src/tests/sqlite_migrations_test.py /absolute/path/to/sprout
```

The suite uses temporary real databases to check history drift, exact versions,
bound parameters, atomic rollback, deadlines, limits, reserved-ledger/transaction
escape attempts, read-only handles, corruption, and recovery. It is engineering
validation, not a production readiness or security certification.
