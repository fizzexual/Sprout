"""Ordinary local store read/write failure preservation and recovery checks."""
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


class StorePublication(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-store-publication-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'case.sprout'
        self.store = self.root / 'sprout.data.json'
        self.original = b'{"retained":{"value":17},"other":"keep"}\n'

    def baseline(self):
        self.store.write_bytes(self.original)
        return self.store.stat().st_mtime_ns

    def run_source(self, source):
        self.source.write_text(source, encoding='utf-8')
        result = subprocess.run([str(BINARY), 'run', str(self.source), '--max-steps', '10000',
                                 '--timeout-ms', '2000'], cwd=self.root, capture_output=True, timeout=5)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer',
                       b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr, 'A runtime crash is not an I/O rejection')
        self.assertGreaterEqual(result.returncode, 0, 'Interpreter was killed')
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000, 'Interpreter exited with NTSTATUS')
        return result

    def caught(self, operation):
        result = self.run_source('make kind = "no_error"\ntry:\n    ' + operation +
                                 '\ncaught error:\n    set kind = error.kind\nshow json_encode(kind)\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), 'io')

    def preserved(self, modification):
        self.assertEqual(self.store.read_bytes(), self.original)
        self.assertEqual(self.store.stat().st_mtime_ns, modification)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['case.sprout', 'sprout.data.json'])

    def recovered(self):
        result = self.run_source('remember("new", 99)\nshow json_encode(recall("retained"))\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'value': 17})
        self.assertEqual(json.loads(self.store.read_bytes()), {'retained': {'value': 17}, 'other': 'keep', 'new': 99})
        self.assertFalse(list(self.root.glob('sprout.data.json.tmp-*')))

    def test_missing_store_is_empty_and_can_be_created(self):
        result = self.run_source('show json_encode([recall("missing"), forget("missing")])\n'
                                 'remember("first", 42)\nshow json_encode(recall("first"))\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], [[None, False], 42])
        self.assertEqual(json.loads(self.store.read_bytes()), {'first': 42})
        self.assertFalse(list(self.root.glob('sprout.data.json.tmp-*')))

    def test_successful_updates_forget_and_legacy_reads_keep_ordinary_values(self):
        self.baseline()
        result = self.run_source('remember("new", "🌱 café")\nforget("other")\n'
                                 'write("notes.txt", "plain UTF-8 🌱")\n'
                                 'show json_encode([recall("retained"), recall("new"), read("notes.txt")])\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{'value': 17}, '🌱 café', 'plain UTF-8 🌱'])
        self.assertEqual(json.loads(self.store.read_bytes()), {'retained': {'value': 17}, 'new': '🌱 café'})
        self.assertFalse(list(self.root.glob('sprout.data.json.tmp-*')))

    def windows_api(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
        return ctypes, kernel

    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing contract')
    def test_read_sharing_failure_preserves_store_for_all_operations_and_recovers(self):
        ctypes, kernel = self.windows_api()
        for operation in ('remember("new", 99)', 'recall("retained")', 'forget("retained")'):
            with self.subTest(operation=operation):
                modification = self.baseline()
                # A normal reader permits deletion but denies another read open.
                handle = kernel.CreateFileW(str(self.store), 0x80000000, 2 | 4, None, 3, 0x80, None)
                self.assertNotEqual(handle, ctypes.c_void_p(-1).value, ctypes.get_last_error())
                try: self.caught(operation)
                finally: kernel.CloseHandle(handle)
                self.preserved(modification)
                self.recovered()

    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing contract')
    def test_replacement_sharing_failure_is_not_success_and_cleans_temporary_file(self):
        modification = self.baseline()
        ctypes, kernel = self.windows_api()
        handle = kernel.CreateFileW(str(self.store), 0x80000000, 1 | 2, None, 3, 0x80, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value, ctypes.get_last_error())
        try:
            result = self.run_source('remember("new", 99)\nshow "saved"\n')
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
            self.caught('remember("new", 99)')
        finally: kernel.CloseHandle(handle)
        self.preserved(modification)
        self.recovered()

    @unittest.skipUnless(os.name == 'nt', 'Windows read-only file attribute')
    def test_readonly_destination_reports_io_and_recovers(self):
        modification = self.baseline()
        _, kernel = self.windows_api()
        self.assertTrue(kernel.SetFileAttributesW(str(self.store), 1))
        try: self.caught('remember("new", 99)')
        finally: kernel.SetFileAttributesW(str(self.store), 0x80)
        self.preserved(modification)
        self.recovered()

    @unittest.skipIf(os.name == 'nt', 'POSIX file access permissions')
    def test_unreadable_existing_store_is_not_treated_as_missing(self):
        for operation in ('remember("new", 99)', 'recall("retained")', 'forget("retained")'):
            with self.subTest(operation=operation):
                modification = self.baseline()
                self.store.chmod(0)
                try:
                    if os.access(self.store, os.R_OK): self.skipTest('Current user bypasses read permissions')
                    self.caught(operation)
                finally: self.store.chmod(0o600)
                self.preserved(modification)
                self.recovered()

    @unittest.skipIf(os.name == 'nt', 'POSIX directory write permissions')
    def test_unwritable_directory_preserves_store_and_leaves_no_temporary_file(self):
        modification = self.baseline()
        self.source.write_text('', encoding='utf-8')
        self.root.chmod(0o500)
        try:
            if os.access(self.root, os.W_OK): self.skipTest('Current user bypasses directory permissions')
            self.caught('remember("new", 99)')
        finally: self.root.chmod(0o700)
        self.preserved(modification)
        self.recovered()


if __name__ == '__main__': unittest.main()
