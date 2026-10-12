'use strict';
// Frozen Node SDK parent. Caller timing starts immediately before runSprout.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function oneCall(run, program, value, options, clock = () => process.hrtime.bigint()) {
  const start = clock();
  if (typeof start !== 'bigint' || start < 0n) throw new TypeError('Clock requires nonnegative bigint nanoseconds');
  const result = await run(program, value, options);
  const end = clock();
  if (typeof end !== 'bigint' || end < start) throw new TypeError('Monotonic clock is invalid');
  return { result, start_ns: String(start), end_ns: String(end), elapsed_ns: String(end - start) };
}
module.exports = { oneCall };

if (require.main === module) (async () => {
  const root = path.resolve(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/sdk.json'), 'utf8'));
  const { runSprout } = require(path.join(root, 'git/integrations/node/index.js'));
  const readline = require('node:readline');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const cancellation = new AbortController();
  process.on('SIGTERM', () => cancellation.abort());
  process.stdout.write('READY\n');
  for await (const line of input) {
    if (line === 'STOP') break;
    const request = JSON.parse(line), data = fixture[request.id];
    assert.ok(data && Number.isInteger(request.limit_ms) && request.limit_ms > 0 && request.limit_ms <= 4000);
    const program = ['Hmin', 'Hecho16K'].includes(request.id) ? path.join(root, 'sdk', request.id + '.sprout') :
      path.join(root, 'git/examples/services/contacts_preview.sprout');
    try {
      const timed = await oneCall(runSprout, program, data.input, { command: path.join(root, manifest.native), cwd: root,
        sandbox: data.sandbox, timeoutMs: request.limit_ms, runtimeTimeoutMs: Math.min(3000, request.limit_ms), maxSteps: 20000000,
        maxInputBytes: 1048576, maxOutputBytes: 262144, maxErrorBytes: 65536, signal: cancellation.signal });
      // Deep exact-tag comparison is deliberately after the inclusive SDK clock stops.
      assert.deepEqual(timed.result, data.expected);
      process.stdout.write(JSON.stringify({ ok: true, id: request.id, ...timed,
        cleanup_scope: 'SDK decoded result returned after native close; native PID/peak unavailable',
        clock_provider: 'Node process.hrtime.bigint', clock_units: 'ns', clock_resolution_ns: null }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, id: request.id, code: String(error.code || error.name).slice(0, 64),
        error: String(error.message).slice(0, 512), stderr: String(error.stderr || '').slice(0, 65536) }) + '\n');
      process.exitCode = 1; break;
    }
  }
  input.close();
})().catch(error => { process.stderr.write(String(error.message).slice(0, 512)); process.exitCode = 1; });
