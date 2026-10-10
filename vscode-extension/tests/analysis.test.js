const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyze, symbolAt, visibleSymbols, rename, references, callAt, callIssues } = require('../analysis');

test('scopes respect branch locals, task parameters, and shadowing', () => {
  const text = 'make value = 1\ntask work(value):\n    when yes:\n        make inner = value\n        show inner\n    show value\nshow value\n';
  const model = analyze(text);
  const roots = model.symbols.filter(s => s.name === 'value');
  assert.equal(roots.length, 2);
  assert.equal(symbolAt(model, text.lastIndexOf('value')).id, roots[0].id);
  assert.equal(symbolAt(model, text.indexOf('show value') + 5).id, roots[1].id);
  assert.equal(visibleSymbols(model, text.indexOf('show value')).some(s => s.name === 'inner'), false);
  assert.equal(visibleSymbols(model, text.indexOf('show inner')).some(s => s.name === 'inner'), true);
});

test('comments and strings cannot declare names or become references', () => {
  const text = '~ make ghost = 1\nmake text = "make fake = ghost"\nshow text ~ text\n';
  const model = analyze(text);
  assert.deepEqual(model.symbols.map(s => s.name), ['text']);
  const edits = rename(model, model.symbols[0], 'message');
  assert.equal(edits.length, 2);
  assert.equal(text.slice(edits[1].token.start, edits[1].token.end), 'text');
});

test('punctuation inside text cannot change indentation scopes or call arity', () => {
  const text = 'task one(value):\n    give value\nwhen one("(") == "(":\n    make inside = ")"\nmake outside = ":"\none(",")\n';
  const model = analyze(text);
  assert.equal(model.symbols.find(s => s.name === 'outside').scope, model.root);
  assert.equal(callIssues(model).length, 0);
  assert.equal(model.resolve('inside', text.indexOf('one(",")')), null);
});

test('renames edit interpolation expressions and preserve string text', () => {
  const text = 'make name = "Sam"\nshow f"name={name}, {upper(name)}"\n';
  const model = analyze(text), edits = rename(model, model.symbols[0], 'person');
  assert.equal(edits.length, 3);
  assert.equal(callIssues(model).length, 0);
});

test('rename rejects a capture in either direction and reserved names', () => {
  const model = analyze('make outer = 1\ntask work(local):\n    show outer, local\n');
  const outer = model.symbols.find(s => s.name === 'outer'), local = model.symbols.find(s => s.name === 'local');
  assert.throws(() => rename(model, outer, 'local'), /another declaration/);
  assert.throws(() => rename(model, local, 'outer'), /capture/);
  assert.throws(() => rename(model, outer, 'when'), /valid name/);
  assert.throws(() => rename(analyze('public task exported():\n    give 1\n'), analyze('public task exported():\n    give 1\n').symbols[0], 'new_name'), /Exported/);
});

test('hoisted tasks and later file variables resolve inside tasks', () => {
  const text = 'show double(2)\ntask double(n):\n    give n + base\nmake base = 5\n';
  const model = analyze(text);
  assert.equal(symbolAt(model, text.indexOf('double')).kind, 'task');
  assert.equal(symbolAt(model, text.indexOf('base')).kind, 'variable');
  assert.equal(model.resolve('base', 0), null);
});

test('lambda and comprehension bindings stay within their expressions', () => {
  const text = 'make result = map([1], task(item): item + 1)\nmake values = [n * 2 for each n in [1, 2]]\nshow item, n\n';
  const model = analyze(text);
  assert.equal(symbolAt(model, text.indexOf('item +')).kind, 'parameter');
  assert.equal(symbolAt(model, text.indexOf('n *')).kind, 'variable');
  assert.equal(symbolAt(model, text.lastIndexOf('item')), null);
  assert.equal(symbolAt(model, text.lastIndexOf('n')), null);
});

