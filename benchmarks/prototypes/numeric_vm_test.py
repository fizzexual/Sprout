"""Experimental numeric bytecode must preserve AST results, failures and step limits."""
import os
import pathlib
import random
import subprocess
import sys
import tempfile
import unittest

BINARY = pathlib.Path(sys.argv.pop(1)).resolve()


class NumericVM(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-vm-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def run_mode(self, code, mode, *flags):
        path = self.root / 'program.sprout'
        path.write_text(code, encoding='utf-8')
        env = os.environ.copy()
        env['SPROUT_NUMERIC_VM'] = str(mode)
        env['SPROUT_NUMERIC_VM_STATS'] = '0'
        return subprocess.run([str(BINARY), *flags, 'run', str(path)], cwd=self.root,
                              env=env, capture_output=True, text=True, encoding='utf-8', timeout=10)

    def assert_parity(self, code, *flags):
        ast = self.run_mode(code, 0, *flags)
        vm = self.run_mode(code, 1, *flags)
        self.assertEqual((vm.returncode, vm.stdout, vm.stderr), (ast.returncode, ast.stdout, ast.stderr))
        return vm

    def test_generated_numeric_expression_parity(self):
        rng = random.Random(1701)
        def expression(depth):
            if depth <= 0 or rng.random() < .25:
                return rng.choice(['a', 'b', str(rng.randint(-20, 20))])
            op = rng.choice(['+', '-', '*', '/', '%'])
            right = str(rng.randint(1, 20)) if op in ['/', '%'] else expression(depth - 1)
            return '(' + expression(depth - 1) + ' ' + op + ' ' + right + ')'
        code = 'make a = 3\nmake b = -2\n' + ''.join('show ' + expression(5) + '\n' for _ in range(100))
        self.assertEqual(self.assert_parity(code).returncode, 0)

    def test_dynamic_types_exact_numbers_and_objects_fall_back(self):
        code = ('make a = 1\nshow a + 2\nset a = "text"\nshow a + "!"\nset a = 3\nshow a + 2\n'
                'show integer("9007199254740993") + integer("1")\nshow decimal("0.1") + decimal("0.2")\n'
                'type NumberBox:\n    make value = 0\n    task plus(self, other):\n        give self.value + other\n'
                'show NumberBox(4) + 3\n')
        self.assertEqual(self.assert_parity(code).returncode, 0)

    def test_math_and_name_errors_match(self):
        for expression in ['1 / 0', '(1 / 0) + missing', 'missing + 1', '1 % 0', '1 - "text"']:
            with self.subTest(expression=expression):
                self.assertNotEqual(self.assert_parity('show ' + expression + '\n').returncode, 0)

    def test_exact_step_limit_matches(self):
        code = 'make value = 0\nrepeat 100 times:\n    set value = (value + 1) * 2 - value\nshow value\n'
        for limit in [1, 4, 10, 30, 200, 3000]:
            with self.subTest(limit=limit):
                self.assert_parity(code, '--max-steps', str(limit))

    def test_unsupported_deep_expressions_fall_back(self):
        expression = '1'
        for _ in range(50):
            expression = '(' + expression + ' + 1)'
        self.assertEqual(self.assert_parity('show ' + expression + '\n').returncode, 0)

    def test_profile_reports_real_bytecode_executions(self):
        path = self.root / 'profile.sprout'
        path.write_text('make a = 1\nrepeat 100 times:\n    set a = a * 2 % 17\nshow a\n')
        env = os.environ.copy()
        env.update(SPROUT_NUMERIC_VM='1', SPROUT_NUMERIC_VM_STATS='1')
        result = subprocess.run([str(BINARY), 'run', str(path)], cwd=self.root, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stderr, r'SPROUT_NUMERIC_VM_PROFILE .*"executions":100[,}]')


if __name__ == '__main__':
    unittest.main()
