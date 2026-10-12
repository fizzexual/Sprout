using Sprout.Host;
using System.Diagnostics;
using System.Text.Json;

// Regression diagnostics only: preserve the original failure and every budget.
internal static class WorkerControl
{
    public static async Task<WorkerResult> Observe(string control, Func<Task<WorkerResult>> invoke)
    {
        var clock = Stopwatch.StartNew();
        try { return await invoke(); }
        catch (SproutWorkerException error)
        {
            try
            {
                Console.Error.WriteLine("FAIL worker control " + JsonSerializer.Serialize(new {
                    control,
                    elapsed_ms = clock.Elapsed.TotalMilliseconds,
                    native_status = error.Status,
                    exit_code = error.ExitCode,
                    system_code = error.SystemCode,
                    diagnostics = Bound(error.Diagnostics),
                    message = Bound(error.Message)
                }));
            }
            catch { /* A diagnostic sink failure must not replace the worker failure. */ }
            throw;
        }
    }

    private static string Bound(string value) => value.Length <= 1024 ? value : value[..1024];

    public static async Task Verify()
    {
        using var document = JsonDocument.Parse("{\"ok\":true}");
        var success = new WorkerResult(document.RootElement.Clone(), "", 0);
        var returned = await Observe("synthetic success", () => Task.FromResult(success));
        if (!ReferenceEquals(success, returned)) throw new Exception("Diagnostic helper changed successful result.");

        var failure = new SproutWorkerException(2, 127, 89, new string('m', 2000), new string('d', 2000));
        TextWriter original = Console.Error;
        try
        {
            using var capture = new StringWriter();
            Console.SetError(capture);
            await RequireSameFailure(failure);
            string line = capture.ToString().Trim();
            const string prefix = "FAIL worker control ";
            if (!line.StartsWith(prefix, StringComparison.Ordinal)) throw new Exception("Missing worker observation.");
            using var report = JsonDocument.Parse(line[prefix.Length..]);
            var fields = report.RootElement;
            if (fields.GetProperty("control").GetString() != "synthetic failure" ||
                fields.GetProperty("native_status").GetInt32() != 2 ||
                fields.GetProperty("exit_code").GetInt32() != 127 ||
                fields.GetProperty("system_code").GetInt32() != 89 ||
                fields.GetProperty("diagnostics").GetString()!.Length != 1024 ||
                fields.GetProperty("message").GetString()!.Length != 1024 ||
                fields.GetProperty("elapsed_ms").GetDouble() < 0)
                throw new Exception("Worker observation lost or expanded bounded failure fields.");
            Console.SetError(new RefusingWriter());
            await RequireSameFailure(failure);
        }
        finally { Console.SetError(original); }
    }

    private static async Task RequireSameFailure(SproutWorkerException failure)
    {
        try { await Observe("synthetic failure", () => Task.FromException<WorkerResult>(failure)); }
        catch (SproutWorkerException observed) when (ReferenceEquals(observed, failure)) { return; }
        throw new Exception("Diagnostic helper masked the original worker failure.");
    }

    private sealed class RefusingWriter : StringWriter
    {
        public override void WriteLine(string? value) => throw new IOException("synthetic unavailable diagnostic sink");
    }
}
