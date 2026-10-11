using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sprout.Host;

public sealed record HostOptions
{
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(5);
    public ulong MaxSteps { get; init; } = 10_000_000;
    public int MaxOutputBytes { get; init; } = 1_048_576;
    public ulong MaxMemoryBytes { get; init; }
    public string? WorkingDirectory { get; init; }
    public bool AllowIO { get; init; }
}
public sealed record WorkerResult(JsonElement Value, string Diagnostics, int ExitCode);
public sealed class SproutWorkerException(int status, int exitCode, int systemCode, string message, string diagnostics) : Exception(message)
{
    public int Status { get; } = status;
    public int ExitCode { get; } = exitCode;
    public int SystemCode { get; } = systemCode;
    public string Diagnostics { get; } = diagnostics;
}

/// <summary>Immutable, process-isolated JSON worker host. Safe for concurrent calls.</summary>
public sealed class WorkerHost
{
    private const int MaxRequestBytes = 1_048_576;
    private readonly string executable;
    private readonly HostOptions options;
    private static readonly JsonSerializerOptions RequestJson = CreateRequestOptions();
    public WorkerHost(string executable, HostOptions? options = null)
    {
        RequireAbsolute(executable, nameof(executable));
        this.options = options ?? new();
        if (this.options.WorkingDirectory is not null) RequireAbsolute(this.options.WorkingDirectory, nameof(HostOptions.WorkingDirectory));
        if (this.options.Timeout < TimeSpan.FromMilliseconds(1) || this.options.Timeout > TimeSpan.FromHours(1) || this.options.MaxSteps is 0 or > 1_000_000_000_000 || this.options.MaxOutputBytes is < 1 or > 16_777_216)
            throw new ArgumentOutOfRangeException(nameof(options), "Invalid timeout, step, or output limit.");
        if (this.options.MaxMemoryBytes != 0 && (this.options.MaxMemoryBytes < 16_777_216 || this.options.MaxMemoryBytes > 1UL << 46))
            throw new ArgumentOutOfRangeException(nameof(options), "Memory cap must be zero or from 16 MiB to 64 TiB.");
        this.executable = executable;
        if (Native.sprout_host_abi_version() != 1) throw new NotSupportedException("Sprout native host ABI1 is required.");
    }
    public Task<WorkerResult> RunAsync<T>(string program, T request, CancellationToken cancellationToken = default)
    {
        RequireAbsolute(program, nameof(program));
        cancellationToken.ThrowIfCancellationRequested();
        using var encoded = new BoundedRequestStream(cancellationToken);
        JsonSerializer.Serialize(encoded, request, RequestJson);
        var payload = Encoding.UTF8.GetString(encoded.ToArray());
        using (var document = JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 128 }))
            ValidateWireValue(document.RootElement);
        return Task.Run(() => Run(program, payload, cancellationToken), CancellationToken.None);
    }
    private WorkerResult Run(string program, string payload, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var strings = new List<IntPtr>();
        IntPtr cancel = IntPtr.Zero;
        Native.Result result = default;
        try
        {
            IntPtr Utf8(string value) { var p = Marshal.StringToCoTaskMemUTF8(value); strings.Add(p); return p; }
            Native.Options native = default;
            Native.sprout_host_options_init_sized(ref native, (nuint)Marshal.SizeOf<Native.Options>());
            native.Executable = Utf8(executable); native.Program = Utf8(program); native.Request = Utf8(payload);
            if (options.WorkingDirectory is not null) native.Cwd = Utf8(options.WorkingDirectory);
            native.RequestLength = (nuint)Encoding.UTF8.GetByteCount(payload);
            native.TimeoutMs = (uint)options.Timeout.TotalMilliseconds; native.MaxSteps = options.MaxSteps;
            native.MaxOutput = (nuint)options.MaxOutputBytes; native.Flags = options.AllowIO ? 1u : 0;
            native.MaxMemory = options.MaxMemoryBytes;
            cancel = Native.sprout_host_cancel_new();
            if (cancel == IntPtr.Zero) throw new OutOfMemoryException("Could not allocate native cancellation handle.");
            int status;
            // Disposing the registration joins in-flight callbacks before cancel is freed.
            using (token.Register(() => Native.sprout_host_cancel_request(cancel)))
                status = Native.sprout_host_run_cancellable(ref native, out result, cancel);
            string diagnostics = Utf8Text(result.Diagnostics, result.DiagnosticsLength);
            string message = Marshal.PtrToStringUTF8(result.Error) ?? $"Sprout worker failed with status {status}.";
            if (status == 8) throw new OperationCanceledException(message, token);
            if (status == 3) throw new TimeoutException(message);
            if (status != 0) throw new SproutWorkerException(status, result.ExitCode, result.SystemCode, message, diagnostics);
            try
            {
                using var document = JsonDocument.Parse(Utf8Text(result.Output, result.OutputLength), new JsonDocumentOptions { MaxDepth = 128 });
                ValidateWireValue(document.RootElement);
                return new(document.RootElement.Clone(), diagnostics, result.ExitCode);
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException) { throw new SproutWorkerException(6, result.ExitCode, result.SystemCode, $"Worker output is invalid JSON: {error.Message}", diagnostics); }
        }
        finally
        {
            if (cancel != IntPtr.Zero) Native.sprout_host_cancel_free(cancel);
            Native.sprout_host_result_free(ref result);
            foreach (var p in strings) Marshal.FreeCoTaskMem(p);
        }
    }
    private static string Utf8Text(IntPtr p, nuint length) => length == 0 ? "" : Marshal.PtrToStringUTF8(p, checked((int)length))!;
    private static JsonSerializerOptions CreateRequestOptions()
    {
        var options = new JsonSerializerOptions { MaxDepth = 128 };
        options.Converters.Add(new StrictTextConverter());
        options.Converters.Add(new StrictElementConverter());
        options.Converters.Add(new StrictDocumentConverter());
        return options;
    }
    private sealed class BoundedRequestStream(CancellationToken token) : Stream
    {
        private readonly MemoryStream bytes = new();
        public byte[] ToArray() => bytes.ToArray();
        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            token.ThrowIfCancellationRequested();
            if (buffer.Length > MaxRequestBytes - bytes.Length) throw new ArgumentException("Request JSON exceeds 1 MiB.");
            bytes.Write(buffer);
        }
        public override void Flush() => token.ThrowIfCancellationRequested();
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => bytes.Length;
        public override long Position { get => bytes.Position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) bytes.Dispose(); base.Dispose(disposing); }
    }
    private sealed class StrictTextConverter : JsonConverter<string>
    {
        public override string? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
        { var text = reader.GetString(); if (text is not null) ValidateWireText(text); return text; }
        public override void Write(Utf8JsonWriter writer, string text, JsonSerializerOptions options)
        { ValidateRequestText(text); writer.WriteStringValue(text); }
        public override void WriteAsPropertyName(Utf8JsonWriter writer, string text, JsonSerializerOptions options)
        { ValidateRequestText(text); writer.WritePropertyName(text); }
    }
    private sealed class StrictElementConverter : JsonConverter<JsonElement>
    {
        public override JsonElement Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
        { using var value = JsonDocument.ParseValue(ref reader); return value.RootElement.Clone(); }
        public override void Write(Utf8JsonWriter writer, JsonElement value, JsonSerializerOptions options)
        { int budget = MaxRequestBytes; ValidateRequestElement(value, ref budget); value.WriteTo(writer); }
    }
    private sealed class StrictDocumentConverter : JsonConverter<JsonDocument>
    {
        public override JsonDocument Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => JsonDocument.ParseValue(ref reader);
        public override void Write(Utf8JsonWriter writer, JsonDocument value, JsonSerializerOptions options)
        { int budget = MaxRequestBytes; ValidateRequestElement(value.RootElement, ref budget); value.WriteTo(writer); }
    }
    private static void ValidateRequestText(string text)
    {
        if (text.Length > MaxRequestBytes) throw new ArgumentException("Request JSON exceeds 1 MiB.");
        ValidateWireText(text);
    }
    private static void ChargeRequest(ref int budget, int count)
    {
        if (count > budget) throw new ArgumentException("Request JSON exceeds 1 MiB.");
        budget -= count;
    }
    private static void ValidateRequestElement(JsonElement value, ref int budget, int depth = 0)
    {
        if ((value.ValueKind is JsonValueKind.Array or JsonValueKind.Object) && depth >= 128) throw new JsonException("JSON nesting exceeds 128 containers.");
        ChargeRequest(ref budget, 1);
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in value.EnumerateObject())
                {
                    ChargeRequest(ref budget, property.Name.Length + 2);
                    ValidateRequestText(property.Name);
                    ValidateRequestElement(property.Value, ref budget, depth + 1);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray()) ValidateRequestElement(item, ref budget, depth + 1);
                break;
            case JsonValueKind.String:
                string text = value.GetString()!;
                ChargeRequest(ref budget, text.Length);
                ValidateRequestText(text);
                break;
        }
    }
    private static void ValidateWireValue(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    ValidateWireText(property.Name);
                    if (!keys.Add(property.Name)) throw new JsonException("Duplicate JSON object key.");
                    ValidateWireValue(property.Value);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray()) ValidateWireValue(item);
                break;
            case JsonValueKind.String:
                ValidateWireText(value.GetString()!);
                break;
            case JsonValueKind.Number:
                if (!value.TryGetDouble(out double number) || !double.IsFinite(number)) throw new JsonException("JSON number must be finite.");
                break;
        }
    }
    private static void ValidateWireText(string text)
    {
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '\0') throw new JsonException("Sprout JSON text cannot contain NUL.");
            if (char.IsHighSurrogate(c))
            {
                if (++i >= text.Length || !char.IsLowSurrogate(text[i])) throw new JsonException("Unpaired JSON surrogate.");
            }
            else if (char.IsLowSurrogate(c)) throw new JsonException("Unpaired JSON surrogate.");
        }
    }
    private static void RequireAbsolute(string path, string name)
    {
        if (string.IsNullOrEmpty(path) || !Path.IsPathFullyQualified(path) || path.Contains('\0')) throw new ArgumentException("Path must be absolute and contain no NUL bytes.", name);
    }
}

