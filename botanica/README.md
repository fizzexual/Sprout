# 🌱 Botanica

**A code editor for the [Sprout](../README.md) language** — built on the same
stack as VS Code (Electron + the Monaco editor), so it feels professional out of
the box: tabs, a file explorer, syntax highlighting, a minimap, and a **Run**
button.

## Run it

```bash
cd botanica
npm install     # one-time: downloads Electron + Monaco
npm start
```

(Or from the project root: `npm run botanica`.)

## What it does

- **Edits Sprout & Bloom** with real syntax highlighting (a custom Monaco grammar)
- **File explorer** — Open Folder to browse and open files
- **Tabs** for multiple open files
- **Run ▶ (F5)** — saves the file and runs it with Sprout; a GUI app opens its
  window, a `server` app opens in the browser, and console output shows in the
  Output panel
- **Open with** — after running the project's
  `tools/install-file-association.ps1`, right-click a `.sprout`/`.bloom` →
  *Open with → Botanica*

## How it's built

| File | Job |
| --- | --- |
| `main.js` | Electron main process: window, menu, file dialogs, runs Sprout |
| `preload.js` | Safe bridge exposing `window.botanica` to the UI |
| `index.html` / `styles.css` | The editor layout (VS Code-style dark theme) |
| `renderer.js` | Editor logic: Monaco, explorer, tabs, run/output |
| `sprout-language.js` | Monaco syntax highlighting for Sprout + Bloom |

> Botanica uses dependencies (Electron + Monaco) — that's how it gets a real
> editor. The Sprout language itself stays dependency-free.
