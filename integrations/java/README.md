# Java JSON host

Java 21+ and Maven. Build with `mvn test install`. The SDK starts the native Sprout executable without a shell and defaults to sandbox execution.

```java
try (var host = new SproutHost("/opt/sprout/sprout")) {
    var input = SproutHost.json().readTree("{\"subtotal\":\"120.00\",\"member\":true}");
    var output = host.run(Path.of("../node/example.sprout"), input);
    System.out.println(output);
}
```

Call `run` from a background thread. Interrupt that thread to cancel; `close()` cancels all active interpreter processes. A host rejects requests over its concurrency limit instead of accumulating a queue. Input, stdout, and stderr have byte limits, and stdout/stderr are drained concurrently. Native step/runtime limits and a separate host deadline apply. Errors expose `SproutException.code()` (`busy`, `input_limit`, `output_limit`, `error_limit`, `timeout`, `canceled`, `runtime`, `protocol`, `spawn`, `closed`, `stream`, `stdin`, `input`).

Programs read `json_decode(read_input())` and emit exactly one `json_encode(output)` line. Other stdout is a protocol error. UTF-8, JSON syntax, duplicate object keys and extra JSON values are checked. Exact integers and decimals should cross host boundaries as text. Configuring `Options.sandbox=false` explicitly permits trusted I/O/module applications; use `cwd` for their project directory. Cancellation terminates the direct interpreter, not an arbitrary descendant tree launched by trusted code.

The boundary limits JSON nesting to 128 containers before tree allocation,
rejects non-finite numeric values, and requires Unicode scalar strings/keys
without NUL. Escaped names are compared after decoding, so `"id"` and
`"\u0069d"` are duplicate keys. Valid surrogate pairs and ordinary large finite
numbers are accepted. Requests represented by `JsonNode` receive the same value
checks before worker launch. Version 1 exact-value tags remain explicit objects
for the application to interpret; the SDK does not automatically decode them.
Ordinary request trees receive a byte budget during validation, including each
use of a shared subtree, before encoding into a capped stream. The cap includes
the final newline and counts UTF-8/JSON escaping. This prevents a small alias
graph from being fully expanded before rejection. Custom `JsonNode` behavior
is trusted application code; its time and allocations cannot receive a hard
host CPU limit, although emitted bytes are capped and parsed again. Native
worker deadlines begin after host-side input preparation.
The effective input cap is `min(maxInputBytes, 1 MiB)`, including the newline;
configuring a larger cap cannot bypass the native request ceiling.
Jackson core/databind are pinned through `jackson-databind:2.21.7`. Its parser
also limits each object property name to 50,000 characters and rejects an
oversized name while reading it, including the character parser used for
worker output. [Dependency review](../../docs/dependency-security-2026-10-11.md)
records the advisory, bounded reproduction, and resolved Paper dependencies.

`SPROUT_COMMAND` enables the actual native interpreter test. Unit tests use a Java subprocess fixture to verify limits, cancellation, protocol rejection, and argument handling.
