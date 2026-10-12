# Frozen synthetic workload observations

`v1-spec.json` describes the fixed workload. The
[derived observations](2026-10-12-windows-observations.json) contain one Windows
normal-collector run on revision `6b8c72454d190a06357fc7ef54cc58764f2c3c02`, native
SHA256 `4ffec927c66a1237c796257b2120fa638e246736d1c52337ecfa87c8fd3821bf`.
They are historical data, separate from current tooling/runtime changes.

There are204 observations,34 retained warmups and five measured samples for
each case/mode. All raw timing samples and negative paired differences remain.
Python and Node each have24 explicitly labeled SDK rows. SDK native-child peaks
are unavailable; parent observations do not replace them. Captures are represented
by518 hashes/byte counts; raw bodies, local paths, usernames and PIDs are omitted.

The original report SHA256 is
`b5aeafe9e266375355f7940a5577f255827b7b0134e9cb0234aeb98e0855c36e`;
snapshot manifest SHA256 is
`1eb4421e279ddbebaf719bb8f91f5a45f25e77d018dd6c04b6ed7ba3c251207a`.
The original controller was
`b5a0b0e4c833e5a0403d25a0681c2397e120fb695a42e7615755f649c5ef7cce`.
Machine-local raw evidence remains separately preserved and reviewed.

An initial private export, SHA256
`be40a1a20ad77d8836fec55b0a6e537ae2d91cf1143b4dd60a16c5bda2334e9f`,
omitted the48 SDK host labels. The file here restores only those original labels;
every other decoded value matches that preserved export. Its SHA256 is
`5fd7a220e3c2895079a9d8af3a01a15d4d500ab9bc521b6f0fc961a375742d24`.
This is an additive correction to already captured data. No workload was rerun.
Independent exact-file review checked attribution and privacy before this copy.

One machine/five samples do not establish language rankings, tail percentiles,
an SLA, representative deployment or eight-hour qualification. Preparation,
timing scopes, memory limitations and inspection/one-run controls are described
in [the measurement documentation](../../docs/performance-workloads.md).
