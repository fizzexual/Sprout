"""UTC oracle/source controls by default; one explicit binary selects four CI calls."""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
_HELPER = None
MIN_SECONDS, MAX_SECONDS = -62135596800, 253402300799
EPOCH = datetime(1970, 1, 1)
MESSAGES = {
    'invalid_type': 'Provide a plain timestamp text value.',
    'input_limit': 'The timestamp exceeds the fixed input limit.',
    'invalid_timestamp': 'The timestamp does not match the supported profile.',
    'unsupported_precision': 'Use at most nine fractional second digits.',
    'leap_second_unsupported': 'Leap seconds are unsupported by this timestamp profile.',
    'out_of_range': 'The UTC instant must remain in years 0001 through 9999.',
    'invalid_instant': 'Provide exactly two exact integer instant fields.',
}
PATTERN = re.compile(r'([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})\Z')


def failure(code): return {'ok': False, 'instant': None, 'text': None, 'error': {'code': code, 'message': MESSAGES[code]}}
def tag(value): return {'$sprout.integer': str(value)}


def strict_equal(actual, expected):
    if type(actual) is not type(expected): return False
    if type(actual) is dict:
        return actual.keys() == expected.keys() and all(strict_equal(actual[key], expected[key]) for key in actual)
    if type(actual) is list: return len(actual) == len(expected) and all(strict_equal(a, b) for a, b in zip(actual, expected))
    return actual == expected


def success(seconds, nanoseconds):
    civil = EPOCH + timedelta(seconds=seconds)
    text = f'{civil.year:04d}-{civil.month:02d}-{civil.day:02d}T{civil.hour:02d}:{civil.minute:02d}:{civil.second:02d}.{nanoseconds:09d}Z'
    return {'ok': True, 'instant': {'seconds': tag(seconds), 'nanoseconds': tag(nanoseconds)}, 'text': text, 'error': None}


def parse_oracle(value):
    if type(value) is not str: return failure('invalid_type')
    if len(value) > 35: return failure('input_limit')
    match = PATTERN.fullmatch(value)
    if not match: return failure('invalid_timestamp')
    year, month, day, hour, minute, second = map(int, match.groups()[:6])
    fraction, offset_text = match.group(7), match.group(8)
    if fraction is not None and len(fraction) > 9: return failure('unsupported_precision')
    offset = 0
    if offset_text not in ('Z', 'z'):
        offset_hour, offset_minute = int(offset_text[1:3]), int(offset_text[4:6])
        if offset_hour > 23 or offset_minute > 59: return failure('invalid_timestamp')
        offset = (offset_hour * 60 + offset_minute) * (-1 if offset_text[0] == '-' else 1)
    if second > 60: return failure('invalid_timestamp')
    try: civil = datetime(year, month, day, hour, minute, min(second, 59))
    except ValueError: return failure('invalid_timestamp')
    if second == 60: return failure('leap_second_unsupported')
    delta = civil - EPOCH
    seconds = delta.days * 86400 + delta.seconds - offset * 60
    if not MIN_SECONDS <= seconds <= MAX_SECONDS: return failure('out_of_range')
    nanoseconds = int((fraction or '').ljust(9, '0'))
    return success(seconds, nanoseconds)


def exact_wire_integer(value):
    if type(value) is not dict or set(value) != {'$sprout.integer'}: return None
    text = value['$sprout.integer']
    if type(text) is not str or not re.fullmatch(r'[+-]?[0-9]+', text): return None
    result = int(text)
    return result if -(1 << 63) <= result < (1 << 63) else None


def format_oracle(value):
    # Tags in this independent wire model represent actual integers after native json_decode.
    if type(value) is not dict or set(value) != {'seconds', 'nanoseconds'}: return failure('invalid_instant')
    seconds, nanoseconds = exact_wire_integer(value['seconds']), exact_wire_integer(value['nanoseconds'])
    if seconds is None or nanoseconds is None or not 0 <= nanoseconds <= 999999999: return failure('invalid_instant')
    if not MIN_SECONDS <= seconds <= MAX_SECONDS: return failure('out_of_range')
    return success(seconds, nanoseconds)


