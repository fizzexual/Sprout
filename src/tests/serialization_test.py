"""Bounded native JSON/persistence integrity regressions.

Fixtures use private temporary stores. Shared values keep the oversized-output
cases small in memory; no large output is written or captured on success.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              os.environ.get('SPROUT_BINARY', Path(__file__).parents[1] /
                             ('sprout.exe' if os.name == 'nt' else 'sprout'))).resolve()


class Serialization(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-serialization-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'case.sprout'
        self.store = self.root / 'sprout.data.json'

    def run_source(self, source, *, steps=1000000, sandbox=True):
        self.source.write_text(source, encoding='utf-8')
        flags = ['--max-steps', str(steps), '--timeout-ms', '10000']
        if sandbox:
            flags.append('--sandbox')
        result = subprocess.run([str(BINARY), 'run', str(self.source), *flags],
                                cwd=self.root, capture_output=True, timeout=15)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer',
                       b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr,
                             'A sanitizer failure is not a valid data rejection')
        self.assertGreaterEqual(result.returncode, 0, 'Interpreter crashed or was killed')
        if os.name == 'nt':
            self.assertLess(result.returncode, 0x80000000, 'Interpreter exited with NTSTATUS')
        return result

    def value(self, source, **options):
        result = self.run_source(source, **options)
        self.assertEqual(result.returncode, 0, repr(result.stdout + result.stderr))
        return json.loads(result.stdout)

    def baseline(self):
        self.store.write_bytes(b'{"value":17,"untouched":{"tag":"original"}}\n')
        return self.store.read_bytes(), self.store.stat().st_mtime_ns

    def preserved(self, snapshot):
        self.assertEqual(self.store.read_bytes(), snapshot[0])
        self.assertEqual(self.store.stat().st_mtime_ns, snapshot[1])
        self.assertEqual(sorted(path.name for path in self.root.iterdir()),
                         ['case.sprout', 'sprout.data.json'])

    def rejection(self, setup, operation='json_encode(value)', **options):
        source = (setup + '\nmake rejected = "not rejected"\ntry:\n    ' + operation + '\n'
                  'caught problem:\n    set rejected = problem.kind\n'
                  'show json_encode({kind: rejected})\n')
        return self.value(source, **options)['kind']

    def test_two_hundred_containers_round_trip_without_losing_a_scalar(self):
        source = ('make value = 7\nrepeat 200 times:\n    set value = [value]\n'
                  'make decoded = json_decode(json_encode(value))\n'
                  'repeat 200 times:\n    set decoded = decoded[0]\n'
                  'show json_encode(decoded)\n')
        self.assertEqual(self.value(source), 7)

    def test_two_hundred_one_containers_raise_a_catchable_data_error(self):
        self.assertEqual(self.rejection('make value = 7\nrepeat 201 times:\n    set value = [value]'), 'data')

    def test_exact_wire_tags_count_as_containers_and_round_trip(self):
        source = ('make leaf = [integer("9223372036854775807"), decimal("-9.223372036854775808"), '
                  'bytes([0, 255, 65])]\nmake value = leaf\n'
                  'repeat 198 times:\n    set value = [value]\n'
                  'make decoded = json_decode(json_encode(value))\n'
                  'repeat 198 times:\n    set decoded = decoded[0]\n'
                  'show json_encode({equal: decoded == leaf, values: decoded})\n')
        self.assertEqual(self.value(source), {'equal': True, 'values': [
            {'$sprout.integer': '9223372036854775807'},
            {'$sprout.decimal': '-9.223372036854775808'}, {'$sprout.bytes': '00ff41'}]})
        self.assertEqual(self.rejection('make value = integer("1")\nrepeat 200 times:\n    set value = [value]'), 'data')

    def test_cyclic_list_map_and_mixed_graphs_are_rejected(self):
        for setup in ['make value = []\nadd(value, value)',
                      'make value = {}\nset value["self"] = value',
                      'make value = {}\nmake inner = [value]\nset value["back"] = inner']:
            with self.subTest(setup=setup):
                self.assertEqual(self.rejection(setup), 'data')

    def test_shared_acyclic_values_are_not_mistaken_for_cycles(self):
        source = ('make shared = {price: decimal("19.95"), bytes: bytes([0, 1])}\n'
                  'make value = [shared, shared, {again: shared}]\n'
                  'show json_encode(json_decode(json_encode(value)))\n')
        leaf = {'price': {'$sprout.decimal': '19.95'}, 'bytes': {'$sprout.bytes': '0001'}}
        self.assertEqual(self.value(source), [leaf, leaf, {'again': leaf}])

    def test_serialization_can_recover_after_a_caught_rejection(self):
        source = ('make cycle = []\nadd(cycle, cycle)\nrepeat 3 times:\n'
                  '    try:\n        json_encode(cycle)\n    caught problem:\n        skip\n'
                  'show json_encode({healthy: [1, 2, 3]})\n')
        self.assertEqual(self.value(source), {'healthy': [1, 2, 3]})

    def test_store_wrapper_accepts_one_hundred_ninety_nine_containers(self):
        source = ('make value = integer("9223372036854775807")\n'
                  'repeat 198 times:\n    set value = [value]\nremember("exact", value)\n'
                  'make recalled = recall("exact")\nrepeat 198 times:\n    set recalled = recalled[0]\n'
                  'show json_encode(recalled)\n')
        self.assertEqual(self.value(source, sandbox=False), {'$sprout.integer': '9223372036854775807'})
        source = ('make value = 7\nrepeat 199 times:\n    set value = [value]\n'
                  'remember("scalar", value)\nmake recalled = recall("scalar")\n'
                  'repeat 199 times:\n    set recalled = recalled[0]\nshow json_encode(recalled)\n')
        self.assertEqual(self.value(source, sandbox=False), 7)

    def test_overdepth_updates_preserve_the_existing_store(self):
        snapshot = self.baseline()
        self.assertEqual(self.rejection('make value = 7\nrepeat 200 times:\n    set value = [value]',
                                        'remember("value", value)', sandbox=False), 'data')
        self.preserved(snapshot)

    def test_cyclic_updates_preserve_the_existing_store(self):
        for setup in ['make value = []\nadd(value, value)',
                      'make value = {}\nset value["self"] = value']:
            with self.subTest(setup=setup):
                snapshot = self.baseline()
                self.assertEqual(self.rejection(setup, 'remember("value", value)', sandbox=False), 'data')
                self.preserved(snapshot)

    def test_wire_size_cap_rejects_small_shared_graphs_before_output(self):
        for leaf, repeats in [('"x" * 131072', 512), ('char(1) * 65536', 171)]:
            with self.subTest(leaf=leaf):
                self.assertEqual(self.rejection('make shared = ' + leaf + '\nmake value = [shared] * ' + str(repeats)), 'limit')

    def test_exact_wire_byte_limit_accepts_sixty_four_mib(self):
        # 16,384 quoted 4,093-byte leaves plus separators occupy 64 MiB + 1;
        # shortening just the final leaf puts the exact wire length on the cap.
        # Only the encoded length is printed, keeping captured output tiny.
        source = ('make shared = "x" * 4093\nmake value = [shared] * 16384\n'
                  'set value[-1] = "x" * 4092\nshow length(json_encode(value))\n')
        self.assertEqual(self.value(source), 64 * 1024 * 1024)
        self.assertEqual(self.rejection('make shared = "x" * 4093\nmake value = [shared] * 16384'), 'limit')

    def test_oversized_shared_update_preserves_the_existing_store(self):
        snapshot = self.baseline()
        self.assertEqual(self.rejection('make shared = "x" * 131072\nmake value = [shared] * 512',
                                        'remember("value", value)', sandbox=False), 'limit')
        self.preserved(snapshot)

    def test_step_budget_interrupts_preflight_before_store_publish(self):
        snapshot = self.baseline()
        source = ('make value = 7\nrepeat 16 times:\n    set value = [value, value]\n'
                  'try:\n    remember("value", value)\ncaught problem:\n    show "budget was caught"\n'
                  'show "store was published"\n')
        result = self.run_source(source, steps=1000, sandbox=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'--max-steps', result.stderr.lower())
        self.preserved(snapshot)


if __name__ == '__main__':
    unittest.main()
