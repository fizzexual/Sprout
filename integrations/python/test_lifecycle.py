"""Owned worker cleanup after thread exhaustion or denied group termination."""
from contextlib import closing, contextmanager, nullcontext
import errno
import http.client
import io
import json
import os
from pathlib import Path
import subprocess
import signal
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import sprout_host
from sprout_host import run, SproutError
from sprout_service import SproutServer


BINARY = os.environ.get('SPROUT_COMMAND')


@contextmanager
def denied_group_signal(children):
    """Exercise POSIX denial logic with an ordinary live owned worker on all OSes."""
    def denied(pid, sig):
        child = children[-1]
        if pid != child.pid or child.poll() is not None:
            raise AssertionError('group fixture did not target its live owned worker')
        if os.name != 'nt' and os.getpgid(pid) != pid:
            raise AssertionError('worker was not launched in its own group')
        raise PermissionError(errno.EPERM, 'fixture group termination denied')
    # On Windows the denial is synthetic; direct termination and reaping still
    # use the actual child handle. POSIX also verifies the real isolated group.
    with patch.object(sprout_host, 'os', SimpleNamespace(name='posix', killpg=denied)), \
         patch.object(sprout_host, 'signal', SimpleNamespace(SIGKILL=getattr(signal, 'SIGKILL', 9))):
        yield


