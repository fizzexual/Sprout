"""Bounded independent fixtures for retrospective aggregate coverage qualification."""
from contextlib import redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('deployment_coverage', ROOT / 'tools/deployment_coverage.py')
COVERAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COVERAGE)


def complete(contacts=115200, health=2880, contention=480, ambiguous=0):
    bursts = contacts // 8
    duplicates = bursts // 15
    oracle = 320 + duplicates
    native = contacts + oracle + duplicates + contention + ambiguous
    shard_count = (contacts + 1999) // 2000
    hosts = []
    for index in range(160):
        hosts.append(dict(pid=10000 + index, samples=1800, epoch_seconds=180,
                          shard=index * shard_count // 160,
                          initial=dict(rss_bytes=32000000, handles=140, threads=1),
                          last=dict(rss_bytes=40000000, handles=180, threads=1),
                          host_sampled_maximum=dict(rss_bytes=45000000, handles=220, threads=12),
                          native_started=native // 160 + int(index < native % 160),
                          native_exited=native // 160 + int(index < native % 160),
                          native_active_pids=[], maximum_native_active=4, errors=[],
                          baseline_threads=1, final_threads=1, clean_shutdown=True))
    return dict(state='finished', passed=True, workload_completed=True, frozen_inputs_unchanged=True,
                errors=[], active_host_pid=None, platform='Windows-10-10.0.19045-SP0',
                timestamp_utc='2026-10-11T20:14:00+00:00',
                latency_clock=dict(name='perf_counter', implementation='QueryPerformanceCounter()', resolution_seconds=1e-7),
                configuration=dict(duration_seconds=28800.0, rate=4.0, clients=8, workers=4, burst=8,
                                   restart_seconds=180.0, contention_seconds=60.0, shard_contacts=2000),
                frozen_sha256={name: 'a' * 64 for name in COVERAGE.POLICY['frozen_files']},
                resource_limits=copy.deepcopy(COVERAGE.POLICY['resource_limits']),
                storage_limits=copy.deepcopy(COVERAGE.POLICY['storage_limits']),
                storage_observation=dict(workspace_bytes=8000000, report_bytes=100000),
                elapsed_seconds=28801.0, traffic_duration_seconds=28800.0,
                counts=dict(contacts=contacts, bursts=bursts, health_checks=health, oracle_checks=oracle,
                            contention_503=contention, duplicate_409=duplicates, ambiguous_commits=ambiguous,
                            hosts_started=160, hosts_cleanly_stopped=160),
                post_status_counts={'201': contacts - ambiguous, **({'409': ambiguous} if ambiguous else {})},
                transport_errors={'ConnectionResetError': ambiguous} if ambiguous else {},
                logical_contact_latency_ms=dict(samples=contacts, p50=40, p95=90, maximum=1000),
                post_attempt_latency_ms=dict(samples=contacts + ambiguous, p50=40, p95=90, maximum=1000),
                hosts=hosts, shards=[dict(shard=index, verified_contacts=min(2000, contacts - index * 2000), integrity='ok')
                                     for index in range(shard_count)])


def audit(report, workspace=None):
    raw = json.dumps(report).encode('utf-8')
    return COVERAGE.qualify(report, hashlib.sha256(raw).hexdigest(), len(raw), workspace)


