'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

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

function validateWorker(program, options) {
    if (typeof program !== 'string' || !program) throw new TypeError('program must name a Sprout source file.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object.');
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !options.cwd)) throw new TypeError('cwd must be a nonempty directory path.');
    if (options.signal != null && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal.');
    const limits = {
      input: Math.min(positive(options.maxInputBytes, 1024 * 1024, 'maxInputBytes', 64 * 1024 * 1024), 1024 * 1024),
      output: positive(options.maxOutputBytes, 1024 * 1024, 'maxOutputBytes', 64 * 1024 * 1024),
      error: positive(options.maxErrorBytes, 64 * 1024, 'maxErrorBytes', 64 * 1024 * 1024),
      time: positive(options.timeoutMs, 5000, 'timeoutMs'),
      runtime: positive(options.runtimeTimeoutMs, 4000, 'runtimeTimeoutMs'),
      steps: positive(options.maxSteps, 100000, 'maxSteps'),
    };
    if (options.sandbox !== undefined && typeof options.sandbox !== 'boolean') throw new TypeError('sandbox must be true or false.');
    if (options.command !== undefined && (typeof options.command !== 'string' || !options.command)) throw new TypeError('command must be an executable path or name.');
  const filename = path.resolve(program), cwd = options.cwd ? path.resolve(options.cwd) : path.dirname(filename);
  const args = ['run', filename, '--max-steps', String(limits.steps), '--timeout-ms', String(limits.runtime)];
  if (options.sandbox !== false) args.push('--sandbox');
  return { filename, cwd, args, limits, command: options.command || 'sprout', signal: options.signal };
}
function prepareRequest(input, profile, signal) {
  if (signal?.aborted) throw new SproutError('Sprout request was canceled.', 'canceled');
  const request = strictJson(input, profile.limits.input - 1) + '\n';
  if (signal?.aborted) throw new SproutError('Sprout request was canceled.', 'canceled');
  return request;
}