def vectors():
    stamps = [
        '1970-01-01T00:00:00Z', '1970-01-01t00:00:00z',
        '1970-01-01T01:00:00+01:00', '1969-12-31T23:00:00-01:00',
        '1970-01-01T00:00:00+00:00', '1970-01-01T00:00:00-00:00',
        '1969-12-31T23:59:59.5Z', '1969-12-31T23:59:59.999999999Z',
        '1970-01-01T00:00:00.000000001Z', '1970-01-01T00:00:00.1Z',
        '1937-01-01T12:00:27.87+00:20', '2000-02-29T23:59:59+23:59',
        '1900-02-28T00:00:00-23:59', '2400-02-29T12:00:00Z',
        '0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999999Z',
        '0001-01-01T00:00:00+00:01', '9999-12-31T23:59:59-00:01',
        '0000-01-01T00:00:00Z', '1900-02-29T00:00:00Z',
        '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z',
        '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z',
        '2026-01-01T00:60:00Z', '2026-01-01T00:00:61Z',
        '2016-12-31T23:59:60Z', '2017-01-01T00:59:60+01:00',
        '1970-01-01 00:00:00Z', '1970-01-01T00:00:00',
        '1970-01-01T00:00:00.Z', '1970-01-01T00:00:00,5Z',
        '1970-01-01T00:00:00.1234567890Z', '1970-01-01T00:00:00.1234567890+00:00',
        '1970-01-01T00:00:00+24:00', '1970-01-01T00:00:00+00:60',
        '1970-01-01T00:00:00+0000', '1970-01-01T00:00:00Z ',
        '１９７０-01-01T00:00:00Z', '1970-01-01T00:00:00Z[UTC]',
    ]
    result = [{'op': 'parse', 'input': text, 'expected': parse_oracle(text)} for text in stamps]
    pairs = [(0, 0), (-1, 500000000), (-1, 999999999), (MIN_SECONDS, 0), (MAX_SECONDS, 999999999),
             (MIN_SECONDS-1, 0), (MAX_SECONDS+1, 0), (0, -1), (0, 1000000000),
             (-(1 << 63), 0), ((1 << 63)-1, 0)]
    result += [{'op': 'format', 'input': {'seconds': tag(seconds), 'nanoseconds': tag(nanoseconds)},
                'expected': format_oracle({'seconds': tag(seconds), 'nanoseconds': tag(nanoseconds)})} for seconds, nanoseconds in pairs]
    for value in [None, 0, True, {}, {'seconds': 0, 'nanoseconds': tag(0)},
                  {'seconds': tag(0), 'nanoseconds': None}, {'seconds': tag(0)},
                  {'seconds': tag(0), 'nanoseconds': tag(0), 'private_name': 'private-value'}]:
        result.append({'op': 'format', 'input': value, 'expected': format_oracle(value)})
    # Preserve all 59 source-first cases and append the independently identified mismatch.
    text = '1970-01-01T00:00:00.1234567890X'
    result.append({'op': 'parse', 'input': text, 'expected': parse_oracle(text)})
    assert len(result) <= 64
    return result


