"""New N014 controls only; fake interpreters and three bounded Python children."""
import contextlib
import copy
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
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('capability_doctor', ROOT / 'tools/project_doctor.py')
DOCTOR = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(DOCTOR)

def metadata(kind='native', family='windows', arch='x86_64', sqlite=True):
    native = kind == 'native'
    transport, tool = ('unavailable', None) if not native else ('winhttp', None) if family == 'windows' else ('curl', 'curl')
    return {'schema': 1, 'runtime': {'kind': kind, 'os': family, 'arch': arch},
            'features': {'intrinsic_calls_v1': True, 'sqlite_adapter_v1': sqlite, 'native_processes_v1': native,
                         'http_request_v1': native, 'workflow_plan_v1': True, 'workflow_run_v1': native},
            'http_transport': {'operation': 'http_request_v1', 'kind': transport, 'requires_external_tool': tool},
            'host_library': {'included': False, 'abi_version': None}}

def encoded(value): return json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode('ascii') + b'\n'

def child(stdout=b'', stderr=b'', *, code=0, live=False, deny=False):
    process = Mock(pid=424242)
    process.stdout, process.stderr = io.BytesIO(stdout), io.BytesIO(stderr)
    process.poll.return_value = None if live else code
    def wait(timeout):
        if process.poll.return_value is None: raise subprocess.TimeoutExpired('owned fake', timeout)
        return process.poll.return_value
    process.wait.side_effect = wait
    def kill():
        if deny: raise PermissionError('owned fake kill denied')
        process.poll.return_value = 1
    process.kill.side_effect = kill
    return process


