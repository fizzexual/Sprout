const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness() {
  const root = path.resolve('fixture', 'project'), file = path.join(root, 'src', 'app.sprout');
  const handlers = {}, commands = {}, children = [], reports = [], tasks = [];
  const disposable = () => ({ dispose() {} });
  const doc = { languageId: 'sprout', fileName: file, version: 1, lineCount: 4, isClosed: false,
    uri: { scheme: 'file', toString: () => file, fsPath: file }, getText: () => 'use helper\nshow 42\n',
    lineAt: () => ({ text: 'show 42', firstNonWhitespaceCharacterIndex: 0 }), save: async () => true };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => path.join(root, 'path with spaces', 'sprout') }),
      getWorkspaceFolder: () => ({ uri: { fsPath: root } }), textDocuments: [],
      ...Object.fromEntries(['Open', 'Save', 'Change', 'Close'].map(event =>
        [`onDid${event}TextDocument`, fn => { handlers[event] = fn; return disposable(); }])) },
    window: { activeTextEditor: { document: doc }, showErrorMessage() {},
      onDidChangeActiveTextEditor: () => disposable(),
      createStatusBarItem: () => ({ ...disposable(), show() {}, hide() {} }) },
    languages: { createDiagnosticCollection: () => ({ ...disposable(), set: (uri, values) => reports.push(values), delete() {} }),
      registerCompletionItemProvider: () => disposable() },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return disposable(); } },
    tasks: { executeTask: async task => tasks.push(task) }, TaskScope: { Workspace: 1 },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Shared: 1 }, StatusBarAlignment: { Left: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Range: class { constructor(...args) { this.args = args; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, { definition, execution }); } },
    ProcessExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
  };
  const cp = { execFile(command, args, options, callback) {
    const child = { command, args, options, callback, killed: false, kill() { this.killed = true; },
      stdin: { on() {}, end(text) { child.input = text; } } };
    children.push(child); return child;
  } };
  const sandbox = { module: { exports: {} }, setTimeout, clearTimeout,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'child_process') return cp;
      if (name === 'fs') return { existsSync: target => target === path.join(root, 'sprout.toml') };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'), sandbox);
  const extension = sandbox.module.exports;
  extension.activate({ subscriptions: [] });
  return { root, file, doc, handlers, commands, children, reports, tasks, extension };
}

test('checks unsaved source in its project, without temporary files', () => {
  const h = harness(); h.handlers.Open(h.doc);
  const child = h.children[0];
  assert.deepEqual(Array.from(child.args), ['check', h.file, '--stdin']);
  assert.equal(child.options.cwd, h.root);
  assert.equal(child.input, h.doc.getText());
  child.callback(null, 'ok', ''); assert.equal(h.reports[0].length, 0);
  h.extension.deactivate();
});

test('older checks cannot overwrite diagnostics from the latest edit', () => {
  const h = harness(); h.handlers.Open(h.doc);
  h.doc.version++; h.handlers.Save(h.doc);
  assert.equal(h.children[0].killed, true);
  h.children[1].callback({ code: 1 }, '', `Sprout error in ${h.file} (line 2): current error\n`);
  h.children[0].callback(null, 'ok', '');
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0][0].message, 'current error');
  h.extension.deactivate();
});

test('closed documents cancel checks and ignore late results', () => {
  const h = harness(); h.handlers.Open(h.doc); h.doc.isClosed = true; h.handlers.Close(h.doc);
  h.children[0].callback({ code: 1 }, '', 'Sprout error (line 2): stale\n');
  assert.equal(h.children[0].killed, true); assert.equal(h.reports.length, 0);
  h.extension.deactivate();
});

test('missing executables report an actionable warning', () => {
  const h = harness(); h.handlers.Open(h.doc); h.children[0].callback({ code: 'ENOENT' }, '', '');
  assert.match(h.reports[0][0].message, /executable not found/); assert.equal(h.reports[0][0].severity, 1);
  h.extension.deactivate();
});

test('imported errors identify their source instead of highlighting an unrelated line', () => {
  const h = harness(); h.handlers.Open(h.doc);
  h.children[0].callback({ code: 1 }, '', 'Sprout error in modules/helper.sprout (line 80): bad import\n');
  assert.match(h.reports[0][0].message, /helper.sprout:80: bad import/);
  assert.equal(h.reports[0][0].range.args[0], 0);
  h.extension.deactivate();
});

test('run uses the executable directly with correct arguments and working directory', async () => {
  const h = harness(); await h.commands['sprout.run']();
  assert.equal(h.tasks.length, 1);
  assert.deepEqual(Array.from(h.tasks[0].execution.args), ['run', h.file]);
  assert.equal(h.tasks[0].execution.options.cwd, h.root);
  assert.equal(h.commands['sprout.gui'], undefined); assert.equal(h.commands['sprout.serve'], undefined);
  h.extension.deactivate();
});

test('cancelled saves do not run outdated code', async () => {
  const h = harness(); h.doc.save = async () => false; await h.commands['sprout.run']();
  assert.equal(h.tasks.length, 0); h.extension.deactivate();
});
