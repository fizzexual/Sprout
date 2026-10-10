// Exercise the actual Emscripten build before publishing the playground.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createSprout = require(path.resolve(process.argv[2]));

async function run(source, expectedCode = 0) {
  const output = [];
  const module = await createSprout({ print: text => output.push(text), printErr: text => output.push(text),
    stdin: () => null, noInitialRun: true });
  module.FS.writeFile('/program.sprout', source);
  let code = 0;
  try { code = module.callMain(['/program.sprout', '--sandbox']) || 0; }
  catch (error) {
    if (error && (error.name === 'ExitStatus' || error.status !== undefined)) code = error.status || 0;
    else throw error;
  }
  assert.equal(code, expectedCode, output.join('\n'));
  return output.join('\n');
}

(async () => {
  assert.equal((await run('show 6 * 7\n')).trim(), '42');
  for (const name of ['json_validation_test.sprout', 'object_regressions_test.sprout']) {
    await run(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tests', name), 'utf8'));
    console.log('ok: WASM ' + name);
  }
  assert.match(await run('show read("/etc/passwd")\n', 1), /sandbox mode/);
  // Expected failure above must not leave Node's process exit status set to 1.
  process.exitCode = 0;
  console.log('WASM smoke tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
