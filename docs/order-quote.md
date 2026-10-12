# Synthetic USD order-quote migration

[The example](../examples/adoption/order-quote/rules.sprout) moves a small,
deterministic basket policy into Sprout. It was authored entirely for this
repository. The Python and Node baselines are synthetic prior implementations,
with no private application source or third-party rule provenance.

`rules.evaluate(request)` is pure: it returns a detached quote and a fixed-order
decision trace, or bounded errors with no quote. The
[one-request worker](../examples/adoption/order-quote/worker.sprout) reads JSON
from stdin and writes one native JSON result line. Host applications retain
ownership of authentication, tax, inventory, payment execution, accepted orders
and operational admission. This example changes future quote calculations.

## Input contract

All five root fields and all three fields of every line are required. The value
`nothing` is rejected; no fields receive implicit defaults. Unknown fields are rejected
at both map levels.

| Field | Accepted input |
| --- | --- |
| `order_id` | Text: canonical positive signed-int64 digits, `1` through `9223372036854775807` |
| `currency` | Exact text `USD` |
| `member` | Plain yes/no; JSON `true` or `false` |
| `shipping` | Exact text `standard` or `express` |
| `lines` | List of 1 through 32 maps, with distinct canonical SKU IDs |
| `lines[].sku_id` | Same canonical text contract as `order_id` |
| `lines[].quantity` | Finite, whole **ordinary number**, 1 through 1000 |
| `lines[].unit_price` | Canonical nonnegative text with exactly two decimal places, `0.00` through `1000000.00` |

ID text permits no sign, whitespace, leading zero, exponent, separator or
non-ASCII digit. Price text permits one ASCII dot and two fractional digits;
its whole portion has no leading zeros except `0`. Quantity `1.0` is accepted
as a whole ordinary number. Bool, text and typed exact integer/decimal
quantities are rejected, including valid `$sprout.integer`/`$sprout.decimal`
tags with value one. Small Python `int` quantities use ordinary JSON numbers;
Python `Decimal` quantities use an exact tag and fail validation. Node callers
send quantity as a number and IDs/prices as text, keeping BigInt in the host's
own model. The Node SDK accepts JSON data rather than raw BigInt inputs.

```json
{"order_id":"9007199254740993","currency":"USD","member":true,"shipping":"standard","lines":[{"sku_id":"9223372036854775807","quantity":1,"unit_price":"105.26"}]}
```

The module reuses [declarative validation](validation.md) for kinds, required
fields, lengths, allowed values and unknown fields. Canonical text, domain
ranges and duplicate SKUs are checked only after the complete structural check
succeeds. IDs become exact integers. Unit prices become exact integer cents
before any basket arithmetic.

## Policy and trace

Eligible discounts compete rather than stack. Choose the largest rate, with
this fixed tie order: `high_value`, `value`, `bulk`, `member`, then `none`.

| Rule | Eligibility | Rate |
| --- | --- | --- |
| `high_value` | Basket gross at least 500.00 USD | 1000 basis points / 10% |
| `value` | Basket gross at least 200.00 USD | 750 basis points / 7.5% |
| `bulk` | Total quantity at least 20 | 750 basis points / 7.5% |
| `member` | `member: yes` | 500 basis points / 5% |

Compute each line and the basket gross in integer cents. Round the basket
discount half up **once**, after summing all lines:

```text
discount_cents = floor((gross_cents * rate_bps + 5000) / 10000)
net_cents      = gross_cents - discount_cents
```

Sprout subtracts the exact remainder before exact integral division. There is
no floating-point cents conversion or discarded fractional exact division.
Two 0.05 USD lines with membership produce a 0.01 USD basket discount; rounding
each line separately would produce a different answer.

Standard shipping costs 4.99 USD below **discounted net** 100.00 USD, and is
free at or above that threshold. Express shipping always costs 14.99 USD.
For a member, gross 105.25 yields net 99.99 plus 4.99 shipping; gross 105.26
yields net 100.00 and free standard shipping.

