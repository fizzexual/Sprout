const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('WASM smoke isolates persistence and retains sandboxed native capability probes', async () => {
  const calls = [], filesystems = [];
  const factory = async options => {
    const files = new Map(); filesystems.push(files);
    return {
      FS: { writeFile(name, value) { files.set(name, value); } },
      callMain(args) {
        const source = files.get('/program.sprout');
        calls.push({ source, args, files });
        if (/^show (?:read|file_read|file_write|request|process|sql_open|remember)\(/.test(source)) {
          options.printErr('native access disabled in sandbox mode'); return 1;
        }
        if (source.startsWith('repeat while yes:')) { options.printErr('stopped by --max-steps'); return 1; }
        if (args.includes('--trace-json')) options.printErr('@sprout-trace {"variables":{"x":"1"}}');
        else if (source.startsWith('show """')) options.print('first\nsecond');
        else options.print('42');
        return 0;
      },
    };
  };
  const mockPath = path.resolve(__dirname, 'mock-sprout.js');
  const sandbox = {
    require(name) { return name === mockPath ? factory : require(name); },
    process: { argv: ['node', 'wasm-smoke.js', mockPath], exitCode: 0 },
    __dirname, console: { log() {}, error(error) { throw error; } },
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'wasm-smoke.js'), 'utf8'), sandbox);
  const persistence = calls.filter(call => call.source.includes('exact_roundtrip'));
  assert.equal(persistence.length, 1);
  assert.equal(persistence[0].args.includes('--sandbox'), false);
  assert.equal(calls.filter(call => !call.args.includes('--sandbox')).length, 1);
  assert.equal(new Set(filesystems).size, calls.length, 'each interpreter owns a fresh filesystem');
  for (const api of ['file_read', 'file_write', 'request', 'process', 'sql_open', 'remember']) {
    const probe = calls.find(call => call.source.startsWith('show ' + api + '('));
    assert.ok(probe, api + ' has a negative capability test');
    assert.ok(probe.args.includes('--sandbox'));
  }
  assert.equal(sandbox.process.exitCode, 0);
});
