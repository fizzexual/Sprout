const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const extension = path.resolve(__dirname, '..');
const repo = path.resolve(extension, '..');
const snippets = JSON.parse(fs.readFileSync(path.join(extension, 'snippets/sprout.json'), 'utf8'));
const names = [
  'Validate explicit input', 'Resolve explicit configuration layers',
  'Parse an explicit UTC timestamp', 'Format an exact UTC instant',
];
const legacyNames = ["Window app", "Server app", "Task", "When / otherwise", "Repeat while", "Repeat N times", "Make variable", "Task with a default input", "Multiline text", "Explicit native call", "Plan a workflow"];
const legacyDigest = '7c67f7ba955b26efea3404f5b41f62bd0ee1f44d5a271ab7cc75e18adc23ae85';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

// This family intentionally uses only numbered tabstops/defaults/mirrors. It
// does not need snippet variables, transformations or nested placeholders.
function placeholders(body) {
  const text = body.join('\n');
  const tokens = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '$') continue;
    const match = /^\$(?:([0-9]+)|\{([0-9]+)(?::([^{}\\]*))?\})/.exec(text.slice(at));
    assert.ok(match, `Invalid or unsupported placeholder at ${at}`);
    tokens.push({ index: Number(match[1] ?? match[2]), value: match[3], text: match[0], at });
    at += match[0].length - 1;
  }
  return tokens;
}

function defaults(body) {
  const text = body.join('\n');
  const values = new Map();
  for (const token of placeholders(body)) {
    if (token.value !== undefined) values.set(token.index, token.value);
  }
  return text.replace(/\$(?:([0-9]+)|\{([0-9]+)(?::([^{}\\]*))?\})/g,
    (_text, short, long) => Number(short ?? long) === 0 ? '' : values.get(Number(short ?? long)));
}

test('library snippet tabstops are contiguous, valid and mirrored after their defaults', () => {
  for (const name of names) {
    const body = snippets[name].body;
    assert.ok(Array.isArray(body) && body.every(line => typeof line === 'string'));
    const tokens = placeholders(body);
    const seen = new Set();
    let highest = 0;
    for (const token of tokens) {
      if (token.index === 0) continue;
      assert.ok(Number.isSafeInteger(token.index) && token.index > 0);
      if (!seen.has(token.index)) {
        assert.notEqual(token.value, undefined, `${name} first tabstop has no default`);
        assert.notEqual(token.value, '', `${name} has an empty default`);
        assert.equal(token.index, highest + 1, `${name} skips a tabstop`);
        highest = token.index;
        seen.add(token.index);
      } else {
        assert.equal(token.value, undefined, `${name} mirror changes its default`);
      }
    }
    assert.equal(tokens.filter(token => token.index === 0).length, 1);
    assert.equal(body.at(-1), '${0}');
    assert.ok(!defaults(body).includes('$'));
  }
  for (const malformed of ['${1:unterminated', '${name}', '${1:{nested}}', '$']) {
    assert.throws(() => placeholders([malformed]), /Invalid or unsupported placeholder/);
  }
});

test('new prefixes are unique across the family and every existing snippet is preserved', () => {
  const prefixes = [];
  for (const [name, item] of Object.entries(snippets)) {
    assert.ok(item && typeof item === 'object', name);
    for (const prefix of Array.isArray(item.prefix) ? item.prefix : [item.prefix]) {
      assert.equal(typeof prefix, 'string');
      assert.ok(prefix.trim() === prefix && prefix.length > 0);
      prefixes.push(prefix.toLowerCase());
    }
  }
  assert.equal(new Set(prefixes).size, prefixes.length, 'A prefix shadows another snippet');
  assert.deepEqual(names.map(name => snippets[name].prefix), ['validatecheck', 'configresolve', 'utcparse', 'utcformat']);
  assert.deepEqual(Object.keys(snippets).filter(name => !legacyNames.includes(name)), names);
  const preserved = Object.fromEntries(legacyNames.map(name => {
    assert.ok(Object.hasOwn(snippets, name), `Old snippet missing: ${name}`);
    return [name, snippets[name]];
  }));
  const digest = crypto.createHash('sha256').update(JSON.stringify(stable(preserved))).digest('hex');
  assert.equal(digest, legacyDigest, 'An existing snippet was changed');
});

