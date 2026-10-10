"""Deterministic grammar/property fuzzing with bounded execution and retained crash repros.

No third-party dependency. This complements sanitizer-guided native fuzzers;
it does not prove absence of memory bugs or exhaust the grammar.
"""
import argparse
import hashlib
import json
import math
import os
import pathlib
import random
import subprocess
import tempfile
import time


def generated_expression(rng, depth):
    if depth == 0 or rng.random() < .2:
        value = rng.randint(-30, 30)
        return str(value), float(value)
    op = rng.choice(['+', '-', '*', '/', '%'])
    left, lv = generated_expression(rng, depth - 1)
    if op in ['/', '%']:
        rv = float(rng.randint(1, 20))
        right = str(int(rv))
    else:
        right, rv = generated_expression(rng, depth - 1)
    value = {'+': lambda: lv + rv, '-': lambda: lv - rv, '*': lambda: lv * rv,
             '/': lambda: lv / rv, '%': lambda: math.fmod(lv, rv)}[op]()
    return '(' + left + ' ' + op + ' ' + right + ')', value


def mutate(rng, source):
    for _ in range(rng.randint(1, 4)):
        at = rng.randrange(len(source) + 1)
        if rng.random() < .5 and at < len(source):
            source = source[:at] + source[at + 1:]
        else:
            source = source[:at] + rng.choice(['[', ']', '(', ')', '{', '}', ':', '"', '\\', '\n', '~', ',', '\x00']) + source[at:]
    return source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=pathlib.Path)
    parser.add_argument('--iterations', type=int, default=200)
    parser.add_argument('--seed', type=int, default=20261010)
    parser.add_argument('--timeout', type=float, default=3)
    parser.add_argument('--artifacts', type=pathlib.Path, default=pathlib.Path('fuzz-artifacts'))
    parser.add_argument('--report', type=pathlib.Path)
    args = parser.parse_args()
    if args.iterations < 1 or args.timeout <= 0:
        parser.error('iterations and timeout must be positive')
    binary = args.binary.resolve()
    rng = random.Random(args.seed)
    corpus = [
        'make a = [1, 2, 3]\nshow a[1]\n',
        'task combine(a, b = 2):\n    give a + b\nshow combine(b: 4, a: 1)\n',
        'make value = {name: "test", list: [1, 2]}\nshow value["name"]\n',
        'make text = """first\n~ bracket text [{(\nlast"""\nshow text\n',
        'when yes:\n    show "okay"\notherwise:\n    show "other"\n',
        'make double = task(x): x * 2\nshow double(3)\n',
        'type Point:\n    make x = 0\n    task show_x(self):\n        give self.x\nshow Point(x: 2).show_x()\n',
    ]
    fixed_bad = ['show ' + '(' * 400 + '1' + ')' * 399 + '\n',
                 'show 1e999\n', 'make value = [\n', 'show "unterminated\n',
                 'show """unterminated\n', 'make value = {x:}\n',
                 '\n'.join('    ' * n + 'when yes:' for n in range(270)) + '\n',
                 'make value = "nul\x00byte"\n']
    report = {'seed': args.seed, 'requested_iterations': args.iterations,
              'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'generated_runtime_cases': 0, 'mutated_parser_cases': 0,
              'malformed_fixed_cases': 0, 'failures': [],
              'scope': 'numeric arithmetic properties; parser mutations; bounded runtime; exit-code/memory-sanitizer signals'}
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='sprout-fuzz-') as temp:
        folder = pathlib.Path(temp)
        source_file = folder / 'case.sprout'

        def execute(source, command, index):
            source_file.write_bytes(source.encode())
            env = os.environ.copy()
            # Disable an experimental optimization unless the caller explicitly enables it.
            env.setdefault('SPROUT_NUMERIC_VM', '0')
            flags = ['--sandbox', '--max-steps', '10000', '--timeout-ms', '500']
            try:
                result = subprocess.run([str(binary), *flags, command, str(source_file)], cwd=folder,
                                        env=env, capture_output=True, timeout=args.timeout)
            except subprocess.TimeoutExpired:
                failure = {'case': index, 'kind': 'process_timeout'}
                retain(source, failure)
                return None
            stderr = result.stderr.decode('utf-8', errors='replace')
            if result.returncode not in [0, 1] or any(marker in stderr for marker in
                    ['ERROR: AddressSanitizer', 'runtime error:', 'MemorySanitizer', 'UndefinedBehaviorSanitizer']):
                failure = {'case': index, 'kind': 'crash_or_sanitizer', 'returncode': result.returncode, 'stderr': stderr}
                retain(source, failure)
                return None
            return result

        def retain(source, failure):
            args.artifacts.mkdir(parents=True, exist_ok=True)
            name = 'seed-%d-case-%s' % (args.seed, failure['case'])
            path = args.artifacts / (name + '.sprout')
            path.write_bytes(source.encode())
            failure['reproduction'] = str(path.resolve())
            (args.artifacts / (name + '.json')).write_text(json.dumps(failure, indent=2) + '\n')
            report['failures'].append(failure)

        for index, source in enumerate(fixed_bad):
            report['malformed_fixed_cases'] += 1
            execute(source, 'check', 'fixed-%d' % index)
        for index in range(args.iterations):
            expression, expected = generated_expression(rng, 5)
            source = 'show ' + expression + '\n'
            result = execute(source, 'run', 'generated-%d' % index)
            report['generated_runtime_cases'] += 1
            if result is not None:
                try:
                    actual = float(result.stdout.strip())
                    valid = result.returncode == 0 and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-8)
                except ValueError:
                    valid = False
                if not valid:
                    retain(source, {'case': 'generated-%d' % index, 'kind': 'numeric_property',
                        'expected': expected, 'stdout': result.stdout.decode(errors='replace'),
                        'stderr': result.stderr.decode(errors='replace'), 'returncode': result.returncode})
            source = mutate(rng, rng.choice(corpus))
            execute(source, 'check', 'mutated-%d' % index)
            report['mutated_parser_cases'] += 1
    report['elapsed_seconds'] = time.perf_counter() - started
    report['passed'] = not report['failures']
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key not in ['binary_sha256', 'scope', 'failures']}, indent=2))
    for failure in report['failures']:
        print(failure['kind'], failure['reproduction'])
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
