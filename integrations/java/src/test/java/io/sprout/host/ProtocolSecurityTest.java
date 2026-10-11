package io.sprout.host;

import static org.junit.jupiter.api.Assertions.*;
import java.io.Reader;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.core.exc.StreamConstraintsException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

final class ProtocolSecurityTest {
    private static final class CountingReader extends Reader {
        private final String document;
        private int consumed;
        CountingReader(String document) { this.document = document; }
        @Override public int read(char[] target, int offset, int length) {
            if (consumed == document.length()) return -1;
            int count = Math.min(length, document.length() - consumed);
            document.getChars(consumed, consumed + count, target, offset);
            consumed += count;
            return count;
        }
        @Override public void close() { }
    }
    private static final class ObservedArray extends ArrayNode {
        private int calls;
        ObservedArray() { super(JsonNodeFactory.instance); }
        @Override public String toString() { calls++; return super.toString(); }
    }
    private SproutHost.Options options() {
        return new SproutHost.Options(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", System.getProperty("java.class.path"), ProtocolWorker.class.getName()), Path.of(".").toAbsolutePath(),
            true, 1000, Duration.ofSeconds(2), Duration.ofSeconds(5), 4096, 4096, 4096, 1);
    }
    @ParameterizedTest @ValueSource(strings={"duplicate", "escaped-duplicate", "nonfinite", "negative-nonfinite",
        "deep", "deep-empty", "surrogate", "surrogate-key", "nul", "nul-key", "leading-blank", "trailing-blank"})
    void rejectsUnrepresentableWorkerOutputAndRecovers(String mode) {
        try (var host = new SproutHost(options())) {
            var error = assertThrows(SproutException.class, () -> host.run(Path.of(mode), SproutHost.json().createObjectNode()));
            assertEquals("protocol", error.code());
            assertTrue(host.run(Path.of("healthy"), SproutHost.json().createObjectNode()).get("ok").booleanValue());
        }
    }
    @ParameterizedTest @ValueSource(strings={"paired", "large-finite", "boundary", "boundary-empty"})
    void validTextDepthAndOrdinaryFiniteNumbersRemainUsable(String mode) {
        try (var host = new SproutHost(options())) {
            var output = host.run(Path.of(mode), SproutHost.json().createObjectNode());
            if (mode.equals("paired")) assertEquals("🌱", output.get("text").textValue());
            if (mode.equals("large-finite")) assertEquals("100000000000000000000", output.get("value").toString());
            if (mode.startsWith("boundary")) {
                for (int depth=0; depth<127; depth++) output = output.get(0);
                assertTrue(output.isArray());
            }
        }
    }
    @Test void rejectsMalformedHostTextAndExcessContainersBeforeSpawn() {
        var factory = SproutHost.json().getNodeFactory();
        var base = options();
        var missing = new SproutHost.Options(List.of("missing-sprout-executable"), base.cwd(), true, base.maxSteps(),
            base.runtimeTimeout(), base.hostTimeout(), base.maxInputBytes(), base.maxOutputBytes(), base.maxErrorBytes(), 1);
        try (var host = new SproutHost(missing)) {
            for (String text : new String[]{"\uD800", "\uDC00", "\u0000"}) {
                var error = assertThrows(SproutException.class, () -> host.run(Path.of("unused"), factory.textNode(text)));
                assertEquals("input", error.code());
            }
            var root = factory.arrayNode(); var child = root;
            for (int depth=1; depth<129; depth++) child = child.addArray();
            assertEquals("input", assertThrows(SproutException.class, () -> host.run(Path.of("unused"), root)).code());
        }
    }
    @Test void aliasGraphRejectsBeforeAnySerializationAndExactUtf8CapStillWorks() {
        var factory = SproutHost.json().getNodeFactory();
        JsonNode aliased = factory.textNode("leaf");
        for (int i=0; i<18; i++) aliased = factory.arrayNode().add(aliased).add(aliased);
        var root = new ObservedArray(); root.add(aliased).add("observed");
        try (var host = new SproutHost(options())) {
            assertEquals("input_limit", assertThrows(SproutException.class, () -> host.run(Path.of("healthy"), root)).code());
            assertEquals(0, root.calls);
            assertTrue(host.run(Path.of("healthy"), factory.textNode("x".repeat(4093))).get("ok").booleanValue());
            assertTrue(host.run(Path.of("healthy"), factory.textNode("🌱".repeat(1023))).get("ok").booleanValue());
            assertEquals("input_limit", assertThrows(SproutException.class, () -> host.run(Path.of("healthy"), factory.textNode("x".repeat(4094)))).code());
            assertEquals("input_limit", assertThrows(SproutException.class, () -> host.run(Path.of("healthy"), factory.textNode("🌱".repeat(1024)))).code());
        }
    }
    @Test void configuredLargeInputCapCannotExceedNativeOneMiBCeiling() {
        var base = options();
        var large = new SproutHost.Options(List.of("missing-sprout-executable"), base.cwd(), true, base.maxSteps(),
            base.runtimeTimeout(), base.hostTimeout(), 2_097_152, base.maxOutputBytes(), base.maxErrorBytes(), 1);
        try (var host = new SproutHost(large)) {
            var value = SproutHost.json().getNodeFactory().textNode("x".repeat(1_048_574));
            assertEquals("input_limit", assertThrows(SproutException.class, () -> host.run(Path.of("unused"), value)).code());
        }
    }
    @Test void characterParserRejectsOversizedNamesBeforeBufferingTheWholeToken() {
        // GHSA-649p-m576-vr99 affected the String/Reader parser used for
        // interpreter output, even when only plain JsonNode trees are parsed.
        var mapper = SproutHost.json();
        int cap = mapper.getFactory().streamReadConstraints().getMaxNameLength();
        String document = "{\"" + "a".repeat(131_072) + "\":1}";
        var reader = new CountingReader(document);
        assertThrows(StreamConstraintsException.class, () -> mapper.readTree(reader));
        assertTrue(reader.consumed <= cap * 2,
            "name limit must reject before reading the complete oversized token: " + reader.consumed);
        assertThrows(StreamConstraintsException.class, () -> mapper.readTree(document));
    }
    @Test void oversizedWorkerNameRejectsAndTheHostRemainsUsable() {
        var base = options();
        var bounded = new SproutHost.Options(base.command(), base.cwd(), true, base.maxSteps(),
            base.runtimeTimeout(), base.hostTimeout(), base.maxInputBytes(), 200_000, base.maxErrorBytes(), 1);
        try (var host = new SproutHost(bounded)) {
            assertEquals("protocol", assertThrows(SproutException.class,
                () -> host.run(Path.of("oversized-name"), SproutHost.json().createObjectNode())).code());
            assertTrue(host.run(Path.of("healthy"), SproutHost.json().createObjectNode()).get("ok").booleanValue());
        }
    }
}
