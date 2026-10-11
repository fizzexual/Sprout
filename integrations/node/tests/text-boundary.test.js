'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runSprout } = require('..');

test('text representation rejects NUL and lone surrogates before launch', async () => {
  for (const input of ['\ud800', '\udfff', '\0', { '\ud800': 1 }, ['\0']]) {
    await assert.rejects(runSprout('unused.sprout', input, { command: 'unused-missing-command' }), TypeError);
  }
});

test('worker strings match native text and recover after invalid output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sprout-text-'));
  // The fake interpreter echoes a controlled wire line supplied as an argument.
  fs.writeFileSync(path.join(directory, 'run'), String.raw`
const path = require('node:path');
const text = { lone: '"\\ud800"', nul: '"\\u0000"', key: '{"\\udfff":1}',
  pair: '"\\ud83c\\udf31"', large: '1e20' }[path.basename(process.argv[2], '.sprout')];
process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(text + '\n'));
`);
  const call = mode => runSprout(path.join(directory, mode + '.sprout'), {}, { command: process.execPath, cwd: directory });
  try {
    for (const mode of ['lone', 'nul', 'key']) await assert.rejects(call(mode), { code: 'protocol' });
    assert.equal(await call('pair'), '\ud83c\udf31');
    assert.equal(await call('large'), 1e20);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