// Result settlement and owned-worker termination are separate. Standalone
// callers keep prompt rejection; queues retain the slot until lifecycle settles.
function startWorker(profile, request, signal, cleanupTimeoutMs = 1000) {
    let child, settled = false, failure = null, timer, cleanupTimer, closed = false, exited = false;
    let lifecycleSettled = false, killAttempted = false, killError = null, cancellationError = null;
    let resolveResult, rejectResult, resolveLifecycle, resolveActualClose;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const lifecycle = new Promise(resolve => { resolveLifecycle = resolve; });
    const actualClose = new Promise(resolve => { resolveActualClose = resolve; });
    const limits = profile.limits;
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    const observation = confirmed => Object.freeze({ confirmed, started: Number.isInteger(child?.pid) && child.pid > 0,
      pid: child?.pid ?? null, closeObserved: closed, exitObserved: exited,
      exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null, killAttempted, killError, cancellationError });
    const finishLifecycle = confirmed => {
      if (lifecycleSettled) return;
      lifecycleSettled = true; clearTimeout(cleanupTimer); resolveLifecycle(observation(confirmed));
    };
    const cleanup = () => {
      clearTimeout(timer);
      try { signal?.removeEventListener('abort', cancel); }
      catch (error) { cancellationError = String(error.message || error).slice(0, 512); }
    };
    const complete = (error, value) => { if (settled) return; settled = true; cleanup(); error ? rejectResult(error) : resolveResult(value); };
    const fail = error => {
      if (settled || failure) return;
      failure = error; error.stderr = Buffer.concat(chunks.stderr).toString('utf8');
      cleanupTimer = setTimeout(() => finishLifecycle(false), cleanupTimeoutMs);
      if (child && !closed && !exited && child.exitCode == null && child.signalCode == null) {
        killAttempted = true;
        try { if (!child.kill('SIGKILL')) killError = 'Direct owned-child kill returned false.'; }
        catch (cause) { killError = String(cause.message || cause).slice(0, 512); }
      }
      child?.stdout.destroy(); child?.stderr.destroy(); child?.stdin.destroy();
      complete(error);
    };
    const cancel = () => fail(new SproutError('Sprout request was canceled.', 'canceled'));
    try { child = spawn(profile.command, profile.args, { cwd: profile.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) {
      complete(new SproutError(`Could not start Sprout: ${error.message}`, 'spawn', { cause: error }));
      finishLifecycle(true); resolveActualClose();
      return { result, lifecycle, actualClose, actuallyClosed: () => true };
    }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const limit = stream === 'stdout' ? limits.output : limits.error;
      if (failure) return;
      if (sizes[stream] + chunk.length > limit) { fail(new SproutError(`Sprout ${stream} exceeds its byte limit.`, `${stream}-limit`)); return; }
      sizes[stream] += chunk.length; chunks[stream].push(chunk);
    });
    child.once('error', error => {
      if (failure) { if (!killError) killError = String(error.message || error).slice(0, 512); return; }
      if (child.pid == null) {
        complete(new SproutError(`Could not start Sprout: ${error.message}`, 'spawn', { cause: error }));
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        finishLifecycle(true);
      } else fail(new SproutError(`Could not start Sprout: ${error.message}`, 'spawn', { cause: error }));
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(new SproutError(`Could not send JSON input: ${error.message}`, 'stdin', { cause: error })); });
    child.once('exit', () => { exited = true; });
    child.once('close', (exitCode, signal) => {
      closed = true; resolveActualClose(); finishLifecycle(true);
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
    timer = setTimeout(() => {
      fail(new SproutError('Sprout request exceeded its host timeout.', 'timeout'));
    }, limits.time);
    try { signal?.addEventListener('abort', cancel, { once: true }); }
    catch (error) { fail(new SproutError(`Could not subscribe to cancellation: ${error.message}`, 'canceled', { cause: error })); }
    if (signal?.aborted) cancel();
    if (!failure) {
      try { child.stdin.end(request); }
      catch (error) { fail(new SproutError(`Could not send JSON input: ${error.message}`, 'stdin', { cause: error })); }
    }
    return { result, lifecycle, actualClose, actuallyClosed: () => closed };
}

/** Execute one JSON request. The caller chooses when a result replaces live behavior. */
function runSprout(program, input, options = {}) {
  try {
    const profile = validateWorker(program, options);
    return startWorker(profile, prepareRequest(input, profile, profile.signal), profile.signal).result;
  } catch (error) { return Promise.reject(error); }
}

/** Bounded FIFO admission around fresh workers; never a worker pool or VM cache. */
function createSproutQueue(program, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object.');
  const workerNames = ['command', 'cwd', 'sandbox', 'timeoutMs', 'runtimeTimeoutMs', 'maxSteps', 'maxInputBytes', 'maxOutputBytes', 'maxErrorBytes'];
  const queueNames = ['concurrency', 'maxQueued', 'queueTimeoutMs', 'cleanupTimeoutMs'];
  for (const name of Object.keys(options)) if (![...workerNames, ...queueNames].includes(name)) throw new TypeError(`Unknown queue option '${name}'.`);
  const concurrency = positive(options.concurrency, 4, 'concurrency', 64);
  const maxQueued = options.maxQueued ?? 32;
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 1024) throw new TypeError('maxQueued must be an integer from 0 to 1024.');
  const queueTimeoutMs = positive(options.queueTimeoutMs, 5000, 'queueTimeoutMs');
  const cleanupTimeoutMs = positive(options.cleanupTimeoutMs, 1000, 'cleanupTimeoutMs', 60000);
  const profile = validateWorker(program, Object.fromEntries(workerNames.filter(name => options[name] !== undefined).map(name => [name, options[name]])));
  const active = new Set(), waiting = [], uncertain = [];
  let state = 'open', preparing = 0, draining = false, closePromise, closeResolve, closeReject, closeTimer, uncertainCount = 0;
  const error = (code, message) => new SproutError(message, code);
  const closedError = () => error('queue-closed', `Sprout queue is ${state}; it accepts no new requests.`);
  const removeWaiting = job => { const at = waiting.indexOf(job); if (at >= 0) waiting.splice(at, 1); };
  const recordUncertainty = observation => { uncertainCount++; if (uncertain.length < 64) uncertain.push(observation); state = 'failed'; };
  function settle(job, failure, value) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    try { job.signal?.removeEventListener('abort', job.abort); }
    catch (cause) {
      if (!failure) failure = new SproutError('Could not remove the request cancellation listener.', 'canceled', { cause });
      failure.cancellationCleanupError = String(cause.message || cause).slice(0, 512);
      recordUncertainty(Object.freeze({ confirmed: false, phase: 'abort-listener', error: failure.cancellationCleanupError }));
      rejectWaiting();
    }
    job.request = null;
    failure ? job.reject(failure) : job.resolve(value);
  }
  function finishClose() {
    if (!closePromise || draining || preparing || waiting.length || [...active].some(job => !job.quarantined)) return;
    clearTimeout(closeTimer);
    if (uncertainCount) {
      state = 'failed'; closeReject(new SproutError('Owned Sprout worker cleanup could not be confirmed.', 'cleanup',
        { cleanup: Object.freeze({ confirmed: false, observations: Object.freeze(uncertain.slice()), total: uncertainCount, truncated: uncertainCount > uncertain.length }) }));
    } else { state = 'closed'; closeResolve(); }
  }
  function rejectWaiting() {
    for (const job of waiting.splice(0)) settle(job, closedError());
  }
  function start(job) {
    clearTimeout(job.timer); job.running = true; active.add(job);
    const ticket = startWorker(profile, job.request, job.controller.signal, cleanupTimeoutMs);
    job.request = null;
    ticket.actualClose.then(() => { if (job.quarantined) { active.delete(job); finishClose(); } });
    Promise.all([ticket.result.then(value => ({ value }), failure => ({ failure })), ticket.lifecycle]).then(([outcome, cleanup]) => {
      if (cleanup.confirmed) active.delete(job);
      else {
        job.quarantined = true;
        if (ticket.actuallyClosed()) active.delete(job);
        recordUncertainty(cleanup); rejectWaiting();
      }
      if (outcome.failure) outcome.failure.cleanup = cleanup;
      settle(job, outcome.failure || (!cleanup.confirmed ? new SproutError('Owned Sprout worker cleanup could not be confirmed.', 'cleanup', { cleanup }) : null), outcome.value);
      drain(); finishClose();
    });
  }
  function drain() {
    if (draining || (state !== 'open' && state !== 'closing')) return;
    draining = true;
    try {
      while ((state === 'open' || state === 'closing') && active.size < concurrency && waiting.length) {
        const job = waiting.shift();
        // Cancellation signals may expose caller-defined getters. Keep the
        // dispatch reservation visible to close/admission while observing them.
        active.add(job);
        let dispatched = false;
        try {
          let aborted, now, observationError;
          try { aborted = job.signal?.aborted; now = performance.now(); }
          catch (cause) { observationError = new SproutError('Could not inspect waiting cancellation signal.', 'canceled', { cause, phase: 'queue-dispatch' }); }
          if (job.settled) continue;
          if ((state !== 'open' && state !== 'closing') || job.controller.signal.aborted) settle(job, closedError());
          else if (observationError) settle(job, observationError);
          else if (aborted) settle(job, error('canceled', 'Sprout request was canceled.'));
          else if (now >= job.deadline) settle(job, error('queue-timeout', 'Sprout request exceeded its waiting deadline.'));
          else { start(job); dispatched = true; }
        } finally { if (!dispatched) active.delete(job); }
      }
    } finally { draining = false; finishClose(); }
  }
  function expire(job) {
    if (job.settled || job.running) return;
    const remaining = job.deadline - performance.now();
    if (remaining > 0) { job.timer = setTimeout(() => expire(job), remaining); return; }
    removeWaiting(job); settle(job, error('queue-timeout', 'Sprout request exceeded its waiting deadline.')); drain();
  }
  function submit(input, requestOptions = {}) {
    let request, signal, reserved = false;
    const releaseReservation = () => { if (reserved) { reserved = false; preparing--; finishClose(); } };
    try {
      if (!requestOptions || typeof requestOptions !== 'object' || Array.isArray(requestOptions) || Object.keys(requestOptions).some(name => name !== 'signal')) throw new TypeError('request options accept only signal.');
      signal = requestOptions.signal;
      if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal.');
      if (state !== 'open') throw closedError();
      if (signal?.aborted) throw error('canceled', 'Sprout request was canceled.');
      if (active.size + waiting.length + preparing >= concurrency + maxQueued) throw error('queue-full', 'Sprout request queue is full.');
      preparing++; reserved = true;
      request = prepareRequest(input, profile, signal);
      if (state !== 'open') throw closedError();
    } catch (failure) { releaseReservation(); return Promise.reject(failure); }
    return new Promise((resolve, reject) => {
      const job = { request, signal, resolve, reject, controller: new AbortController(), settled: false, running: false };
      job.abort = () => {
        if (job.running) job.controller.abort();
        else { removeWaiting(job); settle(job, error('canceled', 'Sprout request was canceled.')); drain(); }
      };
      try {
        try { signal?.addEventListener('abort', job.abort, { once: true }); }
        catch (failure) { settle(job, failure); return; }
        let aborted;
        try { aborted = signal?.aborted; }
        catch (cause) { settle(job, new SproutError('Could not inspect request cancellation signal after subscription.', 'canceled', { cause, phase: 'queue-admission' })); return; }
        if (aborted) job.abort();
        if (job.settled) return;
        if (state !== 'open') { settle(job, closedError()); return; }
      } finally { releaseReservation(); }
      if (active.size < concurrency && !waiting.length) start(job);
      else {
        job.deadline = performance.now() + queueTimeoutMs; waiting.push(job);
        job.timer = setTimeout(() => expire(job), queueTimeoutMs); drain();
      }
    });
  }
  function close(closeOptions = {}) {
    if (closePromise) return closePromise;
    try {
      if (!closeOptions || typeof closeOptions !== 'object' || Array.isArray(closeOptions) || Object.keys(closeOptions).some(name => !['drain', 'timeoutMs'].includes(name))) throw new TypeError('close options accept drain and timeoutMs.');
      if (closeOptions.drain !== undefined && typeof closeOptions.drain !== 'boolean') throw new TypeError('drain must be true or false.');
      const timeoutMs = positive(closeOptions.timeoutMs, 5000, 'close timeoutMs');
      if (state === 'open') state = 'closing';
      closePromise = new Promise((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
      const cancel = () => { rejectWaiting(); for (const job of active) if (!job.quarantined) job.controller.abort(); finishClose(); };
      closeTimer = setTimeout(cancel, timeoutMs);
      if (closeOptions.drain === false || state === 'failed') cancel(); else { drain(); finishClose(); }
      return closePromise;
    } catch (failure) { return Promise.reject(failure); }
  }
  return Object.freeze({ run: submit, close, stats: () => Object.freeze({ state, active: active.size, queued: waiting.length, preparing, concurrency, maxQueued }) });
}

module.exports = { runSprout, createSproutQueue, SproutError };
