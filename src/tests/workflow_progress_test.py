"""Pure progress and native read-only snapshot contracts, using only synthetic state."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()
LIBRARY = ROOT / 'lib/workflow_progress.sprout'
CLI = ROOT / 'examples/workflows/progress.sprout'
STATES = ('pending', 'running', 'done', 'failed')


def replace_fixture(source, target):
    if os.name != 'nt':
        os.replace(source, target)
        return
    # Match the documented Windows replacement primitive with deletion-sharing readers.
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetFileInformationByHandle.restype = wintypes.BOOL
    class Rename(ctypes.Structure):
        _fields_ = [('Flags', wintypes.DWORD), ('RootDirectory', wintypes.HANDLE),
                    ('FileNameLength', wintypes.DWORD), ('FileName', wintypes.WCHAR * 1)]
    handle = kernel.CreateFileW(str(source), 0x10000 | 0x100000, 7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
    try:
        encoded = str(target).encode('utf-16-le')
        buffer = ctypes.create_string_buffer(Rename.FileName.offset + len(encoded))
        info = ctypes.cast(buffer, ctypes.POINTER(Rename)).contents
        info.Flags = 3
        info.FileNameLength = len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + Rename.FileName.offset, encoded, len(encoded))
        if not kernel.SetFileInformationByHandle(handle, 22, buffer, len(buffer)):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)


def summary(statuses=('pending',), attempts=None):
    attempts = attempts or [0 if s == 'pending' else 1 for s in statuses]
    return {'ok': True, 'error': None, 'code': 'ok', 'version': 1, 'fingerprint': 'a' * 64,
            'count': len(statuses), 'complete': all(s == 'done' for s in statuses),
            'counts': {s: statuses.count(s) for s in STATES},
            'jobs': [{'id': 'synthetic-' + str(i), 'status': s, 'attempts': attempts[i]}
                     for i, s in enumerate(statuses)]}


class WorkflowProgress(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-progress-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def checked(self, result):
        for marker in (b'runtime error:', b'AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertGreaterEqual(result.returncode, 0, 'A crash is not an expected rejection')
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        self.assertEqual(result.stderr, b'')
        return result

    def run_source(self, body, *, sandbox=False, prelude=''):
        path = self.root / 'case.sprout'
        prefix = LIBRARY.read_text(encoding='utf-8') if sandbox else 'use ' + json.dumps(LIBRARY.as_posix())
        path.write_text(prelude + '\n' + prefix + '\n' + body + '\n', encoding='utf-8')
        result = self.checked(subprocess.run([str(BINARY), *(['--sandbox'] if sandbox else []), 'run', str(path),
            '--max-steps', '1000000', '--timeout-ms', '3000'], cwd=self.root, capture_output=True, timeout=8))
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout)

    @staticmethod
    def encoded(value):
        return 'builtin::json_decode(' + json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False) + ')'

    def summarize(self, value, expected=None):
        return self.run_source('show builtin::json_encode(workflow_progress.summarize(' +
            self.encoded(value) + ', ' + self.encoded(expected) + '))')

    def assert_unavailable(self, result, code='invalid_summary'):
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], code)
        self.assertEqual(result['state'], 'unavailable')
        for name in ('count', 'counts', 'attempts_total', 'recorded_complete', 'fingerprint', 'expected_matches'):
            self.assertIsNone(result[name])

    def checkpoint(self, states, attempts=None, **metadata):
        inspected = summary(states, attempts)
        raw = {'version': 1, 'fingerprint': inspected['fingerprint'], 'jobs': []}
        for job in inspected['jobs']:
            raw['jobs'].append({**job, 'result': {'ok': job['status'] == 'done', **metadata}
                               if job['status'] in ('done', 'failed') else None})
        return raw

    def cli(self, raw=None, *, expected=None, existing_lock=False, path=None, encoded=None):
        path = path or self.root / "synthetic checkpoint's 🌱.json"
        if raw is not None or encoded is not None:
            path.write_bytes(encoded if encoded is not None else json.dumps(raw, ensure_ascii=False).encode('utf-8'))
        lock = Path(str(path) + '.lock')
        if existing_lock: lock.write_bytes(b'ordinary lock fixture; never unlock this')
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.iterdir()}
        args = [str(BINARY), 'run', str(CLI), str(path), *([] if expected is None else [expected]),
                '--max-steps', '1000000', '--timeout-ms', '3000']
        result = self.checked(subprocess.run(args, cwd=self.root, capture_output=True, timeout=8))
        self.assertLessEqual(len(result.stdout), 4096)
        self.assertEqual(result.stdout.count(b'\n'), 1)
        after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.iterdir()}
        self.assertEqual(after, before, 'Snapshot changed bytes/mtime or created a file/lock')
        return result.returncode, json.loads(result.stdout)

    def test_independent_state_priority_and_attempt_sum_matrix(self):
        cases = [('pending', ['pending', 'pending']), ('partial', ['done', 'pending']),
                 ('failed', ['done', 'failed', 'pending']),
                 ('uncertain', ['done', 'failed', 'running', 'pending']), ('complete', ['done', 'done'])]
        for expected, states in cases:
            with self.subTest(state=expected):
                value = summary(states)
                result = self.summarize(value)
                self.assertTrue(result['ok'])
                self.assertEqual(result['state'], expected)
                self.assertEqual(result['counts'], {s: states.count(s) for s in STATES})
                self.assertEqual(result['attempts_total'], {'$sprout.integer': str(sum(j['attempts'] for j in value['jobs']))})
                self.assertEqual(result['recorded_complete'], expected == 'complete')
                self.assertIsNone(result['expected_matches'])

    def test_fingerprint_correlation_is_separate_from_recorded_completion(self):
        self.assertTrue(self.summarize(summary(['done']), 'A' * 64)['expected_matches'])
        value = self.summarize(summary(['done']), 'b' * 64)
        self.assertTrue(value['ok'])
        self.assertTrue(value['recorded_complete'])
        self.assertFalse(value['expected_matches'])
        for expected in ('', 'g' * 64, 'a' * 63, 'a' * 65, 1, True, []):
            self.assert_unavailable(self.summarize(summary(), expected), 'invalid_expectation')

    def test_inconsistent_counts_completion_headers_and_shapes_have_no_partial_counters(self):
        good = summary(['done', 'pending'])
        cases = [None, [], {'ok': 1}, {**good, 'complete': True}, {**good, 'count': 3},
                 {**good, 'counts': {'pending': 0, 'running': 0, 'done': 1, 'failed': 0}},
                 {**good, 'version': 2}, {**good, 'fingerprint': 'private-value'},
                 {**good, 'error': 'private-diagnostics'}, {**good, 'unexpected': 'private-value'},
                 {**good, 'jobs': []}]
        for value in cases:
            with self.subTest(value=value): self.assert_unavailable(self.summarize(value))
        self.assertEqual(good, summary(['done', 'pending']))

    def test_job_limits_types_unique_ids_and_exact_counter_boundary(self):
        maximal = summary(['done'] * 128, [1000000] * 128)
        result = self.summarize(maximal)
        self.assertTrue(result['ok'])
        self.assertEqual(result['attempts_total'], {'$sprout.integer': '128000000'})
        for bad_job in ({'id': '', 'status': 'done', 'attempts': 1},
                        {'id': 'id', 'status': 'unknown', 'attempts': 1},
                        {'id': 'id', 'status': 'pending', 'attempts': 1.5},
                        {'id': 'id', 'status': 'pending', 'attempts': True},
                        {'id': 'id', 'status': 'pending', 'attempts': -1},
                        {'id': 'id', 'status': 'pending', 'attempts': 1000001}):
            value = summary(); value['jobs'][0] = bad_job
            self.assert_unavailable(self.summarize(value))
        duplicate = summary(['pending', 'pending']); duplicate['jobs'][1]['id'] = duplicate['jobs'][0]['id']
        self.assert_unavailable(self.summarize(duplicate))
        self.assert_unavailable(self.summarize(summary(['pending'] * 129)))

    def test_ids_use_utf8_bytes_and_do_not_appear_in_output(self):
        for name, accepted in [('🌱' * 16, True), ('🌱' * 17, False), ('é' * 32, True), ('é' * 33, False)]:
            value = summary(); value['jobs'][0]['id'] = name
            result = self.summarize(value)
            self.assertEqual(result['ok'], accepted)
            self.assertNotIn(name, json.dumps(result, ensure_ascii=False))
        self.assert_unavailable(self.run_source('''make value = {ok: yes, error: nothing, code: "ok", version: 1, fingerprint: "a" * 64,
count: 1, complete: no, counts: {pending: 1, running: 0, done: 0, failed: 0}, jobs: [{id: builtin::char(255), status: "pending", attempts: 0}]}
show builtin::json_encode(workflow_progress.summarize(value))'''))

    def test_failure_messages_are_fixed_and_input_container_aliases_are_not_returned(self):
        for code in ('not_found', 'io', 'limit', 'invalid_checkpoint'):
            result = self.summarize({'ok': False, 'error': 'private-path-and-diagnostics', 'code': code})
            self.assert_unavailable(result, code)
            self.assertNotIn('private-', json.dumps(result))
        result = self.run_source('make snapshot = ' + self.encoded(summary(['done', 'pending'])) + '''
make before = builtin::json_encode(snapshot)
make result = workflow_progress.summarize(snapshot)
set result.counts.done = 99
show builtin::json_encode({unchanged: before == builtin::json_encode(snapshot), original: snapshot.counts.done})''')
        self.assertTrue(result['unchanged'])
        self.assertEqual(result['original'], 1)

    def test_malformed_cyclic_objects_and_nonfinite_fields_do_not_dispatch_callbacks(self):
        result = self.run_source('''type Sensitive:
    task equals(self, other):
        fail "Do not dispatch equality."
    task text(self):
        fail "Do not dispatch formatting."
make snapshot = {ok: yes, error: nothing, code: "ok", version: 1, fingerprint: "a" * 64,
    count: 1, complete: no, counts: {pending: 1, running: 0, done: 0, failed: 0}, jobs: []}
builtin::add(snapshot.jobs, snapshot.jobs)
make cyclic = workflow_progress.summarize(snapshot)
set snapshot.jobs = [{id: "id", status: "pending", attempts: builtin::sum([1e308, 1e308])}]
make nonfinite = workflow_progress.summarize(snapshot)
set snapshot.error = Sensitive()
show builtin::json_encode([cyclic, nonfinite, workflow_progress.summarize(snapshot), workflow_progress.summarize(Sensitive()), workflow_progress.summarize(snapshot, Sensitive())])''')
        for index, value in enumerate(result):
            self.assert_unavailable(value, 'invalid_expectation' if index == 4 else 'invalid_summary')

    def test_cli_states_statuses_privacy_and_existing_lock_preservation(self):
        for states, expected_exit in [(['done'], 0), (['done', 'pending'], 2), (['failed'], 2), (['running'], 2)]:
            with self.subTest(states=states):
                code, result = self.cli(self.checkpoint(states, stdout='private worker stdout',
                    stderr='private worker stderr', argv=['do-not-run'], secret={'$sprout.integer': 'unused'}), existing_lock=True)
                self.assertEqual(code, expected_exit)
                self.assertTrue(result['ok'])
                self.assertNotIn('private', json.dumps(result))
                self.assertNotIn('synthetic-', json.dumps(result))
        code, result = self.cli(self.checkpoint(['done']), expected='b' * 64)
        self.assertEqual(code, 4)
        self.assertTrue(result['recorded_complete'])
        self.assertFalse(result['expected_matches'])

    def test_cli_missing_corrupt_terminal_result_and_size_failures_preserve_data(self):
        code, result = self.cli(path=self.root / 'missing.json')
        self.assertEqual(code, 3); self.assert_unavailable(result, 'not_found')
        code, result = self.cli(encoded=b'{ordinary malformed checkpoint')
        self.assertEqual(code, 3); self.assert_unavailable(result, 'invalid_checkpoint')
        bad = self.checkpoint(['done']); bad['jobs'][0]['result']['ok'] = 'yes'
        code, result = self.cli(bad)
        self.assertEqual(code, 3); self.assert_unavailable(result, 'invalid_checkpoint')
        oversized = b'{"padding":"' + b'x' * (24 * 1024 * 1024) + b'"}'
        code, result = self.cli(encoded=oversized)
        self.assertEqual(code, 3); self.assert_unavailable(result, 'limit')

    def test_cli_invalid_expected_preflight_does_not_read_checkpoint(self):
        path = self.root / 'directory.json'; path.mkdir()
        result = self.checked(subprocess.run([str(BINARY), 'run', str(CLI), str(path), 'not-a-fingerprint',
            '--max-steps', '1000000', '--timeout-ms', '3000'], capture_output=True, timeout=8))
        self.assertEqual(result.returncode, 3)
        self.assert_unavailable(json.loads(result.stdout), 'invalid_expectation')
        self.assertEqual(list(path.iterdir()), [])

    def test_bounded_atomic_replacement_produces_coherent_read_only_snapshots(self):
        path = self.root / 'changing.json'
        raw = [self.checkpoint(['done']), self.checkpoint(['pending'])]
        versions = [json.dumps(v).encode('utf-8') for v in raw]
        path.write_bytes(versions[0])
        lock = Path(str(path) + '.lock'); lock.write_bytes(b'preserve lock fixture')
        source = self.root / 'observe.sprout'
        source.write_text('use ' + json.dumps(LIBRARY.as_posix()) + '\nshow "READY"\n'
            'repeat 16 times:\n    builtin::wait(0.005)\n    show builtin::json_encode(workflow_progress.summarize('
            'builtin::workflow_inspect(' + json.dumps(path.as_posix()) + ')))\n', encoding='utf-8')
        errors = []
        writes = []
        def writer():
            try:
                for index in range(16):
                    temporary = self.root / ('replace-%d.json' % index)
                    temporary.write_bytes(versions[index % 2])
                    replace_fixture(temporary, path)
                    writes.append(index)
            except Exception as error:
                errors.append(error)
        child = subprocess.Popen([str(BINARY), 'run', str(source), '--max-steps', '1000000', '--timeout-ms', '3000'],
                                 cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        thread = None
        ready = queue.Queue()
        reader = threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            self.assertEqual(ready.get(timeout=3), b'READY\r\n' if os.name == 'nt' else b'READY\n')
            self.assertIsNone(child.poll(), 'Concurrent fixture started after the observer exited')
            thread = threading.Thread(target=writer); thread.start()
            stdout, stderr = child.communicate(timeout=8)
            self.checked(subprocess.CompletedProcess(child.args, child.returncode, stdout, stderr))
            self.assertEqual(child.returncode, 0)
            rows = [json.loads(line) for line in stdout.splitlines()]
            self.assertEqual(len(rows), 16)
            for row in rows:
                self.assertTrue(row['ok'])
                self.assertIn(row['state'], ('complete', 'pending'))
                self.assertEqual(row['counts']['done'] + row['counts']['pending'], 1)
        finally:
            if child.poll() is None: child.kill(); child.wait(timeout=3)
            if thread is not None: thread.join(timeout=3)
            reader.join(timeout=3)
            child.stdout.close()
            child.stderr.close()
        self.assertFalse(thread.is_alive())
        self.assertFalse(reader.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(writes), 16)
        self.assertEqual(path.read_bytes(), versions[1])
        self.assertEqual(lock.read_bytes(), b'preserve lock fixture')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['changing.json', 'changing.json.lock', 'observe.sprout'])

    def test_owned_helpers_and_native_operations_are_protected_in_supplied_sandbox(self):
        declarations = 'make calls = []\ntask observed():\n    builtin::add(calls, "constructor")\n    give 0\n'
        for name, arity in [('wfp_plain', 2), ('wfp_shape', 2), ('wfp_whole', 2), ('wfp_hash', 1),
                            ('wfp_id', 1), ('wfp_error', 2), ('wfp_invalid', 0), ('summarize', 2),
                            ('kind_of', 1), ('is_a', 2), ('contains', 2), ('length', 1), ('add', 2),
                            ('lower', 1), ('integer', 1), ('number', 1), ('bytes', 1), ('bytes_text', 1)]:
            declarations += 'type ' + name + ':\n'
            declarations += ''.join('    make arg%d\n' % i for i in range(arity)) + '    make observed = observed()\n'
        value = self.run_source('make result = summarize(' + self.encoded(summary(['done'])) + ', "A" * 64)\n'
            'show builtin::json_encode({result: result, calls: calls})', sandbox=True, prelude=declarations)
        self.assertTrue(value['result']['ok'])
        self.assertTrue(value['result']['expected_matches'])
        self.assertEqual(value['calls'], [])

    def test_shared_portable_corpus_under_gc_stress(self):
        result = self.checked(subprocess.run([str(BINARY), 'test', str(ROOT / 'src/tests/workflow_progress_test.sprout'),
            '--max-steps', '1000000', '--timeout-ms', '3000'], cwd=self.root,
            env={**os.environ, 'SPROUT_GC_STRESS': '1'}, capture_output=True, timeout=8))
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'6 passed', result.stdout)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__': unittest.main()
