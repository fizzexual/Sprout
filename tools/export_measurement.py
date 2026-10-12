"""Verify a pinned completed experiment; explicitly export new derived public bytes."""
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
from pathlib import Path

import measure_workloads as m
import measurement_fixtures as w


def verify_node_packet(value, row, expected):
    m.require(type(value) is dict and value.get('ok') is True and value.get('id') == row['id'] and value.get('start_ns') == row['start_ns'] and value.get('end_ns') == row['end_ns'] and
              value.get('elapsed_ns') == str(row['elapsed_ns']) and w.strict_equal(value.get('result'), expected), 'oracle', 'Node packet/result differs')


def read_artifact(root, item, remaining):
    m.require(type(item) is dict and set(item) == {'name', 'bytes', 'sha256'} and type(item['bytes']) is int and
              0 <= item['bytes'] <= 262144 and m.digest_text(item['sha256']), 'artifact', 'Artifact metadata malformed')
    m.require(type(remaining) is int and remaining >= item['bytes'], 'artifact', 'Artifact exceeds remaining capture read credit')
    name = item['name']
    m.require(type(name) is str and name and Path(name).name == name and not any(c in name for c in ('/', '\\', ':')),
              'artifact', 'Artifact name is not a basename')
    path = m.inventory_path(root, name)
    digest, value = m.bounded_file(path, item['bytes'], True, expected_size=item['bytes'])
    m.require(digest == item['sha256'], 'artifact', 'Raw artifact changed')
    return value


