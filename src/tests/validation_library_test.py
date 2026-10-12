"""Native pure validation contracts; bounded ordinary data and recursive fixtures."""
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
LIBRARY = ROOT / 'lib/validate.sprout'


class ValidationLibrary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-validation-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def run_sprout(self, body, *, cwd=None, sandbox=False, prelude=''):
        source = self.directory / 'case.sprout'
        prefix = LIBRARY.read_text(encoding='utf-8') if sandbox else 'use ' + json.dumps(LIBRARY.as_posix())
        source.write_text(prelude + '\n' + prefix + '\n' + body + '\n', encoding='utf-8')
        result = subprocess.run([str(BINARY), *(['--sandbox'] if sandbox else []), 'run', str(source), '--max-steps', '3000000',
                                 '--timeout-ms', '5000'], cwd=cwd or self.directory,
                                capture_output=True, timeout=12)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertGreaterEqual(result.returncode, 0, 'A native crash is not a validation rejection')
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), ['case.sprout'])
        return json.loads(result.stdout)

    @staticmethod
    def encoded(value):
        return 'json_decode(' + json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False) + ')'

    def check(self, value, schema):
        return self.run_sprout('show json_encode(validate.check(' + self.encoded(value) + ', ' + self.encoded(schema) + '))')

    def test_pure_tasks_run_under_sandbox_when_supplied_with_the_program(self):
        value = self.run_sprout('show json_encode(check({name: "Ada"}, {kind: "map", fields: {name: {kind: "text"}}}))', sandbox=True)
        self.assertTrue(value['ok'])

    def test_shared_native_and_wasm_contract_corpus(self):
        result = subprocess.run([str(BINARY), 'test', str(ROOT / 'src/tests/validation_library_test.sprout'),
                                 '--max-steps', '3000000', '--timeout-ms', '5000'], cwd=self.directory,
                                capture_output=True, timeout=12)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertIn(b'9 passed', result.stdout)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_synthetic_example_imports_from_another_working_directory(self):
        result = subprocess.run([str(BINARY), 'run', str(ROOT / 'examples/validation/order-input.sprout'),
                                 '--max-steps', '100000', '--timeout-ms', '2000'], cwd=self.directory,
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(json.loads(result.stdout), {'ok': True, 'errors': [], 'schema_error': None, 'truncated': False})
        self.assertEqual(result.stderr, b'')
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_nested_all_kinds_valid_and_no_mutation_of_shared_values(self):
        value = self.run_sprout('''make shared = {kind: "text", allowed: ["first", "second"]}
make schema = {kind: "map", fields: {label: shared, other: shared, active: {kind: "yes-no"}, ratio: {kind: "number"}, id: {kind: "integer"}, cost: {kind: "decimal"}, tags: {kind: "list", max_length: 2, items: {kind: "text"}}, contact: {kind: "map", fields: {name: {kind: "text"}, note: {kind: "text", required: no, nullable: yes}}}}}
make input = {label: "first", other: "second", active: yes, ratio: 2.5, id: integer("9223372036854775807"), cost: decimal("19.95"), tags: ["🌱", "café"], contact: {name: "Ada", note: nothing}}
make before = json_encode([schema, input])
make result = validate.check(input, schema)
show json_encode({result: result, unchanged: before == json_encode([schema, input]), exact_id: kind_of(input.id), exact_cost: kind_of(input.cost)})''')
        self.assertEqual(value['result'], {'ok': True, 'errors': [], 'schema_error': None, 'truncated': False})
        self.assertTrue(value['unchanged'])
        self.assertEqual(value['exact_id'], 'integer')
        self.assertEqual(value['exact_cost'], 'decimal')

    def test_errors_are_aggregated_with_unambiguous_field_and_item_paths(self):
        schema = {'kind': 'map', 'fields': {
            'name': {'kind': 'text', 'min_length': 2}, 'missing': {'kind': 'integer'},
            'contact': {'kind': 'map', 'fields': {'email': {'kind': 'text'}}},
            'tags': {'kind': 'list', 'items': {'kind': 'text'}}}}
        result = self.check({'name': '', 'contact': {'email': None}, 'tags': ['ok', 42], 'extra': True}, schema)
        self.assertFalse(result['ok'])
        self.assertIsNone(result['schema_error'])
        self.assertFalse(result['truncated'])
        self.assertEqual([(e['path'], e['code']) for e in result['errors']], [
            (['name'], 'min_length'), (['missing'], 'required'), (['contact', 'email'], 'null'),
            (['tags', 1], 'kind'), (['extra'], 'unknown')])

    def test_optional_missing_and_explicit_nothing_are_independent(self):
        schema = {'kind': 'map', 'fields': {'a': {'kind': 'text', 'required': False},
                  'b': {'kind': 'text', 'nullable': True}}}
        self.assertTrue(self.check({'b': None}, schema)['ok'])
        self.assertEqual(self.check({'a': None, 'b': None}, schema)['errors'][0]['code'], 'null')
        self.assertEqual(self.check({}, schema)['errors'][0]['path'], ['b'])
        self.assertTrue(self.check(None, {'kind': 'text', 'nullable': True})['ok'])
        self.assertEqual(self.check(None, {'kind': 'text'})['errors'][0]['code'], 'null')
        self.assertEqual(self.check(None, {'kind': 'text', 'nullable': True, 'allowed': ['x']})['errors'][0]['code'], 'allowed')
        self.assertTrue(self.check(None, {'kind': 'text', 'nullable': True, 'allowed': [None]})['ok'])

    def test_exact_kinds_and_allowed_identifiers_never_coerce(self):
        results = self.run_sprout('''make schemas = [{kind: "number"}, {kind: "integer"}, {kind: "decimal"}]
make values = [1, integer("1"), decimal("1.0")]
make matrix = []
for each value in values:
    make row = []
    for each schema in schemas:
        add(row, validate.check(value, schema).ok)
    add(matrix, row)
make exact = {kind: "integer", allowed: [integer("9223372036854775807")]}
make decimal_schema = {kind: "decimal", allowed: [decimal("1.00")]}
show json_encode({matrix: matrix, same: validate.check(integer("9223372036854775807"), exact).ok, different: validate.check(integer("9223372036854775806"), exact).ok, scale: validate.check(decimal("1.0"), decimal_schema).ok})''')
        self.assertEqual(results['matrix'], [[True, False, False], [False, True, False], [False, False, True]])
        self.assertTrue(results['same'])
        self.assertFalse(results['different'])
        self.assertTrue(results['scale'])

    def test_finite_numbers_and_strict_allowed_values(self):
        result = self.run_sprout('''make results = []
for each value in [sum([1e308, 1e308]), sum([-1e308, -1e308]), 1e308, -1e308]:
    add(results, validate.check(value, {kind: "number"}).ok)
show json_encode(results)''')
        self.assertEqual(result, [False, False, True, True])
        self.assertFalse(self.check('private-unlisted-value', {'kind': 'text', 'allowed': ['a', 'b']})['ok'])
        self.assertTrue(self.check(False, {'kind': 'yes-no', 'allowed': [False]})['ok'])
        self.assertFalse(self.check(True, {'kind': 'yes-no', 'allowed': [False]})['ok'])

    def test_number_constructor_collision_cannot_change_finite_or_length_checks(self):
        value = self.run_sprout('''make calls = []
task noted():
    add(calls, "constructor")
    give 0
type number:
    make value
    make observed = noted()
type floor:
    make value
    make observed = noted()
make positive = sum([1e308, 1e308])
make negative = sum([-1e308, -1e308])
make nan = sum([positive, negative])
make results = []
for each value in [1.5, 1e308, positive, negative, nan]:
    add(results, validate.check(value, {kind: "number"}).ok)
show json_encode({numbers: results, ordinary: validate.check("ab", {kind: "text", min_length: 1, max_length: 2}), exact: validate.check("ab", {kind: "text", min_length: integer("1"), max_length: integer("2")}), fraction: validate.check("ab", {kind: "text", max_length: 1.5}), infinite: validate.check("ab", {kind: "text", max_length: positive}), calls: calls})''')
        self.assertEqual(value['numbers'], [True, True, False, False, False])
        self.assertTrue(value['ordinary']['ok'])
        self.assertTrue(value['exact']['ok'])
        self.assertIsNotNone(value['fraction']['schema_error'])
        self.assertIsNotNone(value['infinite']['schema_error'])
        self.assertEqual(value['calls'], [])

    def test_helper_constructor_collisions_do_not_dispatch_in_import_or_supplied_sandbox(self):
        definitions = 'make calls = []\ntask noted():\n    add(calls, "constructor")\n    give 0\n'
        for name, arity in [('field', 3), ('segment', 1), ('problem', 2), ('finite_number', 1),
                            ('bound', 2), ('matches_kind', 2), ('schema_problem', 5),
                            ('error', 4), ('visit', 5), ('check', 2), ('number', 1), ('floor', 1)]:
            definitions += 'type ' + name + ':\n'
            definitions += ''.join('    make arg%d\n' % index for index in range(arity))
            definitions += '    make observed = noted()\n'
        for sandbox in (False, True):
            for ordering in ('before', 'after'):
                with self.subTest(sandbox=sandbox, types=ordering):
                    call = 'check' if sandbox else 'validate.check'
                    body = 'show json_encode({bad: ' + call + '(42, {kind: "text"}), good: ' + call + \
                        '({name: "Ada"}, {kind: "map", fields: {name: {kind: "text", min_length: 1, max_length: 3}}}), schema: ' + call + \
                        '(nothing, {kind: "text", unrecognized: yes}), nonfinite: ' + call + \
                        '(sum([1e308, 1e308]), {kind: "number"}), calls: calls})'
                    value = self.run_sprout(definitions + body if ordering == 'after' else body,
                                            sandbox=sandbox, prelude=definitions if ordering == 'before' else '')
                    self.assertEqual(value['bad']['errors'][0]['code'], 'kind')
                    self.assertTrue(value['good']['ok'])
                    self.assertIsNotNone(value['schema']['schema_error'])
                    self.assertFalse(value['nonfinite']['ok'])
                    self.assertEqual(value['calls'], [])

    def test_unsupported_objects_cannot_run_overloads_or_spoof_primitive_kind_tags(self):
        value = self.run_sprout('''type Sensitive:
    task equals(self, other):
        fail "Validation must not call user equality."
    task text(self):
        fail "Validation must not call user formatting."
type text:
    task equals(self, other):
        fail "Validation must not call user equality."
    task text(self):
        fail "Validation must not call user formatting."
make object = Sensitive()
make spoofed = text()
show json_encode({object: validate.check(object, {kind: "text"}), spoofed: validate.check(spoofed, {kind: "text"}), nullable: validate.check(object, {kind: "map", nullable: yes}), allowed: validate.check("x", {kind: "text", allowed: [object]}), bound: validate.check("x", {kind: "text", max_length: spoofed})})''')
        self.assertEqual(value['object']['errors'][0]['code'], 'kind')
        self.assertEqual(value['spoofed']['errors'][0]['code'], 'kind')
        self.assertEqual(value['nullable']['errors'][0]['code'], 'kind')
        self.assertIsNotNone(value['allowed']['schema_error'])
        self.assertIsNotNone(value['bound']['schema_error'])

    def test_unicode_character_and_list_length_boundaries(self):
        schema = {'kind': 'text', 'min_length': 4, 'max_length': 4}
        self.assertTrue(self.check('café', schema)['ok'])
        self.assertTrue(self.check('a🌱é中', schema)['ok'])
        self.assertEqual(self.check('🌱任务', schema)['errors'][0]['code'], 'min_length')
        self.assertEqual(self.check('café!', schema)['errors'][0]['code'], 'max_length')
        schema = {'kind': 'list', 'min_length': 1, 'max_length': 2, 'items': {'kind': 'number'}}
        self.assertTrue(self.check([1, 2], schema)['ok'])
        self.assertEqual(self.check([], schema)['errors'][0]['code'], 'min_length')
        self.assertEqual(self.check([1, 2, 'bad'], schema)['errors'][-1]['path'], [2])

    def test_invalid_schemas_are_rejected_before_any_input_validation(self):
        invalid = [None, [], 42, {}, {'kind': 'bytes'}, {'kind': 'text', 'required': True},
            {'kind': 'text', 'required': False}, {'kind': 'text', 'nullable': 1},
            {'kind': 'map', 'allow_unknown': 'yes'}, {'kind': 'map', 'fields': []},
            {'kind': 'list'}, {'kind': 'list', 'items': {'kind': 'text', 'required': True}},
            {'kind': 'text', 'min_length': -1}, {'kind': 'text', 'max_length': 1.5},
            {'kind': 'text', 'min_length': 2, 'max_length': 1}, {'kind': 'number', 'max_length': 2},
            {'kind': 'map', 'allowed': [{}]}, {'kind': 'list', 'items': {'kind': 'text'}, 'allowed': [[]]},
            {'kind': 'text', 'allowed': []}, {'kind': 'text', 'allowed': [42]},
            {'kind': 'text', 'allowed': [None]}, {'kind': 'text', 'unknown': True},
            {'kind': 'map', 'fields': {'': {'kind': 'text'}}},
            {'kind': 'map', 'fields': {'x': {'kind': 'text', 'required': 1}}}]
        result = self.run_sprout('make results = []\nfor each schema in ' + self.encoded(invalid) +
            ':\n    add(results, validate.check({unrelated: nothing}, schema))\nshow json_encode(results)')
        for index, value in enumerate(result):
            with self.subTest(schema=invalid[index]):
                self.assertFalse(value['ok'])
                self.assertEqual(value['errors'], [])
                self.assertIsInstance(value['schema_error']['path'], list)
                self.assertTrue(value['schema_error']['message'])
                self.assertFalse(value['truncated'])
        self.assertEqual(result, self.run_sprout('make results = []\nfor each schema in ' + self.encoded(invalid) +
            ':\n    add(results, validate.check(42, schema))\nshow json_encode(results)'))

    def test_recursive_schemas_and_data_are_bounded_without_serializing_or_mutating_them(self):
        value = self.run_sprout('''make recursive = {kind: "list"}
set recursive.items = recursive
make schema_result = validate.check(nothing, recursive)
make data = []
add(data, data)
make data_result = validate.check(data, {kind: "list", items: {kind: "text"}})
make allowed_cycle = []
add(allowed_cycle, allowed_cycle)
make allowed_result = validate.check("x", {kind: "text", allowed: allowed_cycle})
make unknown = {}
set unknown.loop = unknown
make opaque_result = validate.check(unknown, {kind: "map", allow_unknown: yes})
show json_encode({schema: schema_result, data: data_result, allowed: allowed_result, opaque: opaque_result, unchanged_data_length: length(data), retained_recursive_kind: recursive.kind, retained_unknown_fields: keys(unknown)})''')
        self.assertIn('16 levels', value['schema']['schema_error']['message'])
        self.assertEqual(len(value['schema']['schema_error']['path']), 17)
        self.assertEqual(value['data']['errors'][0]['path'], [0])
        self.assertIsNotNone(value['allowed']['schema_error'])
        self.assertTrue(value['opaque']['ok'])
        self.assertEqual(value['unchanged_data_length'], 1)
        self.assertEqual(value['retained_recursive_kind'], 'list')
        self.assertEqual(value['retained_unknown_fields'], ['loop'])

    def test_map_and_diagnostic_limits_do_not_copy_unbounded_field_names(self):
        self.assertTrue(self.check({'extra': {'opaque': 1}}, {'kind': 'map', 'allow_unknown': True})['ok'])
        result = self.check({str(i): 1 for i in range(128)}, {'kind': 'map'})
        self.assertEqual(len(result['errors']), 64)
        self.assertTrue(result['truncated'])
        result = self.check({str(i): 1 for i in range(129)}, {'kind': 'map', 'allow_unknown': True})
        self.assertEqual(result['errors'][0]['code'], 'limit')
        private = 'private-field-' + 'x' * 20000
        for result in (self.check({private: 'private-value'}, {'kind': 'map'}),
                       self.check({}, {'kind': 'map', 'fields': {private: {'kind': 'text'}}}),
                       self.check({}, {'kind': 'text', private: 1})):
            encoded = json.dumps(result)
            self.assertLess(len(encoded), 1000)
            self.assertNotIn('private-', encoded)
            self.assertIn('<field name exceeds 128 characters>', encoded)

    def test_exact_length_bounds_and_schema_aggregate_limits(self):
        result = self.run_sprout('''make fields = {}
for each index in range(16):
    set fields["f" + index] = {kind: "number", required: no, allowed: [1] * 256}
make within = validate.check({}, {kind: "map", fields: fields})
set fields.extra = {kind: "number", allowed: [1] * 256}
make over = validate.check({}, {kind: "map", fields: fields})
show json_encode({within: within, over: over, exact_bound: validate.check("ab", {kind: "text", max_length: integer("2")}), decimal_bound: validate.check("ab", {kind: "text", max_length: decimal("2.0")}), exact_text: validate.check("", {kind: "text", allowed: ["x" * 16384]}), over_text: validate.check("", {kind: "text", allowed: ["x" * 16385]})})''')
        self.assertTrue(result['within']['ok'])
        self.assertIn('4096', result['over']['schema_error']['message'])
        self.assertTrue(result['exact_bound']['ok'])
        self.assertIsNotNone(result['decimal_bound']['schema_error'])
        self.assertIsNone(result['exact_text']['schema_error'])
        self.assertIn('16384', result['over_text']['schema_error']['message'])

    def test_schema_node_limit_counts_shared_occurrences_and_preserves_aliases(self):
        value = self.run_sprout('''make leaf = {kind: "text", required: no}
make full = {}
for each index in range(127):
    set full["f" + index] = leaf
make last = {}
for each index in range(126):
    set last["f" + index] = leaf
make fields = {}
for each index in range(7):
    set fields["group" + index] = {kind: "map", required: no, fields: full}
set fields.last = {kind: "map", required: no, fields: last}
make within = validate.check({}, {kind: "map", fields: fields})
set last.extra = leaf
make over = validate.check({}, {kind: "map", fields: fields})
show json_encode({within: within, over: over, leaf_unchanged: leaf == {kind: "text", required: no}, full_count: length(full), last_count: length(last)})''')
        self.assertTrue(value['within']['ok'])
        self.assertIn('1024 nodes', value['over']['schema_error']['message'])
        self.assertTrue(value['leaf_unchanged'])
        self.assertEqual(value['full_count'], 127)
        self.assertEqual(value['last_count'], 127)

    def test_visited_value_and_hard_length_limits_are_explicit(self):
        value = self.run_sprout('''make schema = {kind: "list", items: {kind: "number"}}
show json_encode({within: validate.check([1] * 9999, schema), nodes: validate.check([1] * 10000, schema), length: validate.check([1] * 10001, schema), text: validate.check("x" * 1048577, {kind: "text"})})''')
        self.assertTrue(value['within']['ok'])
        self.assertEqual(value['nodes']['errors'][0]['path'], [9999])
        self.assertEqual(value['nodes']['errors'][0]['code'], 'limit')
        self.assertTrue(value['nodes']['truncated'])
        self.assertEqual(value['length']['errors'][0]['path'], [])
        self.assertEqual(value['length']['errors'][0]['code'], 'limit')
        self.assertFalse(value['length']['truncated'])
        self.assertEqual(value['text']['errors'][0]['code'], 'limit')


if __name__ == '__main__': unittest.main()
