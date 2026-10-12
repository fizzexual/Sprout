# Pure application request and response contracts

`use "lib/api.sprout"` provides `api.select(request, routes)` and
`api.result(status, body, headers = {})`. Import paths are relative to the source
file, so the [contacts preview](../examples/services/contacts_preview.sprout)
uses `../../lib/api.sprout`. Both tasks use explicit native `builtin::` operations
and captured helper task values. They perform no I/O, execute no supplied tasks,
and do not change caller data. Import requires normal module access; a host can
instead supply the trusted module and its validator as source in sandbox mode.

This is a development API for Sprout `0.2.0-dev`, subject to the
[compatibility policy](compatibility.md). It is an application contract layer,
not a server, authentication mechanism, tenant boundary, router normalization
system, or guarantee about external effects. Host admission, input/output bytes,
worker deadlines, step limits, and operating-system isolation still apply.

## Select a literal route

```sprout
make routes = [
    {id: "list", method: "GET", path: "/contacts"},
    {id: "preview", method: "POST", path: "/contacts", body: {
        kind: "map", fields: {name: {kind: "text", min_length: 1, max_length: 80}}
    }}
]
make request = {method: "POST", path: "/contacts", query: {}, body: {name: "Ada"}}
make selected = api.select(request, routes)
~ selected == {ok: yes, route: "preview", error: nothing, response: nothing}
```

`routes` is a plain list with at most 32 plain descriptors. Each descriptor has
exactly the required `id`, `method`, `path` and optional `query`, `body` fields.
IDs are unique ASCII identifiers of 1–64 letters, digits, `_`, `.`, or `-`.
Duplicate `(method, path)` pairs reject the whole configuration even if their
IDs differ. Configured methods are exactly `GET`, `POST`, `PUT`, `PATCH`,
`DELETE`, `HEAD`, matching the six Python bridge worker handlers.

Paths contain 1–1024 printable ASCII characters, start with `/`, and exclude
space, backslash, `?`, `#`, controls, and DEL. They match literally and remain
case-sensitive: percent escapes, slash suffixes, and dot segments are not
decoded or normalized. Incoming methods are 1–16 uppercase ASCII letters or
hyphens. A custom uppercase method can be inspected by this pure task, but the
Python bridge only forwards its six implemented methods. It currently responds
to `OPTIONS` before a worker is invoked. `GET` never creates an implicit `HEAD`
route; there is no automatic `OPTIONS` or CORS behavior.

Every route and schema is validated **before the request is inspected**,
including routes that would not match. Schemas use the declarative
[validator](validation.md); invalid or unsupported schema options cause
`invalid_contract`, rather than being ignored. `query` requires a valid root-map
schema. Omitting it supplies `{kind: "map"}`, which accepts only an empty query.
Omitting `body` accepts only `nothing`. Explicit `query: nothing` or
`body: nothing` in a route is invalid configuration. To accept a null body,
supply a valid schema with `nullable: yes`.

The request is a plain map with **exactly four required fields**:

| Field | Accepted form |
| --- | --- |
| `method` | Plain uppercase method text as above |
| `path` | Plain literal path text as above |
| `query` | Plain map of nonempty keys, each containing a list of plain texts |
| `body` | Admitted plain JSON/exact value, then the selected body schema |

Unknown or missing envelope fields are rejected. Explicit `query: nothing`
is rejected; an omitted body is also rejected at the envelope level. The helper
preserves explicit `body: nothing`, repeated query strings, empty query lists,
and empty query strings. A query has at most 100 keys, keys of at most 128
characters, and **100 leaf text occurrences in total across its lists**. This
counts strings, not all visited container nodes and not distinct values. The
selected query schema can apply narrower requirements. All body and query
occurrences are inspected even when the schema allows unknown fields.

Success returns exactly `{ok: yes, route: id, error: nothing, response: nothing}`.
It returns the route ID, without supplying a callback or returning request data.
An application branches on that ID and applies its own business rules.

Failure returns exactly `{ok: no, route: nothing, error: code, response: response}`:

