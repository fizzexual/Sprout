# Exact UTC timestamp inputs

Development candidate: one fixed Windows correctness cohort passed normal and
GC tests, a 60-case independent oracle in supplied-source sandbox mode, and the
complete synthetic example. Fresh native, sanitizer and WebAssembly CI remains
pending. Existing local-time helpers retain their contracts.

For a program saved in the repository root:

```sprout
use "lib/utc.sprout"
make result = utc.parse("1969-12-31T23:59:59.5Z")
when not result.ok:
    fail result.error.message
show result.text
show result.instant
```

The canonical text is `1969-12-31T23:59:59.500000000Z`. The exact pair contains
seconds `-1` and nanoseconds `500000000`. Keep the two integer fields when
passing instants through a host SDK.

`utc.parse(text)` and `utc.format({seconds, nanoseconds})` return exactly
`{ok, instant, text, error}`. Success contains a detached pair of exact integer
fields, a30-byte canonical text and `error:nothing`. Failure contains
`instant:nothing`, `text:nothing` and fixed `{code,message}` without input values,
names, paths or partial dates. Unexpected runtime/budget failures propagate.

The application profile accepts complete ASCII
`YYYY-MM-DD[Tt]HH:MM:SS[.1-to-9-digits](Z/z/+HH:MM/-HH:MM)`, at most 35 bytes
for accepted ASCII timestamps. The early guard counts at most 35 characters;
non-ASCII strings are rejected by grammar and may contain more encoded bytes.
It validates Gregorian month/day and years0001–9999 rather than normalizing bad
dates. Hours are00–23, minutes00–59, numeric offset hours00–23/minutes00–59.
Offsets are explicit; the library consults no clock, locale, environment, DST,
IANA, OS calendar or network. No whitespace trimming or suffix extension is used.

RFC3339's grammar/offset/calendar rules are the primary basis:
[§4.2](https://datatracker.ietf.org/doc/html/rfc3339#section-4.2),
[§5.6–5.7](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6).
`-00:00` is a known UTC instant with unknown local offset. The update in
[RFC9557 §2.2–2.3](https://datatracker.ietf.org/doc/html/rfc9557#section-2.2)
aligns `Z` with that meaning; `+00:00` has a preferred-reference implication.
This helper is explicitly instant-only: all three zero-offset spellings resolve
the instant, but source offset/preference/precision metadata is not retained.
No local zone is inferred. Keep that metadata separately if your application
requires it. Canonical output always uses uppercase and nine fractional digits,
for example `1970-01-01T00:00:00.000000001Z`; zero padding is not an accuracy claim.

Fractions are exact, never rounded. More than nine digits reject even if their
excess digits are zero. A well-shaped `:60` returns `leap_second_unsupported`.
Every civil day uses86400 seconds in a POSIX-style model. There is no leap-history
lookup, leap-aware SI duration or general ISO8601/full RFC3339 certification;
exceptional negative leap-second omissions cannot be validated. Both source
civil date and converted UTC result must remain in the selected year range.

`instant.seconds` is exact integer -62135596800..253402300799, and
`instant.nanoseconds` is exact integer0..999999999. Before the epoch, seconds
use floor representation: the half-second before1970 is `{-1,500000000}`.
Do not combine the pair into total int64 nanoseconds or a single scaled decimal
across this full range. The formatter rejects ordinary numbers, whole decimals,
booleans, objects/tasks/bytes, literal tag maps, missing/null/extra fields and
cyclic fields. Properly decoded integer tags are native exact integers.

Codes are `invalid_type`, `input_limit`, `invalid_timestamp`,
`unsupported_precision`, `leap_second_unsupported`, `out_of_range` and
`invalid_instant`. The whole-input character cap precedes parsing; an overly long
ten-digit fraction may therefore return `input_limit`. Complete suffix grammar
precedes `unsupported_precision`, without converting overprecision digits.
Calendar validity precedes leap60
policy. Every encoded envelope plus two reserved line-ending bytes fits320 bytes.
The length guard on already allocated text may scan its source; this is not a
host pre-allocation, resident-memory or hard CPU ceiling. Hosts retain their
request/runtime/output bounds. Helpers/public tasks are captured and native
operations use `builtin::`; unsupported values are guarded before comparison or
formatting. Inputs are never mutated and no mutable input alias is returned.

See `examples/time/deadline.sprout` for static synthetic cutoff comparisons.
The example reuses the declarative validator and reports only fixed surrounding
schema errors. It supplies both cutoff and receipt time; it neither samples a
clock nor schedules/accepts orders or infers a recurring local-time deadline.

The explicit CI driver uses the repository's owned-process helper and retains
at most 32 KiB independently from each of stdout and stderr while reading.
It records capture failures and direct-child cleanup failures separately and
stops after the first failed call. The execution deadline is 5 seconds; OS
process creation and bounded direct wait/reader joins are separate boundaries.
This fixture supervisor does not claim descendant process isolation. The
supplied-source oracle embeds its fixed records, avoiding a large stdin write.

`python src/tests/utc_library_test.py` runs nine pure source/oracle/fake groups
without a native binary or private-machine fixtures. Supplying one positional
binary selects exactly four native CI calls, for example
`python src/tests/utc_library_test.py /absolute/sprout --report-dir /new/report`.
The report directory is exclusive; omitting it creates an owned temporary report
which is retained for diagnostics. Records include raw outputs, call counts,
native/source identities and generated full oracles. The driver stops on the
first error and does not retry. CI supplies the trusted checked-out source and
binary provenance; recorded hashes do not establish authenticity or OS isolation.
Text records label raw hashes separately from UTF-8 hashes with only CRLF
normalized to LF. There is no private Windows path or raw-helper hash requirement.
