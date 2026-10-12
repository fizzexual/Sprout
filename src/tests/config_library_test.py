"""Pure configuration contracts, with an explicitly selected intrinsic-capable runtime."""
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
LIBRARY = ROOT / 'lib/config.sprout'
VALIDATION = ROOT / 'lib/validate.sprout'


class ConfigurationLibrary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-config-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def run_sprout(self, body, *, sandbox=False, prelude=''):
        if sandbox:
            prefix = VALIDATION.read_text(encoding='utf-8') + '\n' + LIBRARY.read_text(encoding='utf-8') \
                .replace('use "validate.sprout"\n', '').replace('private make cfg_validate = validate.check',
                                                             'private make cfg_validate = check')
        else:
            prefix = 'use ' + json.dumps(LIBRARY.as_posix())
        source = self.directory / 'case.sprout'
        source.write_text(prelude + '\n' + prefix + '\n' + body + '\n', encoding='utf-8')
        result = subprocess.run([str(BINARY), *(['--sandbox'] if sandbox else []), 'run', str(source),
                                 '--max-steps', '5000000', '--timeout-ms', '5000'], cwd=self.directory,
                                capture_output=True, timeout=12)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertGreaterEqual(result.returncode, 0, 'A crash is not a configuration rejection')
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), ['case.sprout'])
        return json.loads(result.stdout)

    @staticmethod
    def encoded(value):
        return 'builtin::json_decode(' + json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False) + ')'

    def resolve(self, defaults, schema, files=None, cli=None):
        return self.run_sprout('show builtin::json_encode(config.resolve(' + ', '.join(self.encoded(v)
            for v in (defaults, schema, files if files is not None else [], cli if cli is not None else {})) + '))')

    def assert_rejected(self, value):
        self.assertFalse(value['ok'])
        self.assertIsNone(value['values'])
        self.assertIsNone(value['provenance'])
        self.assertTrue(value['errors'])

    def test_ordered_precedence_provenance_and_exact_values(self):
        value = self.run_sprout('''make schema = {kind: "map", fields: {id: {kind: "integer"}, money: {kind: "decimal"}, enabled: {kind: "yes-no"}, name: {kind: "text"}}}
show builtin::json_encode(config.resolve({id: builtin::integer("9223372036854775807"), money: builtin::decimal("19.95"), enabled: no, name: "default"}, schema,
    [{name: "same", values: {name: "first", money: builtin::decimal("20.10")}}, {name: "same", values: {name: "second"}}], {enabled: yes}))''')
        self.assertTrue(value['ok'])
        self.assertEqual(value['values'], {'id': {'$sprout.integer': '9223372036854775807'},
            'money': {'$sprout.decimal': '20.10'}, 'enabled': True, 'name': 'second'})
        self.assertEqual(value['provenance'], {'id': {'source': 'defaults', 'index': None, 'name': None},
            'money': {'source': 'file', 'index': 0, 'name': 'same'},
            'enabled': {'source': 'cli', 'index': None, 'name': None},
            'name': {'source': 'file', 'index': 1, 'name': 'same'}})
        self.assertEqual(value['errors'], [])

    def test_nested_values_replace_atomically_instead_of_merging(self):
        schema = {'kind': 'map', 'fields': {'nested': {'kind': 'map', 'fields': {
            'left': {'kind': 'number'}, 'right': {'kind': 'number'}}}}}
        value = self.resolve({'nested': {'left': 1, 'right': 2}}, schema,
                             [{'name': 'partial', 'values': {'nested': {'left': 3}}}])
        self.assert_rejected(value)
        self.assertEqual(value['errors'][0]['path'], ['nested', 'right'])
        self.assertEqual(value['errors'][0]['code'], 'required')
        value = self.resolve({'nested': [1, 2]}, {'kind': 'map', 'fields': {
            'nested': {'kind': 'list', 'items': {'kind': 'number'}}}}, cli={'nested': [3]})
        self.assertEqual(value['values']['nested'], [3])

    def test_missing_and_explicit_nothing_are_distinct(self):
        schema = {'kind': 'map', 'fields': {'note': {'kind': 'text', 'required': False, 'nullable': True}}}
        self.assertEqual(self.resolve({'note': 'retained'}, schema)['values'], {'note': 'retained'})
        self.assertEqual(self.resolve({'note': 'retained'}, schema, cli={'note': None})['values'], {'note': None})
        self.assertEqual(self.resolve({}, schema)['values'], {})
        schema['fields']['note']['nullable'] = False
        value = self.resolve({'note': 'retained'}, schema, cli={'note': None})
        self.assert_rejected(value)
        self.assertEqual(value['errors'][0]['code'], 'null')

    def test_output_is_detached_and_alias_occurrences_expand_independently(self):
        value = self.run_sprout('''make shared = [{name: "original"}]
make defaults = {first: shared, second: shared}
make files = [{name: "local", values: {third: shared}}]
make cli = {fourth: shared}
make schema = {kind: "map", allow_unknown: yes}
make before = builtin::json_encode([defaults, files, cli, schema])
make result = config.resolve(defaults, schema, files, cli)
set result.values.first[0].name = "changed"
builtin::add(result.values.third, {})
set result.provenance.fourth.source = "edited"
show builtin::json_encode({ok: result.ok, second: result.values.second, fourth: result.values.fourth,
    unchanged: before == builtin::json_encode([defaults, files, cli, schema]), shared: shared})''')
        self.assertTrue(value['ok'])
        self.assertEqual(value['second'], [{'name': 'original'}])
        self.assertEqual(value['fourth'], [{'name': 'original'}])
        self.assertEqual(value['shared'], [{'name': 'original'}])
        self.assertTrue(value['unchanged'])

    def test_invalid_superseded_values_are_rejected_without_callbacks_or_partial_config(self):
        value = self.run_sprout('''type Sensitive:
    task equals(self, other):
        fail "Do not dispatch user equality."
    task text(self):
        fail "Do not dispatch user formatting."
make object = Sensitive()
task unsupported_callback(value):
    fail "Do not run a configuration callback."
make task_value = unsupported_callback
make positive = builtin::sum([1e308, 1e308])
make negative = builtin::sum([-1e308, -1e308])
make results = []
for each invalid in [object, task_value, builtin::bytes([0, 255]), positive, negative, builtin::sum([positive, negative])]:
    builtin::add(results, config.resolve({hidden: invalid}, {kind: "map", allow_unknown: yes}, [], {hidden: "later valid"}))
show builtin::json_encode(results)''')
        for result in value:
            self.assert_rejected(result)
            self.assertEqual(result['errors'][0]['source'], 'defaults')
            self.assertEqual(result['errors'][0]['path'], ['hidden'])

    def test_recursive_and_overdeep_values_fail_without_mutating_the_source(self):
        value = self.run_sprout('''make loop = []
builtin::add(loop, loop)
make source = {loop: loop}
make cyclic = config.resolve(source, {kind: "map", allow_unknown: yes})
make deep = 1
repeat 17 times:
    set deep = [deep]
make overdeep = config.resolve({deep: deep}, {kind: "map", allow_unknown: yes})
show builtin::json_encode({cyclic: cyclic, deep: overdeep, retained_length: builtin::length(loop), retained_keys: builtin::keys(source)})''')
        for result in (value['cyclic'], value['deep']):
            self.assert_rejected(result)
            self.assertEqual(result['errors'][0]['code'], 'limit')
            self.assertTrue(result['truncated'])
            self.assertLessEqual(len(result['errors'][0]['path']), 17)
        self.assertEqual(value['retained_length'], 1)
        self.assertEqual(value['retained_keys'], ['loop'])

    def test_depth_key_and_list_limits_have_positive_boundary_controls(self):
        value = self.run_sprout('''make schema = {kind: "map", allow_unknown: yes}
make deep = 1
repeat 15 times:
    set deep = [deep]
make within = config.resolve({deep: deep}, schema)
make over = config.resolve({deep: [deep]}, schema)
make short_key = {}
set short_key["🌱" * 128] = yes
make long_key = {}
set long_key["🌱" * 129] = yes
show builtin::json_encode({depth: within.ok, deep: over, key: config.resolve(short_key, schema).ok,
    long_key: config.resolve(long_key, schema), list: config.resolve({items: [1] * 10000}, schema).ok,
    overlist: config.resolve({items: [1] * 10001}, schema)})''')
        self.assertTrue(value['depth'])
        self.assertTrue(value['key'])
        self.assertTrue(value['list'])
        for result in (value['deep'], value['long_key'], value['overlist']): self.assert_rejected(result)
        self.assertTrue(value['deep']['truncated'])
        self.assertFalse(value['overlist']['truncated'])
        self.assertEqual(value['long_key']['errors'][0]['code'], 'key')

    def test_root_map_schema_is_checked_before_layers_and_is_not_mutated(self):
        invalid = [None, {'kind': 'text'}, {'kind': 'map', 'fields': []},
                   {'kind': 'map', 'fields': {'x': {'kind': 'text', 'required': 1}}}]
        for schema in invalid:
            with self.subTest(schema=schema):
                value = self.resolve(None, schema, [{'name': '', 'values': None}])
                self.assert_rejected(value)
                self.assertEqual(value['errors'][0]['source'], 'schema')
                self.assertFalse(value['truncated'])
        value = self.run_sprout('''make schema = {kind: "map", fields: {name: {kind: "text", min_length: 2}}}
make defaults = {name: "x"}
make before = builtin::json_encode([schema, defaults])
make result = config.resolve(defaults, schema)
show builtin::json_encode({result: result, unchanged: before == builtin::json_encode([schema, defaults])})''')
        self.assert_rejected(value['result'])
        self.assertTrue(value['unchanged'])

    def test_layer_envelopes_labels_and_count_are_explicit(self):
        schema = {'kind': 'map', 'allow_unknown': True}
        for files in ({}, [None], [{'name': 'x', 'values': {}, 'unexpected': True}],
                      [{'name': '', 'values': {}}], [{'name': 'x' * 65, 'values': {}}],
                      [{'name': 'x', 'values': []}], [{'values': {}}]):
            with self.subTest(files=files):
                self.assert_rejected(self.resolve({}, schema, files))
        self.assertTrue(self.resolve({}, schema, [{'name': '🌱' * 64, 'values': {}}] * 16)['ok'])
        self.assert_rejected(self.resolve({}, schema, [{'name': 'x', 'values': {}}] * 17))
        self.assert_rejected(self.resolve([], schema))
        self.assert_rejected(self.resolve({}, schema, cli=[]))

    def test_each_map_and_merged_root_key_limits_are_independent(self):
        schema = {'kind': 'map', 'allow_unknown': True}
        self.assertTrue(self.resolve({str(i): i for i in range(128)}, schema)['ok'])
        self.assert_rejected(self.resolve({str(i): i for i in range(129)}, schema))
        value = self.resolve({str(i): i for i in range(100)}, schema, cli={str(i): i for i in range(100, 130)})
        self.assert_rejected(value)
        self.assertEqual(value['errors'][0]['source'], 'resolved')

    def test_occurrence_budget_counts_aliases_and_all_layer_roots(self):
        value = self.run_sprout('''make shared = [1] * 9998
make defaults = {first: shared, second: shared}
make schema = {kind: "map", allow_unknown: yes}
make within = config.resolve(defaults, schema)
make over = config.resolve(defaults, schema, [], {extra: 1})
show builtin::json_encode({within: within.ok, over: over, retained: builtin::length(shared)})''')
        self.assertTrue(value['within'])
        self.assert_rejected(value['over'])
        self.assertIn('20000', value['over']['errors'][0]['message'])
        self.assertTrue(value['over']['truncated'])
        self.assertEqual(value['retained'], 9998)

    def test_text_budget_and_per_value_boundaries_count_keys(self):
        value = self.run_sprout('''make schema = {kind: "map", allow_unknown: yes}
make values = {a: "x" * 65535, b: "x" * 65535, c: "x" * 65535, d: "x" * 65535}
make within = config.resolve(values, schema)
set values.d = "x" * 65536
make total = config.resolve(values, schema)
make single = config.resolve({a: "x" * 65537}, schema)
show builtin::json_encode({within: within.ok, total: total, single: single})''')
        self.assertTrue(value['within'])
        for result in (value['total'], value['single']): self.assert_rejected(result)
        self.assertTrue(value['total']['truncated'])
        self.assertFalse(value['single']['truncated'])
        self.assertIn('262144', value['total']['errors'][0]['message'])
        self.assertIn('65536', value['single']['errors'][0]['message'])

    def test_fixed_errors_omit_labels_values_and_bound_long_key_paths(self):
        private = 'secret-value-should-not-appear'
        result = self.resolve({'x': private}, {'kind': 'map', 'fields': {'x': {'kind': 'number'}}},
                              [{'name': 'secret-layer-name', 'values': {'x': private}}])
        self.assert_rejected(result)
        wire = json.dumps(result)
        self.assertNotIn(private, wire)
        self.assertNotIn('secret-layer-name', wire)
        result = self.resolve({'secret-key-' + 'x' * 20000: private}, {'kind': 'map', 'allow_unknown': True})
        self.assert_rejected(result)
        self.assertLess(len(json.dumps(result)), 1000)
        self.assertNotIn('secret-', json.dumps(result))
        self.assertEqual(result['errors'][0]['path'], ['<field name exceeds 128 characters>'])
        result = self.resolve({str(i): i for i in range(128)}, {'kind': 'map'})
        self.assertEqual(len(result['errors']), 64)
        self.assertTrue(result['truncated'])

    def test_unknown_fields_can_be_opaque_to_schema_but_not_to_plain_value_copy(self):
        schema = {'kind': 'map', 'allow_unknown': True}
        self.assertTrue(self.resolve({'extra': {'nested': [1, None]}}, schema)['ok'])
        result = self.resolve({'extra': 1}, {'kind': 'map'})
        self.assert_rejected(result)
        self.assertEqual(result['errors'][0]['code'], 'unknown')

    def test_helper_and_native_name_collisions_do_not_run_constructors_or_task_bindings(self):
        declarations = 'make calls = []\ntask config_noted():\n    builtin::add(calls, "callback")\n    give 0\n'
        names = [('cfg_plain', 2), ('cfg_segment', 1), ('cfg_error', 6), ('cfg_text_budget', 5),
                 ('cfg_copy', 6), ('cfg_layer', 4), ('cfg_overlay', 6), ('cfg_failure', 1),
                 ('cfg_validate', 2), ('resolve', 4), ('kind_of', 1), ('is_a', 2),
                 ('contains', 2), ('length', 1), ('keys', 1), ('add', 2)]
        for name, arity in names:
            declarations += 'type ' + name + ':\n'
            declarations += ''.join('    make arg%d\n' % i for i in range(arity))
            declarations += '    make observed = config_noted()\n'
        for name, arity in names[-6:]:
            declarations += 'make ' + name + ' = task(' + ', '.join('arg%d' % i for i in range(arity)) + '): config_noted()\n'
        for sandbox in (False, True):
            call = 'resolve' if sandbox else 'config.resolve'
            body = 'make good = CALL({name: "Ada"}, {kind: "map", fields: {name: {kind: "text"}}})\n' \
                   'make bad = CALL({name: 42}, {kind: "map", fields: {name: {kind: "text"}}})\n' \
                   'show builtin::json_encode({good: good, bad: bad, calls: calls})'
            with self.subTest(sandbox=sandbox):
                value = self.run_sprout(body.replace('CALL', call), sandbox=sandbox, prelude=declarations)
                self.assertTrue(value['good']['ok'])
                self.assert_rejected(value['bad'])
                self.assertEqual(value['calls'], [])

    def test_shared_corpus_and_example_are_portable_and_do_not_write_files(self):
        for command, path in [('test', ROOT / 'src/tests/config_library_test.sprout'),
                              ('run', ROOT / 'examples/config/settings.sprout')]:
            result = subprocess.run([str(BINARY), command, str(path), '--max-steps', '5000000', '--timeout-ms', '5000'],
                                    cwd=self.directory, capture_output=True, timeout=12)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
            self.assertEqual(result.stderr, b'')
            if command == 'test': self.assertIn(b'8 passed', result.stdout)
            else: self.assertTrue(json.loads(result.stdout)['ok'])
            self.assertEqual(list(self.directory.iterdir()), [])


if __name__ == '__main__': unittest.main()
