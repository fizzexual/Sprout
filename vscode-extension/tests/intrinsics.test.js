const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { analyze, tokenize, symbolAt, intrinsicAt, intrinsicCompletion, references, rename, callAt, callIssues, BUILTINS } = require('../analysis');

test('only adjacent double colons create the contextual intrinsic token', () => {
  assert.deepEqual(tokenize('builtin :: number(1)').tokens.map(t => t.value), ['builtin', '::', 'number', '(', '1', ')']);
  assert.deepEqual(tokenize('builtin : : number(1)').tokens.map(t => t.value), ['builtin', ':', ':', 'number', '(', '1', ')']);
  const text = 'make builtin = 1\nshow builtin\nshow builtin::number("2")\nshow builtin : : number("2")\n';
  const model = analyze(text), binding = model.symbols[0];
  assert.equal(symbolAt(model, text.indexOf('show builtin') + 5).id, binding.id);
  assert.equal(symbolAt(model, text.indexOf('builtin::')), null);
  assert.equal(symbolAt(model, text.indexOf('number("2")')), null);
  assert.equal(symbolAt(model, text.indexOf('builtin : :')).id, binding.id);
});

test('intrinsic names cannot acquire lexical task or constructor identity', () => {
  const text = 'make builtin = 1\ntask number(first, second):\n    give first\ntype length:\n    make value\nnumber(1, 2)\nbuiltin::number("2")\nbuiltin::length([1])\n';
  const model = analyze(text), task = model.symbols.find(s => s.kind === 'task');
  const ordinary = callAt(model, text.indexOf('number(1, 2)') + 9);
  const explicit = callAt(model, text.indexOf('number("2")') + 8);
  assert.equal(ordinary.symbol, task);
  assert.equal(explicit.symbol, null);
  assert.equal(explicit.intrinsic.prefix.value, 'builtin');
  assert.equal(references([model], task).length, 2, 'declaration and ordinary call only');
  assert.equal(callIssues(model).length, 0, 'native calls do not inherit a shadowing task arity');
});

test('ordinary builtin bindings rename without touching explicit calls or literal text', () => {
  const text = 'make builtin = 1\nshow builtin\nshow builtin::length([builtin])\nshow f"builtin {builtin} {builtin::number(builtin)}"\n~ builtin::length(builtin)\nmake text = """builtin::length(builtin)"""\n';
  const model = analyze(text), edits = rename(model, model.symbols[0], 'local');
  assert.equal(edits.length, 5);
  const renamed = [...edits].sort((a, b) => b.token.start - a.token.start).reduce((value, edit) => value.slice(0, edit.token.start) + 'local' + value.slice(edit.token.end), text);
  assert.match(renamed, /show builtin::length\(\[local\]\)/);
  assert.match(renamed, /\{builtin::number\(local\)\}/);
  assert.match(renamed, /~ builtin::length\(builtin\)/);
  assert.match(renamed, /"""builtin::length\(builtin\)"""/);
  assert.equal(symbolAt(model, text.indexOf('builtin::number')), null);
});

test('a new lexical builtin name does not capture contextual intrinsic prefixes', () => {
  const text = 'make local = 2\nshow local\nshow builtin::length([local])\n';
  const model = analyze(text);
  assert.equal(rename(model, model.symbols[0], 'builtin').length, 3);
});

test('single-colon builtin task labels remain parameters beside nested intrinsic calls', () => {
  const text = 'task outer(builtin, ending = "!"):\n    give builtin + ending\nouter(builtin: builtin::number("2"), ending: "?")\n';
  const model = analyze(text), parameter = model.symbols.find(s => s.kind === 'parameter' && s.name === 'builtin');
  assert.equal(symbolAt(model, text.indexOf('builtin: builtin::')).id, parameter.id);
  assert.equal(rename(model, parameter, 'value').length, 3);
  const outer = callAt(model, text.indexOf('builtin::'));
  assert.equal(outer.name, 'outer');
  assert.equal(outer.argumentName, 'builtin');
  assert.equal(callIssues(model).length, 0);
});

test('comments, strings and dotted receivers do not create intrinsic references', () => {
  const text = 'make builtin = {}\nmake obj = {}\nobj.builtin::number("2")\n~ builtin::unknown()\n# builtin::unknown()\nmake text = "builtin::unknown()"\nmake triple = """\nbuiltin::unknown()\n"""\n';
  const model = analyze(text);
  assert.equal(intrinsicAt(model, model.tokens.find(t => t.value === 'builtin' && model.text[t.start - 1] === '.')), null);
  assert.equal(callIssues(model).some(issue => issue.code.startsWith('intrinsic-')), false);
  assert.equal(references([model], model.symbols[0]).length, 1);
});

test('incomplete intrinsic completion respects punctuation, partial names and statement boundaries', () => {
  for (const text of ['show builtin::', 'show builtin :: ', 'show builtin::num', 'show (builtin\n    :: num', 'show (builtin::\n    ']) {
    const model = analyze(text);
    assert.ok(intrinsicCompletion(model, text.length), text);
  }
  const partial = analyze('show builtin::number(1)');
  assert.ok(intrinsicCompletion(partial, partial.text.indexOf('number') + 3));
  const followed = analyze('show builtin::\nmake later = 1\n');
  assert.ok(intrinsicCompletion(followed, followed.text.indexOf('\n')), 'an incomplete prefix does not borrow the next statement');
  for (const text of ['show builtin : :', 'show other::', 'show obj.builtin::', 'show builtin\n::number', 'show builtin::number\n', 'show builtin::number(']) {
    const model = analyze(text);
    assert.equal(intrinsicCompletion(model, text.length), null, text);
  }
});

