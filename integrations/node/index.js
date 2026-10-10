'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

class SproutError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = 'SproutError'; this.code = code; Object.assign(this, details); }
}
function positive(value, fallback, name, max = 2147483647) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(`${name} must be a positive integer up to ${max}.`);
  return n;
}
function strictJson(value) {
  const active = new Set();
  function visit(value, depth = 0) {
    if (depth > 128) throw new TypeError('JSON nesting exceeds 128 levels.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Input numbers must be finite JSON numbers.'); return; }
    if (typeof value !== 'object') throw new TypeError('Input must contain only JSON values.');
    if (active.has(value)) throw new TypeError('Input cannot contain cycles.');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Input objects must be plain JSON objects.');
    active.add(value);
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) visit(value[i], depth + 1); }
    else for (const item of Object.values(value)) visit(item, depth + 1);
    active.delete(value);
  }
  visit(value); return JSON.stringify(value);
}

/** Execute one JSON request. The caller chooses when a result replaces live behavior. */
function runSprout(program, input, options = {}) {
  if (typeof program !== 'string' || !program) return Promise.reject(new TypeError('program must name a Sprout source file.'));
  let request, limits;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object.');
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !options.cwd)) throw new TypeError('cwd must be a nonempty directory path.');
    if (options.signal != null && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal.');
    request = strictJson(input) + '\n';
    limits = {
      input: positive(options.maxInputBytes, 1024 * 1024, 'maxInputBytes', 64 * 1024 * 1024),
      output: positive(options.maxOutputBytes, 1024 * 1024, 'maxOutputBytes', 64 * 1024 * 1024),
      error: positive(options.maxErrorBytes, 64 * 1024, 'maxErrorBytes', 64 * 1024 * 1024),
      time: positive(options.timeoutMs, 5000, 'timeoutMs'),
      runtime: positive(options.runtimeTimeoutMs, 4000, 'runtimeTimeoutMs'),
      steps: positive(options.maxSteps, 100000, 'maxSteps'),
    };
    if (Buffer.byteLength(request) > limits.input) throw new SproutError('JSON input exceeds maxInputBytes.', 'input-limit');
    if (options.sandbox !== undefined && typeof options.sandbox !== 'boolean') throw new TypeError('sandbox must be true or false.');
    if (options.command !== undefined && (typeof options.command !== 'string' || !options.command)) throw new TypeError('command must be an executable path or name.');
  } catch (error) { return Promise.reject(error); }
  if (options.signal?.aborted) return Promise.reject(new SproutError('Sprout request was canceled.', 'canceled'));
  const filename = path.resolve(program), cwd = options.cwd ? path.resolve(options.cwd) : path.dirname(filename);
  const args = ['run', filename, '--max-steps', String(limits.steps), '--timeout-ms', String(limits.runtime)];
  if (options.sandbox !== false) args.push('--sandbox');
  return new Promise((resolve, reject) => {
    let child, settled = false, failure = null, timer;
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
    const fail = error => {
      if (settled || failure) return;
      failure = error; error.stderr = Buffer.concat(chunks.stderr).toString('utf8');
      child?.kill(); child?.stdout.destroy(); child?.stderr.destroy(); child?.stdin.destroy();
      complete(error);
    };
    const cancel = () => fail(new SproutError('Sprout request was canceled.', 'canceled'));
    const complete = (error, value) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(value); };
    try { child = spawn(options.command || 'sprout', args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { complete(new SproutError(`Could not start Sprout: ${error.message}`, 'spawn', { cause: error })); return; }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const limit = stream === 'stdout' ? limits.output : limits.error;
      if (failure) return;
      if (sizes[stream] + chunk.length > limit) { fail(new SproutError(`Sprout ${stream} exceeds its byte limit.`, `${stream}-limit`)); return; }
      sizes[stream] += chunk.length; chunks[stream].push(chunk);
    });
    child.once('error', error => complete(new SproutError(`Could not start Sprout: ${error.message}`, 'spawn', { cause: error })));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(new SproutError(`Could not send JSON input: ${error.message}`, 'stdin', { cause: error })); });
    child.once('close', (exitCode, signal) => {
      const stderr = Buffer.concat(chunks.stderr).toString('utf8');
      if (failure) { failure.stderr = stderr; complete(failure); return; }
      if (exitCode !== 0) { complete(new SproutError(`Sprout exited with ${exitCode ?? signal}.`, 'runtime', { exitCode, signal, stderr })); return; }
      const bytes = Buffer.concat(chunks.stdout);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (error) { complete(new SproutError('Sprout returned invalid UTF-8.', 'protocol', { cause: error, stderr })); return; }
      // The protocol is exactly one JSON line. Debug prints are protocol failures.
      if (text.endsWith('\r\n')) text = text.slice(0, -2); else if (text.endsWith('\n')) text = text.slice(0, -1);
      if (!text.trim() || text.includes('\n') || text.includes('\r')) { complete(new SproutError('Sprout must return exactly one JSON line.', 'protocol', { stderr })); return; }
      try { complete(null, JSON.parse(text)); }
      catch (error) { complete(new SproutError('Sprout returned malformed JSON.', 'protocol', { cause: error, stderr })); }
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      fail(new SproutError('Sprout request exceeded its host timeout.', 'timeout'));
      // Hostile descendants may keep pipes open: release the request after killing
      // the direct interpreter and closing its owned streams.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }, limits.time);
    if (options.signal?.aborted) cancel();
    if (!failure) child.stdin.end(request);
  });
}

module.exports = { runSprout, SproutError };
