# Sprout for VS Code

Syntax highlighting, snippets, autocomplete, live diagnostics, and Run/Verify
commands for the [Sprout](https://github.com/fizzexual/Sprout) programming language.
Legacy Bloom files retain syntax highlighting.

## Set up the interpreter

Build the current C interpreter from this checkout. On Windows, run
`src\build.cmd`, then `install.ps1` from the repository root. Restart VS Code so
its terminals inherit the updated PATH. Alternatively, set `sprout.command` to
the full executable path, including any spaces; do not add shell quotes.

Live diagnostics require the current `sprout check <file> --stdin` command. The
extension checks unsaved buffers in the project directory without running code.
It reports syntax, import, and declaration errors. Runtime type/value errors are
reported when you run the program.

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
code --install-extension sprout-language-0.3.1.vsix
```

## Test

```sh
node --test tests/*.test.js
```

The regression suite covers unsaved buffers, project paths, diagnostic races,
closed documents, missing executables, imported errors, and run arguments.
