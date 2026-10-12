# Paginated contacts with durable retry keys

`examples/services/contacts_api.sprout` is a separate append-only API example.
It uses `contacts-api.sqlite` in the worker's current directory. The original
`contacts.sprout`, `contacts.sqlite`, recovery exercises and sustained-run
profiles are unchanged. Native SQLite support and `--allow-io` are required.

Create a dedicated state directory, then run the existing host on loopback:

```sh
mkdir contacts-api-state
python integrations/python/sprout_service.py examples/services/contacts_api.sprout --allow-io --cwd contacts-api-state --workers 8 --timeout-ms 4000 --max-body 4096
curl -X POST http://127.0.0.1:8080/contacts -H 'Content-Type: application/json' -d '{"request_key":"ada-001","name":"Ada","email":"ada@example.test"}'
curl 'http://127.0.0.1:8080/contacts?limit=25&after=0'
```

Protect the source and state directory and use the host's normal authenticated
proxy/OS isolation boundaries. This example adds no authentication, tenant
separation or public listener. Loopback alone is not authentication. `/health`
belongs to the host and is a liveness/protocol probe, not a database probe.

## Application wire contract, version 1

The worker receives the existing host envelope with exactly `method`, `path`,
`query` and `body`. Query values are lists of decoded text. Malformed envelope
types or unknown fields return 400 before opening storage. Application responses
have `Cache-Control: no-store`; error bodies contain fixed codes and no SQL,
native diagnostics or request contents.

Only `/contacts` is supported. Other paths return 404 `route_not_found`.
Unsupported methods return 405 `method_not_supported`.

POST accepts no nonempty query parameters. Its body must contain exactly:

| Field | Accepted value |
| --- | --- |
| `request_key` | 1–64 ASCII letters, digits, underscores or hyphens; case-sensitive |
| `name` | 1–100 Unicode characters, not blank after trimming ASCII whitespace; no ASCII controls or DEL |
| `email` | 3–254 printable ASCII characters, no whitespace, exactly one `@` with nonempty text on both sides |

These email rules define a small application identifier; they do not implement
RFC email-address validation or prove deliverability. Values are stored exactly,
without trimming, Unicode normalization or case folding. Therefore `Ada` and
`Ada ` differ, and email uniqueness is case-sensitive. The strict JSON codec
rejects NUL, invalid Unicode and malformed exact-number tags before dispatch.
Invalid application fields return 400 `invalid_request`.

A new key creates one row and returns 201:

```json
{"contact":{"id":"1","name":"Ada","email":"ada@example.test"},"replayed":false}
```

Retry the **same key and exact name/email**, including after a response was
lost or the listener restarted. The API returns 200, the same stored contact,
and `replayed: true`. Reusing the key for a different payload returns 409
`request_key_conflict`. A new key whose email is already stored returns 409
`email_conflict`; that rejected key remains available for a different email.
No request automatically updates a contact or deletes a key.

GET accepts no body and only the following nonempty query parameters:

| Parameter | Contract |
| --- | --- |
| `after` | Canonical decimal text from `0` through `9223372036854775807`; default `0` |
| `limit` | Canonical decimal text from `1` through `50`; default `25` |

Signs, leading zeros other than `0`, fractions, overflow, unknown parameters,
or repeated nonempty values return 400. The existing Python bridge discards
empty query values: `?after=&limit=` is indistinguishable from omission and uses
the defaults. This example does not change that bridge contract.

```json
{"contacts":[{"id":"1","name":"Ada","email":"ada@example.test"}],"has_more":false,"next_after":null}
```

IDs are decimal **strings**, so cursors preserve the full signed-int64 range
without JSON floating-point rounding or numeric-tag handling. Rows are ordered
by ascending ID. When `has_more` is true, pass `next_after` into the next request.
Otherwise `next_after` is null. The query seeks `id > after` through the primary
key and fetches at most `limit + 1` rows; it uses neither OFFSET nor a total-count
scan. Pages are live observations, not a cross-request snapshot. New rows may
appear on later pages; there are no delete/update routes.

