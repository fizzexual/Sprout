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

## Bounded request queue

`createSproutQueue` adds FIFO admission around fresh worker processes:

```js
const { createSproutQueue } = require('./integrations/node');
const queue = createSproutQueue(path.resolve('integrations/node/example.sprout'), {
  command: 'sprout', concurrency: 4, maxQueued: 32,
  queueTimeoutMs: 2000, cleanupTimeoutMs: 1000
});
const controller = new AbortController();
const result = await queue.run({ subtotal: '120.00', member: true }, {
  signal: controller.signal
});
console.log(queue.stats());
await queue.close({ drain: true, timeoutMs: 5000 });
```

Every dispatched request starts one new interpreter. There is no persistent
worker, shared VM, automatic retry or replay. Program/command/cwd/sandbox and
worker limits are validated and copied at construction. Changing the caller's
options afterward does not change the queue; source file contents are not frozen.
The existing `runSprout` API remains available for individual requests.

Queue options add `concurrency` (default 4, 1..64), `maxQueued` (default 32,
0..1024), `queueTimeoutMs` (default 5000) and `cleanupTimeoutMs` (default 1000,
at most 60000). Zero waiting capacity admits only an available running slot.
Other timeouts use positive safe integers up to 2147483647. Unknown queue,
request and close option names are rejected. A request accepts only `signal`;
worker limits belong to the queue configuration.

Admission rejects full/closed/already-canceled work before traversing its input.
It reserves capacity through synchronous preparation and snapshots the strict
JSON request once. Later input mutations cannot change a queued request. The
existing Unicode, exact-tag, input/output/stderr and 128-container contracts
apply. Bounds limit request counts and encoded payload bytes; they are not a
total Node heap or operating-system resource guarantee.

Waiting cancellation or expiration removes a ticket without starting a worker.
Waiting deadlines begin after synchronous preparation and are checked again
before dispatch, even if a timer callback was delayed. Execution deadlines begin
on dispatch. There is no combined submission-to-result deadline, and timers
cannot preempt a blocked or suspended Node event loop.

The active count includes dispatch reservations while checking cancellation,
as well as workers awaiting confirmed cleanup. A cancellation getter that throws
after listener registration or while waiting rejects that ticket with `canceled`
before starting a worker; its listener and reservation still undergo cleanup.
Active cancellation, host timeout or a stream limit first attempts direct-child
`SIGKILL` and destroys owned streams. Queue requests wait up to the cleanup
interval for the owned child's close event; their primary failure code is retained
and `error.cleanup` records the frozen direct-worker observation. Kill refusal,
exceptions or a missing close produce explicit uncertainty, stop further queue
dispatch, and reject waiting/future requests. An uncertain cancellation-listener
removal also fails the queue. Late child exits may reduce the active count but
never reopen it or erase the earlier failure. Arbitrary descendants of trusted
unsandboxed programs are outside this cleanup contract.

New queue error codes are `queue-full`, `queue-timeout`, `queue-closed`, and
`cleanup`; worker failures keep their existing codes. `stats()` returns a frozen
snapshot of state, active/queued/preparing counts and capacities. A failed queue
starts no new worker. Cancellation after dispatch does not roll back external
side effects; use application operation keys where replay safety is required.

The first `close()` stops admission immediately. With `drain: true` (default),
previously admitted requests keep FIFO dispatch until the close deadline
(`timeoutMs`, default 5000). At that deadline, or with `drain: false`, waiting
requests reject with `queue-closed` and active requests are canceled. Close waits
only the cleanup interval afterward and resolves when all owned workers and
waiting timers/listeners have confirmed cleanup. Otherwise it rejects `cleanup`
with at most 64 observations plus total/truncation counts. Later `close()` calls
return the same promise, preserving the first close configuration.

Queue tests include controlled lifecycle races, bounded real direct children,
and native JSON parity when `SPROUT_COMMAND` selects a trusted candidate. Exact
candidate/platform verification remains a release gate; these controls do not
certify service uptime or production readiness.

```sh
node --test integrations/node/tests/*.test.js
```
