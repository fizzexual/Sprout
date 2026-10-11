"""Native contracts for pure DAG planning and read-only checkpoint inspection.

Commands are local fixtures. No remote service, shell, or application repository
is involved. Planning must never execute them; inspection must never repair data.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


if os.name == 'nt':
    import ctypes
    from ctypes import wintypes

    KERNEL = ctypes.WinDLL('kernel32', use_last_error=True)
    KERNEL.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    KERNEL.CreateFileW.restype = wintypes.HANDLE
    KERNEL.CloseHandle.argtypes = [wintypes.HANDLE]
    KERNEL.CloseHandle.restype = wintypes.BOOL
    KERNEL.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                 ctypes.c_void_p, wintypes.DWORD]
    KERNEL.SetFileInformationByHandle.restype = wintypes.BOOL
    KERNEL.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                               ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    KERNEL.ReadFile.restype = wintypes.BOOL

    class RenameInfo(ctypes.Structure):
        _fields_ = [('Flags', wintypes.DWORD), ('RootDirectory', wintypes.HANDLE),
                    ('FileNameLength', wintypes.DWORD), ('FileName', wintypes.WCHAR * 1)]


BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              os.environ.get('SPROUT_BINARY', Path(__file__).parents[1] /
                             ('sprout.exe' if os.name == 'nt' else 'sprout'))).resolve()


def atomic_replace(source, target):
    if os.name != 'nt':
        return os.replace(source, target)
    # Match Sprout's supported Windows publish primitive. MoveFileExW (used by
    # Python os.replace) can deny overwrite even with FILE_SHARE_DELETE readers.
    handle = KERNEL.CreateFileW(str(source), 0x10000 | 0x100000, 7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        encoded = str(target).encode('utf-16-le')
        buffer = ctypes.create_string_buffer(RenameInfo.FileName.offset + len(encoded))
        info = ctypes.cast(buffer, ctypes.POINTER(RenameInfo)).contents
        info.Flags = 3  # FILE_RENAME_FLAG_REPLACE_IF_EXISTS | POSIX_SEMANTICS.
        info.RootDirectory = None
        info.FileNameLength = len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + RenameInfo.FileName.offset, encoded, len(encoded))
        if not KERNEL.SetFileInformationByHandle(handle, 22, buffer, len(buffer)):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        KERNEL.CloseHandle(handle)


def literal(value):
    if value is True:
        return 'yes'
    if value is False:
        return 'no'
    if value is None:
        return 'nothing'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ', '.join(map(literal, value)) + ']'
    if isinstance(value, dict):
        return '{' + ', '.join(literal(k) + ': ' + literal(v) for k, v in value.items()) + '}'
    return str(value)


class WorkflowTools(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-workflow-tools-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'main.sprout'
        self.checkpoint = self.root / 'checkpoint.json'
        self.lock = Path(str(self.checkpoint) + '.lock')

    def run_source(self, source, *flags):
        self.source.write_text(source, encoding='utf-8')
        result = subprocess.run([str(BINARY), 'run', str(self.source),
                                 '--max-steps', '1000000', '--timeout-ms', '5000', *flags],
                                cwd=self.root, capture_output=True, timeout=10)
        return self.checked(result)

    def checked(self, result):
        output = result.stdout + result.stderr
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer',
                       b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, output, 'A sanitizer failure is not a valid rejection')
        self.assertGreaterEqual(result.returncode, 0, 'Interpreter crashed or was killed')
        if os.name == 'nt':
            self.assertLess(result.returncode, 0x80000000, 'Interpreter exited with NTSTATUS')
        return result

    def value(self, source, *flags):
        result = self.run_source(source, *flags)
        self.assertEqual(result.returncode, 0, repr(result.stdout + result.stderr))
        return json.loads(result.stdout.decode('utf-8'))

    def plan(self, jobs, *flags):
        return self.value('use workflow\nshow json_encode(workflow.plan(' + literal(jobs) + '))\n', *flags)

    def inspect(self, path=None, *flags):
        path = self.checkpoint if path is None else path
        before = path.read_bytes() if path.is_file() else None
        mtime = path.stat().st_mtime_ns if path.exists() else None
        had_lock = self.lock.exists()
        result = self.value('use workflow\nshow json_encode(workflow.inspect(' + literal(str(path)) + '))\n', *flags)
        self.assertEqual(self.lock.exists(), had_lock, 'Inspection created a lock file')
        if before is not None:
            self.assertEqual(path.read_bytes(), before, 'Inspection changed checkpoint bytes')
            self.assertEqual(path.stat().st_mtime_ns, mtime, 'Inspection changed checkpoint mtime')
        else:
            self.assertEqual(path.exists(), mtime is not None, 'Inspection created a missing path')
        return result

    def saved(self, jobs=None, **fields):
        state = {'version': 1, 'fingerprint': 'a' * 64,
                 'jobs': jobs if jobs is not None else
                 [{'id': 'one', 'status': 'pending', 'attempts': 0, 'result': None}]}
        state.update(fields)
        self.checkpoint.write_text(json.dumps(state), encoding='utf-8')
        return state

    def assert_invalid(self):
        result = self.inspect()
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'invalid_checkpoint')
        self.assertIsInstance(result['error'], str)
        self.assertNotIn('jobs', result)

    def test_plan_simultaneous_layers_and_stable_input_order(self):
        jobs = [{'id': 'publish', 'argv': ['not-a-real-command'], 'after': ['left', 'right']},
                {'id': 'right', 'argv': ['not-a-real-command'], 'after': ['start']},
                {'id': 'start', 'argv': ['not-a-real-command']},
                {'id': 'left', 'argv': ['not-a-real-command'], 'after': ['start']},
                {'id': 'independent', 'argv': ['not-a-real-command']}]
        result = self.plan(jobs)
        self.assertTrue(result['ok'])
        self.assertEqual(result['count'], 5)
        self.assertEqual(result['layers'], [['start', 'independent'], ['right', 'left'], ['publish']])
        self.assertEqual(result['order'], ['start', 'independent', 'right', 'left', 'publish'])
        self.assertEqual(set(result), {'ok', 'count', 'fingerprint', 'order', 'layers'})

    def test_plan_is_pure_in_sandbox_and_does_not_mutate_jobs(self):
        marker = self.root / 'must-not-run'
        argv = [sys.executable, '-c', 'from pathlib import Path;Path(' + repr(str(marker)) + ').touch()']
        jobs = [{'id': 'side-effect', 'argv': argv, 'idempotent': True}]
        source = ('use workflow\nmake jobs = ' + literal(jobs) + '\nmake before = json_encode(jobs)\n'
                  'make first = workflow.plan(jobs)\nmake second = workflow_plan(jobs)\n'
                  'show json_encode({unchanged: before == json_encode(jobs), equal: first == second})\n')
        self.assertEqual(self.value(source, '--sandbox'), {'unchanged': True, 'equal': True})
        self.assertFalse(marker.exists())
        self.assertFalse(self.checkpoint.exists())
        self.assertFalse(self.lock.exists())

    def test_plan_fingerprint_uses_the_complete_ordered_specification(self):
        jobs = [{'id': 'a', 'argv': ['tool', '--value', '1'], 'idempotent': True, 'retries': 1},
                {'id': 'b', 'argv': ['tool'], 'after': ['a']}]
        result = self.plan(jobs)
        serialized = json.dumps(jobs, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.assertEqual(result['fingerprint'], hashlib.sha256(serialized).hexdigest())
        self.assertNotEqual(self.plan(list(reversed(jobs)))['fingerprint'], result['fingerprint'])
        changed = json.loads(json.dumps(jobs))
        changed[0]['argv'][-1] = '2'
        self.assertNotEqual(self.plan(changed)['fingerprint'], result['fingerprint'])

    def test_plan_rejects_bad_graphs_before_any_side_effect(self):
        bad_graphs = [
            [{'id': 'a', 'argv': ['tool']}, {'id': 'a', 'argv': ['tool']}],
            [{'id': 'a', 'argv': ['tool'], 'after': ['missing']}],
            [{'id': 'a', 'argv': ['tool'], 'after': ['a']}],
            [{'id': 'a', 'argv': ['tool'], 'after': ['b']}, {'id': 'b', 'argv': ['tool'], 'after': ['a']}],
            [{'id': 'a', 'argv': ['tool']}, {'id': 'b', 'argv': ['tool'], 'after': ['a', 'a']}],
            [{'id': 'a', 'argv': ['tool'], 'after': 'a'}],
        ]
        for jobs in bad_graphs:
            with self.subTest(jobs=jobs):
                result = self.run_source('show json_encode(workflow_plan(' + literal(jobs) + '))\n', '--sandbox')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.checkpoint.exists())
                self.assertFalse(self.lock.exists())

    def test_plan_and_run_share_job_validation(self):
        invalid = [[], [1], [{'id': '', 'argv': ['tool']}], [{'id': 'a', 'argv': []}],
                   [{'id': 'a', 'argv': [1]}], [{'id': 'a', 'argv': ['']}],
                   [{'id': 'a', 'argv': ['tool'], 'unknown': True}],
                   [{'id': 'a', 'argv': ['tool'], 'retries': 1}],
                   [{'id': 'a', 'argv': ['tool'], 'idempotent': 'yes'}],
                   [{'id': 'a', 'argv': ['tool'], 'timeout_ms': 1.5}],
                   [{'id': 'a', 'argv': ['tool'], 'timeout_ms': 1e99}],
                   [{'id': 'a', 'argv': ['tool'], 'max_output': 0}],
                   [{'id': 'a', 'argv': ['tool'], 'cwd': 1}],
                   [{'id': 'a', 'argv': ['tool'], 'stdin': []}],
                   [{'id': 'a', 'argv': ['tool'], 'idempotent': True, 'retries': 6}]]
        for jobs in invalid:
            with self.subTest(jobs=jobs):
                plan = self.run_source('workflow_plan(' + literal(jobs) + ')\n')
                run = self.run_source('workflow_run(' + literal(jobs) + ', {checkpoint: ' + literal(str(self.checkpoint)) + '})\n')
                self.assertNotEqual(plan.returncode, 0)
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse(self.checkpoint.exists())
                self.assertFalse(self.lock.exists(), 'Invalid jobs acquired the execution lock')

    def test_plan_job_id_and_argv_limits(self):
        jobs = [{'id': 'j' + str(i), 'argv': ['tool']} for i in range(128)]
        self.assertEqual(self.plan(jobs)['count'], 128)
        self.assertEqual(self.plan([{'id': 'a' * 64, 'argv': ['tool'] * 256}])['count'], 1)
        for value in [jobs + [{'id': 'extra', 'argv': ['tool']}],
                      [{'id': 'a' * 65, 'argv': ['tool']}],
                      [{'id': '€' * 22, 'argv': ['tool']}],
                      [{'id': 'a', 'argv': ['tool'] * 257}]]:
            with self.subTest(kind=len(value)):
                self.assertNotEqual(self.run_source('workflow_plan(' + literal(value) + ')\n').returncode, 0)

    def test_inspect_actual_checkpoint_matches_plan_without_reexecution(self):
        marker = self.root / 'counter'
        code = 'from pathlib import Path;p=Path(' + repr(str(marker)) + ');p.write_text("once");print("PRIVATE OUTPUT")'
        jobs = [{'id': 'write', 'argv': [sys.executable, '-c', code], 'idempotent': True},
                {'id': 'next', 'argv': [sys.executable, '-c', 'print(42)'], 'after': ['write']}]
        planned = self.plan(jobs)
        self.assertFalse(marker.exists())
        run = self.value('workflow_run(' + literal(jobs) + ', {checkpoint: ' + literal(str(self.checkpoint)) + '})\nshow json_encode(yes)\n')
        self.assertTrue(run)
        summary = self.inspect()
        self.assertTrue(summary['ok'])
        self.assertEqual(summary['code'], 'ok')
        self.assertEqual(summary['version'], 1)
        self.assertEqual(summary['fingerprint'], planned['fingerprint'])
        self.assertEqual(summary['count'], 2)
        self.assertTrue(summary['complete'])
        self.assertEqual(summary['counts'], {'pending': 0, 'running': 0, 'done': 2, 'failed': 0})
        self.assertEqual(summary['jobs'], [{'id': 'write', 'status': 'done', 'attempts': 1},
                                           {'id': 'next', 'status': 'done', 'attempts': 1}])
        self.assertNotIn('PRIVATE OUTPUT', json.dumps(summary))
        self.assertEqual(marker.read_text(), 'once')

    def test_inspect_summarizes_uncertain_and_failed_states_without_repair(self):
        self.saved([{'id': 'pending', 'status': 'pending', 'attempts': 0, 'result': None},
                    {'id': 'uncertain', 'status': 'running', 'attempts': 2, 'result': None},
                    {'id': 'finished', 'status': 'done', 'attempts': 1, 'result': {'ok': True}},
                    {'id': 'failed', 'status': 'failed', 'attempts': 3, 'result': {'ok': False}}])
        summary = self.inspect()
        self.assertTrue(summary['ok'])
        self.assertFalse(summary['complete'])
        self.assertEqual(summary['counts'], {'pending': 1, 'running': 1, 'done': 1, 'failed': 1})
        self.assertEqual(summary['jobs'][1], {'id': 'uncertain', 'status': 'running', 'attempts': 2})

    def test_inspect_ignores_unused_metadata_and_never_returns_result_payloads(self):
        self.saved([{'id': 'one', 'status': 'done', 'attempts': 1,
                     'result': {'ok': True, 'stdout': 'secret', 'unused': {'$sprout.bytes': 5}},
                     'future_entry_metadata': {'value': 1}}], future_metadata={'value': 2})
        summary = self.inspect()
        self.assertTrue(summary['ok'])
        self.assertEqual(set(summary), {'ok', 'error', 'code', 'version', 'fingerprint', 'count', 'complete', 'counts', 'jobs'})
        self.assertIsNone(summary['error'])
        self.assertEqual(summary['jobs'], [{'id': 'one', 'status': 'done', 'attempts': 1}])
        self.assertNotIn('secret', json.dumps(summary))

    def test_inspect_does_not_acquire_the_execution_lock(self):
        self.saved()
        self.lock.mkdir()  # Execution's lock open cannot succeed against a directory.
        self.assertTrue(self.inspect()['ok'])
        self.assertTrue(self.lock.is_dir())
        self.assertEqual(list(self.lock.iterdir()), [])

    def test_inspect_permits_concurrent_atomic_checkpoint_replacement(self):
        # Larger ordinary metadata extends the read window without changing the
        # inspector's public schema. Replacement always publishes a complete file.
        payload = json.dumps({'version': 1, 'fingerprint': 'a' * 64,
                              'jobs': [{'id': 'one', 'status': 'pending', 'attempts': 0, 'result': None}],
                              'metadata': 'x' * (8 * 1024 * 1024)}).encode('utf-8')
        self.checkpoint.write_bytes(payload)
        replacement = self.root / 'next-checkpoint.json'
        self.source.write_text('use workflow\nrepeat 24 times:\n'
                               '    make summary = workflow.inspect(' + literal(str(self.checkpoint)) + ')\n'
                               '    when not summary.ok or summary.count != 1:\n'
                               '        fail "Concurrent checkpoint inspection failed."\n'
                               'show json_encode({inspected: 24})\n', encoding='utf-8')
        reader = subprocess.Popen([str(BINARY), 'run', str(self.source), '--max-steps', '1000000',
                                   '--timeout-ms', '20000'], cwd=self.root, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        succeeded = denied = 0
        deadline = time.monotonic() + 12
        try:
            for _ in range(128):
                if reader.poll() is not None or time.monotonic() >= deadline:
                    break
                if not replacement.exists():
                    replacement.write_bytes(payload)
                try:
                    atomic_replace(replacement, self.checkpoint)
                    succeeded += 1
                except PermissionError:
                    # An incompatible open/rename contract must fail this test.
                    denied += 1
                    time.sleep(.001)
            stdout, stderr = reader.communicate(timeout=25)
            completed = self.checked(subprocess.CompletedProcess(reader.args, reader.returncode, stdout, stderr))
            self.assertEqual(completed.returncode, 0, repr(stdout + stderr))
            self.assertEqual(json.loads(stdout), {'inspected': 24})
            self.assertGreater(succeeded, 0, 'No atomic replacement ran during inspection')
            self.assertEqual(denied, 0, 'Inspection blocked atomic checkpoint replacement')
            self.assertFalse(self.lock.exists())
        finally:
            if reader.poll() is None:
                reader.kill()
            reader.communicate(timeout=5)

    @unittest.skipUnless(os.name == 'nt', 'Windows held destination-handle fixture')
    def test_native_file_write_replaces_shared_open_destination(self):
        target = self.root / 'запис-€-工作.txt'
        target.write_bytes(b'original snapshot')
        handle = KERNEL.CreateFileW(str(target), 0x80000000, 7, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            result = self.value('show json_encode(file_write(' + literal(str(target)) +
                                ', "new complete snapshot"))\n')
            self.assertTrue(result['ok'], result)
            self.assertEqual(target.read_bytes(), b'new complete snapshot')
            old = ctypes.create_string_buffer(64)
            length = wintypes.DWORD()
            self.assertTrue(KERNEL.ReadFile(handle, old, len(old), ctypes.byref(length), None))
            self.assertEqual(old.raw[:length.value], b'original snapshot')
        finally:
            KERNEL.CloseHandle(handle)

    def test_inspect_missing_and_directory_errors(self):
        missing = self.inspect()
        self.assertFalse(missing['ok'])
        self.assertEqual(missing['code'], 'not_found')
        directory = self.inspect(self.root)
        self.assertFalse(directory['ok'])
        self.assertEqual(directory['code'], 'io')

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX nonregular-file fixture')
    def test_inspect_fifo_never_waits_for_a_writer(self):
        os.mkfifo(self.checkpoint)
        summary = self.inspect()
        self.assertFalse(summary['ok'])
        self.assertEqual(summary['code'], 'io')

    def test_inspect_unicode_path_and_maximum_id_length(self):
        self.saved([{'id': 'a' * 64, 'status': 'pending', 'attempts': 0, 'result': None}])
        target = self.root / 'запис-€-工作.json'
        self.checkpoint.rename(target)
        result = self.inspect(target)
        self.assertTrue(result['ok'])
        self.assertEqual(result['jobs'][0]['id'], 'a' * 64)

    def test_inspect_rejects_oversized_checkpoint_without_modifying_it(self):
        with self.checkpoint.open('wb') as stream:
            stream.write(b' ' * (24 * 1024 * 1024 + 1))
        summary = self.inspect()
        self.assertFalse(summary['ok'])
        self.assertEqual(summary['code'], 'limit')

    def test_inspect_rejects_invalid_text_and_ambiguous_json(self):
        for raw in [b'not json', b'{}\x00hidden', b'\xff', b'{"version":1,"version":1}',
                    b'{"version":1,"\\u0076ersion":1}', b'{"jobs":[],"value":NaN}']:
            with self.subTest(raw=raw):
                self.checkpoint.write_bytes(raw)
                self.assert_invalid()

    def test_inspect_rejects_wrong_envelope(self):
        for changes in [{'version': 2}, {'version': True}, {'version': '1'},
                        {'fingerprint': 'a' * 63}, {'fingerprint': 'z' * 64},
                        {'jobs': []}, {'jobs': {}}, {'jobs': [None]},
                        {'jobs': [{'id': 'j' + str(i), 'status': 'pending', 'attempts': 0}
                                  for i in range(129)]}]:
            with self.subTest(changes=changes):
                self.saved(**changes)
                self.assert_invalid()

    def test_inspect_rejects_bad_entry_identity_status_and_attempts(self):
        base = {'id': 'one', 'status': 'pending', 'attempts': 0, 'result': None}
        for changes in [{'id': ''}, {'id': 'a' * 65}, {'id': 1}, {'status': 'ready'},
                        {'status': 1}, {'attempts': -1}, {'attempts': 0.5}, {'attempts': 1e99},
                        {'attempts': True}, {'attempts': 1000001}]:
            with self.subTest(changes=changes):
                self.saved([dict(base, **changes)])
                self.assert_invalid()
        self.saved([dict(base), dict(base)])
        self.assert_invalid()

    def test_inspect_requires_actual_terminal_result_booleans(self):
        for status, result in [('done', None), ('done', {'ok': 'yes'}), ('done', {'ok': 1}),
                               ('done', {'ok': False}), ('failed', None), ('failed', {'ok': True}),
                               ('failed', {'ok': 0}), ('failed', {'ok': 'no'})]:
            with self.subTest(status=status, result=result):
                self.saved([{'id': 'one', 'status': status, 'attempts': 1, 'result': result}])
                self.assert_invalid()
        self.saved([{'id': 'one', 'status': 'done', 'attempts': 1000000, 'result': {'ok': True}}])
        self.assertTrue(self.inspect()['complete'])

    def test_inspect_is_blocked_in_sandbox(self):
        self.saved()
        before = self.checkpoint.read_bytes()
        result = self.run_source('workflow_inspect(' + literal(str(self.checkpoint)) + ')\n', '--sandbox')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'sandbox', result.stderr.lower())
        self.assertEqual(self.checkpoint.read_bytes(), before)
        self.assertFalse(self.lock.exists())

    def test_argument_type_and_arity_errors_throw(self):
        for source in ['workflow_plan()\n', 'workflow_plan({}, {})\n', 'workflow_inspect(1)\n',
                       'workflow_inspect()\n', 'workflow_inspect("file", {})\n']:
            with self.subTest(source=source):
                self.assertNotEqual(self.run_source(source).returncode, 0)


if __name__ == '__main__':
    unittest.main()
