import http.client
import io
from contextlib import closing
import json
import os
import socket
import signal
import queue
import subprocess
import sys
import time
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from sprout_service import SproutServer, SproutHandler, _DeadlineReader


def _wire_has_413_status(response, *, allow_partial=False):
    prefix = b'HTTP/1.0 413 '
    return response.startswith(prefix) or (allow_partial and bool(response) and prefix.startswith(response))


class WireStatusTests(unittest.TestCase):
    def test_413_reason_phrase_is_independent_of_status_code(self):
        for phrase in (b'Request Entity Too Large', b'Content Too Large'):
            with self.subTest(phrase=phrase):
                self.assertTrue(_wire_has_413_status(b'HTTP/1.0 413 ' + phrase + b'\r\nContent-Length: 0\r\n\r\n'))
        for response in (b'HTTP/1.0 400 Bad Request\r\n', b'HTTP/1.0 431 Too Large\r\n',
                         b'HTTP/1.0 4130 Too Large\r\n', b'HTTP/1.0  413 Too Large\r\n',
                         b'HTTP/1.0 413\r\n', b'HTTP/1.0 413X Too Large\r\n', b'413 Content Too Large\r\n'):
            with self.subTest(response=response):
                self.assertFalse(_wire_has_413_status(response))
                self.assertFalse(_wire_has_413_status(response, allow_partial=True))

    def test_partial_status_prefix_requires_observed_transport_close(self):
        for response in (b'H', b'HTTP/1.0 ', b'HTTP/1.0 4', b'HTTP/1.0 413'):
            with self.subTest(response=response):
                self.assertFalse(_wire_has_413_status(response))
                self.assertTrue(_wire_has_413_status(response, allow_partial=True))
        for response in (b'', b'HTTP/1.0 5', b'HTTP/1.0 412', b'HTTP/1.1 413'):
            with self.subTest(response=response):
                self.assertFalse(_wire_has_413_status(response, allow_partial=True))


