package io.sprout.host;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

final class ProtocolSecurityTest {
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
}
