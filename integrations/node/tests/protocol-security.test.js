'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runSprout } = require('..');

// A separate executable fixture tests the SDK's boundary independently of the
// interpreter's json_encode implementation. It only writes in its private cwd.
const fixture = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const mode = path.basename(process.argv[2], '.sprout');
if (mode === 'ignore-termination') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync('started', 'yes');
  setTimeout(() => { fs.writeFileSync('late-effect', 'yes'); process.exit(0); }, 600);
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    const output = {
      duplicate: '{"allow":false,"allow":true}',
      'escaped-duplicate': '{"allow":false,"\\u0061llow":true}',
      'nested-duplicate': '{"outer":{"role":"reader","role":"admin"}}',
      nonfinite: '{"amount":1e999}',
      'negative-nonfinite': '-1e999',
      deep: '['.repeat(129) + '0' + ']'.repeat(129),
      boundary: '['.repeat(128) + '0' + ']'.repeat(128),
      quoted: JSON.stringify({ text: '[{'.repeat(300), escaped: '\\"' }),
      healthy: '{"ok":true}',
      'prototype-key': '{"__proto__":{"allow":true},"constructor":"literal"}',
    }[mode];
    process.stdout.write(output + '\n');
  });
}
`;

async function withWorker(check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sprout-node-boundary-'));
  fs.writeFileSync(path.join(directory, 'run'), fixture);
  const run = (mode, options = {}) => runSprout(path.join(directory, mode + '.sprout'), {}, {
    command: process.execPath, cwd: directory, timeoutMs: 3000, ...options,
  });
  try { await check(run, directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('duplicate worker keys reject instead of changing an authorization decision', async () => {
  await withWorker(async run => {
    for (const mode of ['duplicate', 'escaped-duplicate', 'nested-duplicate']) {
      await assert.rejects(run(mode), { code: 'protocol' }, mode);
    }
    assert.deepEqual(await run('healthy'), { ok: true });
  });
});

test('finite-number and nesting limits apply to worker output', async () => {
  await withWorker(async run => {
    for (const mode of ['nonfinite', 'negative-nonfinite', 'deep']) {
      await assert.rejects(run(mode), { code: 'protocol' }, mode);
    }
    let value = await run('boundary');
    for (let depth = 0; depth < 128; depth++) { assert.equal(value.length, 1); value = value[0]; }
    assert.equal(value, 0);
    assert.equal((await run('quoted')).text.length, 600);
    assert.deepEqual(await run('healthy'), { ok: true });
  });
});

test('ordinary prototype-like JSON keys remain inert own data', async () => {
  await withWorker(async run => {
    const value = await run('prototype-key');
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(Object.hasOwn(value, '__proto__'), true);
    assert.equal(value.__proto__.allow, true);
    assert.equal({}.allow, undefined);
    assert.equal(value.constructor, 'literal');
  });
});

test('timeout forcibly terminates a worker that ignores graceful termination', async () => {
  await withWorker(async (run, directory) => {
    const pending = run('ignore-termination', { timeoutMs: 300 });
    // Observe startup so this exercises an existing child rather than a spawn race.
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(path.join(directory, 'started')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(path.join(directory, 'started')), true);
    await assert.rejects(pending, { code: 'timeout' });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(fs.existsSync(path.join(directory, 'late-effect')), false);
    assert.deepEqual(await run('healthy'), { ok: true });
  });
});