class DecoderControls(unittest.TestCase):
    def test_valid_targets_and_wasm_sqlite_definedness(self):
        targets = [('native', 'windows', 'x86_64'), ('native', 'darwin', 'aarch64'), ('native', 'linux', 'x86_64'),
                   ('native', 'unknown', 'unknown'), ('wasm', 'emscripten', 'wasm32'), ('wasm', 'emscripten', 'wasm64')]
        for target in targets:
            for sqlite in (False, True):
                value = metadata(*target, sqlite)
                for ending in (b'\n', b'\r\n'):
                    with self.subTest(target=target, sqlite=sqlite, ending=ending):
                        self.assertEqual(DOCTOR.decode_capabilities(encoded(value)[:-1] + ending), value)

    def test_exact_protocol_boundary_and_single_line_utf8(self):
        raw = encoded(metadata()); padded = b' ' * (1024 - len(raw)) + raw
        self.assertEqual(DOCTOR.decode_capabilities(padded), metadata())
        for invalid in (b' ' + padded, b'', raw[:-1], raw + b'{}\n', raw + b'\n', b'\xef\xbb\xbf' + raw,
                        raw.replace(b'windows', b'win\0dows'), raw.replace(b'windows', b'\xff'), raw.replace(b'windows', b'win\rdows')):
            with self.subTest(raw=invalid[:32]), self.assertRaises(ValueError): DOCTOR.decode_capabilities(invalid)

    def test_duplicates_nonfinite_unknown_schema_fields_and_wrong_exact_types(self):
        raw = encoded(metadata())
        for invalid in (raw.replace(b'"schema":1', b'"schema":1,"\\u0073chema":1'), b'[]\n', b'null\n',
                        raw.replace(b'"requires_external_tool":null', b'"requires_external_tool":NaN'),
                        raw.replace(b'"requires_external_tool":null', b'"requires_external_tool":1e999')):
            with self.subTest(raw=invalid[:40]), self.assertRaises(ValueError): DOCTOR.decode_capabilities(invalid)
        for path, replacement in ((['schema'], True), (['schema'], 2), (['runtime'], []), (['features'], None),
                                  (['host_library'], []), (['http_transport'], False), (['runtime', 'kind'], 0),
                                  (['runtime', 'arch'], ['x86_64']), (['features', 'sqlite_adapter_v1'], 1),
                                  (['host_library', 'included'], 0), (['host_library', 'abi_version'], 1),
                                  (['http_transport', 'requires_external_tool'], True)):
            value = metadata(); parent = value
            for name in path[:-1]: parent = parent[name]
            parent[path[-1]] = replacement
            with self.subTest(path=path), self.assertRaises(ValueError): DOCTOR.decode_capabilities(encoded(value))
        for name in ('runtime', 'features', 'http_transport', 'host_library'):
            value = metadata(); value[name]['extra'] = 0
            with self.subTest(extra=name), self.assertRaises(ValueError): DOCTOR.decode_capabilities(encoded(value))

    def test_cross_target_transport_and_operations_are_not_tool_readiness(self):
        for path, replacement in ((['runtime', 'os'], 'emscripten'), (['runtime', 'arch'], 'wasm32'),
                                  (['features', 'native_processes_v1'], False), (['features', 'http_request_v1'], False),
                                  (['features', 'workflow_run_v1'], False), (['http_transport', 'kind'], 'curl'),
                                  (['http_transport', 'kind'], 'garbage'), (['http_transport', 'operation'], 'http_get')):
            value = metadata(); parent = value
            for name in path[:-1]: parent = parent[name]
            parent[path[-1]] = replacement
            with self.subTest(path=path), self.assertRaises(ValueError): DOCTOR.decode_capabilities(encoded(value))
        wasm = metadata('wasm', 'emscripten', 'wasm32'); wasm['features']['workflow_run_v1'] = True
        with self.assertRaises(ValueError): DOCTOR.decode_capabilities(encoded(wasm))
        curl = metadata(family='linux'); curl['http_transport']['requires_external_tool'] = None
        with self.assertRaises(ValueError): DOCTOR.decode_capabilities(encoded(curl))

    def test_depth_and_member_limits_precede_schema_and_ignore_quoted_brackets(self):
        with patch.object(DOCTOR.json, 'loads', side_effect=AssertionError('deep input must not enter decoder')):
            with self.assertRaisesRegex(ValueError, 'depth'): DOCTOR.decode_capabilities(b'[' * 9 + b'0' + b']' * 9 + b'\n')
        with self.assertRaisesRegex(ValueError, 'member limit'):
            DOCTOR.decode_capabilities(encoded({str(number): 0 for number in range(65)}))
        value = metadata(); value['runtime']['kind'] = '[' * 20
        with self.assertRaisesRegex(ValueError, 'target kind'): DOCTOR.decode_capabilities(encoded(value))
        with self.assertRaisesRegex(ValueError, 'unsupported capability fields'):
            DOCTOR.decode_capabilities(encoded({str(number): 0 for number in range(64)}))


class DoctorControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='doctor-capability-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.root.joinpath('main.sprout').write_bytes(b'file_write("NO-RUN", "x")\n')
        raw = bytearray(128); raw[:2] = b'MZ'; struct.pack_into('<I', raw, 60, 64); raw[64:68] = b'PE\0\0'; struct.pack_into('<H', raw, 68, 0x8664)
        self.native = self.root / 'trusted-fake.exe'; self.native.write_bytes(raw)

    def diagnose(self, **changes):
        result = DOCTOR.diagnose(self.root, native=self.native, probe_capabilities=True, **changes)
        json.dumps(result, allow_nan=False); return result

    @staticmethod
    def codes(report): return [item['code'] for item in report['checks']]

    def test_default_schema1_still_never_launches_and_does_not_write(self):
        original = self.root.joinpath('main.sprout').read_bytes()
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('default execution forbidden')):
            result = DOCTOR.diagnose(self.root, native=self.native)
        self.assertEqual(result['schema'], 1); self.assertEqual(result['execution'], dict(project_code=False, network=False, version_probe=False))
        self.assertEqual(self.root.joinpath('main.sprout').read_bytes(), original); self.assertFalse((self.root / 'NO-RUN').exists())

    def test_fixed_opt_in_argv_schema2_and_unknown_external_effects(self):
        process = child(encoded(metadata()))
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=process) as launch:
            result = self.diagnose(required_features=('intrinsic_calls_v1', 'sqlite_adapter_v1'))
        self.assertEqual(launch.call_count, 1); self.assertEqual(launch.call_args.args[0], [str(self.native), '--capabilities-json'])
        self.assertEqual(launch.call_args.kwargs['cwd'], str(self.native.parent)); self.assertEqual(launch.call_args.kwargs['stdin'], subprocess.DEVNULL)
        self.assertEqual(result['schema'], 2); self.assertEqual(result['native']['capabilities']['status'], 'observed')
        self.assertEqual([item['availability'] for item in result['required_features']], ['available', 'available'])
        external = result['execution']['external_probe']; self.assertTrue(external['launch_attempted'] and external['process_started'])
        self.assertEqual(external['behavior'], 'unverified'); self.assertIsNone(external['project_code_executed']); self.assertIsNone(external['network_accessed'])
        self.assertEqual(result['native']['sqlite_profile'], 'unknown'); self.assertTrue(process.stdout.closed and process.stderr.closed)

    def test_false_required_feature_and_permissions_remain_separate(self):
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=child(encoded(metadata(sqlite=False)))):
            result = self.diagnose(required_features=('sqlite_adapter_v1',), mode='service', allow_io=True)
        self.assertEqual(result['required_features'][0]['availability'], 'unavailable'); self.assertEqual(result['status'], 'blocked')
        self.assertFalse(result['environment']['sandbox']); self.assertFalse(result['environment']['write_probe_performed'])
        self.assertIn('native.feature_unavailable', self.codes(result))

    def test_unknown_schema_and_missing_feature_are_unknown_without_version_fallback(self):
        for value in (dict(metadata(), schema=9), metadata()):
            if value['schema'] == 1: value['features'].pop('sqlite_adapter_v1')
            with self.subTest(value=value), patch.object(DOCTOR.subprocess, 'Popen', return_value=child(encoded(value))) as launch:
                result = self.diagnose(required_features=('sqlite_adapter_v1',), probe_version=True)
            self.assertEqual(launch.call_count, 1); self.assertFalse(result['execution']['version_probe'])
            self.assertEqual(result['required_features'][0]['availability'], 'unknown'); self.assertIn('native.capabilities_invalid', self.codes(result))

    def test_known_bundle_and_manifest_mismatch_refuse_before_any_launch(self):
        self.native.write_bytes(self.native.read_bytes() + b'SPROUT_BUNDLE_02' + struct.pack('<Q', 1))
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('bundle must not launch')):
            result = self.diagnose(required_features=('intrinsic_calls_v1',))
        self.assertIn('native.bundle', self.codes(result)); self.assertFalse(result['execution']['external_probe']['launch_attempted'])
        self.assertEqual(result['required_features'][0]['availability'], 'unknown')
        self.native.write_bytes(self.native.read_bytes()[:-24]); manifest = self.root / 'platform.json'; manifest.write_text('{"schema":1}', encoding='utf-8')
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('mismatching manifest must not launch')):
            result = self.diagnose(native_manifest=manifest)
        self.assertIn('native.invalid', self.codes(result)); self.assertFalse(result['execution']['external_probe']['launch_attempted'])

    def test_legacy_side_effects_are_not_claimed_absent_and_no_fallback_occurs(self):
        def legacy(*args, **kwargs):
            (self.root / 'LEGACY-EFFECT').write_bytes(b'simulated external code effect')
            return child(b'LEGACY PROGRAM RAN\n')
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=legacy) as launch:
            result = self.diagnose(probe_version=True, required_features=('intrinsic_calls_v1',))
        self.assertEqual(launch.call_count, 1); self.assertTrue((self.root / 'LEGACY-EFFECT').exists())
        self.assertIsNone(result['execution']['external_probe']['project_code_executed']); self.assertIsNone(result['execution']['external_probe']['network_accessed'])
        self.assertEqual(result['required_features'][0]['availability'], 'unknown'); self.assertEqual(result['native']['capabilities']['status'], 'unknown')

    def test_before_launch_drift_refuses_and_after_failure_drift_preserves_primary(self):
        original = DOCTOR.native_identity(self.native)
        changed = dict(original, sha256='f' * 64)
        with patch.object(DOCTOR, 'native_identity', side_effect=[dict(original), changed]), patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('prelaunch drift')):
            result = self.diagnose(required_features=('intrinsic_calls_v1',))
        self.assertIn('native.capabilities_identity_drift', self.codes(result)); self.assertFalse(result['execution']['external_probe']['launch_attempted'])
        with patch.object(DOCTOR, 'native_identity', side_effect=[dict(original), dict(original), changed]), patch.object(DOCTOR.subprocess, 'Popen', return_value=child(b'bad', code=7)):
            result = self.diagnose(required_features=('intrinsic_calls_v1',))
        self.assertIn('native.capabilities_failed', self.codes(result)); self.assertIn('native.capabilities_identity_drift', self.codes(result))
        self.assertEqual(result['required_features'][0]['availability'], 'unknown'); self.assertEqual(result['native']['capabilities_probe']['exit_code'], 7)

    def test_real_fixture_byte_tamper_during_mocked_probe_rejects_valid_reply(self):
        def tamper(*args, **kwargs):
            self.native.write_bytes(self.native.read_bytes() + b'changed')
            return child(encoded(metadata()))
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=tamper), patch.object(DOCTOR, 'decode_capabilities', side_effect=AssertionError('drifted identity must not accept reply')):
            result = self.diagnose(required_features=('sqlite_adapter_v1',))
        self.assertIn('native.capabilities_identity_drift', self.codes(result)); self.assertEqual(result['required_features'][0]['availability'], 'unknown')

    def test_native_header_and_wasm_self_report_disagree(self):
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=child(encoded(metadata('wasm', 'emscripten', 'wasm32')))):
            result = self.diagnose(required_features=('sqlite_adapter_v1',))
        self.assertIn('native.capabilities_target_mismatch', self.codes(result)); self.assertEqual(result['required_features'][0]['availability'], 'unknown')

    def test_matching_manifest_disagreement_keeps_both_observations(self):
        manifest = dict(schema=1, platform='Windows', target='PE-x86_64', revision='a' * 40, tag='v0.2.0-dev', version='Sprout v0.2.0-dev',
                        sqlite_source_sha256='b' * 64, build_profile='O2 native SPROUT_SQLITE',
                        assets=[dict(name='sprout-windows-x86_64.exe', bytes=self.native.stat().st_size, sha256=hashlib.sha256(self.native.read_bytes()).hexdigest())])
        path = self.root / 'platform.json'; path.write_text(json.dumps(manifest), encoding='utf-8')
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=child(encoded(metadata(sqlite=False)))):
            result = self.diagnose(native_manifest=path, required_features=('sqlite_adapter_v1',))
        self.assertIn('native.capabilities_manifest_disagreement', self.codes(result)); self.assertEqual(result['native']['sqlite_profile'], 'declared_in_matching_manifest')
        self.assertIs(result['native']['capabilities']['metadata']['features']['sqlite_adapter_v1'], False)

    def test_both_explicit_probes_run_once_and_schema2_stays_unverified(self):
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=[child(encoded(metadata())), child(b'Sprout v0.2.0-dev\n')]) as launch:
            result = self.diagnose(probe_version=True)
        self.assertEqual([call.args[0] for call in launch.call_args_list], [[str(self.native), '--capabilities-json'], [str(self.native), 'version']])
        self.assertEqual(result['native']['version'], 'Sprout v0.2.0-dev'); self.assertEqual(result['execution']['external_probe']['behavior'], 'unverified')

    def test_nonzero_stderr_overflow_and_unconfirmed_cleanup_leave_requirements_unknown(self):
        variants = [child(encoded(metadata()), code=9), child(encoded(metadata()), b'warning'), child(b'x' * 8192), child(encoded(metadata()), live=True, deny=True)]
        for process in variants:
            with self.subTest(process=process), patch.object(DOCTOR.subprocess, 'Popen', return_value=process), patch.object(DOCTOR, 'PROBE_SECONDS', .02):
                result = self.diagnose(required_features=('sqlite_adapter_v1',))
            self.assertEqual(result['required_features'][0]['availability'], 'unknown'); self.assertEqual(result['native']['capabilities']['status'], 'unknown')
            self.assertLessEqual(result['native']['capabilities_probe']['stdout_bytes'] + result['native']['capabilities_probe']['stderr_bytes'], 4096)

    def test_cli_requirements_need_opt_in_known_unique_names_and_no_launch(self):
        base = [str(self.root), '--native', str(self.native)]
        for flags in (['--require-feature', 'sqlite_adapter_v1'], ['--probe-capabilities', '--require-feature', 'unknown'],
                      ['--probe-capabilities', '--require-feature', 'sqlite_adapter_v1', '--require-feature', 'sqlite_adapter_v1']):
            with (self.subTest(flags=flags), patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('invalid CLI must not launch')),
                  contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error):
                DOCTOR.main(base + flags)
            self.assertEqual(error.exception.code, 2)

    def test_text_never_claims_no_external_code_or_network_after_probe(self):
        output = io.StringIO()
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=child(encoded(metadata()))), contextlib.redirect_stdout(output):
            code = DOCTOR.main([str(self.root), '--native', str(self.native), '--probe-capabilities'])
        self.assertEqual(code, 0); self.assertIn('effects are unverified', output.getvalue()); self.assertNotIn('No repairs, project execution', output.getvalue())


