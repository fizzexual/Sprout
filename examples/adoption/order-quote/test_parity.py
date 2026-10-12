"""Bounded synthetic prior-Python/native quote parity; no third-party packages."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else
              os.environ.get('SPROUT_BINARY') or os.environ.get('SPROUT_COMMAND') or
              ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()
sys.path.insert(0, str(ROOT / 'integrations/python'))
from sprout_host import SproutError, decode, encode, run
from baseline import evaluate, semantic

CASES = json.loads((HERE / 'cases.json').read_text(encoding='utf-8'))['cases']
OPTIONS = dict(command=str(BINARY), cwd=HERE, sandbox=False, timeout_ms=5000,
               runtime_timeout_ms=3000, max_steps=1000000, max_input_bytes=8192,
               max_output_bytes=16384, max_error_bytes=8192)


def canonical_text_sha256(raw):
    # Checkout CRLF pairs become LF. UTF-8, bare CR, BOM and other content remain significant.
    return hashlib.sha256(raw.decode('utf-8').replace('\r\n', '\n').encode('utf-8')).hexdigest()


def projection(value):
    if not value['ok']:
        return {'ok': False, 'errors': [{'path': issue['path'], 'code': issue['code']} for issue in value['errors']],
                'truncated': value['truncated']}
    quote = value['quote']
    return dict(ok=True, order_id=quote['order_id'], sku_ids=[line['sku_id'] for line in quote['lines']],
                **{key: quote[key] for key in ('gross', 'discount', 'net', 'shipping', 'total', 'units')},
                discount_rule=value['decisions'][4]['code'], rate_bps=value['decisions'][4]['rate_bps'],
                shipping_rule=value['decisions'][5]['code'])


class OrderQuoteParity(unittest.TestCase):
    def test_pinned_synthetic_oracles_and_validation_profile(self):
        for path, expected in [
            (HERE / 'baseline.py', '737e203e16405d61e95c2335c57e7c361e5316a6d1a997e8e511633e89b2a7d3'),
            (HERE / 'baseline.cjs', '46283dafd11ce71ccac49454198392c34dfa8dc5d88e3fe266a2213be458bb59'),
            (HERE / 'cases.json', '3f07c4fb116ad4f16b1ecdbb9476aa2401603110dcc0327afc690ca88395d3f0'),
            (ROOT / 'lib/validate.sprout', '2f522b628355e1f422f1f544923bde11f9797672005e7898646158c8bfe45287')]:
            raw = path.read_bytes()
            self.assertEqual(canonical_text_sha256(raw), expected,
                             'Pinned synthetic evidence changed; review before updating it.')
            lf = raw.decode('utf-8').replace('\r\n', '\n').encode('utf-8')
            self.assertEqual(canonical_text_sha256(lf), expected)
            self.assertEqual(canonical_text_sha256(lf.replace(b'\n', b'\r\n')), expected)
            self.assertNotEqual(canonical_text_sha256(lf + b'\nintentional-content-change\n'), expected)
        self.assertNotEqual(canonical_text_sha256(b'\r'), canonical_text_sha256(b'\n'))
        self.assertNotEqual(canonical_text_sha256(b'\xef\xbb\xbftext'), canonical_text_sha256(b'text'))
        with self.assertRaises(UnicodeDecodeError): canonical_text_sha256(b'\xff')

    def worker(self, request):
        return run(HERE / 'worker.sprout', request, **OPTIONS)

    def source(self, body, *, prelude='', supplied=False):
        if supplied:
            rules = (HERE / 'rules.sprout').read_text(encoding='utf-8')
            rules = rules.replace('use "../../../lib/validate.sprout"\n', '').replace('validate.check(request, schema)', 'check(request, schema)')
            prefix = (ROOT / 'lib/validate.sprout').read_text(encoding='utf-8') + '\n' + rules
        else:
            prefix = 'use ' + json.dumps((HERE / 'rules.sprout').as_posix())
        with tempfile.TemporaryDirectory(prefix='sprout-order-quote-') as directory:
            source = Path(directory) / 'case.sprout'
            source.write_text(prelude + '\n' + prefix + '\n' + body + '\n', encoding='utf-8')
            result = subprocess.run([str(BINARY), *(['--sandbox'] if supplied else []), 'run', str(source),
                '--max-steps', '1000000', '--timeout-ms', '3000'], cwd=directory, capture_output=True, timeout=8)
            for marker in (b'runtime error:', b'AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
                self.assertNotIn(marker, result.stdout + result.stderr)
            self.assertGreaterEqual(result.returncode, 0, 'A crash is not an invalid quote')
            if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
            self.assertEqual(result.stderr, b'')
            self.assertLessEqual(len(result.stdout), 16384)
            self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), ['case.sprout'])
            return decode(result.stdout)

    @staticmethod
    def encoded(value):
        return 'builtin::json_decode(' + json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False) + ')'

    def test_independent_python_and_hand_calculated_cases(self):
        for case in CASES:
            with self.subTest(case=case['name']):
                original = deepcopy(case['input'])
                self.assertLessEqual(len((encode(original) + '\n').encode('utf-8')), 8192)
                baseline = semantic(evaluate(original))
                self.assertEqual(projection(baseline), case['expected'])
                self.assertEqual(original, case['input'])

    def test_native_matches_python_and_every_hand_calculated_case(self):
        for case in CASES:
            with self.subTest(case=case['name']):
                request = deepcopy(case['input'])
                actual = semantic(self.worker(request))
                self.assertEqual(actual, semantic(evaluate(request)))
                self.assertEqual(projection(actual), case['expected'])
                self.assertEqual(request, case['input'])
                if not actual['ok']:
                    self.assertIsNone(actual['quote'])
                    self.assertEqual(actual['decisions'], [])
                    self.assertNotIn('private-key-secret', json.dumps(actual))
                    self.assertNotIn('private-value-secret', json.dumps(actual))

    def test_reordering_lines_preserves_totals_and_fixed_decision_order(self):
        request = deepcopy(next(case['input'] for case in CASES if case['name'] == 'adjacent_SKUs_above_float_precision'))
        before = semantic(self.worker(request))
        request['lines'].reverse()
        after = semantic(self.worker(request))
        self.assertEqual(before['decisions'], after['decisions'])
        for name in ('gross', 'discount', 'net', 'shipping', 'total', 'units', 'order_id'):
            self.assertEqual(before['quote'][name], after['quote'][name])
        self.assertEqual(after['quote']['lines'], list(reversed(before['quote']['lines'])))

    def test_native_request_and_quote_trees_are_detached(self):
        request = CASES[0]['input']
        value = self.source('make request = ' + self.encoded(request) + '''
make original = builtin::json_encode(request)
make first = rules.evaluate(request)
set first.quote.lines[0].quantity = builtin::integer("77")
make second = rules.evaluate(request)
make request_before = builtin::json_encode(request) == original
set request.lines[0].unit_price = "2.00"
show builtin::json_encode({request_before: request_before, second: second})''')
        self.assertTrue(value['request_before'])
        self.assertEqual(semantic(value['second']), semantic(evaluate(request)))

    def test_cycles_objects_tasks_and_nonfinite_fail_without_partial_quote(self):
        value = self.source('''make request = ''' + self.encoded(CASES[0]['input']) + '''
set request.private_cycle = request
make cycle_result = rules.evaluate(request)
type number:
    make value
make object_request = ''' + self.encoded(CASES[0]['input']) + '''
set object_request.lines[0].quantity = number(1)
make object_result = rules.evaluate(object_request)
task unexpected():
    fail "This task must never be called."
make task_request = ''' + self.encoded(CASES[0]['input']) + '''
set task_request.lines[0].sku_id = unexpected
make task_result = rules.evaluate(task_request)
make nonfinite_request = ''' + self.encoded(CASES[0]['input']) + '''
set nonfinite_request.lines[0].quantity = builtin::sum([1e308, 1e308])
make nonfinite_result = rules.evaluate(nonfinite_request)
show builtin::json_encode([cycle_result, object_result, task_result, nonfinite_result])''')
        for result in value:
            self.assertFalse(result['ok'])
            self.assertIsNone(result['quote']); self.assertEqual(result['decisions'], [])
        self.assertEqual(value[0]['errors'][0]['path'], ['<unknown>'])

    def test_helpers_and_builtin_calls_resist_constructor_collisions_in_supplied_sandbox(self):
        prelude = 'make calls = []\ntask observed():\n    builtin::add(calls, "constructor")\n    give 0\n'
        for name, arity in [('oq_failure', 0), ('oq_error', 4), ('oq_digits', 1), ('oq_id', 3),
                            ('oq_price', 3), ('oq_money', 1), ('evaluate', 1), ('kind_of', 1),
                            ('is_a', 2), ('contains', 2), ('length', 1), ('add', 2), ('keys', 1),
                            ('integer', 1), ('decimal_div', 3), ('split', 2), ('slice', 3)]:
            prelude += 'type ' + name + ':\n' + ''.join('    make arg%d\n' % index for index in range(arity))
            prelude += '    make observed = observed()\n'
        value = self.source('show builtin::json_encode({result: evaluate(' + self.encoded(CASES[1]['input']) +
                            '), calls: calls})', prelude=prelude, supplied=True)
        self.assertEqual(value['calls'], [])
        self.assertEqual(semantic(value['result']), semantic(evaluate(CASES[1]['input'])))

    def test_maximum_basket_physical_response_and_input_are_bounded(self):
        request = next(case['input'] for case in CASES if case['name'] == 'maximum_32_lines_int64_IDs')
        wire = (encode(request) + '\n').encode('utf-8')
        self.assertLessEqual(len(wire), 8192)
        result = subprocess.run([str(BINARY), 'run', str(HERE / 'worker.sprout'), '--max-steps', '1000000',
                                 '--timeout-ms', '3000'], cwd=HERE, input=wire, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b'')
        self.assertLessEqual(len(result.stdout), 16384)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertEqual(semantic(decode(result.stdout)), semantic(evaluate(request)))

    def test_import_requires_trusted_host_choice_and_oversize_input_stops_before_launch(self):
        with self.assertRaises(SproutError) as blocked:
            run(HERE / 'worker.sprout', CASES[0]['input'], **dict(OPTIONS, sandbox=True))
        self.assertEqual(blocked.exception.code, 'runtime')
        with self.assertRaises(SproutError) as oversized:
            run(HERE / 'worker.sprout', {'padding': 'x' * 8192}, **dict(OPTIONS, command='missing-order-quote-worker'))
        self.assertEqual(oversized.exception.code, 'input-limit')


if __name__ == '__main__': unittest.main()