def verify_report(report_dir, report_pin, snapshot, manifest_pin, review_file, review_pin):
    root, snapshot = Path(report_dir).resolve(), Path(snapshot).resolve()
    report = m.pinned_json(root / 'report.json', report_pin, m.BOUNDS['report_bytes'])
    manifest = m.pinned_json(snapshot / 'manifest.json', manifest_pin)
    # Legacy B5 is the already completed experiment, never silently relabeled v2.
    if manifest.get('schema') == 'sprout.finite-measurement-preparation.v1':
        files = manifest.get('files')
        m.verify_inventory(snapshot, files)
        m.require(files.get(manifest['native']) == manifest['native_sha256'] and m.bounded_sha(manifest['compiler'], m.INPUT_BOUNDS['native_compiler_bytes']) == manifest['compiler_sha256'], 'identity', 'Legacy native/compiler identity differs')
        generator = 'controller/workloads.py'; controller = 'controller/measure_pure.py'
    else:
        manifest = m.verify_manifest(snapshot, manifest_pin)
        generator = 'controller/measurement_fixtures.py'; controller = 'controller/measure_workloads.py'
    m.require(manifest['files'].get(generator) == m.sha(Path(w.__file__)), 'fixture_identity', 'Independent fixture model bytes differ')
    review = m.pinned_json(review_file, review_pin)
    m.require(review.get('passed') is True and review.get('report_sha256') == report_pin and review.get('manifest_sha256') == manifest_pin,
              'review', 'Independent review does not pass for these exact records')
    m.require(report.get('complete') is True and report.get('error') is None and report.get('execution_mode') == 'measurement' and report.get('measurements_performed') is True,
              'incomplete', 'Only a complete actual measurement may be exported')
    m.require(type(report.get('launch_reservations')) is int and report['launch_reservations'] == 204 and type(report.get('launch_ceiling')) is int and report['launch_ceiling'] == 208,
              'count', 'Unexpected reservations/ceiling')
    m.require(report['manifest_sha256'] == manifest_pin and report['native']['sha256'] == manifest['native_sha256'] and report['native']['revision'] == manifest['revision'],
              'identity', 'Report candidate differs from snapshot')
    rows = report.get('rows'); m.require(type(rows) is list and len(rows) == 204, 'count', 'Exactly204 rows required')
    artifacts = {}; total = 0; read_total = 0
    def raw(item):
        nonlocal total, read_total
        value = read_artifact(root, item, 136314880 - read_total)
        read_total += len(value)
        m.require(read_total <= 136314880, 'artifact', 'Aggregate actual raw reads exceed fixed cap')
        name = item['name']
        if name not in artifacts:
            artifacts[name] = item; total += len(value)
            m.require(total <= 136314880, 'artifact', 'Aggregate raw capture exceeds fixed208-call maximum')
        return value
    pure, sdk = w.fixtures(), w.sdk_fixtures()
    for key, fixture in pure.items():
        m.require(m.bounded_file(snapshot / ('fixtures/' + key + '.json'), m.BOUNDS['fixture_bytes'], True)[1] == w.compact(fixture), 'fixture_identity', 'Frozen fixture model differs')
        for mode in ('full', 'control'):
            m.require(m.bounded_file(snapshot / ('drivers/' + key + '-' + mode + '.sprout'), m.BOUNDS['fixture_bytes'], True)[1] == w.prepared_source(fixture, mode).encode('utf-8'), 'fixture_identity', 'Frozen driver differs')
    m.require(m.bounded_file(snapshot / 'fixtures/sdk.json', m.BOUNDS['fixture_bytes'], True)[1] == w.compact(sdk) and m.bounded_json(snapshot / 'schedule.json') == w.schedule(), 'fixture_identity', 'SDK fixture/schedule differs')
    for planned, row in zip(w.schedule(), rows):
        m.require(type(row) is dict and all(w.strict_equal(row.get(key), value) for key, value in planned.items()), 'schedule', 'Row identity/order differs')
        m.require(type(row.get('elapsed_ns')) is int and row['elapsed_ns'] >= 0 and all(type(row.get(key)) is str and row[key].isascii() and row[key].isdigit() for key in ('start_ns', 'end_ns')) and
                  int(row['end_ns']) - int(row['start_ns']) == row['elapsed_ns'], 'clock', 'Raw timing differs')
        output = raw(row['output_artifact']); value = m.strict_json(output)
        if row['kind'] == 'prepared':
            m.require(w.strict_equal(value, {'result': pure[row['id']]['expected'], 'unchanged': True}), 'oracle', 'Prepared output differs')
            cleanup = row['cleanup']
            m.require(cleanup.get('confirmed') is True and cleanup.get('direct_reaped') is True and cleanup.get('readers_joined') is True and type(cleanup.get('exit_code')) is int and cleanup['exit_code'] == 0 and cleanup.get('cleanup_errors') == [], 'cleanup', 'Prepared cleanup unconfirmed')
            stdout = raw(row['stdout_artifact']); stderr = raw(row['stderr_artifact'])
            m.require(stdout.splitlines() == [b'READY', b'DONE', output] and stderr == b'' and type(row.get('stdout_received_bytes')) is int and row['stdout_received_bytes'] == len(stdout) and
                      type(row.get('stderr_received_bytes')) is int and row['stderr_received_bytes'] == 0, 'framing', 'Raw protocol/capture differs')
            for key in ('memory_ready', 'memory_done'): m.check_memory(row[key])
        elif row['sdk'] == 'python': m.require(w.strict_equal(value, sdk[row['id']]['expected']), 'oracle', 'Python output differs')
        else:
            verify_node_packet(value, row, sdk[row['id']]['expected'])
    m.require(set(report['sdk_setup']) == {'python', 'node'}, 'cleanup', 'SDK group evidence missing')
    for setup in report['sdk_setup'].values():
        m.require(setup['cleanup'].get('confirmed') is True and setup['child_peak'].get('available') is False and setup['child_peak'].get('value') is None, 'cleanup', 'SDK completion/unavailable-native-peak differs')
        for key in ('stdout_artifact', 'stderr_artifact'):
            if key in setup['cleanup']: raw(setup['cleanup'][key])
    node = report['sdk_setup']['node']['cleanup']
    m.require(node.get('job_empty') is True and node.get('tree_confirmed') is True and node.get('direct_reaped') is True and node.get('readers_joined') is True and node.get('exit_code') == 0 and node.get('cleanup_errors') == [] and node.get('stderr_received_bytes') == 0,
              'cleanup', 'Node parent/job evidence incomplete')
    m.require(w.strict_equal(report['summary'], m.summary(rows)), 'summary', 'Five raw sample summaries differ')
    return report, manifest, artifacts, total, controller


