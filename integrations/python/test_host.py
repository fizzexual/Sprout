import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from decimal import Decimal
from sprout_host import run, encode, decode, SproutError

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
