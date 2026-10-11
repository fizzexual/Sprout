# Building automation command lines

`lib/cli.sprout` parses an explicit list of arguments. It performs no I/O, reads
no environment, and never prints or exits. A script decides how to report errors.

```sprout
use "lib/cli.sprout"
make schema = [
    {long: "output", short: "o", kind: "text", required: yes, help: "Report path"},
    {long: "jobs", short: "j", kind: "number", default: 2, help: "Workers"},
    {long: "tag", short: "t", kind: "text", repeat: yes},
    {long: "verbose", short: "v", kind: "bool"}
]
make result = cli.parse(args(), schema)
when not result.ok:
    fail result.error
when result.help:
    show cli.help("runner", schema, "Run automation tasks.", "TASK ...")
    exit(0)
show result.flags, result.positionals
```

The result always has `ok`, `flags`, `positionals`, `help`, and `error`. On failure
it contains empty flags and positionals; do not execute work unless `ok` is yes.
Flag values are keyed by their long names. `kind` defaults to `bool`; `required`
and `repeat` default to no. Non-required text/number values without defaults are
`nothing`; absent booleans are no and absent repeatable text flags are empty lists.

A schema is an ordered list of maps. Its accepted fields are `long`, `short`,
`kind`, `default`, `required`, `repeat`, and `help`. Long names start with an ASCII
letter and continue with letters, digits or hyphens. Short names are one ASCII
letter or digit. Names/aliases must be unique. `help` and `h` are reserved for
`--help` and `-h`. Incorrect fields, kinds, default types, or argument types
produce a structured parse error. `cli.help` rejects an invalid schema with `fail`.

- Use `--output report.json`, `-o report.json`, or `--output=report.json`.
- A bare boolean sets yes, even when its default is yes. Explicit boolean values
  use `--verbose=true`, `false`, `yes`, or `no`; the same `=value` form works for
  a short alias. Values are case-sensitive. Booleans consume no following word.
- Repeating a non-repeatable flag, including through another alias, is an error.
  Only text flags may repeat. Explicit occurrences replace the fallback default
  list and retain their argument order. Returned defaults are copied.
- Required flags must appear explicitly, even with defaults. Help bypasses this
  required check, while malformed/unknown arguments and schema errors still fail.
- Number flags accept finite decimal/exponent text, including negative values
  such as `--jobs -2` or `--amount=-.5`. Hex, NaN, infinity, overflow, whitespace,
  and partial numeric text are errors. Non-finite numeric defaults are rejected
  as well. Numeric options use `number()` floating
  values; use a text flag and `integer()` or `decimal()` for exact input. Declared
  numeric defaults retain their numeric type.
- Positional arguments may appear between flags. `--` ends option parsing and
  makes every subsequent token positional. A lone `-` is positional, or a literal
  value when it follows a text flag. Set text
  beginning with a hyphen using `--output=-draft`; short flag clusters such as
  `-abc` are rejected with instructions to separate the flags.

The interpreter has its own switches. Put `--` after the source path to forward
all following application arguments literally. A second `--` is then interpreted
by the library as the positional separator.

## Task runner example

Run from the repository root with a native interpreter on PATH:

```text
sprout run examples/cli/task-runner.sprout -- --help
sprout run examples/cli/task-runner.sprout -- -o report.json -j 2 -t ci check test
sprout run examples/cli/task-runner.sprout -- -o report.json --dry-run check test
```

`--command /absolute/path/to/sprout` selects another interpreter. The example's
`check` task parses its source/imports without execution; `test` runs
`src/tests/cli_library_test.sprout`. Native jobs use literal argument vectors,
five-second deadlines, and bounded output capture. The selected tasks and tags
are written with their results to an atomic JSON report. Any failed task produces
a nonzero exit after the report is saved. Dry run prints the plan and creates no
report or child process. Validation rejects unknown tasks or invalid worker
counts before starting jobs or writing output.

The parser is a source library; import it relative to your source tree or ship
it with your package/bundle. The task runner's check/test paths intentionally
refer to this repository and need its files present.
