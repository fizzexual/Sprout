const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { runSprout } = require('..');
const cwd = path.join(__dirname, 'fixtures');
const run = (mode, input = {}, options = {}) => runSprout(path.join(cwd, mode + '.sprout'), input, { command: process.execPath, cwd, ...options });

test('JSON bridge passes bounded runtime options and defaults to sandbox', async () => {
  const result = await run('echo', { name: 'Ada', values: [1, true, null] });
  assert.deepEqual(result.input, { name: 'Ada', values: [1, true, null] });
  assert.deepEqual(result.args, ['--max-steps', '100000', '--timeout-ms', '4000', '--sandbox']);
  const trusted = await run('echo', {}, { sandbox: false });
  assert.equal(trusted.args.includes('--sandbox'), false);
});

test('stdout and stderr floods fail while streams are arriving', async () => {
  await assert.rejects(run('stdout', {}, { maxOutputBytes: 32 }), { code: 'stdout-limit' });
  await assert.rejects(run('stderr', {}, { maxErrorBytes: 32 }), { code: 'stderr-limit' });
});

test('strict protocol rejects malformed JSON, extra lines, blanks, and invalid UTF-8', async () => {
  for (const mode of ['malformed', 'multiple', 'blank', 'invalid-utf8']) await assert.rejects(run(mode), { code: 'protocol' });
});

test('host timeout terminates a stuck interpreter and reports timeout', async () => {
  const start = Date.now();
  await assert.rejects(run('wait', {}, { timeoutMs: 200 }), { code: 'timeout' });
  assert.ok(Date.now() - start < 2500);
});

test('AbortSignal cancels promptly before or during execution', async () => {
  const early = new AbortController(); early.abort();
  await assert.rejects(run('wait', {}, { signal: early.signal }), { code: 'canceled' });
  const controller = new AbortController(), pending = run('wait', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'canceled' });
});

test('runtime failures preserve bounded stderr and exit status', async () => {
  await assert.rejects(run('exit'), error => error.code === 'runtime' && error.exitCode === 7 && error.stderr === 'rule failed');
});

test('invalid or oversized inputs and options are rejected before spawning', async () => {
  await assert.rejects(run('echo', { large: 'x'.repeat(100) }, { maxInputBytes: 16 }), { code: 'input-limit' });
  await assert.rejects(run('echo', { amount: NaN }), /finite/);
  await assert.rejects(run('echo', { missing: undefined }), /JSON values/);
  const circular = {}; circular.circular = circular;
  await assert.rejects(run('echo', circular), /cycles/);
  await assert.rejects(run('echo', {}, { timeoutMs: 0 }), /positive integer/);
  await assert.rejects(run('echo', {}, { sandbox: 'false' }), /true or false/);
  await assert.rejects(run('echo', {}, { cwd: 42 }), /directory path/);
  await assert.rejects(run('echo', {}, { signal: {} }), /AbortSignal/);
  let nested = {}; for (let i = 0; i < 130; i++) nested = { nested };
  await assert.rejects(run('echo', nested), /nesting/);
});

test('missing executable produces a spawn error', async () => {
  await assert.rejects(runSprout(path.join(cwd, 'echo.sprout'), {}, { command: path.join(cwd, 'missing-command') }), { code: 'spawn' });
});

test('current native interpreter performs exact decimal rules through JSON', { skip: !process.env.SPROUT_COMMAND }, async () => {
  const result = await runSprout(path.join(__dirname, '../example.sprout'), { subtotal: '120.00', member: true }, { command: process.env.SPROUT_COMMAND });
  assert.deepEqual(result, { total: '108', discount: '12' });
});
