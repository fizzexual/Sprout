/* One interpreter per worker. The UI can terminate even an infinite Sprout loop. */
let interpreter, output = '', finished = false;
const MAX_OUTPUT = 65536;
const MAX_TRACE_BYTES = 1024 * 1024, MAX_TRACE_EVENTS = 2000;
let tracing = false, traceBytes = 0, traceCount = 0, traceTruncated = false, traceBatch = [];

function flushTrace() {
  if (!traceBatch.length) return;
  self.postMessage({ type: 'trace', events: traceBatch }); traceBatch = [];
}

function pushError(text) {
  const line = String(text), prefix = '@sprout-trace ';
  if (!tracing || !line.startsWith(prefix)) { push(line); return; }
  if (traceTruncated) return;
  // UTF-8 uses at most three bytes per UTF-16 code unit; count bytes when possible.
  const bytes = typeof TextEncoder === 'undefined' ? line.length * 3 : new TextEncoder().encode(line).length;
  if (traceCount >= MAX_TRACE_EVENTS || traceBytes + bytes > MAX_TRACE_BYTES) { traceTruncated = true; return; }
  let event;
  try { event = JSON.parse(line.slice(prefix.length)); } catch { push(line); return; }
  if (event.type !== 'step' || !Number.isSafeInteger(event.sequence) || !Number.isSafeInteger(event.line) || event.line < 1 || typeof event.file !== 'string' || !event.variables || typeof event.variables !== 'object' || Array.isArray(event.variables) || !Array.isArray(event.stack)) { push(line); return; }
  const variables = Object.create(null);
  for (const [name, value] of Object.entries(event.variables).slice(0, 256)) variables[name.slice(0, 256)] = String(value).slice(0, 4096);
  const stack = event.stack.slice(0, 64).filter(frame => frame && typeof frame === 'object').map(frame => ({ task: String(frame.task || '').slice(0, 256), line: Number.isSafeInteger(frame.line) ? frame.line : 0 }));
  traceBatch.push({ type: 'step', sequence: event.sequence, file: event.file.slice(0, 1024), line: event.line, depth: Number.isSafeInteger(event.depth) ? event.depth : 0, variables, stack });
  traceBytes += bytes; traceCount++;
  if (traceBatch.length >= 32) flushTrace();
}

function finish(exitCode, stopped) {
  if (finished) return;
  finished = true;
  flushTrace();
  self.postMessage({ type: 'done', output, exitCode, stopped, traceTruncated, traceCount });
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
  interpreter = await createSprout({ print: push, printErr: pushError, stdin: () => null, noInitialRun: true });
  self.postMessage({ type: 'ready' });
}

self.onmessage = event => {
  if (!interpreter || event.data.type !== 'run' || finished) return;
  tracing = event.data.trace === true;
  let exitCode = 0;
  try {
    interpreter.FS.writeFile('/program.sprout', event.data.code);
    const args = ['/program.sprout', '--sandbox'];
    if (tracing) args.push('--trace-json', '--max-steps', '100000', '--timeout-ms', '4000');
    exitCode = interpreter.callMain(args) || 0;
  } catch (error) {
    if (finished) return;
    if (error && (error.name === 'ExitStatus' || error.status !== undefined)) exitCode = error.status || 0;
    else { output += '\n[runtime error] ' + error; exitCode = 1; }
  }
  finish(exitCode, null);
};

initialize().catch(error => self.postMessage({ type: 'error', message: String(error) }));
