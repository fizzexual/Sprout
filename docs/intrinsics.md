# Explicit builtin calls

`builtin::name(...)` selects Sprout's native builtin directly:

```sprout
type number:
    make value

show number("12")          ~ The existing constructor: {value: "12"}.
show builtin::number("12") ~ The builtin conversion: 12.

make length = task(value): 999
show builtin::length("café")
show "12" |> builtin::number()
```

The qualified operation cannot be redirected by a variable, task, type or
module with the same name. It does not require `use`. `builtin` is contextual,
so ordinary variables, parameters, tasks, types and modules named `builtin`
remain available. `builtin.member(...)` remains ordinary object/module syntax.

The two colons form one adjacent `::` token. Spaces around that token are allowed,
as in `builtin :: length(items)`; `builtin : : length(items)` is malformed.
Normal newline rules apply: expressions can continue within brackets or calls,
and comments/text literals do not change their surrounding syntax. A dotted
receiver such as `object.builtin::length(items)` is not an intrinsic call.

An explicit operation must be called, including when used in a pipeline.
`builtin::length` alone is not a task value. Wrap the operation when a callback
is needed:

```sprout
make size = task(value): builtin::length(value)
show map(["Ada", "Sam"], size)
```

Operations use their existing global names, including `integer`, `decimal`,
`bytes`, `json_encode`, `json_decode`, `file_read`, `request`, `process` and
`workflow_plan`. Dotted aliases retain their documented spelling; for example
`use files` with `files.read(path)` corresponds to `builtin::file_read(path)`.
`show` is a statement, and `system.run` is a module operation; neither becomes
an intrinsic operation named `show` or `run`.

Unknown operation names fail before input expressions execute. Builtin inputs
remain positional: named inputs are rejected before they execute. Explicit
inputs evaluate once, from left to right, then the existing operation applies
its normal arity, value and result checks. Current builtins accept at most 16
inputs; larger lists are rejected before evaluation. See [native library
contracts](native-library.md) and [exact data](runtime-data.md).

The route preserves the underlying operation's runtime budgets, sandbox and
host permissions, and compiled-profile availability. It does not grant I/O or
SQLite support. A successful version command does not prove those capabilities.
For example, `builtin::file_write` remains disabled in a sandbox.

Reliable selection does not make an operation pure. `add` changes its supplied
list, higher-order operations run supplied tasks, and I/O operations keep their
effects. Arguments, object formatting and overloaded operators retain their
existing behavior. This feature is an explicit lookup contract, not isolation
from arbitrary surrounding code.

## Existing callable behavior

Bare calls keep their current precedence:

1. A visible variable holding a task value.
2. A globally registered type constructor.
3. A registered task in the executing source file.
4. A builtin operation.

A non-task variable with a builtin's name still allows the bare builtin call.
Module and object calls keep their existing dispatch, including namespace
shadowing by variables. A caller's global type can therefore preempt a library's
bare helper task or builtin conversion. Libraries can use explicit intrinsic
calls for native operations and capture their own task values for helpers:

```sprout
private task visit(value):
    give builtin::length(value)

private make visit = visit
```

This feature does not change constructor priority, task capture, inheritance,
methods, `super`, annotations, operator overloads or first-class task values.
Function parameter names retain their existing [named-input
contract](ergonomics.md). Pin source/runtime/host revisions according to the
[compatibility policy](compatibility.md).

The dedicated Python contracts and shared Sprout corpus cover collisions,
input evaluation, malformed syntax, formatting, permissions and data handlers.
Native, rebuilt WebAssembly and host/editor parity are release gates; passing
local fixtures alone does not establish production readiness.
