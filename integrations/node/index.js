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
function scalarText(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0) throw new TypeError('Sprout text cannot contain NUL.');
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('JSON text contains an unpaired surrogate.');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('JSON text contains an unpaired surrogate.');
  }
  return value;
}
// Validate before JSON.parse discards duplicate keys or accepts an overflowing
// numeric token. Only 128 containers may be active, including empty containers.
function parseWire(text) {
  let at = 0;
  const whitespace = () => { while (at < text.length && /[ \t\r\n]/.test(text[at])) at++; };
  const invalid = () => { throw new SyntaxError('Invalid JSON boundary.'); };
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') return scalarText(JSON.parse(text.slice(start, at)));
    }
    invalid();
  }
  function value(depth) {
    whitespace();
    const opening = text[at];
    if (opening === '"') { string(); return; }
    if (opening === '{' || opening === '[') {
      if (++depth > 128) throw new TypeError('JSON nesting exceeds 128 containers.');
      at++; whitespace();
      const closing = opening === '{' ? '}' : ']';
      const keys = opening === '{' ? new Set() : null;
      if (text[at] === closing) { at++; return; }
      while (at < text.length) {
        if (keys) {
          if (text[at] !== '"') invalid();
          const key = string();
          if (keys.has(key)) throw new TypeError('Duplicate JSON map key.');
          keys.add(key); whitespace();
          if (text[at++] !== ':') invalid();
        }
        value(depth); whitespace();
        if (text[at] === closing) { at++; return; }
        if (text[at++] !== ',') invalid();
        whitespace();
      }
      invalid();
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,\]}]/.test(text[at])) at++;
    if (at === start) invalid();
    const primitive = JSON.parse(text.slice(start, at));
    if (typeof primitive === 'number' && !Number.isFinite(primitive)) throw new TypeError('JSON numbers must be finite.');
    if (primitive !== null && typeof primitive !== 'number' && typeof primitive !== 'boolean') invalid();
  }
  value(0); whitespace();
  if (at !== text.length) invalid();
  return JSON.parse(text);
}
function strictJson(value, maximum) {
  const active = new Set(); let size = 0;
  function reserve(bytes) {
    if (bytes > maximum - size) throw new SproutError('JSON input exceeds maxInputBytes.', 'input-limit');
    size += bytes;
  }
  function textSize(text) {
    reserve(2);
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 0) throw new TypeError('Sprout text cannot contain NUL.');
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('JSON text contains an unpaired surrogate.');
        reserve(4);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('JSON text contains an unpaired surrogate.');
      else reserve(unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit) ? 2 : unit < 32 ? 6 : unit < 128 ? 1 : unit < 2048 ? 2 : 3);
    }
  }
  function dataProperty(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Input must contain data properties, without accessors.');
    return descriptor.value;
  }
  function visit(value, depth = 0) {
    if (value === null || typeof value === 'boolean') { reserve(value === false ? 5 : 4); return; }
    if (typeof value === 'string') { textSize(value); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Input numbers must be finite JSON numbers.');
      reserve(JSON.stringify(value).length); return;
    }
    if (typeof value !== 'object') throw new TypeError('Input must contain only JSON values.');
    if (++depth > 128) throw new TypeError('JSON nesting exceeds 128 containers.');
    if (active.has(value)) throw new TypeError('Input cannot contain cycles.');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Input objects must be plain JSON objects.');
    const hook = Object.getOwnPropertyDescriptor(value, 'toJSON');
    if (hook && (!Object.hasOwn(hook, 'value') || typeof hook.value === 'function')) throw new TypeError('Input serialization hooks are not JSON data.');
    if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Input arrays must be plain JSON arrays.');
    reserve(2);
    active.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { if (i) reserve(1); visit(dataProperty(value, String(i)), depth); }
    } else {
      let first = true;
      for (const key of Object.keys(value)) {
        if (!first) reserve(1); first = false; textSize(key); reserve(1);
        visit(dataProperty(value, key), depth);
      }
    }
    active.delete(value);
  }
  visit(value);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maximum) throw new SproutError('JSON input exceeds maxInputBytes.', 'input-limit');
  parseWire(text);
  return text;
}

/** Execute one JSON request. The caller chooses when a result replaces live behavior. */
function runSprout(program, input, options = {}) {
  if (typeof program !== 'string' || !program) return Promise.reject(new TypeError('program must name a Sprout source file.'));
  let request, limits;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object.');
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !options.cwd)) throw new TypeError('cwd must be a nonempty directory path.');
    if (options.signal != null && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal.');
    limits = {
      input: positive(options.maxInputBytes, 1024 * 1024, 'maxInputBytes', 64 * 1024 * 1024),
      output: positive(options.maxOutputBytes, 1024 * 1024, 'maxOutputBytes', 64 * 1024 * 1024),
      error: positive(options.maxErrorBytes, 64 * 1024, 'maxErrorBytes', 64 * 1024 * 1024),
      time: positive(options.timeoutMs, 5000, 'timeoutMs'),
      runtime: positive(options.runtimeTimeoutMs, 4000, 'runtimeTimeoutMs'),
      steps: positive(options.maxSteps, 100000, 'maxSteps'),
    };
    if (options.sandbox !== undefined && typeof options.sandbox !== 'boolean') throw new TypeError('sandbox must be true or false.');
    if (options.command !== undefined && (typeof options.command !== 'string' || !options.command)) throw new TypeError('command must be an executable path or name.');
    if (options.signal?.aborted) throw new SproutError('Sprout request was canceled.', 'canceled');
    request = strictJson(input, limits.input - 1) + '\n';
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
      child?.kill('SIGKILL'); child?.stdout.destroy(); child?.stderr.destroy(); child?.stdin.destroy();
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
      try { complete(null, parseWire(text)); }
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
