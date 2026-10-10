"""Median wall-clock workload comparison, output parity and machine-readable evidence."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import statistics
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=pathlib.Path)
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--warmups', type=int, default=1)
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--compare-vm', action='store_true')
    args = parser.parse_args()
    if args.samples < 1 or args.warmups < 0:
        parser.error('samples must be positive and warmups nonnegative')
    binary = args.binary.resolve()
    root = pathlib.Path(__file__).resolve().parents[1]
    report = {'platform': platform.platform(), 'python': platform.python_version(),
              'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'samples': args.samples, 'warmups': args.warmups,
              'clock': 'perf_counter wall time including process startup', 'workloads': {}}
    modes = [0, 1] if args.compare_vm else [0]
    if args.compare_vm:
        env = os.environ.copy()
        env.update(SPROUT_NUMERIC_VM='1', SPROUT_NUMERIC_VM_STATS='1')
        probe = subprocess.run([str(binary), 'run', str(root / 'benchmarks/workloads/arithmetic.sprout')],
                               cwd=root, env=env, capture_output=True, timeout=120)
        prefix = b'SPROUT_NUMERIC_VM_PROFILE '
        profiles = [json.loads(line[len(prefix):]) for line in probe.stderr.splitlines() if line.startswith(prefix)]
        if probe.returncode or not profiles or profiles[-1].get('executions', 0) <= 0:
            raise SystemExit('--compare-vm requires the experimental prototype with verified bytecode executions.')
        report['numeric_vm_probe'] = profiles[-1]
    for workload in sorted((root / 'benchmarks/workloads').glob('*.sprout')):
        expected = None
        row = {}
        for mode in modes:
            timings = []
            env = os.environ.copy()
            env.update(SPROUT_NUMERIC_VM=str(mode), SPROUT_NUMERIC_VM_STATS='0')
            for index in range(args.samples + args.warmups):
                start = time.perf_counter()
                result = subprocess.run([str(binary), 'run', str(workload)], cwd=root, env=env,
                                        capture_output=True, timeout=120)
                elapsed = time.perf_counter() - start
                if result.returncode:
                    raise SystemExit('workload failed: %s\n%s' % (workload.name, result.stderr.decode(errors='replace')))
                if expected is None:
                    expected = result.stdout
                if result.stdout != expected:
                    raise SystemExit('output parity failed: %s' % workload.name)
                if index >= args.warmups:
                    timings.append(elapsed)
            row['numeric_vm' if mode else 'ast'] = {'median_seconds': statistics.median(timings),
                'min_seconds': min(timings), 'max_seconds': max(timings), 'samples_seconds': timings}
        row['source_sha256'] = hashlib.sha256(workload.read_bytes()).hexdigest()
        row['output_sha256'] = hashlib.sha256(expected).hexdigest()
        if args.compare_vm:
            row['vm_speedup'] = row['ast']['median_seconds'] / row['numeric_vm']['median_seconds']
        report['workloads'][workload.stem] = row
        print('%-14s AST %.4fs%s' % (workload.stem, row['ast']['median_seconds'],
              ' VM %.4fs (%.3fx)' % (row['numeric_vm']['median_seconds'], row['vm_speedup']) if args.compare_vm else ''))
    if args.compare_vm:
        # An opt-in experiment cannot become the default on a noisy or workload-specific win.
        arithmetic = report['workloads']['arithmetic']['vm_speedup']
        regressions = [name for name, row in report['workloads'].items() if row['vm_speedup'] < .95]
        report['measurement_gate'] = {'arithmetic_at_least_10_percent_faster': arithmetic >= 1.1,
            'other_workloads_no_more_than_5_percent_slower': not regressions, 'regressions': regressions,
            'passes': arithmetic >= 1.1 and not regressions,
            'note': 'Local timing evidence; cross-platform parity and repeated measurements remain required.'}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print('Evidence:', args.output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
