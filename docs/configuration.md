# Explicit layered configuration

`lib/config.sprout` exports one pure task:

```sprout
use "lib/config.sprout"
make schema = {kind: "map", fields: {
    mode: {kind: "text", allowed: ["preview", "apply"]},
    notify: {kind: "yes-no"},
    note: {kind: "text", required: no, nullable: yes}
}}
make result = config.resolve({mode: "preview", notify: no}, schema,
    [{name: "local", values: {mode: "apply"}}], {notify: yes})
show builtin::json_encode(result)
```

`resolve(defaults, schema, files = [], cli = {})` accepts values already loaded
by the caller. It does not open files, inspect environment variables, parse
arguments, normalize paths, or perform any other I/O. File-layer names are
metadata; they do not cause file access. See the synthetic
[settings example](../examples/config/settings.sprout).

The module and its [validation dependency](validation.md) require a pinned
runtime with [`builtin::` support](intrinsics.md). A development version string
alone does not identify that capability. Native calls preserve permissions and
runtime budgets. This new module needs its own integrated native/WebAssembly
checks; CI for an earlier source revision does not cover it.

## Precedence and validation

The order is defaults, each file layer in list order, then CLI values. Every
layer is a plain root map. A file envelope contains exactly `name` and `values`;
its name is text with 1–64 characters. Repeated names are permitted and have
distinct zero-based file indices.

Merging is shallow at the root. A later key replaces the entire earlier value,
including a nested map or list. For example, replacing `{pair: {a: 1, b: 2}}`
with `{pair: {a: 3}}` removes `b` from the resolved pair. A schema requiring `b`
then rejects the result. Omission preserves the previous key; explicit
`nothing` replaces it. The schema's required/nullable rules decide whether that
value is valid. There is no deletion marker, implicit conversion, deep merge or
schema-supplied default.

The schema must be a valid root-map schema. It is checked before inspecting the
layers. Each layer is then inspected and copied, including values that will
later be replaced. Rejecting an invalid superseded layer is intentional:
reordering layers must not hide unsupported values. Only the final resolved
configuration is checked against the application schema. Earlier plain values
may therefore violate a field constraint if a later layer supplies a valid
replacement.

`allow_unknown: yes` keeps the validation schema's documented opaque-extra
behavior, but the configuration copier still inspects every supplied value.
Tasks, objects, bytes, cycles and non-finite ordinary numbers are rejected even
in unknown fields or superseded layers. Supported values are `nothing`, text,
yes/no, finite ordinary numbers, exact integers/decimals, lists and plain maps.
Text retains its characters without normalization; decode external data through
its strict protocol boundary before resolving configuration.

## Results and provenance

A successful result has this shape:

```sprout
{ok: yes, values: {mode: "apply", notify: yes},
 provenance: {
     mode: {source: "file", index: 0, name: "local"},
     notify: {source: "cli", index: nothing, name: nothing}
 }, errors: [], truncated: no}
```

Each winning root key has a provenance entry. A default uses
`{source: "defaults", index: nothing, name: nothing}`. Provenance describes the
winning root replacement; it does not trace individual nested fields.

Every unsuccessful result returns `values: nothing` and `provenance: nothing`.
No partial configuration is returned. Errors have
`{source, index, path, code, message}`. Sources are `schema`, `defaults`, `file`,
`files`, `cli` or `resolved`; only a file error has a numeric layer index.
Paths contain bounded field names or zero-based list positions. Schema paths
refer to schema options; resolved paths refer to the merged values. The error
codes added by this module are `schema`, `layers`, `layer`, `name`, `key`,
`kind`, `number` and `limit`; final validation also uses its documented codes.
Messages can change during development.

Errors omit input values, file labels and allowed values. Ordinary field names
can still contain sensitive metadata and appear in paths. A name longer than
128 characters becomes `"<field name exceeds 128 characters>"`. Successful
values and provenance deliberately contain caller-supplied settings and file
labels; they are not secret-free logging payloads.

The first 64 errors are returned. `truncated: yes` means further errors were
suppressed or a global traversal/depth budget stopped inspection. Rejected
per-container length/key limits may skip that container's children without
setting `truncated`. An unsuccessful inspection stops before final application
validation, so errors describe the constraints actually checked, without
inventing an error count for unvisited values.

## Detachment and bounds

The module does not mutate defaults, files, CLI values or the schema. Successful
lists/maps are fresh recursively copied containers. Changing a result or its
provenance does not change a caller layer. Shared input aliases are expanded
independently per occurrence, rather than retaining shared container identity.
The copier is occurrence-bounded, not identity-aware: a cycle is rejected at
the traversal limit, and shared aliases count every time they are traversed.

| Bound | Limit |
| --- | --- |
| Named file layers | 16, plus defaults and CLI |
| Layer/data depth | Root depth zero; at most 16 child edges |
| Visited layer values | 20,000 occurrences across defaults, file values and CLI, including each root |
| Keys per map / resolved root keys | 128 |
| Map key | 1–128 characters |
| List items | 10,000 per list |
| Text value | 65,536 characters |
| Aggregate text | 262,144 characters across inspected text values, keys and file labels |
| File label | 1–64 characters |
| Returned errors | First 64 |

The validation dependency has separate schema and final-value limits, including
1,024 schema-node occurrences and 10,000 visited validated values. A copier
success does not override those limits. Unknown subtrees are opaque to final
schema validation, but remain bounded by the copier. Input error paths have at
most 17 segments; schema paths follow the dependency's bounded paths.

Helper task values are captured and native operations are selected explicitly,
so constructor/task names cannot redirect these internal calls. Surrounding
source remains trusted; this module does not isolate the process or cap memory
already used to construct its inputs. Retain CLI/host time, step, input and
output budgets. Sandbox filesystem imports remain prohibited; trusted tasks can
be supplied with a program without changing that policy.

## Verification

```sh
python src/tests/config_library_test.py /path/to/verified-sprout
sprout test src/tests/config_library_test.sprout
sprout run examples/config/settings.sprout
```

The eight-test portable corpus is intended for native and real WebAssembly
integration. Python controls add exact budgets, all-layer non-mutation,
detached alias expansion, superseded-value rejection, error privacy, schema
precedence and constructor/callable collisions. These are functional contracts,
not a deployment qualification or production-readiness claim.
