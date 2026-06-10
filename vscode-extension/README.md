# Sprout for VS Code

Language support for the [Sprout](https://github.com/fizzexual/Sprout)
programming language and its styling language **Bloom**.

## Features

- 🎨 **Syntax highlighting** for `.sprout` and `.bloom`
- ✂️ **Snippets** — type `window`, `task`, `when`, `repeat`, `make`, … and press Tab
- ▶️ **Run commands** — Run, Run as Window, Run as Website, and Verify, from the
  editor title bar, the right-click menu, or the Command Palette
- 🌱 File icons for `.sprout` and `.bloom`

## Run commands

With a `.sprout` file open: click the **▶ Run** button in the editor title bar,
or right-click → **Sprout: Run File** (also `Run as Window`, `Run as Website`,
`Verify File`). They run in an integrated terminal.

The commands call `sprout` on your PATH. From the Sprout repo, run `npm link`
once to make `sprout` available — or set **`sprout.command`** in Settings to a
full path / `node path\to\src\cli.ts`.

## Install

**Try it instantly:** open this folder in VS Code and press <kbd>F5</kbd> — a new
"Extension Development Host" window opens with the extension loaded. Open any
`.sprout` file to see highlighting.

**Install permanently:** package it into a `.vsix` and install that:

```bash
npx @vscode/vsce package
code --install-extension sprout-language-0.1.0.vsix
```
