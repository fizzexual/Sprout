'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture observation deadline'); await pause(1); }
}
const captured = promise => promise.then(value => ({ value }), error => ({ error }));

function adapter(spawn, clock) {
  const filename = path.resolve(__dirname, '../index.js'), loaded = new Module(filename, module);
  const requireNormally = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:child_process' ? { spawn }
    : name === 'node:perf_hooks' && clock ? { performance: { now: clock } } : requireNormally(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
function controlled(t, options = {}, clock) {
  const children = []; let peak = 0;
  const api = adapter(() => {
    const child = new EventEmitter(); children.push(child);
    child.pid = 9000 + children.length; child.exitCode = null; child.signalCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.alive = true; child.kills = []; child.killMode = 'close'; const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.request = () => JSON.parse(Buffer.concat(chunks).toString());
    child.finish = (code = 0, signal = null) => {
      if (child.closed) return;
      child.closed = true; child.alive = false; child.exitCode = code; child.signalCode = signal;
      child.emit('exit', code, signal); child.emit('close', code, signal);
    };
    child.reply = value => { child.stdout.end(JSON.stringify(value) + '\n'); child.stderr.end(); child.finish(); };
    child.kill = signal => {
      child.kills.push(signal);
      if (child.killMode === 'throw') throw new Error('fixture kill denied');
      if (child.killMode === 'never') return false;
      if (child.killMode === 'close') queueMicrotask(() => child.finish(null, signal));
      return true;
    };
    peak = Math.max(peak, children.filter(c => c.alive).length);
    return child;
  }, clock);
  const queue = api.createSproutQueue('unused.sprout', { timeoutMs: 1000, queueTimeoutMs: 1000, cleanupTimeoutMs: 30, ...options });
  t.after(async () => { for (const child of children) if (!child.closed) child.finish(); await queue.close({ drain: false }).catch(() => {}); });
  return { api, queue, children, peak: () => peak };
}

test('bounded FIFO admission keeps at most two direct workers and two waiting tickets', async t => {
  const h = controlled(t, { concurrency: 2, maxQueued: 2 });
  const requests = [0, 1, 2, 3].map(id => h.queue.run({ id }));
  let visited = false;
  const forbidden = new Proxy({}, { ownKeys() { visited = true; throw new Error('input inspected'); } });
  await assert.rejects(h.queue.run(forbidden), { code: 'queue-full' });
  assert.equal(visited, false); assert.equal(h.children.length, 2); assert.equal(h.queue.stats().queued, 2);
  h.children[0].reply(0); await until(() => h.children.length === 3);
  assert.equal(h.children[2].request().id, 2);
  h.children[1].reply(1); await until(() => h.children.length === 4);
  assert.equal(h.children[3].request().id, 3);
  h.children[2].reply(2); h.children[3].reply(3);
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3]); assert.equal(h.peak(), 2);
  await h.queue.close(); assert.equal(h.queue.stats().state, 'closed');
});

test('waiting requests snapshot input once and do not retain caller mutations', async t => {
  const h = controlled(t, { concurrency: 1 }); const first = h.queue.run({});
  const input = { text: 'café🌱', values: [1], exact: { '$sprout.integer': '9223372036854775807' } };
  const second = h.queue.run(input); input.values[0] = 99; input.text = 'changed';
  h.children[0].reply(null); await first; await until(() => h.children.length === 2);
  assert.deepEqual(h.children[1].request(), { text: 'café🌱', values: [1], exact: { '$sprout.integer': '9223372036854775807' } });
  h.children[1].reply('ok'); assert.equal(await second, 'ok');
});

test('zero waiting capacity, strict options and rejected preparation preserve admission', async t => {
  const h = controlled(t, { concurrency: 1, maxQueued: 0 });
  for (const input of [undefined, NaN, { get value() { throw new Error('getter must not run'); } }]) await assert.rejects(h.queue.run(input));
  assert.equal(h.children.length, 0); assert.equal(h.queue.stats().preparing, 0);
  for (const options of [{ concurrency: 0 }, { concurrency: 1.5 }, { concurrency: Infinity }, { maxQueued: -1 }, { maxQueued: 1025 }, { queueTimeoutMs: 0 }, { cleanupTimeoutMs: 60001 }, { signal: new AbortController().signal }, { typo: true }]) {
    assert.throws(() => h.api.createSproutQueue('unused.sprout', options), TypeError);
  }
  await assert.rejects(h.queue.run({}, { timeoutMs: 1 }), TypeError);
  const running = h.queue.run({}); await assert.rejects(h.queue.run({}), { code: 'queue-full' });
  h.children[0].reply(true); assert.equal(await running, true);
});

