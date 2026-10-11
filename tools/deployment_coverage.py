"""Independent aggregate-coverage qualification for the frozen Windows eight-hour profile."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import stat


POLICY_V1 = {
    'schema': 1,
    'id': 'windows-http-sqlite-eight-hour-coverage-v1',
    'declared_utc': '2026-10-11T21:32:18+00:00',
    'configuration': {
        'duration_seconds': 28800, 'rate': 4, 'clients': 8, 'workers': 4,
        'burst': 8, 'restart_seconds': 180, 'contention_seconds': 60,
        'shard_contacts': 2000,
    },
    'floors': {
        'contacts_percent_of_requested_target': 95,
        'health_percent_of_floor_requested_per_10_seconds': 90,
        'contention_percent_of_floor_requested_per_contention_interval': 90,
        'resource_samples_percent_of_epoch_per_0_1_seconds': 85,
        'resource_sample_floor_minimum_epoch_seconds': 60,
    },
    'maximum_closed_epoch_seconds': 240,
    'resource_limits': {
        'rss_peak_bytes': 134217728, 'rss_retained_growth_bytes': 67108864,
        'handles_peak': 512, 'handles_retained_growth': 128,
        'open_fds_peak': 128, 'open_fds_retained_growth': 32,
    },
    'storage_limits': {'workspace_bytes': 268435456, 'report_bytes': 4194304},
    'frozen_files': [
        'bin/sprout.exe', 'tools/deployment_soak.py',
        'integrations/python/sprout_host.py', 'integrations/python/sprout_service.py',
        'examples/services/contacts.sprout',
    ],
    'input_max_bytes': 4194304,
    'frozen_file_max_bytes': 67108864,
    'scope': 'Aggregate coverage and recorded lifecycle/resource/integrity checks; '
             'cannot certify maximum traffic gaps, uninterrupted uptime, authenticity, '
             'or unsampled resource peaks.',
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True, allow_nan=False).encode('utf-8')


POLICY_V1_SHA256 = hashlib.sha256(canonical(POLICY_V1)).hexdigest()
POLICY = {
    **POLICY_V1,
    'id': 'windows-http-sqlite-eight-hour-coverage-v2',
    'declared_utc': '2026-10-11T21:41:33+00:00',
    'supersedes_policy_sha256': POLICY_V1_SHA256,
    'floors': {
        **POLICY_V1['floors'],
        'aggregate_closed_epoch_percent_of_traffic_duration': 95,
        'aggregate_samples_percent_of_traffic_per_0_1_seconds': 85,
    },
}
POLICY_SHA256 = hashlib.sha256(canonical(POLICY)).hexdigest()


class InvalidReport(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise InvalidReport(message)


def mapping(value, name):
    need(type(value) is dict, name + ' must be an object')
    return value


def integer(value, name, minimum=0):
    need(type(value) is int and value >= minimum, name + ' must be an integer >= ' + str(minimum))
    return value


def number(value, name, positive=False):
    need(type(value) in (int, float), name + ' must be a finite number')
    try:
        valid = math.isfinite(value)
    except OverflowError:
        valid = False
    need(valid and (value > 0 if positive else value >= 0), name + ' must be a finite ' + ('positive' if positive else 'nonnegative') + ' number')
    return value


def field(value, key, name):
    need(key in value, name + '.' + key + ' is missing')
    return value[key]


def text(value, name):
    need(type(value) is str and bool(value.strip()), name + ' must be nonempty text')
    return value


def empty_list(value, name):
    need(type(value) is list and not value, name + ' must be an empty list')


def finite_float(value):
    result = float(value)
    need(math.isfinite(result), 'JSON contains a non-finite number')
    return result


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'JSON contains a duplicate object key')
        result[key] = value
    return result


def reject_constant(value):
    raise InvalidReport('JSON contains a non-finite constant')


def open_regular(path, maximum):
    path = Path(path)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and not getattr(before, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT,
         'input must be a regular nonsymlink file')
    need(before.st_size <= maximum, 'input exceeds its byte cap')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        need(stat.S_ISREG(opened.st_mode) and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino),
             'input changed while opening or is not a regular file')
        return os.fdopen(descriptor, 'rb')
    except BaseException:
        os.close(descriptor)
        raise


def read_report(path):
    with open_regular(path, POLICY['input_max_bytes']) as source:
        raw = source.read(POLICY['input_max_bytes'] + 1)
    need(len(raw) <= POLICY['input_max_bytes'], 'report exceeds its byte cap')
    digest = hashlib.sha256(raw).hexdigest()
    try:
        report = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                            parse_float=finite_float, parse_constant=reject_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise InvalidReport('report is not strict UTF-8 finite JSON: ' + str(error)[:160]) from error
    return mapping(report, 'report'), digest, len(raw)


def frozen_check(workspace, hashes):
    # Never follow report['workspace'] or report-supplied relative paths.
    root = Path(workspace) / 'frozen'
    information = root.lstat()
    need(stat.S_ISDIR(information.st_mode) and not stat.S_ISLNK(information.st_mode)
         and not getattr(information, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT,
         'explicit workspace must have a nonsymlink frozen directory')
    root = root.resolve(strict=True)
    for relative in POLICY['frozen_files']:
        path = root
        for part in Path(relative).parts:
            path /= part
            information = path.lstat()
            need(not stat.S_ISLNK(information.st_mode) and not getattr(information, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT,
                 'frozen input path must not contain a symlink/reparse point')
        need(path.resolve(strict=True).is_relative_to(root), 'frozen input escapes the explicit frozen root')
        digest = hashlib.sha256()
        total = 0
        with open_regular(path, POLICY['frozen_file_max_bytes']) as source:
            for chunk in iter(lambda: source.read(65536), b''):
                total += len(chunk)
                need(total <= POLICY['frozen_file_max_bytes'], 'frozen input exceeds its byte cap')
                digest.update(chunk)
        need(digest.hexdigest() == hashes[relative], 'frozen SHA256 mismatch: ' + relative)


def count_map(value, name):
    value = mapping(value, name)
    for key, count in value.items():
        text(key, name + ' key')
        integer(count, name + '.' + key)
    return value


def latency(value, samples, name):
    value = mapping(value, name)
    need(integer(field(value, 'samples', name), name + '.samples') == samples, name + ' sample count mismatch')
    if samples:
        ordered = [number(field(value, key, name), name + '.' + key) for key in ('p50', 'p95', 'maximum')]
        need(ordered == sorted(ordered), name + ' percentiles are not ordered')


def inspect_metrics(report, raw_size, workspace, completed, failures):
    config = mapping(field(report, 'configuration', 'report'), 'configuration')
    for key, expected in POLICY['configuration'].items():
        observed = number(field(config, key, 'configuration'), 'configuration.' + key, True)
        need(observed == expected, 'configuration.' + key + ' does not match the fixed eight-hour profile')
        if key in ('clients', 'workers', 'burst', 'shard_contacts'):
            integer(observed, 'configuration.' + key, 1)
    need(text(field(report, 'platform', 'report'), 'platform').startswith('Windows-'), 'profile requires recorded Windows metrics')
    timestamp = datetime.fromisoformat(text(field(report, 'timestamp_utc', 'report'), 'timestamp_utc'))
    need(timestamp.tzinfo is not None and timestamp.utcoffset().total_seconds() == 0, 'timestamp_utc must be UTC with an explicit offset')
    clock = mapping(field(report, 'latency_clock', 'report'), 'latency_clock')
    need(field(clock, 'name', 'latency_clock') == 'perf_counter', 'latency clock must be perf_counter')
    text(field(clock, 'implementation', 'latency_clock'), 'latency_clock.implementation')
    need(number(field(clock, 'resolution_seconds', 'latency_clock'), 'latency_clock.resolution_seconds', True) <= 1,
         'latency clock resolution is invalid')
    hashes = mapping(field(report, 'frozen_sha256', 'report'), 'frozen_sha256')
    need(set(hashes) == set(POLICY['frozen_files']), 'frozen hash inventory must contain exactly the named profile files')
    for relative, digest in hashes.items():
        need(type(digest) is str and len(digest) == 64 and all(ch in '0123456789abcdef' for ch in digest), 'invalid frozen SHA256: ' + relative)
    if workspace is not None:
        frozen_check(workspace, hashes)
    for name in ('resource_limits', 'storage_limits'):
        limits = mapping(field(report, name, 'report'), name)
        for key, expected in POLICY[name].items():
            need(number(field(limits, key, name), name + '.' + key, True) == expected, name + '.' + key + ' differs from the policy ceiling')
    observation = mapping(field(report, 'storage_observation', 'report'), 'storage_observation')
    for key, cap in POLICY['storage_limits'].items():
        need(integer(field(observation, key, 'storage_observation'), 'storage_observation.' + key) <= cap, 'recorded storage ceiling exceeded: ' + key)
    need(raw_size <= POLICY['storage_limits']['report_bytes'], 'actual report byte cap exceeded')
    elapsed = number(field(report, 'elapsed_seconds', 'report'), 'elapsed_seconds')
    counts = mapping(field(report, 'counts', 'report'), 'counts')
    for key in ('contacts', 'bursts', 'health_checks', 'oracle_checks', 'contention_503', 'duplicate_409',
                'ambiguous_commits', 'hosts_started', 'hosts_cleanly_stopped'):
        integer(field(counts, key, 'counts'), 'counts.' + key)
    need(counts['contacts'] == counts['bursts'] * config['burst'], 'contacts/bursts mismatch')
    need(counts['ambiguous_commits'] <= counts['contacts'], 'ambiguous commits exceed contacts')
    statuses = count_map(field(report, 'post_status_counts', 'report'), 'post_status_counts')
    need(set(statuses) <= {'201', '409', '503'}, 'unexpected logical POST status')
    transport = count_map(field(report, 'transport_errors', 'report'), 'transport_errors')
    need(statuses.get('201', 0) + counts['ambiguous_commits'] == counts['contacts'], '201 plus ambiguous commits must equal contacts')
    need(statuses.get('409', 0) == counts['ambiguous_commits'], 'retry 409 count must equal ambiguous commits')
    need(counts['ambiguous_commits'] <= sum(transport.values()), 'ambiguous commits require recorded transport errors')
    attempts = sum(statuses.values()) + sum(transport.values())
    need(attempts <= counts['contacts'] * 32, 'logical POST attempts exceed the frozen retry bound')
    latency(field(report, 'logical_contact_latency_ms', 'report'), counts['contacts'], 'logical_contact_latency_ms')
    latency(field(report, 'post_attempt_latency_ms', 'report'), attempts, 'post_attempt_latency_ms')
    hosts = field(report, 'hosts', 'report')
    need(type(hosts) is list and len(hosts) == counts['hosts_cleanly_stopped'], 'closed host list/count mismatch')
    need(counts['hosts_started'] == len(hosts) if completed else len(hosts) <= counts['hosts_started'] <= len(hosts) + 1,
         'started/closed host count mismatch')
    epochs = native_total = total_samples = 0
    host_shards = []
    minimum_sample_ratio = None
    for index, host in enumerate(hosts):
        name = 'hosts[%d]' % index
        host = mapping(host, name)
        integer(field(host, 'pid', name), name + '.pid', 1)
        samples = integer(field(host, 'samples', name), name + '.samples', 1)
        total_samples += samples
        epoch = number(field(host, 'epoch_seconds', name), name + '.epoch_seconds', True)
        epochs += epoch
        if epoch > POLICY['maximum_closed_epoch_seconds']:
            failures.append({'code': 'epoch_duration', 'host': index, 'observed': epoch, 'maximum': POLICY['maximum_closed_epoch_seconds']})
        ratio = samples / (epoch * 10)
        if epoch >= POLICY['floors']['resource_sample_floor_minimum_epoch_seconds']:
            minimum_sample_ratio = ratio if minimum_sample_ratio is None else min(minimum_sample_ratio, ratio)
            if samples * 100 < epoch * 10 * POLICY['floors']['resource_samples_percent_of_epoch_per_0_1_seconds']:
                failures.append({'code': 'sample_coverage', 'host': index, 'observed': ratio, 'minimum': .85})
        started = integer(field(host, 'native_started', name), name + '.native_started', 1)
        need(integer(field(host, 'native_exited', name), name + '.native_exited') == started, 'native exit count mismatch: ' + name)
        native_total += started
        empty_list(field(host, 'native_active_pids', name), name + '.native_active_pids')
        empty_list(field(host, 'errors', name), name + '.errors')
        need(field(host, 'clean_shutdown', name) is True, 'unclean host shutdown: ' + name)
        baseline = integer(field(host, 'baseline_threads', name), name + '.baseline_threads', 1)
        need(integer(field(host, 'final_threads', name), name + '.final_threads', 1) == baseline, 'host thread baseline mismatch: ' + name)
        maximum_active = integer(field(host, 'maximum_native_active', name), name + '.maximum_native_active', 1)
        need(maximum_active <= config['workers'] and maximum_active <= started, 'native concurrency bound exceeded: ' + name)
        initial = mapping(field(host, 'initial', name), name + '.initial')
        last = mapping(field(host, 'last', name), name + '.last')
        peak = mapping(field(host, 'host_sampled_maximum', name), name + '.host_sampled_maximum')
        for metric in ('rss_bytes', 'threads', 'handles'):
            values = [integer(field(sample, metric, name + '.' + where), name + '.' + where + '.' + metric, 1)
                      for where, sample in (('initial', initial), ('last', last), ('peak', peak))]
            need(values[2] >= max(values[:2]), 'sampled maximum below recorded endpoint: ' + name + '.' + metric)
        need(initial['threads'] == baseline and last['threads'] == baseline, 'host thread endpoint mismatch: ' + name)
        for metric, ceiling, growth in (('rss_bytes', 'rss_peak_bytes', 'rss_retained_growth_bytes'),
                                        ('handles', 'handles_peak', 'handles_retained_growth')):
            need(peak[metric] <= POLICY['resource_limits'][ceiling], 'sampled resource ceiling exceeded: ' + name + '.' + metric)
            need(last[metric] - initial[metric] <= POLICY['resource_limits'][growth], 'retained resource growth exceeded: ' + name + '.' + metric)
        host_shards.append(integer(field(host, 'shard', name), name + '.shard'))
    need(epochs <= elapsed + .01, 'sum of closed epochs exceeds elapsed duration')
    need(host_shards == sorted(host_shards), 'host shard order regressed')
    if completed:
        traffic = number(field(report, 'traffic_duration_seconds', 'report'), 'traffic_duration_seconds', True)
        need(traffic >= config['duration_seconds'] and elapsed >= traffic, 'traffic/elapsed duration is shorter than requested or inconsistent')
        if epochs * 100 < traffic * POLICY['floors']['aggregate_closed_epoch_percent_of_traffic_duration']:
            failures.append({'code': 'aggregate_epoch_coverage', 'observed': epochs / traffic, 'minimum': .95})
        if total_samples * 100 < traffic * 10 * POLICY['floors']['aggregate_samples_percent_of_traffic_per_0_1_seconds']:
            failures.append({'code': 'aggregate_sample_coverage', 'observed': total_samples / (traffic * 10), 'minimum': .85})
        need(field(report, 'active_host_pid', 'report') is None, 'completed report has an active host')
        need(hosts, 'completed workload has no closed hosts')
        need(counts['duplicate_409'] == counts['bursts'] // 15, 'duplicate probe count mismatch')
        need(counts['oracle_checks'] == len(hosts) * 2 + counts['duplicate_409'], 'oracle probe count mismatch')
        overhead = counts['oracle_checks'] + counts['duplicate_409'] + counts['contention_503']
        need(counts['contacts'] + overhead <= native_total <= attempts + overhead, 'native launch count inconsistent with recorded worker requests')
        shards = field(report, 'shards', 'report')
        need(type(shards) is list and bool(shards), 'completed report is missing verified shards')
        verified = 0
        for index, shard in enumerate(shards):
            shard = mapping(shard, 'shard')
            need(integer(field(shard, 'shard', 'shard'), 'shard.shard') == index, 'verified shard inventory is not consecutive')
            size = integer(field(shard, 'verified_contacts', 'shard'), 'shard.verified_contacts', 1)
            need(size <= config['shard_contacts'], 'verified shard exceeds the profile size')
            if index < len(shards) - 1:
                need(size == config['shard_contacts'], 'nonfinal shard is not full')
            need(field(shard, 'integrity', 'shard') == 'ok', 'shard integrity is not ok')
            verified += size
        need(verified == counts['contacts'], 'verified shard contacts mismatch')
        need(set(host_shards) == set(range(len(shards))), 'host/verified shard inventory mismatch')
        target = config['duration_seconds'] * config['rate']
        floors = [('traffic_coverage', counts['contacts'], target, 95),
                  ('health_coverage', counts['health_checks'], math.floor(config['duration_seconds'] / 10), 90),
                  ('contention_coverage', counts['contention_503'], math.floor(config['duration_seconds'] / config['contention_seconds']), 90)]
        for code, observed, denominator, percent in floors:
            if observed * 100 < denominator * percent:
                failures.append({'code': code, 'observed': observed, 'minimum': math.ceil(denominator * percent / 100)})
        need(counts['health_checks'] <= math.ceil(traffic / 10) + 1, 'health count exceeds the frozen schedule')
        need(counts['contention_503'] <= math.ceil(traffic / config['contention_seconds']) + 1, 'contention count exceeds the frozen schedule')
    return {'contacts': counts['contacts'], 'requested_contacts': config['duration_seconds'] * config['rate'],
            'closed_hosts': len(hosts), 'recorded_elapsed_seconds': elapsed, 'closed_epoch_seconds': epochs,
            'closed_host_samples': total_samples,
            'minimum_closed_epoch_sample_ratio': minimum_sample_ratio, 'frozen_files_verified': workspace is not None}


def qualify(report, report_sha256, raw_size, workspace=None):
    output = {'schema': 1, 'policy_id': POLICY['id'], 'policy_sha256': POLICY_SHA256,
              'report_sha256': report_sha256, 'report_bytes': raw_size,
              'audited_utc': datetime.now(timezone.utc).isoformat(),
              'scope': POLICY['scope'], 'status': 'invalid_report', 'passed': False, 'issues': []}
    pending = type(report) is dict and report.get('state') == 'running' and report.get('passed', False) is None and report.get('workload_completed') is False
    try:
        report = mapping(report, 'report')
        if not pending:
            need(field(report, 'state', 'report') == 'finished', 'report is not in the exact finished state')
            for key in ('passed', 'workload_completed', 'frozen_inputs_unchanged'):
                need(field(report, key, 'report') is True, key + ' must be exactly true at completion')
        empty_list(field(report, 'errors', 'report'), 'report.errors')
        if 'stop_requested' in report:
            need(report['stop_requested'] is False, 'stopped/interrupted workload cannot qualify')
        output['observations'] = inspect_metrics(report, raw_size, workspace, not pending, output['issues'])
        output.update(status='pending' if pending else 'insufficient_coverage' if output['issues'] else 'qualified',
                      passed=None if pending else not output['issues'])
    except (InvalidReport, OSError, ValueError, OverflowError) as error:
        output['issues'].append({'code': 'invalid_report', 'message': str(error)[:300]})
        if pending:
            output.update(status='pending', passed=None)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--workspace', type=Path, help='Explicit trusted workspace; verify only the five named frozen files')
    parser.add_argument('--output', type=Path, required=True, help='New separate qualification file; never overwritten')
    args = parser.parse_args(argv)
    try:
        need(args.output.resolve() != args.report.resolve(), 'qualification output must differ from the input report')
        if args.workspace:
            need(not args.output.resolve().is_relative_to((args.workspace / 'frozen').resolve()), 'qualification output must not modify frozen inputs')
        report, digest, size = read_report(args.report)
        result = qualify(report, digest, size, args.workspace)
        with args.output.open('x', encoding='utf-8') as destination:
            destination.write(json.dumps(result, indent=2, allow_nan=False) + '\n')
    except (InvalidReport, OSError, ValueError, RecursionError) as error:
        print('Coverage audit rejected: ' + str(error)[:300])
        return 1
    print(json.dumps({'status': result['status'], 'passed': result['passed'],
                      'policy_sha256': POLICY_SHA256, 'report_sha256': digest}, sort_keys=True))
    return 0 if result['status'] == 'qualified' else 2 if result['status'] == 'pending' else 1


if __name__ == '__main__':
    raise SystemExit(main())
