# Native library contracts

The new native APIs return checked results instead of silently losing operating
system failures. A result has `ok`, `error` (text or `nothing`), and `code`
(platform-specific integer). Check `ok` before using the remaining fields.
Argument/type mistakes throw Sprout errors. Existing `read`, `write`, `get`, and
`system` calls remain available.

Global functions work directly. Namespace aliases require their module, such
as `use http`, `use files`, `use csv`, `use process`, or `use sqlite`.

## HTTP

```sprout
use http
make response = http.request("https://example.com/api", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: json_encode({message: "Hello"}),
    timeout_ms: 5000,
    max_bytes: 1048576
})
when response.ok:
    show json_decode(response.body)
otherwise:
    show response.status, response.error
```

`request(url, options)` is the global equivalent. Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `method` | `"GET"` | HTTP method token, conventionally uppercase. |
| `headers` | `{}` | Text header names and values; CR/LF injection is rejected. |
| `body` | `nothing` | Text or `bytes` sent without a terminator. |
| `binary` | `no` | Return response `body` as bytes, preserving NULs. |
| `timeout_ms` | `30000` | Total request deadline; 1 to 3,600,000 ms. |
| `max_bytes` | `1048576` | Body limit; 1 byte to 16 MiB. |

Response fields include `status`, `body`, `headers`, and `timed_out`. Header
names are lowercase; each maps to a list of values, preserving duplicates.
`ok` is true only for a completed HTTP 2xx response. A 404 or 302 keeps its
body/status and has `error: nothing`; transport, timeout, and size failures have
an error. Redirects are not followed automatically. TLS certificate validation
remains enabled. Text mode rejects NUL bytes; use `binary: yes` for binary data.

Windows uses asynchronous system WinHTTP and cancels pending operations when
the deadline expires. Linux/macOS require the `curl` executable on PATH. Sprout
passes literal argv to curl, disables `.curlrc`, restricts protocols to HTTP(S),
and uses a total transfer timeout. Proxy environment settings may affect the
transport. This client does not implement connection pooling, streaming bodies,
or implicit retries.

## Files

| Global | Namespace | Result fields / behavior |
| --- | --- | --- |
| `file_read(path, options)` | `files.read` | `data` is text or bytes; text mode also has `text`. Options `binary` and `max_bytes`. |
| `file_write(path, data)` | `files.write` | Atomic replacement of text/bytes; returns written `bytes`. Maximum 16 MiB. |
| `file_info(path)` | `files.info` | `exists`, `is_dir`, exact integer `size`. Missing paths are an ordinary result. |
| `file_list(path)` | `files.list` | Sorted `entries` list containing names, maximum 100,000 entries. |
| `file_mkdir(path)` | `files.mkdir` | Creates one directory; an existing directory is reported as a failure. |
| `file_remove(path)` | `files.remove` | Deletes one file or an empty directory; never recursively deletes. |
| `file_move(from, to)` | `files.move` | Rename/replacement on the same filesystem; cross-filesystem moves may fail. |

Atomic writes create an exclusive temporary file beside the target, check all
writes and flushes, sync its contents, then replace the destination. POSIX also
syncs the parent directory. A parent-directory sync failure can be reported
after replacement is visible; the error says so. Atomic replacement is not a
compare-and-swap operation, does not preserve every metadata field, and replaces
a destination symlink itself. New POSIX files use private permissions. Windows
paths are converted from UTF-8 to Unicode. Directories are not created implicitly.

## Subprocesses

```sprout
use process
make result = process.run(["python", "report.py", "a file.csv"], {
    stdin: "hello\n",
    timeout_ms: 5000,
    max_output: 1048576
})
when result.ok:
    show result.stdout
otherwise:
    show result.exit, result.error, result.stderr
```

Global equivalent: `process(argv, options)`. `argv` is a nonempty list of text;
arguments are passed literally without a shell. Options are `cwd`, text `stdin`,
`timeout_ms` (default 30 seconds), and `max_output` (default 1 MiB per stream,
maximum 16 MiB). No stdin means immediate EOF. Captured text keeps the child's
encoding and line endings; Sprout does not transcode it.

