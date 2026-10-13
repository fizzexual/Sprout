const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

async function exerciseSmoke(apiCount = 10, progressCount = 6, rootCount = 7, bufferCount = 6, metadataChange = null, utcCount = 10, utcSummary = null) {
  const calls = [], filesystems = [], metadataCalls = [];
  const validationLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'validate.sprout'), 'utf8');
  const validationContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'validation_library_test.sprout'), 'utf8');
  const intrinsicContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'intrinsic_builtin_test.sprout'), 'utf8');
  const configLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'config.sprout'), 'utf8');
  const configContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'config_library_test.sprout'), 'utf8');
  const apiLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'api.sprout'), 'utf8');
  const apiContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'api_contract_test.sprout'), 'utf8');
  const progressLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'workflow_progress.sprout'), 'utf8');
  const progressContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'workflow_progress_test.sprout'), 'utf8');
  const utcLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'utc.sprout'), 'utf8');
  const utcContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'utc_library_test.sprout'), 'utf8');
  const rootContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'gc_env_roots_test.sprout'), 'utf8');
  const bufferContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'argument_buffers_test.sprout'), 'utf8');
  const factory = async options => {
    const files = new Map();
    return {
      FS: { mkdirTree() {}, writeFile(name, value) { files.set(name, value); } },
      callMain(args) {
        if (args[0] === '--capabilities-json') {
          metadataCalls.push({args, files});
          assert.equal(files.size, 0, 'query instance has no mounted program or library');
          assert.equal(options.noInitialRun, true);
          if (args.length !== 1) { options.printErr('Usage: sprout --capabilities-json'); return 2; }
          const metadata = {
            schema: 1, runtime: {kind: 'wasm', os: 'emscripten', arch: 'wasm32'},
            features: {intrinsic_calls_v1: true, sqlite_adapter_v1: false, native_processes_v1: false,
              http_request_v1: false, workflow_plan_v1: true, workflow_run_v1: false},
            http_transport: {operation: 'http_request_v1', kind: 'unavailable', requires_external_tool: null},
            host_library: {included: false, abi_version: null},
          };
          if (metadataChange) metadataChange(metadata);
          options.print(JSON.stringify(metadata)); return 0;
        }
        filesystems.push(files);
        const source = files.get('/program.sprout');
        calls.push({ source, args, files });
        if (args[0] === 'test') {
          if (source === validationContracts) {
            assert.equal(files.get('/lib/validate.sprout'), validationLibrary, 'actual library is mounted');
            options.print('10 passed, 0 failed'); return 0;
          }
          if (source === configContracts) {
            assert.equal(files.get('/lib/validate.sprout'), validationLibrary, 'actual validation dependency is mounted');
            assert.equal(files.get('/lib/config.sprout'), configLibrary, 'actual configuration library is mounted');
            options.print('8 passed, 0 failed'); return 0;
          }
          if (source === apiContracts) {
            assert.equal(files.get('/lib/validate.sprout'), validationLibrary, 'actual API validation dependency is mounted');
            assert.equal(files.get('/lib/api.sprout'), apiLibrary, 'actual API library is mounted');
            options.print('\x1b[1m' + apiCount + ' passed, 0 failed\x1b[0m'); return 0;
          }
          if (source === progressContracts) {
            assert.equal(files.get('/lib/workflow_progress.sprout'), progressLibrary, 'actual workflow-progress library is mounted');
            options.print('\x1b[1m' + progressCount + ' passed, 0 failed\x1b[0m'); return 0;
          }
          if (source === utcContracts) {
            assert.equal(files.get('/lib/utc.sprout'), utcLibrary, 'actual UTC library is mounted');
            options.print('\x1b[1m' + (utcSummary ?? (utcCount + ' passed, 0 failed')) + '\x1b[0m'); return 0;
          }
          if (source === rootContracts) {
            options.print('\x1b[1m' + rootCount + ' passed, 0 failed\x1b[0m'); return 0;
          }
          if (source === bufferContracts) {
            options.print('\x1b[1m' + bufferCount + ' passed, 0 failed\x1b[0m'); return 0;
          }
          assert.equal(source, intrinsicContracts, 'actual shared intrinsic contracts reach the interpreter');
          options.print('10 passed, 0 failed'); return 0;
        }
        if (source.startsWith(validationLibrary + '\n')) {
          options.print(JSON.stringify({ok: true, errors: [], schema_error: null, truncated: false})); return 0;
        }
        if (source.startsWith(utcLibrary + '\n')) {
          options.print(JSON.stringify([
            {ok: true, instant: {seconds: {'$sprout.integer': '-1'}, nanoseconds: {'$sprout.integer': '500000000'}},
              text: '1969-12-31T23:59:59.500000000Z', error: null},
            {ok: false, instant: null, text: null,
              error: {code: 'invalid_timestamp', message: 'The timestamp does not match the supported profile.'}},
          ])); return 0;
        }
        if (/^show (?:builtin::)?(?:read|file_read|file_write|request|process|sql_open|remember|workflow_inspect|workflow_run|sql_migrate|sql_migrations)\(/.test(source)) {
          options.printErr('native access disabled in sandbox mode'); return 1;
        }
        if (source.includes('after: ["missing"]')) { options.printErr('workflow dependency does not name a job'); return 1; }
        if (source.includes('json_encode(workflow.plan(')) {
          options.print(JSON.stringify({ok: true, layers: [['build', 'lint'], ['ship']],
            order: ['build', 'lint', 'ship'], fingerprint: 'a'.repeat(64)})); return 0;
        }
        if (source.startsWith('show json_encode(args())')) { options.print(JSON.stringify(args.slice(args.indexOf('--') + 1))); return 0; }
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
    __dirname, Buffer, console: { log() {}, error(error) { throw error; } },
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'wasm-smoke.js'), 'utf8'), sandbox);
  assert.deepEqual(metadataCalls.map(call => Array.from(call.args)), [
    ['--capabilities-json'], ['--capabilities-json', 'extra'],
    ['--capabilities-json', '--sandbox'], ['--capabilities-json', '--'],
  ]);
  assert.equal(new Set(metadataCalls.map(call => call.files)).size, 4, 'every metadata query owns a fresh instance');
  const persistence = calls.filter(call => call.source.includes('exact_roundtrip'));
  assert.equal(persistence.length, 1);
  assert.equal(persistence[0].args.includes('--sandbox'), false);
  const importedValidation = calls.filter(call => call.args[0] === 'test' && call.source === validationContracts);
  assert.equal(importedValidation.length, 1, 'one shared validation corpus runs');
  assert.equal(importedValidation[0].args.includes('--sandbox'), false, 'filesystem imports need normal mode');
  assert.equal(calls.filter(call => !call.args.includes('--sandbox')).length, 6);
  const suppliedValidation = calls.filter(call => call.source.startsWith(validationLibrary + '\n'));
  assert.equal(suppliedValidation.length, 1, 'host-supplied pure validation source runs');
  assert.ok(suppliedValidation[0].args.includes('--sandbox'), 'supplied source retains sandbox restrictions');
  assert.equal(suppliedValidation[0].files.has('/lib/validate.sprout'), false, 'supplied source does not need a filesystem import');
  const intrinsic = calls.filter(call => call.args[0] === 'test' && call.source === intrinsicContracts);
  assert.equal(intrinsic.length, 1, 'shared intrinsic corpus runs exactly once');
  assert.ok(intrinsic[0].args.includes('--sandbox'), 'intrinsic corpus keeps sandbox restrictions');
  const roots = calls.filter(call => call.args[0] === 'test' && call.source === rootContracts);
  assert.equal(roots.length, 1, 'shared environment scope corpus runs exactly once');
  assert.ok(roots[0].args.includes('--sandbox'), 'scope corpus needs no filesystem capability');
  assert.deepEqual(Array.from(roots[0].args.slice(-4)), ['--max-steps', '5000000', '--timeout-ms', '5000']);
  const buffers = calls.filter(call => call.args[0] === 'test' && call.source === bufferContracts);
  assert.equal(buffers.length, 1, 'shared argument recovery corpus runs exactly once');
  assert.ok(buffers[0].args.includes('--sandbox'), 'recovery corpus needs no filesystem capability');
  assert.deepEqual(Array.from(buffers[0].args.slice(-4)), ['--max-steps', '200000', '--timeout-ms', '1000']);
  const config = calls.filter(call => call.args[0] === 'test' && call.source === configContracts);
  assert.equal(config.length, 1, 'shared configuration corpus runs exactly once');
  assert.equal(config[0].args.includes('--sandbox'), false, 'file-backed configuration imports need normal mode');
  for (const source of [apiContracts, progressContracts, utcContracts]) {
    const imported = calls.filter(call => call.args[0] === 'test' && call.source === source);
    assert.equal(imported.length, 1, 'each new pure library corpus runs exactly once');
    assert.equal(imported[0].args.includes('--sandbox'), false, 'file-backed library imports need normal mode');
  }
  const utc = calls.find(call => call.args[0] === 'test' && call.source === utcContracts);
  assert.deepEqual(Array.from(utc.args.slice(-4)), ['--max-steps', '5000000', '--timeout-ms', '3000']);
  const suppliedUtc = calls.filter(call => call.source.startsWith(utcLibrary + '\n'));
  assert.equal(suppliedUtc.length, 1, 'one supplied UTC boundary pair runs');
  assert.ok(suppliedUtc[0].args.includes('--sandbox'));
  assert.equal(suppliedUtc[0].files.has('/lib/utc.sprout'), false, 'supplied source needs no file-backed import');
  assert.equal(new Set(filesystems).size, calls.length, 'each interpreter owns a fresh filesystem');
  for (const api of ['file_read', 'file_write', 'request', 'process', 'sql_open', 'remember',
    'workflow_inspect', 'workflow_run', 'sql_migrate', 'sql_migrations']) {
    const probe = calls.find(call => call.source.startsWith('show ' + api + '('));
    assert.ok(probe, api + ' has a negative capability test');
    assert.ok(probe.args.includes('--sandbox'));
    const explicitProbe = calls.find(call => call.source.startsWith('show builtin::' + api + '('));
    assert.ok(explicitProbe, api + ' has an explicit-call negative capability test');
    assert.ok(explicitProbe.args.includes('--sandbox'));
  }
  assert.ok(calls.some(call => call.source.includes('json_encode(workflow.plan(')), 'pure workflow planning runs in the sandbox');
  assert.ok(calls.some(call => call.source.startsWith('show json_encode(args())') && call.args.includes('--')), 'application flags reach the interpreter');
  assert.equal(sandbox.process.exitCode, 0);
}

