// Exercise the actual Emscripten build before publishing the playground.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createSprout = require(path.resolve(process.argv[2]));

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
  assert.equal((await run('show 6 * 7\n')).trim(), '42');
  for (const name of ['json_validation_test.sprout', 'object_regressions_test.sprout', 'exact_numbers_test.sprout', 'binary_values_test.sprout']) {
    // Each call creates a fresh Emscripten MEMFS. Only this suite needs persistence
    // access to exercise remember/recall/forget; ordinary playground runs stay sandboxed.
    await run(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', name), 'utf8'), 0, [], name !== 'exact_numbers_test.sprout');
    console.log('ok: WASM ' + name);
  }
  assert.match(await run('show read("/etc/passwd")\n', 1), /sandbox mode/);
  for (const expression of ['file_read("/etc/passwd")', 'file_write("/marker", "forbidden")',
    'request("https://example.com")', 'process(["echo", "forbidden"])', 'sql_open("/database.sqlite")',
    'workflow_inspect("/checkpoint.json")', 'workflow_run([], {checkpoint: "/checkpoint.json"})',
    'sql_migrate(nothing, [])', 'sql_migrations(nothing)',
    'remember("sandbox_probe", 42)']) {
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
  // Expected failure above must not leave Node's process exit status set to 1.
  process.exitCode = 0;
  console.log('WASM smoke tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
