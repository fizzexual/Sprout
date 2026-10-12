"""Precise Env-root lifecycle controls; not a macOS cause/reproduction claim."""
import json
import io
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else
              os.environ.get('SPROUT_BINARY', ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout'))).resolve()
CSI = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
CAPTURE_BYTES = 65536


def bounded_process(argv, *, cwd=None, data=None, timeout=15, env=None):
    """Supervised I/O deadline; spawn and bounded cleanup are separate OS boundaries."""
    if data is not None and len(data) > 4096: raise ValueError('fixture stdin exceeds4096 bytes')
    buffers = [bytearray(), bytearray()]; errors = []; cleanup = []; failed = threading.Event()
    done = [threading.Event(), threading.Event()]; writer_done = threading.Event()
    lock = threading.Lock(); process = None; code = None
    def consume(index):
        try:
            stream = process.stdout if index == 0 else process.stderr
            while chunk := stream.read1(4096):
                with lock:
                    remaining = CAPTURE_BYTES - len(buffers[index]); buffers[index].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        errors.append(('stdout' if index == 0 else 'stderr') + ' exceeds fixture capture cap'); failed.set(); break
        except Exception as error:
            errors.append(('stdout' if index == 0 else 'stderr') + ' reader: ' + str(error)[:512]); failed.set()
        finally: done[index].set()
    def provide_input():
        try: process.stdin.write(data)
        except Exception as error:
            errors.append('stdin writer: ' + str(error)[:512]); failed.set()
        finally:
            try: process.stdin.close()
            except Exception as error:
                errors.append('stdin writer close: ' + str(error)[:512]); failed.set()
            writer_done.set()
    readers = [threading.Thread(target=consume, args=(index,), daemon=True) for index in range(2)]
    writer = threading.Thread(target=provide_input, daemon=True) if data is not None else None
    started = time.monotonic()
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for reader in readers: reader.start()
        if writer is not None: writer.start()
        while not failed.is_set():
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0: errors.append('fixture execution deadline exceeded'); break
            if process.poll() is not None and all(event.is_set() for event in done) and (writer is None or writer_done.is_set()): break
            failed.wait(min(.01, remaining))
    except Exception as error: errors.append(type(error).__name__ + ': ' + str(error)[:512])
    finally:
        if process is not None:
            if process.poll() is None:
                try: process.kill()
                except OSError as error: cleanup.append('owned direct kill: ' + str(error)[:512])
            try: code = process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired) as error: cleanup.append('owned direct exit unconfirmed: ' + str(error)[:512])
            for reader in readers:
                if reader.ident is not None: reader.join(timeout=.5)
            if writer is not None and writer.ident is not None: writer.join(timeout=.5)
            for reader, stream in zip(readers, (process.stdout, process.stderr)):
                if reader.is_alive(): cleanup.append('fixture reader/pipe cleanup unconfirmed')
                elif stream is not None:
                    try: stream.close()
                    except OSError as error: cleanup.append('fixture pipe close: ' + str(error)[:512])
            if writer is not None and writer.is_alive(): cleanup.append('fixture writer/pipe cleanup unconfirmed')
            elif process.stdin is not None and not process.stdin.closed:
                try: process.stdin.close()
                except OSError as error: cleanup.append('fixture stdin close: ' + str(error)[:512])
    with lock: stdout, stderr = map(bytes, buffers)
    result = subprocess.CompletedProcess(argv, code, stdout, stderr)
    result.capture_errors = tuple(errors); result.cleanup_errors = tuple(cleanup)
    return result