test('already-canceled and queued cancellation never start a worker or leak a listener', async t => {
  const h = controlled(t, { concurrency: 1 }); const early = new AbortController(); early.abort();
  await assert.rejects(h.queue.run(new Proxy({}, { ownKeys() { throw new Error('visited'); } }), { signal: early.signal }), { code: 'canceled' });
  const first = h.queue.run({}); const controller = new AbortController();
  let added = 0, removed = 0;
  const signal = { get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { added++; controller.signal.addEventListener(...args); },
    removeEventListener(...args) { removed++; controller.signal.removeEventListener(...args); } };
  const canceled = captured(h.queue.run({}, { signal })); controller.abort();
  assert.equal((await canceled).error.code, 'canceled'); assert.equal(h.queue.stats().queued, 0);
  assert.equal(added, 1); assert.equal(removed, 1); assert.equal(h.children.length, 1);
  h.children[0].reply(null); await first;
});

test('waiting timeout and overdue dispatch reject without a worker launch', async t => {
  const h = controlled(t, { concurrency: 1, queueTimeoutMs: 10 }); const first = h.queue.run({});
  await assert.rejects(h.queue.run({}), { code: 'queue-timeout' }); assert.equal(h.children.length, 1);
  h.children[0].reply(null); await first;
  let clock = 0;
  const late = controlled(t, { concurrency: 1, queueTimeoutMs: 1000 }, () => clock);
  const busy = late.queue.run({}), waiting = captured(late.queue.run({}));
  clock = 1001; late.children[0].reply(null); await busy;
  assert.equal((await waiting).error.code, 'queue-timeout'); assert.equal(late.children.length, 1);
});

test('active cancellation retains the physical slot until a delayed actual close', async t => {
  const h = controlled(t, { concurrency: 1 }); const controller = new AbortController();
  const first = captured(h.queue.run({}, { signal: controller.signal })); h.children[0].killMode = 'delay';
  const second = h.queue.run({ id: 2 }); controller.abort(); await pause(5);
  assert.equal(h.children.length, 1); assert.equal(h.queue.stats().active, 1);
  h.children[0].finish(null, 'SIGKILL');
  assert.equal((await first).error.code, 'canceled'); assert.equal((await first).error.cleanup.confirmed, true);
  await until(() => h.children.length === 2); h.children[1].reply(2); assert.equal(await second, 2);
  assert.deepEqual(h.children[0].kills, ['SIGKILL']); assert.equal(h.peak(), 1);
});

test('uncertain cleanup fails closed and late exits do not reopen the queue', async t => {
  for (const mode of ['never', 'throw']) {
    const h = controlled(t, { concurrency: 1, cleanupTimeoutMs: 10 }); const controller = new AbortController();
    const first = captured(h.queue.run({}, { signal: controller.signal })); h.children[0].killMode = mode;
    const second = captured(h.queue.run({})); controller.abort();
    const failure = (await first).error;
    assert.equal(failure.code, 'canceled'); assert.equal(failure.cleanup.confirmed, false);
    assert.ok(failure.cleanup.killError); assert.ok(Object.isFrozen(failure.cleanup));
    assert.equal((await second).error.code, 'queue-closed'); assert.equal(h.children.length, 1);
    assert.equal(h.queue.stats().state, 'failed'); assert.equal(h.queue.stats().active, 1);
    await assert.rejects(h.queue.run({}), { code: 'queue-closed' });
    await assert.rejects(h.queue.close(), { code: 'cleanup' });
    h.children[0].finish(); await until(() => h.queue.stats().active === 0);
    assert.equal(h.queue.stats().state, 'failed');
  }
});

