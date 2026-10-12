const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('WASM smoke isolates persistence and retains sandboxed native capability probes', async () => {
  const calls = [], filesystems = [];
  const validationLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'validate.sprout'), 'utf8');
  const validationContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'validation_library_test.sprout'), 'utf8');
  const intrinsicContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'intrinsic_builtin_test.sprout'), 'utf8');
  const configLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'config.sprout'), 'utf8');
  const configContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'config_library_test.sprout'), 'utf8');
  const apiLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'api.sprout'), 'utf8');
  const apiContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'api_contract_test.sprout'), 'utf8');
  const progressLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'workflow_progress.sprout'), 'utf8');
  const progressContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'workflow_progress_test.sprout'), 'utf8');
  const factory = async options => {
    const files = new Map(); filesystems.push(files);
    return {
      FS: { mkdirTree() {}, writeFile(name, value) { files.set(name, value); } },
      callMain(args) {
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
            options.print('10 passed, 0 failed'); return 0;
          }
          if (source === progressContracts) {
            assert.equal(files.get('/lib/workflow_progress.sprout'), progressLibrary, 'actual workflow-progress library is mounted');
            options.print('6 passed, 0 failed'); return 0;
          }
          assert.equal(source, intrinsicContracts, 'actual shared intrinsic contracts reach the interpreter');
          options.print('10 passed, 0 failed'); return 0;
        }
        if (source.startsWith(validationLibrary + '\n')) {
          options.print(JSON.stringify({ok: true, errors: [], schema_error: null, truncated: false})); return 0;
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
    __dirname, console: { log() {}, error(error) { throw error; } },
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'wasm-smoke.js'), 'utf8'), sandbox);
  const persistence = calls.filter(call => call.source.includes('exact_roundtrip'));
  assert.equal(persistence.length, 1);
  assert.equal(persistence[0].args.includes('--sandbox'), false);
  const importedValidation = calls.filter(call => call.args[0] === 'test' && call.source === validationContracts);
  assert.equal(importedValidation.length, 1, 'one shared validation corpus runs');
  assert.equal(importedValidation[0].args.includes('--sandbox'), false, 'filesystem imports need normal mode');
  assert.equal(calls.filter(call => !call.args.includes('--sandbox')).length, 5);
  const suppliedValidation = calls.filter(call => call.source.startsWith(validationLibrary + '\n'));
  assert.equal(suppliedValidation.length, 1, 'host-supplied pure validation source runs');
  assert.ok(suppliedValidation[0].args.includes('--sandbox'), 'supplied source retains sandbox restrictions');
  assert.equal(suppliedValidation[0].files.has('/lib/validate.sprout'), false, 'supplied source does not need a filesystem import');
  const intrinsic = calls.filter(call => call.args[0] === 'test' && call.source === intrinsicContracts);
  assert.equal(intrinsic.length, 1, 'shared intrinsic corpus runs exactly once');
  assert.ok(intrinsic[0].args.includes('--sandbox'), 'intrinsic corpus keeps sandbox restrictions');
  const config = calls.filter(call => call.args[0] === 'test' && call.source === configContracts);
  assert.equal(config.length, 1, 'shared configuration corpus runs exactly once');
  assert.equal(config[0].args.includes('--sandbox'), false, 'file-backed configuration imports need normal mode');
  for (const source of [apiContracts, progressContracts]) {
    const imported = calls.filter(call => call.args[0] === 'test' && call.source === source);
    assert.equal(imported.length, 1, 'each new pure library corpus runs exactly once');
    assert.equal(imported[0].args.includes('--sandbox'), false, 'file-backed library imports need normal mode');
  }
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
});
