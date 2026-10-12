"""Bounded pure API contracts. Pass an explicitly selected intrinsic-capable binary."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()
LIBRARY = ROOT / 'lib/api.sprout'
VALIDATION = ROOT / 'lib/validate.sprout'


class ApiContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-api-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def run_sprout(self, body, *, sandbox=False, prelude='', raw=False):
        if sandbox:
            prefix = VALIDATION.read_text(encoding='utf-8') + '\n' + LIBRARY.read_text(encoding='utf-8') \
                .replace('use "validate.sprout"\n', '').replace('private make api_validate = validate.check',
                                                             'private make api_validate = check')
        else:
            prefix = 'use ' + json.dumps(LIBRARY.as_posix())
        source = self.directory / 'case.sprout'
        source.write_text(prelude + '\n' + prefix + '\n' + body + '\n', encoding='utf-8')
        result = subprocess.run([str(BINARY), *(['--sandbox'] if sandbox else []), 'run', str(source),
                                 '--max-steps', '5000000', '--timeout-ms', '5000'], cwd=self.directory,
                                capture_output=True, timeout=12)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertGreaterEqual(result.returncode, 0, 'A crash is not an API rejection')
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), ['case.sprout'])
        return result.stdout if raw else json.loads(result.stdout)

    @staticmethod
    def encoded(value):
        return 'builtin::json_decode(' + json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False) + ')'

    @staticmethod
    def request(**changes):
        return {'method': 'GET', 'path': '/contacts', 'query': {}, 'body': None, **changes}

    @staticmethod
    def route(**changes):
        return {'id': 'contacts', 'method': 'GET', 'path': '/contacts', **changes}

    def select(self, request, routes):
        return self.run_sprout('show builtin::json_encode(api.select(' + self.encoded(request) + ', ' +
                               self.encoded(routes) + '))')

    def result(self, status, body, headers=None):
        arguments = [self.encoded(status), self.encoded(body)]
        if headers is not None: arguments.append(self.encoded(headers))
        return self.run_sprout('show builtin::json_encode(api.result(' + ', '.join(arguments) + '))')

    def assert_selection(self, result, status, code):
        self.assertIs(result['ok'], False)
        self.assertIsNone(result['route'])
        self.assertEqual(result['error'], code)
        self.assertEqual(result['response']['status'], status)
        self.assertEqual(result['response']['headers']['Cache-Control'], 'no-store')
        public = 'invalid_request' if code in ('invalid_query', 'invalid_body') else code
        self.assertEqual(result['response']['body'], {'error': public})

    def assert_bad_result(self, result):
        self.assertEqual(result, {'ok': False, 'error': 'invalid_response', 'response': {
            'status': 500, 'headers': {'Cache-Control': 'no-store'}, 'body': {'error': 'invalid_response'}}})

    def test_entire_route_configuration_is_validated_before_request_or_selection(self):
        valid = self.route()
        invalid = [None, {}, [None], [self.route(extra=True)], [self.route(id='')],
                   [self.route(id='private 🌱')], [self.route(method='OPTIONS')], [self.route(path='relative')],
                   [self.route(query=None)], [self.route(body=None)], [self.route(query={'kind': 'text'})],
                   [self.route(body={'kind': 'text', 'max_length': False})],
                   [valid, self.route(id='second', path='/unused', body={'kind': 'list'})]]
        for routes in invalid:
            with self.subTest(routes=routes):
                self.assert_selection(self.select(None, routes), 500, 'invalid_contract')
        self.assert_selection(self.select(self.request(), [valid, self.route(id='second')]), 500, 'invalid_contract')
        self.assert_selection(self.select(self.request(), [valid, self.route(path='/other')]), 500, 'invalid_contract')
        self.assertTrue(self.select(self.request(), [valid])['ok'])

    def test_exact_request_envelope_missing_null_and_unknown_fields(self):
        for request in (None, [], {}, {'method': 'GET', 'path': '/contacts'},
                        {k: v for k, v in self.request().items() if k != 'body'},
                        {k: v for k, v in self.request().items() if k != 'query'},
                        self.request(extra='private'), self.request(method=None),
                        self.request(path=None), self.request(method='get')):
            with self.subTest(request=request):
                self.assert_selection(self.select(request, [self.route()]), 400, 'invalid_request')
        self.assert_selection(self.select(self.request(query=None), [self.route()]), 400, 'invalid_query')
        self.assert_selection(self.select(self.request(body={}), [self.route()]), 400, 'invalid_body')
        nullable = self.route(body={'kind': 'map', 'nullable': True})
        self.assertTrue(self.select(self.request(), [nullable])['ok'])
        self.assert_selection(self.select(self.request(), [self.route(body={'kind': 'map'})]), 400, 'invalid_body')

    def test_literal_path_selection_allow_and_no_implicit_methods(self):
        routes = [self.route(id='post', method='POST'), self.route(id='get'), self.route(id='delete', method='DELETE')]
        value = self.select(self.request(method='OPTIONS'), routes)
        self.assert_selection(value, 405, 'method_not_supported')
        self.assertEqual(value['response']['headers']['Allow'], 'DELETE, GET, POST')
        self.assert_selection(self.select(self.request(method='HEAD'), routes), 405, 'method_not_supported')
        self.assertEqual(self.select(self.request(method='HEAD'), [self.route(method='HEAD')])['route'], 'contacts')
        for path in ('/contacts/', '/%63ontacts', '/Contacts', '/contacts/../contacts'):
            self.assert_selection(self.select(self.request(path=path), routes), 404, 'route_not_found')
        for path in ('contacts', '/contacts?x=1', '/contacts#frag', '/a b', '/a\\b', '/🌱', '/a\r'):
            self.assert_selection(self.select(self.request(path=path), routes), 400, 'invalid_request')
        self.assert_selection(self.select(self.request(), []), 404, 'route_not_found')

    def test_query_lists_empty_values_and_exact_one_hundred_leaf_boundary(self):
        schema = {'kind': 'map', 'fields': {'q': {'kind': 'list', 'items': {'kind': 'text'}, 'required': False}}}
        routes = [self.route(query=schema)]
        for query in ({}, {'q': []}, {'q': ['']}, {'q': ['a', 'a']}, {'q': ['x'] * 100}):
            self.assertTrue(self.select(self.request(query=query), routes)['ok'])
        for query in ({'q': ['x'] * 101}, {'q': 'x'}, {'q': [None]}, {'q': [1]}, {'': []}):
            self.assert_selection(self.select(self.request(query=query), routes), 400, 'invalid_query')
        self.assert_selection(self.select(self.request(query={'undeclared': []}), routes), 400, 'invalid_query')
        many = {str(i): [''] for i in range(100)}
        self.assertTrue(self.select(self.request(query=many), [self.route(query={'kind': 'map', 'allow_unknown': True})])['ok'])
        many['100'] = []
        self.assert_selection(self.select(self.request(query=many), routes), 400, 'invalid_query')

    def test_selected_schemas_keep_missing_nullable_bool_and_exact_kinds_distinct(self):
        schema = {'kind': 'map', 'fields': {'id': {'kind': 'integer'}, 'cost': {'kind': 'decimal'},
                   'enabled': {'kind': 'yes-no'}, 'note': {'kind': 'text', 'required': False, 'nullable': True}}}
        routes = [self.route(body=schema)]
        body = {'id': {'$sprout.integer': '9223372036854775807'}, 'cost': {'$sprout.decimal': '19.95'}, 'enabled': True}
        self.assertTrue(self.select(self.request(body=body), routes)['ok'])
        self.assertTrue(self.select(self.request(body={**body, 'note': None}), routes)['ok'])
        for changes in ({'id': 1}, {'cost': 19.95}, {'enabled': 1}, {'unexpected': True}):
            self.assert_selection(self.select(self.request(body={**body, **changes}), routes), 400, 'invalid_body')
        self.assert_selection(self.select(self.request(body={'cost': body['cost'], 'enabled': True}), routes), 400, 'invalid_body')

    def test_errors_do_not_echo_private_values_keys_schemas_or_paths(self):
        secret = 'private-secret-not-returned'
        result = self.select(self.request(body={secret: secret}), [self.route(body={'kind': 'map'})])
        self.assert_selection(result, 400, 'invalid_body')
        self.assertNotIn(secret, json.dumps(result))
        result = self.select(self.request(path='/' + secret), [self.route()])
        self.assert_selection(result, 404, 'route_not_found')
        self.assertNotIn(secret, json.dumps(result))
        result = self.select(self.request(), [self.route(body={'kind': 'text', 'allowed': [secret], 'unknown': secret})])
        self.assert_selection(result, 500, 'invalid_contract')
        self.assertNotIn(secret, json.dumps(result))

    def test_plain_tag_maps_are_rejected_but_typed_exact_values_survive(self):
        value = self.run_sprout('''make results = []
for each key in ["$sprout.integer", "$sprout.decimal", "$sprout.bytes"]:
    make tagged = {}
    set tagged[key] = "1"
    builtin::add(results, api.result(200, tagged))
show builtin::json_encode({bad: results, good: api.result(200, {small: builtin::integer("1"), id: builtin::integer("9223372036854775807"), cost: builtin::decimal("19.95"), empty: {"": nothing}})})''')
        for result in value['bad']: self.assert_bad_result(result)
        self.assertTrue(value['good']['ok'])
        self.assertEqual(value['good']['response']['body'], {'small': {'$sprout.integer': '1'},
            'id': {'$sprout.integer': '9223372036854775807'}, 'cost': {'$sprout.decimal': '19.95'}, 'empty': {'': None}})

    def test_ordinary_number_policy_is_bridge_stable_and_rejects_nonfinite(self):
        value = self.run_sprout('''make positive = builtin::sum([1e308, 1e308])
make negative = builtin::sum([-1e308, -1e308])
make results = []
for each number in [1e20, -1e20, positive, negative, builtin::sum([positive, negative])]:
    builtin::add(results, api.result(200, number))
show builtin::json_encode({bad: results, good: [api.result(200, 9007199254740991), api.result(200, -9007199254740991), api.result(200, 0.125)]})''')
        for result in value['bad']: self.assert_bad_result(result)
        for result in value['good']: self.assertTrue(result['ok'])

    def test_status_accepts_only_whole_plain_number_or_integer_in_range(self):
        value = self.run_sprout('''make positive = builtin::sum([1e308, 1e308])
make results = []
for each status in [yes, no, nothing, "200", [], {}, builtin::decimal("200"), 199, 600, 200.5, positive, builtin::sum([positive, -positive])]:
    builtin::add(results, api.result(status, nothing))
show builtin::json_encode({bad: results, good: [api.result(200, nothing), api.result(599, nothing), api.result(builtin::integer("201"), nothing)]})''')
        for result in value['bad']: self.assert_bad_result(result)
        self.assertEqual([x['response']['status'] for x in value['good']], [200, 599, 201])
        self.assertTrue(all(x['ok'] for x in value['good']))

    def test_headers_ascii_duplicate_framing_null_and_bounds(self):
        bad = [{'X-Test': 'x\r\nInjected:yes'}, {'X-Test': 'x\t'}, {'X-Test': '🌱'}, {'Bad Name': 'x'},
               {'': 'x'}, {'a' * 65: 'x'}, {'X-Test': 1}, {'X-Test': 'x' * 1025},
               {'X-Id': 'a', 'x-id': 'b'}, {str(i): '' for i in range(17)},
               {'X-' + str(i): 'x' * 1024 for i in range(4)}]
        for name in ('Content-Type', 'content-LENGTH', 'Connection', 'TRANSFER-encoding'):
            bad.append({name: 'value'})
        for headers in bad:
            with self.subTest(headers=headers): self.assert_bad_result(self.result(200, None, headers))
        value = self.run_sprout('show builtin::json_encode(api.result(200, nothing, nothing))')
        self.assert_bad_result(value)
        self.assertTrue(self.result(200, None, {'X-Empty': '', 'x-token': " !#$%&'*+-.^_`|~"})['ok'])
        self.assertTrue(self.result(200, None, {str(i): '' for i in range(16)})['ok'])
        self.assertTrue(self.result(200, None, {'X': 'x' * 1024})['ok'])
        self.assertTrue(self.result(200, None, {str(i): 'x' * 1023 for i in range(4)})['ok'])

    def test_complete_response_and_crlf_reservation_exact_byte_boundary(self):
        empty = {'status': 200, 'headers': {'X': 'v'}, 'body': ''}
        overhead = len(json.dumps(empty, separators=(',', ':'), ensure_ascii=False).encode()) + 2
        size = 65536 - overhead
        good = self.result(200, 'x' * size, {'X': 'v'})
        self.assertTrue(good['ok'])
        self.assertEqual(len(json.dumps(good['response'], separators=(',', ':')).encode()) + 2, 65536)
        self.assert_bad_result(self.result(200, 'x' * (size + 1), {'X': 'v'}))
        # Four UTF-8 bytes and six escaped bytes differ from character counts.
        self.assertTrue(self.result(200, '🌱' * 16000)['ok'])
        self.assert_bad_result(self.result(200, '🌱' * 16400))
        self.assertTrue(self.result(200, '\t' * 32000)['ok'])
        self.assert_bad_result(self.result(200, '\x01' * 11000))
        tagged_body = {'cost': {'$sprout.decimal': '19.95'}, 'text': ''}
        exact_overhead = len(json.dumps({'status': 200, 'headers': {}, 'body': tagged_body}, separators=(',', ':')).encode()) + 2
        good = self.result(200, {**tagged_body, 'text': 'x' * (65536 - exact_overhead)})
        self.assertTrue(good['ok'])
        self.assertEqual(len(json.dumps(good['response'], separators=(',', ':')).encode()) + 2, 65536)
        self.assert_bad_result(self.result(200, {**tagged_body, 'text': 'x' * (65537 - exact_overhead)}))

    def test_actual_stdout_response_boundary_fits_crlf_and_rejects_one_extra_byte(self):
        overhead = len(json.dumps({'status': 200, 'headers': {}, 'body': ''}, separators=(',', ':')).encode())
        size = 65536 - overhead - 2
        for extra in (0, 1):
            wire = self.run_sprout('show builtin::json_encode(api.result(200, "x" * ' + str(size + extra) + ').response)', raw=True)
            self.assertLessEqual(len(wire), 65536)
            newline = b'\r\n' if wire.endswith(b'\r\n') else b'\n'
            self.assertTrue(wire.endswith(newline))
            response = json.loads(wire)
            if extra == 0:
                self.assertEqual(response, {'status': 200, 'headers': {}, 'body': 'x' * size})
                self.assertEqual(len(wire) - len(newline), 65534)
                self.assertEqual(len(wire), 65536 if newline == b'\r\n' else 65535)
            else:
                self.assertEqual(response, {'status': 500, 'headers': {'Cache-Control': 'no-store'},
                                            'body': {'error': 'invalid_response'}})

    def test_bodyless_status_policy_requires_nothing(self):
        for status in (204, 205, 304):
            self.assertTrue(self.result(status, None)['ok'])
            for body in ('', {}, False): self.assert_bad_result(self.result(status, body))

    def test_detached_aliases_headers_and_input_schema_are_not_mutated(self):
        value = self.run_sprout('''make shared = [{name: "old"}]
make body = {first: shared, second: shared}
make headers = {"X-Test": "old"}
make routes = [{id: "get", method: "GET", path: "/", body: {kind: "map", allow_unknown: yes}}]
make request = {method: "GET", path: "/", query: {}, body: body}
make before = builtin::json_encode([request, routes, headers])
make selected = api.select(request, routes)
make result = api.result(200, body, headers)
set result.response.body.first[0].name = "new"
set result.response.headers["X-Test"] = "new"
show builtin::json_encode({selected: selected, unchanged: before == builtin::json_encode([request, routes, headers]),
    second: result.response.body.second, source: shared, headers: headers})''')
        self.assertTrue(value['selected']['ok'])
        self.assertTrue(value['unchanged'])
        self.assertEqual(value['second'], [{'name': 'old'}])
        self.assertEqual(value['source'], [{'name': 'old'}])
        self.assertEqual(value['headers'], {'X-Test': 'old'})

    def test_cycles_alias_occurrences_depth_and_tree_limits(self):
        value = self.run_sprout('''make loop = []
builtin::add(loop, loop)
make deep = 1
repeat 15 times:
    set deep = [deep]
make shared = [1] * 1022
make large = {}
for each index in builtin::range(129):
    set large["x" + index] = 1
show builtin::json_encode({cycle: api.result(200, loop), retained: builtin::length(loop),
    depth: api.result(200, deep).ok, overdepth: api.result(200, [deep]),
    aliases: api.result(200, [shared, shared, shared, shared]).ok,
    occurrence: api.result(200, [shared, shared, shared, shared, 1]),
    list: api.result(200, [1] * 1024).ok, overlist: api.result(200, [1] * 1025), map: api.result(200, large)})''')
        self.assertEqual(value['retained'], 1)
        for name in ('cycle', 'overdepth', 'occurrence', 'overlist', 'map'): self.assert_bad_result(value[name])
        for name in ('depth', 'aliases', 'list'): self.assertTrue(value[name])

    def test_request_limit_and_unsupported_values_cannot_reach_schema_or_callbacks(self):
        value = self.run_sprout('''make calls = []
type Sensitive:
    task equals(self, other):
        builtin::add(calls, "equality")
        give yes
    task text(self):
        builtin::add(calls, "text")
        give "private"
make routes = [{id: "get", method: "GET", path: "/", body: {kind: "map", nullable: yes, allow_unknown: yes}}]
make bad = []
for each value in [Sensitive(), task(value): builtin::add(calls, value), builtin::bytes([0, 255])]:
    builtin::add(bad, api.result(200, value))
    builtin::add(bad, api.select({method: "GET", path: "/", query: {}, body: value}, routes))
make loop = []
builtin::add(loop, loop)
make limited = api.select({method: "GET", path: "/", query: {}, body: loop}, routes)
show builtin::json_encode({bad: bad, limited: limited, calls: calls})''')
        for result in value['bad'][::2]: self.assert_bad_result(result)
        for result in value['bad'][1::2]: self.assert_selection(result, 400, 'invalid_request')
        self.assert_selection(value['limited'], 413, 'request_limit')
        self.assertEqual(value['calls'], [])

    def test_text_key_contract_count_and_request_wire_caps(self):
        value = self.run_sprout('''make routes = [{id: "get", method: "GET", path: "/", body: {kind: "text"}}]
make key = {}
set key["x" * 129] = nothing
show builtin::json_encode({key: api.result(200, key), text: api.result(200, "x" * 65537),
    contracts: api.select(nothing, routes * 33), request: api.select({method: "GET", path: "/", query: {}, body: builtin::char(1) * 50000}, routes),
    within: api.select({method: "GET", path: "/", query: {}, body: "🌱" * 65000}, routes).ok})''')
        self.assert_bad_result(value['key'])
        self.assert_bad_result(value['text'])
        self.assert_selection(value['contracts'], 500, 'invalid_contract')
        self.assert_selection(value['request'], 413, 'request_limit')
        self.assertTrue(value['within'])

    def test_route_schema_cycles_maximum_descriptors_and_literal_path_boundary(self):
        routes = [self.route(id='route' + str(i), path='/' + str(i)) for i in range(32)]
        self.assertTrue(self.select(self.request(path='/31'), routes)['ok'])
        self.assert_selection(self.select(self.request(), routes + [self.route()]), 500, 'invalid_contract')
        path = '/' + 'x' * 1023
        self.assertTrue(self.select(self.request(path=path), [self.route(path=path)])['ok'])
        self.assert_selection(self.select(self.request(path=path + 'x'), [self.route()]), 400, 'invalid_request')
        self.assert_selection(self.select(self.request(), [self.route(path=path + 'x')]), 500, 'invalid_contract')
        value = self.run_sprout('''make schema = {kind: "list"}
set schema.items = schema
make routes = [{id: "get", method: "GET", path: "/", body: schema}]
make selected = api.select(nothing, routes)
make alias = [1]
repeat 12 times:
    set alias = [alias, alias]
show builtin::json_encode({selected: selected, dag: api.result(200, alias), retained: builtin::length(alias)})''')
        self.assert_selection(value['selected'], 500, 'invalid_contract')
        self.assert_bad_result(value['dag'])
        self.assertEqual(value['retained'], 2)

    def test_independent_failure_responses_do_not_share_mutable_state(self):
        value = self.run_sprout('''make routes = [{id: "get", method: "GET", path: "/"}]
make first = api.select({method: "POST", path: "/", query: {}, body: nothing}, routes)
set first.response.headers.Allow = "CHANGED"
set first.response.body.error = "CHANGED"
make second = api.select({method: "POST", path: "/", query: {}, body: nothing}, routes)
make wrong = api.result(yes, nothing)
set wrong.response.headers["Cache-Control"] = "CHANGED"
set wrong.response.body.error = "CHANGED"
show builtin::json_encode({second: second, result: api.result(yes, nothing)})''')
        self.assert_selection(value['second'], 405, 'method_not_supported')
        self.assertEqual(value['second']['response']['headers']['Allow'], 'GET')
        self.assert_bad_result(value['result'])

    def test_helper_native_and_public_constructor_collisions_in_import_and_supplied_sandbox(self):
        names = [('api_plain', 2), ('api_field', 3), ('api_stop', 2), ('api_text', 2), ('api_tree', 3),
                 ('api_wire', 2), ('api_ascii', 4), ('api_routes', 1), ('api_query', 1),
                 ('api_selection_failure', 3), ('api_headers', 1), ('api_status', 1), ('api_result_failure', 0),
                 ('api_validate', 2), ('select', 2), ('result', 3), ('kind_of', 1), ('is_a', 2),
                 ('contains', 2), ('length', 1), ('keys', 1), ('add', 2), ('json_encode', 1),
                 ('code', 1), ('number', 1), ('sort', 1), ('join', 2), ('lower', 1), ('bytes', 1)]
        declarations = 'make calls = []\ntask api_noted():\n    builtin::add(calls, "callback")\n    give 0\n'
        for name, arity in names:
            declarations += 'type ' + name + ':\n'
            declarations += ''.join('    make arg%d\n' % i for i in range(arity))
            declarations += '    make observed = api_noted()\n'
        for sandbox in (False, True):
            prefix = '' if sandbox else 'api.'
            body = '''make routes = [{id: "get", method: "GET", path: "/"}]
make selected = PREFIXselect({method: "GET", path: "/", query: {}, body: nothing}, routes)
make response_checked = PREFIXresult(200, {name: "Ada"}, {"X-Test": "ok"})
make bad = PREFIXresult(yes, nothing)
show builtin::json_encode({selected: selected, result: response_checked, bad: bad, calls: calls})'''.replace('PREFIX', prefix)
            with self.subTest(sandbox=sandbox):
                value = self.run_sprout(body, sandbox=sandbox, prelude=declarations)
                self.assertTrue(value['selected']['ok'])
                self.assertTrue(value['result']['ok'])
                self.assert_bad_result(value['bad'])
                self.assertEqual(value['calls'], [])

    def test_python_sdk_round_trip_preserves_values_with_documented_small_integer_reencoding(self):
        specification = importlib.util.spec_from_file_location('api_codec_peer', ROOT / 'integrations/python/sprout_host.py')
        host = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(host)
        value = self.run_sprout('''show builtin::json_encode(api.result(200, {id: builtin::integer("9223372036854775807"), small: builtin::integer("1"), cost: builtin::decimal("19.95"), ordinary: 0.125}).response)''')
        decoded = host.decode(json.dumps(value))
        reencoded = json.loads(host.encode(decoded['body']))
        self.assertEqual(reencoded, {'id': {'$sprout.integer': '9223372036854775807'}, 'small': 1,
                                    'cost': {'$sprout.decimal': '19.95'}, 'ordinary': 0.125})

    def test_shared_gc_corpus_and_preview_example_have_one_json_result_and_no_files(self):
        result = subprocess.run([str(BINARY), 'test', str(ROOT / 'src/tests/api_contract_test.sprout'),
                                 '--max-steps', '5000000', '--timeout-ms', '5000'],
                                cwd=self.directory, capture_output=True, timeout=12,
                                env={**os.environ, 'SPROUT_GC_STRESS': '1'})
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        self.assertIn(b'10 passed', result.stdout)
        example = ROOT / 'examples/services/contacts_preview.sprout'
        for request, status in [(self.request(path='/contacts/preview'), 200),
                (self.request(method='POST', path='/contacts/preview', body={'name': 'Ada', 'email': 'ada@example.test'}), 200),
                (self.request(method='POST', path='/contacts/preview', body={'name': ' ', 'email': 'invalid'}), 400),
                (self.request(method='POST', path='/contacts/preview', body={'name': 'Ada', 'email': 'a@b', 'secret': 'private'}), 400)]:
            result = subprocess.run([str(BINARY), 'run', str(example), '--max-steps', '5000000', '--timeout-ms', '5000'],
                                    input=json.dumps(request).encode() + b'\n', cwd=self.directory,
                                    capture_output=True, timeout=12)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
            self.assertEqual(result.stderr, b'')
            self.assertEqual(len(result.stdout.splitlines()), 1)
            self.assertEqual(json.loads(result.stdout)['status'], status)
        self.assertEqual(list(self.directory.iterdir()), [])


if __name__ == '__main__': unittest.main()
