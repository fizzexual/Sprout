"""Explicit builtin lookup contracts; run with an explicitly chosen native binary."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 and not sys.argv[1].startswith('-')
              else os.environ.get('SPROUT_BINARY', REPO / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout'))).resolve()


def c_function(source, declaration):
    """Bound a C function body, ignoring braces in comments/string literals."""
    start = source.index('{', source.index(declaration))
    depth = 0
    for token in re.finditer(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|\{|\}', source[start:], re.S):
        if token.group() == '{': depth += 1
        elif token.group() == '}':
            depth -= 1
            if not depth: return source[start:start + token.end()]
    raise AssertionError('unterminated fixture function: ' + declaration)


class IntrinsicBuiltins(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='sprout-intrinsic-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def source(self, code, name='app.sprout'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(code, encoding='utf-8', newline='\n')
        return path

    def run_code(self, code, *flags, input=None):
        path = self.source(code)
        env = os.environ.copy()
        env.pop('SPROUT_SANDBOX', None)
        return subprocess.run([str(BINARY), 'run', str(path), '--max-steps', '10000',
                               '--timeout-ms', '2000', *flags], cwd=self.root, env=env,
                              input=input, capture_output=True, encoding='utf-8', timeout=8)

    def output(self, code, expected, *flags, input=None):
        result = self.run_code(code, *flags, input=input)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), expected)
        return result

    def test_global_types_tasks_and_lexical_values_cannot_redirect_intrinsics(self):
        self.output('''type number:
    make value
task length(value):
    give 900
type length:
    make value
type kind_of:
    make value
type contains:
    make value
    make item
type keys:
    make value
type add:
    make value
    make item
type is_a:
    make value
    make tag
make length = task(value): 800
make errors = []
builtin::add(errors, "issue")
show builtin::json_encode({number: builtin::number("12"), length: builtin::length("café"), kind: builtin::kind_of(12), contains: builtin::contains([1, 2], 2), keys: builtin::keys({a: 1}), object: builtin::is_a(12, "number"), errors: errors})
''', '{"number":12,"length":4,"kind":"number","contains":true,"keys":["a"],"object":false,"errors":["issue"]}')

    def test_bare_constructor_task_capture_and_noncallable_shadow_contract_stays(self):
        self.output('''type number:
    make value
type visit:
    make value
task visit(value):
    give "task:" + value
make captured = visit
make length = 99
show builtin::json_encode(number("12"))
show builtin::number("12")
show builtin::json_encode(visit("x"))
show captured(value: "x")
show length
show length("café")
''', '{"value":"12"}\n12\n{"value":"x"}\ntask:x\n99\n4')

    def test_imported_library_uses_explicit_identity_and_keeps_helper_capture(self):
        self.source('private task visit(value):\n    give builtin::length(value)\n'
                    'private make visit = visit\npublic task count(value):\n    give visit(value)\n',
                    'modules/library.sprout')
        self.output('use library\ntype length:\n    make value\ntype visit:\n    make value\n'
                    'make length = task(value): 999\nshow library.count("café")\n', '4')

    def test_builtin_is_an_ordinary_variable_task_type_member_and_label(self):
        self.output('''task builtin(value):
    give value + 1
make stored = builtin
show stored(2)
make builtin = 7
make record = {builtin: builtin}
task consume(builtin):
    give builtin + 1
show consume(builtin: record.builtin)
make items = [0, 1, 2, 3, 4, 5, 6, 7, 8]
show items[builtin:]
show [1, 2, 3][:]
show [1, 2, 3][1:]
show [1, 2, 3][:2]
type Widget:
    task builtin(self, value):
        give value + 10
show Widget().builtin(2)
show builtin::number("12")
''', '3\n8\n[7, 8]\n[1, 2, 3]\n[2, 3]\n[1, 2]\n12\n12')
        self.output('type builtin:\n    make value\nshow builtin(3).value\n'
                    'show builtin::number("12")\n', '3\n12')

    def test_user_module_named_builtin_keeps_dotted_public_calls(self):
        self.source('public task number(value):\n    give "module:" + value\n', 'modules/builtin.sprout')
        self.output('use builtin\nshow builtin.number("12")\nshow builtin::number("12")\n',
                    'module:12\n12')

    def test_nested_intrinsics_labels_maps_indexes_slices_and_fstrings(self):
        self.output('''task consume(value, builtin = 0):
    give value + builtin
make record = {builtin: builtin::number("2")}
show consume(builtin::number("12"), builtin: record.builtin)
show [1, 2, 3][builtin::number("1"):builtin::length([1, 2, 3])]
show builtin :: number("4")
show f"count {builtin::length([1, 2])}"
show "builtin::number(0)"
''', '14\n[2, 3]\n4\ncount 2\nbuiltin::number(0)')

    def test_inputs_evaluate_once_in_written_order(self):
        self.output('''make events = []
task mark(value):
    builtin::add(events, value)
    give value
show builtin::pow(mark(2), mark(3))
show builtin::json_encode(events)
''', '8\n[2,3]')

    def test_pipeline_closure_and_default_keep_explicit_builtin_marker(self):
        self.output('''type number:
    make value
task parse(value, fallback = builtin::number("9")):
    give builtin::number(value) + fallback
make closure = task(value): value |> builtin::number()
show "12" |> builtin::number()
show closure("4")
show parse(value: "3")
''', '12\n4\n12')

    def test_named_inputs_reject_before_side_effects(self):
        self.output('''make events = []
task touched():
    builtin::add(events, "unexpected")
    give [1]
try:
    builtin::length(items: touched())
caught problem:
    show problem.kind
show builtin::json_encode(events)
''', 'argument\n[]')

    def test_unknown_identity_rejects_before_side_effects(self):
        result = self.run_code('task touched():\n    show "SIDE-EFFECT"\n    give 1\n'
                               'show builtin::missing_builtin(touched())\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn("no builtin operation called 'missing_builtin'", result.stderr)

    def test_too_many_inputs_reject_before_side_effects(self):
        result = self.run_code('task touched():\n    show "SIDE-EFFECT"\n    give 1\nshow builtin::length('
                               + ','.join(['touched()'] * 17) + ')\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('too many inputs', result.stderr)

    def test_direct_call_required_and_malformed_qualifiers_are_bounded_errors(self):
        for source, message in [
            ('make held = builtin::length\n', 'needs a call'),
            ('show "12" |> builtin::number\n', 'needs a call'),
            ('show builtin::\n', 'operation name'),
            ('show builtin:::length([])\n', 'operation name'),
            ('show builtin : : length([])\n', 'two colons together'),
            ('show other::length([])\n', "only 'builtin' uses"),
            ('show builtin::show(1)\n', 'operation name'),
            ('show builtin::length([1]\n', "')'"),
            ('make obj = {builtin: 1}\nshow obj.builtin::length([])\n', None),
        ]:
            with self.subTest(source=source):
                result = self.run_code(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                if message: self.assertIn(message, result.stderr)

    def test_exact_values_and_json_use_original_checked_handlers(self):
        self.output('''type integer:
    make value
type decimal:
    make value
type bytes:
    make value
show builtin::json_encode({id: builtin::integer("9223372036854775807"), money: builtin::decimal("1.25"), bytes: builtin::bytes([0, 255])})
show builtin::kind_of(builtin::json_decode("{\\"$sprout.integer\\":\\"12\\"}"))
''', '{"id":{"$sprout.integer":"9223372036854775807"},"money":{"$sprout.decimal":"1.25"},"bytes":{"$sprout.bytes":"00ff"}}\ninteger')

    def test_object_constructors_methods_super_and_overloads_keep_their_paths(self):
        self.output('''type Parent:
    make value = 2
    task total(self, amount):
        give self.value + amount
type Child from Parent:
    make other = 3
    task total(self, amount):
        give super.total(amount) + self.other
    task plus(self, other):
        give self.value + other
make child = Child(other: builtin::number("4"), value: 3)
show child.total(amount: 5)
show child + 10
show builtin::kind_of(child)
show builtin::is_a(child, "Parent")
''', '12\n13\nChild\nyes')

    def test_sandbox_permissions_cannot_be_bypassed(self):
        for operation, arguments in [('read', '"secret"'), ('file_write', '"marker", "bad"'),
                                     ('process', '["unexecuted-command"]'), ('env', '"SECRET"')]:
            with self.subTest(operation=operation):
                result = self.run_code('show builtin::' + operation + '(' + arguments + ')\n', '--sandbox')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('turned off', result.stderr)
                self.assertFalse((self.root / 'marker').exists())
        self.output('show builtin::number("12")\nshow builtin::length([1, 2])\n', '12\n2', '--sandbox')

    def test_runtime_step_budget_remains_enforced(self):
        result = self.run_code('repeat while yes:\n    make value = builtin::number("12")\n',
                               '--max-steps', '25')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('step', result.stderr)

    def test_native_worker_json_framing_with_intrinsics_in_sandbox(self):
        result = self.run_code('make request = builtin::json_decode(builtin::read_input())\n'
                               'show builtin::json_encode({count: builtin::length(request.items), id: builtin::integer(request.id)})\n',
                               '--sandbox', input='{"items":[1,2],"id":"9223372036854775807"}\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'count': 2, 'id': {'$sprout.integer': '9223372036854775807'}})
        self.assertEqual(len(result.stdout.splitlines()), 1)

    def test_imported_builtin_error_has_its_source_and_line(self):
        module = self.source('public task broken():\n    make value = 1\n    give builtin::length(value)\n', 'modules/broken.sprout')
        result = self.run_code('use broken\nshow broken.broken()\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('modules/' + module.name, result.stderr.replace('\\', '/'))
        self.assertIn('line 3', result.stderr)
        self.assertIn('length', result.stderr)

    def test_formatter_stdin_and_disk_preserve_intrinsic_calls(self):
        code = 'task count(value):\n  give builtin :: length(value)\nshow [1, 2] |> builtin::length()\nshow count([1])\n'
        path = self.source(code)
        before = path.read_bytes()
        result = subprocess.run([str(BINARY), 'format', str(path), '--stdin'], cwd=self.root,
                                input=code, capture_output=True, encoding='utf-8', timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(path.read_bytes(), before)
        self.assertIn('builtin::length()', result.stdout)
        formatted = result.stdout
        self.output(formatted, '2\n1')
        check = subprocess.run([str(BINARY), 'format', str(path), '--check'], cwd=self.root,
                               capture_output=True, encoding='utf-8', timeout=8)
        self.assertEqual(check.returncode, 0, check.stderr)
        path.write_text(code, encoding='utf-8', newline='\n')
        written = subprocess.run([str(BINARY), 'format', str(path), '--write'], cwd=self.root,
                                 capture_output=True, encoding='utf-8', timeout=8)
        self.assertEqual(written.returncode, 0, written.stderr)
        self.assertEqual(path.read_text(encoding='utf-8'), formatted)
        run = subprocess.run([str(BINARY), 'run', str(path)], cwd=self.root,
                             capture_output=True, encoding='utf-8', timeout=8)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), '2\n1')

    def test_learn_renderer_keeps_explicit_identity(self):
        result = self.run_code('learn on\nshow builtin::number("12")\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('builtin::number(', result.stdout)

    def test_registry_has_no_missing_legacy_dispatcher_names_and_every_identity_resolves(self):
        source = (REPO / 'src/sprout.c').read_text(encoding='utf-8')
        registry = source[source.index('BUILTIN_NAMES[]'):source.index('static const int NBUILTIN_NAMES')]
        known = set(re.findall(r'"([A-Za-z_][A-Za-z_0-9]*)"', registry))
        body = c_function(source, 'static Value call_builtin(')
        dispatched = set(re.findall(r'strcmp\(\s*name\s*,\s*"([A-Za-z_][A-Za-z_0-9]*)"', body))
        # The removed global run spelling has only a migration error, not a builtin handler.
        self.assertEqual(dispatched - {'run'} - known, set())
        for file, function in [('exact_numeric.h', 'exact_builtin_name'), ('binary_values.h', 'bytes_builtin_name'),
                               ('runtime_foundation.h', 'foundation_builtin_name'), ('stdlib.inc', 'production_builtin_name'),
                               ('parallel_runtime.h', 'parallel_builtin_name'), ('workflow_runtime.h', 'workflow_builtin_name')]:
            text = (REPO / 'src' / file).read_text(encoding='utf-8')
            predicate = c_function(text, 'static int ' + function + '(')
            known.update(re.findall(r'"([A-Za-z_][A-Za-z_0-9]*)"', predicate))
        code = 'task unexpected():\n    show "SIDE-EFFECT"\n    give 1\nmake results = []\n'
        for name in sorted(known):
            code += 'try:\n    builtin::' + name + '(named: unexpected())\ncaught issue:\n    builtin::add(results, issue.kind)\n'
        code += 'show builtin::json_encode(results)\n'
        result = self.run_code(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['argument'] * len(known))
        self.assertGreater(len(known), 100)

    def test_shared_sprout_corpus(self):
        result = subprocess.run([str(BINARY), 'test', str(REPO / 'src/tests/intrinsic_builtin_test.sprout')],
                                cwd=self.root, capture_output=True, encoding='utf-8', timeout=8)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