These whole-basket tiers have deliberate price jumps. With fewer than20 units,
gross499.99 yields net462.49 under the value tier; gross500.00 yields net450.00
under the high-value tier. Raising gross can therefore lower the quoted net.
Review that business policy when adapting the example, alongside shipping
thresholds; accepted orders remain the host application's responsibility.

The maximum basket contains 32 × 1000 × 1000000.00 USD: gross
`3200000000000` cents, discount `320000000000` cents, net
`2880000000000` cents. The largest rounding numerator is
`3200000000005000`, below signed-int64 capacity. Operations use exact values
even though this bound also lies below the ordinary-number safe-integer limit.
Total quantity is at most 32000. The chosen caps prevent amount overflow;
unexpected runtime failures propagate to the host rather than return a partial
or zero-valued quote.

Successful results have `ok: yes`, `errors: []`, `truncated: no` and:

- `quote`: exact integer `order_id`, `units`, and line `sku_id`/`quantity`;
  decimal `unit_price`, line `gross`, basket `gross`, `discount`, `net`,
  `shipping`, `total`; and `currency: "USD"`.
- `decisions`: four eligibility entries in the table order, each with
  `rate_bps` and `selected`; a `discount` entry with the chosen code, rate and
  `rounding: "half_up_once"`; then a `shipping` entry with `standard_paid`,
  `standard_free` or `express_fixed`.

Line order is retained. Reordering distinct lines preserves totals and the
decision trace. Exact decimal output need not retain two-place display spelling;
hosts compare integral cents and format USD for their own UI.

Failures have `ok: no`, `quote: nothing`, `decisions: []` and at most 16
`{path, code, message}` entries. Known field names and zero-based line indexes
appear in paths; unknown caller-supplied names become the fixed `<unknown>`
marker. Messages and codes never include rejected values or unknown names.
Schema failures use `validation`; domain codes are `id_format`, `id_range`,
`quantity_range`, `price_format`, `price_range` and `duplicate_sku`.
`truncated` means additional diagnostics or validation work were omitted; it
does not provide a total error count. Schema diagnostics precede domain work.
Supported success values are detached, and neither caller data nor the shared
validator is mutated. Cycles in unsupported input positions, tasks, objects
and non-finite quantities fail within the fixed validator's traversal limits.

## Bounded host use

Use the current intrinsic-capable native interpreter and the checked-in
validator. Local imports require explicitly trusted `sandbox: false`; the
default SDK sandbox still refuses imports. The module contains no I/O calls;
the worker's I/O is stdin/stdout plus importing its reviewed source dependencies.
The runtime sandbox is not OS isolation.

```python
from pathlib import Path
from sprout_host import run  # integrations/python on the host import path

result = run(Path("examples/adoption/order-quote/worker.sprout"), request,
    command="sprout", sandbox=False, timeout_ms=5000,
    runtime_timeout_ms=3000, max_steps=1000000,
    max_input_bytes=8192, max_output_bytes=16384, max_error_bytes=8192)
# Successful IDs/quantities are int, money is Decimal. Handle result["ok"].
```

```js
const { runSprout } = require('./integrations/node');
const result = await runSprout('examples/adoption/order-quote/worker.sprout', request, {
  command: 'sprout', sandbox: false, timeoutMs: 5000,
  runtimeTimeoutMs: 3000, maxSteps: 1000000,
  maxInputBytes: 8192, maxOutputBytes: 16384, maxErrorBytes: 8192
});
// Node retains exact tag maps. Read exact text or use a reviewed BigInt adapter.
// Successful total text: result.quote.total['$sprout.decimal']; never Number(...).
```

The host caps the request at 8 KiB including its newline and the physical worker
response at 16 KiB, including LF/CRLF. Stderr is capped at 8 KiB. Runtime limits
are 1,000,000 actions and 3000 ms; host worker execution is bounded by 5000 ms.
These are per-call bounds, not throughput, OS memory, queue or suspension
guarantees. The underlying native stdin reader has a higher cap; callers who
bypass the SDK must impose the example's host bounds themselves. The pure
validator retains its own 16-level/10000-visited-value/64-internal-diagnostic
limits, and may stop traversal before enumerating every invalid input field.

## Independent parity and source pins

