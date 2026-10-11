'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

// Load the public adapter unchanged, replacing only its process transport. This
// gives bounded, deterministic codec coverage without launching a process for
// every generated case. The existing host tests cover the real child transport.
function transport() {
  let reply = request => request, width = 7, launches = 0;
  const filename = path.resolve(__dirname, '../index.js');
  const adapter = new Module(filename, module);
  const ordinaryRequire = adapter.require.bind(adapter);
  adapter.require = name => name === 'node:child_process' ? { spawn } : ordinaryRequire(name);
  function spawn() {
    launches++;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let killed = false;
    child.kill = () => { killed = true; return true; };
    const input = [];
    child.stdin.on('data', bytes => input.push(bytes));
    child.stdin.once('finish', () => queueMicrotask(() => {
      if (killed) return;
      const bytes = Buffer.from(reply(Buffer.concat(input).toString('utf8')));
      for (let at = 0; at < bytes.length && !killed; at += width) child.stdout.write(bytes.subarray(at, at + width));
      child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    }));
    return child;
  }
  adapter._compile(fs.readFileSync(filename, 'utf8'), filename);
  return {
    call: (input, options = {}) => adapter.exports.runSprout('unused.sprout', input, { timeoutMs: 3000, ...options }),
    wire: (text, chunkWidth = 7) => { reply = () => text; width = chunkWidth; },
    launches: () => launches,
  };
}

function unicodeEscape(text) {
  let encoded = '"';
  for (let i = 0; i < text.length; i++) encoded += '\\u' + text.charCodeAt(i).toString(16).padStart(4, '0');
  return encoded + '"';
}

function wrap(wire, count) {
  for (let i = 0; i < count; i++) wire = i % 2 ? '{"value":' + wire + '}' : '[' + wire + ']';
  return wire;
}

test('fixed-seed generated JSON round-trips strings, Unicode, and inert map keys', async () => {
  const host = transport();
  const strings = ['', 'ordinary', '[{]}', '\\"\\\\', '\b\f\n\r\t\u0001', 'é', '🌱', '\uffff', '__proto__', 'constructor'];
  let state = 0x51a7c0de;
  const choose = bound => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % bound; };
  function value(depth) {
    const kind = choose(depth ? 7 : 4);
    if (kind === 0) return null;
    if (kind === 1) return !!choose(2);
    if (kind === 2) return (choose(100000) - 50000) / 8;
    if (kind === 3) return strings[choose(strings.length)];
    if (kind === 4) return Array.from({ length: choose(5) }, () => value(depth - 1));
    const map = Object.create(null);
    for (let i = 0, count = choose(5); i < count; i++) map[strings[choose(strings.length)]] = value(depth - 1);
    return map;
  }
  for (let i = 0; i < 96; i++) {
    const input = value(5);
    assert.deepEqual(await host.call(input), JSON.parse(JSON.stringify(input)), 'seeded case ' + i);
  }
  assert.equal({}.polluted, undefined);
});

test('generated duplicate keys reject after escape decoding at different depths', async () => {
  const host = transport();
  for (const key of ['allow', '', 'a"b', 'a\\b', 'é', '🌱', '__proto__', 'constructor']) {
    const duplicate = '{' + JSON.stringify(key) + ':false,' + unicodeEscape(key) + ':true}';
    for (const depth of [0, 7, 127]) {
      host.wire(wrap(duplicate, depth) + '\n');
      await assert.rejects(host.call(null), { code: 'protocol' }, JSON.stringify({ key, depth }));
    }
  }
  host.wire('{"healthy":true}\n');
  assert.deepEqual(await host.call(null), { healthy: true });
});

test('mixed and empty containers count exactly at the 128-container boundary', async () => {
  const host = transport();
  for (const leaf of ['0', '[]', '{}', '{"$sprout.integer":"9223372036854775807"}']) {
    const leafContainers = leaf === '0' ? 0 : 1;
    const accepted = wrap(leaf, 128 - leafContainers);
    host.wire(accepted + '\n');
    assert.deepEqual(await host.call(null), JSON.parse(accepted));
    host.wire(wrap(leaf, 129 - leafContainers) + '\n');
    await assert.rejects(host.call(null), { code: 'protocol' });
  }
  let input = [];
  for (let i = 1; i < 128; i++) input = i % 2 ? { value: input } : [input];
  host.wire('null\n');
  assert.equal(await host.call(input), null);
  const launches = host.launches();
  await assert.rejects(host.call([input]), /nesting/);
  assert.equal(host.launches(), launches, 'overdeep input must reject before launch');
});

