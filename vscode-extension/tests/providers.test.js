const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness(files = {}) {
  const root = path.resolve('fixture', 'project'), open = [], children = [];
  const asPath = name => path.resolve(root, name);
  const entries = new Map(Object.entries(files).map(([name, text]) => [asPath(name), text]));
  const positionAt = (text, n) => { const lines = text.slice(0, n).split('\n'); return { line: lines.length - 1, character: lines[lines.length - 1].length }; };
  function document(text, name = 'app.sprout') {
    const doc = { fileName: asPath(name), isClosed: false, version: 1, getText: () => text,
      uri: { fsPath: asPath(name), toString: () => asPath(name) },
      positionAt: n => positionAt(text, n), offsetAt: p => text.split('\n').slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character };
    return doc;
  }
  class Range { constructor(...args) { this.args = args; } }
  class MarkdownString { constructor() { this.value = ''; } appendCodeblock(text) { this.value += text; return this; } appendText(text) { this.value += text; return this; } }
  const vscode = {
    workspace: { textDocuments: open, getConfiguration: () => ({ get: (key, fallback) => fallback }) }, Range, MarkdownString,
    CompletionItemKind: { Function: 1, Variable: 2, Class: 3, Module: 4, Keyword: 5 },
    CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
    SnippetString: class { constructor(value) { this.value = value; } },
    Hover: class { constructor(contents) { this.contents = contents; } },
    SignatureInformation: class { constructor(label, documentation) { Object.assign(this, { label, documentation }); } },
    ParameterInformation: class { constructor(label) { this.label = label; } }, SignatureHelp: class {},
    Uri: { file: file => ({ fsPath: file }) },
    Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } },
    TextEdit: { replace: (range, text) => ({ range, text }) },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }, DiagnosticSeverity: { Warning: 1 },
  };
  const cp = { execFile(command, args, options, callback) { const child = { command, args, options, callback, killed: false, kill() { this.killed = true; }, stdin: { on() {}, end(text) { child.text = text; } } }; children.push(child); return child; } };
  const sandbox = { module: { exports: {} }, require(name) {
    if (name === 'vscode') return vscode;
    if (name === 'node:child_process') return cp;
    if (name === 'node:fs') return { statSync(file) { if (!entries.has(file)) throw Error('missing'); return { size: entries.get(file).length }; }, readFileSync: file => entries.get(file) };
    if (name === './analysis') return require('../analysis');
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../providers.js'), 'utf8'), sandbox);
  const api = sandbox.module.exports;
  const provider = api.providers(() => root, () => 'sprout');
  function cancellation() { let callback; return { isCancellationRequested: false, onCancellationRequested(fn) { callback = fn; return { dispose() {} }; }, cancel() { this.isCancellationRequested = true; callback?.(); } }; }
  return { root, open, entries, document, provider, children, cancellation, api, asPath };
}

test('contextual completions hide other scopes and string/comment contents', () => {
  const h = harness(), text = 'task greet(person):\n    make local = person\n    show local\nshow 1\n~ task ghost\n';
  const doc = h.document(text);
  const inside = h.provider.completion.provideCompletionItems(doc, doc.positionAt(text.indexOf('show local')));
  const outside = h.provider.completion.provideCompletionItems(doc, doc.positionAt(text.indexOf('show 1')));
  assert.equal(inside.some(i => i.label === 'person'), true);
  assert.equal(outside.some(i => i.label === 'person' || i.label === 'local' || i.label === 'ghost'), false);
  assert.equal(h.provider.completion.provideCompletionItems(doc, doc.positionAt(text.indexOf('ghost'))).length, 0);
});

test('imports resolve from manifest and unsaved modules override disk', () => {
  const h = harness({ 'sprout.toml': 'include = ["special/helpers.sprout"]', 'special/helpers.sprout': 'public task old():\n    give 0\n' });
  h.open.push(h.document('~ Say hello to someone.\npublic task greet(name, ending = "!"):\n    give name\nprivate task hidden():\n    give 1\n', 'special/helpers.sprout'));
  const text = 'use helpers\nhelpers.greet("Ada", )\nhelpers.\n';
  const doc = h.document(text), at = text.indexOf('greet');
  const definition = h.provider.definition.provideDefinition(doc, doc.positionAt(at));
  assert.equal(definition.uri.fsPath, h.asPath('special/helpers.sprout'));
  const hover = h.provider.hover.provideHover(doc, doc.positionAt(at));
  assert.match(hover.contents.value, /Say hello/);
  const completion = h.provider.completion.provideCompletionItems(doc, doc.positionAt(text.lastIndexOf('helpers.') + 8));
  assert.deepEqual(Array.from(completion.map(i => i.label)), ['greet']);
  const signature = h.provider.signature.provideSignatureHelp(doc, doc.positionAt(text.indexOf(', )') + 2));
  assert.equal(signature.activeParameter, 1); assert.match(signature.signatures[0].label, /ending =/);
  assert.equal(h.provider.reference.provideReferences(doc, doc.positionAt(at), { includeDeclaration: true }).length, 2);
});

test('cyclic imports terminate and preserve source navigation', () => {
  const h = harness({ 'a.sprout': 'use b\npublic task one():\n    give 1\n', 'b.sprout': 'use a\npublic task two():\n    give 2\n' });
  const doc = h.document('use a\nshow a.one()\n');
  const p = h.api.project(doc, h.root);
  assert.equal(p.models.size, 3);
  assert.equal(h.provider.definition.provideDefinition(doc, doc.positionAt(doc.getText().indexOf('one'))).uri.fsPath, h.asPath('a.sprout'));
});

test('standard namespace members offer checked API documentation', () => {
  const h = harness(), doc = h.document('use http\nuse files\nhttp.request("url", )\nfiles.\n');
  const items = h.provider.completion.provideCompletionItems(doc, doc.positionAt(doc.getText().lastIndexOf('files.') + 6));
  assert.equal(items.some(i => i.label === 'read'), true);
  const signature = h.provider.signature.provideSignatureHelp(doc, doc.positionAt(doc.getText().indexOf(', )') + 2));
  assert.match(signature.signatures[0].label, /^request\(url, options/);
  const hover = h.provider.hover.provideHover(doc, doc.positionAt(doc.getText().indexOf('request')));
  assert.match(hover.contents.value, /timed_out/);
});

test('rename produces isolated edits and refuses changed binding', () => {
  const h = harness(), doc = h.document('make person = "person"\nshow person ~ person\n');
  const result = h.provider.rename.provideRenameEdits(doc, doc.positionAt(6), 'name');
  assert.equal(result.edits.length, 2);
  assert.deepEqual(Array.from(result.edits.map(e => e.range.args[0])), [0, 1]);
  const collision = h.document('make outer = 1\ntask work(local):\n    show outer\n');
  assert.throws(() => h.provider.rename.provideRenameEdits(collision, collision.positionAt(6), 'local'), /another declaration/);
});

test('formatting passes unsaved text on stdin and returns an editor edit', async () => {
  const h = harness(), doc = h.document('show   42\n'), token = h.cancellation();
  const pending = h.provider.formatting.provideDocumentFormattingEdits(doc, {}, token);
  assert.deepEqual(Array.from(h.children[0].args), ['format', doc.fileName, '--stdin']);
  assert.equal(h.children[0].text, doc.getText());
  h.children[0].callback(null, 'show 42\n');
  const edits = await pending; assert.equal(edits.length, 1); assert.equal(edits[0].text, 'show 42\n');
});

test('formatting ignores stale, canceled, failed, or unchanged output', async () => {
  for (const state of ['stale', 'cancel', 'failed', 'same']) {
    const h = harness(), doc = h.document('show 42\n'), token = h.cancellation();
    const pending = h.provider.formatting.provideDocumentFormattingEdits(doc, {}, token);
    if (state === 'stale') doc.version++;
    if (state === 'cancel') token.cancel();
    h.children[0].callback(state === 'failed' ? Error('failed') : null, state === 'same' ? doc.getText() : 'show 24\n');
    assert.equal((await pending).length, 0);
    if (state === 'cancel') assert.equal(h.children[0].killed, true);
  }
});

test('static warnings combine known arity and assignments without speculative errors', () => {
  const h = harness(), doc = h.document('task greet(name):\n    give name\ngreet()\nset absent = 1\nshow unknown_dynamic_value\n');
  const warnings = h.provider.staticDiagnostics(doc);
  assert.deepEqual(Array.from(warnings.map(w => w.code)).sort(), ['task-arity', 'unbound-assignment']);
});
