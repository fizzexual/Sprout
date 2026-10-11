# Plan a workflow and inspect its checkpoint

`workflow.plan(jobs)` validates a command DAG and describes its dependency layers
without executing commands or touching the filesystem. `workflow.inspect(path)`
reads a bounded checkpoint summary without running jobs, recovering interrupted
work, or changing the file. Both have global equivalents: `workflow_plan(jobs)`
and `workflow_inspect(path)`.

```sprout
use workflow
make jobs = [
    {id: "fetch", argv: ["python", "fetch.py"], idempotent: yes},
    {id: "north", argv: ["python", "report.py", "north"], after: ["fetch"]},
    {id: "south", argv: ["python", "report.py", "south"], after: ["fetch"]},
    {id: "publish", argv: ["python", "publish.py"], after: ["north", "south"]}
]
make plan = workflow.plan(jobs)
show plan.layers
~ [["fetch"], ["north", "south"], ["publish"]]
```

## Pure planning

The result is `{ok: yes, count, fingerprint, order, layers}`. `order` is the
flattened layers. Jobs keep their input order within each layer, and a job enters
the next layer only after all its dependencies belonged to earlier layers.
Reordering input jobs can therefore change the order of independent peers.
The fingerprint is the same SHA-256 of the complete serialized, ordered job
specification used by `workflow.run`; it is not a hash of dependency ids alone.

Planning shares execution's job validation: 1–128 maps, unique ids of 1–64 UTF-8
bytes, argv lists of 1–256 text entries, a nonempty executable, known option keys,
bounded command/stdin/output sizes and timeouts, and `retries: 0..5` only with
`idempotent: yes`. Dependencies must name jobs, cannot repeat, and cannot form
cycles. Invalid specifications raise an error before any command launches.
Planning does not check whether an executable exists or promises to succeed.

Planning is pure and permitted in the language sandbox and WebAssembly runtime.
Its layers describe dependency readiness, not a schedule or a timing estimate.
`workflow.run` still applies its worker cap, retries, cancellation, persistence,
and batch semantics; inspection/planning does not bypass any execution permission.

## Read-only inspection

```sprout
use workflow
make summary = workflow.inspect("report.checkpoint.json")
when summary.ok:
    show summary.complete, summary.counts
    for each job in summary.jobs:
        show job.id, job.status, job.attempts
otherwise:
    show summary.code, summary.error
```

A successful result contains:

```text
{
  ok: yes,
  error: nothing,
  code: "ok",
  version: 1,
  fingerprint: "64 hexadecimal characters",
  count: 4,
  complete: no,
  counts: {pending: 1, running: 1, done: 1, failed: 1},
  jobs: [{id: "fetch", status: "done", attempts: 1}, ...]
}
```

`complete` means every recorded job has status `done`; `ok` means the checkpoint
was successfully read and summarized. These are different facts. A summary
contains no commands, stdin, process results, stdout, or stderr. Protect job ids
and other returned metadata if they themselves contain sensitive information.

Operational failures return `{ok: no, error: text, code: text}`. Codes are
`not_found`, `io`, `limit`, and `invalid_checkpoint`. Wrong argument types/arity
and sandbox permission violations still raise runtime errors.

The reader accepts at most 24 MiB. It validates strict JSON/UTF-8, checkpoint
version 1, a 64-character hexadecimal fingerprint, 1–128 unique job ids, statuses
`pending`/`running`/`done`/`failed`, and whole attempt counts from zero through one
million. Terminal `done` entries require a result map with boolean `ok: yes`;
terminal `failed` entries require boolean `ok: no`. Truthy text or numbers do not
substitute for those booleans.

Unknown metadata fields are tolerated. Inspection does not deserialize or return
the deeper process result payload and does not validate unused exact-value tags
inside it. Its schema check is intentionally a checkpoint-summary check, not a
complete validation of every application value stored in the file.

Inspection opens no `.lock`, creates no file, and leaves checkpoint bytes and
modification time unchanged. It can observe an atomically replaced checkpoint
while a run is active; the snapshot is not a guarantee of its current live state.
Windows inspection uses deletion-sharing read handles. The runtime's compatible
publish operation permits replacement while those readers retain their snapshot
on supported Windows filesystems. Older OS/filesystem compatibility fallbacks can
return an I/O failure when a destination remains open.
Native filesystem permission is required, so inspection is blocked in the
language sandbox and unavailable in browser WebAssembly.

## Recovery decisions remain with execution and the application

Inspection has no job specification with which to compare the fingerprint or
establish idempotence. A `running` entry means an interrupted/in-flight launch may
have uncertain side effects; the inspector never resets it to `pending` or calls
it safe to retry. Even an all-done checkpoint does not prove its specification
matches a proposed future run. Use `workflow.run`'s matching-specification and
recovery checks, plus application-side reconciliation where required. See
[restartable workflows](workflows.md) for retries, locking, and side-effect limits.

Run the focused native suite with:

```sh
python src/tests/workflow_tools_test.py /absolute/path/sprout
```

It checks deterministic layers, specification fingerprints, execution-validation
parity, no planning side effects, real run-produced checkpoints, strict rejection
and size bounds, concurrent atomic replacement, unchanged file bytes/mtime, lock
independence, privacy of result payloads, and sandbox boundaries. Windows also
checks a real Sprout write with a destination reader retaining the old contents.
Browser support for pure planning additionally
requires testing a freshly built WebAssembly artifact.
