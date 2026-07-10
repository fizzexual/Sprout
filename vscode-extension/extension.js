// extension.js — Sprout support for VS Code:
//   * Run / GUI / Serve / Check commands + a status-bar Run button
//   * Live diagnostics: runs `sprout check` as you type and shows errors inline
//   * Autocomplete for keywords, built-ins, and names already in the file
// (Syntax highlighting and snippets are declared in package.json and need no code.)

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sproutCmd() {
  return vscode.workspace.getConfiguration("sprout").get("command", "sprout");
}

// ---- Run / GUI / Serve / Check: send to an integrated terminal ----
function makeRunner(sub) {
  return () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sprout") {
      vscode.window.showErrorMessage("Open a .sprout file first.");
      return;
    }
    editor.document.save().then(() => {
      const file = editor.document.fileName;
      let term = vscode.window.terminals.find((t) => t.name === "Sprout");
      if (!term) term = vscode.window.createTerminal("Sprout");
      term.show();
      term.sendText(`${sproutCmd()} ${sub} "${file}"`);
    });
  };
}

// ---- Live diagnostics via `sprout check` on a temp copy of the buffer ----
let diagnostics;
const timers = new Map();

function checkDocument(doc) {
  if (!doc || doc.languageId !== "sprout") return;
  // Write the current (possibly unsaved) buffer to a temp file so we can check-as-you-type.
  const tmp = path.join(os.tmpdir(), `sprout-check-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sprout`);
  try { fs.writeFileSync(tmp, doc.getText()); } catch (e) { return; }
  cp.execFile(sproutCmd(), ["check", tmp], { timeout: 8000 }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmp); } catch (e) {}
    const out = `${stderr || ""}\n${stdout || ""}`;
    const diags = [];
    // Format: "Sprout error in <file> (line N): <message>"
    const m = out.match(/Sprout error[^\n]*?\(line (\d+)\):\s*([^\n]*)/);
    if (m) {
      const line = Math.max(0, parseInt(m[1], 10) - 1);
      const textLine = line < doc.lineCount ? doc.lineAt(line) : null;
      const range = textLine
        ? new vscode.Range(line, textLine.firstNonWhitespaceCharacterIndex, line, textLine.text.length)
        : new vscode.Range(line, 0, line, 200);
      diags.push(new vscode.Diagnostic(range, m[2].trim(), vscode.DiagnosticSeverity.Error));
    }
    diagnostics.set(doc.uri, diags);
  });
}

function scheduleCheck(doc, delay) {
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => checkDocument(doc), delay));
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
  "exit", "now", "today", "time"];

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
  for (const [id, sub] of [["sprout.run", "run"], ["sprout.gui", "gui"], ["sprout.serve", "serve"], ["sprout.check", "check"]]) {
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
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)));
  if (vscode.window.activeTextEditor) checkDocument(vscode.window.activeTextEditor.document);

  // completion
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider("sprout", completionProvider()));
}

function deactivate() {}

module.exports = { activate, deactivate };
