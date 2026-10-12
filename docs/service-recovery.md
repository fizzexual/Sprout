# Local HTTP/SQLite recovery exercise

The trusted local service profile needs tested data restoration as well as a
working listener. `/health` is liveness. A `GET /contacts` can create a missing
database and return an empty successful response: starting with the wrong empty
state directory can therefore look healthy. Before promoting a restored service,
verify the intended state directory and a trusted backup manifest, schema,
integrity and exact application data. A successful HTTP status alone is insufficient.

The separate finite exercise is:

```sh
python tools/service_recovery.py /absolute/path/to/sprout \
  --workspace /new/private/recovery-workspace \
  --report /new/private/recovery-report.json --label exact-reviewed-build
```

The workspace and report must be new. The tool uses only synthetic contacts,
loopback listeners and private restored copies. It freezes the binary, Python
host/SDK, contacts worker and test harness and checks their hashes before and
after execution. Run it against an agreed stable candidate; do not freeze files
while another task is editing them. A failed exercise keeps its workspace,
metrics and failed report. No existing service state is replaced.

The exercise seeds four exact contacts, restarts the worker, and drains an
accepted fifth mutation before backing up its committed data. It restores that
snapshot into a fresh candidate directory and checks the independent SQLite and
native HTTP views. A deliberate incompatible column rename and matching candidate
worker demonstrate read/write behavior; reverting only the source must then
return 503. Finally, a fresh restoration of the pre-upgrade snapshot with the old
worker must recover all five original contacts and the uniqueness constraint.
The private candidate's extra test write is outside that earlier restore point.
This demonstrates point-in-time restoration, not automatic down migration or
zero data loss for writes accepted after a backup.

Backups use SQLite's [backup API](https://www.sqlite.org/backup.html), with a
monotonic deadline and a 64 MiB cap. Publication requires completion and a new
destination; partial files are removed on ordinary failure. The snapshot
manifest seals database bytes, schema, row count and exact row content. Restore
verifies all of them and refuses an existing destination. Missing, corrupt or
mismatched snapshots must fail before service launch. SQLite documents why
[copying live files or mishandling journals](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)
can corrupt data. Never overwrite an open database, swap its journal, or delete
recovery sidecars to make a failed restore appear successful.

For an actual deployment, stop new traffic and every client that can mutate the
database, drain accepted handlers within the platform supervisor's grace period,
and record the exact runtime/source hashes and state directory. Create and verify
the consistent backup; preserve its trusted manifest outside the writable service
state. Rehearse the candidate against a private restored copy. Before switching
traffic, verify schema and exact application data, bounded reads/writes and the
tested rollback path. Keep the prior source/runtime and restore data into a fresh
stopped state directory when rollback requires it. Do not replay ambiguous
mutations blindly; use application idempotency/reconciliation rules.

Run bounded primitive regressions with:

```sh
python src/tests/service_recovery_test.py
```

These cover backup lock deadlines, incomplete publication, caller-owned targets,
missing/corrupt/mismatched restore inputs, empty state, changing snapshot inputs
and failed report retention. They do not execute the native end-to-end exercise.
Its report is separate evidence, required before claiming its cases passed.
Neither result establishes power-loss/crash recovery, actual systemd/Windows
supervisor behavior, proxy cutover, filesystem quotas, live production restore,
or eight-hour qualification. Those remain platform-specific operational gates.
