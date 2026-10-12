'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runSprout, createSproutQueue } = require('..');

test('pure API responses preserve exact tags through standalone and queued Node workers',
  { skip: !process.env.SPROUT_COMMAND, timeout: 10000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sprout-api-node-'));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const library = path.resolve(__dirname, '../../../lib/api.sprout').replaceAll('\\', '/');
    const program = path.join(directory, 'response.sprout');
    fs.writeFileSync(program, `use ${JSON.stringify(library)}\nshow builtin::json_encode(api.result(builtin::integer(200), {
      id: builtin::integer("9223372036854775807"), money: builtin::decimal("0.10"),
      small: builtin::integer(7), text: "café🌱"
    }, {"X-Preview": "yes"}).response)\n`);
    const options = { command: process.env.SPROUT_COMMAND, sandbox: false,
      timeoutMs: 3000, runtimeTimeoutMs: 2500, maxSteps: 5000000, maxOutputBytes: 65536 };
    const expected = { status: 200, headers: { 'X-Preview': 'yes' }, body: {
      id: { '$sprout.integer': '9223372036854775807' }, money: { '$sprout.decimal': '0.10' },
      small: { '$sprout.integer': '7' }, text: 'café🌱'
    } };
    assert.deepEqual(await runSprout(program, {}, options), expected);
    const queue = createSproutQueue(program, { ...options, concurrency: 2, maxQueued: 1 });
    t.after(() => queue.close({ drain: false }));
    assert.deepEqual(await Promise.all([queue.run({}), queue.run({})]), [expected, expected]);
    await queue.close();
    assert.equal(queue.stats().active, 0);
  });

test('contacts preview keeps literal route and safe error contracts through a real Node worker',
  { skip: !process.env.SPROUT_COMMAND, timeout: 10000 }, async () => {
    const program = path.resolve(__dirname, '../../../examples/services/contacts_preview.sprout');
    const options = { command: process.env.SPROUT_COMMAND, sandbox: false,
      timeoutMs: 3000, runtimeTimeoutMs: 2500, maxSteps: 5000000, maxOutputBytes: 65536 };
    const envelope = (method, body = null) => ({ method, path: '/contacts/preview', query: {}, body });
    const described = await runSprout(program, envelope('GET'), options);
    assert.deepEqual(described.body, { mode: 'preview', fields: ['name', 'email'], persisted: false });
    const contact = { name: 'café🌱', email: 'synthetic@example.test' };
    const previewed = await runSprout(program, envelope('POST', contact), options);
    assert.equal(previewed.status, 200);
    assert.deepEqual(previewed.body, { valid: true, persisted: false, contact });
    const refused = await runSprout(program, envelope('PATCH'), options);
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.Allow, 'GET, POST');
    assert.equal(refused.headers['Cache-Control'], 'no-store');
    const invalid = await runSprout(program, envelope('POST', { ...contact, secret: 'private synthetic marker' }), options);
    assert.equal(invalid.status, 400);
    assert.ok(!JSON.stringify(invalid).includes('private synthetic marker'));
  });