class EnvironmentRoots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get('SPROUT_GC_ROOT_CC') or shutil.which('cc') or shutil.which('gcc')
        if not compiler: raise RuntimeError('Set SPROUT_GC_ROOT_CC to a trusted cached C compiler; root invariant tests are required, not skipped.')
        cls.build = tempfile.TemporaryDirectory(prefix='sprout-env-root-build-')
        cls.addClassCleanup(cls.build.cleanup)
        cls.harness = Path(cls.build.name) / ('root-review.exe' if os.name == 'nt' else 'root-review')
        flags = shlex.split(os.environ.get('SPROUT_GC_ROOT_CFLAGS', '-O2 -Wall'))
        argv = [compiler, *flags, '-I', str(ROOT / 'src'), '-o', str(cls.harness), str(ROOT / 'src/tests/gc_env_roots_harness.c'), '-lm']
        argv += ['-Wl,--stack,67108864', '-lurlmon'] if os.name == 'nt' else ['-pthread', '-ldl']
        built = bounded_process(argv, timeout=120)
        if built.returncode or built.capture_errors or built.cleanup_errors:
            raise AssertionError('Root harness compile failed: ' + repr((built.capture_errors, built.cleanup_errors)) + '\n' + built.stderr.decode('utf-8', 'replace'))

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='sprout-env-root-')
        self.addCleanup(temp.cleanup); self.directory = Path(temp.name)

    def source(self, text, name='case.sprout'):
        path = self.directory / name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8'); return path

    def execute(self, argv, *, data=None, code=0, harness=True, command=None):
        process = bounded_process([str(command or (self.harness if harness else BINARY)), *map(str, argv)], cwd=self.directory,
                                  data=data.encode('utf-8') if data is not None else None,
                                  timeout=15, env={**os.environ, 'SPROUT_GC_STRESS': '1'})
        self.assertEqual(process.capture_errors, (), repr(process.capture_errors) + '\n' + process.stderr.decode('utf-8', 'replace'))
        self.assertEqual(process.cleanup_errors, (), repr(process.cleanup_errors))
        self.assertEqual(process.returncode, code, process.stderr.decode('utf-8', 'replace'))
        for marker in (b'AddressSanitizer', b'runtime error:', b'DEADLYSIGNAL', b'Assertion', b'assertion'):
            self.assertNotIn(marker, process.stderr)
        stats = None
        if harness:
            lines = process.stderr.splitlines()
            observations = [line for line in lines if line.startswith(b'@gc-env-roots ')]
            self.assertEqual(len(observations), 1, process.stderr.decode('utf-8', 'replace'))
            stats = json.loads(observations[0][len(b'@gc-env-roots '):])
            self.assertEqual(stats['depth'], 0)
        return CSI.sub(b'', process.stdout), process.stderr, stats

    def test_native_and_invariant_harness_run_shared_scope_corpus_under_actual_gc(self):
        fixture = ROOT / 'src/tests/gc_env_roots_test.sprout'
        native, stderr, _ = self.execute(['test', fixture, '--max-steps', '5000000', '--timeout-ms', '5000'], harness=False)
        self.assertEqual(stderr, b''); self.assertRegex(native, rb'(?m)^  7 passed\r?$')
        output, _, stats = self.execute(['test', fixture, '--max-steps', '5000000', '--timeout-ms', '5000'])
        self.assertRegex(output, rb'(?m)^  7 passed\r?$')
        for field in ['marks', 'statements', 'prepared', 'callers', 'values', 'tasks']: self.assertGreater(stats[field], 0)
        self.assertLessEqual(stats['capacity'], 128)

    def test_controlled_collection_root_growth_and_discarded_slots(self):
        _, _, stats = self.execute(['--root-stack-invariants'])
        self.assertEqual(stats['marks'], 20); self.assertEqual(stats['highwater'], 256)
        self.assertEqual(stats['capacity'], 256)
        self.assertGreaterEqual(stats['peak_envs'], 256); self.assertLessEqual(stats['peak_envs'], 272)
        self.assertGreaterEqual(stats['peak_maps'], 256); self.assertLessEqual(stats['peak_maps'], 272)

    def test_scope_observer_rejects_omitted_push_even_for_an_existing_root(self):
        for event in ['statement', 'caller', 'prepared-expression', 'prepared-value', 'task']:
            with self.subTest(event=event):
                process = bounded_process([str(self.harness), '--root-missing-scope-control', event],
                                          cwd=self.directory, timeout=5)
                self.assertEqual(process.capture_errors, ()); self.assertEqual(process.cleanup_errors, ())
                self.assertEqual(process.returncode, 91, process.stderr.decode('utf-8', 'replace'))
                self.assertIn(('REVIEW_REQUIRED_SCOPE_PUSH: ' + event).encode(), process.stderr)

    def test_nested_import_captures_default_method_and_value_calls(self):
        self.source('public task label(text):\n    make copy = text + "!"\n    give copy\npublic make label = label\n', 'nested.sprout')
        self.source('use "nested.sprout"\nprivate make label = nested.label\npublic task prepare(first, second = label(first.tag)):\n    give {tag: first.tag, text: second}\npublic make prepare = prepare\n', 'helper.sprout')
        entry = self.source('''use "helper.sprout"
make selected = helper.prepare
task suspended():
    when yes:
        make earlier = {tag: "scope"}
        make output = selected(earlier)
        give {result: output, retained: earlier.tag}
make values = builtin::map(["a", "b"], task(text): selected({tag: text}))
show builtin::json_encode({one: suspended(), values: values})
''')
        output, _, stats = self.execute(['run', entry])
        self.assertEqual(json.loads(output), {'one': {'result': {'tag': 'scope', 'text': 'scope!'}, 'retained': 'scope'}, 'values': [{'tag': 'a', 'text': 'a!'}, {'tag': 'b', 'text': 'b!'}]})
        self.assertEqual(stats['modules'], 2); self.assertGreater(stats['values'], 0)

    def test_failed_tests_and_expectations_restore_before_next_test(self):
        entry = self.source('''task broken():
    make discarded = {items: []}
    fail "intentional test failure"
test "nested failure":
    broken()
test "false expectation":
    expect no
test "wrong expected error kind":
    expect error "math":
        broken()
test "recovery after three failures":
    make data = {items: []}
    expect builtin::length(data.items) == 0
    show "TEST_RECOVERED"
''')
        output, _, stats = self.execute(['test', entry], code=1)
        self.assertIn(b'TEST_RECOVERED', output); self.assertRegex(output, rb'1 passed, 3 failed')
        self.assertGreater(stats['marks'], 0)

    def test_top_level_failure_and_import_failure_restore_depth(self):
        for name, text in [('task-fail', 'task broken():\n    make local = {}\n    fail "top failure"\nbroken()\n'),
                           ('module-fail', 'use "failure.sprout"\n')]:
            if name == 'module-fail': self.source('task broken():\n    make local = {}\n    fail "module failure"\nbroken()\n', 'failure.sprout')
            with self.subTest(name=name):
                _, stderr, _ = self.execute(['run', self.source(text, name + '.sprout')], code=1)
                self.assertIn(b'failure', stderr)

    def test_hard_default_name_failure_skips_nested_local_catches(self):
        entry = self.source('''task broken(value = undefined_root_input):
    give value
task nested():
    try:
        broken()
    caught local:
        show "LOCAL_MUST_NOT_CATCH"
try:
    nested()
caught outer:
    show "OUTER_MUST_NOT_CATCH"
''')
        output, stderr, stats = self.execute(['run', entry], code=1)
        self.assertNotIn(b'MUST_NOT_CATCH', output); self.assertIn(b'undefined_root_input', stderr)
        self.assertGreater(stats['prepared'], 0)

    def test_check_only_imports_leave_no_roots(self):
        self.source('public task action():\n    fail "MUST_NOT_EXECUTE"\n', 'library.sprout')
        _, stderr, stats = self.execute(['check', self.source('use "library.sprout"\n')])
        self.assertNotIn(b'MUST_NOT_EXECUTE', stderr); self.assertEqual(stats['modules'], 1)

    def test_baked_main_success_and_failure_restore_scope_depth(self):
        for name, source, status in [('good', 'task action():\n    make local = {}\n    give "BUNDLE_RECOVERED"\nshow action()\n', 0),
                                     ('bad', 'task action():\n    make local = {}\n    fail "bundle failure"\naction()\n', 1)]:
            with self.subTest(name=name):
                entry = self.source(source, name + '.sprout')
                bundle = self.directory / (name + ('.exe' if os.name == 'nt' else '.out'))
                self.execute(['bundle', entry, '-o', bundle])
                output, stderr, stats = self.execute([], command=bundle, code=status)
                self.assertGreater(stats['marks'], 0)
                if status == 0: self.assertIn(b'BUNDLE_RECOVERED', output)
                else: self.assertIn(b'bundle failure', stderr)

    def test_repl_recovers_multiple_snippet_failures_and_keeps_session(self):
        data = '1\ntask broken():\n    make local = {}\n    fail "repl failure"\n\nbroken()\nbroken()\nmake after = "REPL_SURVIVED"\nshow after\nback\n4\n'
        output, stderr, stats = self.execute([], data=data)
        self.assertIn(b'REPL_SURVIVED', output); self.assertEqual(stderr.count(b'repl failure'), 2)
        self.assertGreater(stats['marks'], 0)

    def test_file_prompt_root_growth_failure_has_initialized_recovery_boundary(self):
        path = self.source('show "MUST_NOT_EXECUTE"\n')
        output, stderr, _ = self.execute(['--root-prompt-growth-failure'], data=str(path) + '\n')
        self.assertNotIn(b'MUST_NOT_EXECUTE', output)
        self.assertIn(b'could not preserve active interpreter scopes', stderr)


