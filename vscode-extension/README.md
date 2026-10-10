# Sprout for VS Code

Syntax highlighting, snippets, scope-aware completion, navigation, formatting,
live diagnostics, and Run/Verify
commands for the [Sprout](https://github.com/fizzexual/Sprout) programming language.
Legacy Bloom files retain syntax highlighting.

## Set up the interpreter

Build the current C interpreter from this checkout. On Windows, run
`src\build.cmd`, then `install.ps1` from the repository root. Restart VS Code so
its terminals inherit the updated PATH. Alternatively, set `sprout.command` to
the full executable path, including any spaces; do not add shell quotes.

Live diagnostics require the current `sprout check <file> --stdin` command. The
extension checks unsaved buffers in the project directory without running code.
It reports syntax, import, and declaration errors. A separate conservative source
index warns about duplicate bindings, assignment to names without a visible
declaration, and argument counts for known tasks. Disable these extra warnings
with `sprout.staticDiagnostics: false`. Runtime type/value errors are reported
when you run the program.

## Editor tools

- Completion includes visible variables and task parameters, hoisted tasks,
  public imported members, and fields/methods for directly constructed or
  annotated objects. Comments and text literals do not contribute suggestions.
- Hover shows task declarations, adjacent `~` documentation comments, and
  signatures for common built-ins and the checked I/O namespaces.
- Signature help tracks nested calls, optional parameters, and named arguments.
- Go to Definition and Find References resolve lexical names and public imported
  members. Imports follow the project manifest and normal module search folders;
  open unsaved imported files take precedence over files on disk.
- Rename supports private lexical variables, parameters, and tasks. It preserves
  comments and literal text, updates f-string expressions, and rejects edits that
  would capture a reference or change which declaration it resolves to. Exported
  names, type/field/method names, and callable namespace collisions are deliberately
  excluded until a project-wide semantic index is available. Parameters in
  exported tasks/methods and tasks passed as values are also excluded because
  external named callers cannot be safely rewritten.

This is a lexical source index rather than full type inference or an LSP server.
Object member hints do not follow aliases or runtime type changes. Navigation
searches the current file's import graph, not every potential importer. Analysis
is bounded to 1 MiB per file and 64 files per graph; larger entry files omit source
index features. Multiline declarations, lambdas, comprehensions, destructuring,
triple-quoted text, named argument labels, and f-string expression references
are supported.

## Formatting

Format Document uses `sprout format <file> --stdin` and returns an editor edit,
so unsaved changes remain intact. It requires the current interpreter; failed,
canceled, and stale requests produce no edits. The extension is Sprout's default
formatter. To enable format on save, add this to VS Code settings:

```json
"[sprout]": {
  "editor.defaultFormatter": "fizzexual.sprout-language",
  "editor.formatOnSave": true
}
```

## Commands

With a `.sprout` file open, use the editor toolbar or Command Palette:

- **Sprout: Run File** saves the file and runs it in an integrated task terminal.
- **Sprout: Verify File** checks syntax and imports without executing the program.

The nearest `sprout.toml` selects the working directory; otherwise the workspace
folder is used. Executables and filenames are passed as process arguments, so
paths with spaces work. The retired Node GUI and website commands are no longer
shown.

## Package and install

From this directory:

```sh
npx @vscode/vsce package
code --install-extension sprout-language-0.4.0.vsix
```

## Test

```sh
node --test tests/*.test.js
```

The regression suite covers lexical shadowing, comments and strings,
interpolation-safe edits, lambda/comprehension and multiline scopes, imports,
navigation, signature help, formatting cancellation, diagnostic races, and run
arguments. The extension requires VS Code 1.85 or newer.