test('known-exited owners are not signaled and output failures keep a usable queue', async t => {
  const h = controlled(t, { concurrency: 1, maxOutputBytes: 16 }); const controller = new AbortController();
  const canceled = captured(h.queue.run({}, { signal: controller.signal }));
  h.children[0].exitCode = 0; h.children[0].alive = false; h.children[0].emit('exit', 0, null);
  controller.abort(); h.children[0].finish();
  assert.equal((await canceled).error.cleanup.confirmed, true); assert.deepEqual(h.children[0].kills, []);
  const flood = captured(h.queue.run({})); h.children[1].stdout.write(Buffer.alloc(32, 120));
  assert.equal((await flood).error.code, 'stdout-limit'); assert.equal((await flood).error.cleanup.confirmed, true);
  const recovery = h.queue.run({}); h.children[2].reply('ok'); assert.equal(await recovery, 'ok');
});

test('runtime and protocol failures release only confirmed workers and recover', async t => {
  const h = controlled(t, { concurrency: 1 });
  const runtime = captured(h.queue.run({})); h.children[0].stderr.end('bounded error'); h.children[0].finish(7);
  assert.equal((await runtime).error.code, 'runtime'); assert.equal((await runtime).error.stderr, 'bounded error');
  const malformed = captured(h.queue.run({})); h.children[1].stdout.end('bad\n'); h.children[1].finish();
  assert.equal((await malformed).error.code, 'protocol');
  const valid = h.queue.run({}); h.children[2].reply(42); assert.equal(await valid, 42);
});

test('close drains, is idempotent, rejects admission and cancels at its own deadline', async t => {
  const h = controlled(t, { concurrency: 1 }); const first = h.queue.run(1), second = h.queue.run(2);
  const closing = h.queue.close(); assert.equal(closing, h.queue.close({ drain: false }));
  await assert.rejects(h.queue.run({}), { code: 'queue-closed' });
  h.children[0].reply(1); await first; await until(() => h.children.length === 2);
  h.children[1].reply(2); await second; await closing; assert.equal(h.queue.stats().state, 'closed');
  const deadline = controlled(t, { concurrency: 1 });
  const running = captured(deadline.queue.run({})), queued = captured(deadline.queue.run({}));
  await deadline.queue.close({ timeoutMs: 10 });
  assert.equal((await running).error.code, 'canceled'); assert.equal((await queued).error.code, 'queue-closed');
  assert.equal(deadline.children.length, 1); assert.equal(deadline.queue.stats().active, 0);
});

test('reentrant preparation reserves admission and close during subscription starts no worker', async t => {
  const h = controlled(t, { concurrency: 1, maxQueued: 0 }); let nested;
  const input = new Proxy({}, { getPrototypeOf(target) { nested ||= captured(h.queue.run({})); return Object.getPrototypeOf(target); } });
  const outer = h.queue.run(input); assert.equal((await nested).error.code, 'queue-full');
  h.children[0].reply(null); await outer; assert.equal(h.queue.stats().preparing, 0);
  const closing = controlled(t, { concurrency: 1 }); let close;
  const signal = { aborted: false, addEventListener() { close = closing.queue.close({ drain: false }); }, removeEventListener() {} };
  await assert.rejects(closing.queue.run({}, { signal }), { code: 'queue-closed' }); await close;
  assert.equal(closing.children.length, 0);
});

test('invalid cancellation subscriptions and preparation errors do not strand capacity', async t => {
  const h = controlled(t, { concurrency: 1, maxQueued: 0 });
  await assert.rejects(h.queue.run({}, { signal: { aborted: false, addEventListener() { throw new Error('subscription failed'); }, removeEventListener() {} } }), /subscription failed/);
  const good = h.queue.run({}); h.children[0].reply(true); assert.equal(await good, true);
  assert.equal(h.queue.stats().preparing, 0);
});

test('a throwing signal getter after subscription removes its listener before releasing admission', async t => {
  const h = controlled(t, { concurrency: 1, maxQueued: 0 }); const controller = new AbortController();
  const cause = new Error('post-subscription signal getter failed');
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  let armed = false, added = 0, removed = 0, reservationDuringRemoval;
  Object.defineProperty(controller.signal, 'aborted', { get() { if (armed) throw cause; return false; } });
  Object.defineProperty(controller.signal, 'addEventListener', { value(...args) { add(...args); added++; armed = true; } });
  Object.defineProperty(controller.signal, 'removeEventListener', { value(...args) {
    reservationDuringRemoval = h.queue.stats().preparing; remove(...args); removed++;
  } });
  await assert.rejects(h.queue.run({}, { signal: controller.signal }), error => error.code === 'canceled'
    && error.cause === cause && error.phase === 'queue-admission');
  assert.equal(h.children.length, 0); assert.equal(added, 1); assert.equal(removed, 1);
  assert.equal(reservationDuringRemoval, 1); assert.equal(h.queue.stats().preparing, 0);
  const recovery = h.queue.run(3); h.children[0].reply(3); assert.equal(await recovery, 3);
  await h.queue.close(); assert.equal(h.queue.stats().state, 'closed');
});

