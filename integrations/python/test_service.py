import http.client
from contextlib import closing
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
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
    def test_invalid_header_and_recovery(self):
        self.path.write_text('show json_encode({status: 200, headers: {x: "bad\\r\\nInjected: yes"}, body: 42})\n', encoding='utf-8')
        self.assertEqual(self.request('GET', '/')[0], 502)
        self.assertEqual(self.request('GET', '/health')[0], 200)
    def test_runtime_failure(self):
        self.path.write_text('fail "internal detail"\n', encoding='utf-8')
        status, data = self.request('GET', '/')
        self.assertEqual(status, 502); self.assertNotIn('internal detail', json.dumps(data))
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

if __name__ == '__main__': unittest.main()