Results include `exit`, `stdout`, `stderr`, `timed_out`, `truncated`, and
`cancelled`. A normal nonzero exit sets `ok: no` while `error` stays `nothing`.
Start/capture failures set `error`. A timeout, cancellation, or output overflow
terminates the owned process tree. Both streams are drained concurrently, so
writing to stderr while stdout fills does not deadlock. Text capture rejects NUL
bytes. Windows uses a job object and an explicit inherited-handle list. POSIX
uses a process group plus an ownership-pipe guardian outside that group. The
guardian kills the group when its owner exits abruptly, allowing cleanup to
cascade through nested Sprout process calls. The worker starts behind a gate
until the guardian exists, and normal calls reap the guardian. This costs one
extra process per live command. Ordinary grandchildren stay covered; deliberate
`setsid`/`setpgid` detachment can escape. Cleanup is asynchronous and cannot undo
completed effects. This is a lifecycle tool, not a security sandbox. `--sandbox`
blocks it.

## CSV

`csv_parse(text, delimiter)` / `csv.parse` returns a list of rows, each a list
of text cells. The default delimiter is a comma; it must be one byte and cannot
be a quote/newline. Empty fields, doubled quotes, quoted CR/LF, and Unicode text
are preserved. Malformed quotes are errors. Empty input produces no rows; a
trailing line ending does not add a phantom row. Input/fields are limited to
16 MiB, with at most 100,000 cells.

`csv_write(rows, delimiter)` / `csv.write` writes CRLF-terminated rows. Cells
can be text, floating or exact numbers, booleans, or `nothing` (empty cell).
Quoted delimiters, quotes, and newlines round-trip. Maximum output is 16 MiB.
CSV calls are pure and work in sandbox/WebAssembly builds. CSV exported to a
spreadsheet may contain formula-like text; this serializer preserves it literally.

## SQLite

Native builds enable a pinned, vendored SQLite library. Minimal builds return
`ok: no` with an explicit unavailable error. All database calls are blocked by
`--sandbox`, including in-memory databases.

```sprout
use sqlite
make opened = sqlite.open("app.db")
when not opened.ok:
    fail opened.error
make db = opened.handle
make created = sqlite.execute(db, "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)")
make inserted = sqlite.execute(db, "INSERT INTO notes (body) VALUES (?)", ["Safe ' literal text"])
make found = sqlite.execute(db, "SELECT id, body FROM notes")
when found.ok:
    show found.columns, found.rows
make closed = sqlite.close(db)
```

| Call | Global equivalent | Contract |
| --- | --- | --- |
| `sqlite.open(path, options)` | `sql_open` | Returns `handle` and `version`. Options `read_only` (no) and `timeout_ms`. Maximum 64 open handles. |
| `sqlite.execute(handle, sql, params, options)` | `sql_execute` | One prepared statement; positional `params` count must match. |
| `sqlite.transaction(handle, statements, options)` | `sql_transaction` | List of `{sql: text, params: list}`; commits all, or rolls back on failure. |
| `sqlite.close(handle)` | `sql_close` | Releases the handle; later use returns an explicit error. |

Query results contain `columns`, `rows` (lists of cells, preserving duplicate
column names), `changed`, exact `last_id`, and approximate allocated `bytes`.
SQL NULL is `nothing`; INTEGER is an exact Sprout integer; REAL remains a
floating number; TEXT is text; BLOB is bytes. Parameters accept the same scalar
types and bytes; byte lists are also accepted for compatibility. Decimal
parameters bind as exact text. Store them in TEXT columns when exact decimals
must survive SQLite affinity conversion; SQLite NUMERIC/REAL columns may convert
them to floating point.

Execute/transaction options: `timeout_ms` (30000), `max_rows` (10000, maximum
100000), and `max_bytes` (1 MiB, maximum 16 MiB). Transactions apply row/byte limits
to their aggregate results. Runtime deadlines also clamp library deadlines.
Busy locks and expensive queries are bounded; SQLite progress checks may allow
small scheduling overhead. A standalone modifying statement can finish its
write before a result-capture error; use `transaction` when failure must roll
back writes. `rolled_back` reports the rollback outcome, and `statement` identifies
a failed transaction entry with a zero-based index. User SQL cannot issue
COMMIT/ROLLBACK/SAVEPOINT or ATTACH/DETACH and escape this transaction boundary.
Foreign-key enforcement is enabled by default. Handles close at runtime teardown.

## Validation

`python src/tests/stdlib_production_test.py <binary>` tests real local HTTP,
subprocess capture/cancellation, checked file behavior, CSV, and SQLite binding,
rollback, deadlines, and limits. `--no-sqlite` tests the minimal-build contract.
The Windows and Linux native implementations have been exercised with this
suite. This establishes these API contracts; it does not establish an entire
production deployment's availability or workload performance.
