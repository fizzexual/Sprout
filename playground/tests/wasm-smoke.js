// Exercise the actual Emscripten build before publishing the playground.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createSprout = require(path.resolve(process.argv[2]));

async function run(source, expectedCode = 0, flags = [], sandbox = true) {
  const output = [];
  const module = await createSprout({ print: text => output.push(text), printErr: text => output.push(text),
    stdin: () => null, noInitialRun: true });
  module.FS.writeFile('/program.sprout', source);
  let code = 0;
  try { code = module.callMain(['/program.sprout', ...(sandbox ? ['--sandbox'] : []), ...flags]) || 0; }
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
    'remember("sandbox_probe", 42)']) {
    assert.match(await run('show ' + expression + '\n', 1), /sandbox mode/, expression + ' must be blocked');
  }
  assert.match(await run('repeat while yes:\n    make x = 1\n', 1, ['--max-steps', '100']), /--max-steps/);
  assert.match(await run('make x = 1\nshow x\n', 0, ['--trace-json']), /@sprout-trace .*"variables"/);
  assert.match(await run('task sum(a, b = 2):\n    give a + b\nshow sum(b: 20, a: 22)\n'), /42/);
  assert.match(await run('show """first\nsecond"""\n'), /first\nsecond/);
  // Expected failure above must not leave Node's process exit status set to 1.
  process.exitCode = 0;
  console.log('WASM smoke tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