test('known task arity handles defaults, nested calls, strings, and incomplete calls', () => {
  const text = 'task greet(name, suffix = "!"):\n    give name + suffix\ngreet()\ngreet("A", upper("b"))\ngreet(f"x{name}")\ngreet("a", "b", "c")\ngreet(\n';
  const model = analyze(text), issues = callIssues(model);
  assert.equal(issues.length, 2);
  assert.match(issues[0].message, /0/);
  assert.match(issues[1].message, /3/);
  const call = callAt(model, text.indexOf('upper("b"') + 'upper("b"'.length);
  assert.equal(call.name, 'upper');
  const outer = callAt(model, text.indexOf('upper("b"') - 1);
  assert.equal(outer.name, 'greet'); assert.equal(outer.activeParameter, 1);
});

test('multiline headers preserve parameters and pipeline implicit arguments', () => {
  const text = 'task combine(\n    first,\n    second = 2,\n):\n    give first + second\nmake outside = 5\nshow 1 |> combine()\n';
  const model = analyze(text), task = model.symbols.find(s => s.name === 'combine');
  assert.equal(task.params.length, 2);
  assert.equal(symbolAt(model, text.indexOf('first +')).kind, 'parameter');
  assert.equal(model.symbols.find(s => s.name === 'outside').scope, model.root);
  assert.equal(callIssues(model).length, 0);
});

test('triple-quoted text stays opaque to source indexing and rename', () => {
  const text = 'make value = 1\nmake message = """\nmake fake = value\n( ignored )\n"""\nshow value\n';
  const model = analyze(text), variable = model.symbols.find(s => s.name === 'value');
  assert.deepEqual(model.symbols.map(s => s.name), ['value', 'message']);
  assert.equal(rename(model, variable, 'counted').length, 2);
  assert.equal(model.issues.length, 0);
});

test('named arguments resolve to parameters and private renames update their labels', () => {
  const text = 'task greet(name, ending = "!"):\n    give name + ending\ngreet(name: "Ada")\ngreet(ending: "?")\ngreet(unknown: "X")\ngreet(name: "A", "!")\n';
  const model = analyze(text), parameter = model.symbols.find(s => s.name === 'name');
  assert.equal(symbolAt(model, text.indexOf('name: "Ada"')).id, parameter.id);
  assert.equal(rename(model, parameter, 'person').length, 4);
  assert.deepEqual(callIssues(model).map(i => i.code), ['task-arguments', 'task-arguments', 'task-arguments']);
});

test('members resolve for a known constructor without confusing object keys', () => {
  const text = 'type Point:\n    make x\n    task shift(self, amount):\n        give self.x + amount\nmake p = Point(1)\np.shift(2)\nmake data = {x: 1}\n';
  const model = analyze(text), method = symbolAt(model, text.lastIndexOf('shift'));
  assert.equal(method.kind, 'method');
  assert.equal(symbolAt(model, text.indexOf('self.x') + 5).kind, 'field');
  assert.equal(callIssues(model).length, 0);
  assert.throws(() => rename(model, method, 'move'), /members/);
});

test('module navigation and references expose public declarations only', () => {
  const library = analyze('public task greet(name):\n    give name\nprivate task hidden():\n    give 0\n', '/lib.sprout');
  const entry = analyze('use lib\nlib.greet("A")\nlib.hidden()\n', '/app.sprout');
  const modules = new Map([['lib', library]]);
  const symbol = symbolAt(entry, entry.text.indexOf('greet'), modules);
  assert.equal(symbol.file, library.file);
  assert.equal(symbolAt(entry, entry.text.indexOf('hidden'), modules), null);
  assert.equal(references([entry, library], symbol, new Map([[entry.file, modules]])).length, 2);
});

test('diagnostics target only confident declaration and assignment mistakes', () => {
  const model = analyze('make x = 1\nmake x = 2\nset missing = 3\nshow dynamic_call(1)\n');
  assert.deepEqual(model.issues.map(i => i.code), ['duplicate-name', 'unbound-assignment']);
});
