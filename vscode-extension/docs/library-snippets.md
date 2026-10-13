# Explicit pure-library snippets

In a Sprout file, type a prefix and choose the matching VS Code snippet. Tab moves
through the numbered inputs; repeated variable names are linked. The final
tabstop leaves the cursor after the checked result. Existing snippets are kept.

| Prefix | API | Visible arguments and successful value |
| --- | --- | --- |
| `validatecheck` | `validate.check(value, schema)` | A small root-map schema and synthetic input; continue only when `checked.ok` |
| `configresolve` | `config.resolve(defaults, schema, files, cli)` | Explicit defaults, named in-memory layers and overrides; `settings` contains the resolved values |
| `utcparse` | `utc.parse(text)` | Supplied timestamp text with an explicit offset; `instant` contains exact integer seconds and nanoseconds |
| `utcformat` | `utc.format(instant)` | Two explicit `builtin::integer` fields; `timestamp` contains canonical UTC text |

The first tabstop is the relative library import path, initially `lib/...` for a
file in the repository root. Adjust it for the source file's directory and make
the library available yourself. Configuration also needs `validate.sprout`
beside `config.sprout`. If the module is already imported, remove the duplicate
`use` line. Rename the local variables when inserting several templates in one
scope. The field-name tabstop in `validatecheck` expects a Sprout identifier;
text tabstops are string-literal contents and must retain valid quoting.

These templates insert source; choosing a snippet does not run it. Their library
calls take supplied values, with no ambient file-content, environment, command,
clock or network access. The explicit `use` line loads the trusted library when
the program runs. A configuration layer's name is metadata, not a file to read.
The templates do not parse CLI arguments or sample the current time.

Each template checks `result.ok` and fails with fixed text. It does not print
input values, field paths, error records, configuration provenance or successful
data. Add any application handling deliberately; caller values and success
metadata can contain secrets. Unexpected VM/budget failures still propagate.
The examples do not replace host request/output limits or grant permissions.

UTC formatting requires exact integer fields rather than ordinary number
literals. The default pair is the Unix epoch; parsing requires the documented
explicit-offset Gregorian timestamp profile. Keep seconds and nanoseconds
separate. Edit the supplied data to fit the application's schema.

Use a runtime whose explicit `builtin::` operations and these library APIs are
available; a development version string alone does not establish support.
Library contracts are documented in [validation](../../docs/validation.md),
[configuration](../../docs/configuration.md) and [UTC timestamps](../../docs/utc-time.md).

The focused source checks verify placeholders, preservation/unique prefixes and
the actual exported task signatures. They do not execute Sprout, activate VS Code,
prove editor insertion behavior or certify applications for production.