def public_record(report, manifest, artifacts, controller, report_pin, manifest_pin, review_pin):
    # All measured fields are conserved except machine-local source paths/PIDs.
    allowed = {'kind', 'id', 'sdk', 'sample', 'mode', 'warmup', 'launch_reservation', 'batch', 'source_sha256', 'spawn_returned', 'spawn_start_ns', 'ready_ns',
        'timing_scope', 'clock_provider', 'clock_resolution_ns', 'clock_resolution_reason', 'insufficient_timing_scale',
        'start_ns', 'end_ns', 'elapsed_ns', 'memory_ready', 'memory_done', 'cleanup', 'cleanup_scope', 'stdout_received_bytes', 'stderr_received_bytes',
        'stdout_artifact', 'stderr_artifact', 'output_artifact', 'output_bytes', 'output_sha256'}
    rows = [{key: value for key, value in row.items() if key in allowed} for row in report['rows']]
    sdk = {name: {key: value for key, value in setup.items() if key in {'setup_start_ns', 'ready_ns', 'executable_sha256', 'parent_memory_before', 'parent_memory_after', 'child_peak', 'cleanup'}}
           for name, setup in report['sdk_setup'].items()}
    def safe_metrics(value):
        if type(value) is dict:
            if value.get('available') is False and 'reason' in value: value['reason'] = 'provider_unavailable_for_this_metric'
            for item in value.values(): safe_metrics(item)
        elif type(value) is list:
            for item in value: safe_metrics(item)
    # Work on a detached JSON copy; the parsed source and actual file never mutate.
    result = m.strict_json(w.compact({'schema': 'sprout.library-workloads-derived-observation.v1', 'derived': True,
        'original_report_sha256': report_pin, 'original_manifest_sha256': manifest_pin, 'independent_review_sha256': review_pin,
        'candidate': {'revision': manifest['revision'], 'native_sha256': manifest['native_sha256'], 'compiler_sha256': manifest['compiler_sha256'],
                      'build_sha256': manifest['build_sha256'], 'ci_sha256': manifest['ci_sha256'], 'controller_sha256': manifest['files'][controller]},
        'complete': True, 'launch_reservations': 204, 'launch_ceiling': 208, 'rows': rows, 'summary': report['summary'], 'sdk_setup': sdk,
        'raw_artifacts': list(artifacts.values()), 'utc_started': report['utc_started'], 'utc_finished': report['utc_finished'],
        'clock_boundary': report['deadline_boundary'], 'host': {key: value for key, value in report['host'].items() if key in {'os', 'machine', 'cpu_identifier', 'logical_cpus', 'physical_ram_bytes', 'physical_ram_provider'}},
        'python': {key: value for key, value in report['python'].items() if key in {'sha256', 'version', 'bits'}},
        'scope': 'One finite synthetic Windows normal-collector observation; no ranking/SLA/general production/8h qualification',
        'privacy_transform': 'Machine-local executable/source paths and ephemeral PIDs omitted; unavailable diagnostic reason text replaced by a fixed category; timings/warmups/five samples preserved',
        'raw_capture_location': 'Original separately pinned private report; hashes verified, raw bodies not embedded or automatically published'}))
    safe_metrics(result)
    m.require(len(w.compact(result)) <= 2097152, 'export_size', 'Derived export exceeds2MiB')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True); parser.add_argument('--report-sha256', required=True)
    parser.add_argument('--snapshot', type=Path, required=True); parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--review', type=Path, required=True); parser.add_argument('--review-sha256', required=True)
    parser.add_argument('--export', type=Path)
    args = parser.parse_args(argv)
    report, manifest, artifacts, total, controller = verify_report(args.report, args.report_sha256, args.snapshot, args.manifest_sha256, args.review, args.review_sha256)
    if args.export is None:
        print('Completed experiment verified read-only; no export written.'); return 0
    derived = public_record(report, manifest, artifacts, controller, args.report_sha256, args.manifest_sha256, args.review_sha256)
    with args.export.open('xb') as stream: stream.write(w.compact(derived))
    print(m.sha(args.export, m.BOUNDS['report_bytes'])); return 0


if __name__ == '__main__': raise SystemExit(main())
