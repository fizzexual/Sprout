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
    def test_text_matches_native_representation(self):
        for text in ('"\\ud800"', '"\\udfff"', '"\\u0000"', '{"\\ud800":1}', '["\\u0000"]'):
            with self.subTest(text=text):
                with self.assertRaises(ValueError): decode(text)
        for value in ('\ud800', '\udfff', '\x00', {'\ud800': 1}, ['\x00']):
            with self.subTest(value=repr(value)), patch('sprout_host.subprocess.Popen') as launch:
                with self.assertRaises(ValueError): run('unused.sprout', value)
                launch.assert_not_called()
        self.assertEqual(decode('"\\ud83c\\udf31"'), '\U0001f331')
        self.assertEqual(decode(encode({'\U0001f331': '\U0001f331'})), {'\U0001f331': '\U0001f331'})
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
    def test_optional_encoding_cap_counts_exact_utf8_and_escaping(self):
        values = [None, True, False, -12, 1.25, -0.0,
                  {'🌱é': '\\"\b\f\n\r\t\x01\x1f\x7f🌱é'},
                  2**63 - 1, -(2**63), Decimal('-9.223372036854775808'),
                  b'\x00\xffa', bytearray(b'\x00\xff'),
                  [[], {}, {'same': ['🌱', Decimal('19.95'), b'hello']}]]
        for value in values:
            with self.subTest(value=repr(value)):
                wire = encode(value)
                maximum = len(wire.encode('utf-8'))
                self.assertEqual(encode(value, max_bytes=maximum), wire)
                with self.assertRaises(SproutError) as caught:
                    encode(value, max_bytes=maximum - 1)
                self.assertEqual(caught.exception.code, 'input-limit')
        with self.assertRaises(SproutError): encode(None, max_bytes=0)
        for invalid in (-1, True, 1.5):
            with self.assertRaises(ValueError): encode(None, max_bytes=invalid)
    def test_low_cap_stops_exponential_alias_expansion_before_json_or_launch(self):
        visits = []
        class CountingList(list):
            def __iter__(self):
                visits.append(True)
                if len(visits) > 128:
                    raise AssertionError('encoder expanded the shared DAG instead of enforcing its cap')
                return super().__iter__()
        value = CountingList([1])
        for _ in range(24): value = CountingList([value, value])
        with patch('sprout_host.subprocess.Popen') as launch, patch('sprout_host.json.dumps') as dumps:
            with self.assertRaises(SproutError) as caught:
                run('unused.sprout', value, max_input_bytes=64)
            self.assertEqual(caught.exception.code, 'input-limit')
            self.assertLess(len(visits), 128)
            self.assertGreater(len(visits), 0)
            launch.assert_not_called()
            dumps.assert_not_called()
        shared = {'leaf': [1, '🌱']}
        value = [shared, shared]
        wire = encode(value)
        self.assertEqual(encode(value, max_bytes=len(wire.encode('utf-8'))), wire)
    def test_request_cap_includes_newline_and_native_one_mib_ceiling(self):
        class RecordingInput(io.BytesIO):
            def close(self):
                self.sent = self.getvalue()
                super().close()
        for value in ['🌱é', {'x': '\\"\n'}, 2**63 - 1, Decimal('19.95'), b'\x00\xff']:
            with self.subTest(value=repr(value)):
                request = (encode(value) + '\n').encode('utf-8')
                pipe = RecordingInput()
                child = SimpleNamespace(stdin=pipe, stdout=io.BytesIO(b'null\n'), stderr=io.BytesIO(),
                                        poll=lambda: 0, wait=lambda timeout: 0)
                with patch('sprout_host.subprocess.Popen', return_value=child):
                    self.assertIsNone(run('unused.sprout', value, max_input_bytes=len(request)))
                self.assertEqual(pipe.sent, request)
                with patch('sprout_host.subprocess.Popen') as launch:
                    with self.assertRaises(SproutError) as caught:
                        run('unused.sprout', value, max_input_bytes=len(request) - 1)
                    self.assertEqual(caught.exception.code, 'input-limit')
                    launch.assert_not_called()
        with patch('sprout_host.subprocess.Popen') as launch:
            # The binary tag's hex alone is 1 MiB, before framing and tag syntax.
            with self.assertRaises(SproutError) as caught:
                run('unused.sprout', b'x' * (1024 * 512), max_input_bytes=2 * 1024 * 1024)
            self.assertEqual(caught.exception.code, 'input-limit')
            launch.assert_not_called()
    def test_already_canceled_request_does_not_traverse_input(self):
        event = threading.Event(); event.set()
        with patch('sprout_host.encode', side_effect=AssertionError('input was traversed')) as encoder, \
             patch('sprout_host.subprocess.Popen') as launch:
            with self.assertRaises(SproutError) as caught:
                run('unused.sprout', object(), cancel=event, max_input_bytes=1)
            self.assertEqual(caught.exception.code, 'canceled')
            encoder.assert_not_called()
            launch.assert_not_called()
    def test_large_decimal_coefficients_and_exponents_reject_before_formatting(self):
        class UnformattedDecimal(Decimal):
            def __format__(self, spec):
                raise AssertionError('invalid decimal was formatted before validation')
        for text in ['9' * 10000, '1E+100000', '1E-100000', '0E+100000',
                     '9223372036854775808', '-9223372036854775809']:
            with self.subTest(text=text[:40]):
                with self.assertRaisesRegex(ValueError, '64-bit coefficient'):
                    encode(UnformattedDecimal(text))
        for text in ['9223372036854775807', '-9223372036854775808',
                     '9.223372036854775807', '-9.223372036854775808', '-0', '0E+18']:
            value = Decimal(text)
            self.assertEqual(decode(encode(value)), value)
    def test_bounded_encoding_keeps_type_cycle_and_nesting_rejections(self):
        cycle = []; cycle.append(cycle)
        nested = 0
        for _ in range(129): nested = [nested]
        for value in [cycle, nested, {'bad': '\ud800'}, {'\x00': 1}, {1: 'wrong key'}]:
            with self.subTest(kind=type(value).__name__):
                with self.assertRaises((ValueError, TypeError)):
                    encode(value, max_bytes=4096)
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
    def test_native_request_exact_byte_boundary(self):
        data = {'🌱': [2**63 - 1, Decimal('19.95'), b'\x00\xff']}
        maximum = len((encode(data) + '\n').encode('utf-8'))
        self.assertEqual(self.call('show json_encode(json_decode(read_input()))\n', data,
                                   max_input_bytes=maximum), data)
        with self.assertRaises(SproutError) as caught:
            self.call('show json_encode(json_decode(read_input()))\n', data,
                      max_input_bytes=maximum - 1)
        self.assertEqual(caught.exception.code, 'input-limit')
    def test_protocol_and_sandbox(self):
        for source, code in [('show "debug"\nshow "{}"\n', "protocol"), ('show read("secret")\n', "runtime")]:
            with self.assertRaises(SproutError) as caught: self.call(source)
            self.assertEqual(caught.exception.code, code)
    def test_malformed_protocol_values_recover(self):
        for text in ('{"$sprout.decimal":"bad"}', '1e999', '[' * 129 + '0' + ']' * 129, '"\\ud800"', '"\\u0000"'):
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
