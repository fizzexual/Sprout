"""Portable post-open store I/O classification controls with ordinary valid data.

Builds the real interpreter without SQLite in a private temporary directory.
SPROUT_CC selects a compiler executable when cc/gcc/clang is not on PATH.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
TOGGLE = 'SPROUT_TEST_STORE_READ_FAULT'


class StoreReadFault(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get('SPROUT_CC') or shutil.which('cc') or shutil.which('gcc') or shutil.which('clang')
        if not compiler: raise RuntimeError('Store read verification requires a C compiler; set SPROUT_CC')
        cls.build = tempfile.TemporaryDirectory(prefix='sprout-store-read-fault-build-')
        cls.addClassCleanup(cls.build.cleanup)
        cls.binary = Path(cls.build.name) / ('fault-control.exe' if os.name == 'nt' else 'fault-control')
        command = [compiler, '-O0', '-Wall', '-I' + str(ROOT / 'src'), '-include',
                   str(ROOT / 'src/tests/fixtures/store_read_fault.h'), str(ROOT / 'src/sprout.c'),
                   '-o', str(cls.binary), '-lm']
        command += ['-lurlmon', '-Wl,--stack,67108864'] if os.name == 'nt' else ['-pthread']
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
        if result.returncode: raise RuntimeError('Test-only interpreter build failed:\n' + result.stderr[-6000:])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-store-read-fault-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'case.sprout'
        self.store = self.root / 'sprout.data.json'
        self.original = b'{"retained":{"value":17},"other":"keep"}\n'

    def baseline(self):
        self.store.write_bytes(self.original)
        return self.store.stat().st_mtime_ns

    def run_source(self, source, mode=None):
        self.source.write_text(source, encoding='utf-8')
        environment = os.environ.copy()
        environment.pop(TOGGLE, None)
        if mode is not None: environment[TOGGLE] = mode
        result = subprocess.run([str(self.binary), 'run', str(self.source), '--max-steps', '10000',
                                 '--timeout-ms', '2000'], cwd=self.root, env=environment,
                                capture_output=True, timeout=5)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr, 'A runtime failure is not an I/O rejection')
        self.assertGreaterEqual(result.returncode, 0)
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        return result

    def preserved(self, modification, extra=()):
        self.assertEqual(self.store.read_bytes(), self.original)
        self.assertEqual(self.store.stat().st_mtime_ns, modification)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), sorted(['case.sprout', 'sprout.data.json', *extra]))

    def recovered(self):
        result = self.run_source('remember("new", 99)\nshow json_encode(recall("retained"))\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'value': 17})
        self.assertEqual(json.loads(self.store.read_bytes()), {'retained': {'value': 17}, 'other': 'keep', 'new': 99})
        self.assertFalse(list(self.root.glob('sprout.data.json.tmp-*')))
        self.assertFalse((self.root / 'sprout.data.json.bak').exists())

    def test_normal_read_and_publication_keep_previous_keys(self):
        self.baseline()
        self.recovered()

    def test_absent_open_still_initializes_empty_with_each_fault_mode_enabled(self):
        for mode in ('read', 'seek', 'close'):
            with self.subTest(mode=mode):
                self.store.unlink(missing_ok=True)
                result = self.run_source('show json_encode([recall("missing"), forget("missing")])\n'
                                         'remember("new", 99)\nshow "created"\n', mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [b'[null,false]', b'created'])
                self.assertEqual(json.loads(self.store.read_bytes()), {'new': 99})
                self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['case.sprout', 'sprout.data.json'])

    def test_post_open_errors_report_io_preserve_and_recover(self):
        for mode in ('read', 'seek', 'close'):
            for operation in ('remember("new", 99)', 'recall("retained")', 'forget("retained")'):
                with self.subTest(mode=mode, operation=operation):
                    modification = self.baseline()
                    result = self.run_source('make kind = "no_error"\ntry:\n    ' + operation +
                                             '\ncaught error:\n    set kind = error.kind\nshow json_encode(kind)\n', mode)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, b'')
                    self.assertEqual(json.loads(result.stdout), 'io')
                    self.preserved(modification)
                    self.recovered()

    def test_uncaught_read_failure_exits_unsuccessfully_without_publishing(self):
        modification = self.baseline()
        result = self.run_source('remember("new", 99)\nshow "saved"\n', '1')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b"couldn't read sprout.data.json", result.stderr)
        self.preserved(modification)
        self.recovered()

    def test_closed_store_tracking_does_not_affect_other_file_reads(self):
        modification = self.baseline()
        (self.root / 'notes.txt').write_text('ordinary text', encoding='utf-8')
        result = self.run_source('make kind = "no_error"\ntry:\n    recall("retained")\n'
                                 'caught error:\n    set kind = error.kind\n'
                                 'show json_encode([kind, read("notes.txt")])\n', 'read')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['io', 'ordinary text'])
        self.preserved(modification, ['notes.txt'])
        self.recovered()


if __name__ == '__main__': unittest.main()