public static class SproutValues
{
    public static Dictionary<string, string> Integer(long value) => new() { ["$sprout.integer"] = value.ToString(CultureInfo.InvariantCulture) };
    public static Dictionary<string, string> Decimal(decimal value)
    {
        string text = value.ToString(CultureInfo.InvariantCulture);
        int dot = text.IndexOf('.');
        if ((dot >= 0 && text.Length - dot - 1 > 18) || !long.TryParse(text.Replace(".", ""), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _))
            throw new ArgumentOutOfRangeException(nameof(value), "Sprout decimal requires an int64 coefficient and at most 18 decimal places.");
        return new() { ["$sprout.decimal"] = text };
    }
    public static Dictionary<string, string> Bytes(ReadOnlySpan<byte> bytes) => new() { ["$sprout.bytes"] = Convert.ToHexString(bytes).ToLowerInvariant() };
}

internal static class Native
{
    private const string Library = "sprout_host";
    static Native()
    {
        string? path = Environment.GetEnvironmentVariable("SPROUT_HOST_LIBRARY");
        if (path is not null)
        {
            if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("SPROUT_HOST_LIBRARY must be absolute.");
            NativeLibrary.SetDllImportResolver(typeof(Native).Assembly, (name, assembly, search) => name == Library ? NativeLibrary.Load(path) : IntPtr.Zero);
        }
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Options
    {
        public nuint StructSize; public IntPtr Executable, Program, Cwd, Request; public nuint RequestLength;
        public uint TimeoutMs; public ulong MaxSteps; public nuint MaxOutput; public uint Flags; public ulong MaxMemory;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Result
    {
        public nuint StructSize; public int Status, ExitCode, SystemCode, TimedOut, Truncated;
        public IntPtr Output; public nuint OutputLength; public IntPtr Diagnostics; public nuint DiagnosticsLength; public IntPtr Error;
    }
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern uint sprout_host_abi_version();
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void sprout_host_options_init_sized(ref Options options, nuint size);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr sprout_host_cancel_new();
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void sprout_host_cancel_request(IntPtr cancel);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void sprout_host_cancel_free(IntPtr cancel);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern int sprout_host_run_cancellable(ref Options options, out Result result, IntPtr cancel);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] internal static extern void sprout_host_result_free(ref Result result);
}
