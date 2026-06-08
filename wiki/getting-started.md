# Getting Started

## Running a program

A Sprout program is a file ending in **`.sprout`**. There are several ways to run one:

| Way | How |
| --- | --- |
| **Open it to edit** | Double-click a `.sprout` or `.bloom` file — it opens in your editor (VS Code by default). |
| **Run from Explorer** | Right-click a `.sprout` file → **Run with Sprout**. A GUI app opens its window; a `server` app opens in the browser; a plain program shows its output. |
| **VS Code** | Open it in VS Code with the [Sprout extension](../vscode-extension) — highlighting + a **Run** button. |
| **Command line** | `sprout run myprogram.sprout` |

Set the double-click behavior up once (per-user, no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-file-association.ps1
```

It opens files in **VS Code** if it's installed (otherwise Notepad). To choose a
different editor, pass `-Editor notepad++`, `-Editor sublime`, `-Editor cursor`,
or `-Editor "C:\Path\To\editor.exe"`.

### The `sprout` command

```bash
sprout run file.sprout      # run a program
sprout gui file.sprout      # open it as a native window
sprout serve file.sprout    # run it as a website
sprout check file.sprout    # verify it WITHOUT running it
sprout repl                 # type code interactively
sprout version
```

Sprout **checks your whole program for mistakes before running any of it** — so
typos, unknown names, and wrong argument counts are caught up front, not
halfway through. `sprout check` does just the check.

To make `sprout` available everywhere, run `npm link` once in the project folder.

## Hello, world

Put this in `hello.sprout`:

```sprout
show "Hello, world!"
```

Run it and you'll see `Hello, world!`.

## Friendly errors

When something is wrong, Sprout points at the exact spot and explains it in plain
language:

```
🌱 Oops — name problem on line 2:

  2 | show "Hi, " + nme
    |               ^

  I don't know what 'nme' is.

  💡 Did you mean 'name'?
```

## Next

- Learn the language: **[Sprout Syntax](sprout-syntax.md)**
- Build an app with a window: **[GUI & Servers](gui-and-servers.md)**
