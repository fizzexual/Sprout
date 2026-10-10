using Sprout.Host;
using System.Text.Json;

string executable = Environment.GetEnvironmentVariable("SPROUT_BINARY") ?? throw new Exception("Set SPROUT_BINARY to a native Sprout executable.");
string root = Path.Combine(Path.GetTempPath(), "sprout-dotnet-" + Guid.NewGuid());
Directory.CreateDirectory(root);
int passed = 0;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
string Source(string source) { string file = Path.Combine(root, Guid.NewGuid() + " worker's source.sprout"); File.WriteAllText(file, source); return file; }
async Task Test(string name, Func<Task> body) { await body(); passed++; Console.WriteLine("PASS " + name); }
try
{
    var host = new WorkerHost(executable);
    await Test("JSON exact values and Unicode", async () => {
        var r = await host.RunAsync(Source("show json_encode(json_decode(read_input()))\n"), new { name = "🌱 Привіт", id = SproutValues.Integer(long.MaxValue), money = SproutValues.Decimal(0.10m), bytes = SproutValues.Bytes(new byte[] {0,255}) });
        Check(r.Value.GetProperty("name").GetString() == "🌱 Привіт", "Unicode changed");
        Check(r.Value.GetProperty("id").GetProperty("$sprout.integer").GetString() == long.MaxValue.ToString(), "exact integer changed");
        Check(r.Value.GetProperty("bytes").GetProperty("$sprout.bytes").GetString() == "00ff", "bytes changed");
    });
    await Test("sandbox, output bound, and JSON validation", async () => {
        try { await host.RunAsync(Source("show file_read(\"forbidden\")\n"), new {}); throw new Exception("sandbox accepted I/O"); }
        catch (SproutWorkerException e) { Check(e.Status == 5 && e.Diagnostics.Contains("sandbox"), "wrong sandbox error"); }
        var bounded = new WorkerHost(executable, new() {MaxOutputBytes = 32});
        try { await bounded.RunAsync(Source("show \"" + new string('x',10000) + "\"\n"), new {}); throw new Exception("output overflow accepted"); }
        catch (SproutWorkerException e) { Check(e.Status == 4, "wrong output error"); }
        try { await host.RunAsync(Source("show \"invalid-json\"\n"), new {}); throw new Exception("invalid JSON accepted"); }
        catch (SproutWorkerException e) { Check(e.Status == 6, "wrong JSON error"); }
        var r = await host.RunAsync(Source("show json_encode({ready:yes})\n"), new {}); Check(r.Value.GetProperty("ready").GetBoolean(), "failed recovery");
    });
    await Test("cancellation, timeout, and recovery", async () => {
        var loop = Source("repeat while yes:\n    make n = 1\n");
        var bounded = new WorkerHost(executable, new() {Timeout = TimeSpan.FromSeconds(3), MaxSteps = 1_000_000_000_000});
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        try { await bounded.RunAsync(loop, new {}, cancellation.Token); throw new Exception("cancellation ignored"); }
        catch (OperationCanceledException) {}
        bounded = new WorkerHost(executable, new() {Timeout = TimeSpan.FromMilliseconds(50), MaxSteps = 1_000_000_000_000});
        try { await bounded.RunAsync(loop, new {}); throw new Exception("timeout ignored"); }
        catch (TimeoutException) {}
        catch (SproutWorkerException e) { Check(e.Status == 5 && e.Diagnostics.Contains("deadline"), "wrong runtime deadline error"); }
        var r = await host.RunAsync(Source("show json_encode(42)\n"), new {}); Check(r.Value.GetInt32() == 42, "failed recovery");
    });
    await Test("concurrent workers", async () => {
        string source = Source("show json_encode(json_decode(read_input()))\n");
        await Task.WhenAll(Enumerable.Range(0,8).Select(async i => { var r=await host.RunAsync(source,new {n=i}); Check(r.Value.GetProperty("n").GetInt32()==i,"cross-worker state leak"); }));
    });
    await Test("request and decimal validation", async () => {
        try { await host.RunAsync(Source("show json_encode(42)\n"), new string('x',1_048_576)); throw new Exception("oversize accepted"); } catch (ArgumentException) {}
        try { SproutValues.Decimal(decimal.MaxValue); throw new Exception("unrepresentable decimal accepted"); } catch (ArgumentOutOfRangeException) {}
        try { _=new WorkerHost("relative"); throw new Exception("relative path accepted"); } catch (ArgumentException) {}
    });
    await Test("external pricing rules", async () => {
        string rules = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"..","..","..","..","examples","rules.sprout"));
        var r=await host.RunAsync(rules,new {quantity=10,unit_price=SproutValues.Decimal(12.50m)});
        string total=r.Value.GetProperty("total").GetProperty("$sprout.decimal").GetString()!; Check(total is "112.5" or "112.50", "unexpected pricing result: "+total);
    });
    Console.WriteLine($"{passed} .NET host tests passed.");
}
finally { Directory.Delete(root, true); }
