# Declarative input validation

`lib/validate.sprout` provides one public task:

```sprout
use "lib/validate.sprout"

make schema = {kind: "map", fields: {
    name: {kind: "text", min_length: 1, max_length: 80},
    note: {kind: "text", required: no, nullable: yes, max_length: 300},
    tags: {kind: "list", max_length: 8, items: {kind: "text", allowed: ["new", "priority"]}}
}}
make result = validate.check({name: "Ada", tags: ["new"]}, schema)
show json_encode(result)
```

Import paths resolve relative to the source file. Adjust the path for your project;
the runnable [order example](../examples/validation/order-input.sprout) uses
`../../lib/validate.sprout`.

`check(value, schema)` returns:

```sprout
{ok: yes, errors: [], schema_error: nothing, truncated: no}
```

An invalid schema returns `ok: no`, no input errors, and
`schema_error: {path: [...], message: "..."}`. The entire schema is checked before
the input. An invalid input returns `ok: no`, `schema_error: nothing`, and errors
such as:

```sprout
{path: ["contact", "email"], code: "null", message: "Nothing is not allowed here."}
{path: ["tags", 1], code: "kind", message: "Expected text."}
```

Path segments are field names or zero-based list positions. An empty path refers
to the root value. A field literally named `"contact.email"` occupies one path
segment, so it cannot be confused with two nested fields. Schema-error paths
refer to schema options, for example `["fields", "name", "max_length"]`.

## Schema nodes

Every node is a plain map with a required `kind` option. Extra or misplaced
options are rejected; spelling mistakes cannot silently weaken a schema.

| Option | Applies to | Behavior |
| --- | --- | --- |
| `kind` | Every node | `"text"`, `"yes-no"`, `"list"`, `"map"`, `"number"`, `"integer"` or `"decimal"` |
| `required` | A declared map field | `yes` by default; `no` permits an absent key |
| `nullable` | Every node | `no` by default; `yes` permits explicit `nothing` |
| `min_length`, `max_length` | Text and lists | Inclusive bounds; default minimum is zero and default maximum is the hard kind limit |
| `allowed` | Text, yes-no, number, integer and decimal | Nonempty list of scalar values with the exact declared kind; `nothing` also requires `nullable: yes` |
| `fields` | Maps | Map from field names to child schemas; defaults to `{}` |
| `allow_unknown` | Maps | `no` by default; `yes` permits undeclared keys without inspecting their values |
| `items` | Lists | Required schema for every item |

Boolean options require actual `yes` or `no`. Length bounds accept finite whole
ordinary numbers or exact integers; decimal bounds are rejected. Field names
must contain 1–128 characters. `required` is rejected at the root and inside
`items`, where presence is already determined by the container.

Missing and null are separate. An optional field may be absent, but an explicit
`nothing` still fails unless it is nullable. A required nullable field must be
present, and its value may be `nothing`. If an `allowed` list is supplied, a
nullable value must also be present in that list to pass.

Maps reject undeclared fields by default, including nested maps. With
`allow_unknown: yes`, those extra values are opaque: the validator does not
inspect their kinds, size, cycles or serializability. The map itself still has a
128-field limit. Use explicit fields for data whose contents must be checked.

## Exact numbers and text

Kinds are strict. `1` is an ordinary floating-point `number`; `integer("1")` is
an exact `integer`; `decimal("1.0")` is an exact `decimal`. They do not satisfy
each other's schemas. Ordinary `number` values must be finite. Exact values are
checked without converting identifiers or money to floating point. Allowed
exact decimals use numeric equality, so `decimal("1.00")` equals
`decimal("1.0")`; it still does not satisfy an integer schema.

Text lengths use Sprout's `length`, which counts UTF-8 characters for valid
text, rather than bytes or grapheme clusters. `"café"` and `"a🌱é中"` both have
length four. Validation does not normalize text, parse dates, sanitize HTML or
check a protocol's UTF-8/serialization rules. Decode external data through the
appropriate strict boundary before checking its application schema.

