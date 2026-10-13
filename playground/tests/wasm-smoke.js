// Exercise the actual Emscripten build before publishing the playground.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createSprout = require(path.resolve(process.argv[2]));
const unstyled = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

function assertLibrarySummary(output, expected, label) {
  const clean = unstyled(output);
  assert.doesNotMatch(clean, /\b0*[1-9][0-9]*[ \t]+failed\b/);
  const summaries = clean.split(/\r?\n/).map(line =>
    line.match(/^[ \t]*([0-9]+) passed(?:,[ \t]*([0-9]+) failed)?[ \t]*$/)).filter(Boolean);
  assert.equal(summaries.length, 1, label + ' has exactly one complete test summary');
  assert.equal(summaries[0][1], String(expected));
  assert.ok(summaries[0][2] === undefined || summaries[0][2] === '0');
}

// Metadata must work before mounting source, importing a library or parsing
// runtime flags. Each query owns a fresh instance, including rejected queries.
async function queryCapabilities(args, expectedCode = 0) {
  const output = [], errors = [];
  const module = await createSprout({ print: text => output.push(text), printErr: text => errors.push(text),
    stdin: () => { throw new Error('metadata query read stdin'); }, noInitialRun: true });
  let code = 0;
  try { code = module.callMain(args) || 0; }
  catch (error) {
    if (error && error.name === 'ExitStatus' && Number.isInteger(error.status)) code = error.status;
    else throw error;
  }
  assert.equal(code, expectedCode, errors.join('\n'));
  if (expectedCode) {
    assert.deepEqual(output, []);
    assert.deepEqual(errors, ['Usage: sprout --capabilities-json']);
    return;
  }
  assert.deepEqual(errors, []);
  assert.equal(output.length, 1, 'metadata is exactly one JSON line');
  assert.match(output[0], /^[\x20-\x7e]+$/);
  assert.ok(Buffer.byteLength(output[0], 'ascii') + 1 <= 1024);
  assert.deepEqual(JSON.parse(output[0]), {
    schema: 1, runtime: {kind: 'wasm', os: 'emscripten', arch: 'wasm32'},
    features: {intrinsic_calls_v1: true, sqlite_adapter_v1: false, native_processes_v1: false,
      http_request_v1: false, workflow_plan_v1: true, workflow_run_v1: false},
    http_transport: {operation: 'http_request_v1', kind: 'unavailable', requires_external_tool: null},
    host_library: {included: false, abi_version: null},
  });
}

async function run(source, expectedCode = 0, flags = [], sandbox = true, files = {}, command = null) {
  const output = [];
  const module = await createSprout({ print: text => output.push(text), printErr: text => output.push(text),
    stdin: () => null, noInitialRun: true });
  module.FS.writeFile('/program.sprout', source);
  for (const [name, contents] of Object.entries(files)) {
    module.FS.mkdirTree(path.posix.dirname(name));
    module.FS.writeFile(name, contents);
  }
  let code = 0;
  try { code = module.callMain([...(command ? [command] : []), '/program.sprout', ...(sandbox ? ['--sandbox'] : []), ...flags]) || 0; }
  catch (error) {
    if (error && (error.name === 'ExitStatus' || error.status !== undefined)) code = error.status || 0;
    else throw error;
  }
  assert.equal(code, expectedCode, output.join('\n'));
  return output.join('\n');
}

