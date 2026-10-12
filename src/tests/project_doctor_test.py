"""Synthetic read-only doctor contracts; no project code/network/registry execution."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('project_doctor', ROOT/'tools/project_doctor.py')
DOCTOR = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(DOCTOR)


class ProjectDoctorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-doctor-')
        self.addCleanup(self.temp.cleanup)
        # macOS /var is an OS symlink; explicitly choose our fixture's physical
        # directory, preserving the tool's refusal to follow user path aliases.
        self.root = Path(self.temp.name).resolve()
        self.write('main.sprout', b'file_write("MUST-NOT-RUN", "x")\n')

    def write(self, relative, data):
        path = self.root/relative; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode('utf-8') if isinstance(data, str) else data)
        return path

    def codes(self, report):
        json.dumps(report, allow_nan=False)
        return [item['code'] for item in report['checks']]

    def single(self, source='vendor/math.sprout', name='math', content=b'task answer(): give 42\n'):
        self.write(source, content)
        destination = 'sprout_packages/' + name + '.sprout'
        self.write(destination, content)
        self.write('sprout.packages', name + ' ' + source + '\n')
        self.write('sprout.lock', DOCTOR.LOCK_HEADER + '\n' + '\t'.join((name, source, hashlib.sha256(content).hexdigest(), destination)) + '\n')
        return destination

    def native(self, tail=b''):
        data = bytearray(128); data[:2] = b'MZ'; struct.pack_into('<I', data, 60, 64)
        data[64:68] = b'PE\0\0'; struct.pack_into('<H', data, 68, 0x8664)
        return self.write('native.exe', data + tail)

    def tree(self, manifest=None, extras=()):
        declarations = manifest or 'entry main.sprout\nfile data.bin\n'
        files = {'sprout.package': declarations.encode(), 'main.sprout': b'show 1\n', 'data.bin': b'\xff\0asset'}
        files.update(dict(extras))
        rows = []
        for relative, data in files.items():
            source = 'vendor/tree/' + relative; dest = 'sprout_packages/tree/' + relative
            self.write(source, data); self.write(dest, data)
            rows.append('\t'.join(('tree', source, hashlib.sha256(data).hexdigest(), dest)))
        self.write('sprout.packages', 'tree vendor/tree\n')
        self.write('sprout.lock', DOCTOR.LOCK_HEADER + '\n' + '\n'.join(rows) + '\n')

    def test_default_project_does_not_execute_or_modify_any_project_content(self):
        before = self.root.joinpath('main.sprout').read_bytes()
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('unexpected execution')):
            report = DOCTOR.diagnose(self.root)
        self.assertEqual(report['schema'], 1)
        self.assertEqual(report['status'], 'diagnostics_clear')
        self.assertFalse(report['execution']['project_code']); self.assertFalse(report['execution']['network'])
        self.assertFalse((self.root/'MUST-NOT-RUN').exists())
        self.assertEqual((self.root/'main.sprout').read_bytes(), before)

    def test_declared_sources_unicode_paths_and_binary_assets(self):
        self.write('src/entrée.sprout', 'show "日本語"\n')
        self.write('modules/helper.sprout', 'task help(): give 1\n')
        self.write('assets/blob.bin', b'\xff\x00\x01')
        self.write('sprout.toml', 'project = "fixture"\nmain = "src/entrée.sprout"\ninclude = [\n"modules/helper.sprout",\n]\nassets = ["assets/blob.bin"] ~ native comment\n')
        report = DOCTOR.diagnose(self.root)
        self.assertEqual(report['status'], 'diagnostics_clear')
        self.assertEqual(report['project']['entry'], 'src/entrée.sprout')

    def test_missing_declared_file_and_duplicate_module_basenames_are_actionable(self):
        self.write('a/helper.sprout', 'show 1'); self.write('b/helper.sprout', 'show 2')
        self.write('sprout.toml', 'include=["a/helper.sprout","b/helper.sprout"]\nassets=["missing.bin"]')
        report = DOCTOR.diagnose(self.root)
        self.assertIn('project.include_invalid', self.codes(report))
        self.assertIn('project.asset_invalid', self.codes(report))
        self.assertEqual(report['status'], 'blocked')

    def test_unsafe_paths_devices_and_invalid_utf8_never_escape_project(self):
        for name in ('../outside.sprout', '/absolute.sprout', 'C:/outside.sprout', 'x\\bad.sprout', 'NUL.sprout', 'a//bad.sprout'):
            with self.subTest(path=name):
                report = DOCTOR.diagnose(self.root, entry=name)
                self.assertIn('project.entry_invalid', self.codes(report))
        self.write('main.sprout', b'\xff')
        self.assertIn('project.entry_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_config_unsupported_types_syntax_nul_and_invalid_utf8_are_structured(self):
        for data in (b'main="unterminated', b'main=4', b'main="a\\u0062.sprout"', b"main='main.sprout'",
                     b'[app]\nmain="main.sprout"', b'main="main.sprout"\0', b'\xff'):
            with self.subTest(data=data):
                self.write('sprout.toml', data)
                report = DOCTOR.diagnose(self.root)
                self.assertIn('project.config_invalid', self.codes(report))

    def test_unknown_flat_field_warns_without_inventing_native_feature_support(self):
        self.write('sprout.toml', 'main="main.sprout"\nversion="fixture"')
        report = DOCTOR.diagnose(self.root)
        self.assertIn('project.config_unknown', self.codes(report)); self.assertEqual(report['summary']['error'], 0)

    def test_metadata_and_content_budgets_fail_closed_without_large_allocations(self):
        self.write('sprout.toml', 'main="main.sprout"')
        with patch.object(DOCTOR, 'METADATA_BYTES', 4):
            self.assertIn('project.config_invalid', self.codes(DOCTOR.diagnose(self.root)))
        with patch.object(DOCTOR, 'PROJECT_BYTES', 4):
            self.assertIn('project.entry_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_single_locked_local_package_is_verified_and_drift_missing_reported(self):
        dest = self.single()
        self.assertEqual(DOCTOR.diagnose(self.root)['summary']['error'], 0)
        self.write(dest, b'tampered')
        self.assertIn('packages.installed_invalid', self.codes(DOCTOR.diagnose(self.root)))
        (self.root/dest).unlink()
        self.assertIn('packages.installed_invalid', self.codes(DOCTOR.diagnose(self.root)))
        self.write('vendor/math.sprout', b'drifted vendor')
        self.assertIn('packages.local_source_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_manifest_lock_source_drift_duplicate_names_and_unsafe_lock_paths(self):
        dest = self.single()
        original = (self.root/'sprout.lock').read_text()
        self.write('sprout.packages', 'math vendor/another.sprout\n')
        self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))
        self.write('sprout.packages', 'math vendor/math.sprout\nMATH vendor/math.sprout\n')
        self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))
        self.write('sprout.packages', 'math vendor/math.sprout\n')
        for record in (original.replace(dest, '../outside.sprout'), original + original.splitlines()[1] + '\n', original.replace('v1 sha256', 'v2 sha256')):
            self.write('sprout.lock', record)
            self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_legacy_unlocked_manifest_reports_missing_lock_without_repairs(self):
        self.single(); (self.root/'sprout.lock').unlink()
        report = DOCTOR.diagnose(self.root)
        self.assertIn('packages.lock_missing', self.codes(report)); self.assertFalse((self.root/'sprout.lock').exists())

    def test_valid_remote_pin_verifies_installed_bytes_without_network_or_false_error(self):
        content = b'show 1\n'; source = 'github:acme/math@' + 'a'*40 + ':math.sprout'
        self.write('sprout.packages', 'math ' + source)
        self.write('sprout_packages/math.sprout', content)
        self.write('sprout.lock', DOCTOR.LOCK_HEADER + '\nmath ' + source + ' ' + hashlib.sha256(content).hexdigest() + ' sprout_packages/math.sprout\n')
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('unexpected execution')):
            report = DOCTOR.diagnose(self.root)
        self.assertEqual(report['summary']['error'], 0)
        self.assertIn('packages.remote_unverified', self.codes(report))
        self.assertEqual(report['packages']['files'], 1)

    def test_tree_completeness_and_entry_rules(self):
        self.tree(); self.assertEqual(DOCTOR.diagnose(self.root)['summary']['error'], 0)
        for manifest in ('entry main.sprout\nfile missing.sprout\n', 'entry main.sprout\nentry other.sprout\n', 'unknown field\n'):
            self.tree(manifest)
            self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_undeclared_extra_tree_file_and_dependency_source_mismatch(self):
        self.tree(extras=(('extra.bin', b'extra'),))
        self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_tree_local_dependency_and_commit_pinned_mutable_declaration_agree(self):
        for remote in (False, True):
            with self.subTest(remote=remote):
                declared = 'github:acme/fmt@v1.0.0' if remote else 'deps/fmt.sprout'
                source = 'github:acme/fmt@' + 'a'*40 + ':fmt.sprout' if remote else 'vendor/tree/deps/fmt.sprout'
                self.tree('entry main.sprout\nfile data.bin\ndependency fmt ' + declared + '\n')
                content = b'task format(value): give value\n'
                self.write('sprout_packages/fmt.sprout', content)
                if not remote: self.write(source, content)
                with (self.root/'sprout.packages').open('a') as output: output.write('fmt ' + source + '\n')
                with (self.root/'sprout.lock').open('a') as output:
                    output.write('\t'.join(('fmt', source, hashlib.sha256(content).hexdigest(), 'sprout_packages/fmt.sprout')) + '\n')
                report = DOCTOR.diagnose(self.root)
                self.assertEqual(report['summary']['error'], 0, report['checks'])
                if remote: self.assertIn('packages.remote_unverified', self.codes(report))

    def test_cyclic_tree_graph_is_rejected_without_unbounded_recursion(self):
        rows = []; specs = []
        for name, other in (('one', 'two'), ('two', 'one')):
            source = 'github:acme/' + name + '@' + 'a'*40 + ':sprout.package'
            dependency = 'github:acme/' + other + '@' + 'a'*40 + ':sprout.package'
            specs.append(name + ' ' + source)
            for relative, content in (('sprout.package', ('entry main.sprout\ndependency ' + other + ' ' + dependency + '\n').encode()), ('main.sprout', b'show 1\n')):
                path = 'sprout_packages/' + name + '/' + relative
                self.write(path, content)
                rows.append('\t'.join((name, DOCTOR.child_source(source, relative), hashlib.sha256(content).hexdigest(), path)))
        self.write('sprout.packages', '\n'.join(specs) + '\n')
        self.write('sprout.lock', DOCTOR.LOCK_HEADER + '\n' + '\n'.join(rows) + '\n')
        report = DOCTOR.diagnose(self.root)
        self.assertIn('packages.metadata_invalid', self.codes(report))
        self.assertTrue(any('cyclic' in item['message'] for item in report['checks']))

    def test_single_file_lock_cannot_gain_extra_records_or_unknown_package(self):
        self.single(); original = (self.root/'sprout.lock').read_text()
        for line in ('math vendor/extra.bin ' + '0'*64 + ' sprout_packages/math/extra.bin',
                     'extra vendor/extra.sprout ' + '0'*64 + ' sprout_packages/extra.sprout'):
            self.write('sprout.lock', original + line + '\n')
            self.assertTrue(DOCTOR.diagnose(self.root)['summary']['error'])
        self.tree('entry main.sprout\nfile data.bin\ndependency missing github:acme/missing@v1\n')
        self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_locked_local_parent_traversal_is_refused_without_reading_it(self):
        self.single(); self.write('sprout.packages', 'math ../outside.sprout')
        self.assertIn('packages.metadata_invalid', self.codes(DOCTOR.diagnose(self.root)))

    def test_reader_detects_changes_between_repeated_content_checks(self):
        reader = DOCTOR.Reader(self.root); path = self.root/'main.sprout'
        reader.read(path); path.write_bytes(b'changed')
        with self.assertRaisesRegex(DOCTOR.DiagnosticError, 'changed'): reader.read(path)

    def test_symlink_and_dangling_parent_aliases_are_refused(self):
        alias = self.root/'alias'
        try: alias.symlink_to(self.root, target_is_directory=True)
        except OSError as error: self.skipTest('host cannot create symlink fixture: ' + str(error))
        self.assertIn('project.entry_invalid', self.codes(DOCTOR.diagnose(self.root, entry='alias/main.sprout')))
        dangling = self.root/'dangling'; dangling.symlink_to(self.root/'missing')
        self.assertIn('project.entry_invalid', self.codes(DOCTOR.diagnose(self.root, entry='dangling')))

    def test_non_regular_source_is_refused_before_read(self):
        if not hasattr(os, 'mkfifo'): self.skipTest('POSIX FIFO control')
        os.mkfifo(self.root/'pipe.sprout')
        self.assertIn('project.entry_invalid', self.codes(DOCTOR.diagnose(self.root, entry='pipe.sprout')))

    def test_worker_service_state_and_permission_observations_do_not_write_probe(self):
        report = DOCTOR.diagnose(self.root, mode='service')
        self.assertFalse(report['environment']['write_probe_performed'])
        self.assertTrue(report['environment']['sandbox'])
        self.assertEqual(report['environment']['state_dir'], str(self.root))
        with patch.object(DOCTOR.os, 'access', side_effect=[True, False]):
            report = DOCTOR.diagnose(self.root, mode='worker', allow_io=True)
        self.assertIn('environment.state_write_unconfirmed', self.codes(report))
        self.assertFalse(report['environment']['sandbox'])
        self.assertIn('inspection.incomplete', self.codes(DOCTOR.diagnose(self.root, mode='service', state_dir=self.root/'missing')))

    def test_native_static_identity_does_not_execute_or_infer_sqlite_from_version(self):
        native = self.native()
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('unexpected execution')):
            report = DOCTOR.diagnose(self.root, native=native)
        self.assertEqual(report['native']['sqlite_profile'], 'unknown')
        self.assertEqual(report['native']['target'], 'PE-x86_64')
        self.assertEqual(report['native']['sha256'], hashlib.sha256(native.read_bytes()).hexdigest())

    def test_bundle_footer_refuses_probe_and_native_limits_reject_oversized_input(self):
        native = self.native(b'SPROUT_BUNDLE_02' + struct.pack('<Q', 1))
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('bundle must not execute')):
            report = DOCTOR.diagnose(self.root, native=native, probe_version=True)
        self.assertIn('native.bundle', self.codes(report)); self.assertFalse(report['execution']['version_probe'])
        with patch.object(DOCTOR, 'NATIVE_BYTES', 4):
            self.assertIn('native.invalid', self.codes(DOCTOR.diagnose(self.root, native=self.native())))

    def manifest(self, native):
        return dict(schema=1, platform='Windows', target='PE-x86_64', tag='v0.2.0-dev', version='Sprout v0.2.0-dev',
                    revision='a'*40, sqlite_source_sha256='b'*64, build_profile='O2 native SPROUT_SQLITE',
                    assets=[dict(name='sprout-windows-x86_64.exe', bytes=native.stat().st_size, sha256=hashlib.sha256(native.read_bytes()).hexdigest())])

    def test_matching_profile_is_a_declaration_and_malformed_identity_fails(self):
        native = self.native(); manifest = self.manifest(native); path = self.write('platform.json', json.dumps(manifest))
        report = DOCTOR.diagnose(self.root, native=native, native_manifest=path)
        self.assertEqual(report['native']['sqlite_profile'], 'declared_in_matching_manifest')
        for key, value in (('schema', True), ('revision', None), ('sqlite_source_sha256', 3), ('tag', 'v9.0.0'), ('assets', [])):
            self.write('platform.json', json.dumps(dict(manifest, **{key:value})))
            self.assertIn('native.invalid', self.codes(DOCTOR.diagnose(self.root, native=native, native_manifest=path)))
        self.write('platform.json', '{"schema":1,"schema":1}')
        self.assertIn('native.invalid', self.codes(DOCTOR.diagnose(self.root, native=native, native_manifest=path)))
        self.write('platform.json', json.dumps(manifest)[:-1] + ',"unused":1e999}')
        self.assertIn('native.invalid', self.codes(DOCTOR.diagnose(self.root, native=native, native_manifest=path)))

    def fake_process(self, stdout=b'Sprout v0.2.0-dev\n', stderr=b'', live=False, deny=False):
        child = Mock(pid=424242)
        child.stdout, child.stderr = io.BytesIO(stdout), io.BytesIO(stderr)
        child.poll.return_value = None if live else 0
        def wait(timeout):
            if child.poll.return_value is None: raise subprocess.TimeoutExpired('trusted fixture', timeout)
            return child.poll.return_value
        child.wait.side_effect = wait
        def kill():
            if deny: raise PermissionError('mock owned kill denial')
            child.poll.return_value = 1
        child.kill.side_effect = kill
        return child

    def test_explicit_version_probe_executes_only_version_with_bounded_clean_output(self):
        native = self.native(); child = self.fake_process()
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=child) as launch:
            report = DOCTOR.diagnose(self.root, native=native, probe_version=True)
        self.assertEqual(launch.call_args.args[0], [str(native), 'version'])
        self.assertEqual(report['native']['version'], 'Sprout v0.2.0-dev')
        self.assertEqual(report['native']['sqlite_profile'], 'unknown')
        self.assertTrue(child.stdout.closed and child.stderr.closed)

    def test_probe_output_cap_deadline_startup_failure_and_unconfirmed_cleanup(self):
        for child, kind in ((self.fake_process(b'x'*8192), 'output'), (self.fake_process(live=True), 'deadline'),
                            (self.fake_process(live=True, deny=True), 'unconfirmed')):
            with self.subTest(kind=kind), patch.object(DOCTOR.subprocess, 'Popen', return_value=child), patch.object(DOCTOR, 'PROBE_SECONDS', .01):
                result = DOCTOR.version_probe(self.root/'explicit-trusted.exe')
            self.assertLessEqual(len(result['stdout']) + len(result['stderr']), DOCTOR.PROBE_BYTES)
            self.assertTrue(result['errors'])
            if kind == 'unconfirmed': self.assertTrue(result['cleanup_errors']); self.assertIsNone(result['exit_code'])
            if kind == 'deadline': child.kill.assert_called_once()
        child = self.fake_process(live=True)
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=child), patch.object(DOCTOR.threading.Thread, 'start', side_effect=RuntimeError('mock reader start failure')):
            result = DOCTOR.version_probe(self.root/'explicit-trusted.exe')
        child.kill.assert_called_once(); self.assertTrue(child.stdout.closed and child.stderr.closed)
        self.assertIn('reader start failure', result['errors'][0])

    def test_cli_json_output_and_invalid_probe_invocation_have_stable_exit_contracts(self):
        command = [sys.executable, str(ROOT/'tools/project_doctor.py'), str(self.root), '--json']
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(json.loads(result.stdout)['schema'], 1)
        (self.root/'main.sprout').unlink()
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1); self.assertEqual(json.loads(result.stdout)['status'], 'blocked')
        result = subprocess.run(command + ['--probe-version'], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2); self.assertIn('--native is required', result.stderr)

    def test_diagnostic_output_cap_is_structured_failed_not_unbounded_or_exception(self):
        report = DOCTOR.Report(self.root)
        with patch.object(DOCTOR, 'MAX_CHECKS', 4):
            for _ in range(100): report.add('fixture', 'info', 'x'*3000)
        result = report.finish(); self.assertLessEqual(len(result['checks']), 4)
        self.assertEqual(result['status'], 'blocked'); self.assertTrue(result['checks_truncated'])
        self.assertLessEqual(len(result['checks'][0]['message']), 1024)


if __name__ == '__main__': unittest.main()
