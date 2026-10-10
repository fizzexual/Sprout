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

`SPROUT_COMMAND` enables the actual native interpreter test. Unit tests use a Java subprocess fixture to verify limits, cancellation, protocol rejection, and argument handling.
