# Orders CSV dry-run

The application-specific `examples/imports/orders-dry-run.sprout` reads one
local CSV and prints a bounded JSON review. It never imports rows, writes a
report file, opens a database or uses the network. Start with the synthetic
[sample](../examples/imports/orders.csv):

```sh
sprout run examples/imports/orders-dry-run.sprout examples/imports/orders.csv --max-steps 5000000 --timeout-ms 5000
```

Paths are passed as ordinary arguments. `--help` prints usage. A successful
batch exits zero; a reported input or validation failure exits two. Hard runtime
limits or unexpected runtime errors can stop the command without a complete
JSON report. Keep input/host resource limits as well as the example's bounds.

The reusable pure example module exports `order_csv.check(text)`. It reads no
files and returns the same report. Import
`examples/imports/order_csv.sprout` relative to your source. This is a fixed
orders profile, rather than a configurable general-purpose importer.

Use a pinned interpreter from this revision that supports
[`builtin::` calls](intrinsics.md): the validation dependency uses that syntax.
An older executable with the same `0.2.0-dev` version text is insufficient;
keep the example, library and reviewed runtime revisions together.

## CSV and field contract

Input must be valid UTF-8 without NUL. One initial UTF-8 BOM is accepted and
removed as a syntax marker. Header spelling is otherwise exact: no trimming,
case folding or header renaming. Headers may appear in any order and must
contain `id`, `name`, `amount` and `currency`, with optional `note`. Unknown or
duplicate names are rejected before row validation. Every data record must
have exactly one cell per header.

| Field | Contract |
| --- | --- |
| `id` | Positive canonical decimal digits, from `1` through `9223372036854775807`; no signs, whitespace, exponent, fractional part or leading zeros |
| `name` | 1–80 UTF-8 characters, not blank after trimming ASCII whitespace; no ASCII controls or DEL |
| `amount` | Nonnegative canonical decimal text with exactly two fractional digits, from `0.00` through `92233720368547758.07`; no signs, whitespace, exponent or leading whole-part zeros except `0` |
| `currency` | Exactly `USD` or `EUR` |
| `note` | Optional column; at most 200 characters; an empty cell maps explicitly to `nothing` |

Text lengths use Sprout's character counts, rather than byte counts or grapheme
clusters. Names/notes are preserved without normalization or trimming. A missing
note column produces no `note` key in preview rows; an empty cell in a present
note column produces `note: nothing`. Text such as `NULL` remains text.

The existing native `csv.parse` supplies parsing. It preserves commas and
doubled quotes in quoted cells, quoted CR/LF, empty cells and Unicode. CR, LF
and CRLF separate records outside quotes. A trailing record ending does not
create a phantom record. Blank records are real records and fail the width
rule; they are not silently skipped. Native quote failures are reported as
`csv_parse`, without a new claim of broader CSV-standard conformance. That
category covers ordinary parser-reported failures under its native limits; hard
runtime errors propagate. The example does not implement a streaming parser.

Empty input fails because a header is required. A valid header with zero data
records succeeds with empty preview and zero exact currency totals.

## Exact data and batch rules

IDs use `integer(text)`, and amounts use `decimal(text)` after explicit lexical
and range checks. [Declarative validation](validation.md) checks typed fields,
text bounds, allowed currencies and nullable notes. Numeric conversion failures
are field errors; they do not also produce a misleading missing/kind error.
There is no floating-point conversion of IDs or money.

The sample includes ID `9007199254740993`, beyond floating-point integer
precision, and the maximum positive int64 ID. JSON previews preserve exact types
using the native `$sprout.integer` / `$sprout.decimal` tags. Exact `0.10 + 0.20`
can serialize as `{"$sprout.decimal":"0.3"}`: numeric value is preserved,
while fixed two-place display formatting is not promised.

