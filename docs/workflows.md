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
`cancelled`, and `attempted`. The last flag distinguishes dispatch to the native
runner from cancellation or expiry while queued. A group supports 1–16 workers
and up to 128 commands. The interpreter deadline covers queue time and running
work together. Both output
pipes across the group are capped at 16 MiB; each command's configured cap may be
reduced to its share. Failure cancels running process trees and unstarted jobs by
default; `fail_fast: no` collects independent failures. Every worker is joined
before results return. Sprout VM state stays on the interpreter thread.
Windows runners own kill-on-close jobs. POSIX runners have a guardian that
cleans their process group when its owner dies; nested Sprout groups cascade
cleanup through their own guardians. A command deliberately escaping its group
with `setsid` or `setpgid` requires external process supervision. After an
interruption, verify external services and any intentionally detached work have
stopped before replaying a job.

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
may remain afterward; the OS lock is released on normal completion, runtime
errors, or process death. Checkpoints atomically record `running` before each batch launches, then
record results after joining workers.

Persisted workflow output shares a 3 MiB raw budget across both pipes and all
jobs, reserving space for worst-case JSON escaping within a 24 MiB checkpoint.
Attempts include interrupted launches and may exceed the automatic retry budget;
one million total attempts is the recovery counter limit. Completed checkpoints
at that limit remain readable; further launches require manual reconciliation.

Completed jobs are reused on resume. Interrupted `running` jobs have uncertain
side effects. They are retried automatically only when their original
specification declared `idempotent: yes`. Failed jobs retry only with that
declaration and `retries: 0..5`; the count is additional attempts after the first.
A process timeout, output overflow or cancellation after dispatch is a failure.
Jobs cancelled before dispatch stay pending and consume no attempt. A dependency
on a failed job prevents descendants from launching.
All currently ready jobs enter the queue together; `workers` limits simultaneous
execution. Retryable failures can leave queued jobs pending for the next batch.

This provides at-least-once recovery for explicitly safe jobs, not exactly-once
external side effects. Use transactional writes, unique operation keys, or
upserts inside a job to make retries safe. An unsafe interrupted job requires
manual reconciliation and a new checkpoint; changing its declaration afterward
does not bypass the fingerprint check. Output is stored in plaintext; choose an
appropriately protected checkpoint directory for sensitive results.

Parallel processes and workflows are native host operations. They are disabled
in sandbox mode and unavailable in browser WebAssembly. A recorded workflow may
contain completed, failed, and pending jobs; inspect `ok` before consuming it.
