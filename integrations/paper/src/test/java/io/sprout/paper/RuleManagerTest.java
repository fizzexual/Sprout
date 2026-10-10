package io.sprout.paper;

import static org.junit.jupiter.api.Assertions.*;
import io.sprout.host.SproutHost;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

final class RuleManagerTest {
    @TempDir Path dir;
    private final ActionPolicy policy = new ActionPolicy(Set.of("BREAD", "EMERALD"));
    private com.fasterxml.jackson.databind.JsonNode response(String text) {
        var result = SproutHost.json().createObjectNode(); result.putArray("actions").addObject().put("type", "message").put("text", text); return result;
    }
    private com.fasterxml.jackson.databind.JsonNode input() { return SproutHost.json().createObjectNode().put("event", "join"); }
    private RuleManager.Evaluator fixture = (file, input) -> {
        try { String text = Files.readString(file); if (text.equals("bad")) throw new IllegalArgumentException("bad candidate"); return response(text); }
        catch (java.io.IOException failure) { throw new CompletionException(failure); }
    };
    @Test void invalidReloadKeepsWorkingImmutableSnapshot() throws Exception {
        Path source = dir.resolve("rules.sprout"); Files.writeString(source, "good");
        try (var rules = new RuleManager(dir.resolve("cache"), fixture, policy)) {
            var good = rules.reload(source).get(3, TimeUnit.SECONDS).version();
            Files.writeString(source, "bad");
            assertThrows(ExecutionException.class, () -> rules.reload(source).get(3, TimeUnit.SECONDS));
            assertEquals(good, rules.current());
            assertEquals("good", rules.evaluate(input()).get(3, TimeUnit.SECONDS).getFirst().text());
        }
    }
    @Test void restartRecoversPersistedLastGoodWhenCandidateFails() throws Exception {
        Path source = dir.resolve("rules.sprout"), cache = dir.resolve("cache"); Files.writeString(source, "good");
        try (var rules = new RuleManager(cache, fixture, policy)) { rules.reload(source).get(3, TimeUnit.SECONDS); }
        Files.writeString(source, "bad");
        try (var rules = new RuleManager(cache, fixture, policy)) {
            var loaded = rules.reload(source).get(3, TimeUnit.SECONDS);
            assertTrue(loaded.fallback()); assertEquals("good", rules.evaluate(input()).get(3, TimeUnit.SECONDS).getFirst().text());
        }
    }
    @Test void newestReloadWinsAndWorkRunsOutsideCallerThread() throws Exception {
        Path old = dir.resolve("old"), fresh = dir.resolve("fresh"); Files.writeString(old, "old"); Files.writeString(fresh, "new");
        var started = new CountDownLatch(1); var release = new CountDownLatch(1); Thread caller = Thread.currentThread();
        RuleManager.Evaluator evaluate = (file, data) -> {
            assertNotEquals(caller, Thread.currentThread());
            try { String text = Files.readString(file); if (text.equals("old")) { started.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); } return response(text); }
            catch (Exception failure) { throw new CompletionException(failure); }
        };
        try (var rules = new RuleManager(dir.resolve("cache"), evaluate, policy)) {
            var previous = rules.reload(old); assertTrue(started.await(3, TimeUnit.SECONDS));
            var latest = rules.reload(fresh).get(3, TimeUnit.SECONDS); release.countDown();
            assertTrue(previous.get(3, TimeUnit.SECONDS).superseded()); assertEquals(latest.version(), rules.current());
            assertEquals("new", rules.evaluate(input()).get(3, TimeUnit.SECONDS).getFirst().text());
        } finally { release.countDown(); }
    }
    @Test void sourceAndQueueAreBoundedAndCloseCompletesQueuedCalls() throws Exception {
        Path source = dir.resolve("rules.sprout"); Files.writeString(source, "good");
        var release = new CountDownLatch(1); var entered = new CountDownLatch(2);
        RuleManager.Evaluator evaluate = (file, data) -> {
            if (data.has("blocked")) { entered.countDown(); try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new CompletionException(error); } }
            return response("good");
        };
        var rules = new RuleManager(dir.resolve("cache"), evaluate, policy);
        try {
            Files.writeString(source, "x".repeat(65_537));
            assertThrows(ExecutionException.class, () -> rules.reload(source).get(3, TimeUnit.SECONDS));
            Files.writeString(source, "good"); rules.reload(source).get(3, TimeUnit.SECONDS);
            var calls = new ArrayList<CompletableFuture<?>>();
            for (int i=0; i<2; i++) calls.add(rules.evaluate(SproutHost.json().createObjectNode().put("blocked", true)));
            assertTrue(entered.await(3, TimeUnit.SECONDS));
            for (int i=0; i<40; i++) calls.add(rules.evaluate(input()));
            assertTrue(calls.stream().anyMatch(CompletableFuture::isCompletedExceptionally));
            rules.close(); assertTrue(calls.stream().allMatch(CompletableFuture::isDone));
        } finally { release.countDown(); rules.close(); }
    }
    @Test @EnabledIfEnvironmentVariable(named="SPROUT_COMMAND", matches=".+")
    void actualSproutValidatesJoinAndMobRewardRules() throws Exception {
        try (var host = new SproutHost(System.getenv("SPROUT_COMMAND")); var rules = new RuleManager(dir.resolve("cache"), host::run, policy)) {
            rules.reload(Path.of("src/main/resources/rules.sprout")).get(5, TimeUnit.SECONDS);
            var data = SproutHost.json().createObjectNode(); data.put("event", "mob_kill"); data.put("entity", "ZOMBIE");
            data.putObject("player").put("name", "Ada").put("id", "test");
            var actions = rules.evaluate(data).get(5, TimeUnit.SECONDS);
            assertEquals("BREAD", actions.get(1).material()); assertEquals(1, actions.get(1).amount());
        }
    }
}
