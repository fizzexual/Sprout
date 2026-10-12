"""New credited-size/late-identity controls only; no real child or SDK invocation."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import hashlib
import io
import itertools
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import measure_workloads as m
import prepare_measurement as preparation
import export_measurement as exporter
import measurement_fixtures as fixtures
import measurement_sdk as sdk_driver


def info(size): return SimpleNamespace(st_size=size, st_mode=stat.S_IFREG)


class Stream(io.BytesIO):
    def __init__(self, value): super().__init__(value); self.read_total = 0
    def fileno(self): return 1234
    def read(self, count):
        value = super().read(count); self.read_total += len(value); return value


class CreditedInput(unittest.TestCase):
    def setUp(self):
        self.no_children = patch.object(m.subprocess, 'Popen', side_effect=AssertionError('Control attempted a real child'))
        self.spawn = self.no_children.start(); self.addCleanup(self.no_children.stop)

    def tearDown(self): self.spawn.assert_not_called()

    def test_inventory_uses_credited_sizes_and_rechecks_actual_total(self):
        files = {'first.py': hashlib.sha256(b'a'*32).hexdigest(), 'second.py': hashlib.sha256(b'b'*48).hexdigest()}
        streams = [Stream(b'a'*32), Stream(b'b'*48)]
        with patch.object(m, 'inventory_path', side_effect=lambda root, name: Path(name)), \
             patch.object(m, 'file_bound', side_effect=[32, 48, 32, 48]), \
             patch.object(Path, 'open', side_effect=streams), \
             patch.object(m.os, 'fstat', side_effect=[info(32), info(32), info(48), info(48)]):
            self.assertEqual(m.verify_inventory(Path('snapshot'), files), 80)
        self.assertEqual([value.read_total for value in streams], [32, 48])
        # The second stat now observes growth in the first previously credited file.
        with patch.object(m, 'inventory_path', side_effect=lambda root, name: Path(name)), \
             patch.object(Path, 'stat', side_effect=[info(32), info(48), info(33)]), \
             patch.object(Path, 'open', side_effect=AssertionError('Uncredited growth read')) as opened, \
             patch.object(m.hashlib, 'sha256', side_effect=AssertionError('Hasher constructed before rejected credit')) as hashed:
            with self.assertRaises(m.ContractError) as caught: m.verify_inventory(Path('snapshot'), files)
            self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called(); hashed.assert_not_called()
        # Growth visible only after opening still fails before creating/updating the hasher.
        empty = Stream(b'x'*33)
        with patch.object(Path, 'stat', return_value=info(32)), patch.object(Path, 'open', return_value=empty), \
             patch.object(m.os, 'fstat', return_value=info(33)), \
             patch.object(m.hashlib, 'sha256', side_effect=AssertionError('Opened growth hashed')) as hashed:
            with self.assertRaises(m.ContractError) as caught: m.bounded_sha(Path('first.py'), 32, expected_size=32)
            self.assertEqual(caught.exception.code, 'input_changed'); hashed.assert_not_called()
        self.assertEqual(empty.read_total, 0)

    def test_late_source_loaded_helper_and_host_hashes_are_stream_bounded(self):
        for maximum in [None, m.INPUT_BOUNDS['native_compiler_bytes'], m.INPUT_BOUNDS['host_executable_bytes']]:
            effective = m.INPUT_BOUNDS['source_file_bytes'] if maximum is None else maximum
            with self.subTest(maximum=effective), patch.object(Path, 'stat', return_value=info(effective+1)), \
                 patch.object(Path, 'open', side_effect=AssertionError('Late identity exceeded cap')) as opened:
                with self.assertRaises(m.ContractError) as caught: m.sha(Path('identity.bin'), maximum)
                self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called()
        stream = Stream(b'x'*64)
        with patch.object(Path, 'stat', return_value=info(64)), patch.object(Path, 'open', return_value=stream), \
             patch.object(m.os, 'fstat', side_effect=[info(64), info(64)]):
            self.assertEqual(m.sha(Path('small.bin'), 64), hashlib.sha256(b'x'*64).hexdigest())
        self.assertEqual(stream.read_total, 64)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            modules = [(m, 'measure_workloads.py'), (fixtures, 'measurement_fixtures.py'), (sdk_driver, 'measurement_sdk.py')]
            manifest = {'files': {'controller/' + name: 'a'*64 for _, name in modules}}
            with patch.object(m, '__file__', str(root/'controller/measure_workloads.py')), \
                 patch.object(Path, 'stat', return_value=info(m.INPUT_BOUNDS['source_file_bytes']+1)), \
                 patch.object(Path, 'open', side_effect=AssertionError('Loaded controller growth read')) as opened:
                with self.assertRaises(m.ContractError) as caught: m.executing_controller(root, manifest)
                self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called()
        with patch.dict(sys.modules), patch.object(Path, 'stat', return_value=info(m.INPUT_BOUNDS['source_file_bytes']+1)), \
             patch.object(Path, 'open', side_effect=AssertionError('Late SDK source read')) as opened:
            with self.assertRaises(m.ContractError) as caught: sdk_driver.load_sdk(Path('snapshot'))
            self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called()

    def test_collect_and_raw_reads_respect_remaining_and_declared_credit(self):
        item = {'name': 'ordinary.bin', 'bytes': 16, 'sha256': hashlib.sha256(b'x'*16).hexdigest()}
        with patch.object(m, 'inventory_path', return_value=Path('ordinary.bin')):
            for call in [lambda: preparation.collect_input(Path('ordinary.bin'), 32, 15),
                         lambda: exporter.read_artifact(Path('report'), item, 15),
                         lambda: exporter.read_artifact(Path('report'), item, 16)]:
                with patch.object(Path, 'stat', return_value=info(17)), \
                     patch.object(Path, 'open', side_effect=AssertionError('Uncredited collect/read')) as opened, \
                     patch.object(m.hashlib, 'sha256', side_effect=AssertionError('Over-credit input hashed')) as hashed:
                    with self.assertRaises(m.ContractError): call()
                    opened.assert_not_called(); hashed.assert_not_called()
            for raw in [False, True]:
                stream = Stream(b'x'*16)
                with patch.object(Path, 'stat', return_value=info(16)), patch.object(Path, 'open', return_value=stream), \
                     patch.object(m.os, 'fstat', side_effect=[info(16), info(16)]):
                    value = exporter.read_artifact(Path('report'), item, 16) if raw else preparation.collect_input(Path('ordinary.bin'), 32, 16)[1]
                    self.assertEqual(value, b'x'*16)
                self.assertEqual(stream.read_total, 16)

    def test_late_identity_failure_preserves_cleanup_and_original_sdk_error(self):
        children = []
        class FakeOwned:
            def __init__(self, argv, cwd, tree=False):
                self.child = SimpleNamespace(pid=42); self.closed = 0; self.markers = []
                self.stdout = SimpleNamespace(raw=bytearray()); self.stderr = SimpleNamespace(raw=bytearray())
                children.append(self)
            def marker(self, value, seconds): self.markers.append(value)
            def close(self):
                self.closed += 1; return {'confirmed': True, 'direct_reaped': True}
        budget = m.Budget(clock=m.Clock(read=itertools.count(100).__next__))
        with patch.object(m, 'host_tool_path', return_value='selected-node.bin'), patch.object(m, 'OwnedProcess', FakeOwned), \
             patch.object(Path, 'stat', return_value=info(m.INPUT_BOUNDS['host_executable_bytes']+1)), \
             patch.object(Path, 'open', side_effect=AssertionError('Late Node identity read')) as opened:
            with self.assertRaises(m.SampleError) as caught: m.NodeSuite(Path('snapshot'), budget)
            self.assertEqual(caught.exception.code, 'input_size'); self.assertIsInstance(caught.exception.__cause__, m.ContractError)
            self.assertEqual(caught.exception.observation['cleanup'], {'confirmed': True, 'direct_reaped': True}); opened.assert_not_called()
        self.assertEqual(len(children), 1); self.assertEqual(children[0].closed, 1); self.assertEqual(children[0].markers, [b'READY'])
        original = m.ContractError('fixture_sdk_failure', 'Ordinary fake SDK failure')
        def fail(program, request, **options): raise original
        suite = object.__new__(m.PythonSuite); suite.root = Path('snapshot'); suite.runtime = Path('runtime.bin')
        suite.budget = m.Budget(clock=m.Clock(read=itertools.count(100).__next__))
        suite.sdk = SimpleNamespace(run=fail); suite.data = {'Hmin': {'typed_input': {}, 'sandbox': True}}
        with patch.object(Path, 'stat', return_value=info(m.INPUT_BOUNDS['source_file_bytes']+1)), \
             patch.object(Path, 'open', side_effect=AssertionError('Late Python source identity read')) as opened:
            with self.assertRaises(m.SampleError) as caught: suite.call('Hmin')
            self.assertEqual(caught.exception.code, 'fixture_sdk_failure'); self.assertIs(caught.exception.__cause__, original)
            self.assertEqual(caught.exception.observation['primary_error_type'], 'ContractError')
            self.assertIsNone(caught.exception.observation['program_sha256'])
            self.assertEqual(caught.exception.observation['program_identity_error']['code'], 'input_size'); opened.assert_not_called()


if __name__ == '__main__': unittest.main()
