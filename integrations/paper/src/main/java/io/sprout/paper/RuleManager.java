package io.sprout.paper;

import com.fasterxml.jackson.databind.JsonNode;
import io.sprout.host.SproutHost;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Supplier;

/** Immutable source snapshots are validated before publication. No Bukkit calls occur here. */
public final class RuleManager implements AutoCloseable {
    @FunctionalInterface public interface Evaluator { JsonNode run(Path source, JsonNode input); }
    public record Version(String id, Path source) { }
    public record Reload(Version version, boolean fallback, boolean superseded) { }
    private final Path directory;
    private final Evaluator evaluator;
    private final ActionPolicy policy;
    private final ThreadPoolExecutor workers;
    private final AtomicReference<Version> current = new AtomicReference<>();
    private final Set<CompletableFuture<?>> pending = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Object publication = new Object();
    private long generation;

    public RuleManager(Path directory, Evaluator evaluator, ActionPolicy policy) {
        this.directory = directory; this.evaluator = evaluator; this.policy = policy;
        workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32),
            Thread.ofPlatform().daemon().name("sprout-rules-", 0).factory(), new ThreadPoolExecutor.AbortPolicy());
    }
    public Version current() { return current.get(); }
    public CompletableFuture<Reload> reload(Path candidate) {
        long request;
        synchronized (publication) { request = ++generation; }
        return submit(() -> {
            Version version;
            boolean fallback = false;
            try { version = prepare(candidate); }
            catch (Exception failure) {
                // On startup only, recover the previously validated snapshot. Running versions stay unchanged.
                Path lastGood = directory.resolve("last-good.sprout");
                if (current.get() != null || !Files.isRegularFile(lastGood)) throw new CompletionException(failure);
                try { version = prepare(lastGood); fallback = true; }
                catch (Exception recoveryFailure) { failure.addSuppressed(recoveryFailure); throw new CompletionException(failure); }
            }
            synchronized (publication) {
                if (closed.get() || request != generation) return new Reload(current.get(), false, true);
                try {
                    Path staged = Files.createTempFile(directory, "last-good-", ".tmp");
                    try {
                        Files.copy(version.source(), staged, StandardCopyOption.REPLACE_EXISTING);
                        try { Files.move(staged, directory.resolve("last-good.sprout"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                        catch (AtomicMoveNotSupportedException ignored) { Files.move(staged, directory.resolve("last-good.sprout"), StandardCopyOption.REPLACE_EXISTING); }
                    } finally { Files.deleteIfExists(staged); }
                } catch (IOException failure) { throw new CompletionException(failure); }
                current.set(version);
            }
            return new Reload(version, fallback, false);
        });
    }
    public CompletableFuture<List<ActionPolicy.Action>> evaluate(JsonNode input) {
        Version version = current.get();
        if (version == null) return CompletableFuture.failedFuture(new IllegalStateException("No validated Sprout rules are active"));
        JsonNode snapshot = input.deepCopy();
        return submit(() -> policy.validate(evaluator.run(version.source(), snapshot)));
    }
    private Version prepare(Path candidate) throws Exception {
        Files.createDirectories(directory);
        byte[] bytes;
        try (var stream = Files.newInputStream(candidate)) { bytes = stream.readNBytes(65_537); }
        if (bytes.length > 65_536) throw new IllegalArgumentException("Rule source exceeds 64 KiB");
        StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes));
        String id = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)).substring(0, 12);
        Path snapshot = Files.createTempFile(directory, "rules-" + id + "-", ".sprout");
        Files.write(snapshot, bytes);
        try {
            for (String event : List.of("join", "mob_kill")) {
                var input = SproutHost.json().createObjectNode(); input.put("event", event);
                input.putObject("player").put("id", "00000000-0000-0000-0000-000000000000").put("name", "SproutValidation");
                input.put("entity", "ZOMBIE");
                policy.validate(evaluator.run(snapshot, input));
            }
            return new Version(id, snapshot);
        } catch (Exception failure) { Files.deleteIfExists(snapshot); throw failure; }
    }
    private <T> CompletableFuture<T> submit(Supplier<T> work) {
        CompletableFuture<T> future = new CompletableFuture<>();
        pending.add(future); future.whenComplete((result, error) -> pending.remove(future));
        if (closed.get()) { future.completeExceptionally(new IllegalStateException("Rule manager is closed")); return future; }
        try { workers.execute(() -> {
            if (future.isDone()) return;
            try { future.complete(work.get()); } catch (Exception failure) { future.completeExceptionally(failure); }
        }); } catch (RejectedExecutionException failure) { future.completeExceptionally(new IllegalStateException("Sprout rule queue is full or closed", failure)); }
        return future;
    }
    @Override public void close() {
        synchronized (publication) { closed.set(true); ++generation; }
        pending.forEach(f -> f.cancel(true)); workers.shutdownNow();
    }
}
