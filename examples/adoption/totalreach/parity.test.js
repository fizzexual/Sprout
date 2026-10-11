'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { runSprout } = require('../../../integrations/node');
const { normalizeDealValue } = require('./bridge');
const fixtures = require('./fixtures.json');
const binary = process.env.SPROUT_BINARY || process.env.SPROUT_COMMAND;
const program = path.join(__dirname, 'deal-value.sprout');
const source = fs.readFileSync(path.join(__dirname, 'upstream', 'validation.ts'), 'utf8');
const sha256 = '3f5afc2d1a8ccd277260b1b2b01450917272c325fda21c992d30b944fb2f2554';

function originalRule() {
  assert.equal(createHash('sha256').update(source).digest('hex'), sha256,
    'Pinned original source changed; review provenance before updating it.');
  const match = source.match(/^export function toNumber\(value: FormDataEntryValue \| null\): number \{([\s\S]*?)^\}/m);
  assert.ok(match, 'The original toNumber declaration must be present.');
  // Only remove the export and static parameter/return types. The pinned body
  // executes unchanged; importing Zod or the Next/Prisma application is unnecessary.
  return vm.runInNewContext(`(function toNumber(value) {${match[1]}})`, {}, { timeout: 1000 });
}
function wireValue(value) { return JSON.parse(JSON.stringify(value)); }
const original = originalRule();

test('handwritten migration fixtures agree with the pinned original rule', () => {
  for (const fixture of fixtures) {
    assert.deepEqual(wireValue(original(fixture.input)), fixture.expected, fixture.name);
  }
});

test('native sandboxed worker matches every independent fixture', { skip: !binary }, async () => {
  const result = await runSprout(program, { values: fixtures.map(f => f.input) },
    { command: binary, maxSteps: 1000000 });
  assert.deepEqual(result, { values: fixtures.map(f => f.expected) });
});

test('native rule matches the original for generated punctuation and numeric boundaries', { skip: !binary }, async () => {
  const values = ['9'.repeat(310), '0.' + '0'.repeat(323) + '5', '0.' + '0'.repeat(323) + '1',
    '1' + '0'.repeat(308), '-1' + '0'.repeat(308)];
  let state = 20261010;
  const alphabet = '0123456789.-+$,e abc\t\n';
  for (let i = 0; i < 120; i++) {
    let text = '';
    for (let j = 0; j < 24; j++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      text += alphabet[state % alphabet.length];
    }
    values.push(text);
  }
  const expected = values.map(value => wireValue(original(value)));
  const result = await runSprout(program, { values }, { command: binary, maxSteps: 1000000 });
  assert.deepEqual(result.values, expected);
});

test('host bridge preserves the original FormData non-text handling', { skip: !binary }, async () => {
  assert.equal(await normalizeDealValue('$48,000', { command: binary }), 48000);
  assert.equal(await normalizeDealValue({ name: 'attachment.csv' }, { command: binary }), 0);
});

test('worker rejects malformed batches and its documented text limit', { skip: !binary }, async () => {
  for (const [request, expected] of [[null, 'Expected a JSON object'], [{}, 'Expected a values list'],
    [{ values: '12' }, 'values must be a list'], [{ values: Array(257).fill('1') }, 'values must be a list'],
    [{ values: ['1'.repeat(4097)] }, '4096 Unicode characters'],
    [{ values: ['€'.repeat(4097)] }, '4096 Unicode characters']]) {
    await assert.rejects(runSprout(program, request, { command: binary }),
      error => error.code === 'runtime' && error.stderr.includes(expected));
  }
  const withinLimit = await runSprout(program, { values: ['€'.repeat(4096)] }, { command: binary });
  assert.deepEqual(withinLimit.values, [0]);
});
