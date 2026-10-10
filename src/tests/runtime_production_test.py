"""Real native failure/recovery probes for runtime budgets and workflow lifecycles."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

BINARY = Path(sys.argv.pop(1)).resolve()

def literal(value):
    if value is True: return 'yes'
    if value is False: return 'no'
    if value is None: return 'nothing'
    if isinstance(value, str): return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list): return '[' + ', '.join(map(literal, value)) + ']'
    if isinstance(value, dict): return '{' + ', '.join(literal(k) + ': ' + literal(v) for k, v in value.items()) + '}'
    return str(value)

def command(code): return [sys.executable, '-X', 'utf8', '-c', code]

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'main.sprout'
    def tearDown(self): self.temp.cleanup()
    def run_source(self, source, *flags, timeout=8):
        self.path.write_text(source, encoding='utf-8')
        return subprocess.run([str(BINARY), 'run', str(self.path), *flags], cwd=self.root,
                              capture_output=True, encoding='utf-8', timeout=timeout)
    def json(self, source, **kwargs):
        result = self.run_source(source, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)
    def workflow(self, jobs, **options):
        options = {'checkpoint': str(self.root / 'checkpoint.json'), **options}
        return 'use workflow\nshow json_encode(workflow.run(' + literal(jobs) + ', ' + literal(options) + '))\n'
    def launch(self, source):
        self.path.write_text(source, encoding='utf-8')
        return subprocess.Popen([str(BINARY), 'run', str(self.path)], cwd=self.root,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    def wait_file(self, path):
        deadline = time.monotonic() + 5
        while not path.exists() and time.monotonic() < deadline: time.sleep(.02)
        self.assertTrue(path.exists(), 'fixture never started')
    def test_step_budget_cannot_be_caught(self):
        r = self.run_source('try:\n    repeat while yes:\n        make x = 1\ncaught e:\n    show "caught"\n', '--max-steps', '100')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--max-steps', r.stderr)
        self.assertNotIn('caught', r.stdout)
    def test_counted_loop_is_bounded(self):
        r = self.run_source('repeat 1000000000 times:\n    skip\n', '--max-steps', '100')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--max-steps', r.stderr)
    def test_deadline(self):
        r = self.run_source('repeat while yes:\n    make x = 1\n', '--timeout-ms', '30')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--timeout-ms', r.stderr)
        r = self.run_source('wait(30)\n', '--timeout-ms', '30', timeout=2)
        self.assertNotEqual(r.returncode, 0); self.assertIn('--timeout-ms', r.stderr)
    def test_bad_limits(self):
        for flags in (('--max-steps', '0'), ('--timeout-ms', '-1'), ('--max-steps', '3x'), ('--max-steps',)):
            r = self.run_source('show 1\n', *flags)
            self.assertEqual(r.returncode, 2)
    def test_stdin_source(self):
        r = subprocess.run([str(BINARY), 'run', str(self.path), '--stdin', '--max-steps', '100'],
                           cwd=self.root, input='show 42\n', capture_output=True, encoding='utf-8')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), '42')
    def test_trace_scopes_and_module_file(self):
        module = self.root / 'helper.sprout'
        module.write_text('public task twice(n):\n    make result = n * 2\n    give result\n', encoding='utf-8')
        r = self.run_source('use helper\nmake x = helper.twice(21)\nshow x\n', '--trace-json')
        self.assertEqual(r.returncode, 0, r.stderr)
        events = [json.loads(l.removeprefix('@sprout-trace ')) for l in r.stderr.splitlines() if l.startswith('@sprout-trace ')]
        self.assertTrue(any(e['file'].endswith('helper.sprout') and e['stack'] for e in events))
        self.assertTrue(any('result' in e['variables'] for e in events))
        self.assertEqual(r.stdout.strip(), '42')
    def test_trace_is_bounded(self):
        r = self.run_source('repeat 6000 times:\n    make x = 1\nshow 42\n', '--trace-json')
        self.assertEqual(r.returncode, 0, r.stderr[-1000:])
        self.assertLessEqual(r.stderr.count('@sprout-trace '), 5000)
        self.assertEqual(r.stdout.strip(), '42')
    def test_corrupt_store_preserved(self):
        path = self.root / 'sprout.data.json'; path.write_text('{broken', encoding='utf-8')
        r = self.run_source('remember("new", 1)\n')
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(path.read_text(), '{broken')
        self.assertEqual((self.root / 'sprout.data.json.bak').read_text(), '{broken')
    def test_map_fields(self):
        self.assertEqual(self.json('make r = {ok: yes, value: 42}\nshow json_encode([r.ok, r.value])\n'), [True, 42])
        self.assertNotEqual(self.run_source('make r = {}\nshow r.missing\n').returncode, 0)
    def test_parallel_order(self):
        commands = [command('import time;time.sleep(.2);print("first")'), command('print("second")')]
        result = self.json('use process\nshow json_encode(process.parallel(' + literal(commands) + ', {workers: 2}))\n')
        self.assertEqual([r['stdout'].strip() for r in result], ['first', 'second'])
        self.assertTrue(all(r['ok'] for r in result))
    def test_parallel_failure_cleanup(self):
        commands = [command('import time;time.sleep(.15);raise SystemExit(3)'), command('import time;time.sleep(5)')]
        start = time.monotonic()
        result = self.json('show json_encode(parallel(' + literal(commands) + ', {workers: 2}))\n')
        self.assertLess(time.monotonic() - start, 3)
        self.assertFalse(result[0]['ok']); self.assertTrue(result[1]['cancelled'])
        result = self.json('show json_encode(parallel(' + literal([command('print(42)')]) + '))\n')
        self.assertTrue(result[0]['ok'])
    def test_parallel_collect_failures(self):
        result = self.json('show json_encode(parallel(' + literal([command('raise SystemExit(2)'), command('print(42)')]) + ', {fail_fast: no}))\n')
        self.assertFalse(result[0]['ok']); self.assertTrue(result[1]['ok'])
    def test_workflow_dependencies_resume(self):
        log = self.root / 'log.txt'
        first = command('from pathlib import Path;Path(' + repr(str(log)) + ').write_text("once")')
        last = command('from pathlib import Path;print(Path(' + repr(str(log)) + ').read_text())')
        jobs = [{'id': 'save', 'argv': first}, {'id': 'read', 'argv': last, 'after': ['save']}]
        source = self.workflow(jobs)
        result = self.json(source); self.assertTrue(result['ok']); self.assertFalse(result['resumed'])
        log.write_text('changed')
        result = self.json(source); self.assertTrue(result['resumed'])
        self.assertEqual(log.read_text(), 'changed')
        self.assertEqual(result['jobs'][1]['result']['stdout'].strip(), 'once')
    def test_workflow_rejects_cycle_before_side_effect(self):
        jobs = [{'id': 'a', 'argv': command('print(1)'), 'after': ['b']}, {'id': 'b', 'argv': command('print(2)'), 'after': ['a']}]
        r = self.run_source(self.workflow(jobs)); self.assertNotEqual(r.returncode, 0)
        self.assertIn('cycle', r.stderr); self.assertFalse((self.root / 'checkpoint.json').exists())
    def test_workflow_spec_drift_preserves_checkpoint(self):
        jobs = [{'id': 'a', 'argv': command('print(1)')}]
        self.assertTrue(self.json(self.workflow(jobs))['ok'])
        saved = (self.root / 'checkpoint.json').read_bytes()
        jobs[0]['argv'] = command('print(2)')
        self.assertNotEqual(self.run_source(self.workflow(jobs)).returncode, 0)
        self.assertEqual((self.root / 'checkpoint.json').read_bytes(), saved)
    def test_interrupted_unsafe_job_does_not_rerun(self):
        marker = self.root / 'started'
        job = {'id': 'unsafe', 'argv': command('from pathlib import Path;import time;Path(' + repr(str(marker)) + ').write_text("once");time.sleep(4)')}
        source = self.workflow([job]); process = self.launch(source)
        self.wait_file(marker); process.kill(); process.communicate(timeout=3)
        r = self.run_source(source); self.assertNotEqual(r.returncode, 0)
        self.assertIn('uncertain side effects', r.stderr)
        self.assertEqual(marker.read_text(), 'once')
    def test_interrupted_idempotent_job_can_resume(self):
        marker = self.root / 'started'
        code = 'from pathlib import Path;import time;p=Path(' + repr(str(marker)) + ');exists=p.exists();p.write_text("done");time.sleep(4 if not exists else 0)'
        source = self.workflow([{'id': 'safe', 'argv': command(code), 'idempotent': True}])
        process = self.launch(source); self.wait_file(marker); process.kill(); process.communicate(timeout=3)
        result = self.json(source); self.assertTrue(result['ok']); self.assertTrue(result['resumed'])
        self.assertEqual(result['jobs'][0]['attempts'], 2)
    def test_workflow_exclusive_lock(self):
        marker = self.root / 'started'
        source = self.workflow([{'id': 'a', 'argv': command('from pathlib import Path;import time;Path(' + repr(str(marker)) + ').touch();time.sleep(4)'), 'idempotent': True}])
        process = self.launch(source)
        try:
            self.wait_file(marker)
            r = self.run_source(source); self.assertNotEqual(r.returncode, 0); self.assertIn('locked', r.stderr)
        finally:
            process.kill(); process.communicate(timeout=3)
    def test_workflow_retry(self):
        marker = self.root / 'attempt'
        code = 'from pathlib import Path;p=Path(' + repr(str(marker)) + ');n=int(p.read_text()) if p.exists() else 0;p.write_text(str(n+1));raise SystemExit(1 if n==0 else 0)'
        result = self.json(self.workflow([{'id': 'retry', 'argv': command(code), 'idempotent': True, 'retries': 1}]))
        self.assertTrue(result['ok']); self.assertEqual(result['jobs'][0]['attempts'], 2)

if __name__ == '__main__': unittest.main()
