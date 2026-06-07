// preload.js — the safe bridge between the editor UI (renderer) and the
// Electron main process. The renderer only ever sees window.botanica.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("botanica", {
  // dialogs
  openFileDialog: () => ipcRenderer.invoke("dialog:openFile"),
  openFolderDialog: () => ipcRenderer.invoke("dialog:openFolder"),
  saveAsDialog: (defaultPath) => ipcRenderer.invoke("dialog:saveAs", defaultPath),

  // disk
  readFile: (p) => ipcRenderer.invoke("fs:read", p),
  writeFile: (p, data) => ipcRenderer.invoke("fs:write", p, data),
  readDir: (dir) => ipcRenderer.invoke("fs:readdir", dir),
  dirname: (p) => ipcRenderer.invoke("path:dirname", p),

  // running programs
  runStart: (p) => ipcRenderer.invoke("run:start", p),
  runStop: () => ipcRenderer.invoke("run:stop"),
  onRunData: (cb) => ipcRenderer.on("run:data", (_e, t) => cb(t)),
  onRunEnd: (cb) => ipcRenderer.on("run:end", (_e, code) => cb(code)),

  // menu + "open with"
  onMenu: (cb) => {
    const channels = [
      "menu-new", "menu-open", "menu-open-folder",
      "menu-save", "menu-save-as", "menu-run", "menu-stop",
    ];
    for (const ch of channels) ipcRenderer.on(ch, () => cb(ch));
  },
  onOpenPath: (cb) => ipcRenderer.on("open-path", (_e, p) => cb(p)),
});
