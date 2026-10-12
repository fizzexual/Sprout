"""Bounded loopback checks for opt-in, content-free service telemetry."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
import http.client
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import sprout_service
from sprout_host import SproutError
from sprout_service import SproutServer


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.program = Path(self.temp.name) / 'private-program.sprout'
        self.program.write_text('make request = json_decode(read_input())\nshow json_encode({status: 200, body: {ok: yes}})\n', encoding='utf-8')
        self.server = SproutServer(('127.0.0.1', 0), self.program, workers=2, metrics=True)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01})
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        with closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)) as client:
            client.request(method, path, body, headers or {})
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read()

    def drained_snapshot(self):
        deadline = time.monotonic() + 2
        while self.server.metrics.snapshot()['connections']['active']:
            if time.monotonic() >= deadline:
                self.fail('accepted connection handlers did not drain')
            time.sleep(.005)
        return self.server.metrics.snapshot()

    def test_metrics_are_read_only_no_store_and_never_launch_a_worker(self):
        with patch('sprout_service.run') as worker:
            status, headers, raw = self.request('GET', '/metrics?token=private-query')
            self.assertEqual(status, 200)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            value = json.loads(raw)
            self.assertEqual(value['schema'], 1)
            self.assertEqual(value['workers']['started'], 0)
            self.assertNotIn(b'private-query', raw)
            self.assertEqual(self.request('HEAD', '/metrics')[2], b'')
            status, headers, _ = self.request('POST', '/metrics')
            self.assertEqual(status, 405)
            self.assertEqual(headers['Allow'], 'GET, HEAD')
            worker.assert_not_called()

    def test_default_keeps_application_metrics_route(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.server = SproutServer(('127.0.0.1', 0), self.program)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01})
        self.thread.start()
        with patch('sprout_service.run', return_value={'status': 200, 'body': 'application route'}) as worker:
            status, _, raw = self.request('GET', '/metrics')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw), 'application route')
            self.assertIsNone(self.server.metrics)
            self.assertEqual(worker.call_args.args[1]['path'], '/metrics')

    def test_fixed_categories_do_not_retain_payload_headers_paths_or_diagnostics(self):
        with patch('sprout_service.run', return_value={'status': 201, 'body': {'result': 'private-response'}}):
            for index in range(5):
                self.assertEqual(self.request('POST', '/private-path-%d?secret=private-query' % index,
                    '{"secret":"private-input"}', {'Authorization': 'Bearer private-header'})[0], 201)
        error = SproutError('private-diagnostics', 'io')
        with patch('sprout_service.run', side_effect=error):
            self.assertEqual(self.request('GET', '/private-error-path')[0], 502)
        value = self.drained_snapshot()
        raw = json.dumps(value, allow_nan=False)
        for secret in ('private-', str(self.program), 'Authorization', 'Bearer'):
            self.assertNotIn(secret, raw)
        self.assertEqual(set(value['responses']), {'2xx', '3xx', '4xx', '5xx', 'other'})
        self.assertEqual(value['workers']['started'], 6)
        self.assertEqual(value['workers']['completed'], 5)
        self.assertEqual(value['workers']['failed'], 1)
        self.assertEqual(value['connections']['active'], 0)
        self.assertEqual(value['workers']['active'], 0)
        value['workers']['failed'] = 999
        self.assertEqual(self.server.metrics.snapshot()['workers']['failed'], 1)

    def test_worker_timeout_and_invalid_response_are_distinct(self):
        with patch('sprout_service.run', side_effect=SproutError('private-timeout', 'timeout')):
            self.assertEqual(self.request('GET', '/slow')[0], 504)
        with patch('sprout_service.run', return_value={'status': True, 'body': 'bad'}):
            self.assertEqual(self.request('GET', '/bad')[0], 502)
        value = self.drained_snapshot()
        self.assertEqual(value['workers']['started'], 2)
        self.assertEqual(value['workers']['completed'], 1)
        self.assertEqual(value['workers']['failed'], 1)
        self.assertEqual(value['workers']['timed_out'], 1)
        self.assertEqual(value['workers']['invalid_responses'], 1)
        self.assertEqual(value['responses']['5xx'], 2)
        self.assertEqual(value['workers']['active'], 0)

    def test_protocol_rejections_and_base_handler_errors_have_no_worker_invocation(self):
        with patch('sprout_service.run') as worker:
            self.assertEqual(self.request('POST', '/', '{broken')[0], 400)
            self.assertEqual(self.request('OPTIONS', '/')[0], 501)
            self.assertEqual(self.request('GET', '/health')[0], 200)
            worker.assert_not_called()
        value = self.drained_snapshot()
        self.assertEqual(value['workers']['started'], 0)
        self.assertEqual(value['responses']['4xx'], 1)
        self.assertEqual(value['responses']['5xx'], 1)
        self.assertEqual(value['responses']['2xx'], 1)

    def test_concurrency_capacity_rejection_and_recovery_balance_all_gauges(self):
        running = threading.Barrier(3)
        release = threading.Event()
        def worker(*_, **__):
            running.wait(timeout=2)
            if not release.wait(timeout=2): raise AssertionError('fixture worker release timed out')
            return {'status': 200, 'body': {'ok': True}}
        with patch('sprout_service.run', side_effect=worker), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.request, 'GET', '/work') for _ in range(2)]
            try:
                running.wait(timeout=2)
                current = self.server.metrics.snapshot()
                self.assertEqual(current['workers']['active'], 2)
                self.assertEqual(current['connections']['active'], 2)
                self.assertEqual(self.request('GET', '/metrics')[0], 503)
            finally:
                release.set()
            for future in futures: self.assertEqual(future.result(timeout=2)[0], 200)
        value = self.drained_snapshot()
        self.assertEqual(value['connections']['accepted'], 2)
        self.assertEqual(value['connections']['rejected_capacity'], 1)
        self.assertEqual(value['connections']['peak_active'], 2)
        self.assertEqual(value['workers']['started'], value['workers']['completed'])
        self.assertEqual(value['workers']['active'], 0)
        self.assertEqual(value['responses']['5xx'], 1)
        self.assertEqual(self.request('GET', '/metrics')[0], 200)

    def test_thread_start_failure_releases_admission_and_metrics(self):
        with patch('sprout_service.http.server.ThreadingHTTPServer.process_request', side_effect=RuntimeError('fixture')):
            with self.assertRaisesRegex(RuntimeError, 'fixture'):
                self.server.process_request(object(), ('127.0.0.1', 0))
        value = self.server.metrics.snapshot()
        self.assertEqual(value['connections']['accepted'], 1)
        self.assertEqual(value['connections']['active'], 0)
        acquired = [self.server.capacity.acquire(blocking=False) for _ in range(2)]
        self.assertEqual(acquired, [True, True])
        for _ in acquired: self.server.capacity.release()

    def test_many_connections_keep_fixed_counters_and_admission_gauges_balanced(self):
        calls = []
        lock = threading.Lock()
        def worker(*_, **__):
            with lock: calls.append(True)
            time.sleep(.01)
            return {'status': 200, 'body': None}
        def observe(index):
            try:
                return self.request('GET', '/dynamic-%d' % index)[0]
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError) as error:
                # An early capacity rejection can close unread bytes before
                # its attempted 503 arrives. Retain the actual transport outcome;
                # do not invent a received status or retry this request.
                return type(error).__name__
        with patch('sprout_service.run', side_effect=worker), ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(observe, i) for i in range(32)]
            statuses = [f.result(timeout=2) for f in futures]
        self.assertTrue(set(statuses) <= {200, 503, 'ConnectionResetError', 'ConnectionAbortedError', 'BrokenPipeError'})
        value = self.drained_snapshot()
        self.assertEqual(value['connections']['accepted'] + value['connections']['rejected_capacity'], 32)
        self.assertEqual(value['connections']['accepted'], len(calls))
        self.assertEqual(value['responses']['2xx'], len(calls))
        self.assertEqual(value['responses']['5xx'], value['connections']['rejected_capacity'])
        self.assertLessEqual(statuses.count(200), value['responses']['2xx'])
        self.assertLessEqual(statuses.count(503), value['responses']['5xx'])
        self.assertEqual(value['workers']['started'], len(calls))
        self.assertEqual(value['workers']['completed'], len(calls))
        self.assertEqual(value['workers']['active'], 0)
        self.assertLessEqual(value['connections']['peak_active'], 2)
        self.assertLessEqual(value['workers']['peak_active'], 2)

    def test_telemetry_failure_cannot_leak_admission_after_thread_start_failure(self):
        with patch('sprout_service.http.server.ThreadingHTTPServer.process_request', side_effect=RuntimeError('thread fixture')), \
             patch.object(self.server.metrics, 'finish_connection', side_effect=RuntimeError('metrics fixture')):
            with self.assertRaisesRegex(RuntimeError, 'metrics fixture'):
                self.server.process_request(object(), ('127.0.0.1', 0))
        acquired = [self.server.capacity.acquire(blocking=False) for _ in range(2)]
        self.assertEqual(acquired, [True, True])
        for _ in acquired: self.server.capacity.release()

    def test_telemetry_admission_failure_releases_capacity_without_false_gauge_balance(self):
        with patch.object(self.server.metrics, 'accept', side_effect=MemoryError('fixture allocation')):
            with self.assertRaises(MemoryError):
                self.server.process_request(object(), ('127.0.0.1', 0))
        value = self.server.metrics.snapshot()
        self.assertEqual(value['connections']['accepted'], 0)
        self.assertEqual(value['connections']['active'], 0)
        acquired = [self.server.capacity.acquire(blocking=False) for _ in range(2)]
        self.assertEqual(acquired, [True, True])
        for _ in acquired: self.server.capacity.release()

    def test_telemetry_handler_clock_failure_still_releases_admission(self):
        self.assertTrue(self.server.capacity.acquire(blocking=False))
        self.server.metrics.accept()
        owned, peer = socket.socketpair()
        with closing(owned), closing(peer):
            peer.settimeout(2)
            with patch('sprout_service.time.monotonic', side_effect=OSError('fixture clock failure')):
                with self.assertRaises(OSError):
                    self.server.process_request_thread(owned, ('127.0.0.1', 0))
            self.assertEqual(owned.fileno(), -1)
            self.assertEqual(peer.recv(1), b'')
        self.assertEqual(self.server.metrics.snapshot()['connections']['active'], 0)
        acquired = [self.server.capacity.acquire(blocking=False) for _ in range(2)]
        self.assertEqual(acquired, [True, True])
        for _ in acquired: self.server.capacity.release()

    def test_unexpected_worker_failure_releases_worker_gauge(self):
        with patch('sprout_service.run', side_effect=OSError('fixture private failure')):
            with self.assertRaises(OSError): self.server.run_worker({'method': 'GET', 'path': '/'})
        value = self.server.metrics.snapshot()
        self.assertEqual(value['workers']['active'], 0)
        self.assertEqual(value['workers']['failed'], 1)
        json.dumps(value, allow_nan=False)

    def test_unavailable_finish_timing_does_not_lose_outcomes_or_leave_active_gauges(self):
        self.server.metrics.accept()
        started = self.server.metrics.start_worker()
        with patch('sprout_service.time.monotonic', side_effect=OSError('fixture clock failure')):
            self.server.metrics.finish_connection(started)
            self.server.metrics.finish_worker(started, 'completed')
            value = self.server.metrics.snapshot()
        self.assertIsNone(value['uptime_seconds'])
        self.assertEqual(value['connections']['active'], 0)
        self.assertEqual(value['workers']['active'], 0)
        self.assertEqual(value['workers']['completed'], 1)
        self.assertEqual(value['workers']['failed'], 0)
        self.assertEqual(value['durations']['connection_timing_failures'], 1)
        self.assertEqual(value['durations']['worker_timing_failures'], 1)
        json.dumps(value, allow_nan=False)

    def test_missing_finish_timing_preserves_sdk_result_and_rejects_nonfinite_duration(self):
        failing = threading.Event()
        def monotonic():
            if failing.is_set(): raise OSError('fixture timing unavailable')
            return time.monotonic()
        def worker(*_, **__):
            failing.set()
            return {'status': 200, 'body': {'committed': True}}
        with patch('sprout_service.time', SimpleNamespace(monotonic=monotonic)), \
             patch('sprout_service.run', side_effect=worker):
            self.assertEqual(self.server.run_worker({'method': 'POST'}), {'status': 200, 'body': {'committed': True}})
        self.assertEqual(self.server.metrics.snapshot()['workers']['active'], 0)
        for value in (float('nan'), float('inf'), float('-inf'), -1):
            with patch('sprout_service.time.monotonic', return_value=value):
                self.assertIsNone(self.server.metrics._elapsed(1))

    def test_metrics_use_monotonic_time_and_cli_is_explicit_opt_in(self):
        clock = SimpleNamespace(monotonic=time.monotonic,
                                time=Mock(side_effect=AssertionError('metrics must not use wall time')))
        with patch('sprout_service.time', clock):
            with patch('sprout_service.run', return_value={'status': 200, 'body': None}):
                self.assertEqual(self.request('GET', '/work')[0], 200)
            value = self.drained_snapshot()
            self.assertGreaterEqual(value['durations']['worker_total_seconds'], 0)
            self.assertGreaterEqual(value['durations']['connection_total_seconds'], 0)
        for flags, enabled in (([], False), (['--metrics'], True)):
            with patch('sys.argv', ['sprout_service.py', str(self.program), *flags]), \
                 patch('sprout_service.SproutServer') as factory, patch('sprout_service.signal.signal'), \
                 redirect_stdout(io.StringIO()):
                sprout_service.main()
                self.assertIs(factory.call_args.kwargs['metrics'], enabled)
        for bad in (1, 'true', None):
            with self.assertRaisesRegex(ValueError, 'metrics must be a boolean'):
                SproutServer(('127.0.0.1', 0), self.program, metrics=bad)

    @unittest.skipUnless(os.environ.get('SPROUT_COMMAND'), 'set SPROUT_COMMAND')
    def test_real_native_worker_and_metrics_endpoint(self):
        self.server.command = os.environ['SPROUT_COMMAND']
        self.assertEqual(self.request('GET', '/real-native')[0], 200)
        value = self.drained_snapshot()
        self.assertEqual(value['workers']['started'], 1)
        self.assertEqual(value['workers']['completed'], 1)
        self.assertEqual(value['workers']['active'], 0)
        self.assertEqual(self.request('GET', '/metrics')[0], 200)


if __name__ == '__main__': unittest.main()
