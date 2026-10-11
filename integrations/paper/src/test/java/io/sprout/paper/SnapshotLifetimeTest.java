package io.sprout.paper;

import static org.junit.jupiter.api.Assertions.*;
import io.sprout.host.SproutHost;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class SnapshotLifetimeTest {
    @TempDir Path directory;
    private final ActionPolicy policy = new ActionPolicy(Set.of("BREAD"));
    private com.fasterxml.jackson.databind.JsonNode response(String text) {
        var value = SproutHost.json().createObjectNode();
        value.putArray("actions").addObject().put("type", "message").put("text", text);
        return value;
    }
    private String content(Path source) {
        try { return Files.readString(source); } catch (Exception failure) { throw new CompletionException(failure); }
    }
    private long snapshots(Path cache) throws Exception {
        try (var files = Files.list(cache)) { return files.filter(path -> path.getFileName().toString().startsWith("rules-") && path.toString().endsWith(".sprout")).count(); }
    }
    private void awaitSnapshots(Path cache, long expected) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (snapshots(cache) != expected && System.nanoTime() < end) Thread.sleep(10);
        assertEquals(expected, snapshots(cache));
    }
    @Test void repeatedReloadDoesNotAccumulateSnapshotsAndClosePreservesLastGood() throws Exception {
        Path source = directory.resolve("source"), cache = directory.resolve("cache");
        var rules = new RuleManager(cache, (file, input) -> response(content(file)), policy);
        try {
            for (int i=0; i<40; i++) {
                Files.writeString(source, "version-" + i);
                rules.reload(source).get(3, TimeUnit.SECONDS);
                awaitSnapshots(cache, 1);
            }
            assertEquals("version-39", Files.readString(cache.resolve("last-good.sprout")));
        } finally { rules.close(); }
        awaitSnapshots(cache, 0);
        assertEquals("version-39", Files.readString(cache.resolve("last-good.sprout")));
    }
    @Test void supersededPreparationDeletesItsUnusedSnapshot() throws Exception {
        Path old = directory.resolve("old"), fresh = directory.resolve("new"), cache = directory.resolve("cache");
        Files.writeString(old, "old"); Files.writeString(fresh, "new");
        var started = new CountDownLatch(1); var release = new CountDownLatch(1);
        try (var rules = new RuleManager(cache, (file, input) -> {
            if (content(file).equals("old")) {
                started.countDown();
                try { if (!release.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("fixture wait expired"); }
                catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new CompletionException(failure); }
            }
            return response(content(file));
        }, policy)) {
            var first = rules.reload(old); assertTrue(started.await(3, TimeUnit.SECONDS));
            rules.reload(fresh).get(3, TimeUnit.SECONDS); release.countDown();
            assertTrue(first.get(3, TimeUnit.SECONDS).superseded());
            awaitSnapshots(cache, 1);
            assertEquals("new", content(rules.current().source()));
        } finally { release.countDown(); }
        awaitSnapshots(cache, 0);
    }
    @Test void replacementKeepsSnapshotUntilInflightEvaluationReleasesIt() throws Exception {
        Path source = directory.resolve("source"), cache = directory.resolve("cache"); Files.writeString(source, "old");
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        try (var rules = new RuleManager(cache, (file, input) -> {
            if (input.has("blocked")) {
                entered.countDown();
                try { if (!release.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("fixture wait expired"); }
                catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new CompletionException(failure); }
            }
            return response(content(file));
        }, policy)) {
            Path old = rules.reload(source).get(3, TimeUnit.SECONDS).version().source();
            var active = rules.evaluate(SproutHost.json().createObjectNode().put("blocked", true));
            assertTrue(entered.await(3, TimeUnit.SECONDS));
            Files.writeString(source, "new"); rules.reload(source).get(3, TimeUnit.SECONDS);
            assertTrue(Files.exists(old)); assertEquals(2, snapshots(cache));
            release.countDown(); assertEquals("old", active.get(3, TimeUnit.SECONDS).getFirst().text());
            awaitSnapshots(cache, 1); assertFalse(Files.exists(old));
        } finally { release.countDown(); }
    }
    @Test void closeReleasesQueuedLeasesButDoesNotDeleteSnapshotInUse() throws Exception {
        Path source = directory.resolve("source"), cache = directory.resolve("cache"); Files.writeString(source, "old");
        var entered = new CountDownLatch(2); var release = new CountDownLatch(1);
        var rules = new RuleManager(cache, (file, input) -> {
            if (input.has("blocked")) {
                entered.countDown();
                boolean interrupted = false;
                while (release.getCount() > 0) {
                    try { release.await(3, TimeUnit.SECONDS); }
                    catch (InterruptedException ignored) { interrupted = true; }
                }
                String text = content(file);
                if (interrupted) Thread.currentThread().interrupt();
                return response(text);
            }
            return response(content(file));
        }, policy);
        try {
            Path active = rules.reload(source).get(3, TimeUnit.SECONDS).version().source();
            var input = SproutHost.json().createObjectNode().put("blocked", true);
            var calls = new ArrayList<CompletableFuture<?>>();
            calls.add(rules.evaluate(input)); calls.add(rules.evaluate(input));
            assertTrue(entered.await(3, TimeUnit.SECONDS));
            for (int i=0; i<12; i++) calls.add(rules.evaluate(input));
            calls.getLast().cancel(true);
            rules.close(); assertTrue(calls.stream().allMatch(CompletableFuture::isDone));
            assertTrue(Files.exists(active));
            release.countDown(); awaitSnapshots(cache, 0);
            assertTrue(Files.exists(cache.resolve("last-good.sprout")));
        } finally { release.countDown(); rules.close(); }
    }
}
