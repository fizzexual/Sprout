"""Private supervisor/oracle controls. No Sprout or SDK-native worker is launched."""
from __future__ import annotations
from collections import Counter
from decimal import Decimal
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import redirect_stdout

HERE = Path(__file__).resolve().parent
NODE_STOPWATCH_SHA = '9129f0a17ee51e3e807e217203eca0757e70090fbd42d6fef5d12ee7a62ea7ae'
TOOLS = HERE.parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import measure_workloads as m
import measurement_fixtures as w
import measurement_sdk as sdk
import prepare_measurement as preparation
import export_measurement as exporter

HERE = Path(__file__).resolve().parent


def sample_selection(root):
    source = root / 'source export 🌱'; source.mkdir()
    application = {}; native = {}
    for name in sorted(preparation.NATIVE_SOURCES | set(preparation.SOURCE_PATHS)):
        path = source / name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(('synthetic ordinary source, never compiled: ' + name).encode())
        (native if name in preparation.NATIVE_SOURCES else application)[name] = m.sha(path)
    for name in ['native stub', 'compiler stub', 'node stub']:
        (root / name).write_bytes(('ordinary inert bytes: ' + name).encode())
    shutil.copyfile(TOOLS.parent / 'benchmarks/library-workloads/v1-spec.json', root / 'spec.json')
    build = {'revision': 'a' * 40, 'binary_sha256': m.sha(root / 'native stub'), 'compiler_sha256': m.sha(root / 'compiler stub'),
             'exit': 0, 'inputs_still_match': True, 'argv': ['compiler-never-invoked', '-O2', '-Wall', '-s', '-DSPROUT_SQLITE', '-Wl,--stack,67108864'], 'input_git_blob_sha256': native}
    ci = {'headSha': 'a' * 40, 'conclusion': 'success', 'status': 'completed', 'attempt': 1,
          'jobs': [{'name': name, 'conclusion': 'success', 'status': 'completed'} for name in sorted(preparation.REQUIRED_JOBS)]}
    (root / 'build.json').write_bytes(w.compact(build)); (root / 'ci.json').write_bytes(w.compact(ci))
    selected = {'schema': 'sprout.measurement-selection.v2', 'profile': m.PROFILE, 'revision': 'a' * 40,
        'source_root': source.name, 'application_sources': application, 'native_path': 'native stub', 'native_sha256': m.sha(root / 'native stub'),
        'compiler_path': 'compiler stub', 'compiler_sha256': m.sha(root / 'compiler stub'), 'build_path': 'build.json', 'build_sha256': m.sha(root / 'build.json'),
        'ci_path': 'ci.json', 'ci_sha256': m.sha(root / 'ci.json'), 'spec_path': 'spec.json', 'spec_sha256': m.sha(root / 'spec.json'),
        'node_path': 'node stub', 'node_sha256': m.sha(root / 'node stub'), 'python_path': sys.executable, 'python_sha256': m.sha(sys.executable)}
    file = root / 'selection.json'; file.write_bytes(w.compact(selected))
    return file, selected


def sample_snapshot(root):
    selection, chosen = sample_selection(root); snapshot = root / 'frozen snapshot 🌱'
    pin = preparation.freeze(snapshot, selection, m.sha(selection))
    return snapshot, pin, selection, chosen


def sample_scope(root, snapshot, pin):
    manifest = m.bounded_json(snapshot / 'manifest.json')
    output = root / 'one report 🌱'
    record = {'schema': 'sprout.measurement-reviewed-scope.v2', 'profile': m.PROFILE, 'snapshot_manifest_sha256': pin,
        'native_sha256': manifest['native_sha256'], 'ci_sha256': manifest['ci_sha256'], 'python_sha256': manifest['host_tools']['python']['sha256'],
        'node_sha256': manifest['host_tools']['node']['sha256'], 'output_directory': str(output.resolve()), 'run_id': 'synthetic-control',
        'scope_reviewed_and_sealed': True, 'bounds': m.BOUNDS}
    file = root / 'scope.json'; file.write_bytes(w.compact(record))
    return file, record, output


class ManualClock:
    def __init__(self): self.value = 0
    def __call__(self): return self.value
    def advance(self, amount): self.value += amount


class SimulatedSuite:
    def __init__(self, root, budget):
        self.budget = budget; self.setup = {'test_simulated': True}; self.closed = False
    def call(self, identifier):
        self.budget.reserve()
        return {'elapsed_ns': 7, 'output_raw': w.compact(w.sdk_fixtures()[identifier]['expected'])}
    def close(self):
        self.closed = True
        return {'confirmed': True, 'test_simulated': True}


def fake_identity(root, digest):
    return {'native_sha256': 'test-only-no-native', 'revision': 'test-only', 'build_sha256': 'test-only'}