test('library snippets use actual captured exports, explicit arguments and fixed private-safe failures', () => {
  const modules = Object.fromEntries(['validate', 'config', 'utc'].map(name =>
    [name, fs.readFileSync(path.join(repo, 'lib', `${name}.sprout`), 'utf8')]));
  const requirements = [
    { name: names[0], module: 'validate', task: 'check', parameters: ['value', 'schema'],
      call: 'make checked = validate.check(input, schema)', failure: 'Input validation failed.' },
    { name: names[1], module: 'config', task: 'resolve', parameters: ['defaults', 'schema', 'files', 'cli'],
      call: 'make resolved = config.resolve(defaults, schema, layers, overrides)', failure: 'Configuration validation failed.' },
    { name: names[2], module: 'utc', task: 'parse', parameters: ['text'],
      call: 'make parsed = utc.parse(timestamp)', failure: 'Timestamp input is invalid.' },
    { name: names[3], module: 'utc', task: 'format', parameters: ['instant'],
      call: 'make formatted = utc.format(instant)', failure: 'Timestamp instant is invalid.' },
  ];
  for (const required of requirements) {
    const source = modules[required.module];
    const header = [...source.matchAll(/^public task ([A-Za-z_]\w*)\(([^)]*)\):/gm)]
      .find(match => match[1] === required.task);
    assert.ok(header, `${required.module}.${required.task} is not public`);
    assert.deepEqual(header[2].split(',').map(value => value.trim().split(/\s*=\s*/)[0]), required.parameters);
    assert.ok(source.includes(`public make ${required.task} = ${required.task}`), 'Export lost its captured task binding');
    const expanded = defaults(snippets[required.name].body);
    assert.equal(expanded.split('\n')[0], `use "lib/${required.module}.sprout"`);
    assert.ok(expanded.includes(required.call));
    const result = /^make ([A-Za-z_]\w*) = /m.exec(required.call)[1];
    assert.ok(expanded.includes(`when not ${result}.ok:\n\tfail "${required.failure}"`));
    assert.equal(expanded.match(/\bfail\b/g).length, 1);
    assert.ok(!/\bshow\b|\.(?:errors|schema_error|error|provenance)\b/.test(expanded), 'Template logs caller diagnostics or payload');
    const calls = [...expanded.matchAll(/\b([A-Za-z_]\w*)(\.|::)([A-Za-z_]\w*)\(/g)].map(match => `${match[1]}${match[2]}${match[3]}`);
    assert.deepEqual(calls, required.task === 'format' ? ['builtin::integer', 'builtin::integer', 'utc.format'] : [`${required.module}.${required.task}`]);
    assert.ok(!/\b(?:read_input|read_file|file_read|clock|shell|request|env|process|http)\s*(?:\.|::|\()/.test(expanded));
  }
  const formatted = defaults(snippets[names[3]].body);
  assert.ok(formatted.includes('{seconds: builtin::integer("0"), nanoseconds: builtin::integer("0")}'));
  const resolved = defaults(snippets[names[1]].body);
  assert.ok(resolved.indexOf('when not resolved.ok:') < resolved.indexOf('make settings = resolved.values'));
  for (const [name, result, member] of [[names[2], 'parsed', 'instant'], [names[3], 'formatted', 'text']]) {
    const expanded = defaults(snippets[name].body);
    assert.ok(expanded.indexOf(`when not ${result}.ok:`) < expanded.lastIndexOf(`${result}.${member}`));
  }
});