test('close during a real signal getter at dispatch reserves the ticket and starts no worker', async t => {
  const h = controlled(t, { concurrency: 1, maxQueued: 1 });
  const controller = new AbortController(); let armed = false, closing, observed;
  Object.defineProperty(controller.signal, 'aborted', { get() {
    if (armed) {
      armed = false;
      closing = h.queue.close({ drain: false });
      observed = h.queue.stats();
    }
    return false;
  } });
  const first = h.queue.run(1), second = captured(h.queue.run(2, { signal: controller.signal }));
  armed = true; h.children[0].reply(1); assert.equal(await first, 1);
  assert.equal(h.children.length, 1, 'canceled dispatch must not spawn after close');
  assert.equal(observed.state, 'closing'); assert.equal(observed.active, 1);
  assert.equal((await second).error.code, 'queue-closed'); await closing;
  assert.deepEqual(h.queue.stats(), { state: 'closed', active: 0, queued: 0, preparing: 0, concurrency: 1, maxQueued: 1 });
});

test('a throwing waiting signal getter rejects its ticket and permits subsequent work', async t => {
  const h = controlled(t, { concurrency: 1 }); const controller = new AbortController();
  const cause = new Error('waiting signal getter failed'); let armed = false;
  Object.defineProperty(controller.signal, 'aborted', { get() { if (armed) throw cause; return false; } });
  const first = h.queue.run(1), second = captured(h.queue.run(2, { signal: controller.signal }));
  armed = true; h.children[0].reply(1); await first;
  const failure = (await second).error;
  assert.equal(failure.code, 'canceled'); assert.equal(failure.cause, cause); assert.equal(failure.phase, 'queue-dispatch');
  assert.equal(h.children.length, 1); assert.equal(h.queue.stats().active, 0); assert.equal(h.queue.stats().queued, 0);
  const recovery = h.queue.run(3); h.children[1].reply(3); assert.equal(await recovery, 3);
  await h.queue.close(); assert.equal(h.queue.stats().state, 'closed');
});

test('draining close reentered from dispatch cannot reorder work or resolve before cleanup', async t => {
  const h = controlled(t, { concurrency: 1, maxQueued: 2 }); const controller = new AbortController();
  let armed = false, closing, closed = false;
  Object.defineProperty(controller.signal, 'aborted', { get() {
    if (armed) { armed = false; closing = h.queue.close(); closing.then(() => { closed = true; }); }
    return false;
  } });
  const first = h.queue.run(1), second = h.queue.run(2, { signal: controller.signal }), third = h.queue.run(3);
  armed = true; h.children[0].reply(1); await first;
  assert.equal(h.children.length, 2); assert.equal(h.children[1].request(), 2); assert.equal(h.peak(), 1);
  await pause(1); assert.equal(closed, false); assert.equal(h.queue.stats().state, 'closing');
  h.children[1].reply(2); assert.equal(await second, 2); await until(() => h.children.length === 3);
  assert.equal(h.children[2].request(), 3); assert.equal(closed, false);
  h.children[2].reply(3); assert.equal(await third, 3); await closing;
  assert.equal(h.peak(), 1); assert.equal(h.queue.stats().active, 0); assert.equal(h.queue.stats().state, 'closed');
});

test('close rejects distinct waiting requests and reports uncertain listener cleanup honestly', async t => {
  const h = controlled(t, { concurrency: 1 });
  const running = captured(h.queue.run({})), left = captured(h.queue.run({})), right = captured(h.queue.run({}));
  await h.queue.close({ drain: false });
  assert.equal((await running).error.code, 'canceled');
  assert.notEqual((await left).error, (await right).error);
  (await left).error.code = 'caller mutation'; assert.equal((await right).error.code, 'queue-closed');
  const broken = controlled(t, { concurrency: 1 });
  const signal = { aborted: false, addEventListener() {}, removeEventListener() { throw new Error('listener removal denied'); } };
  const request = captured(broken.queue.run({}, { signal })); broken.children[0].reply(true);
  assert.equal((await request).error.code, 'canceled');
  assert.equal((await request).error.cancellationCleanupError, 'listener removal denied');
  assert.equal(broken.queue.stats().state, 'failed');
  await assert.rejects(broken.queue.close(), error => error.code === 'cleanup' && error.cleanup.observations[0].phase === 'abort-listener');
});