class PreparationTests(unittest.TestCase):
    def test_thread_object_creation_failure_cannot_launch_a_worker(self):
        with patch('sprout_host.threading.Thread', side_effect=RuntimeError('cannot construct thread')), \
             patch('sprout_host.subprocess.Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'cannot construct thread'):
                run('unused.sprout', None)
            launch.assert_not_called()

    def test_startup_cleanup_cannot_block_closing_a_reader_owned_buffer(self):
        read_fd, write_fd = os.pipe()
        entered, finished = threading.Event(), threading.Event()
        class ObservedReader(io.BufferedReader):
            def read1(self, size):
                entered.set()
                return super().read1(size)
        source = ObservedReader(io.FileIO(read_fd, closefd=True))
        child = SimpleNamespace(stdin=io.BytesIO(), stdout=source, stderr=io.BytesIO(),
                                poll=lambda: 0, wait=lambda timeout: 0)
        real_start = threading.Thread.start
        attempted, result = [], []
        def start(thread):
            attempted.append(thread)
            if len(attempted) == 2: raise RuntimeError('cannot start second reader')
            real_start(thread)
            if not entered.wait(1): raise AssertionError('first reader did not enter its pipe read')
        def call():
            try:
                with patch('sprout_host.subprocess.Popen', return_value=child), \
                     patch('sprout_host.threading.Thread.start', new=start), \
                     patch('sprout_host._stop_child'):
                    run('unused.sprout', None)
            except BaseException as error: result.append(error)
            finally: finished.set()
        caller = threading.Thread(target=call)
        caller.start()
        try:
            self.assertTrue(finished.wait(2), 'cleanup waited for a buffered reader lock held by an external pipe writer')
            self.assertEqual(len(result), 1)
            self.assertIsInstance(result[0], SproutError)
            self.assertEqual(result[0].code, 'io')
            self.assertTrue(child.stdin.closed and child.stderr.closed)
        finally:
            os.close(write_fd)  # Release the external fixture writer, then reclaim the reader.
            caller.join(2)
            for thread in attempted:
                if thread.ident is not None: thread.join(2)
            source.close()
        self.assertFalse(caller.is_alive())
        self.assertFalse(any(thread.is_alive() for thread in attempted))


@unittest.skipUnless(BINARY, 'set SPROUT_COMMAND to a built runtime')
class NativeStartupTests(unittest.TestCase):
    def assert_start_failure_is_cleaned(self, failed_start, error_type=RuntimeError, *, deny_group=False):
        real_popen, real_start = subprocess.Popen, threading.Thread.start
        children, attempted = [], []
        with tempfile.TemporaryDirectory() as name:
            source = Path(name) / 'worker.sprout'
            # No stdin writer means this real native worker waits in read_input.
            source.write_text('show json_encode(read_input())\n', encoding='utf-8')
            def observe(*args, **kwargs):
                if deny_group and os.name == 'nt':
                    kwargs.update(start_new_session=False, creationflags=subprocess.CREATE_NO_WINDOW)
                child = real_popen(*args, **kwargs)
                argv = args[0] if args else kwargs['args']
                if Path(argv[0]).resolve() == Path(BINARY).resolve(): children.append(child)
                return child
            def start(thread):
                attempted.append(thread)
                if len(attempted) == failed_start:
                    raise error_type('simulated OS thread quota exhaustion')
                return real_start(thread)
            try:
                group_control = denied_group_signal(children) if deny_group else nullcontext()
                with patch('sprout_host.subprocess.Popen', new=observe), \
                     patch('sprout_host.threading.Thread.start', new=start), group_control:
                    with self.assertRaises(SproutError if error_type is RuntimeError else error_type) as caught:
                        run(source, None, command=BINARY, timeout_ms=200,
                            runtime_timeout_ms=5000 if deny_group else 100)
                if error_type is RuntimeError: self.assertEqual(caught.exception.code, 'io')
                if deny_group:
                    issue, = caught.exception.cleanup_errors
                    self.assertEqual((issue.operation, issue.errno), ('process-group', errno.EPERM))
                    self.assertIn('fixture group termination denied', issue.message)
                    self.assertIsInstance(caught.exception.cleanup_errors, tuple)
                    if error_type is RuntimeError:
                        self.assertEqual(caught.exception.exit_code, children[0].returncode)
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].poll(), 'worker survived failed SDK initialization')
                self.assertTrue(all(pipe.closed for pipe in (children[0].stdin, children[0].stdout, children[0].stderr)))
                self.assertFalse(any(thread.is_alive() for thread in attempted), 'started I/O thread survived cleanup')
                source.write_text('show json_encode(42)\n', encoding='utf-8')
                self.assertEqual(run(source, None, command=BINARY), 42)
            finally:
                # Keep a failed regression harmless even on the old SDK.
                for child in children:
                    if child.poll() is None: child.kill()
                    child.wait(timeout=2)
                    for pipe in (child.stdin, child.stdout, child.stderr):
                        if not pipe.closed: pipe.close()
                for thread in attempted:
                    if thread.ident is not None: thread.join(1)

    def test_each_io_thread_start_failure_reaps_worker_and_closes_pipes(self):
        for failed_start in (1, 2, 3):
            with self.subTest(failed_start=failed_start): self.assert_start_failure_is_cleaned(failed_start)

    def test_initialization_interrupt_preserves_signal_semantics_after_cleanup(self):
        self.assert_start_failure_is_cleaned(2, KeyboardInterrupt)

    def test_group_denial_preserves_initialization_failure_and_interrupt(self):
        self.assert_start_failure_is_cleaned(2, deny_group=True)
        self.assert_start_failure_is_cleaned(2, KeyboardInterrupt, deny_group=True)

    def test_group_denial_reaps_limit_timeout_and_canceled_workers_then_recovers(self):
        real_popen, real_start = subprocess.Popen, threading.Thread.start
        for code in ('stdout-limit', 'timeout', 'canceled'):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as name:
                children, threads = [], []
                cancel = threading.Event() if code == 'canceled' else None
                def observe(*args, **kwargs):
                    if os.name == 'nt':
                        kwargs.update(start_new_session=False, creationflags=subprocess.CREATE_NO_WINDOW)
                    child = real_popen(*args, **kwargs); children.append(child)
                    if cancel is not None: cancel.set()  # Only after the real launch.
                    return child
                def start(thread):
                    threads.append(thread)
                    return real_start(thread)
                source = Path(name) / 'worker.sprout'
                # ask explicitly flushes a single bounded prompt, then reads the
                # supplied input. No repeated writes can die from SIGPIPE when
                # the capped reader closes its pipe before the denial control.
                prompt = 'ask("' + 'x' * 2048 + '")\n' if code == 'stdout-limit' else ''
                source.write_text(prompt + 'repeat while yes:\n    make x = 1\n', encoding='utf-8')
                try:
                    with patch('sprout_host.subprocess.Popen', new=observe), \
                         patch('sprout_host.threading.Thread.start', new=start), denied_group_signal(children):
                        with self.assertRaises(SproutError) as caught:
                            run(source, None, command=BINARY, max_output_bytes=1000,
                                timeout_ms=50 if code == 'timeout' else 1000, cancel=cancel,
                                runtime_timeout_ms=5000, max_steps=1000000000)
                    error = caught.exception
                    self.assertEqual(error.code, code)
                    self.assertEqual(len(children), 1)
                    self.assertIsNotNone(children[0].poll(), 'direct worker survived denied group termination')
                    self.assertEqual(error.exit_code, children[0].returncode)
                    issue, = error.cleanup_errors
                    self.assertEqual((issue.operation, issue.errno), ('process-group', errno.EPERM))
                    self.assertIn('fixture group termination denied', issue.message)
                    self.assertIsInstance(error.cleanup_errors, tuple)
                    self.assertTrue(all(pipe.closed for pipe in (children[0].stdin, children[0].stdout, children[0].stderr)))
                    self.assertFalse(any(thread.is_alive() for thread in threads))
                    if os.name != 'nt':
                        with self.assertRaises(ChildProcessError):
                            os.waitpid(children[0].pid, os.WNOHANG)
                    source.write_text('show json_encode(42)\n', encoding='utf-8')
                    self.assertEqual(run(source, None, command=BINARY), 42)
                finally:
                    # Bound the regression even against a SDK missing fallback.
                    for child in children:
                        if child.poll() is None: child.kill()
                        child.wait(timeout=2)
                        for pipe in (child.stdin, child.stdout, child.stderr):
                            if not pipe.closed: pipe.close()
                    for thread in threads:
                        if thread.ident is not None: thread.join(1)

    def test_http_bridge_returns_bounded_failure_then_recovers(self):
        with tempfile.TemporaryDirectory() as name:
            source = Path(name) / 'api.sprout'
            source.write_text('show json_encode({status: 200, body: {ok: yes}})\n', encoding='utf-8')
            server = SproutServer(('127.0.0.1', 0), source, command=BINARY)
            serving = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
            serving.start()
            def request(path):
                with closing(http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)) as client:
                    client.request('GET', path)
                    response = client.getresponse()
                    return response.status, json.loads(response.read())
            def exhausted(*args, **kwargs):
                with patch('sprout_host.threading.Thread.start', side_effect=RuntimeError('simulated local quota')):
                    return run(*args, **kwargs)
            try:
                with patch('sprout_service.run', side_effect=exhausted):
                    self.assertEqual(request('/work'), (502, {'error': 'worker failed', 'code': 'io'}))
                self.assertEqual(request('/health'), (200, {'ok': True, 'protocol': 1}))
                self.assertEqual(request('/work'), (200, {'ok': True}))
            finally:
                server.shutdown(); server.server_close(); serving.join(2)
            self.assertFalse(serving.is_alive())


if __name__ == '__main__':
    unittest.main()