class ReaderDeadlineTests(unittest.TestCase):
    def test_server_bind_does_not_depend_on_reverse_dns(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('sprout_service.socket.getfqdn', side_effect=AssertionError('unexpected reverse DNS')):
                with SproutServer(('127.0.0.1', 0), Path(directory) / 'unused.sprout') as server:
                    self.assertEqual(server.server_name, '127.0.0.1')
                    self.assertEqual(server.server_port, server.socket.getsockname()[1])
                    self.assertGreater(server.server_port, 0)

    def test_buffered_input_cannot_reset_or_skip_dispatch_deadline(self):
        timeouts = []
        connection = SimpleNamespace(gettimeout=lambda: 2,
                                     settimeout=timeouts.append)
        with patch('sprout_service.time.monotonic', side_effect=[10, 10.1, 11.1]):
            raw = _DeadlineReader(connection, io.BytesIO(b'header\nbody'), 1)
            with io.BufferedReader(raw) as reader:
                self.assertEqual(reader.readline(), b'header\n')
                self.assertEqual(reader.read(4), b'body')  # Already buffered.
                with self.assertRaises(socket.timeout): raw.finish_request()
        self.assertAlmostEqual(timeouts[0], .9)

    def test_valid_input_restores_response_timeout(self):
        timeouts = []
        connection = SimpleNamespace(gettimeout=lambda: 2,
                                     settimeout=timeouts.append)
        with patch('sprout_service.time.monotonic', side_effect=[10, 10.1, 10.2]):
            with _DeadlineReader(connection, io.BytesIO(b'x'), 1) as reader:
                self.assertEqual(reader.read(1), b'x')
                reader.finish_request()
        self.assertAlmostEqual(timeouts[0], .9)
        self.assertEqual(timeouts[-1], 2)

@unittest.skipUnless(os.environ.get("SPROUT_COMMAND"), "set SPROUT_COMMAND")
class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "api.sprout"
        self.path.write_text('make r = json_decode(read_input())\nshow json_encode({status: 200, body: r})\n', encoding='utf-8')
        self.server = SproutServer(('127.0.0.1', 0), self.path, command=os.environ['SPROUT_COMMAND'], max_body=1000)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()
    def request(self, method, path, body=None):
        with closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)) as client:
            client.request(method, path, body)
            response = client.getresponse(); return response.status, json.loads(response.read())
    def raw_request(self, wire):
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=4) as client:
            client.sendall(wire)
            chunks = []
            while True:
                data = client.recv(4096)
                if not data: return b''.join(chunks)
                chunks.append(data)
    def test_health_and_request(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'ok': True, 'protocol': 1}))
        status, data = self.request('POST', '/hello?tag=a&tag=b', '{"value":42}')
        self.assertEqual(status, 200); self.assertEqual(data['body']['value'], 42)
        self.assertEqual(data['query']['tag'], ['a', 'b'])
    def test_input_limits(self):
        # No unread body remains on this control, so require the full response.
        with patch('sprout_service.run') as worker:
            response = self.raw_request(b'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1001\r\n\r\n')
            headers, body = response.split(b'\r\n\r\n', 1)
            self.assertIn(b' 413 ', headers.split(b'\r\n')[0])
            self.assertEqual(json.loads(body), {'error': 'request too large'})
            worker.assert_not_called()
        self.assertEqual(self.request('POST', '/', '{broken')[0], 400)
        self.assertEqual(self.request('POST', '/', '{"$sprout.decimal":"bad"}')[0], 400)
        self.assertEqual(self.request('POST', '/', '1e999')[0], 400)
    def test_oversized_body_rejection_preserves_no_dispatch_and_recovery(self):
        decisions = queue.Queue()
        real_respond = SproutHandler.respond
        def observe(handler, status, body, headers=None):
            try:
                return real_respond(handler, status, body, headers)
            finally:
                decisions.put((status, body))
        with patch('sprout_service.run') as worker, patch.object(SproutHandler, 'respond', observe):
            with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=1) as client:
                # Retain a real oversized body. Immediate rejection leaves it
                # unread; TCP closure may replace some or all response bytes.
                client.sendall(b'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1001\r\n\r\n' + b'x' * 1001)
                chunks = []; close_error = None
                try:
                    while True:
                        data = client.recv(4096)
                        if not data: break
                        chunks.append(data)
                except (ConnectionResetError, ConnectionAbortedError) as error:
                    close_error = error
            response = b''.join(chunks)
            self.assertEqual(decisions.get(timeout=1), (413, {'error': 'request too large'}))
            if response:
                self.assertTrue(_wire_has_413_status(response, allow_partial=close_error is not None),
                                f'unexpected wire response: {response!r}')
            if close_error is None:
                headers, body = response.split(b'\r\n\r\n', 1)
                self.assertEqual(json.loads(body), {'error': 'request too large'})
            else:
                print(f'oversized body: observed 413, wire_bytes={len(response)}, '
                      f'close={type(close_error).__name__}, errno={close_error.errno}')
            worker.assert_not_called()
        self.assertEqual(self.request('GET', '/health')[0], 200)
        status, body = self.request('POST', '/recovery', '{"value":42}')
        self.assertEqual(status, 200); self.assertEqual(body['body'], {'value': 42})
    def test_deep_small_body_returns_400_without_worker(self):
        for depth in (128, 129):
            with self.subTest(depth=depth):
                body = '[' * depth + '0' + ']' * depth
                self.assertLess(len(body), self.server.max_body)
                with patch('sprout_service.run') as worker:
                    self.assertEqual(self.request('POST', '/', body)[0], 400)
                    worker.assert_not_called()
        self.assertEqual(self.request('GET', '/health')[0], 200)
    def test_envelope_input_byte_cap_returns_413_without_worker(self):
        self.server.max_body = 1048576
        body = '"' + 'a' * (self.server.max_body - 2) + '"'
        self.assertEqual(len(body), self.server.max_body)
        with patch('sprout_service.run') as worker:
            self.assertEqual(self.request('POST', '/', body)[0], 413)
            worker.assert_not_called()
    def test_invalid_header_and_recovery(self):
        self.path.write_text('show json_encode({status: 200, headers: {x: "bad\\r\\nInjected: yes"}, body: 42})\n', encoding='utf-8')
        self.assertEqual(self.request('GET', '/')[0], 502)
        self.assertEqual(self.request('GET', '/health')[0], 200)
    def test_runtime_failure(self):
        self.path.write_text('fail "internal detail"\n', encoding='utf-8')
        status, data = self.request('GET', '/')
        self.assertEqual(status, 502); self.assertNotIn('internal detail', json.dumps(data))
    def test_trickling_headers_and_body_expire_without_worker(self):
        self.server.request_read_timeout = .3
        for prefix in [b'GET / HTTP/1.1\r\nX-Slow: ',
                       b'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n']:
            with self.subTest(prefix=prefix[:12]), patch('sprout_service.run') as worker:
                with closing(socket.create_connection(('127.0.0.1', self.server.server_port), timeout=1)) as client:
                    client.sendall(prefix)
                    stop = threading.Event()
                    def trickle():
                        while not stop.wait(.02):
                            try: client.sendall(b' ')
                            except OSError: return
                    sender = threading.Thread(target=trickle, daemon=True); sender.start()
                    started = time.monotonic()
                    try:
                        try:
                            while client.recv(4096): pass
                        except (ConnectionResetError, ConnectionAbortedError):
                            # Closing unread input can produce a reset or Windows
                            # abort instead of EOF. Deadline and no-dispatch
                            # assertions remain unchanged below.
                            pass
                        self.assertLess(time.monotonic() - started, .9)
                    finally:
                        stop.set(); sender.join(1)
                    self.assertFalse(sender.is_alive())
                worker.assert_not_called()
        self.assertEqual(self.request('GET', '/health')[0], 200)
    def test_shutdown_wait_for_trickling_reader_is_bounded(self):
        self.server.request_read_timeout = .3
        closed = threading.Event(); stop = threading.Event()
        with patch('sprout_service.run') as worker:
            client = socket.create_connection(('127.0.0.1', self.server.server_port), timeout=1)
            client.sendall(b'GET / HTTP/1.1\r\nX-Slow: ')
            def trickle():
                while not stop.wait(.02):
                    try: client.sendall(b' ')
                    except OSError: return
            def close():
                self.server.shutdown(); self.server.server_close(); closed.set()
            sender = threading.Thread(target=trickle, daemon=True); sender.start()
            closer = None
            try:
                deadline = time.monotonic() + 1
                while self.server.capacity._value == 8 and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertLess(self.server.capacity._value, 8, 'request was never accepted')
                closer = threading.Thread(target=close, daemon=True); closer.start()
                self.assertTrue(closed.wait(1.5), 'shutdown was held open by a trickling request')
            finally:
                stop.set(); client.close(); sender.join(1)
                if closer: closer.join(2)
            self.assertFalse(sender.is_alive())
            self.assertFalse(closer.is_alive())
            worker.assert_not_called()
    def test_listener_close_drains_an_accepted_worker(self):
        entered = threading.Event(); release = threading.Event(); closed = threading.Event()
        results = []
        def worker(*args, **kwargs):
            entered.set()
            if not release.wait(3): raise AssertionError('test worker was not released')
            return {'status': 200, 'body': {'finished': True}}
        def close():
            self.server.server_close(); closed.set()
        with patch('sprout_service.run', side_effect=worker):
            client = threading.Thread(target=lambda: results.append(self.request('GET', '/drain')))
            client.start()
            try:
                self.assertTrue(entered.wait(2))
                self.server.shutdown()
                closer = threading.Thread(target=close); closer.start()
                self.assertFalse(closed.wait(.1), 'close returned while an accepted worker was active')
            finally:
                release.set(); client.join(3)
                if 'closer' in locals(): closer.join(3)
            self.assertTrue(closed.is_set())
            self.assertFalse(client.is_alive())
            self.assertEqual(results, [(200, {'finished': True})])
    @unittest.skipIf(os.name == 'nt', 'Windows TerminateProcess does not deliver POSIX SIGTERM')
    def test_cli_sigterm_drains_a_live_native_worker(self):
        self.path.write_text('write("started.txt", "yes")\nwait(1)\n'
                             'show json_encode({status: 200, body: {finished: yes}})\n', encoding='utf-8')
        script = str(Path(__file__).with_name('sprout_service.py').resolve())
        bootstrap_trace = self.path.parent / 'bootstrap.trace'
        # Preserve ordinary script argv/import lookup while capturing a stuck
        # bootstrap's Python stack. Readiness cancels the diagnostic timer via
        # SIGUSR1, keeping it separate from the native worker's drain deadline.
        bootstrap = ('import faulthandler, os, runpy, signal, sys\n'
                     'signal.signal(signal.SIGUSR1, lambda *_: faulthandler.cancel_dump_traceback_later())\n'
                     'trace = open(sys.argv.pop(1), "w")\n'
                     'faulthandler.dump_traceback_later(5, file=trace)\n'
                     'script = sys.argv.pop(1)\n'
                     'sys.argv[0] = script\n'
                     'sys.path[0] = os.path.dirname(script)\n'
                     'try:\n'
                     '    runpy.run_path(script, run_name="__main__")\n'
                     'finally:\n'
                     '    faulthandler.cancel_dump_traceback_later()\n'
                     '    trace.close()\n')
        command = [sys.executable, '-c', bootstrap, str(bootstrap_trace), script,
                                    str(self.path), '--command', os.environ['SPROUT_COMMAND'],
                                    '--port', '0', '--workers', '1', '--timeout-ms', '2000',
                                    '--max-body', '1000', '--allow-io']
        process = subprocess.Popen(command,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        lines = queue.Queue(); results = queue.Queue(); diagnostics = []
        def read_stdout():
            for line in process.stdout:
                lines.put(line)
            lines.put('')
        def read_stderr():
            while True:
                chunk = process.stderr.buffer.read1(4096)
                if not chunk: return
                diagnostics.append(chunk.decode('utf-8', errors='replace'))
                # Diagnostics stay bounded even when bootstrap fails noisily.
                diagnostics[:] = [''.join(diagnostics)[-8192:]]
        reader = threading.Thread(target=read_stdout, daemon=True)
        error_reader = threading.Thread(target=read_stderr, daemon=True)
        reader.start(); error_reader.start(); client = None
        try:
            deadline = time.monotonic() + 15
            port = None; output = []; ready = False; last_error = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    line = lines.get(timeout=min(.1, max(.001, deadline - time.monotonic())))
                except queue.Empty:
                    line = None
                if line:
                    output.append(line.strip()); output[:] = output[-8:]
                    if line.startswith('Sprout worker service at http://'):
                        port = int(line.strip().rsplit(':', 1)[1])
                if port is not None:
                    try:
                        with closing(http.client.HTTPConnection('127.0.0.1', port, timeout=.5)) as connection:
                            connection.request('GET', '/health')
                            response = connection.getresponse()
                            ready = response.status == 200 and json.loads(response.read()) == {'ok': True, 'protocol': 1}
                        if ready: break
                    except (OSError, ValueError, http.client.HTTPException) as error:
                        last_error = repr(error)
            if not ready and process.poll() is not None:
                error_reader.join(.5)
            stack = ''
            if not ready and bootstrap_trace.exists():
                with bootstrap_trace.open('rb') as trace:
                    stack = trace.read(8192).decode('utf-8', errors='replace')
            self.assertTrue(ready, f'service never became ready; exit={process.poll()}, '
                                  f'pid={process.pid}, python={sys.executable!r}, script={script!r}, '
                                  f'stdout={output!r}, stderr={diagnostics!r}, last_error={last_error}, '
                                  f'bootstrap_stack={stack!r}')
            process.send_signal(signal.SIGUSR1)
            def request():
                try:
                    with closing(http.client.HTTPConnection('127.0.0.1', port, timeout=4)) as connection:
                        connection.request('GET', '/drain')
                        response = connection.getresponse()
                        results.put((response.status, json.loads(response.read())))
                except Exception as error: results.put(error)
            client = threading.Thread(target=request); client.start()
            deadline = time.monotonic() + 2
            while not (self.path.parent / 'started.txt').exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue((self.path.parent / 'started.txt').exists())
            process.terminate()
            self.assertEqual(results.get(timeout=3), (200, {'finished': True}))
            self.assertEqual(process.wait(timeout=3), 0)
            error_reader.join(3)
            self.assertEqual(''.join(diagnostics), '')
        finally:
            if process.poll() is None: process.kill(); process.wait(timeout=3)
            if client: client.join(3)
            reader.join(3); error_reader.join(3)
            process.stdout.close(); process.stderr.close()
        self.assertFalse(reader.is_alive())
        self.assertFalse(error_reader.is_alive())
    def test_invalid_framing_never_dispatches(self):
        for field in (b'Content-Length: +0', b'Content-Length: -0',
                      b'Content-Length: 0\r\nTransfer-Encoding:',
                      b'Transfer-Encoding:\r\nTransfer-Encoding: chunked'):
            with self.subTest(field=field), patch('sprout_service.run') as worker:
                wire = b'POST / HTTP/1.1\r\nHost: localhost\r\n' + field + b'\r\n\r\n'
                self.assertIn(b' 400 ', self.raw_request(wire).split(b'\r\n')[0])
                worker.assert_not_called()
        self.assertEqual(self.request('GET', '/health')[0], 200)
    def test_malformed_target_returns_400(self):
        with patch('sprout_service.run') as worker:
            wire = b'GET http://[ HTTP/1.1\r\nHost: localhost\r\n\r\n'
            self.assertIn(b' 400 ', self.raw_request(wire).split(b'\r\n')[0])
            worker.assert_not_called()
    def test_bodyless_statuses_have_no_wire_body(self):
        for status in (204, 205, 304):
            with self.subTest(status=status), patch('sprout_service.run', return_value={'status': status, 'body': {'unexpected': 42}}):
                headers, body = self.raw_request(b'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n').split(b'\r\n\r\n', 1)
                self.assertEqual(body, b'')
                if status in (204, 304): self.assertNotIn(b'Content-Length:', headers)
    def test_head_reports_length_without_wire_body(self):
        reply = {'status': 200, 'body': {'value': 42}}
        with patch('sprout_service.run', return_value=reply):
            get_head, get_body = self.raw_request(b'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n').split(b'\r\n\r\n', 1)
            head_head, head_body = self.raw_request(b'HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n').split(b'\r\n\r\n', 1)
            self.assertEqual(head_body, b'')
            self.assertIn(('Content-Length: '+str(len(get_body))).encode(), head_head)
    def test_contacts_sqlite_application(self):
        example = Path(__file__).resolve().parents[2] / 'examples/services/contacts.sprout'
        self.path.write_text(example.read_text(encoding='utf-8'), encoding='utf-8')
        self.server.allow_io = True
        self.assertEqual(self.request('GET', '/contacts'), (200, {'contacts': []}))
        data = json.dumps({'name': "Robert'); DROP TABLE contacts;--", 'email': 'robert@example.test'})
        self.assertEqual(self.request('POST', '/contacts', data)[0], 201)
        self.assertEqual(self.request('POST', '/contacts', data)[0], 409)
        status, result = self.request('GET', '/contacts')
        self.assertEqual(status, 200); self.assertEqual(len(result['contacts']), 1)
        self.assertEqual(result['contacts'][0][1], "Robert'); DROP TABLE contacts;--")
        self.assertEqual(self.request('POST', '/contacts', '{}')[0], 400)
    def test_contacts_database_busy_is_503_then_recovers(self):
        example = Path(__file__).resolve().parents[2] / 'examples/services/contacts.sprout'
        self.path.write_text(example.read_text(encoding='utf-8'), encoding='utf-8')
        self.server.allow_io = True
        self.assertEqual(self.request('GET', '/contacts')[0], 200)
        with closing(sqlite3.connect(self.path.parent / 'contacts.sqlite')) as database:
            database.execute('BEGIN EXCLUSIVE')
            try:
                data = json.dumps({'name': 'Busy', 'email': 'busy@example.test'})
                self.assertEqual(self.request('POST', '/contacts', data)[0], 503)
            finally:
                database.rollback()
        self.assertEqual(self.request('POST', '/contacts', data)[0], 201)
        self.assertEqual(self.request('GET', '/contacts')[1]['contacts'][0][1], 'Busy')
    def test_explicit_state_directory_keeps_database_outside_source(self):
        state = self.path.parent / 'state'; state.mkdir()
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.server = SproutServer(('127.0.0.1', 0), self.path, command=os.environ['SPROUT_COMMAND'],
                                   allow_io=True, cwd=state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        example = Path(__file__).resolve().parents[2] / 'examples/services/contacts.sprout'
        self.path.write_text(example.read_text(encoding='utf-8'), encoding='utf-8')
        data = json.dumps({'name': 'Separate state', 'email': 'state@example.test'})
        self.assertEqual(self.request('POST', '/contacts', data)[0], 201)
        self.assertEqual(self.request('GET', '/contacts')[1]['contacts'][0][1], 'Separate state')
        self.assertTrue((state / 'contacts.sqlite').is_file())
        self.assertFalse((self.path.parent / 'contacts.sqlite').exists())

if __name__ == '__main__': unittest.main()