| `error` | Status | Public response body |
| --- | --- | --- |
| `invalid_contract` | 500 | `{error: "invalid_contract"}` |
| `invalid_request` | 400 | `{error: "invalid_request"}` |
| `invalid_query`, `invalid_body` | 400 | `{error: "invalid_request"}` |
| `request_limit` | 413 | `{error: "request_limit"}` |
| `route_not_found` | 404 | `{error: "route_not_found"}` |
| `method_not_supported` | 405 | `{error: "method_not_supported"}` |

All include `Cache-Control: no-store`. A 405 also includes `Allow`, listing the
configured methods for that exact path in alphabetical order, separated by
`, `. Errors expose neither raw field names and paths nor submitted values,
schema diagnostics, allowed-value lists, or configuration IDs. The `error` enum
is a fixed category for the application; the HTTP body is fixed too. A malformed
query envelope yields `invalid_query`, including the 100-string/key cap.
Generic tree and encoded-request cap failures yield `request_limit`.

## Validate a bridge response

```sprout
make checked = api.result(201, {id: builtin::integer("9223372036854775807")},
                         {"Cache-Control": "no-store"})
show builtin::json_encode(checked.response)
```

Success is exactly `{ok: yes, error: nothing, response: {status, headers, body}}`.
The returned response tree is detached from caller maps/lists and headers;
shared acyclic aliases are copied independently. Emit **`checked.response`** as
one JSON line. The wrapper containing `ok` and `error` is not the bridge response
and is not included in its byte budget.

Status must be a plain whole ordinary number or typed integer from 200 through
599. Integers in that small range are normalized to an ordinary status number.
Booleans, decimals, strings, nonfinite/fractional numbers, and other kinds reject.
For statuses 204, 205, and 304, body must be `nothing`; the helper rejects other
bodies rather than silently losing them. `HEAD` suppression is transport-owned:
the result task does not receive the request method.

Headers default to `{}` only when omitted. Explicit `nothing` rejects. A plain
header map can contain at most 16 headers. Names are ASCII HTTP tokens of 1–64
characters; values are plain printable ASCII (space through `~`) of 0–1024
characters. Name-plus-value sizes total at most 4096 bytes. Case-insensitive
duplicates reject. `Content-Type`, `Content-Length`, `Connection`, and
`Transfer-Encoding` reject in any casing, because the bridge owns these framing
headers. Accepted caller spelling is preserved. Header values cannot contain
tabs, CR, LF, DEL, or Unicode.

**The complete encoded `{status, headers, body}` plus a two-byte line-ending
reservation must be at most 65536 UTF-8 bytes.** This includes exact-number tags, escaped characters,
keys, delimiters, and headers; it is not a body-only allowance. The Python bridge
separately re-encodes the HTTP body, without the stdout line ending, and omits wire bodies
for `HEAD`, 204, 205, and 304.

The current Windows CLI emits CRLF from `show`; POSIX and WebAssembly emit LF.
The helper reserves two bytes on every platform, so a boundary response fits
the physical Windows stdout limit and leaves one conservative spare byte on
LF-only platforms. It does not change native newline behavior or host ceilings.

Byte admission happens after the bounded detached tree is encoded. It is a final
wire-size limit, not a 64 KiB resident-memory or pre-allocation guarantee. Tree,
text, occurrence, and native exact-value limits also bound that intermediate
encoding. No separate estimator replaces the actual JSON writer.

An invalid response returns a fresh valid fixed result:

```sprout
{ok: no, error: "invalid_response", response: {
    status: 500, headers: {"Cache-Control": "no-store"}, body: {error: "invalid_response"}
}}
```

No rejected output value, header, or diagnostic is echoed. Native runtime budget
errors and unexpected runtime failures still propagate; the library does not
turn an exhausted host budget into a successful application response.

## Tree limits and wire compatibility

These limits apply to the complete route list, request envelope, or response map
being admitted, independently for each call:

