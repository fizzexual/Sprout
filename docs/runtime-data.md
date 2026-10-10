# Runtime budgets and exact data

Existing number literals keep floating-point behavior. Use `integer("...")` for
signed 64-bit values and `decimal("...")` for a signed 64-bit coefficient with
at most 18 fractional places. Exact arithmetic checks overflow. Fractions must
be constructed explicitly rather than mixed with floating-point approximations.

```sprout
make price = decimal("19.95")
show price * integer("3")
show decimal_div(decimal("1"), decimal("3"), 6)
```

`decimal_div` chooses precision and truncates toward zero. Exact `/` requires an
integral result; choose `decimal_div` for fractional results. `number(value)`
explicitly converts an exact number to an approximate floating-point number.
Legacy floating-point math/collection functions still require ordinary numbers.

`bytes([0, 255, 65])` and `bytes_from_hex("00ff41")` produce immutable byte
buffers, capped at 16 MiB. They support indexing, slicing, concatenation, equality,
`length`, `bytes_list`, and `bytes_hex`. `bytes_text` accepts valid UTF-8 without
NUL; binary file/HTTP/SQLite operations preserve embedded zero bytes.

`json_encode` / `json_decode` use version 1 tagged maps to preserve exact types:
`$sprout.integer`, `$sprout.decimal`, and `$sprout.bytes` contain decimal text,
decimal text, and hex respectively. Reserved single-key tag maps are decoded as
those values. Ordinary `json` retains its existing ordinary JSON map behavior.
`read_input()` reads up to one MiB of text from standard input for host requests.

Native CLI execution supports `--max-steps N` and `--timeout-ms N` anywhere before
`--`. A step is an interpreter action; it is not a source line. Exhausting a
budget stops the program even inside `try`. Native process, HTTP and SQLite
operations clamp their deadlines to the runtime's remaining time. Host SDKs and
containers additionally bound output and process resources. These flags do not
limit resident memory or provide OS isolation.

`--trace-json` records bounded step events on stderr using the prefix
`@sprout-trace `. Each event contains its source file/line, visible variable
previews, task stack and sequence. Previews do not call user formatting tasks.
Recording stops after 5,000 events or approximately 2 MiB; execution continues.
The playground presents this as recorded playback, with a lower UI trace cap.

Persistence saves use temporary files, flush, and atomic replacement. Invalid
`sprout.data.json` raises a data error and preserves the original and a backup.
Exact types and binary values survive recall. Atomic replacement prevents partial
JSON; the key/value store does not provide concurrent transaction isolation.
