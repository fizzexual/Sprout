"""CLI regressions; uses only Python's standard library and a built interpreter."""
import pathlib
import subprocess
import sys
import tempfile
import unittest

BINARY = pathlib.Path(sys.argv.pop(1) if len(sys.argv) > 1 else
                      pathlib.Path(__file__).parents[1] / ('sprout.exe' if sys.platform == 'win32' else 'sprout')).resolve()


class CLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-cli-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def source(self, name, code):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(code, encoding='utf-8')
        return target

    def run_sprout(self, *args, input=None):
        return subprocess.run([str(BINARY), *map(str, args)], cwd=self.root,
                              input=input, capture_output=True, text=True,
                              encoding='utf-8', timeout=10)

    def test_check_never_executes_entry_or_imports(self):
        self.source('modules/helper.sprout', 'write("module-effect", "bad")\npublic task hello():\n    give 42\n')
        entry = self.source('app.sprout', 'use helper\nwrite("entry-effect", "bad")\nrepeat while yes:\n    show 1\n')
        result = self.run_sprout('check', entry)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'module-effect').exists())
        self.assertFalse((self.root / 'entry-effect').exists())

    def test_check_reports_missing_imports(self):
        entry = self.source('app.sprout', 'use missing\n')
        result = self.run_sprout('check', entry)
        self.assertEqual(result.returncode, 1)
        self.assertIn("couldn't find a module", result.stderr)

    def test_check_reports_syntax_errors_in_imports(self):
        self.source('modules/helper.sprout', 'make x = [\n')
        entry = self.source('app.sprout', 'use helper\n')
        result = self.run_sprout('check', entry)
        self.assertEqual(result.returncode, 1)
        self.assertIn('helper.sprout', result.stderr)

    def test_check_handles_circular_imports_without_running(self):
        self.source('modules/a.sprout', 'use b\nshow 1 / 0\n')
        self.source('modules/b.sprout', 'use a\nshow 1 / 0\n')
        entry = self.source('app.sprout', 'use a\n')
        result = self.run_sprout('check', entry)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_stdin_uses_unsaved_buffer_and_original_path(self):
        entry = self.source('app.sprout', 'make broken = [\n')
        self.source('modules/helper.sprout', 'show 1 / 0\n')
        result = self.run_sprout('check', entry, '--stdin', input='use helper\nshow 42\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_sprout('check', entry, '--stdin', input='make x = [\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn(str(entry), result.stderr)

    def test_inheritance_cycles_are_errors_instead_of_crashes(self):
        for code in ['type A from A:\n    make x = 0\nshow A()\n',
                     'type A from B:\n    make x = 0\ntype B from A:\n    make y = 0\nshow A()\n',
                     'interface I:\n    speak\ntype A from I:\n    make x = 0\nshow A()\n',
                     'type A from I:\n    make x = 0\ninterface I:\n    speak\nshow A()\n']:
            with self.subTest(code=code):
                entry = self.source('app.sprout', code)
                result = self.run_sprout('run', entry)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn('Sprout error', result.stderr)

    def test_forward_inheritance_still_works(self):
        entry = self.source('app.sprout', 'type Child from Parent:\n    make y = 2\ntype Parent:\n    make x = 1\nshow Child().x\n')
        result = self.run_sprout('run', entry)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '1')

    def test_stored_tasks_survive_loading_more_definitions(self):
        self.source('many.sprout', ''.join('public task task%d(n):\n    give n\n' % i for i in range(20)))
        entry = self.source('app.sprout', 'task original(n):\n    give n * n\nmake saved = original\nuse many\nshow saved(6)\n')
        result = self.run_sprout('run', entry)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '36')


if __name__ == '__main__':
    unittest.main()
