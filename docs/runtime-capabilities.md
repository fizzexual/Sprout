# Compiled runtime metadata

Run a trusted interpreter with exactly one argument:

```sh
sprout --capabilities-json
```

The command prints one ASCII JSON line and returns0 only when its output is
written and flushed. Extra arguments return2 with usage on stderr. The flag is
recognized only in the first argument position, before interpreter initialization
or bundle inspection. It reads no program, project configuration, package,
database or stdin and executes no feature to probe it.

Schema1 has `runtime` target kind/OS family/architecture, six boolean `features`,
the compiled transport for `http_request_v1`, and `host_library`. The latter is
always `included:false, abi_version:null` for this interpreter. The separate C
host library supplies its own `sprout_host_abi_version()` query. Version text is
available through the existing `sprout version`; it is not a capability gate.

The feature keys are `intrinsic_calls_v1`, `sqlite_adapter_v1`,
`native_processes_v1`, `http_request_v1`, `workflow_plan_v1` and
`workflow_run_v1`. Intrinsic calls and pure workflow planning are compiled in
both native and Emscripten targets. SQLite follows the actual `SPROUT_SQLITE`
definedness used by the adapter. Native processes, checked HTTP requests and
workflow execution are unavailable in the Emscripten target. Unknown target
architecture/family is explicit; `darwin` identifies the Apple OS family.

For checked `request`/`http.request`, Windows declares WinHTTP and other native
targets declare an external `curl` requirement. The query does not load WinHTTP,
check curl or make a request. This transport entry does not describe the legacy
`http_get` implementation. Compiled availability does not grant sandbox or I/O
permissions, establish OS-account access or tool readiness, authenticate a build,
identify a publisher, attest provenance or certify an application.

The same first-position query works on a native bundle and skips its payload,
footer and asset extraction. It describes the compiled interpreter in that
artifact, not whether the artifact is a pure interpreter or a trusted bundle.
Keep normal application flags after the separator:

```sh
sprout run app.sprout -- --capabilities-json
```

That flag remains an application argument. Other first arguments, including
the word `capabilities`, retain existing behavior. SDK/doctor consumers are
unchanged; there is no automatic probe or adoption. A future explicit consumer
must require a trusted command, bound output/time, reject nonzero exit and
invalid/unsupported metadata, and keep permissions/build identity separate.

Pure decoder controls reject unknown fields/types, nonfinite values and
contradictory target/feature/transport records. They accept both SQLite boolean
values for WASM because adapter availability follows compiled definedness.
These schema controls execute no runtime or compiler.

The dedicated regression models copy the exact helper and early guard bytes
and test native/WASM/unknown macro selections, including `SPROUT_SQLITE=0`'s
definedness and write/flush errors. Models are not actual target builds.
Required real native controls cover the fixed schema/bound, runtime environment,
literal application forwarding and a bundle with declared assets. Actual WASM
qualification uses a fresh instance with no source mount; both native and WASM
qualification remain separate from prior revisions and historical failures.