[cases.json](../examples/adoption/order-quote/cases.json) contains 58 synthetic
cases with hand-calculated projections. The Python oracle uses `int`/`Decimal`
and independent Decimal half-up rounding in a local 28-digit context. The Node
oracle uses BigInt cents and identifiers. Both are independent of the Sprout
module and require no third-party packages. Their tests compare the entire
semantic quote, line IDs and cents, ordered eligibility/selection trace, and
failure paths/codes/messages, then check the hand-calculated projections.
Python and Node codecs retain different host representations; the test-only
Node normalizer checks exact tag types before converting known fields to cents.
Parity does not depend on decimal trailing-zero spelling.

The baselines consume bounded plain JSON application values in these tests;
their standalone stdin conveniences are reference tools, not the SDK's streaming
admission boundary. This corpus establishes parity for its declared cases.
Malformed wire JSON and unsupported host object graphs remain transport concerns;
Python and Node may produce different wire number spellings outside the accepted
quantity range. Such inputs never produce an accepted quote here.

Pinned `canonical_text_sha256` means strict UTF-8, replacing CRLF pairs with LF,
then SHA-256 of the resulting UTF-8 bytes. Bare CR, BOM and every other content
change remain significant. Tests check LF/CRLF variants and changed-content
negatives. Exact raw-byte local evidence is retained separately.

| Input | Canonical text SHA-256 |
| --- | --- |
| `baseline.py` | `737e203e16405d61e95c2335c57e7c361e5316a6d1a997e8e511633e89b2a7d3` |
| `baseline.cjs` | `46283dafd11ce71ccac49454198392c34dfa8dc5d88e3fe266a2213be458bb59` |
| `cases.json` | `3f07c4fb116ad4f16b1ecdbb9476aa2401603110dcc0327afc690ca88395d3f0` |
| `lib/validate.sprout` | `2f522b628355e1f422f1f544923bde11f9797672005e7898646158c8bfe45287` |

From the repository root, select a native binary explicitly:

```text
python examples/adoption/order-quote/test_parity.py /absolute/path/to/sprout -v
```

Set `SPROUT_BINARY` to the same binary, then:

```text
node --test examples/adoption/order-quote/parity.test.js
```

The initial Windows reference on 2026-10-12 was native SHA-256
`94a468c820833b1f0fb26af329e9aed5b07bd892964922254f5e293261a7fbf6`:
9 Python and 5 Node groups passed, each comparing all 58 cases. Separate changed
pin controls passed after the newline portability correction. Detachment,
private errors, cyclic/typed input rejection, constructor collisions, physical
maximum-response size and unchanged sandbox behavior also have bounded controls.
Collection was ordinary mode. This new example awaits its own fresh integrated
CI; independent root source/parity review approved the bounded contract.
Existing foundation CI does not verify it. These results
are correctness evidence for this corpus, with no benchmark or deployment claim.
Root's additional14 synthetic baskets also passed an independent rational-money
oracle, including half-up carry, exact host types and further threshold pairs.
Fresh integrated CI remains pending.

## Code-only rollout and rollback

1. Preserve immutable copies and digests of the prior evaluator, candidate
   worker, validator, SDK and selected runtime. Keep prior accepted orders in
   the application's existing storage model.
2. Put both implementations behind one reviewed host interface. Python can use
   the same int/Decimal model. Node must adapt known exact-tag fields to its
   own BigInt cents/identifier model before comparing or switching interfaces.
   Use the strict conversion controls in `parity.test.js` as test evidence.
3. Shadow representative requests without effects and compare semantic cents,
   identifiers, trace and failures. Require the candidate's fresh CI and local
   parity checks before routing future quote calls to its immutable path.
4. To roll back, stop new candidate admission, finish or explicitly cancel its
   bounded in-flight quote calls, then select the preserved prior evaluator
   for future requests. Verify a fixed valid/invalid request pair through the
   same host interface and retain the candidate failure diagnostics privately.

Host errors such as protocol failure, timeout or output cap remain explicit
failures. Do not silently issue a zero quote or automatically retry with a
different evaluator. Rollback neither replays effects nor recomputes or changes
already accepted orders. This example performs no external effects itself.
