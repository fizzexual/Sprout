"""Bounded CSV import dry-run controls; ordinary local inputs, no storage writes."""
import json
import csv
from decimal import Decimal
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else
              ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()
PROGRAM = ROOT / 'examples/imports/orders-dry-run.sprout'
MODULE = ROOT / 'examples/imports/order_csv.sprout'


def exact(value):
    if isinstance(value, list): return [exact(item) for item in value]
    if isinstance(value, dict):
        if set(value) == {'$sprout.integer'}: return int(value['$sprout.integer'])
        if set(value) == {'$sprout.decimal'}: return Decimal(value['$sprout.decimal'])
        return {key: exact(item) for key, item in value.items()}
    return value


def csv_text(header, rows):
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\r\n')
    writer.writerow(header)
    writer.writerows(rows)
    return output.getvalue()


class NativeCSVBehavior(unittest.TestCase):
    def evaluate(self, body):
        with tempfile.TemporaryDirectory(prefix='csv-parser-contract-') as directory:
            source = Path(directory) / 'case.sprout'
            source.write_text(body, encoding='utf-8')
            result = subprocess.run([str(BINARY), '--sandbox', 'run', str(source),
                '--max-steps', '100000', '--timeout-ms', '2000'], capture_output=True, timeout=5)
            self.assertGreaterEqual(result.returncode, 0)
            if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
            self.assertEqual(result.stderr, b'')
            return json.loads(result.stdout)

    def test_existing_parser_empty_blank_trailing_and_quoted_records(self):
        cases = [('', []), ('\n', [['']]), ('a,b,\r\n', [['a', 'b', '']]),
                 ('a\rb\nc\r\n', [['a'], ['b'], ['c']]),
                 ('"Ada, 🌱","a""b","line\r\nnext"\n', [['Ada, 🌱', 'a"b', 'line\r\nnext']])]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(self.evaluate('show json_encode(csv_parse(' + json.dumps(text, ensure_ascii=False) + '))'), expected)

    def test_existing_parser_rejections_have_catchable_error_kind(self):
        for text in ('"open', 'unquoted"quote', '"closed"suffix', '"closed" ,next'):
            with self.subTest(text=text):
                result = self.evaluate('make kind = "not_rejected"\ntry:\n    make rows = csv_parse(' +
                    json.dumps(text) + ')\ncaught issue:\n    set kind = issue.kind\nshow json_encode(kind)')
                self.assertEqual(result, 'error')


