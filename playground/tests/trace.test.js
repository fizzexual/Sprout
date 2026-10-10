const assert = require('node:assert/strict');
const { test } = require('node:test');
const SproutTrace = require('../web/trace');
const events = [{line:1,variables:{}},{line:3,variables:{x:'1'}},{line:3,variables:{x:'2'}},{line:5,variables:{x:'3'}}];

test('recorded stepping moves backward and forward without mutating captured state', () => {
  const trace = new SproutTrace(); trace.record(events, 'code', 'file.sprout');
  assert.equal(trace.move(1).variables.x, '1'); assert.equal(trace.move(1).variables.x, '2');
  assert.equal(trace.move(-1).variables.x, '1'); assert.equal(trace.seek(999).line, 5);
  assert.equal(trace.seek(-5).line, 1); assert.equal(events[1].variables.x, '1');
});

test('breakpoint seek follows chronological steps including repeated lines', () => {
  const trace = new SproutTrace(); trace.record(events, 'code', 'file.sprout');
  trace.toggleBreakpoint(3);
  assert.equal(trace.nextBreakpoint().variables.x, '1');
  assert.equal(trace.nextBreakpoint().variables.x, '2');
  assert.equal(trace.nextBreakpoint(), null); assert.equal(trace.cursor, 2);
  trace.toggleBreakpoint(3); assert.equal(trace.breakpoints.size, 0);
});

test('source changes block playback and rerecording refreshes the index', () => {
  const trace = new SproutTrace();
  assert.equal(trace.invalidate('code', 'file.sprout'), false);
  trace.record(events, 'code', 'file.sprout');
  assert.equal(trace.invalidate('new code', 'file.sprout'), true); assert.equal(trace.move(1), null);
  trace.record(events, 'new code', 'file.sprout', true);
  assert.equal(trace.stale, false); assert.equal(trace.truncated, true); assert.equal(trace.move(1).line, 3);
  assert.equal(trace.invalidate('new code', 'other.sprout'), true);
});

test('partial streamed recordings can be inspected after execution stops', () => {
  const trace = new SproutTrace(); trace.record([], 'code', 'file.sprout');
  trace.append(events.slice(0, 2)); assert.equal(trace.cursor, 0); assert.equal(trace.move(1).line, 3);
  trace.append(events.slice(2)); assert.equal(trace.cursor, 1); assert.equal(trace.events.length, 4);
});