test('WASM smoke isolates persistence and retains sandboxed native capability probes', () => exerciseSmoke());

test('WASM UTC rejects mixed complete summaries while accepting one exact summary', async () => {
  await exerciseSmoke(10, 6, 7, 6, null, 10, '10 passed, 0 failed');
  for (const summary of ['10 passed\n9 passed', '9 passed\n10 passed']) {
    await assert.rejects(exerciseSmoke(10, 6, 7, 6, null, 10, summary), assert.AssertionError);
  }
});

test('WASM metadata rejects incorrect compiled flags and target/ABI claims', async () => {
  for (const change of [metadata => { metadata.features.http_request_v1 = true; },
    metadata => { metadata.features.sqlite_adapter_v1 = true; },
    metadata => { metadata.runtime.kind = 'native'; },
    metadata => { metadata.host_library.abi_version = 1; }]) {
    await assert.rejects(exerciseSmoke(10, 6, 7, 6, change), assert.AssertionError);
  }
});

test('WASM metadata requires a known numeric terminal status', async () => {
  const prefix = fs.readFileSync(path.join(__dirname, 'wasm-smoke.js'), 'utf8').split('async function run(')[0];
  assert.ok(prefix.includes('async function queryCapabilities('));
  const mockPath = path.resolve(__dirname, 'mock-sprout.js');
  const metadata = {schema: 1, runtime: {kind: 'wasm', os: 'emscripten', arch: 'wasm32'},
    features: {intrinsic_calls_v1: true, sqlite_adapter_v1: false, native_processes_v1: false,
      http_request_v1: false, workflow_plan_v1: true, workflow_run_v1: false},
    http_transport: {operation: 'http_request_v1', kind: 'unavailable', requires_external_tool: null},
    host_library: {included: false, abi_version: null}};
  async function terminal(error, expectedCode = 0) {
    const factory = async options => ({
      callMain() {
        if (expectedCode) options.printErr('Usage: sprout --capabilities-json');
        else options.print(JSON.stringify(metadata));
        throw error;
      },
      get FS() { throw new Error('metadata fixture mounted a filesystem'); },
    });
    return vm.runInNewContext(prefix + '\nqueryCapabilities(["--capabilities-json"], ' + expectedCode + ');', {
      require(name) { return name === mockPath ? factory : require(name); },
      process: {argv: ['node', 'wasm-smoke.js', mockPath]}, Buffer,
    });
  }
  for (const error of [{name: 'ExitStatus'}, {name: 'ExitStatus', status: null},
    {name: 'ExitStatus', status: NaN}, {name: 'ExitStatus', status: false},
    {name: 'OtherError', status: 0}]) {
    await assert.rejects(terminal(error), thrown => thrown === error);
  }
  await terminal({name: 'ExitStatus', status: 0});
  await terminal({name: 'ExitStatus', status: 2}, 2);
});

test('WASM summaries retain exact corpus counts with CLI colors', async () => {
  for (const wrong of [1, 9, 11, 110]) await assert.rejects(exerciseSmoke(wrong, 6), assert.AssertionError);
  for (const wrong of [1, 5, 7, 60]) await assert.rejects(exerciseSmoke(10, wrong), assert.AssertionError);
  for (const wrong of [1, 6, 8, 70]) await assert.rejects(exerciseSmoke(10, 6, wrong), assert.AssertionError);
  for (const wrong of [1, 5, 7, 60]) await assert.rejects(exerciseSmoke(10, 6, 7, wrong), assert.AssertionError);
  for (const wrong of [1, 9, 11, 100]) await assert.rejects(exerciseSmoke(10, 6, 7, 6, null, wrong), assert.AssertionError);
});
