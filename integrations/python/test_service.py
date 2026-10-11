import http.client
from contextlib import closing
import json
import os
import socket
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from sprout_service import SproutServer

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
        self.assertEqual(self.request('POST', '/', 'x'*1001)[0], 413)
        self.assertEqual(self.request('POST', '/', '{broken')[0], 400)
        self.assertEqual(self.request('POST', '/', '{"$sprout.decimal":"bad"}')[0], 400)
        self.assertEqual(self.request('POST', '/', '1e999')[0], 400)
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

if __name__ == '__main__': unittest.main()
