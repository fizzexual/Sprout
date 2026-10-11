# Retrospective coverage qualification

`tools/deployment_coverage.py` independently qualifies the recorded aggregate
coverage of the frozen Windows eight-hour HTTP/SQLite profile. It reads reports
as data and never imports or executes the measured harness, SDK, native binary,
or any report-supplied path. It does not modify the original report or active
deployment. The thirty-minute baseline remains narrower historical evidence and
does not qualify as an eight-hour run.

The current policy was declared at **2026-10-11 21:41:33 UTC**, before the frozen run's
planned October 12 04:14 UTC completion. Its identifier is
`windows-http-sqlite-eight-hour-coverage-v2`; its SHA256 is
`e0fa18931226ba2c181d2700dea0da3e91fc9cba878c551232298cb9342bd0ee`.
The hash covers the `POLICY` object encoded as sorted-key, compact, ASCII JSON
without non-finite numbers. The exact object is in the auditor source. Future
policy changes need their own declaration and evidence rather than replacing
this policy after inspecting the completed run.

The earlier v1 policy was declared at **2026-10-11 21:32:18 UTC**, hash
`2996d5d90a400bfaae6dfd059551f7924201db95d7731d4f678b90eb98c36d65`.
Independent review found that 160 synthetic 59-second epochs with one sample
each made every per-epoch 60-second sampling check inapplicable, and v1 could
qualify that report despite only 9,440 seconds of host exposure. V2 supersedes
v1 before completion by adding the two aggregate exposure/sample floors below.
The original `POLICY_V1` definition/hash remain in source; v2 explicitly records
`supersedes_policy_sha256`. No completed-run result was used to choose the fix.

| Requirement | Frozen profile |
| --- | --- |
| Configuration | Windows; 28,800 seconds; rate 4 contacts/s; 8 clients; 4 native workers; bursts of 8; restart interval 180 seconds; contention interval 60 seconds; 2,000 contacts per SQLite shard |
| Logical write coverage | At least 95% of requested duration × rate: 109,440 completed contacts |
| Periodic health checks | At least 90% of floor(requested duration / 10): 2,592 checks |
| SQLite lock/recovery probes | At least 90% of floor(requested duration / contention interval): 432 probes |
| Closed host sampling | For every closed epoch lasting at least 60 seconds, samples × 0.1 / epoch duration must be at least 85% |
| Aggregate closed-host exposure | Sum of all closed epoch durations / recorded traffic duration must be at least 95% |
| Aggregate closed-host sampling | Sum of all closed host samples × 0.1 / recorded traffic duration must be at least 85%, including short epochs |
| Closed host duration | Every closed epoch must be at most restart interval + 60 seconds: 240 seconds |
| Host RSS | Sampled peak at most 128 MiB; retained growth at most 64 MiB |
| Windows handles | Sampled peak at most 512; retained growth at most 128 |
| Storage | Recorded workspace at most 256 MiB; recorded and actual input report at most 4 MiB |

The recorded resource ceilings must match the policy. Completion requires the
exact `finished` state and actual boolean `passed`, `workload_completed`, and
`frozen_inputs_unchanged` values of `true`; no stop request or errors; traffic
duration at least the configured duration; elapsed duration at least traffic
duration; no active host; and consistent closed-host counts. Each closed host
must record successful native exits, empty active-process/error lists, thread
baseline restoration, positive integer resource metrics and sampling counts,
and native concurrency within four workers. Missing fields, booleans used as
numbers, non-finite numbers, and inconsistent recorded endpoints fail closed.

The auditor cross-checks bursts against contacts, latency sample counts against
logical contacts and POST attempts, duplicate and oracle counts against the
frozen schedule, native launch totals against observed worker requests, and
verified shard records against contacts. Lost successful responses can be
reconciled by a retry returning 409: successful 201 responses plus recorded
ambiguous commits must equal completed contacts. The auditor does not require
every completed contact to have an observed 201.

Run the auditor after completion, choosing a **new separate output file**:

```sh
python tools/deployment_coverage.py /path/to/original-report.json \
  --workspace /path/to/explicit-trusted-workspace \
  --output /path/to/new-qualification.json
```

`--workspace` is optional. When supplied, the auditor checks only these fixed
files under that workspace's `frozen` directory:

- `bin/sprout.exe`
- `tools/deployment_soak.py`
- `integrations/python/sprout_host.py`
- `integrations/python/sprout_service.py`
- `examples/services/contacts.sprout`

Their hashes must match the report's exact named inventory. Paths must remain
inside the explicit frozen root, contain no symlink/reparse point, and reference
regular files of at most 64 MiB each. The report's own workspace/path fields
never select files to read. This verifies **snapshot consistency**, not source
authenticity or candidate identity: candidate provenance requires separately
trusted frozen hashes and source/build evidence. Without `--workspace`, the
qualification explicitly records that files were not independently checked.

Reports are ordinary local trusted engineering evidence, not signed telemetry.
The reader caps input at 4 MiB, rejects nonregular/symlink inputs, malformed
UTF-8/JSON, duplicate decoded keys, and non-finite JSON numbers. Output files
are created exclusively and cannot overwrite the input, an existing
qualification, or a file inside an explicitly supplied frozen directory.

Output schema 1 records the input report's byte length and SHA256, policy
identifier/hash, audit time, observations, and bounded reasons for rejection:

| Status | `passed` | Exit code | Meaning |
| --- | --- | --- | --- |
| `qualified` | `true` | 0 | Completed report satisfies this aggregate policy and recorded consistency checks |
| `insufficient_coverage` | `false` | 1 | Well-shaped completed report falls below a floor or exceeds the epoch duration cap |
| `invalid_report` | `false` | 1 | Completion, shape, consistency, integrity marker, or resource/storage evidence is invalid |
| `pending` | `null` | 2 | A running snapshot is an observation, never completed qualification |

A pending snapshot can contain observations or issues, but cannot become a
completed pass. Automation should handle exit code 2 separately from failure.
Unreadable/malformed input or an unusable output path rejects the command
without writing a qualification. The original report remains untouched.

These are **aggregate floors**. A report lacking event-gap telemetry cannot
establish maximum traffic gaps or uninterrupted uptime, even if it qualifies.
Sampling can miss transient resource peaks. This audit does not establish
crash/high-availability recovery, remote network behavior, authenticity of
submitted metrics, or production certification. Tests include a historical
false-pass shape with only eight contacts despite a claimed eight-hour clock,
the short-epoch sampling exemption found during independent review,
healthy and ambiguous-write fixtures, exact floor boundaries, partial/running
states, invalid telemetry, count inconsistencies, and frozen-source mismatch.

```sh
python src/tests/deployment_coverage_test.py
```
