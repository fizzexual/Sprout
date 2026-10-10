const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

async function harness(run) {
  const messages = [], files = []; let options;
  const self = { postMessage: message => messages.push(message) };
  const sandbox = { self, importScripts(name) { assert.equal(name, 'sprout.js'); },
    createSprout: async config => { options = config; return { FS: { writeFile: (...args) => files.push(args) },
      callMain: args => run(options, args) }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'worker.js'), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].type, 'ready');
  self.onmessage({ data: { type: 'run', code: 'show 42' } });
  return { messages, files, options };
}

test('worker runs source in sandbox and reports its output', async () => {
  const h = await harness((options, args) => {
    assert.deepEqual(Array.from(args), ['/program.sprout', '--sandbox']); options.print('42'); return 0;
  });
  assert.deepEqual(h.files[0], ['/program.sprout', 'show 42']);
  assert.equal(h.messages[1].output, '42\n'); assert.equal(h.messages[1].exitCode, 0);
  assert.equal(h.options.stdin(), null);
});

test('worker preserves nonzero interpreter exit status', async () => {
  const h = await harness(options => { options.printErr('Sprout error'); throw { name: 'ExitStatus', status: 1 }; });
  assert.equal(h.messages[1].exitCode, 1); assert.match(h.messages[1].output, /Sprout error/);
});

test('output floods stop at the cap and emit one completion', async () => {
  const h = await harness(options => { for (let i = 0; i < 100000; i++) options.print('a'.repeat(100)); });
  assert.equal(h.messages.length, 2); assert.equal(h.messages[1].output.length, 65536);
  assert.equal(h.messages[1].stopped, 'output limit');
});

test('unexpected runtime errors are visible', async () => {
  const h = await harness(() => { throw new Error('crash'); });
  assert.equal(h.messages[1].exitCode, 1); assert.match(h.messages[1].output, /runtime error.*crash/);
});