class OracleSourceTests(unittest.TestCase):
    def test_hand_calculated_epoch_negative_and_nanosecond_goldens(self):
        for text, seconds, nanoseconds in [
            ('1970-01-01T00:00:00Z', 0, 0), ('1970-01-01T01:00:00+01:00', 0, 0),
            ('1969-12-31T23:59:59.5Z', -1, 500000000), ('1970-01-01T00:00:00.000000001Z', 0, 1),
            ('0001-01-01T00:00:00Z', MIN_SECONDS, 0), ('9999-12-31T23:59:59.999999999Z', MAX_SECONDS, 999999999),
        ]:
            with self.subTest(text=text): self.assertEqual(parse_oracle(text), success(seconds, nanoseconds))

    def test_complete_vector_budget_types_and_fixed_wire_envelopes(self):
        data = vectors(); self.assertEqual(len(data), 60)
        for row in data:
            with self.subTest(op=row['op'], input=row['input']):
                value = row['expected']
                self.assertEqual(set(value), {'ok', 'instant', 'text', 'error'})
                self.assertLessEqual(len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())+2, 320)
                if value['ok']:
                    self.assertEqual(len(value['text'].encode()), 30)
                    self.assertEqual(parse_oracle(value['text']), value)
                    self.assertEqual(format_oracle(value['instant']), value)
                else:
                    self.assertIsNone(value['instant']); self.assertIsNone(value['text'])
                    self.assertLessEqual(len(value['error']['message'].encode()), 96)

    def test_module_source_has_captured_tasks_explicit_native_calls_and_fixed_loops(self):
        source = (ROOT / 'lib/utc.sprout').read_text(encoding='utf-8')
        tasks = re.findall(r'^(private|public) task ([a-z_]+)\(', source, re.M)
        self.assertEqual(len(tasks), 13)
        for visibility, name in tasks: self.assertIn(f'{visibility} make {name} = {name}', source)
        for native in ['kind_of', 'is_a', 'index_of', 'length', 'integer', 'slice', 'join', 'contains']:
            self.assertNotRegex(source, rf'(?<!::)\b{native}\(')
        self.assertNotRegex(source, r'\b(?:time|time_make|time_parts|time_format|today|now|wait|system|get|read|write)\(')
        self.assertIn('repeat 14 times:', source)
        self.assertIn('repeat while month < 12', source)
        self.assertEqual(len(re.findall(r'^test "', (ROOT / 'src/tests/utc_library_test.sprout').read_text(encoding='utf-8'), re.M)), 10)

    def test_native_entry_requires_binary_before_reports_or_child(self):
        from unittest.mock import patch
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('Unexpected native launch')) as launched, \
             patch.object(tempfile, 'mkdtemp', side_effect=AssertionError('Unexpected output creation')) as created:
            with self.assertRaises(ValueError): native_ci_checks(None)
            launched.assert_not_called(); created.assert_not_called()


def read_bounded(path, maximum):
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or not 0 <= before.st_size <= maximum: raise ValueError('Not a bounded regular file')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != before.st_size: raise ValueError('Input changed before read')
        chunks, total = [], 0
        while total < before.st_size:
            data = stream.read(min(65536, before.st_size-total))
            if not data: break
            chunks.append(data); total += len(data)
        if os.fstat(stream.fileno()).st_size != before.st_size or total != before.st_size: raise ValueError('Input changed during bounded read')
    return b''.join(chunks)


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def example_expected():
    """Full independent output oracle for the four committed synthetic records."""
    records = [
        ('1970-01-01T01:00:00+01:00', '1970-01-01T00:00:00Z'),
        ('1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000000001Z'),
        ('2000-02-29T23:59:59-00:00', '2000-03-01T00:00:00Z'),
        ('1900-02-29T00:00:00Z', '1900-03-01T00:00:00Z'),
    ]
    outputs = []
    for deadline_text, received_text in records:
        deadline, received = parse_oracle(deadline_text), parse_oracle(received_text)
        if not deadline['ok'] or not received['ok']:
            outputs.append({'ok': False, 'error': 'invalid_timestamp'})
        else:
            deadline_pair = tuple(int(deadline['instant'][key]['$sprout.integer']) for key in ('seconds', 'nanoseconds'))
            received_pair = tuple(int(received['instant'][key]['$sprout.integer']) for key in ('seconds', 'nanoseconds'))
            outputs.append({'ok': True, 'deadline': deadline['text'], 'received': received['text'], 'late': received_pair > deadline_pair})
    return outputs


def verify_example_output(value):
    expected = example_expected()
    if not strict_equal(value, expected):
        raise AssertionError('Synthetic example differs from frozen oracle')


