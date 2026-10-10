"""Native I/O contracts; isolated local HTTP server and real subprocesses.

Usage: python src/tests/stdlib_production_test.py <built-sprout> [--no-sqlite]
The --no-sqlite flag verifies the explicit unavailable result in minimal builds.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SQLITE = '--no-sqlite' not in sys.argv
if not SQLITE:
    sys.argv.remove('--no-sqlite')
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              Path(__file__).parents[1] / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()


def quote(value):
    return json.dumps(value, ensure_ascii=False)


def python_command(*arguments):
    # Child programs choose their own text encoding; make this fixture explicit.
    return [sys.executable, '-X', 'utf8', *arguments]


def exact_values(value):
    if isinstance(value, dict):
        if set(value) == {'$sprout.integer'}:
            return int(value['$sprout.integer'])
        if set(value) == {'$sprout.bytes'}:
            return bytes.fromhex(value['$sprout.bytes'])
        return {k: exact_values(v) for k, v in value.items()}
    if isinstance(value, list):
        return [exact_values(v) for v in value]
    return value


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self, head=False):
        if self.path == '/slow':
            time.sleep(.4)
        if self.path == '/binary':
            body = b'before\0after'
        elif self.path == '/large':
            body = b'x' * 20000
        else:
            body = json.dumps({'method': self.command, 'path': self.path,
                               'header': self.headers.get('X-Sprout'),
                               'body': self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()}).encode()
        status = 404 if self.path == '/missing' else 302 if self.path == '/redirect' else 200
        try:
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Content-Type', 'application/json')
            self.send_header('X-Duplicate', 'first')
            self.send_header('X-Duplicate', 'second')
            if status == 302:
                self.send_header('Location', '/ok')
            self.end_headers()
            if not head:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request

    def do_HEAD(self):
        self.handle_request(head=True)


class ProductionLibrary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-stdlib-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_code(self, code, *flags):
        source = self.root / 'app.sprout'
        source.write_text(code, encoding='utf-8')
        return subprocess.run([str(BINARY), *flags, str(source)], cwd=self.root,
                              capture_output=True, text=True, encoding='utf-8', timeout=10)

    def evaluate(self, expression, setup='', *flags):
        result = self.run_code(setup + f'\nshow json_encode({expression})\n', *flags)
        self.assertEqual(result.returncode, 0, result.stderr)
        return exact_values(json.loads(result.stdout))

    def test_csv_roundtrip_empty_quotes_newlines_unicode(self):
        rows = [['name', 'value'], ['', 'a,b'], ['quotes', 'a"b'], ['lines', 'a\r\nb'], ['Юникод', '🌱']]
        actual = self.evaluate(f'csv_parse(csv_write({quote(rows)}))')
        self.assertEqual(actual, rows)
        self.assertEqual(self.evaluate('csv_parse("a,b,\\r\\n,,\\r\\n")'), [['a', 'b', ''], ['', '', '']])
        self.assertEqual(self.evaluate('csv_parse("")'), [])

    def test_csv_delimiter_and_malformed_input(self):
        self.assertEqual(self.evaluate('csv_parse("a;b\\n", ";")'), [['a', 'b']])
        for text in ['"unclosed', 'x"oops', '"closed"suffix']:
            result = self.run_code(f'show csv_parse({quote(text)})\n')
            self.assertEqual(result.returncode, 1)
            self.assertIn('CSV', result.stderr)

    def test_atomic_file_write_read_and_replacement(self):
        result = self.evaluate('file_read("дані 🌱.txt")', 'make a = file_write("дані 🌱.txt", "first")\nmake b = file_write("дані 🌱.txt", "new 🌱\\n")\n')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['text'], 'new 🌱\n')
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_file_errors_never_report_success(self):
        for expression in ['file_read("missing")', 'file_write("missing/file", "x")', 'file_remove("missing")']:
            with self.subTest(expression=expression):
                result = self.evaluate(expression)
                self.assertFalse(result['ok'])
                self.assertTrue(result['error'])
        target = self.root / 'binary'; target.write_bytes(b'abc\0def')
        self.assertFalse(self.evaluate('file_read("binary")')['ok'])
        target.write_text('abcdef')
        self.assertFalse(self.evaluate('file_read("binary", {max_bytes: 2})')['ok'])

    def test_file_directory_and_move(self):
        setup = 'make dir = file_mkdir("data")\nmake a = file_write("data/z", "x")\nmake b = file_write("data/a", "y")\nmake moved = file_move("data/z", "data/b")\n'
        self.assertEqual(self.evaluate('file_list("data")', setup)['entries'], ['a', 'b'])
        self.assertTrue(self.evaluate('file_info("data")')['is_dir'])
        self.assertFalse(self.evaluate('file_info("missing")')['exists'])
        self.assertFalse(self.evaluate('file_remove("data")')['ok'])  # never recursive
        self.assertTrue(self.evaluate('file_remove("data/a")')['ok'])

    def test_binary_files_and_http_preserve_nul_bytes(self):
        payload = bytes([0, 255, 42, 13, 10])
        setup = 'make written = file_write("binary.dat", bytes([0, 255, 42, 13, 10]))\n'
        self.assertEqual(self.evaluate('file_read("binary.dat", {binary: yes}).data', setup), payload)
        self.assertEqual((self.root / 'binary.dat').read_bytes(), payload)
        response = self.evaluate(f'request({quote(self.url + "/binary")}, {{binary: yes}})')
        self.assertTrue(response['ok'], response.get('error'))
        self.assertEqual(response['body'], b'before\0after')
        response = self.evaluate(f'request({quote(self.url + "/echo")}, {{method: "POST", body: bytes([65, 0, 66])}})')
        self.assertTrue(response['ok'], response.get('error'))
        self.assertEqual(json.loads(response['body'])['body'], 'A\0B')

    def test_process_literal_arguments_exit_and_stderr(self):
        arg = 'spaces "quotes" \\slash & $(echo nope); 🌱'
        script = 'import sys,json; print(json.dumps(sys.argv[1:],ensure_ascii=False)); print("problem",file=sys.stderr); sys.exit(7)'
        result = self.evaluate(f'process({quote(python_command("-c", script, arg, ""))})')
        self.assertFalse(result['ok'])
        self.assertEqual(result['exit'], 7)
        self.assertEqual(json.loads(result['stdout']), [arg, ''])
        self.assertEqual(result['stderr'].strip(), 'problem')
        self.assertIsNone(result['error'])

    def test_process_stdin_cwd_and_dual_pipe_capture(self):
        script = 'import sys,os; print(os.getcwd()); print(sys.stdin.read()); sys.stdout.write("o"*100000); sys.stderr.write("e"*100000)'
        options = '{stdin: "hello\\nworld", max_output: 200000, cwd: "."}'
        result = self.evaluate(f'process({quote(python_command("-c", script))}, {options})')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertTrue('hello\nworld' in result['stdout'].replace('\r\n', '\n'))
        self.assertEqual(result['stderr'], 'e' * 100000)

    def test_process_timeout_kills_descendants_and_recovers(self):
        marker = self.root / 'escaped'
        child = f'import time,pathlib; time.sleep(.4); pathlib.Path({str(marker)!r}).write_text("bad")'
        parent = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); time.sleep(10)'
        result = self.evaluate(f'process({quote(python_command("-c", parent))}, {{timeout_ms: 80}})')
        self.assertTrue(result['timed_out'], result)
        time.sleep(.55)
        self.assertFalse(marker.exists())
        result = self.evaluate(f'process({quote(python_command("-c", "print(42)"))})')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['stdout'].strip(), '42')

    def test_process_output_limit_and_missing_executable(self):
        result = self.evaluate(f'process({quote(python_command("-c", "print(\"x\"*100000)"))}, {{max_output: 50}})')
        self.assertFalse(result['ok'])
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['stdout']), 50)
        result = self.evaluate('process(["sprout-nonexistent-command-987654321"])')
        self.assertFalse(result['ok'])
        self.assertEqual(result['exit'], -1 if os.name == 'nt' else 127)
        self.assertTrue(result['error'])

    def test_http_methods_headers_body_and_duplicate_response_headers(self):
        for method in ['GET', 'POST', 'PUT']:
            options = '{method: ' + quote(method) + ', headers: {"X-Sprout": "literal & safe"}, body: "hello 🌱"}'
            result = self.evaluate(f'request({quote(self.url + "/echo")}, {options})')
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['status'], 200)
            self.assertEqual(result['headers']['x-duplicate'], ['first', 'second'])
            body = json.loads(result['body'])
            self.assertEqual(body['method'], method)
            self.assertEqual(body['body'], 'hello 🌱')
            self.assertEqual(body['header'], 'literal & safe')

    def test_http_status_redirect_and_head(self):
        result = self.evaluate(f'request({quote(self.url + "/missing")})')
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 404)
        self.assertIsNone(result['error'])
        result = self.evaluate(f'request({quote(self.url + "/redirect")})')
        self.assertEqual(result['status'], 302)
        result = self.evaluate(f'request({quote(self.url + "/ok")}, {{method: "HEAD"}})')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['body'], '')

    def test_http_timeout_output_limit_and_binary(self):
        result = self.evaluate(f'request({quote(self.url + "/slow")}, {{timeout_ms: 40}})')
        self.assertTrue(result['timed_out'], result)
        self.assertFalse(result['ok'])
        for path, options in [('/large', '{max_bytes: 40}'), ('/binary', '{}')]:
            result = self.evaluate(f'request({quote(self.url + path)}, {options})')
            self.assertFalse(result['ok'], result)
            self.assertTrue(result['error'])
        self.assertTrue(self.evaluate(f'request({quote(self.url + "/ok")})')['ok'])

    def test_http_header_injection_and_unknown_options_rejected(self):
        for options in ['{headers: {"X-Test": "bad\\r\\nInjected: yes"}}', '{timeot_ms: 2}']:
            result = self.run_code(f'show request({quote(self.url)}, {options})\n')
            self.assertEqual(result.returncode, 1)

    def test_all_host_io_blocked_in_sandbox_csv_allowed(self):
        for expression in ['file_read("x")', 'file_write("x", "y")', 'file_info("x")', 'file_list(".")',
                           'file_mkdir("x")', 'file_remove("x")', 'file_move("a", "b")',
                           'request("https://example.com")', 'process(["echo", "x"])', 'sql_open(":memory:")']:
            with self.subTest(expression=expression):
                result = self.run_code(f'show {expression}\n', '--sandbox')
                self.assertEqual(result.returncode, 1)
                self.assertIn('sandbox mode', result.stderr)
        self.assertEqual(self.evaluate('csv_parse("a,b")', '', '--sandbox'), [['a', 'b']])
        self.assertFalse((self.root / 'x').exists())

    def test_sqlite_availability_and_parameter_binding(self):
        if not SQLITE:
            result = self.evaluate('sql_open(":memory:")')
            self.assertFalse(result['ok'])
            self.assertIn('not included', result['error'])
            return
        setup = 'make db = sql_open("app.db").handle\nmake table = sql_execute(db, "CREATE TABLE users (name TEXT, id INTEGER, payload BLOB)")\n'
        dangerous = "Robert'); DROP TABLE users;--"
        setup += f'make inserted = sql_execute(db, "INSERT INTO users VALUES (?, ?, ?)", [{quote(dangerous)}, integer("9223372036854775807"), [0, 255, 42]])\n'
        result = self.evaluate('sql_execute(db, "SELECT name, id, payload FROM users")', setup)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['columns'], ['name', 'id', 'payload'])
        self.assertEqual(result['rows'], [[dangerous, 9223372036854775807, bytes([0, 255, 42])]])

    @unittest.skipUnless(SQLITE, 'minimal build')
    def test_sqlite_transaction_rolls_back_and_cannot_escape(self):
        setup = 'make db = sql_open("app.db").handle\nmake table = sql_execute(db, "CREATE TABLE items (id INTEGER PRIMARY KEY)")\n'
        for bad in ['INSERT INTO items VALUES (1)', 'COMMIT']:
            statement = '[{sql: "INSERT INTO items VALUES (1)"}, {sql: ' + quote(bad) + '}]'
            result = self.evaluate(f'sql_transaction(db, {statement})', setup)
            self.assertFalse(result['ok'], result)
            self.assertTrue(result['rolled_back'])
            self.assertEqual(self.evaluate('sql_execute(db, "SELECT COUNT(*) FROM items").rows', 'make db = sql_open("app.db").handle\n'), [[0]])
            (self.root / 'app.db').unlink()

    @unittest.skipUnless(SQLITE, 'minimal build')
    def test_sqlite_success_limits_timeout_and_closed_handle(self):
        setup = 'make db = sql_open(":memory:").handle\n'
        result = self.evaluate('sql_transaction(db, [{sql: "CREATE TABLE t (n INTEGER)"}, {sql: "INSERT INTO t VALUES (?)", params: [42]}])', setup)
        self.assertTrue(result['ok'], result)
        result = self.evaluate('sql_execute(db, "SELECT 1 UNION ALL SELECT 2", [], {max_rows: 1})', setup)
        self.assertFalse(result['ok'])
        result = self.evaluate('sql_execute(db, "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c) SELECT sum(n) FROM c", [], {timeout_ms: 10})', setup)
        self.assertFalse(result['ok'])
        self.assertTrue(result.get('timed_out'))
        result = self.evaluate('sql_execute(db, "SELECT 1")', setup + 'make closed = sql_close(db)\n')
        self.assertFalse(result['ok'])

    @unittest.skipUnless(SQLITE, 'minimal build')
    def test_sqlite_multiple_statements_missing_params_and_readonly(self):
        setup = 'make db = sql_open("app.db").handle\n'
        for expression in ['sql_execute(db, "SELECT 1; SELECT 2")', 'sql_execute(db, "SELECT ?")']:
            self.assertFalse(self.evaluate(expression, setup)['ok'])
        self.assertFalse(self.evaluate('sql_execute(db, "CREATE TABLE t (n INTEGER)")', 'make db = sql_open("app.db", {read_only: yes}).handle\n')['ok'])

    @unittest.skipUnless(SQLITE, 'minimal build')
    def test_sqlite_aggregate_transaction_limits_and_change_counts(self):
        setup = 'make db = sql_open("app.db").handle\nmake created = sql_execute(db, "CREATE TABLE t (n INTEGER)")\n'
        statements = '[{sql: "INSERT INTO t VALUES (1)"}, {sql: "SELECT 1 UNION ALL SELECT 2"}]'
        result = self.evaluate(f'sql_transaction(db, {statements}, {{max_rows: 1}})', setup)
        self.assertFalse(result['ok'])
        self.assertTrue(result['rolled_back'])
        count = self.evaluate('sql_execute(db, "SELECT COUNT(*) FROM t").rows', 'make db = sql_open("app.db").handle\n')
        self.assertEqual(count, [[0]])
        result = self.evaluate('sql_transaction(db, [{sql: "SELECT 1"}, {sql: "SELECT 2"}], {max_bytes: 600})', 'make db = sql_open("app.db").handle\n')
        self.assertFalse(result['ok'])
        self.assertTrue(result['rolled_back'])
        result = self.evaluate('sql_execute(db, "CREATE TABLE another (n INTEGER)")', 'make db = sql_open("app.db").handle\nmake added = sql_execute(db, "INSERT INTO t VALUES (42)")\n')
        self.assertEqual(result['changed'], 0)


if __name__ == '__main__':
    unittest.main()
