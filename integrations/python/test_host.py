import os
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from decimal import Decimal
from sprout_host import run, encode, decode, SproutError, MAX_JSON_NESTING

BINARY = os.environ.get("SPROUT_COMMAND")

class CodecTests(unittest.TestCase):
    def test_exact_boundary(self):
        data = {"big": 2**63 - 1, "small": -(2**63), "money": Decimal("19.95"), "bytes": b"a\x00b"}
        self.assertEqual(decode(encode(data)), data)
    def test_invalid_input(self):
        for data in (float("nan"), 2**63, Decimal("0.0000000000000000001"), {1: "x"}):
            with self.assertRaises((ValueError, TypeError)):
                encode(data)
        data = []; data.append(data)
        with self.assertRaises(ValueError): encode(data)
    def test_invalid_response(self):
        for text in ('{"a":1,"a":2}', 'NaN', '1e999', '{"$sprout.decimal":"bad"}', '{"$sprout.decimal":23}', '{"$sprout.integer":"1_000"}', '{"$sprout.integer":"9223372036854775808"}', '{"$sprout.bytes":"a x"}'):
            with self.assertRaises((ValueError, TypeError)): decode(text)
    def test_nesting_boundary_and_quoted_brackets(self):
        value = 0
        for _ in range(MAX_JSON_NESTING): value = [value]
        text = '[' * MAX_JSON_NESTING + '0' + ']' * MAX_JSON_NESTING
        self.assertEqual(encode(value), text)
        self.assertEqual(encode(decode(text)), text)
        with self.assertRaisesRegex(ValueError, 'nesting'): encode([value])
        with self.assertRaisesRegex(ValueError, 'nesting'): decode('[' + text + ']')
        quoted = {'text': '\\"' + '[{' * 200 + '\\' + '}]' * 200}
        self.assertEqual(decode(encode(quoted)), quoted)
        self.assertEqual(decode(b'[1,2]'), [1, 2])
    def test_exact_tags_count_toward_wire_nesting(self):
        for leaf in (2**63 - 1, Decimal('1.25'), b'hello'):
            with self.subTest(leaf=leaf):
                value = leaf
                for _ in range(MAX_JSON_NESTING - 1): value = [value]
                self.assertEqual(encode(decode(encode(value))), encode(value))
                with self.assertRaisesRegex(ValueError, 'nesting'): encode([value])
                with self.assertRaisesRegex(ValueError, 'nesting'): decode('[' + encode(value) + ']')
    def test_deep_small_input_rejects_before_launch(self):
        with self.assertRaisesRegex(ValueError, 'nesting'):
            decode('[' * 3000 + '0' + ']' * 3000)
        value = 0
        for _ in range(3000): value = [value]
        with patch('sprout_host.subprocess.Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'nesting'): run('unused.sprout', value)
            launch.assert_not_called()
    def test_parser_recursion_is_normalized(self):
        with patch('sprout_host.json.loads', side_effect=RecursionError('parser recursion')):
            with self.assertRaisesRegex(ValueError, 'nested too deeply'): decode('[]')
    def test_broken_stdin_close_has_no_thread_exception(self):
        class BrokenPipe:
            def __init__(self, fail_write): self.fail_write, self.closes = fail_write, 0
            def write(self, data):
                if self.fail_write: raise BrokenPipeError('worker closed stdin')
                return len(data)
            def close(self):
                self.closes += 1
                raise BrokenPipeError('flush after worker exit')
        for fail_write in (False, True):
            with self.subTest(fail_write=fail_write):
                pipe = BrokenPipe(fail_write)
                child = SimpleNamespace(stdin=pipe, stdout=io.BytesIO(b'42\n'), stderr=io.BytesIO(),
                                        poll=lambda: 0, wait=lambda timeout: 0)
                thread_errors = []
                with patch('sprout_host.subprocess.Popen', return_value=child), \
                     patch('threading.excepthook', side_effect=thread_errors.append):
                    self.assertEqual(run('unused.sprout', None), 42)
                self.assertEqual(thread_errors, [])
                self.assertEqual(pipe.closes, 1)

@unittest.skipUnless(BINARY, "set SPROUT_COMMAND to a built runtime")
class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "worker.sprout"
    def tearDown(self): self.temp.cleanup()
    def call(self, source, data=None, **kwargs):
        self.path.write_text(source, encoding="utf-8")
        return run(self.path, data, command=BINARY, **kwargs)
    def test_request_exact_types(self):
        data = {"money": Decimal("19.95"), "bytes": b"x\x00y", "big": 2**63 - 1}
        self.assertEqual(self.call('show json_encode(json_decode(read_input()))\n', data), data)
    def test_protocol_and_sandbox(self):
        for source, code in [('show "debug"\nshow "{}"\n', "protocol"), ('show read("secret")\n', "runtime")]:
            with self.assertRaises(SproutError) as caught: self.call(source)
            self.assertEqual(caught.exception.code, code)
    def test_malformed_protocol_values_recover(self):
        for text in ('{"$sprout.decimal":"bad"}', '1e999', '[' * 129 + '0' + ']' * 129):
            with self.subTest(text=text[:40]):
                with self.assertRaises(SproutError) as caught:
                    self.call('show ' + json.dumps(text) + '\n')
                self.assertEqual(caught.exception.code, 'protocol')
        self.assertEqual(self.call('show json_encode(42)\n'), 42)
    def test_limits_recover(self):
        with self.assertRaises(SproutError) as caught:
            self.call('repeat while yes:\n    show "xxxxxxxxxxxxxxxx"\n', max_output_bytes=1000, max_steps=10000000)
        self.assertEqual(caught.exception.code, "stdout-limit")
        self.assertEqual(self.call('show json_encode(42)\n'), 42)
    def test_host_cancel_and_timeout(self):
        source = 'repeat while yes:\n    make x = 1\n'
        event = threading.Event(); timer = threading.Timer(.05, event.set); timer.start()
        with self.assertRaises(SproutError) as caught:
            self.call(source, cancel=event, max_steps=1000000000)
        timer.join(); self.assertEqual(caught.exception.code, "canceled")
        with self.assertRaises(SproutError) as caught:
            self.call(source, timeout_ms=50, runtime_timeout_ms=10000, max_steps=1000000000)
        self.assertEqual(caught.exception.code, "timeout")
    def test_many_isolated_calls(self):
        for i in range(12):
            self.assertEqual(self.call('make x = json_decode(read_input())\nshow json_encode(x + 1)\n', i), i + 1)

if __name__ == "__main__": unittest.main()