class ExampleAcceptanceTests(unittest.TestCase):
    def test_complete_example_rejects_changed_extra_and_missing_fields(self):
        expected = example_expected()
        verify_example_output(expected)
        for change in ('changed', 'extra', 'missing'):
            with self.subTest(change=change):
                actual = unique_json(json.dumps(expected).encode('utf-8'))
                if change == 'changed':
                    actual[0]['deadline'] = '1970-01-01T00:00:01.000000000Z'
                elif change == 'extra':
                    actual[0]['unexpected'] = 'extra-value'
                else:
                    del actual[0]['received']
                with self.assertRaisesRegex(AssertionError, '^Synthetic example differs from frozen oracle$'):
                    verify_example_output(actual)


def bounded_helper():
    """Trusted checked-out helper; no private file identity or test/compiler entry."""
    global _HELPER
    if _HELPER is None:
        helper_path = ROOT / 'src/tests/gc_env_roots_test.py'
        read_bounded(helper_path, 1048576)
        spec = importlib.util.spec_from_file_location('_sprout_utc_bounded_capture', helper_path)
        helper = importlib.util.module_from_spec(spec)
        saved_argv = sys.argv
        try:
            sys.argv = [str(helper_path)]
            spec.loader.exec_module(helper)
        finally:
            sys.argv = saved_argv
        # The copied helper enforces this independently in each output reader.
        helper.CAPTURE_BYTES = 32768
        _HELPER = helper
    return _HELPER


class CorrectionTests(unittest.TestCase):
    def test_bad_suffix_and_valid_overprecision_oracle_pair(self):
        malformed = '1970-01-01T00:00:00.1234567890X'
        overprecision = '1970-01-01T00:00:00.1234567890Z'
        self.assertEqual(parse_oracle(malformed), failure('invalid_timestamp'))
        self.assertEqual(parse_oracle(overprecision), failure('unsupported_precision'))
        self.assertEqual(len(vectors()), 60)
        self.assertEqual(vectors()[-1]['input'], malformed)

    def test_grammar_before_precision_source_order(self):
        source = (ROOT / 'lib/utc.sprout').read_text(encoding='utf-8')
        conversion = source.index('when fraction_count <= 9:')
        component = source.index('set nanoseconds = u_component(text, start, position)')
        offset = source.index('when position + 1 == size')
        precision = source.index('when fraction_count > 9:')
        calendar = source.index('make year = u_component(text, 0, 4)')
        self.assertLess(conversion, component)
        self.assertLess(component, offset)
        self.assertLess(offset, precision)
        self.assertLess(precision, calendar)
        self.assertEqual(source.count('give u_failure("unsupported_precision")'), 1)

    def test_fake_streaming_overflow_and_owned_direct_reap(self):
        from unittest.mock import patch
        original_argv = sys.argv
        helper = bounded_helper()
        self.assertIs(sys.argv, original_argv)
        self.assertEqual(helper.CAPTURE_BYTES, 32768)
        class Child:
            stdout = io.BytesIO(b'x' * 32769)
            stderr = io.BytesIO()
            stdin = None
            status = None
            kills = 0
            def poll(self): return self.status
            def kill(self): self.kills += 1; self.status = -9
            def wait(self, timeout): return self.status
        child = Child()
        with patch.object(helper.subprocess, 'Popen', return_value=child) as launched:
            result = helper.bounded_process(['fake-owned-overflow'], timeout=1)
        launched.assert_called_once()
        self.assertEqual(result.capture_errors, ('stdout exceeds fixture capture cap',))
        self.assertEqual(result.cleanup_errors, ())
        self.assertEqual(len(result.stdout), 32768)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(result.returncode, -9)
        self.assertEqual(child.kills, 1)
        self.assertTrue(child.stdout.closed); self.assertTrue(child.stderr.closed)

    def test_fake_primary_diagnostic_and_cleanup_refusal(self):
        from unittest.mock import patch
        helper = bounded_helper()
        class Pipe:
            closed = False
            def read1(self, count): raise OSError('original reader diagnostic')
            def close(self): self.closed = True
        class Child:
            stdout = Pipe(); stderr = io.BytesIO(); stdin = None
            def poll(self): return None
            def kill(self): raise PermissionError('owned direct kill denied')
            def wait(self, timeout): raise subprocess.TimeoutExpired('fake-owned-denial', timeout)
        child = Child()
        with patch.object(helper.subprocess, 'Popen', return_value=child) as launched:
            result = helper.bounded_process(['fake-owned-denial'], timeout=1)
        launched.assert_called_once()
        self.assertTrue(any('original reader diagnostic' in issue for issue in result.capture_errors))
        self.assertTrue(any('owned direct kill denied' in issue for issue in result.cleanup_errors))
        self.assertTrue(any('owned direct exit unconfirmed' in issue for issue in result.cleanup_errors))
        self.assertIsNone(result.returncode)
        self.assertTrue(child.stdout.closed); self.assertTrue(child.stderr.closed)


