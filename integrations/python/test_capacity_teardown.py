"""Bounded rejection teardown controls; loopback only, no native worker."""
import socket
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from sprout_service import SproutServer


class SocketProbe:
    def __init__(self, raw):
        self.raw = raw
        self.half_closed = threading.Event()

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def shutdown(self, how):
        self.raw.shutdown(how)
        if how == socket.SHUT_WR: self.half_closed.set()


class CapacityTeardown(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-reject-')
        self.addCleanup(self.temp.cleanup)
        program = Path(self.temp.name) / 'never-run.sprout'
        program.write_text('fail "not executed"\n', encoding='utf-8')
        self.server = SproutServer(('127.0.0.1', 0), program, workers=1, metrics=True)
        self.addCleanup(self.server.server_close)
        self.assertTrue(self.server.capacity.acquire(blocking=False))
        self.addCleanup(self.server.capacity.release)

    def test_late_request_after_response_half_close_retains_complete_503(self):
        # An ordinary HTTP client connects before it sends its request. Hold
        # that write until the response has half-closed; the old full close
        # loses its unread response on Windows when this request then arrives.
        with patch('sprout_service.run') as worker:
            for delay in (0, .001, .010):
                with self.subTest(delay=delay):
                    client = socket.create_connection(self.server.server_address, timeout=1)
                    peer, address = self.server.get_request()
                    probe = SocketProbe(peer)
                    thread = threading.Thread(target=self.server.process_request, args=(probe, address))
                    thread.start()
                    try:
                        self.assertTrue(probe.half_closed.wait(1))
                        time.sleep(delay)
                        client.sendall(b'GET /metrics HTTP/1.1\r\nHost: fixture\r\n\r\n')
                        response = bytearray()
                        while len(response) < 4096:
                            chunk = client.recv(4096 - len(response))
                            if not chunk: break
                            response.extend(chunk)
                        self.assertEqual(response, b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                    finally:
                        client.close()
                        thread.join(timeout=1)
                        self.assertFalse(thread.is_alive(), 'rejection must finish without an application handler')
            worker.assert_not_called()
        metrics = self.server.metrics.snapshot()
        self.assertEqual(metrics['connections']['accepted'], 0)
        self.assertEqual(metrics['connections']['active'], 0)
        self.assertEqual(metrics['connections']['rejected_capacity'], 3)
        self.assertEqual(metrics['responses']['5xx'], 3)
        self.assertEqual(metrics['workers']['started'], 0)

    def test_byte_ceiling_does_not_admit_or_store_flooded_request(self):
        request = Mock()
        request.recv.side_effect = lambda limit: b'x' * limit
        with patch('sprout_service.time.monotonic', return_value=10):
            self.server.process_request(request, ('127.0.0.1', 0))
        sizes = [call.args[0] for call in request.recv.call_args_list]
        self.assertEqual(sum(sizes), 65536)
        self.assertTrue(all(0 < size <= 4096 for size in sizes))
        request.close.assert_called_once_with()
        self.assertFalse(self.server.capacity.acquire(blocking=False), 'rejection cannot release an accepted slot')

    def test_absolute_io_budget_is_not_reset_by_partial_reads(self):
        request = Mock()
        request.recv.return_value = b'partial request'
        with patch('sprout_service.time.monotonic', side_effect=[10, 10.01, 10.15, 10.201]):
            self.server.process_request(request, ('127.0.0.1', 0))
        self.assertEqual(request.recv.call_count, 1)
        self.assertAlmostEqual(request.settimeout.call_args_list[0].args[0], .19)
        self.assertAlmostEqual(request.settimeout.call_args_list[1].args[0], .05)
        request.close.assert_called_once_with()

    def test_send_half_close_and_receive_errors_all_close_without_worker_or_slot_release(self):
        for method in ('sendall', 'shutdown', 'recv'):
            with self.subTest(method=method):
                request = Mock()
                getattr(request, method).side_effect = OSError('fixture failure')
                with patch('sprout_service.run') as worker:
                    self.server.process_request(request, ('127.0.0.1', 0))
                    worker.assert_not_called()
                request.close.assert_called_once_with()
                self.assertFalse(self.server.capacity.acquire(blocking=False))

    def test_nonfinite_remaining_clock_stops_drain_without_unbounded_wait(self):
        request = Mock()
        with patch('sprout_service.time.monotonic', side_effect=[10, float('nan')]):
            self.server.process_request(request, ('127.0.0.1', 0))
        request.recv.assert_not_called()
        request.close.assert_called_once_with()

    def test_eof_stops_drain_and_clock_failure_still_closes(self):
        request = Mock()
        request.recv.return_value = b''
        self.server.process_request(request, ('127.0.0.1', 0))
        self.assertEqual(request.recv.call_count, 1)
        request.close.assert_called_once_with()
        request = Mock()
        with patch('sprout_service.time.monotonic', side_effect=OSError('clock unavailable')):
            self.server.process_request(request, ('127.0.0.1', 0))
        request.close.assert_called_once_with()


if __name__ == '__main__': unittest.main()