def simulated_pure(root, fixture, mode, budget):
    budget.reserve()
    raw = w.compact({'result': fixture['expected'], 'unchanged': True})
    return {'elapsed_ns': 5 if mode == 'full' else 9, 'output_raw': raw, 'stdout_raw': b'READY\nDONE\n' + raw + b'\n',
            'stderr_raw': b'', 'cleanup': {'confirmed': True, 'test_simulated': True}}


class Controls(unittest.TestCase):
    def test_schedule_exact_pairs_warmups_and_launch_reservations(self):
        rows = w.schedule()
        self.assertEqual(len(rows), 204)
        self.assertEqual(Counter(row['kind'] for row in rows), {'prepared': 156, 'sdk': 48})
        self.assertEqual(sum(row['warmup'] for row in rows), 34)
        for identifier in w.PURE_IDS:
            measured = [row for row in rows if row['kind'] == 'prepared' and row['id'] == identifier and not row['warmup']]
            self.assertEqual([row['sample'] for row in measured], [i for i in range(5) for _ in range(2)])
            for i in range(5): self.assertEqual([row['mode'] for row in measured[2*i:2*i+2]], ['full', 'control'] if i % 2 == 0 else ['control', 'full'])
        budget = m.Budget(m.Clock(lambda: 0))
        for _ in range(208): budget.reserve()
        with self.assertRaises(m.ContractError) as caught: budget.reserve()
        self.assertEqual(caught.exception.code, 'launch_ceiling'); self.assertEqual(budget.reserved, 208)

    def test_fixture_shapes_caps_and_independent_exact_decisions(self):
        data = w.fixtures()
        for key, count in [('V1', 9), ('V64', 577), ('V512', 4609)]:
            self.assertEqual(w.native_nodes(data[key]['inputs'][0]), count)
        failures = data['Verrors']['expected']
        self.assertEqual(len(failures['errors']), 64); self.assertTrue(failures['truncated'])
        self.assertEqual(failures['errors'][0], {'path': [0, 'id'], 'code': 'kind', 'message': 'Expected integer.'})
        self.assertEqual(failures['errors'][-1]['path'], [9, 'id'])
        large = data['Clarge']; self.assertEqual(large['schema_nodes'], 641); self.assertLessEqual(large['copied_occurrences'], 20000)
        self.assertEqual(large['expected']['provenance']['key000'], {'source': 'defaults', 'index': None, 'name': None})
        self.assertEqual(large['expected']['values']['key127']['label'], 'cli')
        self.assertEqual(large['expected']['values']['key126']['label'], 'file-15')
        for key, size in [('Aresult2K', 2048), ('Aresult32K', 32768)]:
            self.assertEqual(len(w.compact(data[key]['expected']['response'])) + 2, size)
        selected = data['Aselect32']; self.assertEqual(len(selected['inputs'][1]), 32)
        self.assertEqual(selected['expected']['route'], 'route_31')
        self.assertEqual(len(w.compact(selected['inputs'][0]['body'])), 1024)
        progress = data['P128']; self.assertEqual(progress['expected']['counts'], dict.fromkeys(['pending', 'running', 'done', 'failed'], 32))
        self.assertEqual(progress['expected']['attempts_total'], w.integer(sum(index % 7 + 1 for index in range(128) if index % 4 != 0)))
        self.assertEqual(progress['expected']['state'], 'uncertain'); self.assertIs(progress['expected']['expected_matches'], False)
        self.assertEqual(len(w.compact(w.sdk_fixtures()['Hecho16K']['input'])) + 1, 16384)
        for fixture in data.values(): self.assertLessEqual(len(w.compact(fixture)), 1048576)

    def test_clock_failures_latch_and_do_not_advance(self):
        reads = iter([5, 4, 6, float('nan')]); clock = m.Clock(lambda: next(reads))
        self.assertEqual(clock.now(), 5)
        with self.assertRaises(m.ContractError): clock.now()
        saved = dict(clock.failure); self.assertEqual(clock.previous, 5)
        self.assertEqual(clock.now(), 6)
        with self.assertRaises(m.ContractError): clock.now()
        self.assertEqual(clock.failure, saved); self.assertEqual(clock.previous, 6)
        with self.assertRaises(m.ContractError): m.Clock(lambda: True).now()
        failing = m.Clock(lambda: (_ for _ in ()).throw(OSError('ordinary read failure')))
        with self.assertRaises(OSError): failing.now()
        self.assertIsNone(failing.failure['observed_ns'])

    def test_strict_json_and_exact_host_types(self):
        self.assertEqual(m.strict_json('"🌱"'.encode()), '🌱')
        for raw in [b'{"a":1,"\\u0061":2}', b'1e999', b'NaN', b'"\\ud800"', b'"\\u0000"', b'"\xff"']:
            with self.subTest(raw=raw), self.assertRaises(m.ContractError): m.strict_json(raw)
        self.assertFalse(w.strict_equal(True, 1)); self.assertFalse(w.strict_equal(1, 1.0))
        self.assertTrue(sdk.typed_equal(9223372036854775807, w.integer(9223372036854775807)))
        self.assertFalse(sdk.typed_equal(True, w.integer(1)))
        self.assertTrue(sdk.typed_equal(Decimal('0.10'), w.decimal()))
        self.assertFalse(sdk.typed_equal(Decimal('0.1'), w.decimal()))

    def test_complete_simulation_keeps_five_raw_samples_and_negative_pairs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = m.execute_plan(root, 'test-pin', root / 'output', budget=m.Budget(m.Clock(lambda: 0)),
                pure_runner=simulated_pure, suite_factories={'python': SimulatedSuite, 'node': SimulatedSuite}, identity=fake_identity)
            self.assertTrue(result['complete']); self.assertEqual(result['launch_reservations'], 204)
            self.assertEqual(len(result['rows']), 204); self.assertFalse(result['measurements_performed'])
            self.assertEqual(result['execution_mode'], 'test_simulation')
            for identifier in w.PURE_IDS:
                summary = result['summary'][identifier]
                self.assertEqual(summary['full']['raw_ns'], [5] * 5)
                self.assertEqual(summary['control']['raw_ns'], [9] * 5)
                self.assertEqual(summary['paired_differences_ns'], [-4] * 5)
                self.assertEqual(summary['difference_labels'], ['not_separable_from_noise'] * 5)
            for row in result['rows']:
                artifact = row['output_artifact']; raw = (root / 'output' / artifact['name']).read_bytes()
                self.assertEqual(hashlib.sha256(raw).hexdigest(), artifact['sha256'])
            self.assertLessEqual((root / 'output/report.json').stat().st_size, 2097152)

    def test_failed_sample_and_startup_attempt_preserved_without_retry(self):
        calls = []
        def fail(root, fixture, mode, budget):
            budget.reserve(); calls.append((fixture['id'], mode))
            raise m.SampleError(m.ContractError('oracle', 'ordinary wrong fixture output'),
                {'launch_reservation': budget.reserved, 'pid': 123, 'stdout_raw': b'{"result":"wrong"}\n', 'cleanup': {'confirmed': True}})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = m.execute_plan(root, 'test-pin', root / 'output', budget=m.Budget(m.Clock(lambda: 0)), pure_runner=fail, identity=fake_identity)
            self.assertFalse(report['complete']); self.assertEqual(report['error']['code'], 'oracle')
            self.assertEqual(calls, [('V1', 'full')]); self.assertEqual(report['launch_reservations'], 1)
            self.assertEqual(report['rows'], [])
            artifact = report['failed_observation']['stdout_artifact']
            self.assertEqual((root / 'output' / artifact['name']).read_bytes(), b'{"result":"wrong"}\n')
            (root / 'manifest.json').write_bytes(w.compact({'native': 'native/sprout.exe'})); (root / 'drivers').mkdir(); (root / 'drivers/V1-full.sprout').write_bytes(b'ordinary source identity')
            budget = m.Budget(m.Clock(lambda: 0))
            original = OSError('ordinary Popen failure')
            with self.assertRaises(m.SampleError) as caught:
                m.prepared(root, {'id': 'V1', 'batch': 1}, 'full', budget,
                    process_factory=lambda *args: (_ for _ in ()).throw(original))
            evidence = caught.exception.observation
            self.assertEqual(budget.reserved, 1); self.assertFalse(evidence['spawn_returned'])
            self.assertEqual(evidence['source_sha256'], m.sha(root / 'drivers/V1-full.sprout'))
            self.assertIsNone(evidence['pid']); self.assertNotIn('elapsed_ns', evidence)

    def test_postcheck_deadline_and_source_changes_reject_complete_report(self):
        for failure in ['deadline', 'identity']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                raw_clock = ManualClock(); budget = m.Budget(m.Clock(raw_clock)); checks = []
                def verify(root, digest):
                    checks.append(True)
                    if len(checks) == 2:
                        if failure == 'identity': raise m.ContractError('source_hash', 'ordinary changed source')
                        raw_clock.advance(90000000000)
                    return fake_identity(root, digest)
                root = Path(directory)
                report = m.execute_plan(root, 'test-pin', root / 'output', budget=budget, pure_runner=simulated_pure,
                    suite_factories={'python': SimulatedSuite, 'node': SimulatedSuite}, identity=verify)
                self.assertFalse(report['complete']); self.assertEqual(len(report['rows']), 204)
                self.assertEqual(report['error']['code'], 'overall_deadline' if failure == 'deadline' else 'source_hash')

    def test_manifest_pin_and_changed_content_not_self_authenticating(self):
        with tempfile.TemporaryDirectory() as directory:
            root, pin, _, _ = sample_snapshot(Path(directory))
            manifest = m.verify_manifest(root, pin); path = root / 'manifest.json'
            (root / manifest['native']).write_bytes(b'changed ordinary source')
            with self.assertRaises(m.ContractError): m.verify_manifest(root, pin)
            manifest['files'][manifest['native']] = m.sha(root / manifest['native']); path.write_bytes(w.compact(manifest))
            with self.assertRaises(m.ContractError) as caught: m.verify_manifest(root, pin)
            self.assertEqual(caught.exception.code, 'input_hash')
            with self.assertRaises(m.ContractError) as caught: m.verify_manifest(root, m.sha(path))
            self.assertEqual(caught.exception.code, 'manifest_shape')

    def test_loaded_controller_cannot_be_authenticated_by_copy_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'controller').mkdir()
            names = ['measure_workloads.py', 'measurement_fixtures.py', 'measurement_sdk.py']
            for name in names: shutil.copyfile(TOOLS / name, root / 'controller' / name)
            manifest = {'files': {'controller/' + name: m.sha(root / 'controller' / name) for name in names}}
            with self.assertRaises(m.ContractError) as caught: m.executing_controller(root, manifest)
            self.assertEqual(caught.exception.code, 'executing_source')

    def test_bounded_writer_does_not_block_supervisor(self):
        entered, release = threading.Event(), threading.Event()
        class Stream:
            closed = False
            def write(self, data): entered.set(); release.wait(1); return len(data)
            def flush(self): pass
            def close(self): self.closed = True
        stream = Stream(); writer = m.PipeWriter(stream); writer.start()
        began = time.monotonic()
        try:
            with self.assertRaises(m.ContractError) as caught: writer.send(b'GO\n', .02)
            self.assertEqual(caught.exception.code, 'stdin_deadline'); self.assertTrue(entered.is_set())
            self.assertLess(time.monotonic() - began, .5)
        finally:
            writer.stop(); release.set(); writer.thread.join(1)
        self.assertFalse(writer.thread.is_alive()); self.assertTrue(stream.closed)

    def test_reader_error_latched_during_dequeue_preserves_root_cause(self):
        for mode in ['line', 'eof']:
            reader = m.PipeReader(io.BytesIO(), 4096, True)
            class Queue:
                def get(self, **kwargs):
                    reader.latch('stdout_limit', 'ordinary controlled overflow')
                    return b'partial' if mode == 'line' else None
                def empty(self): return True
            reader.frames = Queue()
            with self.assertRaises(m.ContractError) as caught: getattr(reader, mode)(.1)
            self.assertEqual(caught.exception.code, 'stdout_limit')

    def fixture_call(self, mode='normal', cap=262144, clock=None, late_spawn=False):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        root = Path(directory.name); (root / 'manifest.json').write_bytes(w.compact({'native': 'native/sprout.exe'})); (root / 'drivers').mkdir()
        (root / 'drivers/V1-full.sprout').write_bytes(b'ordinary Python-controlled source placeholder; not executed')
        children = []
        def factory(argv, cwd):
            child = m.OwnedProcess([sys.executable, '-B', str(HERE / 'fixtures/measurement_worker.py'), mode], cwd, stdout_cap=cap)
            children.append(child)
            if late_spawn: clock.advance(5000000000)
            return child
        return root, factory, children

    def test_live_handshake_owned_memory_and_normal_delayed_exit(self):
        for mode in ['normal', 'delayed-exit']:
            with self.subTest(mode=mode):
                root, factory, children = self.fixture_call(mode)
                report = m.prepared(root, {'id': 'V1', 'batch': 1, 'expected': {'ok': True}}, 'full', m.Budget(), factory)
                self.assertEqual(report['cleanup']['exit_code'], 0)
                self.assertFalse(report['cleanup']['termination_requested']); self.assertTrue(report['cleanup']['confirmed'])
                self.assertEqual(m.strict_json(report['output_raw']), {'result': {'ok': True}, 'unchanged': True})
                for name in ['memory_ready', 'memory_done']:
                    value = report[name]; m.check_memory(value)
                    if os.name == 'nt':
                        self.assertTrue(value['available']); self.assertGreater(value['peak_working_set_bytes'], 0)
                    else: self.assertFalse(value['available']); self.assertIsNone(value['peak_working_set_bytes'])
                self.assertIsNotNone(children[0].child.poll())

    def test_live_failures_keep_raw_and_reap_owned_child(self):
        for mode, cap, code in [('wrong', 262144, 'marker'), ('partial', 262144, 'partial_frame'),
                ('overflow', 4096, 'stdout_limit'), ('stderr', 262144, 'stderr'), ('wait', 262144, 'worker_deadline')]:
            with self.subTest(mode=mode):
                root, factory, children = self.fixture_call(mode, cap)
                budget = m.Budget(supervised_ns=200000000 if mode == 'wait' else 90000000000)
                with self.assertRaises(m.SampleError) as caught:
                    m.prepared(root, {'id': 'V1', 'batch': 1, 'expected': {'ok': True}}, 'full', budget, factory)
                error = caught.exception
                if os.environ.get('N007_CONTROL_EVIDENCE'):
                    target = Path(os.environ['N007_CONTROL_EVIDENCE']); target.mkdir(exist_ok=True)
                    record = m.raw_artifacts(dict(error.observation, code=error.code), target, ['wrong', 'partial', 'overflow', 'stderr', 'wait'].index(mode))
                    (target / (mode + '.json')).write_bytes(w.compact(record))
                self.assertEqual(error.code, code); self.assertEqual(budget.reserved, 1)
                self.assertTrue(error.observation['cleanup']['direct_reaped']); self.assertTrue(error.observation['cleanup']['readers_joined'])
                self.assertIsNotNone(children[0].child.poll())
                self.assertLessEqual(len(error.observation['stdout_raw']), cap)

    def test_reader_start_failure_closes_unowned_pipes_preserving_original(self):
        original = RuntimeError('ordinary controlled thread start failure'); children = []
        real_popen = subprocess.Popen
        def capture(*args, **kwargs):
            child = real_popen(*args, **kwargs); children.append(child); return child
        with patch.object(m.subprocess, 'Popen', side_effect=capture), patch.object(m.threading.Thread, 'start', side_effect=original):
            with self.assertRaises(RuntimeError) as caught:
                m.OwnedProcess([sys.executable, '-B', str(HERE / 'fixtures/measurement_worker.py')], HERE)
        self.assertIs(caught.exception, original)
        self.assertTrue(original.n007_cleanup['direct_reaped']); self.assertTrue(original.n007_cleanup['readers_joined'])
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(all(stream.closed for stream in [children[0].stdin, children[0].stdout, children[0].stderr]))

    def test_late_spawn_returns_are_failed_not_zero_samples(self):
        clock = ManualClock(); root, factory, children = self.fixture_call(clock=clock, late_spawn=True)
        budget = m.Budget(m.Clock(clock))
        with self.assertRaises(m.SampleError) as caught:
            m.prepared(root, {'id': 'V1', 'batch': 1, 'expected': {'ok': True}}, 'full', budget, factory)
        self.assertEqual(caught.exception.code, 'worker_deadline')
        self.assertTrue(caught.exception.observation['spawn_returned'])
        self.assertNotIn('elapsed_ns', caught.exception.observation)
        self.assertTrue(caught.exception.observation['cleanup']['confirmed']); self.assertIsNotNone(children[0].child.poll())

    def test_python_stopwatch_excludes_oracle_and_preserves_exception(self):
        reads = iter([10, 17]); calls = []
        output, start, end = sdk.one_call(lambda *args, **kwargs: calls.append('run') or {'ok': True}, 'not-executed', {}, {}, m.Clock(lambda: next(reads)))
        self.assertEqual((start, end, output), (10, 17, {'ok': True})); self.assertEqual(calls, ['run'])
        original = RuntimeError('ordinary SDK-shaped failure')
        with self.assertRaises(RuntimeError) as caught:
            sdk.one_call(lambda *args, **kwargs: (_ for _ in ()).throw(original), 'not-executed', {}, {}, m.Clock(lambda: 20))
        self.assertIs(caught.exception, original); self.assertEqual(original.n007_start_ns, 20)

    def test_node_setup_failure_after_ready_closes_owned_parent(self):
        for failure in ['clock', 'fixture']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                raw_clock = ManualClock(); budget = m.Budget(m.Clock(raw_clock)); closes = []
                class Parent:
                    child = SimpleNamespace(pid=1234, poll=lambda: None)
                    stdout = SimpleNamespace(raw=b'READY\n'); stderr = SimpleNamespace(raw=b'')
                    def marker(self, expected, seconds):
                        self.marker_seen = True
                        if failure == 'clock': raw_clock.value = -1
                    def close(self):
                        closes.append('owned close')
                        return {'confirmed': True, 'test_simulated': True, 'direct_reaped': True}
                owned = Parent()
                with patch.object(m, 'OwnedProcess', return_value=owned), patch.object(m, 'host_tool_path', return_value='fake-node-never-executed'), \
                     patch.object(m, 'sha', return_value='fake-identity'), patch.object(m, 'memory', return_value={'available': False}):
                    with self.assertRaises(m.SampleError) as caught: m.NodeSuite(Path(directory), budget)
                self.assertTrue(owned.marker_seen); self.assertEqual(closes, ['owned close'])
                self.assertEqual(budget.reserved, 0)
                self.assertEqual(caught.exception.observation['parent_pid'], 1234)
                self.assertTrue(caught.exception.observation['cleanup']['confirmed'])
                self.assertEqual(caught.exception.observation['stdout_raw'], b'READY\n')
                if failure == 'clock':
                    self.assertEqual(caught.exception.code, 'clock_type')
                    self.assertEqual(caught.exception.observation['clock_failure']['observed_ns'], '-1')
                else: self.assertIsInstance(caught.exception.__cause__, FileNotFoundError)

    def test_node_parent_teardown_raw_evidence_is_retained_on_failure(self):
        class FailedParentSuite(SimulatedSuite):
            def close(self):
                self.closed = True
                return {'confirmed': False, 'stdout_raw': b'READY\nordinary-parent-output\n',
                        'stderr_raw': b'ordinary-parent-diagnostic', 'stdout_received_bytes': 29, 'stderr_received_bytes': 26}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = m.execute_plan(root, 'test-pin', root / 'output', budget=m.Budget(m.Clock(lambda: 0)),
                pure_runner=simulated_pure, suite_factories={'python': SimulatedSuite, 'node': FailedParentSuite}, identity=fake_identity)
            self.assertFalse(report['complete']); self.assertEqual(report['error']['code'], 'cleanup')
            self.assertEqual(report['launch_reservations'], 204); self.assertEqual(len(report['rows']), 204)
            record = report['sdk_setup']['node']['cleanup']
            self.assertEqual((root / 'output' / record['stderr_artifact']['name']).read_bytes(), b'ordinary-parent-diagnostic')
            self.assertEqual(record['stderr_received_bytes'], 26)
            self.assertFalse(record['confirmed']); self.assertTrue((root / 'output/report.json').is_file())

    def test_new_runtime_selection_requires_external_pin_and_canonical_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path, chosen = sample_selection(root); pin = m.sha(path)
            self.assertEqual(preparation.load_selection(path, pin), chosen)
            chosen['revision'] = 'b' * 40
            path.write_bytes(w.compact(chosen))
            with self.assertRaises(m.ContractError): preparation.load_selection(path, pin)
            self.assertEqual(preparation.load_selection(path, m.sha(path)), chosen)
            for bad in [('revision', 'short'), ('native_path', ''), ('native_sha256', 'A' * 64)]:
                invalid = dict(chosen); invalid[bad[0]] = bad[1]; path.write_bytes(w.compact(invalid))
                with self.subTest(field=bad[0]), self.assertRaises(m.ContractError): preparation.load_selection(path, m.sha(path))
            path.write_bytes(b'{"schema":"a","schema":"b"}')
            with self.assertRaises(m.ContractError): preparation.load_selection(path, m.sha(path))

    def test_node_stopwatch_fake_transport_only(self):
        # Bind this unchanged stopwatch to B5's previously exercised fake-callback body;
        # this publication candidate's scope runs no Node/native control process.
        source = (TOOLS / 'measurement_sdk.cjs').read_text(encoding='utf-8')
        body = source[source.index('async function oneCall('):source.index('module.exports =')]
        self.assertEqual(hashlib.sha256(body.encode()).hexdigest(), NODE_STOPWATCH_SHA)

    def test_default_inspectors_launch_write_and_consume_nothing(self):
        with tempfile.TemporaryDirectory(prefix='measurement 🌱 ') as directory:
            root = Path(directory); snapshot, pin, selection, chosen = sample_snapshot(root)
            before = {str(path.relative_to(root)): m.sha(path) for path in root.rglob('*') if path.is_file()}
            actual_open = Path.open
            def read_only(path, mode='r', *args, **kwargs):
                if any(char in mode for char in 'wax+'): raise AssertionError('default tried to write')
                return actual_open(path, mode, *args, **kwargs)
            with patch.object(m.subprocess, 'Popen', side_effect=AssertionError('default tried to launch')), patch.object(Path, 'open', new=read_only), redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(['--snapshot', str(snapshot), '--manifest-sha256', pin]), 0)
                self.assertEqual(preparation.main(['--selection', str(selection), '--selection-sha256', m.sha(selection)]), 0)
            after = {str(path.relative_to(root)): m.sha(path) for path in root.rglob('*') if path.is_file()}
            self.assertEqual(before, after); self.assertEqual(list(root.glob('.*.attempt.json')), [])

    def test_scope_output_pin_and_exclusive_marker_without_any_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); snapshot, pin, _, _ = sample_snapshot(root)
            file, record, output = sample_scope(root, snapshot, pin)
            with patch.object(m, 'execution_platform_supported', return_value=True), patch.object(m.subprocess, 'Popen', side_effect=AssertionError('unexpected launch')):
                manifest, decoded = m.reviewed_scope(snapshot, pin, file, m.sha(file), output)
                marker = m.reserve_once(output, decoded, m.sha(file)); original = marker.read_bytes()
                with self.assertRaises(FileExistsError): m.reserve_once(output, decoded, m.sha(file))
                self.assertEqual(marker.read_bytes(), original); self.assertFalse(output.exists())
                with self.assertRaises(m.ContractError): m.reviewed_scope(snapshot, pin, file, m.sha(file), root / 'different report')
                with self.assertRaises(m.ContractError): m.reviewed_scope(snapshot, pin, file, 'f' * 64, output)

    def test_unsupported_run_refuses_before_consuming_marker_or_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); snapshot, pin, _, _ = sample_snapshot(root); scope, _, output = sample_scope(root, snapshot, pin)
            with patch.object(m, 'execution_platform_supported', return_value=False), patch.object(m.subprocess, 'Popen', side_effect=AssertionError('unsupported launch')):
                with self.assertRaises(m.ContractError) as caught:
                    m.main(['--run-once', '--snapshot', str(snapshot), '--manifest-sha256', pin, '--scope-record', str(scope), '--scope-sha256', m.sha(scope), '--report', str(output)])
                self.assertEqual(caught.exception.code, 'platform')
            self.assertFalse(output.exists()); self.assertEqual(list(root.glob('.*.attempt.json')), [])

    def test_scope_arguments_cannot_implicitly_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); snapshot, pin, _, _ = sample_snapshot(root); scope, _, output = sample_scope(root, snapshot, pin)
            with patch.object(m.subprocess, 'Popen', side_effect=AssertionError('implicit launch')):
                with self.assertRaises(m.ContractError) as caught:
                    m.main(['--snapshot', str(snapshot), '--manifest-sha256', pin, '--scope-record', str(scope), '--scope-sha256', m.sha(scope), '--report', str(output)])
                self.assertEqual(caught.exception.code, 'mode')
            self.assertFalse(output.exists()); self.assertEqual(list(root.glob('.*.attempt.json')), [])

    def test_fixed_caps_boolean_tuning_and_suffix_independent_paths(self):
        spec = m.bounded_json(TOOLS.parent / 'benchmarks/library-workloads/v1-spec.json')
        m.validate_spec(spec)
        for key, wrong in [('runtime_ms', 6000), ('launch_ceiling', True)]:
            changed = m.strict_json(w.compact(spec)); changed['bounds'][key] = wrong
            with self.assertRaises(m.ContractError): m.validate_spec(changed)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'native').mkdir(); (root / 'native' / 'runtime').write_bytes(b'inert ordinary bytes')
            (root / 'manifest.json').write_bytes(w.compact({'native': 'native/runtime'}))
            self.assertEqual(m.runtime_path(root), root.resolve() / 'native' / 'runtime')
            (root / 'manifest.json').write_bytes(w.compact({'native': '../outside'}))
            with self.assertRaises(m.ContractError): m.runtime_path(root)

    def test_runtime_path_canonical_root_preserves_escape_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'alias').mkdir()
            (root / 'native').mkdir(); (root / 'native' / 'runtime').write_bytes(b'inert ordinary bytes')
            aliased_root = root / 'alias' / '..'
            (root / 'manifest.json').write_bytes(w.compact({'native': 'native/runtime'}))
            expected = root.resolve() / 'native' / 'runtime'
            self.assertNotEqual(expected, aliased_root / 'native' / 'runtime')
            self.assertEqual(m.runtime_path(aliased_root), expected)
            for invalid in ('../outside', 'native/../../outside', '/native/runtime', 'native\\runtime', 'C:/native/runtime'):
                with self.subTest(invalid=invalid):
                    (root / 'manifest.json').write_bytes(w.compact({'native': invalid}))
                    with self.assertRaises(m.ContractError) as caught: m.runtime_path(aliased_root)
                    self.assertEqual(caught.exception.code, 'inventory_path')

    def test_public_copy_preserves_all_samples_warmups_and_negative_differences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = m.execute_plan(root, 'test-pin', root / 'output', budget=m.Budget(m.Clock(lambda: 0)), pure_runner=simulated_pure,
                suite_factories={'python': SimulatedSuite, 'node': SimulatedSuite}, identity=fake_identity)
            original = w.compact(report)
            for row in report['rows']: row['pid'] = 123; row['source'] = 'C:/Users/PRIVATE-CANARY/local/source'
            report['python']['executable'] = 'C:/Users/PRIVATE-CANARY/python'
            manifest = {'revision': 'a'*40, 'native_sha256': 'b'*64, 'compiler_sha256': 'c'*64, 'build_sha256': 'd'*64, 'ci_sha256': 'e'*64,
                'files': {'controller/measure_workloads.py': 'f'*64}}
            untouched = w.compact(report)
            result = exporter.public_record(report, manifest, {}, 'controller/measure_workloads.py', '1'*64, '2'*64, '3'*64)
            self.assertNotIn(b'PRIVATE-CANARY', w.compact(result)); self.assertEqual(w.compact(report), untouched)
            self.assertEqual(len(result['rows']), 204); self.assertEqual(sum(row['warmup'] for row in result['rows']), 34)
            self.assertTrue(w.strict_equal(result['summary'], report['summary']))
            for old, new in zip(report['rows'], result['rows']):
                self.assertEqual(old['elapsed_ns'], new['elapsed_ns']); self.assertEqual(old['output_artifact'], new['output_artifact'])
            self.assertEqual(result['summary']['V1']['paired_differences_ns'], [-4]*5)

    def test_public_rows_keep_explicit_sdk_dimension_without_private_identity(self):
        rows = [
            {'kind': 'sdk', 'sdk': 'python', 'id': 'Hmin', 'start_ns': '1', 'end_ns': '2', 'pid': 101, 'source': 'private-path'},
            {'kind': 'sdk', 'sdk': 'node', 'id': 'Hmin', 'start_ns': '3', 'end_ns': '4', 'parent_pid': 102},
            {'kind': 'prepared', 'id': 'V1', 'mode': 'full', 'pid': 103},
        ]
        report = {'rows': rows, 'sdk_setup': {}, 'summary': {}, 'utc_started': 'synthetic', 'utc_finished': 'synthetic',
                  'deadline_boundary': 'synthetic', 'host': {}, 'python': {}}
        manifest = {'revision': 'a' * 40, 'native_sha256': 'b' * 64, 'compiler_sha256': 'c' * 64,
                    'build_sha256': 'd' * 64, 'ci_sha256': 'e' * 64, 'files': {'controller.py': 'f' * 64}}
        before = w.compact(report)
        # Pure projection only: the CLI separately requires complete verified evidence.
        result = exporter.public_record(report, manifest, {}, 'controller.py', '1' * 64, '2' * 64, '3' * 64)
        self.assertEqual(result['rows'], [
            {'kind': 'sdk', 'sdk': 'python', 'id': 'Hmin', 'start_ns': '1', 'end_ns': '2'},
            {'kind': 'sdk', 'sdk': 'node', 'id': 'Hmin', 'start_ns': '3', 'end_ns': '4'},
            {'kind': 'prepared', 'id': 'V1', 'mode': 'full'},
        ])
        self.assertEqual(w.compact(report), before)

    def test_export_rejects_simulation_and_tampering_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); snapshot, pin, _, _ = sample_snapshot(root)
            report = m.execute_plan(root, pin, root / 'simulated', budget=m.Budget(m.Clock(lambda: 0)), pure_runner=simulated_pure,
                suite_factories={'python': SimulatedSuite, 'node': SimulatedSuite}, identity=fake_identity)
            reportfile = root / 'simulated/report.json'; reportpin = m.sha(reportfile)
            review = root / 'review.json'; review.write_bytes(w.compact({'passed': True, 'report_sha256': reportpin, 'manifest_sha256': pin}))
            target = root / 'never-exported.json'
            args = ['--report', str(reportfile.parent), '--report-sha256', reportpin, '--snapshot', str(snapshot), '--manifest-sha256', pin,
                '--review', str(review), '--review-sha256', m.sha(review), '--export', str(target)]
            with self.assertRaises(m.ContractError) as caught: exporter.main(args)
            self.assertEqual(caught.exception.code, 'incomplete'); self.assertFalse(target.exists())
            reportfile.write_bytes(reportfile.read_bytes() + b' ')
            with self.assertRaises(m.ContractError) as caught: exporter.main(args)
            self.assertEqual(caught.exception.code, 'input_hash'); self.assertFalse(target.exists())

    def test_node_envelope_is_not_the_semantic_result(self):
        row = {'id': 'Hmin', 'start_ns': '10', 'end_ns': '17', 'elapsed_ns': 7}
        packet = {'ok': True, 'id': 'Hmin', 'start_ns': '10', 'end_ns': '17', 'elapsed_ns': '7', 'result': {'ok': True}}
        exporter.verify_node_packet(packet, row, {'ok': True})
        with self.assertRaises(m.ContractError): exporter.verify_node_packet({'ok': True}, row, {'ok': True})
        for key, wrong in [('id', 'Hecho16K'), ('elapsed_ns', '6'), ('result', {'ok': 1})]:
            changed = dict(packet); changed[key] = wrong
            with self.subTest(key=key), self.assertRaises(m.ContractError): exporter.verify_node_packet(changed, row, {'ok': True})


if __name__ == '__main__': unittest.main()
