package io.sprout.host;

import static org.junit.jupiter.api.Assertions.*;
import com.fasterxml.jackson.databind.node.DoubleNode;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

final class SproutHostTest {
    SproutHost.Options options(long timeout, int bytes) {
        return new SproutHost.Options(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", System.getProperty("java.class.path"), FakeInterpreter.class.getName()), Path.of(".").toAbsolutePath(),
            true, 123, Duration.ofSeconds(2), Duration.ofMillis(timeout), 4096, bytes, bytes, 1);
    }
    @Test void echoesJsonAndPassesArgumentsWithoutShell() throws Exception {
        try (var host = new SproutHost(options(5000, 4096))) {
            var input = SproutHost.json().readTree("{\"text\":\"hello \\n 🌱\"}");
            assertEquals(input, host.run(Path.of("echo"), input));
            var args = host.run(Path.of("a space/../args"), input);
            assertEquals("run", args.get(0).textValue());
            assertTrue(args.get(1).textValue().endsWith("args"));
            assertEquals("--sandbox", args.get(6).textValue());
        }
    }
    @ParameterizedTest @ValueSource(strings={"extra", "invalid", "duplicate", "utf8"})
    void rejectsBadProtocol(String mode) {
        try (var host = new SproutHost(options(5000, 4096))) {
            var error = assertThrows(SproutException.class, () -> host.run(Path.of(mode), SproutHost.json().createObjectNode()));
            assertEquals("protocol", error.code());
        }
    }
    @Test void enforcesByteLimitsWhileReading() {
        try (var host = new SproutHost(options(5000, 512))) {
            assertEquals("output_limit", assertThrows(SproutException.class, () -> host.run(Path.of("large"), SproutHost.json().createObjectNode())).code());
            assertEquals("error_limit", assertThrows(SproutException.class, () -> host.run(Path.of("errors"), SproutHost.json().createObjectNode())).code());
        }
    }
    @Test void exposesBoundedRuntimeFailure() {
        try (var host = new SproutHost(options(5000, 4096))) {
            var error = assertThrows(SproutException.class, () -> host.run(Path.of("runtime"), SproutHost.json().createObjectNode()));
            assertEquals("runtime", error.code()); assertTrue(error.getMessage().contains("deliberate fixture"));
        }
    }
    @Test void hostTimeoutKillsHangingInterpreterAndAllowsNextRequest() {
        try (var host = new SproutHost(options(1000, 4096))) {
            assertTimeoutPreemptively(Duration.ofSeconds(3), () -> {
                assertEquals("timeout", assertThrows(SproutException.class, () -> host.run(Path.of("hang"), SproutHost.json().createObjectNode())).code());
            });
            assertTrue(host.run(Path.of("echo"), SproutHost.json().createObjectNode()).isObject());
        }
    }
    @Test void hostDeadlineAlsoBoundsBlockedStdinWrites() {
        var base = options(1000, 4096);
        var limits = new SproutHost.Options(base.command(), base.cwd(), true, base.maxSteps(), base.runtimeTimeout(),
            base.hostTimeout(), 1_048_576, base.maxOutputBytes(), base.maxErrorBytes(), 1);
        try (var host = new SproutHost(limits)) {
            assertTimeoutPreemptively(Duration.ofSeconds(3), () -> {
                var input = SproutHost.json().getNodeFactory().textNode("x".repeat(900_000));
                assertEquals("timeout", assertThrows(SproutException.class, () -> host.run(Path.of("hang"), input)).code());
            });
            assertEquals(0, host.activeProcesses());
        }
    }
    @Test void interruptionCancelsAndConcurrencyIsBounded() throws Exception {
        try (var host = new SproutHost(options(5000, 4096))) {
            var failure = new AtomicReference<SproutException>();
            Thread call = Thread.ofPlatform().start(() -> { try { host.run(Path.of("hang"), SproutHost.json().createObjectNode()); }
                catch (SproutException error) { failure.set(error); } });
            // The first call holds the permit before starting its process.
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (System.nanoTime() < end && host.activeProcesses() == 0 && failure.get() == null) Thread.yield();
            assertEquals(1, host.activeProcesses());
            assertEquals("busy", assertThrows(SproutException.class, () -> host.run(Path.of("echo"), SproutHost.json().createObjectNode())).code());
            call.interrupt(); call.join(2000);
            assertFalse(call.isAlive()); assertEquals("canceled", failure.get().code());
        }
    }
    @Test void validatesInputAndClosedHost() {
        var host = new SproutHost(options(5000, 4096));
        assertEquals("input", assertThrows(SproutException.class, () -> host.run(Path.of("echo"), DoubleNode.valueOf(Double.NaN))).code());
        assertEquals("input_limit", assertThrows(SproutException.class, () -> host.run(Path.of("echo"), SproutHost.json().getNodeFactory().textNode("x".repeat(5000)))).code());
        var nested = SproutHost.json().createObjectNode(); var child = nested;
        for (int i=0; i<130; i++) child = child.putObject("nested");
        assertEquals("input", assertThrows(SproutException.class, () -> host.run(Path.of("echo"), nested)).code());
        host.close();
        assertEquals("closed", assertThrows(SproutException.class, () -> host.run(Path.of("echo"), SproutHost.json().createObjectNode())).code());
    }
    @Test @EnabledIfEnvironmentVariable(named="SPROUT_COMMAND", matches=".+")
    void actualNativeProgramReturnsExactDecimalText() throws Exception {
        try (var host = new SproutHost(System.getenv("SPROUT_COMMAND"))) {
            var input = SproutHost.json().readTree("{\"subtotal\":\"120.00\",\"member\":true}");
            var result = host.run(Path.of("../node/example.sprout"), input);
            assertEquals("108", result.get("total").textValue());
        }
    }
}