class CSVImportExample(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='csv-import-example-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.input = self.directory / 'orders 🌱.csv'

    def execute(self, arguments, *, program=PROGRAM, sandbox=False):
        result = subprocess.run([str(BINARY), *(['--sandbox'] if sandbox else []), 'run', str(program),
            '--max-steps', '5000000', '--timeout-ms', '5000', '--', *map(str, arguments)],
            cwd=self.directory, capture_output=True, timeout=12)
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertGreaterEqual(result.returncode, 0)
        if os.name == 'nt': self.assertLess(result.returncode, 0x80000000)
        self.assertIn(result.returncode, (0, 2), result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        return result

    def dry_run(self, text, *, expected_ok=None):
        data = text.encode('utf-8') if isinstance(text, str) else text
        self.input.write_bytes(data)
        previous_mtime = self.input.stat().st_mtime_ns
        result = self.execute([self.input])
        wire = json.loads(result.stdout)
        report = exact(wire)
        self.assertEqual(result.returncode, 0 if report['ok'] else 2)
        if expected_ok is not None: self.assertIs(report['ok'], expected_ok)
        self.assertEqual(self.input.read_bytes(), data)
        self.assertEqual(self.input.stat().st_mtime_ns, previous_mtime)
        self.assertEqual(list(self.directory.iterdir()), [self.input], 'Dry-run published a file')
        self.assertEqual(set(report), {'ok', 'row_count', 'valid_rows', 'error_count', 'errors', 'truncated', 'preview', 'totals'})
        self.assertEqual(len(report['errors']), min(report['error_count'], 64))
        self.assertIs(report['truncated'], report['error_count'] > 64)
        if not report['ok']: self.assertIsNone(report['totals'])
        return report, wire

    def simple(self, identifier='1', amount='0.10', *, name='Ada', currency='USD', note=None):
        header = ['id', 'name', 'amount', 'currency']
        row = [identifier, name, amount, currency]
        if note is not None: header.append('note'); row.append(note)
        return csv_text(header, [row])

    def test_reordered_headers_quotes_unicode_and_exact_totals_match_independent_csv_oracle(self):
        header = ['currency', 'note', 'name', 'amount', 'id']
        rows = [['USD', 'quoted "note"\r\nsecond line', 'Ada, 🌱', '0.10', '9007199254740993'],
                ['EUR', '', 'Zoë', '19.95', '9223372036854775807'],
                ['USD', 'third', 'Ivy', '0.20', '2']]
        text = csv_text(header, rows)
        decoded = list(csv.DictReader(io.StringIO(text, newline='')))
        report, wire = self.dry_run(text, expected_ok=True)
        self.assertEqual(report['row_count'], 3)
        self.assertEqual(report['valid_rows'], 3)
        self.assertEqual(report['preview'], [dict(id=int(row['id']), name=row['name'], amount=Decimal(row['amount']),
            currency=row['currency'], note=row['note'] or None) for row in decoded])
        self.assertEqual(report['totals'], {currency: sum((Decimal(row['amount']) for row in decoded if row['currency'] == currency), Decimal(0)) for currency in ('USD', 'EUR')})
        self.assertEqual(wire['preview'][0]['id'], {'$sprout.integer': '9007199254740993'})
        self.assertEqual(wire['preview'][1]['id'], {'$sprout.integer': '9223372036854775807'})
        self.assertIn('$sprout.decimal', wire['totals']['USD'])

    def test_empty_and_header_only_policy_and_optional_note(self):
        empty, _ = self.dry_run('', expected_ok=False)
        self.assertEqual(empty['errors'][0]['code'], 'header')
        self.assertIsNone(empty['row_count'])
        header, _ = self.dry_run('id,name,amount,currency\n', expected_ok=True)
        self.assertEqual((header['row_count'], header['valid_rows'], header['preview']), (0, 0, []))
        self.assertEqual(header['totals'], {'USD': Decimal(0), 'EUR': Decimal(0)})
        absent, _ = self.dry_run(self.simple(), expected_ok=True)
        self.assertNotIn('note', absent['preview'][0])
        empty_note, _ = self.dry_run(self.simple(note=''), expected_ok=True)
        self.assertIsNone(empty_note['preview'][0]['note'])

    def test_headers_reject_duplicates_unknown_missing_and_implicit_normalization(self):
        for header in (['id', 'name', 'amount', 'name'], ['id', 'name', 'amount', 'private-header'],
                       ['id', 'name', 'amount'], ['id', ' name', 'amount', 'currency'],
                       ['ID', 'name', 'amount', 'currency'], ['id', 'name', 'amount', 'currency', 'note', 'extra']):
            with self.subTest(header=header):
                report, _ = self.dry_run(csv_text(header, []), expected_ok=False)
                self.assertEqual(report['errors'][0]['path'], ['header'])
                self.assertEqual(report['errors'][0]['code'], 'header')
                self.assertNotIn('private-header', json.dumps(report))
        report, _ = self.dry_run('\ufeff' + self.simple(), expected_ok=True)
        self.assertEqual(report['valid_rows'], 1)

    def test_blank_rows_and_width_errors_are_real_csv_records(self):
        report, _ = self.dry_run('id,name,amount,currency\n\n1,Ada,0.10,USD\n', expected_ok=False)
        self.assertEqual((report['row_count'], report['valid_rows']), (2, 1))
        self.assertEqual(report['errors'][0]['record'], 2)
        self.assertEqual(report['errors'][0]['code'], 'row_width')
        for cells in (['1', 'Ada', '0.10'], ['1', 'Ada', '0.10', 'USD', 'extra']):
            report, _ = self.dry_run(csv_text(['id', 'name', 'amount', 'currency'], [cells]), expected_ok=False)
            self.assertEqual(report['errors'][0]['code'], 'row_width')

    def test_record_numbers_do_not_claim_physical_lines_after_quoted_newline(self):
        text = csv_text(['id', 'name', 'amount', 'currency', 'note'],
                        [['1', 'Ada', '0.10', 'USD', 'one\r\ntwo'], ['2', 'Ivy', 'bad', 'USD', '']])
        report, _ = self.dry_run(text, expected_ok=False)
        self.assertEqual(report['errors'][0]['record'], 3)
        self.assertEqual(report['errors'][0]['path'], ['amount'])
        self.assertEqual(report['preview'][0]['note'], 'one\r\ntwo')

    def test_exact_identifier_syntax_and_range(self):
        for identifier in ('0', '01', '+1', '-1', '1.0', '1e3', '', ' 1', '1 ', '99999999999999999999'):
            with self.subTest(identifier=identifier):
                report, _ = self.dry_run(self.simple(identifier), expected_ok=False)
                self.assertEqual(report['errors'][0]['code'], 'id_format')
        report, _ = self.dry_run(self.simple('9223372036854775808'), expected_ok=False)
        self.assertEqual(report['errors'][0]['code'], 'id_range')

    def test_exact_money_syntax_and_cents_range(self):
        for amount in ('1', '1.0', '1.000', '01.00', '+1.00', '-0.01', '1e1.00', 'NaN', ' 1.00', '1.00 ', '0.1x'):
            with self.subTest(amount=amount):
                report, _ = self.dry_run(self.simple(amount=amount), expected_ok=False)
                self.assertEqual(report['errors'][0]['code'], 'amount_format')
        report, _ = self.dry_run(self.simple(amount='92233720368547758.08'), expected_ok=False)
        self.assertEqual(report['errors'][0]['code'], 'amount_range')
        for amount in ('0.00', '0.01', '92233720368547758.07'):
            report, _ = self.dry_run(self.simple(amount=amount), expected_ok=True)
            self.assertEqual(report['totals']['USD'], Decimal(amount))

    def test_aggregate_field_errors_never_echo_rejected_cell_values(self):
        text = csv_text(['id', 'name', 'amount', 'currency', 'note'],
            [['private-id', ' ', 'private-amount', 'private-currency', 'private-note-' + 'x' * 200],
             ['2', 'Valid', '0.10', 'USD', '']])
        report, wire = self.dry_run(text, expected_ok=False)
        self.assertEqual(report['error_count'], 5)
        self.assertEqual({tuple(issue['path']) for issue in report['errors']}, {('id',), ('name',), ('amount',), ('currency',), ('note',)})
        self.assertTrue(all(issue['record'] == 2 for issue in report['errors']))
        self.assertNotIn('private-', json.dumps(wire))
        self.assertEqual(report['valid_rows'], 1)

    def test_duplicate_ids_include_correct_first_record_even_if_other_fields_invalid(self):
        text = csv_text(['id', 'name', 'amount', 'currency'],
                        [['1', '', '0.10', 'USD'], ['1', 'Ivy', '0.20', 'USD'], ['2', 'Valid', '0.30', 'USD']])
        report, _ = self.dry_run(text, expected_ok=False)
        duplicate = next(issue for issue in report['errors'] if issue['code'] == 'duplicate_id')
        self.assertEqual((duplicate['record'], duplicate['first_record'], duplicate['path']), (3, 2, ['id']))
        self.assertEqual(report['valid_rows'], 1)
        self.assertEqual(report['preview'][0]['id'], 2)

    def test_currency_totals_enforce_cents_range_even_when_decimal_scale_would_normalize(self):
        for increment in ('0.01', '0.03'):
            report, _ = self.dry_run(csv_text(['id', 'name', 'amount', 'currency'],
                [['1', 'Ada', '92233720368547758.07', 'USD'], ['2', 'Ivy', increment, 'USD']]), expected_ok=False)
            self.assertEqual(report['valid_rows'], 2)
            self.assertEqual(report['error_count'], 1)
            self.assertEqual(report['errors'][0]['path'], ['totals', 'USD'])
            self.assertEqual(report['errors'][0]['code'], 'total_range')
        report, _ = self.dry_run(csv_text(['id', 'name', 'amount', 'currency'],
            [['1', 'Ada', '92233720368547758.07', 'USD'], ['2', 'Ivy', '92233720368547758.07', 'EUR']]), expected_ok=True)
        self.assertEqual(report['totals']['USD'], report['totals']['EUR'])

    def test_error_count_is_honest_beyond_reported_cap_and_later_valid_rows_are_checked(self):
        report, _ = self.dry_run(csv_text(['id', 'name', 'amount', 'currency'],
            [['0', 'Ada', '0.10', 'USD']] * 70 + [['71', 'Valid', '0.20', 'USD']]), expected_ok=False)
        self.assertEqual((report['row_count'], report['valid_rows'], report['error_count']), (71, 1, 70))
        self.assertEqual(len(report['errors']), 64)
        self.assertTrue(report['truncated'])
        self.assertEqual(report['preview'][0]['id'], 71)

    def test_record_preview_and_field_boundaries(self):
        valid_rows = [[str(i + 1), 'A', '0.01', 'USD'] for i in range(1000)]
        report, _ = self.dry_run(csv_text(['id', 'name', 'amount', 'currency'], valid_rows), expected_ok=True)
        self.assertEqual((report['row_count'], report['valid_rows'], len(report['preview'])), (1000, 1000, 10))
        self.assertEqual(report['totals']['USD'], Decimal('10.00'))
        over, _ = self.dry_run(csv_text(['id', 'name', 'amount', 'currency'], valid_rows + [['1001', 'A', '0.01', 'USD']]), expected_ok=False)
        self.assertEqual(over['errors'][0]['code'], 'row_limit')
        self.assertEqual((over['row_count'], over['valid_rows'], over['preview']), (1001, 0, []))
        self.dry_run(self.simple(name='🌱' * 80, note='x' * 200), expected_ok=True)
        over, _ = self.dry_run(self.simple(name='🌱' * 81, note='x' * 201), expected_ok=False)
        self.assertEqual(over['error_count'], 2)

    def test_encoding_parse_and_size_failures_have_fixed_reports(self):
        for invalid in (b'\xff', b'id,name,amount,currency\n1,A\x00da,0.10,USD'):
            report, _ = self.dry_run(invalid, expected_ok=False)
            self.assertEqual(report['errors'][0]['code'], 'input_encoding')
        for malformed in ('"open', 'id,name,amount,currency\n1,"Ada"suffix,0.10,USD'):
            report, _ = self.dry_run(malformed, expected_ok=False)
            self.assertEqual(report['errors'][0]['code'], 'csv_parse')
            self.assertIsNone(report['row_count'])
        characters, _ = self.dry_run('x' * 65537, expected_ok=False)
        self.assertEqual(characters['errors'][0]['code'], 'input_characters')
        byte_limit, _ = self.dry_run('🌱' * 65537, expected_ok=False)
        self.assertEqual(byte_limit['errors'][0]['code'], 'input_io')
        at_limit, _ = self.dry_run('🌱' * 65536, expected_ok=False)
        self.assertEqual(at_limit['errors'][0]['code'], 'header')

    def test_cli_help_argument_errors_and_missing_input_publish_nothing(self):
        self.assertIn(b'Usage: orders-dry-run', self.execute(['--help']).stdout)
        for arguments, code in (([], 'arguments'), (['--unknown'], 'arguments'),
                                ([self.directory / 'missing.csv'], 'input_io')):
            result = self.execute(arguments)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)['errors'][0]['code'], code)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_pure_supplied_sandbox_adapter_is_deterministic_and_does_not_mutate_input(self):
        validator = (ROOT / 'lib/validate.sprout').read_text(encoding='utf-8')
        importer = MODULE.read_text(encoding='utf-8').replace('use csv\n', '').replace('use "../../lib/validate.sprout"\n', '')
        importer = importer.replace('validate.check(', 'csv_validation_check(').replace('csv.parse(', 'csv_parse(')
        importer = importer.replace('public task check(text):', 'public task csv_import_check(text):')
        importer = importer.replace('public make check = check', 'public make csv_import_check = csv_import_check')
        text = self.simple('9007199254740993', '0.10')
        source = self.directory / 'supplied.sprout'
        source.write_text(validator + '\nprivate make csv_validation_check = check\n' + importer +
            '\nmake input = ' + json.dumps(text, ensure_ascii=False) + '\nmake before = bytes_hex(bytes(input))\n' +
            'make first = csv_import_check(input)\nmake second = csv_import_check(input)\n' +
            'show json_encode({same: first == second, unchanged: before == bytes_hex(bytes(input)), report: first})\n', encoding='utf-8')
        result = exact(json.loads(self.execute([], program=source, sandbox=True).stdout))
        self.assertTrue(result['same']); self.assertTrue(result['unchanged'])
        self.assertTrue(result['report']['ok'])
        self.assertEqual(result['report']['preview'][0]['id'], 9007199254740993)
        self.assertEqual(list(self.directory.iterdir()), [source])

    def test_pure_helper_checks_encoding_before_character_operations(self):
        source = self.directory / 'pure.sprout'
        source.write_text('use ' + json.dumps(MODULE.as_posix(), ensure_ascii=False) + '\n'
            'show json_encode([order_csv.check(42), order_csv.check(char(255)), order_csv.check("x" * 262145)])\n', encoding='utf-8')
        reports = json.loads(self.execute([], program=source).stdout)
        self.assertEqual([report['errors'][0]['code'] for report in reports], ['input_kind', 'input_encoding', 'input_bytes'])
        self.assertTrue(all(not report['ok'] and report['error_count'] == 1 and not report['truncated'] for report in reports))
        self.assertEqual(list(self.directory.iterdir()), [source])


if __name__ == '__main__': unittest.main()
