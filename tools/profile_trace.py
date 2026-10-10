"""Summarize bounded Sprout traces: event counts and observed inclusive wall intervals."""
import argparse
import collections
import hashlib
import json
import pathlib
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=pathlib.Path)
    parser.add_argument('program', type=pathlib.Path)
    parser.add_argument('--cwd', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    binary, program = args.binary.resolve(), args.program.resolve()
    started = time.perf_counter()
    result = subprocess.run([str(binary), '--trace-json', 'run', str(program)],
                            cwd=args.cwd or program.parent, capture_output=True, timeout=args.timeout)
    elapsed = time.perf_counter() - started
    events = []
    other_stderr = []
    for line in result.stderr.decode('utf-8', errors='replace').splitlines():
        if line.startswith('@sprout-trace '):
            events.append(json.loads(line[len('@sprout-trace '):]))
        else:
            other_stderr.append(line)
    counts = collections.Counter()
    intervals = collections.defaultdict(float)
    for index, event in enumerate(events):
        location = (event.get('file', '<input>'), event.get('line', 0), event.get('type', 'unknown'))
        counts[location] += 1
        if index + 1 < len(events) and 'elapsed_ms' in event and 'elapsed_ms' in events[index + 1]:
            intervals[location] += max(0., events[index + 1]['elapsed_ms'] - event['elapsed_ms'])
    records = [{'file': key[0], 'line': key[1], 'event': key[2], 'events': count,
                'observed_wall_ms': intervals[key]} for key, count in counts.items()]
    records.sort(key=lambda row: (-row['observed_wall_ms'], -row['events'], row['file'], row['line']))
    report = {'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'program_sha256': hashlib.sha256(program.read_bytes()).hexdigest(),
              'returncode': result.returncode, 'wall_seconds_with_tracing': elapsed,
              'program_stdout_sha256': hashlib.sha256(result.stdout).hexdigest(),
              'program_stdout_bytes': len(result.stdout),
              'trace_events': len(events), 'timestamped': any('elapsed_ms' in event for event in events),
              'prefix_may_be_capped': len(events) >= 5000 or sum(len(json.dumps(event)) for event in events) >= 2000000,
              'locations': records, 'stderr': '\n'.join(other_stderr),
              'interpretation': 'Intervals between observed events include tracing overhead, nested calls and I/O. '
                                'They are not exclusive CPU time. The runtime caps the trace prefix at 5000 events/2 MiB.'}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    print('Recorded %d events in %.4fs%s' % (len(events), elapsed, ' (trace prefix may be capped)' if report['prefix_may_be_capped'] else ''))
    for row in records[:15]:
        print('%8.3fms %6d events %s:%s %s' % (row['observed_wall_ms'], row['events'], row['file'], row['line'], row['event']))
    if not report['timestamped']:
        print('This runtime does not include elapsed_ms; only event counts are available.')
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
