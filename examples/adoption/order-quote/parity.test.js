'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const path = require('node:path');
const { runSprout } = require('../../../integrations/node');
const { evaluate, semantic } = require('./baseline.cjs');
const cases = require('./cases.json').cases;
const command = process.env.SPROUT_BINARY || process.env.SPROUT_COMMAND ||
  path.resolve(__dirname, '../../../src', process.platform === 'win32' ? 'sprout.exe' : 'sprout');
const options = { command, cwd: __dirname, sandbox: false, timeoutMs: 5000, runtimeTimeoutMs: 3000,
  maxSteps: 1000000, maxInputBytes: 8192, maxOutputBytes: 16384, maxErrorBytes: 8192 };
const worker = input => runSprout(path.join(__dirname, 'worker.sprout'), input, options);

const canonicalTextSha256 = raw => createHash('sha256').update(
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n/g, '\n'), 'utf8').digest('hex');

function wireSemantic(result) {
  const tagged = (value, key) => {
    assert.equal(typeof value, 'object'); assert.notEqual(value, null);
    assert.deepEqual(Object.keys(value), [key]); assert.equal(typeof value[key], 'string');
    return value[key];
  };
  const integer = value => {
    const text = tagged(value, '$sprout.integer');
    assert.match(text, /^-?(?:0|[1-9][0-9]*)(?![\s\S])/);
    const number = BigInt(text); assert.ok(number >= -9223372036854775808n && number <= 9223372036854775807n);
    return String(number);
  };
  const money = value => {
    const text = tagged(value, '$sprout.decimal');
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?(?![\s\S])/.exec(text);
    assert.ok(match, 'Quote money must be exact nonnegative integral cents');
    return String(BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')));
  };
  assert.equal(typeof result.ok, 'boolean'); assert.equal(typeof result.truncated, 'boolean');
  if (!result.ok) { assert.equal(result.quote, null); assert.deepEqual(result.decisions, []); return result; }
  const quote = result.quote;
  return { ...result, quote: { ...quote, order_id: integer(quote.order_id), units: integer(quote.units),
    lines: quote.lines.map(line => ({ ...line, sku_id: integer(line.sku_id), quantity: integer(line.quantity),
      unit_price: money(line.unit_price), gross: money(line.gross) })),
    ...Object.fromEntries(['gross', 'discount', 'net', 'shipping', 'total'].map(key => [key, money(quote[key])])) },
    decisions: result.decisions.map(item => Object.hasOwn(item, 'rate_bps') ? { ...item, rate_bps: integer(item.rate_bps) } : item) };
}

function projection(value) {
  if (!value.ok) return { ok: false, errors: value.errors.map(({ path, code }) => ({ path, code })), truncated: value.truncated };
  const quote = value.quote;
  return { ok: true, order_id: quote.order_id, sku_ids: quote.lines.map(line => line.sku_id),
    ...Object.fromEntries(['gross', 'discount', 'net', 'shipping', 'total', 'units'].map(key => [key, quote[key]])),
    discount_rule: value.decisions[4].code, rate_bps: value.decisions[4].rate_bps, shipping_rule: value.decisions[5].code };
}

test('synthetic oracle, fixture and validation profile hashes are pinned', () => {
  for (const [filename, expected] of [
    ['baseline.py', '737e203e16405d61e95c2335c57e7c361e5316a6d1a997e8e511633e89b2a7d3'],
    ['baseline.cjs', '46283dafd11ce71ccac49454198392c34dfa8dc5d88e3fe266a2213be458bb59'],
    ['cases.json', '3f07c4fb116ad4f16b1ecdbb9476aa2401603110dcc0327afc690ca88395d3f0'],
    ['../../../lib/validate.sprout', '2f522b628355e1f422f1f544923bde11f9797672005e7898646158c8bfe45287']]) {
    const raw = fs.readFileSync(path.resolve(__dirname, filename));
    assert.equal(canonicalTextSha256(raw), expected,
      'Pinned synthetic evidence changed; review before updating it.');
    const lf = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n/g, '\n');
    assert.equal(canonicalTextSha256(Buffer.from(lf)), expected);
    assert.equal(canonicalTextSha256(Buffer.from(lf.replace(/\n/g, '\r\n'))), expected);
    assert.notEqual(canonicalTextSha256(Buffer.from(lf + '\nintentional-content-change\n')), expected);
  }
  assert.notEqual(canonicalTextSha256(Buffer.from('\r')), canonicalTextSha256(Buffer.from('\n')));
  assert.notEqual(canonicalTextSha256(Buffer.from('\ufefftext')), canonicalTextSha256(Buffer.from('text')));
  assert.throws(() => canonicalTextSha256(Buffer.from([255])), TypeError);
});

test('independent BigInt baseline agrees with every hand-calculated fixture', () => {
  for (const fixture of cases) {
    const input = structuredClone(fixture.input);
    assert.ok(Buffer.byteLength(JSON.stringify(input) + '\n') <= 8192);
    assert.deepEqual(projection(semantic(evaluate(input))), fixture.expected, fixture.name);
    assert.deepEqual(input, fixture.input, 'Baseline must not mutate input');
  }
});

test('native worker matches Node exact semantics and every fixed fixture', async () => {
  for (const fixture of cases) {
    const input = structuredClone(fixture.input), actual = wireSemantic(await worker(input));
    assert.deepEqual(actual, semantic(evaluate(input)), fixture.name);
    assert.deepEqual(projection(actual), fixture.expected, fixture.name);
    assert.deepEqual(input, fixture.input, 'Worker bridge must not mutate input');
    if (!actual.ok) {
      assert.ok(!JSON.stringify(actual).includes('private-key-secret'));
      assert.ok(!JSON.stringify(actual).includes('private-value-secret'));
    }
  }
});

test('line reordering changes only line order; deterministic rules remain stable', async () => {
  const input = structuredClone(cases.find(item => item.name === 'adjacent_SKUs_above_float_precision').input);
  const before = wireSemantic(await worker(input)); input.lines.reverse();
  const after = wireSemantic(await worker(input));
  assert.deepEqual(before.decisions, after.decisions);
  assert.deepEqual(after.quote.lines, [...before.quote.lines].reverse());
  for (const key of ['order_id', 'units', 'gross', 'discount', 'net', 'shipping', 'total']) assert.equal(before.quote[key], after.quote[key]);
});

test('baseline result is detached and host rejects oversized input before launch', async () => {
  const input = structuredClone(cases[0].input), original = structuredClone(input);
  const result = evaluate(input); result.quote.lines[0].quantity = 77n;
  assert.deepEqual(input, original);
  await assert.rejects(runSprout(path.join(__dirname, 'worker.sprout'), { padding: 'x'.repeat(8192) },
    { ...options, command: 'missing-order-quote-worker' }), error => error.code === 'input-limit');
  await assert.rejects(runSprout(path.join(__dirname, 'worker.sprout'), cases[0].input, { ...options, sandbox: true }),
    error => error.code === 'runtime');
});
