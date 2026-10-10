// extension.js — Sprout support for VS Code:
//   * Run / Check commands + a status-bar Run button
//   * Live diagnostics: checks the unsaved buffer through `sprout check --stdin`
//   * Lexical completion, navigation, task signatures, rename, and formatting
// (Syntax highlighting and snippets are declared in package.json and need no code.)

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { providers } = require("./providers");
let languageTools;

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
    const diags = languageTools ? languageTools.staticDiagnostics(doc) : [];
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

function activate(context) {
  languageTools = providers(projectDirectory, sproutCmd);
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

  const selector = { language: "sprout", scheme: "file" };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, languageTools.completion, "."));
  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, languageTools.hover));
  context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, languageTools.signature, "(", ","));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, languageTools.definition));
  context.subscriptions.push(vscode.languages.registerReferenceProvider(selector, languageTools.reference));
  context.subscriptions.push(vscode.languages.registerRenameProvider(selector, languageTools.rename));
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, languageTools.formatting));
}

function deactivate() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const child of checks.values()) child.kill();
  checks.clear();
}

module.exports = { activate, deactivate };