test('an asynchronous spawn error starts no worker and keeps the queue usable', async () => {
  const children = [];
  const api = adapter(() => {
    const child = new EventEmitter(); children.push(child);
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { throw new Error('a never-started process must not be killed'); };
    queueMicrotask(() => { child.emit('error', new Error('missing executable')); child.emit('close', -1, null); });
    return child;
  });
  const queue = api.createSproutQueue('unused.sprout', { concurrency: 1 });
  for (let count = 0; count < 2; count++) await assert.rejects(queue.run({}), error => error.code === 'spawn' && error.cleanup.confirmed && !error.cleanup.started);
  await queue.close(); assert.equal(children.length, 2); assert.ok(children.every(child => child.stdin.destroyed));
});

test('a synchronous spawn failure confirms no worker without inventing a close event', async () => {
  const api = adapter(() => { throw new Error('fixture spawn failed before ownership'); });
  const queue = api.createSproutQueue('unused.sprout', { concurrency: 1 });
  await assert.rejects(queue.run({}), error => error.code === 'spawn' && error.cleanup.confirmed
    && !error.cleanup.started && !error.cleanup.closeObserved && error.cleanup.pid === null);
  assert.equal(queue.stats().active, 0); await queue.close();
});

test('real direct workers obey capacity, cancel with confirmed exit and recover', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sprout-queue-real-')); t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(path.join(directory, 'run'), 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=JSON.parse(s);setTimeout(()=>process.stdout.write(JSON.stringify({id:v.id,pid:process.pid})+"\\n"),v.delay||0);});');
  const children = []; let peak = 0;
  const api = adapter((...args) => { const child = cp.spawn(...args); children.push(child);
    peak = Math.max(peak, children.filter(c => c.pid && c.exitCode == null && c.signalCode == null).length); return child; });
  const queue = api.createSproutQueue(path.join(directory, 'task.sprout'), { command: process.execPath, cwd: directory,
    concurrency: 2, maxQueued: 4, timeoutMs: 3000, queueTimeoutMs: 3000, cleanupTimeoutMs: 1000 });
  t.after(() => queue.close({ drain: false }));
  const outputs = await Promise.all([0, 1, 2, 3].map(id => queue.run({ id, delay: 20 })));
  assert.deepEqual(outputs.map(value => value.id), [0, 1, 2, 3]); assert.equal(peak, 2);
  const controller = new AbortController(), canceled = captured(queue.run({ delay: 3000 }, { signal: controller.signal }));
  await until(() => children.length === 5 && children[4].pid); controller.abort();
  assert.equal((await canceled).error.code, 'canceled'); assert.equal((await canceled).error.cleanup.confirmed, true);
  assert.equal((await queue.run({ id: 'recovered' })).id, 'recovered'); await queue.close();
  assert.equal(children.length, 6); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('separately selected native candidate preserves exact JSON and Unicode queue parity', { skip: !process.env.SPROUT_COMMAND, timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sprout-queue-native-')); t.after(() => fs.rmSync(directory, { recursive: true }));
  const program = path.join(directory, 'worker.sprout');
  fs.writeFileSync(program, 'make input = builtin::json_decode(builtin::read_input())\nshow builtin::json_encode({id: builtin::integer(input.id), text: input.text, count: builtin::length(input.text)})\n');
  const { runSprout, createSproutQueue } = require('..');
  const input = { id: '9223372036854775807', text: 'café🌱' }, options = { command: process.env.SPROUT_COMMAND, timeoutMs: 3000 };
  const expected = await runSprout(program, input, options), queue = createSproutQueue(program, { ...options, concurrency: 2 });
  t.after(() => queue.close({ drain: false }));
  assert.deepEqual(await Promise.all([queue.run(input), queue.run(input)]), [expected, expected]); await queue.close();
  assert.deepEqual(expected, { id: { '$sprout.integer': '9223372036854775807' }, text: 'café🌱', count: 5 });
});