test('malformed lexical variants reject and escaped JSON punctuation stays text', async () => {
  const host = transport();
  const malformed = ['01', '+1', 'NaN', 'Infinity', '-Infinity', '1e309', '-1e309',
    '[1,]', '{"a":1,}', '{a:1}', 'true false', 'nullx', '"\\x00"', '"\\u12xz"',
    '"unterminated\\"', '"raw\u0001control"', '"\\ud800"', '"\\udfff"',
    '"\\ud800\\ud800"', '"\\udfff\\ud800"', '"\\u0000"', '{"\\u0000":1}'];
  for (const wire of malformed) {
    host.wire(wire + '\n');
    await assert.rejects(host.call(null), { code: 'protocol' }, wire);
  }
  for (const wire of ['-0', '1e308', '1e-400', '"\\ud83c\\udf31"',
    '"brackets:[{]}, quote:\\", slash:\\\\"', '{"\\u0061":1,"b":2}']) {
    host.wire(wire + '\n');
    assert.deepEqual(await host.call(null), JSON.parse(wire));
  }
});

test('UTF-8 chunking and input/output byte caps include the line terminator', async () => {
  const host = transport(), input = { text: '🌱é' };
  const wire = JSON.stringify(input) + '\n', bytes = Buffer.byteLength(wire);
  for (const width of [1, 2, 3, 7]) {
    host.wire(wire, width);
    assert.deepEqual(await host.call(input, { maxInputBytes: bytes, maxOutputBytes: bytes }), input);
    await assert.rejects(host.call(input, { maxOutputBytes: bytes - 1 }), { code: 'stdout-limit' });
  }
  const launches = host.launches();
  await assert.rejects(host.call(input, { maxInputBytes: bytes - 1 }), { code: 'input-limit' });
  assert.equal(host.launches(), launches);
  for (const bad of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xf0, 0x9f])]) {
    host.wire(Buffer.concat([Buffer.from('"'), bad, Buffer.from('"\n')]), 1);
    await assert.rejects(host.call(null), { code: 'protocol' });
  }
});

test('exact-value tags stay opaque maps according to the Node SDK contract', async () => {
  const host = transport();
  for (const input of [{ '$sprout.integer': '9223372036854775807' },
    { '$sprout.decimal': '-9.223372036854775808' }, { '$sprout.bytes': '00ff41' },
    { '$sprout.integer': 'application-owned-format' }, { '$sprout.bytes': 7 }]) {
    assert.deepEqual(await host.call(input), input);
  }
});

test('invalid JSON returned by serialization hooks rejects before launch', async () => {
  const host = transport();
  for (const output of ['\ud800', '\0', undefined]) {
    const input = {};
    Object.defineProperty(input, 'toJSON', { value: () => output });
    await assert.rejects(host.call(input), TypeError);
  }
  const input = {};
  Object.defineProperty(input, 'toJSON', { value: () => JSON.parse(wrap('0', 129)) });
  await assert.rejects(host.call(input), TypeError);
  assert.equal(host.launches(), 0);
});

test('input caps and already-canceled requests stop before alias expansion', async () => {
  const host = transport(); let graph = 'payload';
  for (let depth = 0; depth < 40; depth++) graph = [graph, graph];
  const original = JSON.stringify; let serializations = 0;
  JSON.stringify = value => { if (value === graph) serializations++; return original(value); };
  try {
    await assert.rejects(host.call(graph, { maxInputBytes: 128 }), { code: 'input-limit' });
    assert.equal(serializations, 0, 'oversized aliases reached full JSON serialization');
  } finally { JSON.stringify = original; }
  let reads = 0;
  const input = { get value() { reads++; throw new Error('input was visited'); } };
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(host.call(input, { signal: canceled.signal }), { code: 'canceled' });
  await assert.rejects(host.call(input, { maxInputBytes: 0 }), TypeError);
  await assert.rejects(host.call(input), /data properties/);
  assert.equal(reads, 0);
  assert.equal(host.launches(), 0);
});

test('larger configured input limits retain native reader ceiling and newline accounting', async () => {
  const host = transport(); host.wire('{"ok":true}\n');
  const cap = 1024 * 1024;
  assert.deepEqual(await host.call('x'.repeat(cap - 3), { maxInputBytes: cap * 2 }), { ok: true });
  await assert.rejects(host.call('x'.repeat(cap - 2), { maxInputBytes: cap * 2 }), { code: 'input-limit' });
  assert.equal(host.launches(), 1);
});