test('empty cursor positions never acquire an intrinsic or lexical target', () => {
  const model = analyze('show 1\n');
  assert.equal(intrinsicAt(model, null), null);
  assert.equal(intrinsicAt(model, undefined), null);
  assert.equal(symbolAt(model, model.text.length), null);
});

test('intrinsic call parentheses cannot be borrowed from a following statement or interpolation', () => {
  for (const text of ['show builtin::length\n([])\n', 'show f"{builtin::length}"\n([])\n']) {
    const model = analyze(text);
    assert.deepEqual(callIssues(model).map(issue => issue.code), ['intrinsic-call-required']);
    assert.equal(callAt(model, text.indexOf('([])') + 1), null);
  }
  for (const text of ['show (builtin::length\n([1]))\n', 'show f"{builtin::length([1])}"\n']) {
    const model = analyze(text);
    assert.equal(callIssues(model).length, 0);
    assert.ok(callAt(model, text.indexOf('([1])') + 1).intrinsic);
  }
});

test('known intrinsic warnings reject named inputs and first-class values without borrowing task rules', () => {
  const text = 'task number(value):\n    give value\nbuiltin::number(value: "2")\nbuiltin::missing(show_effect())\nmake fn = builtin::number\n"2" |> builtin::number()\nnumber(value: "2")\n';
  const model = analyze(text);
  assert.deepEqual(callIssues(model).map(issue => issue.code).sort(), ['intrinsic-arguments', 'intrinsic-call-required', 'intrinsic-name']);
  const native = callAt(model, text.indexOf('value: "2"') + 6);
  assert.equal(native.argumentName, 'value');
  assert.equal(native.symbol, null);
  assert.equal(symbolAt(model, text.indexOf('value: "2"')), null, 'native input labels are not lexical parameters');
});

test('nested intrinsic calls and interpolation keep positional signature context', () => {
  const text = 'task combine(builtin, value):\n    give value\ncombine(builtin::number("2"), builtin::decimal_div(builtin::decimal("1"), builtin::decimal("3"), 2))\nshow f"{builtin::length([1, 2])}"\n';
  const model = analyze(text), start = text.indexOf(', 2))') + 2;
  const call = callAt(model, start);
  assert.equal(call.name, 'decimal_div');
  assert.equal(call.activeParameter, 2);
  assert.equal(call.argumentName, null);
  const outer = callAt(model, text.indexOf('builtin::decimal_div'));
  assert.equal(outer.name, 'combine'); assert.equal(outer.activeParameter, 1);
  const interpolation = callAt(model, text.indexOf('[1, 2]') + '[1, 2]'.length);
  assert.equal(interpolation.name, 'length'); assert.ok(interpolation.intrinsic);
  assert.equal(callIssues(model).length, 0);
});

test('intrinsic completions use exactly the native known-name registries', () => {
  const root = path.join(__dirname, '..', '..'), names = new Set();
  const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
  for (const [file, registry] of [['sprout.c', 'BUILTIN_NAMES'], ['stdlib.inc', 'PR_BUILTINS']]) {
    const body = read(file).match(new RegExp(`static const char \\*const ${registry}\\[\\]\\s*=\\s*\\{([^}]+)\\}`));
    assert.ok(body, `${registry} definition found`);
    for (const match of body[1].matchAll(/"([A-Za-z_][A-Za-z_0-9]*)"/g)) names.add(match[1]);
  }
  for (const [file, predicate] of [['exact_numeric.h', 'exact_builtin_name'], ['binary_values.h', 'bytes_builtin_name'], ['runtime_foundation.h', 'foundation_builtin_name'], ['parallel_runtime.h', 'parallel_builtin_name'], ['workflow_runtime.h', 'workflow_builtin_name']]) {
    const body = read(file).match(new RegExp(`static int ${predicate}\\(const char \\*name\\)\\s*\\{([^}]+)\\}`));
    assert.ok(body, `${predicate} definition found`);
    for (const match of body[1].matchAll(/strcmp\(name,\s*"([A-Za-z_][A-Za-z_0-9]*)"\)/g)) names.add(match[1]);
  }
  assert.equal(new Set(BUILTINS).size, BUILTINS.length, 'no duplicate completion names');
  assert.deepEqual([...BUILTINS].sort(), [...names].sort(), 'editor names match native identity, not module aliases or statements');
});

test('Sprout grammar highlights direct contextual calls without reserving ordinary builtin', () => {
  const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '../syntaxes/sprout.tmLanguage.json'), 'utf8'));
  const pattern = grammar.patterns.find(p => p.captures?.['1']?.name === 'keyword.other.intrinsic.sprout');
  const regex = new RegExp(pattern.match);
  for (const text of ['builtin::number("2")', 'show builtin :: length(items)', 'value |> builtin::number()']) {
    const result = text.match(regex);
    assert.ok(result, text); assert.equal(result[1], 'builtin'); assert.equal(result[2], '::');
  }
  for (const text of ['make builtin = 1', 'outer(builtin: 2)', 'builtin : :number(2)', 'obj.builtin::number(2)', 'builtin::number']) assert.equal(regex.test(text), false, text);
  assert.ok(grammar.patterns.indexOf(pattern) > grammar.patterns.findIndex(p => p.name === 'string.quoted.triple.sprout'));
  assert.ok(grammar.patterns.indexOf(pattern) > grammar.patterns.findIndex(p => p.name === 'string.quoted.double.sprout'));
  assert.ok(new RegExp(grammar.patterns[0].match).test('# builtin::number(2)'));
});
