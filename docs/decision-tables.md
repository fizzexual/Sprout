# Pure ordered decision tables

Pending fresh target CI. One separately pinned private Windows1544 profile
passed normal10, actual environment-GC10, supplied sandbox42 and full example4
once; that does not qualify the new portable driver or WebAssembly/platform
coverage. Its dependency is the declarative validator and verified `builtin::`
profile. No expression strings, callbacks, ambient data, I/O, effects or retries
are supported.

`decision.evaluate(input, table)` selects the first matching rule from an
explicit ordered list. The table is exactly
`{schema: 1, input_schema, rules, fallback?}`. Version is an ordinary numeric
literal `1`, not boolean, integer or decimal. The schema is a valid root-map
validator schema, with at most 32 declared root fields and strict unknown-field
rejection. Root `nullable:yes` is an invalid table; omission/`nullable:no` is
allowed. The input always must be a plain root map. Leaf nullable flags remain
valid and distinguish explicit `nothing` from an absent key.

Every table value, schema, rule and output is guarded and validated before the
input is inspected. All input values are guarded and validated before matching.
Invalid later rules or unused outputs cannot be hidden by an earlier match.
There is no mutable input/table copy just to detect bad data. Only a selected,
already admitted output is cloned; no caller container is returned or mutated.

Each rule is `{id, conditions, output}` with unique text ID of 1–64 characters
and 1–8 conditions. The list order is its priority; all conditions use conjunction.
Rule IDs and output values are application metadata and can be sensitive, even
though error messages omit them. An empty rule list is valid. Unconditional
behavior uses `fallback`, not an empty conditions list.

Conditions read one declared root field, without dotted/nested paths:

| Form | Meaning |
| --- | --- |
| `{field,op:"exists"}` | Key is present, including explicit `nothing`. |
| `{field,op:"missing"}` | Key is absent. |
| `{field,op:"eq"|"ne",value}` | Strict native-kind equality or its negation for a present scalar. Missing makes both false. |
| `{field,op:"lt"|"lte"|"gt"|"gte",value}` | Same declared exact integer/decimal kind; explicit `nothing` makes ordering false. |
| `{field,op:"in",values}` | 1–16 same-kind scalar alternatives; `nothing` allowed only for nullable fields. Missing is false. |

List/map fields support `exists` and `missing` only, including when nullable;
they cannot use comparison/membership with a null operand to bypass this rule.

Text equality is case-sensitive, without trimming/normalization. Booleans are
not numeric. Integer and decimal are distinct kinds. Decimal comparisons use
exact numeric value across different scales, preserving the signed int64
coefficient/18-place native contract. Relational predicates do not accept
ordinary numbers or text. Ordinary `number` fields can use equality/membership
only; admitted values must be finite and have magnitude at most
9007199254740991. No exact-money semantics are promised for them. Incompatible
operands, unknown fields/operators/options, duplicate IDs, empty IDs/conditions
and malformed membership lists are `invalid_table`.

The result is always `{ok,matched,selection,output,error}`. Rule success has
`matched:yes` and `selection:{kind:"rule",index:exact one-based integer,id}`.
Explicit fallback has `matched:no`, `selection.kind:"fallback"`, null index/ID
and its detached value. No match/no fallback has `selection.kind:"none"` and
`output:nothing`. Explicit fallback `nothing` differs from absent fallback by
that kind. No input value is automatically echoed. Successful errors are
`nothing`; failure contains no selection, output or partial decision.

Failures use one fixed `{code,message}` with `invalid_table`, `table_limit`,
`invalid_input`, `input_limit` or `output_limit`. Errors contain no input values,
unknown names, rule IDs or schema paths. A table is checked before input, so a
bad table takes precedence over a bad input. Invalid schema diagnostics from the
validator are wrapped rather than returned. Unexpected runtime/budget failures
propagate. The failure envelope plus two line bytes is under 320 bytes.

Limits are 32 rules/256 possible predicate checks, 32 root input/schema fields,
128 nested map keys, 256 nested list items, 16 container edges, 4096 admitted
value occurrences and 65536 aggregate text characters across table/schema/input.
A leaf text has at most 1024 characters, field/key names at most 128. Table/input
text/depth/width/occurrence overflow returns its corresponding limit code. Rule
counts over 32, condition counts over 8 and too many declared root fields are
`table_limit`; malformed predicate alternatives remain `invalid_table`.

Admission counts alias occurrences, not object identities. Cycles and repeated
aliases stop at the occurrence/depth limit; no container equality is used for
identity detection. Objects (including spoofed native names), tasks, bytes,
nonfinite/oversize ordinary numbers and literal reserved singleton tag maps
are rejected before comparisons or cloning. Properly decoded exact tags are
native typed values. Text/keys must be valid UTF-8 scalar strings.

The complete selected response JSON plus two line bytes is at most 32768 bytes,
checked after bounded cloning/encoding. That is a wire limit, not pre-allocation
or resident-memory isolation. Already allocated text may be scanned to reject
it. Hosts still need input, step, runtime and capture controls. Captured helpers
and explicit intrinsic calls prevent caller constructors from intercepting them.

`examples/rules/item_handling.sprout` demonstrates synthetic priority, exact
2.50 boundary, optional absence and explicit null. It makes no carrier,
authorization, inventory, delivery/SLA or production-policy claim.

Run `python src/tests/decision_library_test.py` from the repository for six
pure source/oracle groups. This mode creates no native children and works with
parent GC/sandbox environment variables present. Its rational/kind-tagged oracle
checks42 directly authored envelopes; it does not execute Sprout.

An explicit trusted CLI binary selects the fixed four-call native profile:

```text
python src/tests/decision_library_test.py /absolute/path/to/sprout --report-dir /new/retained/report
```

Before helper import, report/temp creation or any native launch, explicit mode
requires both `SPROUT_GC_STRESS` and `SPROUT_SANDBOX` to be absent from the parent
environment, including empty values. CI must explicitly unset them for this
driver. Child environments deliberately select normal, actual `GC_STRESS=1`,
and the supplied-source `--sandbox` call. This guard is this driver's contract;
it does not retroactively change another test tool's environment behavior.

The four calls are shared normal10, actual-GC shared10, supplied sandbox42 full
typed/key-strict JSON results and the full synthetic example4. Each uses3s VM,
five million steps,5s host supervision and32768 streaming bytes on each output
pipe with the repository's trusted owned-process helper. The helper import saves
and restores `sys.argv` and does not run its compiler/test entry. Source/host/
binary identities and both raw/canonical-LF text hashes are recorded, with no
private path, seal or machine-specific hash requirement for repository users.
The generated fixtures derive from committed source/oracle code in a new report
directory. No report path supplied means an automatically named retained temp
directory; it is printed, not removed. An explicit report directory must be new.

The driver counts all complete test summary lines and accepts exactly one full
10-passed/zero-failed summary. It rejects diagnostics, incomplete or multiple JSON
physical lines, decoded duplicate keys, nonfinite numbers and partial/changed/
extra/missing result fields. It preserves first failure/raw pipes and separate
capture/cleanup/finalization diagnostics, stops remaining calls and does not
retry. OS spawn is not preemptible; direct wait1s and reader joins0.5s are separate
cleanup boundaries. No descendant cleanup, resident-memory or OS isolation claim
follows from this helper. The selected binary/test source is trusted; recorded
hashes provide attribution, not independent source/build authenticity.

This portable driver still needs its reviewed changed-only fake controls and
fresh native/sanitizer/WASM CI on the integrated revision. No speed, arbitrary
policy, general production or sustained-deployment qualification is claimed.
