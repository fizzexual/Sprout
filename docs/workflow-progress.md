# Recorded workflow progress

`lib/workflow_progress.sprout` summarizes the sanitized result of
[`workflow.inspect`](workflow-tools.md). Its single public task is pure:

```sprout
use "lib/workflow_progress.sprout"
make result = workflow_progress.summarize(snapshot, expected_fingerprint)
```

`summarize(snapshot, expected_fingerprint = nothing)` reads no file, launches no
job and changes no input. It checks the inspection-summary shape and recomputes
job counts and an exact integer attempt total. A malformed or inconsistent
summary yields a fixed error and no partial counts.

Use an intrinsic-capable pinned runtime and the matching library revision. The
new module needs separate integrated native/WebAssembly verification; CI for an
earlier source revision does not cover it.

## One native read-only snapshot

The [progress CLI](../examples/workflows/progress.sprout) performs one
`builtin::workflow_inspect` read, then prints a bounded JSON summary:

```sh
sprout run examples/workflows/progress.sprout report.checkpoint.json --max-steps 1000000 --timeout-ms 3000
sprout run examples/workflows/progress.sprout report.checkpoint.json EXPECTED_SHA256
```

The optional fingerprint is the full 64-character hexadecimal fingerprint of
the ordered job specification, such as `workflow.plan(jobs).fingerprint`.
Hexadecimal case is ignored. Correlation to a caller-supplied hash does not
authenticate the checkpoint or prove external side effects completed.

Exit codes are zero for recorded completion, two for a valid incomplete
snapshot, three for bad arguments/unavailable or inconsistent state, and four
for a supplied fingerprint mismatch. Mismatch takes precedence over recorded
completion. `--help` prints plain usage text. Otherwise stdout contains exactly
one JSON line, at most 4 KiB including its line ending; no report file is written.
The checkpoint argument is nonempty text capped at 4,096 UTF-8 bytes.

Inspection leaves checkpoint bytes/mtime and any `.lock` file unchanged. It
neither acquires the workflow execution lock nor unlocks work. Concurrent atomic
replacement can yield an earlier or later coherent snapshot; no statement about
the file's latest live state follows. Native filesystem permission is required;
the CLI is unavailable in the language sandbox and browser WebAssembly. The pure
task can consume supplied summaries in those environments.

## States and results

A successful result contains:

```text
{
  ok: true, code: "ok", error: null,
  state: "uncertain", count: 4,
  counts: {pending: 1, running: 1, done: 1, failed: 1},
  attempts_total: {"$sprout.integer": "4"},
  recorded_complete: false,
  fingerprint: "64 lowercase hexadecimal characters",
  expected_matches: null
}
```

The following priority determines `state`:

| Recorded entries | State |
| --- | --- |
| Any `running` entry | `uncertain`, including a mixture with failed work |
| Otherwise any `failed` entry | `failed` |
| Every entry is `done` | `complete` |
| Otherwise some `done` entries | `partial` |
| All entries are `pending` | `pending` |

`ok` means the snapshot is internally consistent. `recorded_complete` means all
recorded statuses are done. `expected_matches` is `nothing` when no hash was
supplied; false does not change the snapshot's recorded completion. The counts
remain visible when uncertain/failed, without silently classifying them as
successful completion or safe recovery.

There is no heartbeat, PID/liveness evidence or last-update time in this
summary. A recorded running job may still be active or may have been interrupted;
its external effects are uncertain. A failed process may already have produced
effects. Done means recorded process success, without independent application
verification. There is no ETA, retry eligibility, idempotence assessment,
resume action or automatic reconciliation. Use the existing
[workflow recovery contract](workflows.md) and application evidence before
replaying anything.

No command, stdin, process-result payload, stdout, stderr, job ID or input path
appears in this module's output. The fingerprint and counts can still be
sensitive operational metadata. Failed inspection preserves the native code
`not_found`, `io`, `limit` or `invalid_checkpoint`, with a fixed message rather
than raw native diagnostics. `invalid_summary` and `invalid_expectation` are
the pure task's other failure codes. All failures return state `unavailable` and
`nothing` for count/counts/attempts/completion/fingerprint/match fields.

## Checked shape and bounds

Successful inputs have exactly the native summary fields `ok`, `error`, `code`,
`version`, `fingerprint`, `count`, `complete`, `counts` and `jobs`. Version is one;
error is `nothing`; code is `"ok"`. Each job has exactly `id`, `status` and
`attempts`. Unknown fields are rejected by the pure task, even though the native
checkpoint reader tolerates unknown metadata before producing its summary.

Counts/attempts/version accept whole ordinary numbers or exact integers in their
bounded ranges; booleans, decimals and non-finite values are rejected. Declared
counts and completion must agree with the jobs. Output count fields are small
ordinary numbers; `attempts_total` is always an exact integer.

| Bound | Limit |
| --- | --- |
| Jobs | 1–128, with unique IDs |
| Job ID | 1–64 UTF-8 bytes, checked UTF-8 without NUL |
| Status | `pending`, `running`, `done` or `failed` |
| Per-job attempts | 0–1,000,000 |
| Total attempts | At most 128,000,000, computed exactly |
| Fingerprint | Exactly 64 ASCII hexadecimal characters |
| Native inspection file | At most 24 MiB, through the existing reader |
| Failed-input diagnostic text | At most 256 characters, never returned |
| Pure shape | Fixed shallow maps and a list of at most 128 three-field jobs |

The fixed shape has no recursive descent or general deep copy. Cyclic containers,
objects or tasks in required positions fail its shape/kind checks. Returned maps
are fresh; changing a result does not change the supplied summary. Helpers are
captured task values and native calls are explicit. These bounds do not limit
memory already used by a caller or turn scans inside a native builtin into a
hard CPU limit. Retain host/CLI step, time and output budgets. A hard runtime
budget failure can terminate the CLI without its ordinary JSON report.

## Verification

```sh
python src/tests/workflow_progress_test.py /path/to/verified-sprout
sprout test src/tests/workflow_progress_test.sprout
```

The six-test shared corpus is pure and intended for real WebAssembly integration.
Native controls use synthetic checkpoints only: state/counter oracles, UTF-8 byte
limits, error privacy, detachment, finite cyclic rejection, callback exclusion,
unchanged bytes/mtime/locks, strict terminal results, bounded reader failures and
concurrent atomic replacement. They never execute or recover a workflow job and
do not qualify sustained deployment or external effects.