| Limit | Value |
| --- | --- |
| Visited value occurrences (shared aliases counted repeatedly) | 4096 |
| Depth | 16 child edges, whole input root at depth 0 |
| Each map | 128 keys |
| Each list | 1024 items |
| Each text value | 65536 Unicode characters |
| All text values and map keys together | 65536 Unicode characters |
| Each map key (empty permitted outside query/schema) | 128 Unicode characters |
| Complete request JSON plus two-byte line-ending reservation | 262144 UTF-8 bytes |
| Complete response JSON plus two-byte line-ending reservation | 65536 UTF-8 bytes |

The request measurement uses the same conservative two-byte reservation. It
does not assert that every host sends CRLF: the current Python and Node hosts
normally send LF, leaving one spare byte below this helper's request ceiling.

The response/request envelope consumes one depth edge before the body. A body
of fifteen nested lists ending in a scalar reaches the depth limit. The bounded
recursive copy checks every occurrence and stops on its first failure; cycles
are rejected by the depth/occurrence limits, rather than truncated or published.
No partial result is returned. Native `copy()` is not used for graph admission.
All text, including keys, undergoes strict scalar JSON encoding to reject invalid
UTF-8 or NUL before copying or rendering the admitted tree. Limit checks bound
subsequent copying/encoding, not the caller's earlier allocations or native
scans of already-created text; retain host limits for untrusted programs.

Supported values are plain `nothing`, text, yes/no, ordinary numbers, typed
integers/decimals, lists, and maps. Objects, tasks, bytes, and nonfinite ordinary
numbers reject without invoking user formatting/equality tasks. Ordinary number
magnitude is deliberately limited to `9007199254740991` (2^53−1), including
fractional values. This narrower policy keeps values within the current Python
bridge encoder's ordinary-number domain. Use actual typed integer/decimal
values for larger exact numbers.

Plain **singleton** maps named `$sprout.integer`, `$sprout.decimal`, or
`$sprout.bytes` reject even when their text would form a valid wire tag: decoding
would change their map identity. Actual typed integer and decimal values remain
supported and receive native tags. The current Python SDK decodes integers to
Python `int`, so HTTP body re-encoding may render a small exact integer as an
ordinary JSON integer. Its value is retained, but identical tag spelling/native
kind at that HTTP boundary is not promised. Large integers and decimals retain
their required tags. The Node worker protocol retains native tag maps.

The Python request envelope has already lost some information: `parse_qs`
drops blank values, `urlsplit` supplies the path rather than the raw URI, and an
absent HTTP body and a JSON `null` both become `nothing`. Request headers are
not forwarded. This library accepts caller-provided complete envelopes, preserves
their strings/lists/nulls, and cannot reconstruct information lost upstream.

## Preview example and verification

`examples/services/contacts_preview.sprout` describes its shape with `GET
/contacts/preview` and validates a `POST` preview containing exactly `name` and
`email`. It rejects blank/control-containing names and requires one interior `@`
with printable ASCII email characters. This is a small application rule, not
full email-address validation or a delivery check. Accepted names/emails are
intentionally returned in the successful preview. Errors are fixed. It writes
no files, stores no records, and provides no idempotency or external effect.

The module can be adopted before an application's business operation by selecting
its route, then emitting `api.result(...).response`. Existing contacts/SQLite
examples and their data/schema protocols remain separate and unchanged.

Native controls cover schema precedence, exact envelopes, literal matching,
duplicate routes, missing/null distinctions, private-safe errors, query leaf
limits, typed values, complete-byte boundaries, headers, callbacks, cycles,
alias detachment, import/provided-source sandbox behavior, Python codec parity,
and the one-line preview protocol. The ten-case shared corpus also runs with
`SPROUT_GC_STRESS=1`. These are bounded pure contract checks, not a deployment,
authentication, concurrency, or sustained production certification.

```text
python src/tests/api_contract_test.py /absolute/path/to/intrinsic-capable/sprout
SPROUT_GC_STRESS=1 sprout test src/tests/api_contract_test.sprout
```
