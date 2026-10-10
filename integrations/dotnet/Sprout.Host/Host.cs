using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

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
    private readonly string executable;
    private readonly HostOptions options;
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
        var payload = JsonSerializer.Serialize(request);
        if (Encoding.UTF8.GetByteCount(payload) > 1_048_576) throw new ArgumentException("Request JSON exceeds 1 MiB.", nameof(request));
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
                return new(document.RootElement.Clone(), diagnostics, result.ExitCode);
            }
            catch (JsonException error) { throw new SproutWorkerException(6, result.ExitCode, result.SystemCode, $"Worker output is invalid JSON: {error.Message}", diagnostics); }
        }
        finally
        {
            if (cancel != IntPtr.Zero) Native.sprout_host_cancel_free(cancel);
            Native.sprout_host_result_free(ref result);
            foreach (var p in strings) Marshal.FreeCoTaskMem(p);
        }
    }
    private static string Utf8Text(IntPtr p, nuint length) => length == 0 ? "" : Marshal.PtrToStringUTF8(p, checked((int)length))!;
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
