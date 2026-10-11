# JSON and persistence integrity regression evidence

The 2026-10-11 agent review reproduced silent data loss in the JSON writer at
commit `76ba445adfb19cfb113c0624c56a3fec176873fa`. A scalar wrapped in 200 lists
encoded successfully but decoded as `nothing` at the leaf. The writer replaced
values beyond its recursion threshold with JSON `null`. Cyclic collections
also reached that fallback instead of reporting an error. Persistence used the
same writer, with an additional outer store map.

The replacement checks the complete wire shape before allocating its output
buffer. It rejects excessive nesting, cycles, invalid UTF-8, non-finite numbers,
malformed reserved singleton tags, and excessive encoded size. A pointer shared
between separate branches is allowed: cycle detection checks only the current
ancestor path. Writing no longer substitutes `null` for an excessive-depth
value. Task values retain their documented legacy JSON `null` representation.

These are engineering regression checks by a separate implementation agent,
not an external professional security audit or a production certification.

## Limits and store preservation

* Native serialization accepts at most **200 nested wire containers**. A list,
  map, or exact-value tag map counts as a container; scalars do not. Host SDKs
  use their separate, lower 128-container boundary.
* The encoded JSON cap is **64 MiB**, inclusive. The check counts quotes,
  separators, escaped control characters, UTF-8 bytes, and exact-value tags.
  This is a wire-size limit, not a resident-memory limit.
* `remember` adds the outer store map. A value containing 199 nested lists around
  a scalar fits; 200 such lists do not. An exact scalar adds its own tag map.
* Public JSON serialization consumes the runtime step/deadline budget in both
  validation and writing. A budget failure remains uncapturable by Sprout
  `try`/`caught`.

The regression suite checks that rejected `remember` updates preserve the
existing store's bytes and modification time and leave no replacement or backup
file. It covers excessive depth, cycles, oversized shared data, and a step budget
exhausted during validation. This concerns failures before publication; it does
not establish concurrent transaction isolation or recovery from every OS or
hardware failure. See [runtime data](runtime-data.md) and
[persistence](../wiki/persistence.md) for the public behavior.

The private serializer used for interpreter-owned workflow checkpoints, trace
metadata, and SQLite result/migration metadata retains the same shape, cycle,
UTF-8, and size checks. It omits the public serializer's budget charges so a
workflow can save known job outcomes after its execution deadline expires.
The owning operation still imposes its own limits. This helper is not exposed
as a general user API.

## Verification

[`src/tests/serialization_test.py`](../src/tests/serialization_test.py) contains
13 focused tests. In addition to the failure-preservation checks, they verify
the exact 200/201-container boundary, exact-type and binary round trips at the
boundary, mixed list/map cycles, shared acyclic references, recovery after a
caught data error, escaped-size accounting, and acceptance at exactly 64 MiB
with rejection one byte above it. Oversized fixtures reuse small shared values;
the exact-cap test prints only the encoded length.

| Build | Focused serialization suite | Existing boundary suite |
| --- | --- | --- |
| Windows native candidate | 13 passed; 13 passed with GC stress | Covered by the broader [boundary review](security-review-2026-10-11.md) |
| Linux GCC 12.2.0 UBSan snapshot | 13 passed with GC stress | Covered separately by the broader boundary review |
| Linux GCC 12.2.0 ASan + UBSan snapshot, non-PIE | 13 passed with GC stress | 26 passed with GC stress |

The Linux snapshot's `sprout.c` SHA-256 was
`f47c079836a033e7a353b481305807674fdce115fd6653e209389e6f1fd87ce3`.
It included the writer-buffer cleanup and budget checks in both writer passes.
The frozen snapshot avoids mixing an instrumented build with concurrent source
changes. Linux checks ran in local offline containers with read-only source,
private temporary fixtures, a 768 MiB run memory limit, and bounded child
timeouts. No sanitizer diagnostic was reported in these successful runs.

Run the focused suite against a newly built executable:

```sh
python src/tests/serialization_test.py /absolute/path/to/sprout
SPROUT_GC_STRESS=1 python src/tests/serialization_test.py /absolute/path/to/sprout
```

For a core-runtime Linux sanitizer build, the checked flags were:

```sh
gcc -O1 -g -no-pie -fsanitize=address,undefined,float-cast-overflow \
    -fno-sanitize-recover=all -fno-omit-frame-pointer -Isrc \
    src/sprout.c -o /build/sprout-serialization-asan -lm -pthread
ASAN_OPTIONS=detect_leaks=0:abort_on_error=1:detect_stack_use_after_return=0 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 SPROUT_GC_STRESS=1 \
    python src/tests/serialization_test.py /build/sprout-serialization-asan
```

The UBSan-only build omitted `-no-pie`, address instrumentation, and the
frame-pointer flag. These scoped builds did not enable SQLite. Leak detection
and ASan fake-stack instrumentation were disabled for the conservative-GC
configuration; conservative stack scanning is not address-instrumented. Earlier
PIE sanitizer launches were intermittent in this local environment, so this
evidence applies to the successful non-PIE build. It does not claim a complete
leak audit, coverage of every runtime operation, or macOS verification.

## Node codec cross-check

The separate [generated codec tests](../integrations/node/tests/codec-generated.test.js)
exercise the public Node adapter with a controlled process transport. Eight
tests cover 96 fixed-seed JSON values, differently escaped duplicate keys,
mixed/empty containers at 128 and 129 levels, malformed lexical variants,
Unicode and invalid UTF-8 split across byte chunks, exact input/output byte
limits including the line terminator, rejection of accessors and serialization
hooks, and early rejection of exponentially expanding shared collections.
The complete Node suite passed all 23 tests on Windows,
including a request against the current native interpreter. Existing host
tests separately exercise actual child processes.

No codec validation bypass was reproduced in these checks. Node intentionally
returns reserved exact-value tags as plain maps, while the Python SDK restores
int64, Decimal, and bytes. Node applications own tag-schema validation and must
avoid JavaScript number precision loss. Prototype-like keys remain ordinary own
JSON data; consumers must still choose how they use those keys.

Node and Python now count encoded bytes during input preparation, stopping
shared-collection expansion before building the complete JSON representation.
Already-canceled requests skip input traversal. Python also checks exact decimal
size before large conversions and binary size before creating hex text. Its
22 host tests passed on Windows and Linux; the combined Windows host/service
suite passed 36 tests with one POSIX signal test skipped.

Input and output byte limits bound the wire request and captured response.
They do not establish an OS memory limit or interrupt arbitrary application
methods during synchronous encoding and decoding. Child-process execution
timeouts are a separate boundary.
