"""Changed-only pure read-count controls. No child/SDK/compiler/workload execution."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import hashlib
import io
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import measure_workloads as m
import prepare_measurement as preparation
import export_measurement as exporter
import measurement_fixtures as w


def info(size, mode=stat.S_IFREG): return SimpleNamespace(st_size=size, st_mode=mode)


class Stream(io.BytesIO):
    def __init__(self, value): super().__init__(value); self.requests = []; self.read_total = 0
    def fileno(self): return 1234
    def read(self, count):
        self.requests.append(count); value = super().read(count); self.read_total += len(value); return value


class Bounds(unittest.TestCase):
    def test_oversized_selector_and_wrong_pin_read_zero_bytes(self):
        with patch.object(Path, 'stat', return_value=info(1048576)), patch.object(Path, 'open', side_effect=AssertionError('oversized input read')) as opened:
            with self.assertRaises(m.ContractError) as caught: preparation.load_selection(Path('selector.json'), 'a'*64)
            self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called()

    def test_manifest_scope_report_pin_paths_reject_before_reading(self):
        cases = [lambda: m.verify_manifest(Path('snapshot'), 'a'*64),
                 lambda: m.reviewed_scope(Path('snapshot'), 'a'*64, Path('scope.json'), 'b'*64, Path('out')),
                 lambda: exporter.verify_report(Path('report'), 'a'*64, Path('snapshot'), 'b'*64, Path('review.json'), 'c'*64)]
        for index, call in enumerate(cases):
            with self.subTest(index=index), patch.object(Path, 'stat', return_value=info(3000000)), patch.object(Path, 'open', side_effect=AssertionError('oversized metadata read')) as opened:
                if index == 1:
                    with patch.object(m, 'verify_manifest', return_value={}):
                        with self.assertRaises(m.ContractError) as caught: call()
                else:
                    with self.assertRaises(m.ContractError) as caught: call()
                self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called()

    def test_review_pin_also_uses_bounded_reader(self):
        original = m.pinned_json
        def pinned(path, pin, maximum=1048576):
            if Path(path).name == 'review.json': return original(path, pin, maximum)
            return {} if Path(path).name == 'report.json' else {'schema': 'sprout.finite-measurement-snapshot.v2'}
        modelsha = m.sha(Path(w.__file__))
        with patch.object(m, 'pinned_json', side_effect=pinned), patch.object(m, 'sha', return_value=modelsha), patch.object(m, 'verify_manifest', return_value={'files': {'controller/measurement_fixtures.py': modelsha}}), \
             patch.object(Path, 'stat', return_value=info(2000000)), patch.object(Path, 'open', side_effect=AssertionError('oversized review read')) as opened:
            with self.assertRaises(m.ContractError) as caught:
                exporter.verify_report(Path('report'), 'a'*64, Path('snapshot'), 'b'*64, Path('review.json'), 'c'*64)
            self.assertEqual(caught.exception.code, 'input_size'); opened.assert_not_called()

    def test_exact_boundary_stream_and_growth_never_read_beyond_cap(self):
        cap = 65536
        for growth in [False, True]:
            stream = Stream(b'x' * (cap + 1 if growth else cap))
            after = cap + 1 if growth else cap
            with self.subTest(growth=growth), patch.object(Path, 'stat', return_value=info(cap)), patch.object(Path, 'open', return_value=stream), \
                 patch.object(m.os, 'fstat', side_effect=[info(cap), info(after)]):
                if growth:
                    with self.assertRaises(m.ContractError) as caught: m.bounded_sha(Path('input.bin'), cap)
                    self.assertEqual(caught.exception.code, 'input_changed')
                else: self.assertEqual(m.bounded_sha(Path('input.bin'), cap), hashlib.sha256(b'x'*cap).hexdigest())
            self.assertEqual(stream.read_total, cap); self.assertEqual(stream.requests, [cap])

    def test_directory_fifo_and_boolean_limit_rejected_before_open(self):
        for size, mode, cap in [(0, stat.S_IFDIR, 64), (0, stat.S_IFIFO, 64), (0, stat.S_IFREG, True)]:
            with self.subTest(mode=mode, cap=cap), patch.object(Path, 'stat', return_value=info(size, mode)), patch.object(Path, 'open', side_effect=AssertionError('nonregular read')) as opened:
                with self.assertRaises(m.ContractError): m.bounded_sha(Path('input'), cap)
                opened.assert_not_called()

    def test_inventory_aggregate_checked_before_any_file_data_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); files = {}
            for index in range(9):
                name = f'input{index}.py'; (root / name).write_bytes(b'ordinary bytes'); files[name] = 'a'*64
            manifest = {'schema': 'sprout.finite-measurement-snapshot.v2', 'profile': m.PROFILE, 'files': files}
            with patch.object(m, 'pinned_json', return_value=manifest), patch.object(m, 'file_bound', return_value=33554432), \
                 patch.object(m, 'bounded_sha', side_effect=AssertionError('hashed before aggregate check')) as hashed:
                with self.assertRaises(m.ContractError) as caught: m.verify_manifest(root, 'a'*64)
                self.assertEqual(caught.exception.code, 'input_size'); hashed.assert_not_called()


if __name__ == '__main__': unittest.main()
