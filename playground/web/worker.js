/* One interpreter per worker. The UI can terminate even an infinite Sprout loop. */
let interpreter, output = '', finished = false;
const MAX_OUTPUT = 65536;

function finish(exitCode, stopped) {
  if (finished) return;
  finished = true;
  self.postMessage({ type: 'done', output, exitCode, stopped });
}

function push(text) {
  const line = String(text) + '\n';
  if (output.length + line.length > MAX_OUTPUT) {
    output += line.slice(0, MAX_OUTPUT - output.length);
    finish(null, 'output limit');
    throw new Error('Sprout output limit reached');
  }
  output += line;
}

async function initialize() {
  importScripts('sprout.js');
  interpreter = await createSprout({ print: push, printErr: push, stdin: () => null, noInitialRun: true });
  self.postMessage({ type: 'ready' });
}

self.onmessage = event => {
  if (!interpreter || event.data.type !== 'run' || finished) return;
  let exitCode = 0;
  try {
    interpreter.FS.writeFile('/program.sprout', event.data.code);
    exitCode = interpreter.callMain(['/program.sprout', '--sandbox']) || 0;
  } catch (error) {
    if (finished) return;
    if (error && (error.name === 'ExitStatus' || error.status !== undefined)) exitCode = error.status || 0;
    else { output += '\n[runtime error] ' + error; exitCode = 1; }
  }
  finish(exitCode, null);
};

initialize().catch(error => self.postMessage({ type: 'error', message: String(error) }));
