# TotalReach deal-value rule: a bounded migration example

This ports the existing `toNumber` form rule from the public MIT-licensed
[fizzexual/TotalReach](https://github.com/fizzexual/TotalReach) CRM into a Sprout
JSON worker. The source snapshot is pinned to commit
`d07cbf4b89458fbb23d425916bd7705c9349db09`, specifically
[src/lib/validation.ts](https://github.com/fizzexual/TotalReach/blob/d07cbf4b89458fbb23d425916bd7705c9349db09/src/lib/validation.ts).
Its currency conversion is used by the original
[createDeal/updateDeal actions](https://github.com/fizzexual/TotalReach/blob/d07cbf4b89458fbb23d425916bd7705c9349db09/src/lib/actions/deals.ts).
The original
[validation tests](https://github.com/fizzexual/TotalReach/blob/d07cbf4b89458fbb23d425916bd7705c9349db09/src/lib/validation.test.ts)
cover grouped currency values and invalid-input defaults.

`upstream/validation.ts` preserves the original file bytes (SHA-256
`3f5afc2d1a8ccd277260b1b2b01450917272c325fda21c992d30b944fb2f2554`).
Its [MIT license](upstream/LICENSE), including the original copyright, is retained.
The test executes the original function body after removing only its TypeScript
declaration annotations/export. It does not reimplement the reference in JavaScript
or depend on Next.js, Prisma, Zod, or a network connection.

## Contract and parity

Input is `{ "values": ["$48,000", "12,500.50", null] }`; output is
`{ "values": [48000, 12500.5, 0] }`. A batch accepts up to 256 JSON values;
each text entry is limited to 4096 Unicode characters. The host bridge maps a non-string
FormData entry, including a File, to null before crossing JSON. The ordinary
JSON text boundary cannot represent embedded NUL in Sprout text.

The port preserves the original behavior: remove everything except ASCII
digits, `.` and `-`, parse the longest floating-point numeric prefix, and return
zero for invalid/nonfinite or non-text values. Despite its original comment,
negative values are accepted. `"1e3"` becomes `13`, `"12-34"` becomes `12`,
and accounting parentheses do not make a value negative. This is a behavior
preserving migration, not a stricter money validator or a locale-aware parser.

The independently written fixtures cover the original tests plus ambiguous
punctuation, negative values, Unicode filtering, and floating-point precision.
A deterministic generated corpus and overflow/subnormal probes additionally
compare the native worker against the pinned original function. The native runs
use the Node host adapter with sandboxing enabled, bounded output, a host deadline,
and execution budgets. Tests also exercise the FormData bridge and invalid batches.

Run with Node 18+ and a native Sprout build from this revision:

```sh
SPROUT_BINARY=/absolute/path/sprout node --test examples/adoption/totalreach/parity.test.js
```

PowerShell:

```powershell
$env:SPROUT_BINARY = (Resolve-Path src/sprout.exe).Path
node --test examples/adoption/totalreach/parity.test.js
```

Without `SPROUT_BINARY` (or `SPROUT_COMMAND`), the original-reference fixture
check runs and native checks are visibly skipped. Native parity is required
before adopting the worker.

## Incremental application adoption

`bridge.js` exports `normalizeDealValue(formData.get("value"), options)`, an
asynchronous replacement point for the original synchronous conversion. In a
candidate host integration, call it before a database transaction and pass the
validated result to Prisma. Compare results in a shadow path first; retain the
original function for rollback. Authentication, ownership checks, Prisma writes,
Next.js UI, and automation dispatch remain application responsibilities.

This example changes no TotalReach repository and deploys no application. It
demonstrates one existing rule running with native parity; production adoption
still needs representative request/latency and failure-path measurements. A fresh
process per form conversion may cost more than the tiny JavaScript function.
Batching several configurable rules per request is a more practical next trial.