class SupervisorControls(unittest.TestCase):
    def test_backward_clock_above_origin_rejects_preserving_primary_and_owned_cleanup(self):
        scenarios = [('known-exited', [10.0, 10.2, 10.1], child(encoded(metadata())), [None, 0, 0], 0, 0, False, 'clock moved backward'),
                     ('live-owned', [10.0, 10.2, 10.1], child(encoded(metadata()), live=True), [None, None], 1, 1, False, 'clock moved backward'),
                     ('cleanup-denied', [10.0, 10.2, 10.1], child(encoded(metadata()), live=True, deny=True), [None, None], None, 1, True, 'clock moved backward'),
                     ('origin-deadline', [10.0, 10.2, 13.01], child(encoded(metadata()), live=True), [None, None], 1, 1, False, 'deadline expired')]
        for name, readings, process, polls, code, kills, uncertain, primary in scenarios:
            process.poll.side_effect = polls
            with (self.subTest(name=name), patch.object(DOCTOR.time, 'monotonic', side_effect=readings),
                  patch.object(DOCTOR.subprocess, 'Popen', return_value=process)):
                result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
            self.assertEqual(len(result['errors']), 1); self.assertIn(primary, result['errors'][0])
            self.assertEqual(result['exit_code'], code); self.assertEqual(process.kill.call_count, kills)
            process.wait.assert_called_once_with(timeout=1)
            self.assertEqual(bool(result['cleanup_errors']), uncertain)
            self.assertTrue(process.stdout.closed and process.stderr.closed)
            json.dumps(DOCTOR._probe_trace(result), allow_nan=False)
        process = child(encoded(metadata())); process.poll.side_effect = [None, 0, 0]
        with (patch.object(DOCTOR.time, 'monotonic', side_effect=[10.0, 10.2, 10.3]),
              patch.object(DOCTOR.subprocess, 'Popen', return_value=process)):
            result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        self.assertEqual(result['errors'], []); self.assertEqual(result['cleanup_errors'], [])
        self.assertEqual(result['exit_code'], 0); process.kill.assert_not_called()

    def test_spawn_reader_start_and_reader_io_failures_preserve_cleanup(self):
        with patch.object(DOCTOR.subprocess, 'Popen', side_effect=OSError('owned spawn refused')):
            result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        self.assertTrue(result['launch_attempted']); self.assertFalse(result['process_started']); self.assertTrue(result['errors'])
        process = child(live=True)
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=process), patch.object(DOCTOR.threading.Thread, 'start', side_effect=RuntimeError('reader startup')):
            result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        process.kill.assert_called_once(); self.assertTrue(result['errors']); self.assertTrue(process.stdout.closed and process.stderr.closed)
        class Broken(io.BytesIO):
            def read1(self, size): raise OSError('owned reader refused')
        process = child(); process.stdout = Broken()
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=process): result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        self.assertTrue(result['errors']); process.kill.assert_not_called()

    def test_already_exited_child_is_reaped_without_signal_and_wait_denial_is_failure(self):
        process = child(encoded(metadata()))
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=process): result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        self.assertEqual(result['exit_code'], 0); process.kill.assert_not_called(); self.assertEqual(result['cleanup_errors'], [])
        process = child(); process.wait.side_effect = PermissionError('wait refused')
        with patch.object(DOCTOR.subprocess, 'Popen', return_value=process): result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        self.assertIsNone(result['exit_code']); self.assertTrue(result['cleanup_errors']); process.kill.assert_not_called()

    def test_invalid_clock_refuses_before_launch_and_json_diagnostics_stay_finite(self):
        with patch.object(DOCTOR.time, 'monotonic', return_value=float('nan')), patch.object(DOCTOR.subprocess, 'Popen', side_effect=AssertionError('invalid clock')):
            result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
        self.assertFalse(result['launch_attempted']); self.assertTrue(result['errors'])
        json.dumps(DOCTOR._probe_trace(result), allow_nan=False)

    def test_live_reader_is_not_closed_after_denied_cleanup(self):
        release = threading.Event()
        class Held:
            def __init__(self): self.closed = False; self.finished = threading.Event()
            def read(self, size):
                release.wait(5); self.finished.set(); return b''
            def close(self): self.closed = True
        process = child(live=True, deny=True); process.stdout, process.stderr = Held(), Held()
        try:
            with patch.object(DOCTOR.subprocess, 'Popen', return_value=process), patch.object(DOCTOR, 'PROBE_SECONDS', .01):
                result = DOCTOR.capabilities_probe(Path('trusted-fake.exe'))
            self.assertTrue(result['errors'] and result['cleanup_errors']); self.assertIsNone(result['exit_code'])
            self.assertFalse(process.stdout.closed or process.stderr.closed)
        finally:
            release.set(); self.assertTrue(process.stdout.finished.wait(1) and process.stderr.finished.wait(1))


class PythonChildControls(unittest.TestCase):
    def test_three_bounded_owned_python_children_cover_output_and_deadline(self):
        programs = ["import sys;sys.stdout.write(" + repr(encoded(metadata()).decode('ascii')) + ");sys.stdout.flush()",
                    "import sys;sys.stdout.write('x'*8192);sys.stdout.flush()", "import time;time.sleep(10)"]
        for index, program in enumerate(programs):
            self.assertLessEqual(len(program.encode('utf-8')), 2048)
            with self.subTest(index=index), patch.object(DOCTOR, 'PROBE_SECONDS', 1):
                result = DOCTOR._bounded_capability_command([sys.executable, '-c', program])
            self.assertIsNotNone(result['exit_code']); self.assertEqual(result['cleanup_errors'], [])
            self.assertLessEqual(result['stdout_bytes'] + result['stderr_bytes'], 4096)
            if index == 0:
                self.assertEqual(result['errors'], []); self.assertEqual(result['exit_code'], 0); DOCTOR.decode_capabilities(result['stdout'])
            elif index == 1: self.assertTrue(any('cap exceeded' in item for item in result['errors']))
            else: self.assertTrue(any('deadline expired' in item for item in result['errors']))


if __name__ == '__main__': unittest.main(failfast=True)
