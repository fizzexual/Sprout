"""Named inputs and multiline text regression contracts against the native runtime."""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

BINARY = pathlib.Path(sys.argv.pop(1) if len(sys.argv) > 1 else
                      pathlib.Path(__file__).parents[1] / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()


class Ergonomics(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-ergonomics-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def source(self, code, name='app.sprout'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(code.encode())
        return path

    def run_code(self, code, *options):
        path = self.source(code)
        return subprocess.run([str(BINARY), *options, 'run', str(path)], cwd=self.root,
                              capture_output=True, text=True, encoding='utf-8', timeout=10)

    def assert_output(self, code, expected):
        result = self.run_code(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), expected)

    def test_reordering_defaults_and_mixed_calls(self):
        self.assert_output('task greet(name, punctuation = "!"):\n    give name + punctuation\n'
                           'show greet(punctuation: "?", name: "Sam")\n'
                           'show greet(name: "Pat")\nshow greet("Alex", punctuation: ".")\n',
                           'Sam?\nPat!\nAlex.')

    def test_defaults_see_bound_inputs(self):
        self.assert_output('task total(a, b = 2, c = a + b):\n    give a + b + c\n'
                           'show total(c: 20, a: 1)\nshow total(a: 3)\n', '23\n10')

    def test_named_arguments_preserve_source_evaluation_order(self):
        self.assert_output('make events = []\ntask mark(label):\n    add(events, label)\n    give label\n'
                           'task pair(a, b):\n    give a + b\n'
                           'show pair(b: mark("B"), a: mark("A"))\nshow join(events, ",")\n', 'AB\nB,A')

    def test_closures_modules_and_pipelines(self):
        self.source('public task joiner(first, second = "!"):\n    give first + second\n', 'modules/words.sprout')
        self.assert_output('use words\nmake joiner = task(first, second = "!"): first + second\n'
                           'show joiner(second: "?", first: "lambda")\n'
                           'show words.joiner(second: ".", first: "module")\n'
                           'show "pipe" |> joiner(second: "!")\n', 'lambda?\nmodule.\npipe!')

    def test_methods_super_and_inherited_constructors(self):
        self.assert_output('type Parent:\n    make base = 0\n    task score(self, a, b = 3):\n        give self.base + a + b\n'
                           'type Child from Parent:\n    make label = "default"\n'
                           '    task score(self, a, b = 4):\n        give super.score(b: b, a: a) + 1\n'
                           'make child = Child(label: "named", base: 10)\n'
                           'show child.label\nshow child.score(b: 2, a: 1)\n'
                           'show Child(base: 5).score(a: 1)\n', 'named\n14\n11')

    def test_constructor_explicit_inputs_evaluate_in_source_order(self):
        self.assert_output('make events = []\ntask mark(label):\n    add(events, label)\n    give label\n'
                           'type Pair:\n    make a = "default"\n    make b = "default"\n'
                           'make pair = Pair(b: mark("B"), a: mark("A"))\n'
                           'show pair.a + pair.b\nshow join(events, ",")\n', 'AB\nB,A')

    def test_invalid_inputs_have_clear_errors_before_side_effects(self):
        prefix = 'task touch():\n    write("effect.txt", "unexpected")\n    give 1\ntask pair(a, b = 2):\n    give a + b\n'
        cases = [('pair(unknown: touch())', 'no input'),
                 ('pair(1, a: touch())', 'supplied twice'),
                 ('pair(b: touch())', "needs a value for 'a'"),
                 ('pair(a: touch(), a: 2)', 'named twice'),
                 ('pair(a: touch(), 2)', 'positional inputs'),
                 ('length(value: touch())', 'builtin operations')]
        for call, message in cases:
            with self.subTest(call=call):
                result = self.run_code(prefix + 'show ' + call + '\n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.root / 'effect.txt').exists())

    def test_named_type_annotations_remain_enforced(self):
        result = self.run_code('task numeric(a: number, b: text = ""):\n    give a\nshow numeric(a: "bad")\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("input 'a'", result.stderr)
        self.assertIn('must be a number', result.stderr)

    def test_multiline_literals_preserve_comments_brackets_and_whitespace(self):
        self.assert_output('make message = """first  \n\n~ text with [ { ( ) } ]\n  last"""\n'
                           'show json_encode(message)\nshow length("""""")\n',
                           '"first  \\n\\n~ text with [ { ( ) } ]\\n  last"\n0')

    def test_multiline_escape_sequences_and_line_numbers(self):
        self.assert_output('show """quote: \\" and newline:\\nend"""\n', 'quote: " and newline:\nend')
        result = self.run_code('make text = """first\nsecond\nthird"""\nshow missing\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('line 4', result.stderr)

    def test_unterminated_triples_and_interpolated_triples_fail_clearly(self):
        for code, message in [('show """missing\n', 'closing triple quote'),
                              ('show f"""unsupported\n"""\n', 'multiline interpolated')]:
            result = self.run_code(code)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)

    def test_formatter_is_idempotent_and_preserves_multiline_content(self):
        code = 'when yes:\n  make message = """first  \n\n ~ raw [ { (  \n  last"""\n  show json_encode(message)\n'
        original = self.run_code(code)
        path = self.source(code)
        formatted = subprocess.run([str(BINARY), 'format', str(path)], cwd=self.root,
                                   capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(formatted.returncode, 0, formatted.stderr)
        self.assertIn('first  \n\n ~ raw [ { (  \n  last', formatted.stdout)
        after = self.run_code(formatted.stdout)
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertEqual(original.stdout, after.stdout)
        path = self.source(formatted.stdout)
        again = subprocess.run([str(BINARY), 'format', str(path)], cwd=self.root,
                               capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(again.stdout, formatted.stdout)

    def test_multiline_crlf_content_is_preserved_by_formatter(self):
        code = 'make message = """first\r\n  second\r\nlast"""\r\nshow json_encode(message)\r\n'
        original = self.run_code(code)
        path = self.source(code)
        formatted = subprocess.run([str(BINARY), 'format', str(path)], cwd=self.root, capture_output=True, timeout=10)
        self.assertIn(b'first\r\n  second\r\nlast', formatted.stdout)
        after = self.run_code(formatted.stdout.decode())
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertEqual(original.stdout, after.stdout)

    def test_learn_trace_renders_argument_names(self):
        result = self.run_code('task greet(name):\n    give name\nlearn on\nshow greet(name: "Sam")\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('name:', result.stdout)


if __name__ == '__main__':
    unittest.main()