Duplicate IDs are reported on later occurrences, with the earlier
`first_record`. An ID is tracked once its record has the correct width and its
ID passes lexical/range/type checks, even when other fields in that record are
invalid. This avoids overlooking a duplicate because an earlier name or amount
was bad. A wrong-width record has no reliable field mapping and is not tracked.

Totals are separate for USD and EUR; no currency conversion is performed.
Each currency total also has the signed-int64 **cents** ceiling
`92233720368547758.07`. The check happens before addition, so decimal scale
normalization cannot accidentally expand that monetary profile. An overflowing
currency produces one batch `total_range` error. Schema-valid row counts and
preview remain available, but totals are `nothing` unless the whole batch is
valid. There is no partial-import path or persisted retry state.

## Report and bounds

Reports contain `ok`, `row_count`, `valid_rows`, `error_count`, `errors`,
`truncated`, `preview` and `totals`. Errors have fixed messages and locations:

```json
{"record":3,"path":["amount"],"code":"amount_format","message":"Amount must be canonical nonnegative decimal text with exactly two fractional digits."}
```

`record` is the CSV record ordinal, with header record 1 and first data record 2.
It is not a physical line number: quoted cells can span lines. File/batch errors
use a null record; total errors use paths such as `["totals","USD"]`.
Duplicate errors also contain `first_record`.

| Bound | Fixed limit |
| --- | --- |
| File / pure helper input | 262,144 UTF-8 bytes |
| Decoded text | 65,536 characters, including an initial BOM |
| Data records | 1,000, excluding the header |
| Columns | Four required columns and at most one optional column |
| Reported errors | First 64 |
| Preview | First 10 individually valid rows |

These limits are independent. For example, 65,536 four-byte characters reach
the byte ceiling, while the same number of ASCII characters occupy fewer
bytes. The pure helper validates byte encoding before character operations.
Its byte conversion still uses the native bounded bytes API and does not cap
memory already used to create the caller's text.

After a valid header and record-count check, every record is inspected even
when more than 64 errors occur. `error_count` counts all detected field,
duplicate, width and total errors; `truncated` is true exactly when that count
exceeds the reported cap. `valid_rows` counts rows passing field and duplicate
checks; a total-range batch error does not change that count.

Encoding/parser/header/whole-file limits can abort row inspection.
`row_count` is null when records were not parsed, and otherwise counts parsed
data records even if they were not subsequently checked. For these failures,
`error_count` reports detected problems rather than inventing errors for
uninspected rows. Input above the CLI reader's byte limit, missing files and
other ordinary read failures share `input_io`; the pure helper can instead
report its own `input_bytes` limit after receiving text.

Errors do not echo rejected cell values, input paths or unknown header names.
Preview deliberately includes accepted names and notes, so the complete report
can contain application data and should be handled accordingly. Report bounds
do not certify confidentiality, authorization, disk quotas or operational
availability.

The CLI reads through `files.read` in binary mode and `bytes_text`; it does not
write through any file API. This does not create a snapshot guarantee when
another process changes the input concurrently; use a stable input copy.
Native sandbox mode still prohibits filesystem module imports and file reads.
A host may supply trusted pure tasks directly; tests exercise such a supplied
adapter without changing that permission policy.

Keep normal builtin bindings in surrounding trusted source, including the exact
constructors, bytes/CSV operations and collection functions. The example binds
its own task values, but it is not isolation from arbitrary Sprout source that
changes builtin resolution. The [validation library's source boundary](validation.md)
also applies.

## Focused verification

```sh
python src/tests/csv_import_example_test.py /path/to/pinned/sprout
```

The independent Python CSV/Decimal oracle checks valid quoted records and exact
totals. Native tests cover actual parser behavior, row ordinals, header/width
rules, canonical int64 and cents limits, duplicate IDs, bounded diagnostics,
full 1,000-record handling, malformed encoding and the read-only CLI. They
compare input bytes/modification time and verify that no output files appear.
This is new-feature evidence on fresh synthetic data, not deployment or
sustained-workload qualification.