(async () => {
  await queryCapabilities(['--capabilities-json']);
  for (const extra of ['extra', '--sandbox', '--']) await queryCapabilities(['--capabilities-json', extra], 2);
  console.log('ok: WASM source-free compiled metadata and exact argument admission');
  assert.equal((await run('show 6 * 7\n')).trim(), '42');
  for (const name of ['json_validation_test.sprout', 'object_regressions_test.sprout', 'exact_numbers_test.sprout', 'binary_values_test.sprout']) {
    // Each call creates a fresh Emscripten MEMFS. Only this suite needs persistence
    // access to exercise remember/recall/forget; ordinary playground runs stay sandboxed.
    await run(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', name), 'utf8'), 0, [], name !== 'exact_numbers_test.sprout');
    console.log('ok: WASM ' + name);
  }
  assert.match(await run('show read("/etc/passwd")\n', 1), /sandbox mode/);
  const nativeExpressions = ['file_read("/etc/passwd")', 'file_write("/marker", "forbidden")',
    'request("http://127.0.0.1:1/")', 'process(["echo", "forbidden"])', 'sql_open("/database.sqlite")',
    'workflow_inspect("/checkpoint.json")', 'workflow_run([], {checkpoint: "/checkpoint.json"})',
    'sql_migrate(nothing, [])', 'sql_migrations(nothing)',
    'remember("sandbox_probe", 42)'];
  for (const expression of nativeExpressions) {
    assert.match(await run('show ' + expression + '\n', 1), /sandbox mode/, expression + ' must be blocked');
  }
  assert.match(await run('repeat while yes:\n    make x = 1\n', 1, ['--max-steps', '100']), /--max-steps/);
  assert.match(await run('make x = 1\nshow x\n', 0, ['--trace-json']), /@sprout-trace .*"variables"/);
  assert.match(await run('task sum(a, b = 2):\n    give a + b\nshow sum(b: 20, a: 22)\n'), /42/);
  assert.match(await run('show """first\nsecond"""\n'), /first\nsecond/);
  const planned = JSON.parse(await run('use workflow\nshow json_encode(workflow.plan([' +
    '{id: "build", argv: ["never-execute"]},' +
    '{id: "lint", argv: ["never-execute"]},' +
    '{id: "ship", argv: ["never-execute"], after: ["build", "lint"]}]))\n'));
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.layers, [['build', 'lint'], ['ship']]);
  assert.deepEqual(planned.order, ['build', 'lint', 'ship']);
  assert.match(planned.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(await run('use workflow\nshow workflow.plan([{id: "one", argv: ["never"], after: ["missing"]}])\n', 1), /dependency does not name a job/);
  const literalFlags = ['--sandbox', '--max-steps', 'application-value', '--stdin', '--'];
  assert.deepEqual(JSON.parse(await run('show json_encode(args())\n', 0, ['--', ...literalFlags])), literalFlags);
  assert.match(await run('show file_read("/program.sprout")\n', 1, ['--', '--sandbox']), /sandbox mode/);
  const validationLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'validate.sprout'), 'utf8');
  const validationContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'validation_library_test.sprout'), 'utf8');
  // File-backed module imports need normal mode; the files stay inside MEMFS.
  const validationOutput = await run(validationContracts, 0, ['--max-steps', '3000000'], false,
    {'/lib/validate.sprout': validationLibrary}, 'test');
  assert.match(validationOutput, /[1-9][0-9]* passed/);
  assert.doesNotMatch(validationOutput, /[1-9][0-9]* failed/);
  console.log('ok: WASM validation source-library contracts');
  // A host can supply the pure library source with a sandboxed program. This
  // does not grant sandboxed scripts permission to import filesystem modules.
  const suppliedValidation = JSON.parse(await run(validationLibrary + '\n' +
    'show json_encode(check({name: "🌱"}, {kind: "map", fields: {name: {kind: "text", max_length: 2}}}))\n',
    0, ['--max-steps', '3000000']));
  assert.equal(suppliedValidation.ok, true);
  assert.deepEqual(suppliedValidation.errors, []);
  const intrinsicContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'intrinsic_builtin_test.sprout'), 'utf8');
  const intrinsicOutput = await run(intrinsicContracts, 0, ['--max-steps', '3000000'], true, {}, 'test');
  assert.match(intrinsicOutput, /[1-9][0-9]* passed/);
  assert.doesNotMatch(intrinsicOutput, /[1-9][0-9]* failed/);
  console.log('ok: WASM explicit builtin contracts');
  const configLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'config.sprout'), 'utf8');
  const configContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'config_library_test.sprout'), 'utf8');
  const configOutput = await run(configContracts, 0, ['--max-steps', '3000000'], false,
    {'/lib/validate.sprout': validationLibrary, '/lib/config.sprout': configLibrary}, 'test');
  assert.match(configOutput, /[1-9][0-9]* passed/);
  assert.doesNotMatch(configOutput, /[1-9][0-9]* failed/);
  console.log('ok: WASM layered configuration contracts');
  const apiLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'api.sprout'), 'utf8');
  const apiContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'api_contract_test.sprout'), 'utf8');
  const apiOutput = await run(apiContracts, 0, ['--max-steps', '5000000'], false,
    {'/lib/validate.sprout': validationLibrary, '/lib/api.sprout': apiLibrary}, 'test');
  assert.match(unstyled(apiOutput), /^\s*10 passed(?:,\s*0 failed)?\s*$/m);
  assert.doesNotMatch(unstyled(apiOutput), /[1-9][0-9]* failed/);
  console.log('ok: WASM pure API contracts');
  const progressLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'workflow_progress.sprout'), 'utf8');
  const progressContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'workflow_progress_test.sprout'), 'utf8');
  const progressOutput = await run(progressContracts, 0, ['--max-steps', '1000000'], false,
    {'/lib/workflow_progress.sprout': progressLibrary}, 'test');
  assert.match(unstyled(progressOutput), /^\s*6 passed(?:,\s*0 failed)?\s*$/m);
  assert.doesNotMatch(unstyled(progressOutput), /[1-9][0-9]* failed/);
  console.log('ok: WASM recorded workflow progress contracts');
  const utcLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'utc.sprout'), 'utf8');
  const utcContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'utc_library_test.sprout'), 'utf8');
  const utcOutput = await run(utcContracts, 0, ['--max-steps', '5000000', '--timeout-ms', '3000'], false,
    {'/lib/utc.sprout': utcLibrary}, 'test');
  assertLibrarySummary(utcOutput, 10, 'UTC');
  const suppliedUtc = JSON.parse(await run(utcLibrary + '\n' +
    'show builtin::json_encode([parse("1969-12-31T23:59:59.5Z"), parse("1900-02-29T00:00:00Z")])\n',
    0, ['--max-steps', '5000000', '--timeout-ms', '3000']));
  assert.deepEqual(suppliedUtc, [
    {ok: true, instant: {seconds: {'$sprout.integer': '-1'}, nanoseconds: {'$sprout.integer': '500000000'}},
      text: '1969-12-31T23:59:59.500000000Z', error: null},
    {ok: false, instant: null, text: null,
      error: {code: 'invalid_timestamp', message: 'The timestamp does not match the supported profile.'}},
  ]);
  console.log('ok: WASM exact UTC contracts and supplied-source sandbox');
  const textSteppingContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'text_stepping_test.sprout'), 'utf8');
  const textSteppingOutput = await run(textSteppingContracts, 0, ['--max-steps', '5000000', '--timeout-ms', '3000'], true, {}, 'test');
  assertLibrarySummary(textSteppingOutput, 6, 'Text stepping');
  console.log('ok: WASM bounded text stepping and byte-safe legacy tails');
  const decisionLibrary = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'decision.sprout'), 'utf8');
  const decisionContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'decision_library_test.sprout'), 'utf8');
  const decisionOutput = await run(decisionContracts, 0, ['--max-steps', '5000000', '--timeout-ms', '3000'], false,
    {'/lib/validate.sprout': validationLibrary, '/lib/decision.sprout': decisionLibrary}, 'test');
  assertLibrarySummary(decisionOutput, 10, 'Decision tables');
  const suppliedDecisionLibrary = decisionLibrary.replace(
    /^use "validate\.sprout"\r?\nprivate make d_validate = validate\.check\r?$/m,
    'private make d_validate = check');
  assert.notEqual(suppliedDecisionLibrary, decisionLibrary, 'inline decision helper captures the supplied validator');
  const suppliedDecision = JSON.parse(await run(validationLibrary + '\n' + suppliedDecisionLibrary + '\n' +
    '~ WASM decision supplied pair\n' +
    'make table = {schema: 1, input_schema: {kind: "map", fields: {weight: {kind: "decimal", required: yes}, note: {kind: "text", required: no, nullable: yes}}}, rules: [' +
    '{id: "oversize", conditions: [{field: "weight", op: "gte", value: builtin::decimal("2.50")}], output: {route: "review"}}, ' +
    '{id: "missing-note", conditions: [{field: "note", op: "missing"}], output: {route: "queue"}}, ' +
    '{id: "explicit-null", conditions: [{field: "note", op: "eq", value: nothing}], output: {route: "check"}}], fallback: {route: "standard"}}\n' +
    'show builtin::json_encode([evaluate({weight: builtin::decimal("2.500")}, table), evaluate({weight: builtin::decimal("1.00"), note: nothing}, table)])\n',
    0, ['--max-steps', '5000000', '--timeout-ms', '3000']));
  assert.deepEqual(suppliedDecision, [
    {ok: true, matched: true, selection: {kind: 'rule', index: {'$sprout.integer': '1'}, id: 'oversize'}, output: {route: 'review'}, error: null},
    {ok: true, matched: true, selection: {kind: 'rule', index: {'$sprout.integer': '3'}, id: 'explicit-null'}, output: {route: 'check'}, error: null},
  ]);
  console.log('ok: WASM ordered decision contracts and supplied-source sandbox');
  const rootContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'gc_env_roots_test.sprout'), 'utf8');
  const rootOutput = await run(rootContracts, 0, ['--max-steps', '5000000', '--timeout-ms', '5000'], true, {}, 'test');
  assert.match(unstyled(rootOutput), /^\s*7 passed(?:,\s*0 failed)?\s*$/m);
  assert.doesNotMatch(unstyled(rootOutput), /[1-9][0-9]* failed/);
  console.log('ok: WASM environment scope contracts (ordinary runtime; semantic recovery only)');
  const bufferContracts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', 'argument_buffers_test.sprout'), 'utf8');
  const bufferOutput = await run(bufferContracts, 0, ['--max-steps', '200000', '--timeout-ms', '1000'], true, {}, 'test');
  assert.match(unstyled(bufferOutput), /^\s*6 passed(?:,\s*0 failed)?\s*$/m);
  assert.doesNotMatch(unstyled(bufferOutput), /[1-9][0-9]* failed/);
  console.log('ok: WASM argument recovery contracts (ordinary runtime; semantic recovery only, no allocation counters)');
  for (const expression of nativeExpressions) {
    assert.match(await run('show builtin::' + expression + '\n', 1), /sandbox mode/, expression + ' must stay blocked with explicit lookup');
  }
  // Expected failure above must not leave Node's process exit status set to 1.
  process.exitCode = 0;
  console.log('WASM smoke tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
