"""Reporting/resource gate regressions without starting another HTTP workload."""
from contextlib import closing, redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('deployment_soak', ROOT / 'tools/deployment_soak.py')
DEPLOYMENT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOYMENT)


class DeploymentHarnessTests(unittest.TestCase):
    @staticmethod
    def cadence_summary(maximum_gap=1):
        return dict(max_gap_seconds=60, checkpoints=2, failed=False, failure=None,
                    first_monotonic=0, last_monotonic=1, last_observed_monotonic=1,
                    first_wall=1000, last_wall=1001, last_observed_wall=1001,
                    maximum_monotonic_gap_seconds=maximum_gap, maximum_wall_gap_seconds=maximum_gap)

    def setUp(self):
        self.summary = dict(samples=20, clean_shutdown=True, baseline_threads=1, final_threads=1,
                            native_started=8, native_exited=8, native_active_pids=[], maximum_native_active=4,
                            initial=dict(rss_bytes=100, handles=10, open_fds=5, threads=1),
                            last=dict(rss_bytes=150, handles=12, open_fds=6, threads=1),
                            host_sampled_maximum=dict(rss_bytes=180, handles=20, open_fds=10, threads=15),
                            cadence=self.cadence_summary())
        self.limits = dict(rss_peak_bytes=200, rss_retained_growth_bytes=60,
                           handles_peak=30, handles_retained_growth=3,
                           open_fds_peak=12, open_fds_retained_growth=2)

    def gate(self, summary=None, descriptor='handles'):
        DEPLOYMENT.resource_gate(summary or self.summary, self.limits, 4, descriptor=descriptor)

    def test_complete_host_metrics_pass_on_both_descriptor_models(self):
        self.gate()
        self.gate(descriptor='open_fds')

    def test_missing_or_invalid_required_metrics_fail(self):
        for metric in ('rss_bytes', 'threads', 'handles'):
            for where in ('initial', 'last', 'host_sampled_maximum'):
                with self.subTest(metric=metric, where=where):
                    summary = copy.deepcopy(self.summary)
                    summary[where][metric] = None
                    with self.assertRaisesRegex(AssertionError, 'missing or invalid'):
                        self.gate(summary)
        summary = copy.deepcopy(self.summary)
        summary['last']['open_fds'] = None
        with self.assertRaisesRegex(AssertionError, 'missing or invalid'):
            self.gate(summary, descriptor='open_fds')

    def test_absolute_resource_ceilings_fail(self):
        for metric, value in [('rss_bytes', 201), ('handles', 31), ('open_fds', 13)]:
            summary = copy.deepcopy(self.summary)
            summary['host_sampled_maximum'][metric] = value
            descriptor = 'open_fds' if metric == 'open_fds' else 'handles'
            with self.subTest(metric=metric), self.assertRaisesRegex(AssertionError, 'ceiling'):
                self.gate(summary, descriptor)

    def test_retained_growth_ceilings_fail(self):
        for metric, value in [('rss_bytes', 161), ('handles', 14), ('open_fds', 8)]:
            summary = copy.deepcopy(self.summary)
            summary['last'][metric] = value
            descriptor = 'open_fds' if metric == 'open_fds' else 'handles'
            with self.subTest(metric=metric), self.assertRaisesRegex(AssertionError, 'growth exceeded'):
                self.gate(summary, descriptor)

    def test_native_and_thread_lifecycle_gates(self):
        for key, value in [('native_exited', 7), ('native_active_pids', [999]),
                           ('maximum_native_active', 5), ('final_threads', 2)]:
            summary = copy.deepcopy(self.summary); summary[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.gate(summary)

    def test_completion_requires_duration_and_snapshot_verification(self):
        report = dict(workload_completed=True, traffic_duration_seconds=30,
                      configuration=dict(duration_seconds=30, max_gap_seconds=60), frozen_inputs_unchanged=True,
                      controller_cadence=self.cadence_summary(), hosts=[dict(cadence=self.cadence_summary())])
        DEPLOYMENT.completion_gate(report)
        for key, value in [('workload_completed', False), ('traffic_duration_seconds', 29.9),
                           ('frozen_inputs_unchanged', False)]:
            incomplete = dict(report); incomplete[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                DEPLOYMENT.completion_gate(incomplete)

    def test_completion_and_resource_gates_require_valid_cadence(self):
        invalid = [None, {}, dict(self.cadence_summary(), checkpoints=1),
                   dict(self.cadence_summary(), failed=True),
                   dict(self.cadence_summary(), maximum_wall_gap_seconds=61),
                   dict(self.cadence_summary(), last_observed_wall=float('nan')),
                   dict(self.cadence_summary(), last_monotonic=-1)]
        for cadence in invalid:
            with self.subTest(cadence=cadence):
                summary = copy.deepcopy(self.summary); summary['cadence'] = cadence
                with self.assertRaisesRegex(AssertionError, 'cadence'):
                    self.gate(summary)
                report = dict(workload_completed=True, traffic_duration_seconds=30,
                              frozen_inputs_unchanged=True, configuration=dict(duration_seconds=30, max_gap_seconds=60),
                              controller_cadence=cadence, hosts=[self.summary])
                with self.assertRaisesRegex(AssertionError, 'cadence'):
                    DEPLOYMENT.completion_gate(report)

    def test_cadence_rejects_backward_clocks_separately(self):
        for monotonic, wall, expected in [(99, 1001, 'monotonic'), (101, 999, 'wall')]:
            with self.subTest(clock=expected), patch.object(DEPLOYMENT.time, 'monotonic', side_effect=[100, monotonic]), patch.object(DEPLOYMENT.time, 'time', side_effect=[1000, wall]):
                cadence = DEPLOYMENT.Cadence(60, 'test'); cadence.checkpoint()
                with self.assertRaisesRegex(AssertionError, expected + ' clock moved backward'):
                    cadence.checkpoint()
                self.assertTrue(cadence.report()['failed'])
                json.dumps(cadence.report(), allow_nan=False)

    def test_missing_and_nonfinite_clocks_do_not_pollute_report(self):
        for source in ('monotonic', 'time'):
            for value in (None, float('nan'), float('inf'), float('-inf'), True):
                with self.subTest(source=source, value=value), patch.object(DEPLOYMENT.time, source, return_value=value):
                    cadence = DEPLOYMENT.Cadence(60, 'test')
                    with self.assertRaisesRegex(AssertionError, 'missing or nonfinite'):
                        cadence.checkpoint()
                    self.assertTrue(cadence.report()['failed'])
                    json.dumps(cadence.report(), allow_nan=False)
        with patch.object(DEPLOYMENT.time, 'monotonic', return_value=float('nan')):
            self.assertIsNone(DEPLOYMENT.elapsed_since(0))

    def test_gap_limit_must_be_positive_and_finite(self):
        for value in (None, 0, -1, float('nan'), float('inf'), True):
            with self.subTest(value=value), self.assertRaisesRegex(AssertionError, 'finite and positive'):
                DEPLOYMENT.Cadence(value, 'test')

    def test_legitimate_operations_and_pacing_keep_progress_reference(self):
        clock = SimpleNamespace(monotonic=100, wall=1000)
        with patch.object(DEPLOYMENT.time, 'monotonic', side_effect=lambda: clock.monotonic), patch.object(DEPLOYMENT.time, 'time', side_effect=lambda: clock.wall):
            cadence = DEPLOYMENT.Cadence(60, 'controller'); cadence.checkpoint()
            clock.monotonic += 45; clock.wall += 45; cadence.checkpoint()
            for _ in range(8):
                clock.monotonic += .25; clock.wall += .25; cadence.pending()
            self.assertEqual(cadence.report()['checkpoints'], 2)
            self.assertEqual(cadence.report()['last_monotonic'], 145)
            clock.monotonic += 44; clock.wall += 44; cadence.checkpoint()
            DEPLOYMENT.cadence_gate(cadence.report(), 60)
            self.assertEqual(cadence.report()['maximum_monotonic_gap_seconds'], 46)

    def test_final_sampler_capture_detects_wall_only_suspend(self):
        clock = SimpleNamespace(monotonic=1, wall=1000)
        with patch.object(DEPLOYMENT.time, 'monotonic', side_effect=lambda: clock.monotonic), patch.object(DEPLOYMENT.time, 'time', side_effect=lambda: clock.wall), patch.object(DEPLOYMENT, 'resource', return_value=dict(rss_bytes=100, threads=1, handles=10)):
            probes = DEPLOYMENT.Probes('never-launched', 'never-written', 60)
            clock.monotonic += 1; clock.wall += 1; probes.capture()
            clock.monotonic += .1; clock.wall += 61
            with self.assertRaisesRegex(AssertionError, 'host sampler cadence exceeded'):
                probes.capture()
            self.assertTrue(probes.report()['cadence']['failed'])
            json.dumps(probes.report(), allow_nan=False)

    def clock_fixture(self, jump=None, duration=30, rate=4, max_gap_seconds=60):
        """Real SQLite oracle and bounded fake transport/clock, no subprocesses."""
        clock = SimpleNamespace(monotonic=0, wall=1000)
        services = []
        summary = copy.deepcopy(self.summary)
        class FixtureService:
            def __init__(service, frozen, program, binary, workers, metrics, max_gap_seconds=60):
                service.database = Path(program).parent / 'contacts.sqlite'
                service.process = SimpleNamespace(pid=424242)
                service.lock = threading.Lock(); service.close_calls = 0
                service.summary = copy.deepcopy(summary)
                service.summary['cadence']['max_gap_seconds'] = max_gap_seconds
                services.append(service)
                with closing(sqlite3.connect(service.database)) as database:
                    database.execute('CREATE TABLE contacts(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE)')
                    database.commit()
            def request(service, method, path, value=None, *, timeout=6):
                with service.lock:
                    if path == '/health': return 200, b'{"ok":true}'
                    database = sqlite3.connect(service.database, timeout=0)
                    try:
                        if method == 'GET':
                            return 200, json.dumps({'contacts': database.execute('SELECT id,name,email FROM contacts').fetchall()}).encode()
                        try:
                            database.execute('INSERT INTO contacts(name,email) VALUES(?,?)', (value['name'], value['email'])); database.commit()
                            return 201, b'{"ok":true}'
                        except sqlite3.OperationalError:
                            return 503, b'{"error":"database unavailable"}'
                        except sqlite3.IntegrityError:
                            return 409, b'{"error":"email already exists"}'
                    finally:
                        database.close()
            def close(service):
                service.close_calls += 1
                return copy.deepcopy(service.summary)
        def sleep(seconds):
            if jump == 'nonfinite':
                clock.monotonic = float('inf'); clock.wall = float('nan')
                return
            clock.monotonic += duration + 1 if jump == 'both' else seconds
            clock.wall += duration + 1 if jump in ('both', 'wall') else seconds
        with tempfile.TemporaryDirectory() as name:
            fixture = Path(name)
            for relative in ('integrations/python/sprout_host.py', 'integrations/python/sprout_service.py', 'examples/services/contacts.sprout', 'dummy-native'):
                target = fixture / relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('not executed\n')
            args = SimpleNamespace(binary=fixture/'dummy-native',duration_seconds=duration,rate=rate,clients=8,workers=4,burst=8,
                                   max_gap_seconds=max_gap_seconds,
                                   restart_seconds=180,contention_seconds=60,shard_contacts=2000,
                                   max_host_rss_mib=128,max_retained_rss_growth_mib=64,max_host_handles=512,max_retained_handles_growth=128,
                                   max_host_fds=128,max_retained_fds_growth=32,max_workspace_mib=256,max_report_mib=4,
                                   seed=1,label='clock-review',workspace=fixture/'run',report=fixture/'result.json',stop_file=fixture/'STOP')
            with patch.object(DEPLOYMENT, 'ROOT', fixture), patch.object(DEPLOYMENT, 'Service', FixtureService), patch.object(DEPLOYMENT.time, 'monotonic', side_effect=lambda: clock.monotonic), patch.object(DEPLOYMENT.time, 'time', side_effect=lambda: clock.wall), patch.object(DEPLOYMENT.time, 'sleep', side_effect=sleep), redirect_stdout(io.StringIO()):
                result = DEPLOYMENT.main(args)
            report = json.loads(args.report.read_text())
            json.dumps(report, allow_nan=False)
            actual = 0
            for service in services:
                with closing(sqlite3.connect(service.database)) as database:
                    actual += database.execute('SELECT count(*) FROM contacts').fetchone()[0]
            return result, report, sum(service.close_calls for service in services), actual

    def test_pacing_clock_jump_after_one_burst_cannot_pass_full_duration(self):
        result, report, closed, actual = self.clock_fixture(jump='both', duration=28800)
        self.assertEqual(result, 1)
        self.assertFalse(report['passed']); self.assertFalse(report['workload_completed'])
        self.assertEqual(report['counts']['contacts'], 8); self.assertEqual(actual, 8)
        self.assertEqual(closed, 1)
        self.assertEqual(len(report['errors']), 1)
        self.assertIn('controller cadence exceeded maximum gap', report['errors'][0]['message'])
        DEPLOYMENT.cadence_gate(report['hosts'][0]['cadence'], 60)

    def test_wall_only_suspend_during_pacing_fails(self):
        result, report, closed, actual = self.clock_fixture(jump='wall', duration=28800)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertIn('controller cadence exceeded maximum gap', report['errors'][0]['message'])
        self.assertEqual(closed, 1); self.assertEqual(actual, 8)

    def test_failed_clock_report_has_no_nan_or_infinity(self):
        result, report, closed, actual = self.clock_fixture(jump='nonfinite', duration=28800)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertIn('clock is missing or nonfinite', report['errors'][0]['message'])
        self.assertIsNone(report['elapsed_seconds']); self.assertIsNone(report['hosts'][0]['epoch_seconds'])
        self.assertEqual(closed, 1); self.assertEqual(actual, 8)
        json.dumps(report, allow_nan=False)

    def test_healthy_pacing_and_bursts_complete_with_valid_cadence(self):
        result, report, closed, actual = self.clock_fixture()
        self.assertEqual(result, 0); self.assertTrue(report['passed'])
        self.assertEqual(actual, 120); self.assertEqual(closed, 1)
        self.assertEqual(report['traffic_duration_seconds'], 30)
        DEPLOYMENT.completion_gate(report)

    def test_planned_pacing_above_limit_is_rejected_before_host_launch(self):
        with self.assertRaisesRegex(AssertionError, 'planned pacing exceeds'):
            self.clock_fixture(rate=.1)

    def test_explicit_larger_gap_allows_documented_slow_pacing(self):
        result, report, closed, actual = self.clock_fixture(duration=120, rate=.1, max_gap_seconds=90)
        self.assertEqual(result, 0); self.assertTrue(report['passed'])
        self.assertEqual(report['configuration']['max_gap_seconds'], 90)
        self.assertEqual(actual, 16); self.assertEqual(closed, 1)
        self.assertEqual(report['controller_cadence']['maximum_wall_gap_seconds'], 80)

    def setup_clock_fixture(self, pause):
        real_connect = DEPLOYMENT.sqlite3.connect
        def connect(database, *args, **kwargs):
            if str(database).endswith('independent-oracle.sqlite'):
                DEPLOYMENT.time.sleep(pause)
            return real_connect(database, *args, **kwargs)
        with patch.object(DEPLOYMENT.sqlite3, 'connect', new=connect):
            return self.clock_fixture(duration=120)

    def test_oracle_setup_clock_gap_is_included_before_host_launch(self):
        result, report, closed, actual = self.setup_clock_fixture(61)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertEqual(closed, 0); self.assertEqual(actual, 0)
        self.assertEqual(report['controller_cadence']['first_monotonic'], 0)
        self.assertEqual(report['controller_cadence']['maximum_wall_gap_seconds'], 61)
        self.assertIn('controller cadence exceeded maximum gap', report['errors'][0]['message'])

    def test_healthy_oracle_setup_and_pacing_complete(self):
        result, report, closed, actual = self.setup_clock_fixture(2)
        self.assertEqual(result, 0); self.assertTrue(report['passed'])
        self.assertGreater(actual, 8); self.assertEqual(closed, 1)
        self.assertEqual(report['controller_cadence']['first_monotonic'], 0)
        self.assertEqual(report['traffic_duration_seconds'], 120)

    def test_retry_socket_timeout_is_clamped_to_remaining_budget(self):
        service = unittest.mock.Mock()
        service.request.return_value = (201, b'{"ok": true}')
        with patch.object(DEPLOYMENT.time, 'perf_counter', side_effect=[0, 14, 14.1, 14.2, 14.3, 14.4]):
            result = DEPLOYMENT.write_contact(service, {'name': 'Example', 'email': 'test@example.test'})
        self.assertEqual(service.request.call_args.kwargs['timeout'], 1)
        self.assertEqual(result['statuses'], {'201': 1})

    def test_late_success_is_not_accepted(self):
        service = unittest.mock.Mock()
        service.request.return_value = (201, b'{"ok": true}')
        with patch.object(DEPLOYMENT.time, 'perf_counter', side_effect=[0, 14, 14.1, 16]):
            with self.assertRaisesRegex(AssertionError, 'logical deadline'):
                DEPLOYMENT.write_contact(service, {'name': 'Example', 'email': 'test@example.test'})

    def test_resource_sampler_does_not_retain_new_windows_pointer_types(self):
        first = DEPLOYMENT.resource(os.getpid())
        self.assertGreater(first['rss_bytes'], 0)
        self.assertGreater(first['threads'], 0)
        if os.name == 'nt':
            import ctypes
            before = len(ctypes._pointer_type_cache)
            for _ in range(250):
                DEPLOYMENT.resource(os.getpid())
            self.assertEqual(len(ctypes._pointer_type_cache), before)
        else:
            self.assertGreater(DEPLOYMENT.resource(os.getpid())['rss_bytes'], 0)

    def test_workspace_and_report_storage_ceiling_crossings_fail(self):
        limits = dict(workspace_bytes=256, report_bytes=100)
        DEPLOYMENT.storage_gate(dict(workspace_bytes=256, report_bytes=100), limits)
        for key in limits:
            observation = dict(workspace_bytes=256, report_bytes=100)
            observation[key] += 1
            with self.subTest(key=key), self.assertRaisesRegex(AssertionError, 'storage ceiling'):
                DEPLOYMENT.storage_gate(observation, limits)

    def test_storage_measurement_includes_nested_frozen_and_database_files(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            (folder / 'frozen').mkdir()
            (folder / 'frozen' / 'binary').write_bytes(b'1234567')
            (folder / 'database').write_bytes(b'123')
            self.assertEqual(DEPLOYMENT.workspace_bytes(folder), 10)

    def test_stop_file_presence_and_inaccessible_control_fail_closed(self):
        with tempfile.TemporaryDirectory() as name:
            flag = Path(name) / 'STOP'
            DEPLOYMENT.check_stop_file(flag)
            flag.write_text('superseded by a newly frozen candidate', encoding='utf-8')
            with self.assertRaisesRegex(DEPLOYMENT.DeploymentStopped, 'requested cancellation'):
                DEPLOYMENT.check_stop_file(flag)
            with patch.object(Path, 'lstat', side_effect=PermissionError('denied')):
                with self.assertRaisesRegex(DEPLOYMENT.DeploymentStopped, 'could not be inspected'):
                    DEPLOYMENT.check_stop_file(flag)

    def test_pacing_sleep_checks_stop_file(self):
        with tempfile.TemporaryDirectory() as name:
            flag = Path(name) / 'STOP'
            deadline = DEPLOYMENT.time.monotonic() + 60
            with patch.object(DEPLOYMENT.time, 'sleep', side_effect=lambda seconds: flag.touch()) as sleeping:
                with self.assertRaises(DEPLOYMENT.DeploymentStopped):
                    DEPLOYMENT.pause_until(deadline, flag)
            self.assertEqual(sleeping.call_count, 1)
            self.assertLessEqual(sleeping.call_args.args[0], .25)

    def cancelled_fixture(self, use_stop_file=False):
        with tempfile.TemporaryDirectory() as name:
            fixture = Path(name)
            for relative in ('integrations/python/sprout_host.py', 'integrations/python/sprout_service.py',
                             'examples/services/contacts.sprout', 'dummy-native'):
                path = fixture / relative; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'not executed in this reporting regression\n')
            report = fixture / 'result.json'
            args = SimpleNamespace(binary=fixture / 'dummy-native', duration_seconds=30, rate=4, clients=8,
                                   workers=4, burst=8, restart_seconds=180, contention_seconds=60, shard_contacts=2000,
                                   max_host_rss_mib=128, max_retained_rss_growth_mib=64, max_host_handles=512,
                                   max_retained_handles_growth=128, max_host_fds=128, max_retained_fds_growth=32,
                                   max_workspace_mib=256, max_report_mib=4,
                                   seed=1, label='interrupt-regression', workspace=fixture / 'run', report=report)
            if use_stop_file:
                args.stop_file = fixture / 'STOP'; args.stop_file.touch()
            with patch.object(DEPLOYMENT, 'ROOT', fixture), patch.object(DEPLOYMENT, 'Service', side_effect=KeyboardInterrupt) as service, redirect_stdout(io.StringIO()):
                result = DEPLOYMENT.main(args)
            saved = json.loads(report.read_text(encoding='utf-8'))
            return result, saved, service.call_count

    def test_interruption_preserves_failed_report(self):
        result, saved, launched = self.cancelled_fixture()
        self.assertEqual(result, 1)
        self.assertEqual(saved['state'], 'interrupted')
        self.assertFalse(saved['passed'])
        self.assertFalse(saved['workload_completed'])
        self.assertTrue(saved['stop_requested'])
        self.assertEqual(saved['errors'][0]['type'], 'KeyboardInterrupt')

    def test_preexisting_stop_file_never_launches_a_host_or_passes(self):
        result, saved, launched = self.cancelled_fixture(use_stop_file=True)
        self.assertEqual(result, 1)
        self.assertEqual(launched, 0)
        self.assertEqual(saved['state'], 'interrupted')
        self.assertFalse(saved['passed'])
        self.assertFalse(saved['workload_completed'])
        self.assertTrue(saved['stop_requested'])
        self.assertEqual(saved['errors'][0]['type'], 'DeploymentStopped')


if __name__ == '__main__':
    unittest.main()
