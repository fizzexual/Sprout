"""Reporting/resource gate regressions without starting another HTTP workload."""
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('deployment_soak', ROOT / 'tools/deployment_soak.py')
DEPLOYMENT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOYMENT)


class DeploymentHarnessTests(unittest.TestCase):
    def setUp(self):
        self.summary = dict(samples=20, clean_shutdown=True, baseline_threads=1, final_threads=1,
                            native_started=8, native_exited=8, native_active_pids=[], maximum_native_active=4,
                            initial=dict(rss_bytes=100, handles=10, open_fds=5, threads=1),
                            last=dict(rss_bytes=150, handles=12, open_fds=6, threads=1),
                            host_sampled_maximum=dict(rss_bytes=180, handles=20, open_fds=10, threads=15))
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
                      configuration=dict(duration_seconds=30), frozen_inputs_unchanged=True)
        DEPLOYMENT.completion_gate(report)
        for key, value in [('workload_completed', False), ('traffic_duration_seconds', 29.9),
                           ('frozen_inputs_unchanged', False)]:
            incomplete = dict(report); incomplete[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                DEPLOYMENT.completion_gate(incomplete)

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

    def test_interruption_preserves_failed_report(self):
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
                                   seed=1, label='interrupt-regression', workspace=fixture / 'run', report=report)
            with patch.object(DEPLOYMENT, 'ROOT', fixture), patch.object(DEPLOYMENT, 'Service', side_effect=KeyboardInterrupt), redirect_stdout(io.StringIO()):
                result = DEPLOYMENT.main(args)
            saved = json.loads(report.read_text(encoding='utf-8'))
            self.assertEqual(result, 1)
            self.assertEqual(saved['state'], 'finished')
            self.assertFalse(saved['passed'])
            self.assertFalse(saved['workload_completed'])
            self.assertEqual(saved['errors'][0]['type'], 'KeyboardInterrupt')


if __name__ == '__main__':
    unittest.main()
