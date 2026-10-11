"""Native CLI library/example integration, including actual child commands and writes."""
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
EXAMPLE = ROOT / 'examples/cli/task-runner.sprout'


class CLILibrary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-cli-library-')
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / 'a report.json'

    def invoke(self, *arguments):
        return subprocess.run([str(BINARY), 'run', str(EXAMPLE), '--', *map(str, arguments)],
                              cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=15)

    def test_native_sprout_contracts(self):
        result = subprocess.run([str(BINARY), 'test', str(ROOT / 'src/tests/cli_library_test.sprout')],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('8 passed', result.stdout)

    def test_help_without_required_output_or_tasks(self):
        result = self.invoke('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Usage: task-runner [OPTIONS] TASK ...', result.stdout)
        self.assertIn('-o, --output TEXT', result.stdout)
        self.assertIn('[required]', result.stdout)
        self.assertIn('[repeatable]', result.stdout)
        self.assertFalse(self.output.exists())

    def test_help_resolves_source_library_from_another_directory(self):
        result = subprocess.run([str(BINARY), 'run', str(EXAMPLE), '--', '-h'],
                                cwd=self.temp.name, capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Usage: task-runner [OPTIONS] TASK ...', result.stdout)

    def test_dry_run_repeat_tags_and_no_effect(self):
        result = self.invoke('check', '-o', self.output, '-j', '1', '--tag=first', '-t', 'second', '-n')
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['tags'], ['first', 'second'])
        self.assertEqual(report['tasks'], ['check'])
        self.assertEqual(report['workers'], 1)
        self.assertTrue(report['dry_run'])
        self.assertNotIn('results', report)
        self.assertFalse(self.output.exists())

    def test_real_check_and_test_tasks_save_matching_atomic_report(self):
        result = self.invoke('check', 'test', '-o', self.output, '--command', BINARY, '-j', '2', '-t', "O'Reilly")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(json.loads(self.output.read_text(encoding='utf-8')), report)
        self.assertEqual(report['tasks'], ['check', 'test'])
        self.assertEqual(report['tags'], ["O'Reilly"])
        self.assertEqual(len(report['results']), 2)
        self.assertTrue(all(value['ok'] and value['exit'] == 0 for value in report['results']))
        self.assertIn('8 passed', report['results'][1]['stdout'])

    def test_child_start_failure_preserves_a_useful_report(self):
        result = self.invoke('check', '-o', self.output, '--command', Path(self.temp.name) / 'missing-executable')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('details were saved', result.stderr)
        report = json.loads(self.output.read_text(encoding='utf-8'))
        self.assertEqual(report['tasks'], ['check'])
        self.assertEqual(len(report['results']), 1)
        self.assertFalse(report['results'][0]['ok'])
        self.assertIsNotNone(report['results'][0]['error'])

    def test_errors_before_launch_or_output_write(self):
        cases = [(['-o', self.output, '--jobs', '-2', 'check'], '--jobs must be a whole number'),
                 (['-o', self.output, '--jobs=1.5', 'check'], '--jobs must be a whole number'),
                 (['-o', self.output, '--jobs=1e999', 'check'], 'finite decimal number'),
                 (['-o', self.output, '--jobs=2', '-j', '3', 'check'], 'supplied twice'),
                 (['-o', self.output, '--unknown', 'check'], 'Unknown flag'),
                 (['-o', self.output, '--jobs'], 'needs a number value'),
                 (['--output=', 'check'], '--output and --command must not be empty'),
                 (['-o', self.output, '--command=', 'check'], '--output and --command must not be empty'),
                 (['-o', self.output, 'missing-task'], 'Unknown task'),
                 (['--help', '--unknown'], 'Unknown flag')]
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                result = self.invoke(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