Objects, tasks and bytes are unsupported declared kinds. Objects cannot satisfy
a primitive schema by choosing a matching class name. Validation does not call
user equality or formatting methods.

The module binds its helper and public task values, so a caller-defined type
named `visit`, `field` or `check` cannot redirect its task calls. Ordinary numeric
checks and length comparisons also avoid the `number` constructor/conversion
name. Native non-finite arithmetic raises a math error; the guarded finite check
catches that specific error and rejects the value. Other errors propagate.

This is a trusted-source library: retain the normal builtin bindings for
`kind_of`, `is_a`, `contains`, `length`, `keys` and `add`. Globally declaring types
with those names can change native callable resolution. The current language
does not provide a private immutable builtin namespace. Do not treat this module
as isolation from arbitrary surrounding Sprout code.

## Aggregation and limits

Validation leaves the schema and input unchanged. It does not insert defaults,
remove unknown fields, coerce values, return a changed record, or perform I/O.
Its only mutable state consists of fresh private counters and diagnostics.
Declared fields are checked in schema insertion order, list items in index order,
and unknown fields afterward in input insertion order. Multiple applicable
constraints can report multiple errors at one path.

| Bound | Fixed limit |
| --- | --- |
| Schema/data depth | Root depth zero; at most 16 child edges |
| Schema nodes | 1,024 occurrences, including the root; shared aliases count each time |
| Declared fields / input map fields | 128 per map |
| Schema field name | 128 characters |
| Allowed entries | 256 per scalar node; 4,096 across the schema |
| Schema field names plus allowed text | 16,384 characters across the schema |
| Input text | 1,048,576 characters per checked text value |
| Input list | 10,000 items per checked list |
| Visited input values | 10,000, including root and present declared children |
| Returned input errors | First 64 |

Limits are independent: a flat root list with 9,999 scalar items visits 10,000
values, while 10,000 scalar items exceeds the visited-value budget. Unknown
subtrees are not visited. Text/list length rejection skips that node's children;
there is already an error and no successful validation.

`truncated: yes` means additional errors were suppressed or validation stopped
at its depth/visited-value budget. It always accompanies `ok: no`. A plain length
rejection does not itself set `truncated`. Invalid schemas report a single
schema problem and never validate input, so their `truncated` field is `no`.
Recursive schemas are rejected by the schema depth/node limits. Traversal does
not use deep equality, copying or JSON serialization to detect schema cycles.

Diagnostics have bounded paths and fixed messages that do not include input
values or allowed values. Unknown field names up to 128 characters appear in
their paths; longer names use `"<field name exceeds 128 characters>"` instead.
Schema paths can include two segments per map edge; input paths have at most
17 segments. Do not treat field names as secret-free log labels automatically.

The input error codes are `required`, `null`, `kind`, `allowed`, `min_length`,
`max_length`, `unknown` and `limit`. Use the code and path for application UI;
human-readable message text can change during development.

These traversal bounds do not cap the memory already used to construct a value
or make a scan inside a native builtin preemptible. Retain CLI/host step, time,
input and output limits. The module itself is pure, but native sandbox mode
still prohibits filesystem `use`; supply trusted module tasks with the program
when using that mode. The tests cover both ordinary imports and supplied tasks
under sandbox without changing runtime import policy.

## Verification

Run the native contract suite with a pinned native executable:

```sh
python src/tests/validation_library_test.py /path/to/sprout
sprout test src/tests/validation_library_test.sprout
sprout run examples/validation/order-input.sprout
```

The nine-test Sprout corpus is shared with the real WebAssembly harness. The
Python suite additionally checks exact boundaries, schema aggregation budgets,
non-mutation, object overload exclusion, cyclic values and bounded diagnostics.
This library is part of the development build; it does not close deployment or
sustained-workload qualification gates.
