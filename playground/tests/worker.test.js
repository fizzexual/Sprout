const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

async function harness(run, trace = false) {
  const messages = [], files = []; let options;
  const self = { postMessage: message => messages.push(message) };
  const sandbox = { self, importScripts(name) { assert.equal(name, 'sprout.js'); },
    createSprout: async config => { options = config; return { FS: { writeFile: (...args) => files.push(args) },
      callMain: args => run(options, args) }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'worker.js'), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].type, 'ready');
  self.onmessage({ data: { type: 'run', code: 'show 42', trace } });
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

const traceLine = (sequence, variables = { answer: '42' }) => '@sprout-trace ' + JSON.stringify({type:'step',sequence,file:'/program.sprout',line:sequence+1,depth:0,variables,stack:[]});

test('recording separates stderr trace from normal program output', async () => {
  const h = await harness((options, args) => {
    assert.deepEqual(Array.from(args), ['/program.sprout', '--sandbox', '--trace-json', '--max-steps', '100000', '--timeout-ms', '4000']);
    options.printErr(traceLine(0)); options.print('42'); options.print(traceLine(1)); return 0;
  }, true);
  const batch = h.messages.find(m => m.type === 'trace'), done = h.messages.find(m => m.type === 'done');
  assert.equal(batch.events.length, 1); assert.equal(batch.events[0].variables.answer, '42');
  assert.match(done.output, /42\n@sprout-trace/); assert.equal(done.traceCount, 1);
});

test('trace floods stop recording at 2000 events without stopping the program', async () => {
  const h = await harness(options => { for (let i = 0; i < 10000; i++) options.printErr(traceLine(i)); options.print('completed'); return 0; }, true);
  const done = h.messages.find(m => m.type === 'done');
  assert.equal(done.traceCount, 2000); assert.equal(done.traceTruncated, true);
  assert.equal(done.output, 'completed\n'); assert.equal(done.exitCode, 0);
  assert.equal(h.messages.filter(m => m.type === 'trace').flatMap(m => m.events).length, 2000);
});

test('trace bytes are bounded separately from console output', async () => {
  const h = await harness(options => { for (let i = 0; i < 100; i++) options.printErr(traceLine(i, { large: 'x'.repeat(10000) })); options.print('done'); return 0; }, true);
  const done = h.messages.find(m => m.type === 'done');
  assert.equal(done.traceTruncated, true); assert.ok(done.traceCount < 100); assert.equal(done.output, 'done\n');
  assert.ok(h.messages.find(m => m.type === 'trace').events[0].variables.large.length <= 4096);
});

test('malformed trace lines remain visible and traces are opt-in', async () => {
  const h = await harness(options => { options.printErr('@sprout-trace {bad'); options.printErr('@sprout-trace {}'); return 0; }, true);
  assert.match(h.messages.find(m => m.type === 'done').output, /\{bad/);
  const ordinary = await harness(options => { options.printErr(traceLine(0)); return 0; });
  assert.equal(ordinary.messages.some(m => m.type === 'trace'), false);
});

test('trace batches become available before completion for bounded partial recordings', async () => {
  const h = await harness(options => { for (let i = 0; i < 33; i++) options.printErr(traceLine(i)); throw { name: 'ExitStatus', status: 1 }; }, true);
  assert.equal(h.messages[1].type, 'trace'); assert.equal(h.messages[1].events.length, 32);
  assert.equal(h.messages[2].events.length, 1); assert.equal(h.messages[3].type, 'done');
});
