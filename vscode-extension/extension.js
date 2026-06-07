// extension.js — adds "Run" commands for Sprout files in VS Code.
// (Syntax highlighting and snippets are declared in package.json and need no code.)

const vscode = require("vscode");

function activate(context) {
  const make = (sub) => () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sprout") {
      vscode.window.showErrorMessage("Open a .sprout file first.");
      return;
    }
    editor.document.save().then(() => {
      const cmd = vscode.workspace.getConfiguration("sprout").get("command", "sprout");
      const file = editor.document.fileName;
      let term = vscode.window.terminals.find((t) => t.name === "Sprout");
      if (!term) term = vscode.window.createTerminal("Sprout");
      term.show();
      term.sendText(`${cmd} ${sub} "${file}"`);
    });
  };

  const commands = [
    ["sprout.run", "run"],
    ["sprout.gui", "gui"],
    ["sprout.serve", "serve"],
    ["sprout.check", "check"],
  ];
  for (const [id, sub] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, make(sub)));
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
