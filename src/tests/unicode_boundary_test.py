"""Ordinary UTF-8 CLI/filesystem/SDK controls with bounded temporary fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

BINARY = Path(sys.argv.pop(1)).resolve()
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'integrations/python'))
from sprout_host import run as host_run


class UnicodeBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-unicode-boundary-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def execute(self, arguments, *, cwd=None, executable=BINARY, environment=None):
        result = subprocess.run([str(executable), *map(str, arguments)], cwd=cwd or self.root,
            env=environment, capture_output=True, timeout=8,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertGreaterEqual(result.returncode, 0, 'native crash is not an ordinary rejection')
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        return result

    def success(self, arguments, **kwargs):
        result = self.execute(arguments, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        return result

    def source(self, filename, body, *, directory=None):
        path = (directory or self.root) / filename
        path.write_text(body, encoding='utf-8')
        return path

    def test_ascii_and_unicode_source_names_and_current_directory(self):
        for dirname in ('ascii', '项目 café 🌱'):
            directory = self.root / dirname; directory.mkdir()
            for filename in ('ascii.sprout', 'café.sprout', '规则🌱.sprout'):
                with self.subTest(directory=dirname, file=filename):
                    path = self.source(filename, 'show json_encode(42)\n', directory=directory)
                    for argument in (path, Path(filename)):
                        result = self.success(['run', argument], cwd=directory)
                        self.assertEqual(json.loads(result.stdout), 42)

    def test_arguments_preserve_unicode_spaces_quotes_empty_and_flag_separator(self):
        path = self.source('args🌱.sprout', 'show json_encode(args())\n')
        arguments = ['', ' ', 'Café', '🌱任务', 'quoted "text"', 'quote\\"inside', 'trailing\\',
                     'two\\\\"slashes', 'wild*card?', '--sandbox', '--max-steps', 'not-a-number']
        result = self.success(['--max-steps', '5000', 'run', path, '--timeout-ms', '1000', '--', *arguments])
        self.assertEqual(json.loads(result.stdout), arguments)
        self.assertEqual(json.loads(self.success(['run', path]).stdout), [])

    @unittest.skipUnless(os.name == 'nt', 'Windows UTF-16 command-line boundary')
    def test_valid_utf16_surrogate_pair_is_preserved_as_one_scalar(self):
        path = self.source('pairs.sprout', 'show json_encode(args())\n')
        result = self.success(['run', path, '\ud83c\udf31'])
        self.assertEqual(json.loads(result.stdout), ['🌱'])

    @unittest.skipUnless(os.name == 'nt', 'Windows UTF-16 command-line boundary')
    def test_unpaired_utf16_surrogate_rejects_before_execution(self):
        path = self.source('invalid.sprout', 'write("unexpected-marker", "ran")\n')
        result = self.execute(['run', path, '\ud800'])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'valid UTF-8', result.stderr)
        self.assertFalse((self.root / 'unexpected-marker').exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows canonical UTF-8 path scan boundary')
    def test_long_canonical_unicode_root_fails_closed_before_fixed_path_scan(self):
        compiler = os.environ.get('SPROUT_CC') or shutil.which('cc') or shutil.which('gcc') or shutil.which('clang')
        if not compiler: self.fail('Path boundary verification requires a C compiler; set SPROUT_CC')
        control = self.root / 'path-control.exe'
        built = subprocess.run([compiler, '-O0', '-I' + str(ROOT / 'src'),
            str(ROOT / 'src/tests/fixtures/unicode_path_scan.c'), '-o', str(control),
            '-lm', '-lurlmon', '-Wl,--stack,67108864'], capture_output=True, timeout=90)
        self.assertEqual(built.returncode, 0, built.stderr.decode('utf-8', 'replace')[-6000:])
        observed = json.loads(self.success([], executable=control).stdout)
        self.assertTrue(observed['short_path_accepted'])
        self.assertTrue(observed['long_path_rejected'])
        self.assertGreaterEqual(observed['root_utf8_bytes'], 1024)
        self.assertEqual(list(self.root.iterdir()), [control], 'normalization must not publish files')

    def test_import_and_check_in_unicode_project(self):
        directory = self.root / '项目 café 🌱'; directory.mkdir()
        self.source('helper.sprout', 'public task answer():\n    give 42\n', directory=directory)
        path = self.source('main🌱.sprout', 'use helper\nshow json_encode(helper.answer())\n', directory=directory)
        self.assertEqual(json.loads(self.success(['run', path], cwd=directory).stdout), 42)
        checked = self.success(['check', path], cwd=directory)
        self.assertIn('main🌱.sprout', checked.stdout.decode('utf-8'))

    def test_new_project_preserves_acp_and_non_acp_names_and_existing_contents(self):
        for name in ('project-café', 'project-项目🌱'):
            with self.subTest(project=name):
                self.success(['new', name, 'starter'])
                folder = self.root / name
                self.assertTrue((folder / 'sprout.toml').is_file())
                self.assertTrue((folder / 'app.sprout').is_file())
                self.success(['build'], cwd=folder)
                original = (folder / 'app.sprout').read_bytes()
                self.assertEqual(self.execute(['new', name, 'starter']).returncode, 1)
                self.assertEqual((folder / 'app.sprout').read_bytes(), original)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['project-café', 'project-项目🌱'])

    def test_formatter_updates_the_correct_unicode_source(self):
        path = self.source('format-café🌱.sprout', 'make x=1   \nshow json_encode(x)\n')
        self.assertEqual(self.execute(['format', path, '--check']).returncode, 1)
        self.success(['format', path, '--write'])
        self.success(['format', path, '--check'])
        self.assertEqual(json.loads(self.success(['run', path]).stdout), 1)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_legacy_file_calls_use_the_same_unicode_path_as_native_files(self):
        name = 'legacy-café🌱.txt'
        path = self.source('files.sprout', 'write(' + json.dumps(name, ensure_ascii=False) + ', "one")\n'
            'append(' + json.dumps(name, ensure_ascii=False) + ', "two")\n'
            'show json_encode([exists(' + json.dumps(name, ensure_ascii=False) + '), read(' + json.dumps(name, ensure_ascii=False) + ')])\n')
        self.assertEqual(json.loads(self.success(['run', path]).stdout), [True, 'onetwo'])
        self.assertEqual((self.root / name).read_text(encoding='utf-8'), 'onetwo')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['files.sprout', name])

    def test_local_unicode_package_source_lock_restore_and_remove(self):
        directory = self.root / '项目café🌱'; directory.mkdir()
        for name in ('package-café.sprout', 'package-任务🌱.sprout'):
            with self.subTest(source=name):
                source = self.source(name, 'public task answer():\n    give 42\n', directory=directory)
                self.success(['add', source.name, 'local'], cwd=directory)
                installed = directory / 'sprout_packages/local.sprout'
                self.assertEqual(installed.read_bytes(), source.read_bytes())
                locked = (directory / 'sprout.lock').read_bytes()
                self.assertIn(name, locked.decode('utf-8'))
                installed.unlink()
                self.success(['install', '--locked'], cwd=directory)
                self.assertEqual(installed.read_bytes(), source.read_bytes())
                self.assertEqual((directory / 'sprout.lock').read_bytes(), locked)
                program = self.source('main.sprout', 'use local\nshow json_encode(local.answer())\n', directory=directory)
                self.assertEqual(json.loads(self.success(['run', program], cwd=directory).stdout), 42)
                self.success(['remove', 'local'], cwd=directory)
                self.assertFalse(installed.exists())

    def test_bundle_unicode_self_path_assets_arguments_and_temp_cleanup(self):
        directory = self.root / '项目 café🌱'; directory.mkdir()
        asset = directory / 'assets/数据-café🌱.txt'; asset.parent.mkdir()
        asset.write_text('hello🌱', encoding='utf-8')
        relative = 'assets/' + asset.name
        path = self.source('entry-café🌱.sprout',
            'show json_encode({arguments: args(), asset: read(' + json.dumps(relative, ensure_ascii=False) + ')})\n', directory=directory)
        bundle = directory / ('bundle-café🌱.exe' if os.name == 'nt' else 'bundle-café🌱')
        self.success(['bundle', path.name, '-o', bundle.name, '--asset', relative], cwd=directory)
        destination = self.root / 'elsewhere🌱'; destination.mkdir()
        relocated = destination / ('移动🌱.exe' if os.name == 'nt' else '移动🌱')
        shutil.copy2(bundle, relocated)
        temporary = self.root / 'temporary café🌱'; temporary.mkdir()
        environment = os.environ.copy()
        environment.update(TEMP=str(temporary), TMP=str(temporary), TMPDIR=str(temporary))
        arguments = ['', 'Café🌱', 'quoted "text"']
        result = self.success(arguments, cwd=destination, executable=relocated, environment=environment)
        self.assertEqual(json.loads(result.stdout), {'arguments': arguments, 'asset': 'hello🌱'})
        self.assertEqual(list(temporary.iterdir()), [], 'bundle temporary project was not removed')

    def test_test_command_enumerates_unicode_test_filename(self):
        directory = self.root / '项目café🌱'; directory.mkdir()
        tests = directory / 'tests'; tests.mkdir()
        self.source('检查🌱.sprout', 'test "unicode source":\n    expect 1 == 1\n', directory=tests)
        self.success(['test'], cwd=directory)

    def test_actual_sdk_launch_with_unicode_executable_source_and_cwd(self):
        directory = self.root / 'SDK 项目🌱'; directory.mkdir()
        copied = directory / ('解释器🌱.exe' if os.name == 'nt' else '解释器🌱')
        shutil.copy2(BINARY, copied)
        path = self.source('规则 café🌱.sprout', 'show json_encode(json_decode(read_input()))\n', directory=directory)
        data = {'label': 'Café🌱任务', 'empty': '', 'quoted': '"two words"'}
        self.assertEqual(host_run(path, data, command=copied, cwd=directory, timeout_ms=2000,
                                  runtime_timeout_ms=1000, max_steps=5000), data)

    def test_unicode_workflow_checkpoint_resumes_completed_job(self):
        directory = self.root / 'workflow项目🌱'; directory.mkdir()
        checkpoint = directory / '状态-café🌱.json'
        marker = directory / 'counter🌱'
        command = [sys.executable, '-X', 'utf8', '-c',
                   'from pathlib import Path;p=Path(' + repr(str(marker)) + ');p.write_text(str(int(p.read_text())+1) if p.exists() else "1")']
        jobs = [{"id": "任务🌱", "argv": command}]
        options = {"checkpoint": str(checkpoint), "workers": 1}
        path = self.source('workflow.sprout', 'use workflow\nshow json_encode(workflow.run(' +
            json.dumps(jobs, ensure_ascii=False) + ', ' + json.dumps(options, ensure_ascii=False) + '))\n', directory=directory)
        first = json.loads(self.success(['run', path], cwd=directory).stdout)
        self.assertTrue(first['ok']); self.assertFalse(first['resumed'])
        second = json.loads(self.success(['run', path], cwd=directory).stdout)
        self.assertTrue(second['ok']); self.assertTrue(second['resumed'])
        self.assertEqual(marker.read_text(), '1')
        self.assertEqual(second['jobs'][0]['id'], '任务🌱')


if __name__ == '__main__': unittest.main()