class DriverCapture(unittest.TestCase):
    def test_stalled_writer_obeys_deadline_and_owned_kill_releases_pipe(self):
        entered = threading.Event(); released = threading.Event(); closed = threading.Event()
        class Input:
            def write(self, data):
                entered.set()
                if not released.wait(2): raise OSError('finite modeled writer stall')
                return len(data)
            def close(self): closed.set()
            @property
            def closed(self): return closed.is_set()
        class Child:
            stdout = io.BytesIO(); stderr = io.BytesIO(); stdin = Input(); status = None; kills = 0
            def poll(self): return self.status
            def kill(self): self.kills += 1; self.status = -9; released.set()
            def wait(self, timeout): return self.status
        child = Child(); started = time.monotonic()
        try:
            with mock.patch.object(subprocess, 'Popen', return_value=child):
                result = bounded_process(['owned-writer-model'], data=b'abcd', timeout=.05)
            self.assertTrue(entered.is_set()); self.assertLess(time.monotonic() - started, 1.5)
            self.assertIn('fixture execution deadline exceeded', result.capture_errors)
            self.assertEqual(result.cleanup_errors, ()); self.assertEqual(result.returncode, -9)
            self.assertEqual(child.kills, 1); self.assertTrue(closed.is_set())
        finally: released.set()

    def test_live_writer_cleanup_refusal_preserves_primary_and_does_not_close_its_pipe(self):
        entered = threading.Event(); released = threading.Event(); closed = threading.Event()
        class Input:
            def write(self, data):
                entered.set()
                if not released.wait(2): raise OSError('finite modeled writer stall')
                return len(data)
            def close(self): closed.set()
            @property
            def closed(self): return closed.is_set()
        class Child:
            stdout = io.BytesIO(); stderr = io.BytesIO(); stdin = Input()
            def poll(self): return None
            def kill(self): raise PermissionError('writer owner kill denied')
            def wait(self, timeout): raise subprocess.TimeoutExpired('owned-writer-model', timeout)
        try:
            with mock.patch.object(subprocess, 'Popen', return_value=Child()):
                result = bounded_process(['owned-writer-model'], data=b'abcd', timeout=.05)
            self.assertTrue(entered.is_set()); self.assertFalse(closed.is_set())
            self.assertIn('fixture execution deadline exceeded', result.capture_errors)
            self.assertTrue(any('kill denied' in error for error in result.cleanup_errors))
            self.assertTrue(any('exit unconfirmed' in error for error in result.cleanup_errors))
            self.assertIn('fixture writer/pipe cleanup unconfirmed', result.cleanup_errors)
            self.assertIsNone(result.returncode)
        finally:
            released.set()
            self.assertTrue(closed.wait(1), 'finite modeled writer must settle after fixture release')

    def test_stdout_and_stderr_floods_fail_with_bounded_prefix_and_reaped_direct_child(self):
        for descriptor, name in [(1, 'stdout'), (2, 'stderr')]:
            with self.subTest(stream=name):
                result = bounded_process([sys.executable, '-c', 'import os,time;os.write(' + str(descriptor) + ',b"x"*100000);time.sleep(30)'], timeout=2)
                self.assertIn(name + ' exceeds fixture capture cap', result.capture_errors)
                self.assertEqual(len(getattr(result, name)), CAPTURE_BYTES)
                self.assertEqual(result.cleanup_errors, ()); self.assertIsNotNone(result.returncode)

    def test_deadline_retains_diagnostic_and_confirms_owned_exit(self):
        result = bounded_process([sys.executable, '-c', 'import os,time;os.write(2,b"original-diagnostic");time.sleep(30)'], timeout=1)
        self.assertIn('fixture execution deadline exceeded', result.capture_errors)
        self.assertEqual(result.stderr, b'original-diagnostic'); self.assertEqual(result.cleanup_errors, ())
        self.assertIsNotNone(result.returncode)

    def test_reader_error_retains_primary_when_direct_cleanup_is_denied(self):
        class Pipe:
            closed = False
            def read1(self, count): raise OSError('reader failure')
            def close(self): self.closed = True
        class Child:
            stdout = Pipe(); stderr = Pipe(); stdin = None
            def poll(self): return None
            def kill(self): raise PermissionError('kill denied')
            def wait(self, timeout): raise subprocess.TimeoutExpired('owned-fixture', timeout)
        with mock.patch.object(subprocess, 'Popen', return_value=Child()):
            result = bounded_process(['owned-model'], timeout=1)
        self.assertTrue(any('reader failure' in error for error in result.capture_errors))
        self.assertTrue(any('kill denied' in error for error in result.cleanup_errors))
        self.assertTrue(any('exit unconfirmed' in error for error in result.cleanup_errors))
        self.assertIsNone(result.returncode)


if __name__ == '__main__': unittest.main()