## Transaction and storage contract

Migration version 1 creates `contacts_api`, with `id INTEGER PRIMARY KEY AUTOINCREMENT`, a
unique binary-collated request key, name and a unique binary-collated email.
The retry key and business result live in the same row. Within one
`sqlite.transaction` / `BEGIN IMMEDIATE`, a parameterized conditional INSERT
checks key absence, then a parameterized SELECT reads the stored outcome.
First creation versus replay comes from that locked transaction's change count.
There is no separate, racy pre-check and no external effect in the transaction.

AUTOINCREMENT keeps newly allocated IDs above prior committed IDs, with SQLite's
small `sqlite_sequence` bookkeeping overhead. IDs can have gaps; clients must
not assume consecutive values. At signed-int64 exhaustion, a new insert fails
closed with 503 instead of allocating a lower random ID that forward cursors
could miss. Its key is not consumed; replays of existing keys still work.
The exact internal `sqlite_sequence` definition is part of the schema oracle.
See SQLite's [AUTOINCREMENT contract](https://www.sqlite.org/autoinc.html).

Concurrent identical requests serialize into one creation and replays. Competing
payloads for the same key leave only the winner's row. SQLite commit preserves
the key with its contact; an HTTP response can still fail after commit, so
clients must retain and reuse their key. This is database idempotency for this
append-only operation, not exactly-once delivery or a guarantee for email,
payments, other databases or other external effects.

The migration history is immutable and checked by `sqlite.migrate`. Exact
application table/index/trigger definitions are checked before initialization
and again after migration. Foreign, unversioned or altered application schemas
are refused rather than silently adopted. Missing/extra fields, indexes,
triggers or other application objects produce 503 `storage_unavailable` before
contact writes. These checks establish consistency, not authenticity against an
operator who can rewrite the database and its ledger.

Each SQLite call caps lock/query time at 500 ms, captured rows at 51 and captured
bytes at 64 KiB. Schema validation/migration can also need a writer lock.
Storage locks, incompatible history/schema and other database failures produce
503 `storage_unavailable`. The host's four-second worker limit bounds the entire
request; it can return its existing 502/504 errors for worker failure/expiry.
No automatic retry loop is hidden in the example. A failed or lost outcome can
be retried with the same key and unchanged payload once storage recovers.

The database and retry history grow with accepted contacts. Per-request bounds
do not impose a total storage cap or certify large-history capacity. Enforce
external disk/OS quotas and measure the intended workload. There is no key TTL,
pruning, retention job or automatic down migration. Removing a key would remove
its retry guarantee, so out-of-band deletion is outside this contract.

Back up the **whole** database, including keys and `_sprout_migrations`, with a
consistent SQLite backup or after a graceful drain. Restoring an older snapshot
also restores its earlier retry history and excludes later writes. Keep source,
migration history and a verified native binary with the backup. Future upgrades
append migrations and update/test the exact schema oracle; merely reverting
code does not downgrade data. The existing [recovery runbook](service-recovery.md)
illustrates the separate original contacts app's recovery primitives; its
application-specific runner is not a restore tool for this new schema.

## Focused validation

Set `SPROUT_COMMAND` to an absolute native SQLite-enabled executable, then run:

```sh
python integrations/python/test_contacts_api.py -v
```

Tests use bounded fresh data and loopback listeners. They exercise real native
transactions, concurrent fresh-start/same-key calls, conflicting payloads,
deliberately dropped post-commit replies and restart persistence, sparse keyset
pages and int64 cursors, strict inputs, field limits, lock failure/recovery and
schema refusal. Independent read-only SQLite queries check stored rows and
integrity. The original example source and its separate database remain intact.
This evidence is not a sustained-run, crash/power-loss, internet-deployment or
production-readiness qualification.
