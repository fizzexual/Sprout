"""Distribution contracts exercised against a real native interpreter, without external services."""
import hashlib
import http.server
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest

BINARY = pathlib.Path(sys.argv.pop(1) if len(sys.argv) > 1 else
                      pathlib.Path(__file__).parents[1] / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()


class Distribution(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-dist-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.elsewhere = self.root / 'elsewhere'
        self.elsewhere.mkdir()

    def file(self, name, content, base=None):
        target = (base or self.project) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())
        return target

    def run_sprout(self, *args, cwd=None, input=None):
        return subprocess.run([str(BINARY), *map(str, args)], cwd=cwd or self.project,
                              capture_output=True, text=True, encoding='utf-8', input=input, timeout=20)

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def bundle(self, entry='app.sprout', output='app', *extra):
        self.assert_ok(self.run_sprout('bundle', entry, '-o', output, *extra))
        return self.project / (output + '.exe' if os.name == 'nt' else output)

    def run_bundle(self, binary, *args):
        return subprocess.run([str(binary), *args], cwd=self.elsewhere,
                              capture_output=True, text=True, encoding='utf-8', timeout=20)

    def add_single(self):
        code = 'public task square(n):\n    give n * n\n'
        self.file('vendor/mathx.sprout', code)
        self.assert_ok(self.run_sprout('add', 'vendor/mathx.sprout'))
        return code

    def http_server(self):
        directory = str(self.project)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=directory, **kwargs)
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:%d' % server.server_port

    def test_lock_digest_and_restore_are_reproducible(self):
        code = self.add_single()
        before = (self.project / 'sprout.lock').read_bytes()
        self.assertIn(hashlib.sha256(code.encode()).hexdigest().encode(), before)
        shutil.rmtree(self.project / 'sprout_packages')
        self.assert_ok(self.run_sprout('install', '--locked'))
        self.assertEqual((self.project / 'sprout_packages/mathx.sprout').read_text(), code)
        self.assertEqual((self.project / 'sprout.lock').read_bytes(), before)

    def test_existing_package_tampering_is_rejected(self):
        self.add_single()
        self.file('sprout_packages/mathx.sprout', 'show "tampered"\n')
        result = self.run_sprout('install', '--locked')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Checksum mismatch', result.stderr)

    def test_source_drift_is_rejected_before_install(self):
        self.add_single()
        before = (self.project / 'sprout.lock').read_bytes()
        shutil.rmtree(self.project / 'sprout_packages')
        self.file('vendor/mathx.sprout', 'show "source changed"\n')
        result = self.run_sprout('install')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.project / 'sprout_packages/mathx.sprout').exists())
        self.assertEqual((self.project / 'sprout.lock').read_bytes(), before)

    def test_locked_requires_lock_and_legacy_install_bootstraps(self):
        self.file('vendor/a.sprout', 'public task answer():\n    give 42\n')
        self.file('sprout.packages', 'a vendor/a.sprout\n')
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)
        self.assert_ok(self.run_sprout('install'))
        self.assertTrue((self.project / 'sprout.lock').exists())
        self.assert_ok(self.run_sprout('install', '--locked'))

    def test_corrupt_lock_and_manifest_changes_fail(self):
        self.add_single()
        self.file('sprout.packages', 'mathx different-source.sprout\n')
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)
        self.file('sprout.lock', '# sprout.lock v1 sha256\nmathx vendor/mathx.sprout not-a-hash ../escape\n')
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)

    def test_multifile_package_relative_imports_and_namespace(self):
        self.file('vendor/toolbox/sprout.package', 'entry main.sprout\nfile lib/helper.sprout\n')
        self.file('vendor/toolbox/main.sprout', 'use "lib/helper.sprout"\npublic task answer():\n    give helper.answer()\n')
        self.file('vendor/toolbox/lib/helper.sprout', 'public task answer():\n    give 42\n')
        self.assert_ok(self.run_sprout('add', 'vendor/toolbox', 'toolbox'))
        self.file('app.sprout', 'use toolbox\nshow toolbox.answer()\n')
        result = self.run_sprout('run', 'app.sprout')
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), '42')
        shutil.rmtree(self.project / 'sprout_packages')
        self.assert_ok(self.run_sprout('install', '--locked'))
        self.assert_ok(self.run_sprout('run', 'app.sprout'))
        bundle = self.bundle()
        shutil.rmtree(self.project / 'sprout_packages')
        result = self.run_bundle(bundle)
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), '42')

    def test_recursive_dependencies_and_missing_files(self):
        self.file('vendor/kit/sprout.package', 'entry main.sprout\ndependency dep deps/dep.sprout\n')
        self.file('vendor/kit/main.sprout', 'use dep\npublic task answer():\n    give dep.answer()\n')
        self.file('vendor/kit/deps/dep.sprout', 'public task answer():\n    give 7\n')
        self.assert_ok(self.run_sprout('add', 'vendor/kit', 'kit'))
        self.file('app.sprout', 'use kit\nshow kit.answer()\n')
        result = self.run_sprout('run', 'app.sprout')
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), '7')
        self.assertIn('dep ', (self.project / 'sprout.packages').read_text())
        self.file('vendor/bad/sprout.package', 'entry missing.sprout\n')
        before = (self.project / 'sprout.lock').read_bytes()
        self.assertNotEqual(self.run_sprout('add', 'vendor/bad', 'bad').returncode, 0)
        self.assertEqual((self.project / 'sprout.lock').read_bytes(), before)

    def test_multifile_lock_missing_record_is_rejected(self):
        self.file('vendor/tree/sprout.package', 'entry main.sprout\nfile helper.sprout\n')
        self.file('vendor/tree/main.sprout', 'show 1\n')
        self.file('vendor/tree/helper.sprout', 'show 2\n')
        self.assert_ok(self.run_sprout('add', 'vendor/tree', 'tree'))
        lock = (self.project / 'sprout.lock').read_text()
        self.file('sprout.lock', '\n'.join(line for line in lock.splitlines() if not line.endswith('/helper.sprout')) + '\n')
        result = self.run_sprout('install', '--locked')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Incomplete', result.stderr)

    def test_remote_tree_preserves_binary_files_and_checks_source_drift(self):
        self.file('remote/sprout.package', 'entry main.sprout\nfile data.bin\n')
        self.file('remote/main.sprout', 'public task answer():\n    give 9\n')
        blob = bytes(range(256))
        self.file('remote/data.bin', blob)
        url = self.http_server() + '/remote/sprout.package'
        self.assert_ok(self.run_sprout('add', url, 'remote'))
        self.assertEqual((self.project / 'sprout_packages/remote/data.bin').read_bytes(), blob)
        shutil.rmtree(self.project / 'sprout_packages')
        self.assert_ok(self.run_sprout('install', '--locked'))
        shutil.rmtree(self.project / 'sprout_packages')
        self.file('remote/data.bin', b'changed')
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)
        self.assertFalse((self.project / 'sprout_packages/remote/main.sprout').exists())

    def test_dependency_conflicts_and_cycles_are_rejected(self):
        self.file('vendor/conflict/sprout.package', 'entry main.sprout\ndependency dep one.sprout\ndependency dep two.sprout\n')
        self.file('vendor/conflict/main.sprout', 'show 1\n')
        self.file('vendor/conflict/one.sprout', 'show 1\n')
        self.file('vendor/conflict/two.sprout', 'show 2\n')
        result = self.run_sprout('add', 'vendor/conflict', 'conflict')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Conflicting', result.stderr)
        base = self.http_server()
        self.file('a/sprout.package', 'entry main.sprout\ndependency b %s/b/sprout.package\n' % base)
        self.file('b/sprout.package', 'entry main.sprout\ndependency a %s/a/sprout.package\n' % base)
        self.file('a/main.sprout', 'show 1\n')
        self.file('b/main.sprout', 'show 2\n')
        result = self.run_sprout('add', base + '/a/sprout.package', 'a')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Circular', result.stderr)

    def test_package_destination_symlinks_are_rejected(self):
        code = self.add_single()
        target = self.file('outside.sprout', 'outside untouched\n', self.root)
        installed = self.project / 'sprout_packages/mathx.sprout'
        installed.unlink()
        try:
            installed.symlink_to(target)
        except OSError as exc:
            self.skipTest('Symlink creation is not available: %s' % exc)
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)
        self.assertEqual(target.read_text(), 'outside untouched\n')

    def test_package_traversal_and_bad_github_refs_fail(self):
        self.file('vendor/safe.sprout', 'show 1\n')
        self.assertNotEqual(self.run_sprout('add', 'vendor/safe.sprout', '../escape').returncode, 0)
        self.assertNotEqual(self.run_sprout('add', 'vendor/safe.sprout', 'a' * 128).returncode, 0)
        self.file('vendor/' + 'a' * 128 + '.sprout', 'show 1\n')
        self.assertNotEqual(self.run_sprout('add', 'vendor/' + 'a' * 128 + '.sprout').returncode, 0)
        self.assertFalse((self.project / 'sprout.packages').exists())
        self.file('vendor/evil/sprout.package', 'entry ../escape.sprout\n')
        self.assertNotEqual(self.run_sprout('add', 'vendor/evil', 'evil').returncode, 0)
        for source in ['github:owner/repo@', 'github:owner/repo@../main', 'github:owner/repo@v1:../secret']:
            with self.subTest(source=source):
                self.assertNotEqual(self.run_sprout('add', source, 'test').returncode, 0)
        self.assertFalse((self.root / 'escape.sprout').exists())

    def test_local_module_precedes_project_map_and_conventional_modules(self):
        self.file('app.sprout', 'use "nested/main.sprout"\nshow main.result()\n')
        self.file('nested/main.sprout', 'use helper\npublic task result():\n    give helper.answer()\n')
        self.file('nested/helper.sprout', 'public task answer():\n    give 8\n')
        self.file('modules/helper.sprout', 'public task answer():\n    give 99\n')
        result = self.run_sprout('run', 'app.sprout')
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), '8')

    def test_complete_bundle_runs_elsewhere_with_assets_and_arguments(self):
        self.file('sprout.toml', 'project = "demo"\nmain = "nested/app.sprout"\nassets = ["data/message.txt"]\n')
        self.file('nested/app.sprout', 'use helper\nshow helper.answer()\nshow read("data/message.txt")\nshow args()\n')
        self.file('nested/helper.sprout', 'public task answer():\n    give 42\n')
        self.file('data/message.txt', 'asset payload')
        first = self.bundle('nested/app.sprout', 'first')
        second = self.bundle('nested/app.sprout', 'second')
        self.assertEqual(first.read_bytes(), second.read_bytes())
        (self.project / 'nested/app.sprout').unlink()
        (self.project / 'nested/helper.sprout').unlink()
        (self.project / 'data/message.txt').unlink()
        result = self.run_bundle(first, 'hello')
        self.assert_ok(result)
        self.assertIn('42\nasset payload', result.stdout)
        self.assertIn('hello', result.stdout)

    def test_bundle_missing_import_and_outside_file_fail(self):
        self.file('app.sprout', 'use nonexistent\n')
        self.assertNotEqual(self.run_sprout('bundle', 'app.sprout', '-o', 'missing').returncode, 0)
        outside = self.file('outside.sprout', 'show 1\n', self.root)
        self.assertNotEqual(self.run_sprout('bundle', outside, '-o', 'outside').returncode, 0)
        self.file('app.sprout', 'show 1\n')
        self.assertNotEqual(self.run_sprout('bundle', 'app.sprout', '--asset', '../outside.sprout').returncode, 0)

    def test_bundle_checksum_tampering_and_traversal_are_rejected(self):
        self.file('app.sprout', 'show "original"\n')
        bundle = self.bundle()
        data = bytearray(bundle.read_bytes())
        offset = data.index(b'show "original"\n')
        data[offset] = ord('x')
        tampered = self.elsewhere / bundle.name
        tampered.write_bytes(data)
        tampered.chmod(0o755)
        result = self.run_bundle(tampered)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum', result.stderr)
        original = bundle.read_bytes()
        archive_size = struct.unpack('<Q', original[-8:])[0]
        interpreter = original[:-24-archive_size]
        entry = b'app.sprout'
        content = b'show 1\n'
        bad_path = b'../escape.sprout'
        archive = (struct.pack('<Q', len(entry)) + entry + struct.pack('<Q', 1) +
                   struct.pack('<QQ', len(bad_path), len(content)) + hashlib.sha256(content).digest() + bad_path + content)
        tampered.write_bytes(interpreter + archive + b'SPROUT_BUNDLE_02' + struct.pack('<Q', len(archive)))
        result = self.run_bundle(tampered)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsafe file path', result.stderr)
        self.assertFalse((self.root / 'escape.sprout').exists())

    def test_legacy_single_file_bundles_still_run(self):
        content = b'show 123\n'
        legacy = self.elsewhere / ('legacy.exe' if os.name == 'nt' else 'legacy')
        legacy.write_bytes(BINARY.read_bytes() + content + b'SPROUT_BUNDLE_01' + struct.pack('<Q', len(content)))
        legacy.chmod(0o755)
        result = self.run_bundle(legacy)
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), '123')

    def test_remove_preserves_other_locked_packages(self):
        self.add_single()
        self.file('vendor/other.sprout', 'show 2\n')
        self.assert_ok(self.run_sprout('add', 'vendor/other.sprout'))
        self.assert_ok(self.run_sprout('remove', 'mathx'))
        self.assertFalse((self.project / 'sprout_packages/mathx.sprout').exists())
        self.assertNotIn('mathx', (self.project / 'sprout.lock').read_text())
        self.assert_ok(self.run_sprout('install', '--locked'))

    def test_format_stdin_never_overwrites_disk(self):
        self.file('app.sprout', 'show "saved"\n')
        result = self.run_sprout('format', 'app.sprout', '--stdin', input='when yes:\n  show 1  \n')
        self.assert_ok(result)
        self.assertEqual(result.stdout, 'when yes:\n    show 1\n')
        self.assertEqual((self.project / 'app.sprout').read_text(), 'show "saved"\n')
        self.assertNotEqual(self.run_sprout('format', 'app.sprout', '--stdin', '--write', input='show 1\n').returncode, 0)


if __name__ == '__main__':
    unittest.main()
