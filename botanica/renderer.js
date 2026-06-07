// renderer.js — Botanica's editor UI: Monaco, file explorer, tabs, run panel.

// Monaco loads its language worker from disk (webSecurity is relaxed for this
// local editor). Even if the worker fails, plain editing + highlighting work.
self.MonacoEnvironment = {
  getWorkerUrl: () => "node_modules/monaco-editor/min/vs/base/worker/workerMain.js",
};

require.config({ paths: { vs: "node_modules/monaco-editor/min/vs" } });

let editor = null;
let folderRoot = null;
const tabs = new Map(); // id -> { id, path, name, lang, model }
let currentId = null;
let untitledCount = 0;

require(["vs/editor/editor.main"], () => {
  window.registerSproutLanguages(monaco);

  editor = monaco.editor.create(document.getElementById("editor"), {
    value: "",
    language: "sprout",
    theme: "botanica-dark",
    fontSize: 14,
    automaticLayout: true,
    minimap: { enabled: true },
    fontFamily: "Cascadia Code, Consolas, monospace",
    tabSize: 4,
    insertSpaces: true,
    scrollBeyondLastLine: false,
  });

  editor.onDidChangeCursorPosition((e) => {
    document.getElementById("stPos").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  wireUI();
  newFile(); // start with a blank tab
});

// --- helpers ---------------------------------------------------------------

function langForPath(p) {
  if (p && p.toLowerCase().endsWith(".bloom")) return "bloom";
  return "sprout";
}
function iconFor(name) {
  if (name.endsWith(".sprout")) return "🌱";
  if (name.endsWith(".bloom")) return "🌸";
  return "📄";
}
function baseName(p) {
  return p.split(/[\\/]/).pop();
}

// --- tabs ------------------------------------------------------------------

function newFile() {
  const id = "untitled:" + ++untitledCount;
  const name = `untitled-${untitledCount}.sprout`;
  const model = monaco.editor.createModel("", "sprout");
  tabs.set(id, { id, path: null, name, lang: "sprout", model });
  activateTab(id);
  renderTabs();
}

async function openFile(filePath) {
  for (const t of tabs.values()) {
    if (t.path === filePath) { activateTab(t.id); return; }
  }
  const content = await window.botanica.readFile(filePath);
  const lang = langForPath(filePath);
  const model = monaco.editor.createModel(content, lang);
  const id = "file:" + filePath;
  tabs.set(id, { id, path: filePath, name: baseName(filePath), lang, model });
  activateTab(id);
  renderTabs();
  markActiveInTree(filePath);
}

function activateTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  currentId = id;
  editor.setModel(t.model);
  document.getElementById("stFile").textContent = t.path || t.name;
  document.getElementById("stLang").textContent = t.lang === "bloom" ? "Bloom" : "Sprout";
  renderTabs();
  editor.focus();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.model.dispose();
  tabs.delete(id);
  if (currentId === id) {
    const next = [...tabs.keys()].pop();
    if (next) activateTab(next);
    else { currentId = null; newFile(); }
  }
  renderTabs();
}

function renderTabs() {
  const bar = document.getElementById("tabs");
  bar.innerHTML = "";
  for (const t of tabs.values()) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === currentId ? " active" : "");
    el.innerHTML = `<span class="dot">${iconFor(t.name)}</span><span>${t.name}</span><span class="x" title="Close">✕</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains("x")) closeTab(t.id);
      else activateTab(t.id);
    };
    bar.appendChild(el);
  }
}

// --- file explorer ---------------------------------------------------------

async function openFolder() {
  const dir = await window.botanica.openFolderDialog();
  if (dir) loadFolder(dir);
}

async function loadFolder(dir) {
  folderRoot = dir;
  document.getElementById("folderName").textContent = baseName(dir).toUpperCase();
  const tree = document.getElementById("tree");
  tree.innerHTML = "";
  await buildFolder(dir, 0, tree);
}

async function buildFolder(dirPath, depth, container) {
  let items;
  try { items = await window.botanica.readDir(dirPath); }
  catch { return; }
  for (const it of items) {
    const node = document.createElement("div");
    node.className = "node " + (it.dir ? "folder" : "file");
    node.style.paddingLeft = 8 + depth * 12 + "px";
    const twist = it.dir ? "▸" : "";
    node.innerHTML = `<span class="twist">${twist}</span><span class="ico">${it.dir ? "📁" : iconFor(it.name)}</span>${it.name}`;
    container.appendChild(node);

    if (it.dir) {
      let childWrap = null;
      let open = false;
      node.onclick = async () => {
        open = !open;
        node.querySelector(".twist").textContent = open ? "▾" : "▸";
        if (open) {
          childWrap = document.createElement("div");
          container.insertBefore(childWrap, node.nextSibling);
          await buildFolder(it.path, depth + 1, childWrap);
        } else if (childWrap) {
          childWrap.remove();
          childWrap = null;
        }
      };
    } else {
      node.dataset.path = it.path;
      node.onclick = () => openFile(it.path);
    }
  }
}

function markActiveInTree(filePath) {
  document.querySelectorAll(".node.file.active").forEach((n) => n.classList.remove("active"));
  const n = document.querySelector(`.node.file[data-path="${cssEscape(filePath)}"]`);
  if (n) n.classList.add("active");
}
function cssEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// --- save / run ------------------------------------------------------------

async function saveCurrent() {
  const t = tabs.get(currentId);
  if (!t) return null;
  if (!t.path) {
    const p = await window.botanica.saveAsDialog(t.name);
    if (!p) return null;
    t.path = p;
    t.name = baseName(p);
    t.lang = langForPath(p);
    monaco.editor.setModelLanguage(t.model, t.lang);
  }
  await window.botanica.writeFile(t.path, t.model.getValue());
  document.getElementById("stFile").textContent = t.path;
  renderTabs();
  return t.path;
}

async function runCurrent() {
  const t = tabs.get(currentId);
  if (!t) return;
  const saved = await saveCurrent();
  if (!saved) return;
  if (!saved.toLowerCase().endsWith(".sprout")) {
    appendOutput("[Botanica] Run works on .sprout files. (A .bloom is a stylesheet.)\n");
    return;
  }
  showOutput(true);
  document.getElementById("outputBody").textContent = "";
  appendOutput(`▶ Running ${baseName(saved)} ...\n\n`);
  await window.botanica.runStart(saved);
}

function appendOutput(text) {
  const body = document.getElementById("outputBody");
  body.textContent += text;
  body.scrollTop = body.scrollHeight;
}
function showOutput(on) {
  document.getElementById("editorArea").classList.toggle("with-output", on);
}

// --- wiring ----------------------------------------------------------------

function wireUI() {
  document.getElementById("btnNew").onclick = newFile;
  document.getElementById("btnOpen").onclick = async () => {
    const p = await window.botanica.openFileDialog();
    if (p) openFile(p);
  };
  document.getElementById("btnOpenFolder").onclick = openFolder;
  document.getElementById("btnOpenFolder2").onclick = openFolder;
  document.getElementById("btnSave").onclick = saveCurrent;
  document.getElementById("btnRun").onclick = runCurrent;
  document.getElementById("btnStop").onclick = () => window.botanica.runStop();
  document.getElementById("btnClearOut").onclick = () => (document.getElementById("outputBody").textContent = "");

  window.botanica.onRunData((t) => appendOutput(t));
  window.botanica.onRunEnd((code) => appendOutput(`\n[finished${code != null ? " — exit " + code : ""}]\n`));

  window.botanica.onOpenPath((p) => openFile(p));
  window.botanica.onOpenFolderPath((p) => loadFolder(p));
  window.botanica.onMenu(async (ch) => {
    if (ch === "menu-new") newFile();
    else if (ch === "menu-open") { const p = await window.botanica.openFileDialog(); if (p) openFile(p); }
    else if (ch === "menu-open-folder") openFolder();
    else if (ch === "menu-save") saveCurrent();
    else if (ch === "menu-save-as") { const t = tabs.get(currentId); if (t) { t.path = null; saveCurrent(); } }
    else if (ch === "menu-run") runCurrent();
    else if (ch === "menu-stop") window.botanica.runStop();
  });
}
