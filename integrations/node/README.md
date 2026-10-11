# Sprout from Node.js

This dependency-free adapter runs a bounded Sprout subprocess for one JSON
request. Use it for application rules, pricing calculations, transformations,
and validated configuration. It requires Node.js 18+ and the current Sprout
interpreter. It is a subprocess bridge, not an in-process VM or JavaScript compiler.

```js
const path = require('node:path');
const { runSprout } = require('./integrations/node');

const result = await runSprout(
  path.resolve('integrations/node/example.sprout'),
  { subtotal: '120.00', member: true },
  { command: 'sprout', timeoutMs: 5000, maxSteps: 100000 }
);
console.log(result); // { total: '108', discount: '12' }
```

The default is `sandbox: true`. Trusted apps that import local modules must set
`sandbox: false` explicitly and select the project root with `cwd`. Disabling the
sandbox permits the runtime's host I/O capabilities; isolate untrusted code at
the process/container level as appropriate for your deployment.

The source reads `json_decode(read_input())` and prints exactly one
`json_encode(result)` line. Additional stdout, malformed JSON, invalid UTF-8,
runtime failures, byte limits, and timeouts reject with `SproutError`; error codes
are `spawn`, `stdin`, `runtime`, `protocol`, `input-limit`, `stdout-limit`,
`stderr-limit`, `timeout`, or `canceled`. `stderr` is available when captured.
Input and output permit at most 128 nested JSON containers. Duplicate decoded
object keys, non-finite numbers, unpaired surrogates, and NUL text are rejected.
Valid Unicode surrogate pairs round-trip. Reserved exact-value tags stay plain
maps in this SDK; your application owns their schema and conversion.
Input must use plain JSON data properties. Accessors and serialization hooks
are rejected. Input sizing stops shared-reference expansion at the byte cap
before allocating the full JSON request; already-canceled requests stop before
visiting input. Host execution deadlines begin after this synchronous preparation.

Options are `command`, `cwd`, `sandbox`, `signal` (an AbortSignal), `timeoutMs`
(host wall time, default 5000), `runtimeTimeoutMs` (default 4000), `maxSteps`
(100000), `maxInputBytes`/`maxOutputBytes` (1 MiB), and `maxErrorBytes` (64 KiB).
The effective input cap includes the newline and never exceeds the native
reader's 1 MiB ceiling, even when a larger `maxInputBytes` is configured.
Output bounds apply while streams arrive. Timeout or cancellation kills the
direct interpreter forcibly. The adapter does not promise to kill arbitrary descendants
started by trusted, unsandboxed programs. Keep exact identifiers and decimals as
JSON strings when JavaScript's number precision would otherwise lose information.

For hot reload, run validation and a representative request against the edited
file before changing the active file path in your host. Keep the last known good
path on failure; this adapter does not replace live application behavior itself.

```sh
node --test integrations/node/tests/*.test.js
```
