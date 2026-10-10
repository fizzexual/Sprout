package io.sprout.host;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Blocking JSON host. Call from a worker thread; interrupt the caller to cancel. */
public final class SproutHost implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public record Options(List<String> command, Path cwd, boolean sandbox, int maxSteps,
                          Duration runtimeTimeout, Duration hostTimeout,
                          int maxInputBytes, int maxOutputBytes, int maxErrorBytes, int concurrency) {
        public Options {
            command = List.copyOf(command);
            if (command.isEmpty() || command.stream().anyMatch(s -> s == null || s.isEmpty()))
                throw new IllegalArgumentException("command must contain an executable");
            Objects.requireNonNull(runtimeTimeout); Objects.requireNonNull(hostTimeout);
            if (maxSteps < 1 || runtimeTimeout.toMillis() < 1 || hostTimeout.toMillis() < 1
                || maxInputBytes < 1 || maxOutputBytes < 1 || maxErrorBytes < 1 || concurrency < 1)
                throw new IllegalArgumentException("limits must be positive");
        }
        public static Options defaults(String executable) {
            return new Options(List.of(executable), null, true, 100_000, Duration.ofSeconds(4),
                Duration.ofSeconds(5), 1_048_576, 1_048_576, 65_536, 4);
        }
    }

    private final Options options;
    private final Semaphore permits;
    private final ExecutorService streams = Executors.newVirtualThreadPerTaskExecutor();
    private final Set<Process> active = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();

    public SproutHost(Options options) { this.options = Objects.requireNonNull(options); permits = new Semaphore(options.concurrency()); }
    public SproutHost(String executable) { this(Options.defaults(executable)); }
    public static ObjectMapper json() { return JSON.copy(); }
    public int activeProcesses() { return active.size(); }

    public JsonNode run(Path program, JsonNode input) {
        Objects.requireNonNull(program); Objects.requireNonNull(input);
        validateInput(input, 0);
        byte[] request = (input.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        if (request.length > options.maxInputBytes()) throw new SproutException("input_limit", "JSON input exceeds byte limit");
        if (closed.get()) throw new SproutException("closed", "Sprout host is closed");
        if (!permits.tryAcquire()) throw new SproutException("busy", "Sprout concurrency limit reached");
        Process process = null;
        List<Future<?>> tasks = new ArrayList<>();
        try {
            Path source = program.toAbsolutePath().normalize();
            List<String> args = new ArrayList<>(options.command());
            args.addAll(List.of("run", source.toString(), "--max-steps", Integer.toString(options.maxSteps()),
                "--timeout-ms", Long.toString(options.runtimeTimeout().toMillis())));
            if (options.sandbox()) args.add("--sandbox");
            ProcessBuilder builder = new ProcessBuilder(args);
            builder.directory((options.cwd() == null ? source.getParent() : options.cwd()).toFile());
            process = builder.start();
            active.add(process);
            if (closed.get()) throw new SproutException("closed", "Sprout host is closed");
            Process child = process;
            Future<byte[]> stdout = streams.submit(() -> read(child.getInputStream(), options.maxOutputBytes(), "output_limit", child));
            tasks.add(stdout);
            Future<byte[]> stderr = streams.submit(() -> read(child.getErrorStream(), options.maxErrorBytes(), "error_limit", child));
            tasks.add(stderr);
            Future<?> stdin = streams.submit(() -> { try (OutputStream sink = child.getOutputStream()) { sink.write(request); }
                catch (IOException failure) { throw new SproutException("stdin", "Could not send JSON input", failure); } });
            tasks.add(stdin);
            if (!process.waitFor(options.hostTimeout().toMillis(), TimeUnit.MILLISECONDS))
                throw new SproutException("timeout", "Sprout host timeout expired");
            byte[] output = result(stdout), errors = result(stderr);
            if (process.exitValue() != 0)
                throw new SproutException("runtime", "Sprout exited " + process.exitValue() + ": " + new String(errors, StandardCharsets.UTF_8));
            result(stdin);
            String response;
            try { response = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output)).toString(); }
            catch (CharacterCodingException failure) { throw new SproutException("protocol", "Output is not valid UTF-8", failure); }
            if (response.endsWith("\n")) response = response.substring(0, response.length() - 1);
            if (response.endsWith("\r")) response = response.substring(0, response.length() - 1);
            if (response.isBlank() || response.indexOf('\n') >= 0 || response.indexOf('\r') >= 0)
                throw new SproutException("protocol", "Expected exactly one JSON output line");
            try { return JSON.readTree(response); }
            catch (IOException failure) { throw new SproutException("protocol", "Output is not strict JSON", failure); }
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new SproutException("canceled", "Sprout call was interrupted", failure);
        } catch (IOException failure) {
            throw new SproutException("spawn", "Could not start Sprout", failure);
        } catch (RejectedExecutionException failure) {
            throw new SproutException("closed", "Sprout host was closed", failure);
        } finally {
            if (process != null) {
                process.destroyForcibly();
                closeQuietly(process.getOutputStream()); closeQuietly(process.getInputStream()); closeQuietly(process.getErrorStream());
                active.remove(process);
            }
            tasks.forEach(f -> f.cancel(true));
            permits.release();
        }
    }

    private static <T> T result(Future<T> result) throws InterruptedException {
        try { return result.get(1, TimeUnit.SECONDS); }
        catch (ExecutionException failure) {
            if (failure.getCause() instanceof SproutException error) throw error;
            throw new SproutException("stream", "Could not read interpreter output", failure.getCause());
        } catch (TimeoutException failure) { throw new SproutException("stream", "Interpreter stream did not close", failure); }
    }
    private static byte[] read(InputStream stream, int limit, String code, Process child) throws IOException {
        try (stream; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) != -1) {
                if (bytes.size() > limit - count) { child.destroyForcibly(); throw new SproutException(code, "Interpreter stream exceeds byte limit"); }
                bytes.write(buffer, 0, count);
            }
            return bytes.toByteArray();
        }
    }
    private static void validateInput(JsonNode node, int depth) {
        if (depth > 128) throw new SproutException("input", "JSON nesting exceeds 128 levels");
        if (node.isFloatingPointNumber() && !Double.isFinite(node.doubleValue()))
            throw new SproutException("input", "Input must contain finite JSON numbers");
        if (node.isMissingNode() || node.isPojo() || node.isBinary()) throw new SproutException("input", "Input must contain plain JSON values");
        if (node.isContainerNode()) node.forEach(child -> validateInput(child, depth + 1));
    }
    private static void closeQuietly(Closeable stream) { try { stream.close(); } catch (IOException ignored) { } }
    @Override public void close() {
        closed.set(true);
        active.forEach(p -> { p.destroyForcibly(); closeQuietly(p.getOutputStream()); closeQuietly(p.getInputStream()); closeQuietly(p.getErrorStream()); });
        streams.shutdownNow();
    }
}
