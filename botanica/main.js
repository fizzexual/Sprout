// main.js — Botanica's Electron main process.
//
// Creates the window, builds the native menu, handles file dialogs and disk
// access, and runs Sprout programs (by spawning the Sprout CLI), streaming
// their output back to the editor.

const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fss = require("node:fs");
const { spawn } = require("node:child_process");

// In dev, the Sprout CLI lives in ../src. When packaged into an .exe, the
// Sprout source is bundled as an "extraResource" (see package.json > build).
const SPROUT_CLI = app.isPackaged
  ? path.join(process.resourcesPath, "sprout-src", "cli.ts")
  : path.join(__dirname, "..", "src", "cli.ts");

let mainWindow = null;
let runChild = null;

// A path passed on the command line (e.g. from "Open with" / the context menu).
// dev/unpacked: argv = [electron, <appDir or ".">, <userPath?>] -> skip the app path.
// packaged:     argv = [exe, <userPath?>].
function pathFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (!a || a.startsWith("-")) continue;
    try { if (fss.existsSync(a)) return a; } catch { /* ignore */ }
  }
  return null;
}

let pendingPath = pathFromArgv(process.argv);

// Open a file in a tab, or a folder in the explorer, depending on what it is.
function sendOpen(p) {
  if (!mainWindow || !p) return;
  const abs = path.resolve(p);
  try {
    if (fss.statSync(abs).isDirectory()) mainWindow.webContents.send("open-folder-path", abs);
    else mainWindow.webContents.send("open-path", abs);
  } catch { /* ignore */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#1e1e1e",
    title: "Botanica",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Local-only editor: relax file:// rules so Monaco's worker can load.
      webSecurity: false,
    },
  });

  buildMenu();
  mainWindow.loadFile("index.html");

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingPath) {
      sendOpen(pendingPath);
      pendingPath = null;
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      sendOpen(pathFromArgv(argv));
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function buildMenu() {
  const send = (channel) => () => mainWindow && mainWindow.webContents.send(channel);
  const template = [
    {
      label: "File",
      submenu: [
        { label: "New File", accelerator: "CmdOrCtrl+N", click: send("menu-new") },
        { label: "Open File…", accelerator: "CmdOrCtrl+O", click: send("menu-open") },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+K", click: send("menu-open-folder") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: send("menu-save") },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: send("menu-save-as") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Run",
      submenu: [
        { label: "Run Program", accelerator: "F5", click: send("menu-run") },
        { label: "Stop", accelerator: "Shift+F5", click: send("menu-stop") },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- file system over IPC ---
ipcMain.handle("dialog:openFile", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Sprout & Bloom", extensions: ["sprout", "bloom"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("dialog:openFolder", async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("dialog:saveAs", async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || "untitled.sprout",
    filters: [
      { name: "Sprout", extensions: ["sprout"] },
      { name: "Bloom", extensions: ["bloom"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("fs:read", (_e, p) => fs.readFile(p, "utf8"));
ipcMain.handle("fs:write", (_e, p, data) => fs.writeFile(p, data, "utf8"));
ipcMain.handle("fs:readdir", async (_e, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});
ipcMain.handle("path:dirname", (_e, p) => path.dirname(p));

// --- run a Sprout program ---
ipcMain.handle("run:start", (_e, filePath) => {
  if (runChild) {
    try { runChild.kill(); } catch { /* ignore */ }
    runChild = null;
  }
  // Quote paths (the repo path has spaces) and let the user's Node run the CLI.
  const cmd = `node "${SPROUT_CLI}" run "${filePath}"`;
  runChild = spawn(cmd, { shell: true, cwd: path.dirname(filePath) });

  const send = (t) => mainWindow && mainWindow.webContents.send("run:data", t);
  runChild.stdout.on("data", (d) => send(d.toString()));
  runChild.stderr.on("data", (d) => send(d.toString()));
  runChild.on("close", (code) => {
    if (mainWindow) mainWindow.webContents.send("run:end", code);
    runChild = null;
  });
  runChild.on("error", (err) => send("\n[Botanica] couldn't start: " + err.message + "\n"));
  return true;
});

ipcMain.handle("run:stop", () => {
  if (runChild) {
    try { runChild.kill(); } catch { /* ignore */ }
    runChild = null;
  }
  return true;
});
