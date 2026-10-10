# Parallel processes and restartable workflows

```sprout
use process
make results = process.parallel([
    ["python", "report.py", "north"],
    ["python", "report.py", "south"]
], {workers: 2, timeout_ms: 30000, fail_fast: yes})
show results
```

Commands are argv lists, never interpolated shell commands. A command map can
provide `argv`, `cwd`, `stdin`, `timeout_ms`, and `max_output`. Results preserve
input order and include `ok`, `exit`, `stdout`, `stderr`, `timed_out`, `truncated`,
and `cancelled`. A group supports 1–16 workers and up to 128 commands. Both output
pipes across the group are capped at 16 MiB; each command's configured cap may be
reduced to its share. Failure cancels running process trees and unstarted jobs by
default; `fail_fast: no` collects independent failures. Every worker is joined
before results return. Sprout VM state stays on the interpreter thread.

```sprout
use workflow
make result = workflow.run([
    {id: "fetch", argv: ["python", "fetch.py"], idempotent: yes, retries: 2},
    {id: "report", argv: ["python", "report.py"], after: ["fetch"], idempotent: yes}
], {checkpoint: "report.checkpoint.json", workers: 2})
show result.ok
```

Dependencies and duplicate ids are validated before any process launches. The
checkpoint contains a SHA-256 fingerprint of the complete job specification,
attempt counts, statuses, and bounded results. A changed specification rejects
the checkpoint; ordering and text changes also change its fingerprint. An OS
file lock prevents concurrent runs against the same checkpoint. Its `.lock` file
may remain afterward; the OS lock is released on normal completion or process
death. Checkpoints atomically record `running` before each batch launches, then
record results after joining workers.

Completed jobs are reused on resume. Interrupted `running` jobs have uncertain
side effects. They are retried automatically only when their original
specification declared `idempotent: yes`. Failed jobs retry only with that
declaration and `retries: 0..5`; the count is additional attempts after the first.
A process timeout, output overflow or cancellation is a failure. A dependency
on a failed job prevents descendants from launching.

This provides at-least-once recovery for explicitly safe jobs, not exactly-once
external side effects. Use transactional writes, unique operation keys, or
upserts inside a job to make retries safe. An unsafe interrupted job requires
manual reconciliation and a new checkpoint; changing its declaration afterward
does not bypass the fingerprint check. Output is stored in plaintext; choose an
appropriately protected checkpoint directory for sensitive results.

Parallel processes and workflows are native host operations. They are disabled
in sandbox mode and unavailable in browser WebAssembly. A recorded workflow may
contain completed, failed, and pending jobs; inspect `ok` before consuming it.
