# .NET host SDK

`Sprout.Host` targets .NET 8 or newer and uses the native C host ABI through
P/Invoke. It executes a fresh native Sprout process for each JSON request. The
application retains its web framework, database drivers, and deployment model;
Sprout can own external pricing, validation, or automation rules.

```csharp
var host = new WorkerHost("/absolute/path/sprout");
var result = await host.RunAsync("/absolute/path/rules.sprout",
    new { quantity = 10, unit_price = SproutValues.Decimal(12.50m) }, cancellationToken);
Console.WriteLine(result.Value.GetProperty("total"));
```

Build the small native host library from `src/embed.c`, then deploy
`sprout_host.dll` (Windows), `libsprout_host.so` (Linux), or
`libsprout_host.dylib` (macOS) beside the application. The architecture must match
the .NET process. The Sprout executable is deployed separately. Alternatively,
set `SPROUT_HOST_LIBRARY` to an absolute native library path before first use.
The SDK has no NuGet package dependencies. See `../native/README.md` for build
commands and platform details.

Defaults: language sandbox enabled, 5 seconds, 10 million execution steps,
1 MiB per output stream. Requests are bounded to 1 MiB UTF-8 JSON and responses
are parsed into a detached `JsonElement`. `HostOptions` configures deadlines,
step/output limits, a working directory, trusted `AllowIO`, and optional
`MaxMemoryBytes`. The memory option caps Windows total job committed memory or
POSIX address space per process; it is not a resident-memory measurement.
Cancellation joins callbacks before freeing native state and terminates owned
processes. POSIX ownership-pipe guardians cascade cleanup through a trusted
worker's nested Sprout subprocess groups after cancellation or abrupt owner
death; ordinary grandchildren are included. One extra guardian process is used
per live command. Intentionally detached `setsid`/`setpgid` descendants can escape.
Cleanup cannot undo effects already performed. Use an OS supervisor/container
for hostile source or stronger tenant lifecycle control.
`TimeoutException`, `OperationCanceledException`, or
`SproutWorkerException` report bounded failure; the last includes diagnostics,
status and exit code. Runtime deadlines may reach the worker first and produce
a `SproutWorkerException` with the runtime diagnostic.

Requests and responses require unique decoded object keys, finite JSON numbers,
at most 128 nested containers, and Unicode scalar text without NUL. Plain string
values and dictionary string keys are checked before the serializer can replace
unpaired UTF-16 surrogates. Serialized wire data is checked again. One optional
final LF or CRLF and horizontal whitespace are allowed; additional blank lines
are protocol errors. Ordinary large finite JSON numbers remain ordinary numbers;
the int64 contract applies to explicit exact-integer tags.
Requests serialize into a byte-capped stream rather than an unlimited final
string. Ordinary large text and JSON DOM values receive checks before writing;
alias expansion stops as the stream reaches its cap. Serializer buffers and
escaping can use additional bounded memory beyond the wire cap. Property
getters, enumerators and custom converters remain trusted application code;
their allocations and execution time are not covered by worker OS limits.

Exact integers, decimals, and bytes use `SproutValues` to encode the version 1
JSON tags. Returned tags remain explicit JSON objects. A Sprout decimal has a
signed 64-bit coefficient and at most 18 fractional places, which is narrower
than .NET `decimal`; out-of-range values are rejected. Sandbox policy and OS
process limits are distinct from a container or tenant isolation boundary.

The dependency-free console test harness exercises actual workers:

```sh
SPROUT_BINARY=/absolute/sprout SPROUT_HOST_LIBRARY=/absolute/libsprout_host.so \
  dotnet run --project tests
```
