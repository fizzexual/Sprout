using Sprout.Host;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class ProtocolSecurity
{
    [JsonConverter(typeof(ObservedConverter))]
    public sealed class Observed { public static int Calls; }
    public sealed class ObservedConverter : JsonConverter<Observed>
    {
        public override Observed Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => throw new NotSupportedException();
        public override void Write(Utf8JsonWriter writer, Observed value, JsonSerializerOptions options) { Observed.Calls++; writer.WriteStringValue("observed"); }
    }
    private static string Literal(string text) => "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    public static async Task WorkerBoundary(WorkerHost host, Func<string, string> source)
    {
        string[] invalid = {
            "{\"allow\":false,\"allow\":true}",
            "{\"allow\":false,\"\\u0061llow\":true}",
            "{\"outer\":{\"role\":\"reader\",\"role\":\"admin\"}}",
            "{\"amount\":1e999}", "-1e999",
            new string('[',129) + "0" + new string(']',129),
            new string('[',129) + new string(']',129),
            "{\"text\":\"\\ud800\"}", "{\"\\udc00\":true}",
            "{\"text\":\"\\u0000suffix\"}", "{\"\\u0000\":true}",
            "\n{}", "{}\n",
        };
        foreach (string wire in invalid)
        {
            try { await host.RunAsync(source("show " + Literal(wire) + "\n"), new {}); throw new Exception("Malformed worker output accepted: " + wire); }
            catch (SproutWorkerException error) when (error.Status == 6) { }
        }
        foreach (string wire in new[] {
            "{\"text\":\"\\ud83c\\udf31\",\"literal\":\"\\\\ud800\",\"replacement\":\"�\"}",
            "{\"value\":100000000000000000000,\"tag\":{\"$sprout.integer\":\"9223372036854775807\"}}",
            new string('[',128) + "0" + new string(']',128),
            new string('[',128) + new string(']',128),
        }) await host.RunAsync(source("show " + Literal(wire) + "\n"), new {});
        var recovered = await host.RunAsync(source("show json_encode({ok:yes})\n"), new {});
        if (!recovered.Value.GetProperty("ok").GetBoolean()) throw new Exception("Protocol rejection stranded host.");
    }
    public static async Task RequestBoundary(WorkerHost host, Func<string, string> source)
    {
        object aliased = "leaf";
        for (int i=0; i<18; i++) aliased = new object[] { aliased, aliased };
        Observed.Calls = 0;
        try { await host.RunAsync(source("fail \"must not run\"\n"), new object[] { aliased, new Observed() }); throw new Exception("Oversized alias request accepted."); }
        catch (ArgumentException) { }
        if (Observed.Calls != 0) throw new Exception("Oversized request was completely serialized before its cap.");
        try { await host.RunAsync(source("fail \"must not run\"\n"), new string('x',1_048_577)); throw new Exception("Oversized single text accepted."); }
        catch (ArgumentException) { }
        await host.RunAsync(source("show json_encode({ok:yes})\n"), new string('x',1_048_574));
        foreach (object value in new object[] { "\uD800", new { text = "\uDC00" }, new Dictionary<string,object> { ["\uD800"] = true }, new[] { "NUL\0suffix" } })
        {
            try { await host.RunAsync(source("fail \"must not run\"\n"), value); throw new Exception("Malformed host text reached worker."); }
            catch (JsonException) { }
        }
        foreach (string wire in new[] { "{\"allow\":false,\"allow\":true}", "{\"text\":\"\\u0000\"}", "1e999" })
        {
            using var document = JsonDocument.Parse(wire);
            try { await host.RunAsync(source("fail \"must not run\"\n"), document.RootElement); throw new Exception("Malformed request reached worker."); }
            catch (JsonException) { }
        }
    }
}