def file_identity(path, maximum, text=False):
    raw = read_bounded(path, maximum)
    identity = {'path': str(path.resolve()), 'bytes': len(raw), 'raw_sha256': hashlib.sha256(raw).hexdigest()}
    if text:
        canonical = raw.decode('utf-8').replace('\r\n', '\n').encode('utf-8')
        identity['canonical_utf8_lf_sha256'] = hashlib.sha256(canonical).hexdigest()
    return identity


def supplied_wrapper(rows):
    record_text = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
    literal = json.dumps(record_text, ensure_ascii=False)
    source = read_bounded(ROOT / 'lib/utc.sprout', 1048576).decode('utf-8').replace('\r\n', '\n')
    return (source + '\nmake records = builtin::json_decode(' + literal + ')\nmake outputs = []\nfor each record in records:\n    when record.op == "parse":\n        builtin::add(outputs, parse(record.input))\n    otherwise:\n        builtin::add(outputs, format(record.input))\nshow builtin::json_encode(outputs)\n').encode('utf-8')


def verify_shared_output(raw):
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', raw)
    if re.search(rb'\b0*[1-9][0-9]*[ \t]+failed\b', clean):
        raise AssertionError('Portable test summary reports failures')
    summaries = [match for line in clean.splitlines()
                 if (match := re.fullmatch(rb'[ \t]*([0-9]+) passed(?:,[ \t]*([0-9]+) failed)?[ \t]*', line))]
    if len(summaries) != 1 or summaries[0].group(1) != b'10' or summaries[0].group(2) not in (None, b'0'):
        raise AssertionError('Portable test summary must be exactly10 passed and zero failed')