class CoverageTests(unittest.TestCase):
    def test_healthy_complete_and_reconciled_ambiguous_writes_qualify(self):
        for report in (complete(), complete(ambiguous=8)):
            with self.subTest(ambiguous=report['counts']['ambiguous_commits']):
                result = audit(report)
                self.assertEqual(result['status'], 'qualified', result)
                self.assertIs(result['passed'], True)
                self.assertFalse(result['observations']['frozen_files_verified'])

    def test_policy_identity_remains_the_predeclared_policy(self):
        self.assertEqual(COVERAGE.POLICY_SHA256, 'e0fa18931226ba2c181d2700dea0da3e91fc9cba878c551232298cb9342bd0ee')
        self.assertEqual(COVERAGE.POLICY['declared_utc'], '2026-10-11T21:41:33+00:00')
        self.assertEqual(COVERAGE.POLICY_V1_SHA256, '2996d5d90a400bfaae6dfd059551f7924201db95d7731d4f678b90eb98c36d65')
        self.assertEqual(COVERAGE.POLICY_V1['declared_utc'], '2026-10-11T21:32:18+00:00')
        self.assertEqual(COVERAGE.POLICY['supersedes_policy_sha256'], COVERAGE.POLICY_V1_SHA256)

    def test_short_epochs_cannot_make_sample_coverage_vacuous(self):
        report = complete()
        for host in report['hosts']: host.update(epoch_seconds=59, samples=1)
        result = audit(report)
        self.assertEqual(result['status'], 'insufficient_coverage', result)
        self.assertTrue({'aggregate_epoch_coverage', 'aggregate_sample_coverage'} <=
                        {issue['code'] for issue in result['issues']})

    def test_aggregate_exposure_floor_and_recorded_traffic_sample_denominator(self):
        report = complete()
        for host in report['hosts']: host.update(epoch_seconds=171, samples=1710)
        self.assertEqual(audit(report)['status'], 'qualified')  # 27,360 seconds = 95%.
        report['hosts'][0]['epoch_seconds'] = 170.999
        result = audit(report)
        self.assertEqual(result['status'], 'insufficient_coverage')
        self.assertEqual({issue['code'] for issue in result['issues']}, {'aggregate_epoch_coverage'})
        report = complete()
        for host in report['hosts']: host['samples'] = 1530
        report.update(traffic_duration_seconds=28800.1, elapsed_seconds=28802)
        result = audit(report)
        self.assertEqual(result['status'], 'insufficient_coverage')
        self.assertEqual({issue['code'] for issue in result['issues']}, {'aggregate_sample_coverage'})

    def test_old_clock_advance_false_pass_with_only_eight_contacts_is_rejected(self):
        report = complete()
        report['hosts'] = [report['hosts'][0]]
        report['hosts'][0].update(samples=2, epoch_seconds=28801, native_started=11, native_exited=11, maximum_native_active=1)
        report['elapsed_seconds'] = 28802
        report['counts'] = dict(contacts=8, bursts=1, health_checks=1, oracle_checks=2, contention_503=1,
                                duplicate_409=0, ambiguous_commits=0, hosts_started=1, hosts_cleanly_stopped=1)
        report['post_status_counts'] = {'201': 8}
        report['logical_contact_latency_ms']['samples'] = report['post_attempt_latency_ms']['samples'] = 8
        report['shards'] = [dict(shard=0, verified_contacts=8, integrity='ok')]
        result = audit(report)
        self.assertEqual(result['status'], 'insufficient_coverage', result)
        self.assertIs(result['passed'], False)
        self.assertTrue({'traffic_coverage', 'health_coverage', 'contention_coverage', 'sample_coverage', 'epoch_duration'} <=
                        {issue['code'] for issue in result['issues']})

    def test_inclusive_floors_and_just_below_each_floor(self):
        accepted = complete(contacts=109440, health=2592, contention=432)
        for host in accepted['hosts']: host['samples'] = 1530
        self.assertEqual(audit(accepted)['status'], 'qualified')
        cases = [(complete(contacts=109432), 'traffic_coverage'),
                 (complete(health=2591), 'health_coverage'),
                 (complete(contention=431), 'contention_coverage')]
        sampled = complete(); sampled['hosts'][0]['samples'] = 1529
        cases.append((sampled, 'sample_coverage'))
        for report, code in cases:
            with self.subTest(code=code):
                result = audit(report)
                self.assertEqual(result['status'], 'insufficient_coverage', result)
                self.assertIn(code, {issue['code'] for issue in result['issues']})

    def test_epoch_bound_inclusive_and_over_limit(self):
        report = complete(); report['hosts'][0].update(epoch_seconds=240, samples=2400); report['elapsed_seconds'] += 60
        self.assertEqual(audit(report)['status'], 'qualified')
        report['hosts'][0].update(epoch_seconds=240.001, samples=2401); report['elapsed_seconds'] += 1
        self.assertEqual(audit(report)['issues'][0]['code'], 'epoch_duration')

    def test_missing_counts_clock_and_resource_metrics_fail_closed(self):
        mutations = [lambda r: r['counts'].pop('health_checks'), lambda r: r.pop('latency_clock'),
                     lambda r: r['latency_clock'].pop('resolution_seconds'),
                     lambda r: r['hosts'][0]['last'].pop('handles'), lambda r: r.pop('active_host_pid')]
        for mutate in mutations:
            report = complete(); mutate(report)
            self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_bool_float_and_nonfinite_metrics_are_rejected(self):
        mutations = [lambda r: r['counts'].update(contacts=True), lambda r: r['hosts'][0].update(samples=1800.0),
                     lambda r: r['hosts'][0].update(native_exited=True), lambda r: r['configuration'].update(clients=8.0),
                     lambda r: r['hosts'][0]['last'].update(rss_bytes=float('inf')),
                     lambda r: r['latency_clock'].update(resolution_seconds=float('nan')),
                     lambda r: r['configuration'].update(duration_seconds=True)]
        for mutate in mutations:
            report = complete(); mutate(report)
            self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_full_profile_and_resource_ceiling_changes_are_rejected(self):
        for key in COVERAGE.POLICY['configuration']:
            report = complete(); report['configuration'][key] += 1
            with self.subTest(key=key): self.assertEqual(audit(report)['status'], 'invalid_report')
        report = complete(); report['platform'] = 'Linux-test'
        self.assertEqual(audit(report)['status'], 'invalid_report')
        report = complete(); report['resource_limits']['rss_peak_bytes'] *= 2
        self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_lifecycle_counts_storage_and_verified_records_must_match(self):
        mutations = [lambda r: r['counts'].update(hosts_cleanly_stopped=159),
                     lambda r: r['counts'].update(hosts_started=161),
                     lambda r: r['hosts'][0].update(native_exited=0),
                     lambda r: r['hosts'][0].update(native_active_pids=[42]),
                     lambda r: r['hosts'][0].update(maximum_native_active=5),
                     lambda r: r['hosts'][0].update(final_threads=2),
                     lambda r: r['hosts'][0].update(clean_shutdown=1),
                     lambda r: r['hosts'][0].update(errors=['sampler failed']),
                     lambda r: r['storage_observation'].update(workspace_bytes=268435457),
                     lambda r: r['storage_observation'].update(report_bytes=4194305),
                     lambda r: r['hosts'][0]['host_sampled_maximum'].update(handles=513),
                     lambda r: r['shards'][0].update(integrity='failed'),
                     lambda r: r['shards'][-1].update(verified_contacts=1199),
                     lambda r: r['counts'].update(oracle_checks=0),
                     lambda r: r['logical_contact_latency_ms'].update(samples=1),
                     lambda r: r['post_attempt_latency_ms'].update(p95=2000)]
        for mutate in mutations:
            report = complete(); mutate(report)
            self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_completion_and_duration_flags_cannot_be_substituted(self):
        for key, value in [('state', 'interrupted'), ('passed', 1), ('workload_completed', False),
                           ('frozen_inputs_unchanged', False), ('traffic_duration_seconds', 28799),
                           ('elapsed_seconds', 28000), ('stop_requested', True), ('active_host_pid', 42)]:
            report = complete(); report[key] = value
            with self.subTest(key=key): self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_running_snapshots_are_pending_never_complete_qualification(self):
        report = complete(); report.update(state='running', passed=None, workload_completed=False)
        report.pop('frozen_inputs_unchanged'); report.pop('traffic_duration_seconds')
        report['counts']['hosts_started'] += 1; report['active_host_pid'] = 999
        result = audit(report)
        self.assertEqual(result['status'], 'pending', result)
        self.assertIsNone(result['passed'])
        report['hosts'][0]['samples'] = 1
        self.assertIsNone(audit(report)['passed'])
        report['passed'] = True
        self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_fixed_frozen_inventory_and_explicit_workspace_hash_verification(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); report = complete()
            report['workspace'] = 'report-supplied-path-must-not-be-used'
            for relative in COVERAGE.POLICY['frozen_files']:
                path = root / 'frozen' / relative; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'bounded fixture, never executed\n')
                report['frozen_sha256'][relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(audit(report, root)['status'], 'qualified')
            self.assertTrue(audit(report, root)['observations']['frozen_files_verified'])
            (root / 'frozen/bin/sprout.exe').write_bytes(b'changed')
            self.assertEqual(audit(report, root)['status'], 'invalid_report')
            report['frozen_sha256']['../outside'] = 'a' * 64
            self.assertEqual(audit(report)['status'], 'invalid_report')

    def test_strict_input_json_and_size_boundaries(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'report.json'
            for raw in (b'{"a":1,"\\u0061":2}', b'{"a":NaN}', b'{"a":1e999}', b'{"a":"\xff"}', b'[]'):
                path.write_bytes(raw)
                with self.subTest(raw=raw), self.assertRaises(COVERAGE.InvalidReport): COVERAGE.read_report(path)
            valid = json.dumps(complete()).encode()
            path.write_bytes(valid + b' ' * (4194304 - len(valid)))
            _, digest, size = COVERAGE.read_report(path)
            self.assertEqual(size, 4194304); self.assertEqual(digest, hashlib.sha256(path.read_bytes()).hexdigest())
            with path.open('ab') as source: source.write(b' ')
            with self.assertRaises(COVERAGE.InvalidReport): COVERAGE.read_report(path)

    def test_symlink_report_and_frozen_components_are_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); original = root / 'original.json'; original.write_text('{}')
            link = root / 'link.json'
            try: link.symlink_to(original)
            except OSError: self.skipTest('symlink creation unavailable')
            with self.assertRaises(COVERAGE.InvalidReport): COVERAGE.read_report(link)
            (root / 'actual').mkdir(); (root / 'frozen').symlink_to(root / 'actual', target_is_directory=True)
            self.assertEqual(audit(complete(), root)['status'], 'invalid_report')

    def test_cli_preserves_original_and_uses_distinct_exit_for_pending(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); source = root / 'report.json'; output = root / 'qualification.json'
            raw = json.dumps(complete()).encode(); source.write_bytes(raw)
            with redirect_stdout(io.StringIO()): result = COVERAGE.main([str(source), '--output', str(output)])
            self.assertEqual(result, 0); self.assertEqual(source.read_bytes(), raw)
            saved = json.loads(output.read_text()); self.assertEqual(saved['report_sha256'], hashlib.sha256(raw).hexdigest())
            with redirect_stdout(io.StringIO()): self.assertEqual(COVERAGE.main([str(source), '--output', str(source)]), 1)
            self.assertEqual(source.read_bytes(), raw)
            with redirect_stdout(io.StringIO()): self.assertEqual(COVERAGE.main([str(source), '--output', str(output)]), 1)
            pending = complete(); pending.update(state='running', passed=None, workload_completed=False)
            source.write_text(json.dumps(pending))
            with redirect_stdout(io.StringIO()): result = COVERAGE.main([str(source), '--output', str(root / 'pending.json')])
            self.assertEqual(result, 2); self.assertIsNone(json.loads((root / 'pending.json').read_text())['passed'])


if __name__ == '__main__':
    unittest.main()
