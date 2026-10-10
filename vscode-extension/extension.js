// extension.js — Sprout support for VS Code:
//   * Run / Check commands + a status-bar Run button
//   * Live diagnostics: checks the unsaved buffer through `sprout check --stdin`
//   * Autocomplete for keywords, built-ins, and names already in the file
// (Syntax highlighting and snippets are declared in package.json and need no code.)

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

function sproutCmd() {
  return vscode.workspace.getConfiguration("sprout").get("command", "sprout");
}

function projectDirectory(doc) {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  let dir = path.dirname(doc.fileName);
  while (true) {
    if (fs.existsSync(path.join(dir, "sprout.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return folder ? folder.uri.fsPath : path.dirname(doc.fileName);
}

// ProcessExecution handles paths with spaces and shell metacharacters on every OS.
function makeRunner(sub) {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sprout") {
      vscode.window.showErrorMessage("Open a .sprout file first.");
      return;
    }
    if (!(await editor.document.save())) return;
    const task = new vscode.Task({ type: "sprout", command: sub }, vscode.TaskScope.Workspace,
      sub === "run" ? "Run File" : "Verify File", "Sprout",
      new vscode.ProcessExecution(sproutCmd(), [sub, editor.document.fileName],
        { cwd: projectDirectory(editor.document) }), []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared };
    await vscode.tasks.executeTask(task);
  };
}

// ---- Live diagnostics, preserving the real filename and project import paths ----
let diagnostics;
const timers = new Map();
const checks = new Map();

function checkDocument(doc) {
  if (!doc || doc.isClosed || doc.languageId !== "sprout" || doc.uri.scheme !== "file") return;
  const key = doc.uri.toString(), version = doc.version, cwd = projectDirectory(doc);
  const previous = checks.get(key);
  if (previous) previous.kill();
  const child = cp.execFile(sproutCmd(), ["check", doc.fileName, "--stdin"], { cwd, timeout: 8000 }, (err, stdout, stderr) => {
    if (checks.get(key) !== child) return;
    checks.delete(key);
    if (doc.isClosed || doc.version !== version) return;
    const out = `${stderr || ""}\n${stdout || ""}`;
    const diags = [];
    // Format: "Sprout error in <file> (line N): <message>"
    const m = out.match(/Sprout error(?: in (.*?))?(?: \(line (\d+)\))?: +([^\n]*)/);
    if (m) {
      const imported = m[1] && path.resolve(cwd, m[1]) !== path.resolve(doc.fileName);
      const line = imported ? 0 : Math.min(doc.lineCount - 1, Math.max(0, parseInt(m[2] || "1", 10) - 1));
      const textLine = line < doc.lineCount ? doc.lineAt(line) : null;
      const range = textLine
        ? new vscode.Range(line, textLine.firstNonWhitespaceCharacterIndex, line, textLine.text.length)
        : new vscode.Range(line, 0, line, 200);
      const message = imported ? `${path.basename(m[1])}:${m[2] || 1}: ${m[3].trim()}` : m[3].trim();
      diags.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
    } else if (err) {
      const message = err.code === "ENOENT"
        ? "Sprout executable not found. Install Sprout or set sprout.command to its full path."
        : "Sprout could not check this file. Run Sprout: Verify File to see the details.";
      diags.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Warning));
    }
    diagnostics.set(doc.uri, diags);
  });
  checks.set(key, child);
  child.stdin.on("error", () => {}); // a missing executable may close stdin before the buffer is sent
  child.stdin.end(doc.getText());
}

function scheduleCheck(doc, delay) {
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); checkDocument(doc); }, delay));
}

// ---- Autocomplete ----
const KEYWORDS = ["make", "set", "show", "when", "orwhen", "otherwise", "for each", "in", "repeat",
  "while", "task", "give", "type", "interface", "does", "from", "match", "is", "try", "caught",
  "fail", "use", "and", "or", "not", "stop", "skip", "public", "private", "yes", "no", "nothing"];
const BUILTINS = ["range", "length", "add", "remove", "insert", "sort", "sort_by", "reverse",
  "index_of", "map", "filter", "reduce", "group_by", "min_by", "max_by", "partition", "chunk",
  "sum", "count", "unique", "zip", "flatten", "slice", "keys", "values", "contains", "first",
  "last", "copy", "kind_of", "is_a", "round", "format", "floor", "ceil", "abs", "sqrt", "pow",
  "min", "max", "clamp", "sign", "random", "number", "is_number", "upper", "lower", "trim",
  "replace", "split", "join", "starts_with", "ends_with", "words", "lines", "title", "pad_start",
  "pad_end", "code", "char", "matches", "find", "find_all", "captures", "ask", "args", "env",
  "exit", "now", "today", "time", "seed", "sin", "cos", "tan", "log", "exp", "pi",
  "days", "hours", "minutes", "time_parts", "time_make", "time_format", "wait",
  "read", "write", "append", "exists", "remember", "recall", "forget", "get", "json", "explore", "color"];

function completionProvider() {
  return {
    provideCompletionItems(doc) {
      const items = [];
      for (const k of KEYWORDS) {
        const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
        items.push(it);
      }
      for (const b of BUILTINS) {
        const it = new vscode.CompletionItem(b, vscode.CompletionItemKind.Function);
        it.insertText = new vscode.SnippetString(`${b}($0)`);
        items.push(it);
      }
      // names already defined in this file (make X / task X / type X)
      const seen = new Set([...KEYWORDS, ...BUILTINS]);
      const re = /\b(?:make|task|type|interface)\s+([A-Za-z_]\w*)/g;
      let mm;
      while ((mm = re.exec(doc.getText()))) {
        if (!seen.has(mm[1])) { seen.add(mm[1]); items.push(new vscode.CompletionItem(mm[1], vscode.CompletionItemKind.Variable)); }
      }
      return items;
    },
  };
}

function activate(context) {
  for (const [id, sub] of [["sprout.run", "run"], ["sprout.check", "check"]]) {
    context.subscriptions.push(vscode.commands.registerCommand(id, makeRunner(sub)));
  }

  // status-bar Run button (shown for .sprout files)
  const runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  runButton.command = "sprout.run";
  runButton.text = "$(play) Run Sprout";
  runButton.tooltip = "Run this Sprout file";
  context.subscriptions.push(runButton);
  const updateButton = () => {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === "sprout") runButton.show(); else runButton.hide();
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateButton));
  updateButton();

  // diagnostics
  diagnostics = vscode.languages.createDiagnosticCollection("sprout");
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((d) => checkDocument(d)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => checkDocument(d)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => scheduleCheck(e.document, 400)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => {
    const key = d.uri.toString();
    clearTimeout(timers.get(key)); timers.delete(key);
    const child = checks.get(key); checks.delete(key);
    if (child) child.kill();
    diagnostics.delete(d.uri);
  }));
  for (const doc of vscode.workspace.textDocuments) checkDocument(doc);

  // completion
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider("sprout", completionProvider()));
}

function deactivate() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const child of checks.values()) child.kill();
  checks.clear();
}

module.exports = { activate, deactivate };
