"""Reporting/resource gate regressions without starting another HTTP workload."""
from contextlib import closing, redirect_stdout
import copy
import importlib.util
import io
import json
import math
import os
import signal
from pathlib import Path
import sqlite3
import subprocess
import sys
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

    def complete_report(self):
        cadence = dict(self.cadence_summary(), last_monotonic=30, last_observed_monotonic=30,
                       last_wall=1030, last_observed_wall=1030,
                       maximum_monotonic_gap_seconds=30, maximum_wall_gap_seconds=30)
        return dict(workload_completed=True, traffic_duration_seconds=30,
                    configuration=dict(duration_seconds=30, max_gap_seconds=60, rate=4, contention_seconds=60),
                    frozen_inputs_unchanged=True, controller_cadence=cadence,
                    traffic_clock=dict(started_monotonic=0, nominal_deadline_monotonic=30,
                                       deadline_monotonic=30, finished_monotonic=30),
                    counts=dict(contacts=120, health_checks=3, contention_503=1),
                    hosts=[dict(cadence=self.cadence_summary())])

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
        report = self.complete_report()
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
                report = self.complete_report(); report['controller_cadence'] = cadence
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

    def test_first_rejected_clock_observation_retains_raw_delta_and_prior_state(self):
        clock = SimpleNamespace(monotonic=100, wall=1000)
        with patch.object(DEPLOYMENT.time, 'monotonic', side_effect=lambda: clock.monotonic), \
             patch.object(DEPLOYMENT.time, 'time', side_effect=lambda: clock.wall):
            cadence = DEPLOYMENT.Cadence(60, 'test'); cadence.checkpoint()
            clock.monotonic, clock.wall = 101, 1001; cadence.pending()
            prior = cadence.report()
            self.assertIsNone(prior['first_failure_observation'])
            clock.monotonic, clock.wall = 102, 999
            with self.assertRaisesRegex(AssertionError, 'wall clock moved backward'): cadence.pending()
            failed = cadence.report(); observation = failed['first_failure_observation']
            self.assertEqual(observation['observed_monotonic'], 102)
            self.assertEqual(observation['observed_wall'], 999)
            self.assertEqual(observation['prior_observed_wall'], 1001)
            self.assertEqual(observation['prior_checkpoint_wall'], 1000)
            self.assertEqual(observation['wall_delta_seconds'], -2)
            self.assertEqual(observation['wall_checkpoint_gap_seconds'], -1)
            self.assertEqual(observation['monotonic_delta_seconds'], 1)
            self.assertFalse(observation['requested_checkpoint'])
            for key in ('checkpoints', 'first_monotonic', 'first_wall', 'last_monotonic', 'last_wall',
                        'last_observed_monotonic', 'last_observed_wall',
                        'maximum_monotonic_gap_seconds', 'maximum_wall_gap_seconds'):
                self.assertEqual(failed[key], prior[key])
            clock.monotonic, clock.wall = 103, 998
            with self.assertRaisesRegex(AssertionError, 'wall clock moved backward'): cadence.checkpoint()
            self.assertEqual(cadence.report()['first_failure_observation'], observation)
            observation['observed_wall'] = 0  # Report copies cannot alter the latched evidence.
            self.assertEqual(cadence.report()['first_failure_observation']['observed_wall'], 999)
            json.dumps(cadence.report(), allow_nan=False)

    def test_excessive_gap_records_raw_evidence_without_advancing_valid_clock(self):
        with patch.object(DEPLOYMENT.time, 'monotonic', side_effect=[100, 162]), \
             patch.object(DEPLOYMENT.time, 'time', side_effect=[1000, 1062]):
            cadence = DEPLOYMENT.Cadence(60, 'test'); cadence.checkpoint()
            with self.assertRaisesRegex(AssertionError, 'exceeded maximum gap'): cadence.checkpoint()
            value = cadence.report()
            self.assertEqual(value['checkpoints'], 1)
            self.assertEqual(value['last_observed_monotonic'], 100)
            self.assertEqual(value['last_observed_wall'], 1000)
            self.assertEqual(value['maximum_monotonic_gap_seconds'], 62)
            self.assertEqual(value['first_failure_observation']['observed_monotonic'], 162)
            self.assertEqual(value['first_failure_observation']['wall_delta_seconds'], 62)
            self.assertTrue(value['first_failure_observation']['requested_checkpoint'])
            json.dumps(value, allow_nan=False)

    def test_partial_clock_read_failure_keeps_the_completed_raw_read_only(self):
        for failing in ('wall', 'monotonic'):
            with self.subTest(failing=failing), \
                 patch.object(DEPLOYMENT.time, 'monotonic', side_effect=OSError('clock unavailable') if failing == 'monotonic' else None,
                              return_value=100) as monotonic, \
                 patch.object(DEPLOYMENT.time, 'time', side_effect=OSError('clock unavailable') if failing == 'wall' else None,
                              return_value=1000) as wall:
                cadence = DEPLOYMENT.Cadence(60, 'test')
                with self.assertRaisesRegex(OSError, 'clock unavailable'): cadence.checkpoint()
                value = cadence.report(); observation = value['first_failure_observation']
                self.assertEqual(observation['observed_monotonic'], 100 if failing == 'wall' else None)
                self.assertIsNone(observation['observed_wall'])
                self.assertEqual(value['checkpoints'], 0)
                self.assertIsNone(value['last_observed_monotonic'])
                self.assertIsNone(value['last_observed_wall'])
                if failing == 'monotonic': wall.assert_not_called()
                json.dumps(value, allow_nan=False)

    def test_missing_and_nonfinite_clocks_do_not_pollute_report(self):
        for source in ('monotonic', 'time'):
            for value in (None, float('nan'), float('inf'), float('-inf'), True):
                with self.subTest(source=source, value=value), patch.object(DEPLOYMENT.time, source, return_value=value):
                    cadence = DEPLOYMENT.Cadence(60, 'test')
                    with self.assertRaisesRegex(AssertionError, 'missing or nonfinite'):
                        cadence.checkpoint()
                    self.assertTrue(cadence.report()['failed'])
                    key = 'observed_monotonic' if source == 'monotonic' else 'observed_wall'
                    self.assertIsNone(cadence.report()['first_failure_observation'][key])
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

    def clock_fixture(self, jump=None, duration=30, rate=4, max_gap_seconds=60,
                      started=0, health_delay=0, health_fail_at=None, startup_delay=0,
                      contention_seconds=60, contention_delay=0, restart_seconds=180, actual_counts=None,
                      close_failure=False, close_summary_available=True):
        """Real SQLite oracle and bounded fake transport/clock, no subprocesses."""
        clock = SimpleNamespace(monotonic=started, wall=1000)
        services = []
        summary = copy.deepcopy(self.summary)
        class FixtureService:
            def __init__(service, frozen, program, binary, workers, metrics, max_gap_seconds=60):
                service.database = Path(program).parent / 'contacts.sqlite'
                service.metrics = metrics
                service.process = SimpleNamespace(pid=424242)
                service.lock = threading.Lock(); service.close_calls = 0
                service.health_calls = 0
                service.lock_calls = 0
                clock.monotonic += startup_delay; clock.wall += startup_delay
                service.summary = copy.deepcopy(summary)
                service.summary['cadence']['max_gap_seconds'] = max_gap_seconds
                services.append(service)
                with closing(sqlite3.connect(service.database)) as database:
                    database.execute('CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE)')
                    database.commit()
            def request(service, method, path, value=None, *, timeout=6):
                with service.lock:
                    if path == '/health':
                        service.health_calls += 1
                        clock.monotonic += health_delay; clock.wall += health_delay
                        if service.health_calls == health_fail_at: return 500, b'{"ok":false}'
                        return 200, b'{"ok":true}'
                    database = sqlite3.connect(service.database, timeout=0)
                    try:
                        if method == 'GET':
                            return 200, json.dumps({'contacts': database.execute('SELECT id,name,email FROM contacts').fetchall()}).encode()
                        try:
                            database.execute('INSERT INTO contacts(name,email) VALUES(?,?)', (value['name'], value['email'])); database.commit()
                            return 201, b'{"ok":true}'
                        except sqlite3.OperationalError:
                            service.lock_calls += 1
                            clock.monotonic += contention_delay; clock.wall += contention_delay
                            return 503, b'{"error":"database unavailable"}'
                        except sqlite3.IntegrityError:
                            return 409, b'{"error":"email already exists"}'
                    finally:
                        database.close()
            def close(service):
                service.close_calls += 1
                summary = copy.deepcopy(service.summary)
                if close_failure:
                    summary.update(pid=service.process.pid, errors=['fixture probe error'])
                    if close_summary_available: DEPLOYMENT.save(service.metrics, summary)
                    raise DEPLOYMENT.ServiceCloseError('HTTP host exit 1: fixture probe error',
                        summary=summary if close_summary_available else None, exit_code=1,
                        metrics_error=None if close_summary_available else 'FileNotFoundError: fixture metrics unavailable')
                return summary
        def sleep(seconds):
            if jump == 'nonfinite':
                clock.monotonic = float('inf'); clock.wall = float('nan')
                return
            nominal = started + duration
            if jump == 'nominal' and clock.monotonic < nominal - 2 <= clock.monotonic + seconds:
                clock.wall += nominal - clock.monotonic
                clock.monotonic = nominal
                return
            clock.monotonic += duration + 1 if jump == 'both' else seconds
            clock.wall += -1 if jump == 'backward' else duration + 1 if jump in ('both', 'wall') else seconds
        with tempfile.TemporaryDirectory() as name:
            fixture = Path(name)
            for relative in ('integrations/python/sprout_host.py', 'integrations/python/sprout_service.py', 'examples/services/contacts.sprout', 'dummy-native'):
                target = fixture / relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('not executed\n')
            args = SimpleNamespace(binary=fixture/'dummy-native',duration_seconds=duration,rate=rate,clients=8,workers=4,burst=8,
                                   max_gap_seconds=max_gap_seconds,
                                   restart_seconds=restart_seconds,contention_seconds=contention_seconds,shard_contacts=2000,
                                   max_host_rss_mib=128,max_retained_rss_growth_mib=64,max_host_handles=512,max_retained_handles_growth=128,
                                   max_host_fds=128,max_retained_fds_growth=32,max_workspace_mib=256,max_report_mib=4,
                                   seed=1,label='clock-review',workspace=fixture/'run',report=fixture/'result.json',stop_file=fixture/'STOP')
            with patch.object(DEPLOYMENT, 'ROOT', fixture), patch.object(DEPLOYMENT, 'Service', FixtureService), patch.object(DEPLOYMENT.time, 'monotonic', side_effect=lambda: clock.monotonic), patch.object(DEPLOYMENT.time, 'time', side_effect=lambda: clock.wall), patch.object(DEPLOYMENT.time, 'sleep', side_effect=sleep), redirect_stdout(io.StringIO()):
                result = DEPLOYMENT.main(args)
            report = json.loads(args.report.read_text())
            json.dumps(report, allow_nan=False)
            actual = 0
            for database_path in {service.database for service in services}:
                with closing(sqlite3.connect(database_path)) as database:
                    actual += database.execute('SELECT count(*) FROM contacts').fetchone()[0]
            if actual_counts is not None:
                actual_counts['locks'] = sum(service.lock_calls for service in services)
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

    def test_failed_close_after_clock_error_retains_final_host_evidence_without_success_credit(self):
        result, report, closed, actual = self.clock_fixture(jump='backward', close_failure=True)
        self.assertEqual(result, 1); self.assertFalse(report['passed']); self.assertFalse(report['workload_completed'])
        self.assertEqual(actual, 8); self.assertEqual(closed, 1)
        self.assertEqual(report['counts']['hosts_started'], 1)
        self.assertEqual(report['counts']['hosts_cleanly_stopped'], 0)
        self.assertEqual(len(report['hosts']), 1)
        self.assertEqual(report['hosts'][0]['native_started'], report['hosts'][0]['native_exited'])
        self.assertTrue(report['hosts'][0]['clean_shutdown'])
        self.assertEqual(report['hosts'][0]['exit_code'], 1)
        self.assertIn('HTTP host exit 1', report['hosts'][0]['close_error'])
        self.assertIn('fixture probe error', report['hosts'][0]['errors'])
        self.assertIn('wall clock moved backward', report['errors'][0]['message'])
        self.assertIn('HTTP host exit 1', report['errors'][1]['message'])
        self.assertIsNone(report['active_host_pid'])
        self.assertEqual(report['controller_cadence']['first_failure_observation']['observed_wall'], 999)
        json.dumps(report, allow_nan=False)

    def test_unavailable_close_metrics_do_not_manufacture_a_host_summary(self):
        result, report, closed, actual = self.clock_fixture(jump='backward', close_failure=True, close_summary_available=False)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertEqual(actual, 8); self.assertEqual(closed, 1)
        self.assertEqual(report['hosts'], [])
        self.assertEqual(report['counts']['hosts_cleanly_stopped'], 0)
        self.assertIn('wall clock moved backward', report['errors'][0]['message'])
        self.assertIn('final host metrics unavailable', report['errors'][1]['message'])

    def close_service_fixture(self, code, mode='valid', final_threads=1):
        """Real small owned child publishes local metrics and exits after STOP."""
        with tempfile.TemporaryDirectory() as name:
            metrics = Path(name) / 'metrics.json'
            payload = dict(clean_shutdown=True, native_started=0, native_exited=0, native_active_pids=[],
                           baseline_threads=1, final_threads=final_threads,
                           errors=[] if code == 0 else ['fixture probe error'])
            script = ('import json,os,pathlib,sys\n'
                      'assert sys.stdin.readline().strip()=="STOP"\n'
                      'value=json.loads(sys.argv[3]); value["pid"]=os.getpid()\n'
                      'if sys.argv[4]=="foreign": value["pid"]+=1\n'
                      'if sys.argv[4]=="unidentified": value.pop("pid")\n'
                      'if sys.argv[4]!="missing": pathlib.Path(sys.argv[1]).write_text('
                      '"unfinished JSON" if sys.argv[4]=="invalid" else json.dumps(value))\n'
                      'sys.exit(int(sys.argv[2]))\n')
            service = DEPLOYMENT.Service.__new__(DEPLOYMENT.Service)
            service.metrics, service.stderr, service.readers = metrics, bytearray(), []
            service.process = subprocess.Popen([sys.executable, '-c', script, str(metrics), str(code), json.dumps(payload), mode],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=os.name != 'nt',
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            try:
                try:
                    summary, error = service.close(), None
                except DEPLOYMENT.ServiceCloseError as caught:
                    summary, error = None, caught
                self.assertEqual(service.process.returncode, code)
                self.assertTrue(all(p.closed for p in (service.process.stdin, service.process.stdout, service.process.stderr)))
                if os.name != 'nt':
                    with self.assertRaises(ChildProcessError): os.waitpid(service.process.pid, os.WNOHANG)
                return summary, error, service.process.pid
            finally:
                if service.process.poll() is None: service.process.kill()
                service.process.wait(timeout=2)
                for stream in (service.process.stdin, service.process.stdout, service.process.stderr):
                    if not stream.closed: stream.close()

    def test_real_host_exit_one_retains_saved_metrics_and_reaps_child(self):
        summary, error, pid = self.close_service_fixture(0)
        self.assertIsNone(error); self.assertEqual(summary['pid'], pid)
        summary, error, pid = self.close_service_fixture(1)
        self.assertIsNone(summary); self.assertEqual(error.exit_code, 1)
        self.assertEqual(error.summary['pid'], pid)
        self.assertTrue(error.summary['clean_shutdown'])
        self.assertEqual(error.summary['errors'], ['fixture probe error'])
        self.assertIsNone(error.metrics_error)

    def test_real_host_unavailable_or_incomplete_metrics_remain_failed(self):
        for mode, expected in [('missing', 'FileNotFoundError'), ('invalid', 'JSONDecodeError')]:
            for code in (0, 1):
                with self.subTest(mode=mode, code=code):
                    summary, error, pid = self.close_service_fixture(code, mode)
                    self.assertIsNone(summary); self.assertIsNone(error.summary)
                    self.assertEqual(error.exit_code, code)
                    self.assertIn(expected, error.metrics_error)
                    if code == 1: self.assertIn('HTTP host exit 1', str(error))

    def test_real_host_invalid_cleanup_metrics_do_not_receive_success_credit(self):
        summary, error, pid = self.close_service_fixture(0, final_threads=True)
        self.assertIsNone(summary); self.assertEqual(error.exit_code, 0)
        self.assertEqual(error.summary['pid'], pid)
        self.assertIn('native children or threads', str(error))

    def test_real_host_foreign_or_unidentified_metrics_are_not_attached_as_evidence(self):
        for mode in ('foreign', 'unidentified'):
            for code in (0, 1):
                with self.subTest(mode=mode, code=code):
                    summary, error, pid = self.close_service_fixture(code, mode)
                    self.assertIsNone(summary); self.assertIsNone(error.summary)
                    self.assertEqual(error.exit_code, code)
                    self.assertIn('different or unidentified process', error.metrics_error)
                    if code == 1: self.assertIn('HTTP host exit 1', str(error))

    def stub_close_fixture(self, mode, code=1, platform_name='nt', group_failure=None, tree_status=0):
        """No actual signals: model exit and STOP races with all signal APIs mocked."""
        process = unittest.mock.Mock(pid=424242)
        process.poll.return_value = code if mode == 'exited' else None
        process.wait.return_value = code
        process.stdout, process.stderr = io.BytesIO(), io.BytesIO()
        writes = []
        class Control(io.BytesIO):
            def write(control, value):
                writes.append(value)
                if mode == 'broken':
                    process.poll.return_value = code
                    raise BrokenPipeError('fixture host exited during control write')
                return super().write(value)
            def close(control):
                super().close()
                if mode == 'delivered': process.poll.return_value = code
        process.stdin = Control()
        if mode in ('timeout-exited', 'live-timeout', 'kill-denied'):
            def wait(*, timeout):
                if timeout == 12:
                    if mode == 'timeout-exited': process.poll.return_value = code
                    raise subprocess.TimeoutExpired('owned fixture host', timeout)
                if mode == 'kill-denied': raise subprocess.TimeoutExpired('owned fixture host', timeout)
                return code
            process.wait.side_effect = wait
        if mode == 'kill-denied':
            process.kill.side_effect = PermissionError('fixture direct kill denied')
        elif mode == 'live-timeout':
            process.kill.side_effect = lambda: setattr(process.poll, 'return_value', code)
        with tempfile.TemporaryDirectory() as folder:
            service = DEPLOYMENT.Service.__new__(DEPLOYMENT.Service)
            service.process, service.stderr, service.readers = process, bytearray(), []
            service.metrics = Path(folder)/'host.json'
            payload = dict(pid=process.pid, clean_shutdown=True, native_started=0, native_exited=0,
                           native_active_pids=[], baseline_threads=1, final_threads=1,
                           errors=[] if code == 0 else ['fixture exit error'])
            service.metrics.write_text(json.dumps(payload))
            with patch.object(DEPLOYMENT.os, 'name', platform_name), \
                 patch.object(DEPLOYMENT.os, 'killpg', create=True) as group, \
                 patch.object(signal, 'SIGKILL', 9, create=True), \
                 patch.object(DEPLOYMENT.subprocess, 'CREATE_NO_WINDOW', 0, create=True), \
                 patch.object(DEPLOYMENT.subprocess, 'run') as tree:
                tree.return_value = SimpleNamespace(returncode=tree_status, stdout=b'', stderr=b'fixture tree error' if tree_status else b'')
                group.side_effect = group_failure
                tree.side_effect = group_failure
                try: summary, error = service.close(), None
                except DEPLOYMENT.ServiceCloseError as caught: summary, error = None, caught
            return SimpleNamespace(process=process, summary=summary, error=error, writes=writes,
                                   tree_calls=tree.call_count, group_calls=group.call_count, payload=payload)

    def test_exited_host_zero_and_one_are_reaped_without_stop_or_any_signal(self):
        for platform_name in ('nt', 'posix'):
            for code in (0, 1):
                with self.subTest(platform=platform_name, code=code):
                    result = self.stub_close_fixture('exited', code, platform_name)
                    self.assertEqual(result.writes, [])
                    self.assertEqual(result.tree_calls + result.group_calls, 0)
                    result.process.kill.assert_not_called()
                    result.process.wait.assert_called_once_with(timeout=0)
                    self.assertEqual(result.error.exit_code, code)
                    self.assertEqual(result.error.summary, result.payload)
                    self.assertNotIn('deadline', str(result.error))
                    self.assertIn('before controller STOP' if code == 0 else 'HTTP host exit 1', str(result.error))

    def test_broken_stop_after_exit_preserves_exit_one_without_tree_or_group_signal(self):
        for platform_name in ('nt', 'posix'):
            result = self.stub_close_fixture('broken', 1, platform_name)
            self.assertEqual(result.error.exit_code, 1)
            self.assertEqual(result.error.summary, result.payload)
            self.assertIn('HTTP host exit 1', str(result.error))
            self.assertNotIn('deadline', str(result.error))
            self.assertEqual(result.tree_calls + result.group_calls, 0)
            result.process.kill.assert_not_called()

    def test_zero_exit_requires_delivered_stop_to_receive_controlled_close_credit(self):
        rejected = self.stub_close_fixture('broken', 0)
        self.assertIn('without confirmed STOP delivery', str(rejected.error))
        accepted = self.stub_close_fixture('delivered', 0)
        self.assertIsNone(accepted.error)
        self.assertEqual(accepted.summary, accepted.payload)
        self.assertEqual(accepted.writes, [b'STOP\n'])
        self.assertEqual(accepted.tree_calls + accepted.group_calls, 0)
        accepted.process.kill.assert_not_called()

    def test_deadline_expiry_followed_by_observed_exit_keeps_deadline_without_signal(self):
        result = self.stub_close_fixture('timeout-exited', 0)
        self.assertIn('deadline', str(result.error))
        self.assertEqual(result.error.exit_code, 0)
        self.assertEqual(result.error.summary, result.payload)
        self.assertEqual(result.tree_calls + result.group_calls, 0)
        result.process.kill.assert_not_called()

    def test_live_group_denial_preserves_deadline_and_still_directly_kills_and_reaps(self):
        for platform_name in ('nt', 'posix'):
            for failure in (PermissionError('fixture group denied'), subprocess.TimeoutExpired('fixture tree', 5)):
                with self.subTest(platform=platform_name, failure=type(failure).__name__):
                    result = self.stub_close_fixture('live-timeout', 1, platform_name, failure)
                    self.assertIn('deadline', str(result.error))
                    self.assertIn(type(failure).__name__, str(result.error))
                    self.assertEqual(result.error.summary, result.payload)
                    result.process.kill.assert_called_once()
                    self.assertEqual(result.process.wait.call_args.kwargs['timeout'], 5)

    def test_unconfirmed_owned_exit_retains_primary_deadline_and_cleanup_diagnostics(self):
        result = self.stub_close_fixture('kill-denied', 1, 'nt', PermissionError('fixture group denied'))
        self.assertIsNone(result.error.exit_code)
        self.assertIn('deadline', str(result.error))
        self.assertIn('direct owned host termination', str(result.error))
        self.assertIn('exit could not be confirmed', str(result.error))
        self.assertEqual(result.error.summary, result.payload)

    def test_live_failed_tree_command_retains_status_and_direct_owned_cleanup(self):
        result = self.stub_close_fixture('live-timeout', 1, 'nt', tree_status=5)
        self.assertIn('deadline', str(result.error))
        self.assertIn('tree termination exit 5', str(result.error))
        self.assertIn('fixture tree error', str(result.error))
        result.process.kill.assert_called_once()

    def test_real_preexited_zero_and_one_keep_metrics_without_signal_or_success_credit(self):
        for code in (0, 1):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as folder:
                service = DEPLOYMENT.Service.__new__(DEPLOYMENT.Service)
                service.metrics, service.stderr, service.readers = Path(folder)/'metrics.json', bytearray(), []
                service.process = subprocess.Popen([sys.executable, '-c', 'import sys; sys.exit(int(sys.argv[1]))', str(code)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    start_new_session=os.name != 'nt',
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                service.process.wait(timeout=3)
                payload = dict(pid=service.process.pid, clean_shutdown=True, native_started=0, native_exited=0,
                               native_active_pids=[], baseline_threads=1, final_threads=1,
                               errors=[] if code == 0 else ['fixture error'])
                service.metrics.write_text(json.dumps(payload))
                try:
                    with patch.object(service.process, 'kill') as direct, \
                         patch.object(DEPLOYMENT.os, 'killpg', create=True) as group, \
                         patch.object(DEPLOYMENT.subprocess, 'run') as tree:
                        with self.assertRaises(DEPLOYMENT.ServiceCloseError) as caught: service.close()
                    direct.assert_not_called(); group.assert_not_called(); tree.assert_not_called()
                    self.assertEqual(caught.exception.exit_code, code)
                    self.assertEqual(caught.exception.summary, payload)
                    self.assertNotIn('deadline', str(caught.exception))
                    if os.name != 'nt':
                        with self.assertRaises(ChildProcessError): os.waitpid(service.process.pid, os.WNOHANG)
                finally:
                    for pipe in (service.process.stdin, service.process.stdout, service.process.stderr):
                        if not pipe.closed: pipe.close()

    def test_real_owned_child_is_reaped_when_mocked_group_kill_is_denied(self):
        with tempfile.TemporaryDirectory() as folder:
            service = DEPLOYMENT.Service.__new__(DEPLOYMENT.Service)
            service.metrics, service.stderr, service.readers = Path(folder)/'metrics.json', bytearray(), []
            service.process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=os.name != 'nt',
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            payload = dict(pid=service.process.pid, clean_shutdown=True, native_started=0, native_exited=0,
                           native_active_pids=[], baseline_threads=1, final_threads=1, errors=[])
            service.metrics.write_text(json.dumps(payload))
            original_wait = service.process.wait
            def bounded_wait(timeout=None):
                if timeout == 12: raise subprocess.TimeoutExpired('owned fixture', timeout)
                return original_wait(timeout=timeout)
            try:
                with patch.object(service.process, 'wait', side_effect=bounded_wait), \
                     patch.object(DEPLOYMENT.os, 'killpg', create=True, side_effect=PermissionError('fixture group denied')), \
                     patch.object(DEPLOYMENT.subprocess, 'run', side_effect=PermissionError('fixture tree denied')):
                    with self.assertRaises(DEPLOYMENT.ServiceCloseError) as caught: service.close()
                self.assertIn('deadline', str(caught.exception))
                self.assertIn('PermissionError', str(caught.exception))
                self.assertIsNotNone(service.process.poll())
                self.assertTrue(all(pipe.closed for pipe in (service.process.stdin, service.process.stdout, service.process.stderr)))
                if os.name != 'nt':
                    with self.assertRaises(ChildProcessError): os.waitpid(service.process.pid, os.WNOHANG)
            finally:
                if service.process.poll() is None: service.process.kill()
                service.process.wait(timeout=2)
                for pipe in (service.process.stdin, service.process.stdout, service.process.stderr):
                    if not pipe.closed: pipe.close()

    def test_live_reader_stream_is_retained_with_failure_instead_of_blocking_close(self):
        with tempfile.TemporaryDirectory() as folder:
            service = DEPLOYMENT.Service.__new__(DEPLOYMENT.Service)
            service.process = unittest.mock.Mock(pid=424242)
            service.process.poll.return_value = service.process.wait.return_value = 1
            service.process.stdin, service.process.stdout, service.process.stderr = io.BytesIO(), io.BytesIO(), io.BytesIO()
            reader = unittest.mock.Mock(ident=1)
            reader.is_alive.return_value = True
            service.readers, service.stderr = [reader], bytearray()
            service.metrics = Path(folder)/'metrics.json'
            service.metrics.write_text(json.dumps(dict(pid=424242, clean_shutdown=True, native_started=0,
                native_exited=0, native_active_pids=[], baseline_threads=1, final_threads=1, errors=['fixture error'])))
            try:
                with self.assertRaises(DEPLOYMENT.ServiceCloseError) as caught: service.close()
                reader.join.assert_called_once_with(timeout=3)
                self.assertFalse(service.process.stdout.closed)
                self.assertIn('pipe reader did not exit', str(caught.exception))
                self.assertEqual(caught.exception.exit_code, 1)
            finally:
                service.process.stdout.close()

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

    def test_absolute_deadline_rounding_preserves_raw_duration_without_extra_burst(self):
        started = 65510.001
        nominal = started + 30
        self.assertLess(nominal - started, 30)  # Historical false failure.
        result, report, closed, actual = self.clock_fixture(started=started)
        self.assertEqual(result, 0, report['errors'])
        self.assertEqual(actual, 120); self.assertEqual(closed, 1)
        self.assertGreaterEqual(report['traffic_duration_seconds'], 30)
        clock = report['traffic_clock']
        self.assertEqual(clock['nominal_deadline_monotonic'], nominal)
        self.assertEqual(clock['deadline_monotonic'], math.nextafter(nominal, math.inf))
        self.assertGreaterEqual(clock['finished_monotonic'], clock['deadline_monotonic'])
        self.assertEqual(report['traffic_duration_seconds'], clock['finished_monotonic'] - started)
        DEPLOYMENT.completion_gate(report)

    def test_pacing_overrun_to_nominal_endpoint_cannot_start_rounding_only_burst(self):
        for options, expected in [({'jump': 'nominal'}, 112), ({'startup_delay': 30}, 0)]:
            with self.subTest(options=options):
                result, report, closed, actual = self.clock_fixture(started=65510.001, **options)
                self.assertEqual(result, 1); self.assertFalse(report['passed'])
                self.assertEqual(actual, expected); self.assertEqual(report['counts']['bursts'], expected // 8)
                self.assertEqual(report['counts']['contacts'], expected); self.assertEqual(closed, 1)
                self.assertGreaterEqual(report['traffic_duration_seconds'], 30)
                self.assertEqual(report['traffic_clock']['finished_monotonic'], report['traffic_clock']['deadline_monotonic'])
                self.assertIn('contacts coverage', report['errors'][0]['message'])

    def test_eight_hour_arithmetic_and_unrepresentable_deadlines_fail_closed(self):
        started = 50000.001
        nominal = started + 28800
        self.assertEqual(nominal - started, 28799.999999999993)
        deadline = DEPLOYMENT.duration_deadline(started, 28800)
        self.assertEqual(deadline, math.nextafter(nominal, math.inf))
        self.assertGreaterEqual(deadline - started, 28800)
        for start, duration in [(float('inf'), 30), (0, float('nan')), (True, 30),
                                (0, 0), (1e308, 1e308), (float.fromhex('0x1.fffffffffffffp+1023'), 1)]:
            with self.subTest(start=start, duration=duration), self.assertRaises(AssertionError):
                DEPLOYMENT.duration_deadline(start, duration)

    def test_fractional_burst_intervals_do_not_add_an_extra_terminal_burst(self):
        for started, duration, rate, expected in [(0, 1, 80, 80), (65510.001, 1, 80, 80),
                                                   (65510.001, 30, 40, 1200)]:
            with self.subTest(started=started, duration=duration, rate=rate):
                result, report, closed, actual = self.clock_fixture(started=started, duration=duration, rate=rate)
                self.assertEqual(result, 0, report['errors'])
                self.assertEqual(actual, expected)
                self.assertEqual(report['counts']['contacts'], expected)
                self.assertEqual(report['counts']['bursts'], expected // 8)
                self.assertEqual(closed, 1)
                self.assertGreaterEqual(report['traffic_duration_seconds'], duration)

    def test_truly_short_absolute_finish_cannot_be_hidden_by_duration_field(self):
        report = self.complete_report()
        report['traffic_clock']['finished_monotonic'] = math.nextafter(30, -math.inf)
        with self.assertRaisesRegex(AssertionError, 'before its deadline'):
            DEPLOYMENT.completion_gate(report)
        report = self.complete_report(); report.pop('traffic_clock')
        with self.assertRaisesRegex(AssertionError, 'absolute traffic clock evidence'):
            DEPLOYMENT.completion_gate(report)

    def test_health_latency_does_not_accumulate_probe_phase_drift(self):
        result, report, closed, actual = self.clock_fixture(duration=120, health_delay=.01, startup_delay=3)
        self.assertEqual(result, 0, report['errors'])
        self.assertEqual(report['counts']['health_checks'], 12)
        self.assertGreaterEqual(actual, 456); self.assertEqual(closed, 1)
        DEPLOYMENT.completion_gate(report)

    def test_contention_phase_survives_burst_lattice_latency_and_restarts(self):
        for latency, restart, startup in [(0, 180, 0), (.01, 5, .1)]:
            with self.subTest(latency=latency, restart=restart):
                actual_counts = {}
                result, report, closed, actual = self.clock_fixture(
                    duration=20, contention_seconds=3, contention_delay=latency,
                    restart_seconds=restart, startup_delay=startup, actual_counts=actual_counts)
                self.assertEqual(result, 0, report['errors']); self.assertTrue(report['passed'])
                self.assertGreaterEqual(actual_counts['locks'], 6)
                self.assertEqual(report['counts']['contention_503'], actual_counts['locks'])
                self.assertEqual(actual, 80)
                self.assertEqual(closed, report['counts']['hosts_started'])
                if restart == 5: self.assertGreaterEqual(closed, 3)
                DEPLOYMENT.completion_gate(report)

    def test_slow_contention_probe_does_not_manufacture_missed_slot_credits(self):
        actual_counts = {}
        result, report, closed, actual = self.clock_fixture(
            duration=20, contention_seconds=3, contention_delay=7, actual_counts=actual_counts)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertLess(actual_counts['locks'], 6)
        self.assertEqual(report['counts']['contention_503'], actual_counts['locks'])
        self.assertEqual(actual, report['counts']['contacts']); self.assertEqual(closed, 1)

    def test_periodic_probe_skips_missed_slots_without_catchup_credit(self):
        self.assertEqual(DEPLOYMENT.next_periodic_deadline(0, 10, .01), 10)
        self.assertEqual(DEPLOYMENT.next_periodic_deadline(10, 10, 35), 40)
        self.assertEqual(DEPLOYMENT.next_periodic_deadline(10, 10, 40), 50)
        result, report, closed, actual = self.clock_fixture(duration=120, health_delay=21)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertLess(report['counts']['health_checks'], 11)
        self.assertEqual(closed, 1)
        self.assertEqual(actual, report['counts']['contacts'])

    def test_failed_health_probe_never_receives_success_credit(self):
        result, report, closed, actual = self.clock_fixture(health_fail_at=2)
        self.assertEqual(result, 1); self.assertFalse(report['passed'])
        self.assertEqual(report['counts']['health_checks'], 0)
        self.assertIn('health probe failed', report['errors'][0]['message'])
        self.assertEqual(closed, 1); self.assertEqual(actual, 0)

    def test_current_completion_gate_rejects_missing_or_low_aggregate_coverage(self):
        accepted = self.complete_report(); accepted['counts']['contacts'] = 114
        DEPLOYMENT.completion_gate(accepted)
        for key, value in [('contacts', 113), ('health_checks', 2), ('contacts', True)]:
            report = self.complete_report(); report['counts'][key] = value
            with self.subTest(key=key, value=value), self.assertRaisesRegex(AssertionError, 'coverage'):
                DEPLOYMENT.completion_gate(report)
        report = self.complete_report(); report['counts'].pop('contention_503')
        with self.assertRaisesRegex(AssertionError, 'coverage'):
            DEPLOYMENT.completion_gate(report)

    def test_planned_pacing_above_limit_is_rejected_before_host_launch(self):
        with self.assertRaisesRegex(AssertionError, 'planned pacing exceeds'):
            self.clock_fixture(rate=.1)

    def test_explicit_larger_gap_allows_documented_slow_pacing(self):
        result, report, closed, actual = self.clock_fixture(duration=120, rate=.1, max_gap_seconds=90)
        self.assertEqual(result, 0); self.assertTrue(report['passed'])
        self.assertEqual(report['configuration']['max_gap_seconds'], 90)
        self.assertEqual(actual, 16); self.assertEqual(closed, 1)
        self.assertEqual(report['counts']['health_checks'], 12)
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