def native_ci_checks(binary, report=None):
    """One explicit trusted CI binary, four calls; default mode never enters here."""
    if binary is None: raise ValueError('Explicit binary is required for native CI mode')
    binary = Path(binary).resolve(strict=True)
    binary_identity = file_identity(binary, 67108864)
    helper = bounded_helper()
    source_paths = {'module': ROOT / 'lib/utc.sprout', 'validator': ROOT / 'lib/validate.sprout',
                    'shared': ROOT / 'src/tests/utc_library_test.sprout',
                    'example': ROOT / 'examples/time/deadline.sprout',
                    'executed_driver': Path(__file__).resolve(),
                    'loaded_helper': Path(helper.__file__).resolve()}
    source_identities = {name: file_identity(path, 1048576, True) for name, path in source_paths.items()}
    rows = vectors()
    if len(rows) != 60: raise ValueError('Fixed oracle case count differs')
    wrapper = supplied_wrapper(rows)
    expected_example = example_expected()
    if report is None:
        report = Path(tempfile.mkdtemp(prefix='sprout-utc-ci-')).resolve()
    else:
        report = Path(report).resolve()
        report.mkdir(parents=True, exist_ok=False)
    print('UTC native report: ' + str(report), file=sys.stderr)
    program = report / 'supplied-oracle.sprout'; program.write_bytes(wrapper)
    (report / 'oracle-vectors.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
    (report / 'synthetic-example-expected.json').write_text(json.dumps(expected_example, indent=2)+'\n', encoding='utf-8', newline='\n')
    scope = {'schema': 'sprout.utc-ci-scope.v1', 'planned_native_calls': 4, 'sdk_calls': 0, 'compiler_calls': 0,
             'vm_timeout_ms': 3000, 'max_steps': 5000000, 'host_execution_seconds': 5,
             'streaming_capture_bytes_each_stream': 32768, 'native': binary_identity,
             'sources': source_identities, 'wrapper_sha256': hashlib.sha256(wrapper).hexdigest(),
             'host': {'executable': sys.executable, 'version': sys.version, 'platform': sys.platform},
             'provenance_scope': 'Trusted checked-out test code and explicitly selected binary; recorded identities are evidence, not source authenticity or OS isolation.'}
    (report / 'attempt.json').write_text(json.dumps(scope, indent=2)+'\n', encoding='utf-8', newline='\n')
    calls = [('shared-normal', 'test', ROOT / 'src/tests/utc_library_test.sprout', False, False, None),
             ('shared-gc', 'test', ROOT / 'src/tests/utc_library_test.sprout', True, False, None),
             ('oracle-supplied-sandbox', 'run', program, False, True, None),
             ('synthetic-example', 'run', ROOT / 'examples/time/deadline.sprout', False, False, None)]
    observations = []
    for label, mode, source, stress, sandbox, input_raw in calls:
        child_env = dict(os.environ); child_env.pop('SPROUT_GC_STRESS', None); child_env.pop('SPROUT_SANDBOX', None)
        if stress: child_env['SPROUT_GC_STRESS'] = '1'
        argv = [str(binary), mode, str(source), '--max-steps', '5000000', '--timeout-ms', '3000']
        if sandbox: argv.append('--sandbox')
        result = helper.bounded_process(argv, data=input_raw, timeout=5, cwd=ROOT, env=child_env)
        (report / (label+'.stdout.bin')).write_bytes(result.stdout); (report / (label+'.stderr.bin')).write_bytes(result.stderr)
        observation = {'label': label, 'argv': argv, 'exit': result.returncode, 'gc_stress': stress,
                       'stdout_bytes': len(result.stdout), 'stderr_bytes': len(result.stderr),
                       'capture_errors': list(result.capture_errors), 'cleanup_errors': list(result.cleanup_errors)}
        observations.append(observation)
        (report / 'observations.json').write_text(json.dumps(observations, indent=2)+'\n', encoding='utf-8')
        if result.returncode != 0 or result.capture_errors or result.cleanup_errors or len(result.stdout) > 32768 or len(result.stderr) > 32768:
            raise AssertionError('First native failure retained; no retry')
        if result.stderr: raise AssertionError('Unexpected native diagnostic retained')
        if mode == 'test':
            verify_shared_output(result.stdout)
        elif label == 'oracle-supplied-sandbox':
            if not strict_equal(unique_json(result.stdout), [row['expected'] for row in rows]): raise AssertionError('Independent oracle differs')
        else:
            verify_example_output(unique_json(result.stdout))
    for name, path in source_paths.items():
        if file_identity(path, 1048576, True) != source_identities[name]:
            raise AssertionError('Executed test source changed during native CI calls')
    if file_identity(binary, 67108864) != binary_identity:
        raise AssertionError('Selected binary changed during native CI calls')
    (report / 'passed.json').write_text('{"passed":true,"native_calls":4}\n', encoding='utf-8', newline='\n')
    return observations


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', nargs='?', type=Path, help='Explicit trusted binary selects exactly four native CI calls')
    parser.add_argument('--report-dir', type=Path, help='New exclusive output directory, only in explicit binary mode')
    args = parser.parse_args(argv)
    if args.binary is not None:
        native_ci_checks(args.binary, args.report_dir)
        return 0
    if args.report_dir is not None: raise ValueError('Report directory requires an explicit binary')
    suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(OracleSourceTests),
                               unittest.defaultTestLoader.loadTestsFromTestCase(CorrectionTests),
                               unittest.defaultTestLoader.loadTestsFromTestCase(ExampleAcceptanceTests)])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__': raise SystemExit(main())
