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
    // Only this manager's temporary snapshots are eligible for deletion. The
    // persisted last-good file is retained for restart recovery.
    private final Map<Path, Integer> readers = new HashMap<>();
    private final Set<Path> retired = new HashSet<>();
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
                if (closed.get() || request != generation) { retire(version); return new Reload(current.get(), false, true); }
                try {
                    Path staged = Files.createTempFile(directory, "last-good-", ".tmp");
                    try {
                        Files.copy(version.source(), staged, StandardCopyOption.REPLACE_EXISTING);
                        try { Files.move(staged, directory.resolve("last-good.sprout"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                        catch (AtomicMoveNotSupportedException ignored) { Files.move(staged, directory.resolve("last-good.sprout"), StandardCopyOption.REPLACE_EXISTING); }
                    } finally { Files.deleteIfExists(staged); }
                } catch (IOException failure) { retire(version); throw new CompletionException(failure); }
                Version previous = current.getAndSet(version);
                if (previous != null) retire(previous);
            }
            return new Reload(version, fallback, false);
        });
    }
    public CompletableFuture<List<ActionPolicy.Action>> evaluate(JsonNode input) {
        JsonNode snapshot = input.deepCopy();
        Version version;
        synchronized (publication) {
            version = current.get();
            if (closed.get() || version == null) return CompletableFuture.failedFuture(new IllegalStateException("No validated Sprout rules are active"));
            readers.merge(version.source(), 1, Integer::sum);
        }
        return submit(() -> policy.validate(evaluator.run(version.source(), snapshot)), () -> release(version));
    }
    private Version prepare(Path candidate) throws Exception {
        Files.createDirectories(directory);
        byte[] bytes;
        try (var stream = Files.newInputStream(candidate)) { bytes = stream.readNBytes(65_537); }
        if (bytes.length > 65_536) throw new IllegalArgumentException("Rule source exceeds 64 KiB");
        StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes));
        String id = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)).substring(0, 12);
        Path snapshot = Files.createTempFile(directory, "rules-" + id + "-", ".sprout");
        try {
            Files.write(snapshot, bytes);
            for (String event : List.of("join", "mob_kill")) {
                var input = SproutHost.json().createObjectNode(); input.put("event", event);
                input.putObject("player").put("id", "00000000-0000-0000-0000-000000000000").put("name", "SproutValidation");
                input.put("entity", "ZOMBIE");
                policy.validate(evaluator.run(snapshot, input));
            }
            return new Version(id, snapshot);
        } catch (Exception failure) { Files.deleteIfExists(snapshot); throw failure; }
    }
    private void retire(Version version) { retired.add(version.source()); cleanupRetired(); }
    private void release(Version version) {
        synchronized (publication) {
            readers.computeIfPresent(version.source(), (path, count) -> count == 1 ? null : count - 1);
            cleanupRetired();
        }
    }
    private void cleanupRetired() {
        retired.removeIf(path -> {
            if (readers.containsKey(path)) return false;
            try { Files.deleteIfExists(path); return true; }
            catch (IOException failure) { return false; } // Retry at the next release/reload/close.
        });
    }
    private final class Work<T> implements Runnable {
        final CompletableFuture<T> future = new CompletableFuture<>();
        final Supplier<T> work; final Runnable cleanup;
        final AtomicInteger state = new AtomicInteger(); // queued, running, finished
        volatile Thread runner;
        Work(Supplier<T> work, Runnable cleanup) {
            this.work = work; this.cleanup = cleanup;
            future.whenComplete((value, failure) -> { pending.remove(future); if (future.isCancelled()) discard(); });
        }
        void discard() {
            if (state.compareAndSet(0, 2)) cleanup.run();
            else { Thread running = runner; if (running != null) running.interrupt(); }
        }
        @Override public void run() {
            if (!state.compareAndSet(0, 1)) return;
            runner = Thread.currentThread();
            try { if (!future.isDone()) future.complete(work.get()); }
            catch (Exception failure) { future.completeExceptionally(failure); }
            finally { runner = null; state.set(2); cleanup.run(); }
        }
    }
    private <T> CompletableFuture<T> submit(Supplier<T> work) { return submit(work, () -> { }); }
    private <T> CompletableFuture<T> submit(Supplier<T> work, Runnable cleanup) {
        Work<T> task = new Work<>(work, cleanup); pending.add(task.future);
        if (closed.get()) { task.future.completeExceptionally(new IllegalStateException("Rule manager is closed")); task.discard(); return task.future; }
        try { workers.execute(task); }
        catch (RejectedExecutionException failure) { task.future.completeExceptionally(new IllegalStateException("Sprout rule queue is full or closed", failure)); task.discard(); }
        return task.future;
    }
    @Override public void close() {
        synchronized (publication) { closed.set(true); ++generation; Version previous = current.getAndSet(null); if (previous != null) retire(previous); cleanupRetired(); }
        pending.forEach(f -> f.cancel(true)); workers.shutdownNow();
    }
}
