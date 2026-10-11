"""Real SQLite migration transactions, adversarial supplied SQL, and recovery."""
import copy
from contextlib import closing
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

BINARY = pathlib.Path(sys.argv.pop(1) if len(sys.argv) > 1 else
                      pathlib.Path(__file__).parents[1] / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()
LEDGER = '_sprout_migrations'


def integer(value):
    return {'$sprout.integer': str(value)}


def plain(value):
    if isinstance(value, dict):
        if list(value) == ['$sprout.integer']:
            return int(value['$sprout.integer'])
        return {key: plain(child) for key, child in value.items()}
    if isinstance(value, list):
        return [plain(child) for child in value]
    return value


def migration(version=1, statements=None, name='schema'):
    return {'version': version, 'name': name, 'statements': statements or [
        {'sql': 'CREATE TABLE items(id INTEGER PRIMARY KEY, body TEXT UNIQUE)'},
        {'sql': 'INSERT INTO items(body) VALUES(?)', 'params': ["first ' literal"]},
    ]}


class Migrations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-migrations-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.db = self.root / 'test.db'

    def run_program(self, source, request=None, *flags):
        program = self.root/'app.sprout'
        program.write_text(source, encoding='utf-8')
        result = subprocess.run([str(BINARY), 'run', str(program), *flags], cwd=self.root,
                                input=None if request is None else json.dumps(request).encode(),
                                capture_output=True, timeout=15)
        self.assertGreaterEqual(result.returncode, 0, 'crash signal: ' + repr(result.stderr))
        if os.name == 'nt':
            self.assertLess(result.returncode, 0x80000000, 'Windows crash: ' + repr(result.stderr))
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout+result.stderr)
        return result

    def call(self, history, options=None, extra='', read_only=False, *flags):
        source = '''use sqlite
make request = json_decode(read_input())
make opened = sqlite.open("test.db", {read_only: READONLY})
show json_encode(opened)
when opened.ok:
    make db = opened.handle
    show json_encode(sqlite.migrate(db, request.history, request.options))
EXTRA
    show json_encode(sqlite.close(db))
'''.replace('READONLY', 'yes' if read_only else 'no').replace('EXTRA', extra)
        result = self.run_program(source, {'history': history, 'options': options or {}}, *flags)
        self.assertEqual(result.returncode, 0, repr(result.stderr))
        lines = [plain(json.loads(line)) for line in result.stdout.splitlines()]
        self.assertTrue(lines[0]['ok'], lines)
        return lines[1], lines[2:-1]

    def tables(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def rows(self, table='items'):
        with closing(sqlite3.connect(self.db)) as db, db:
            return db.execute('SELECT * FROM "'+table+'"').fetchall()

    def test_ordered_versions_atomic_schema_params_and_idempotent_repeat(self):
        history = [migration(), migration(3, [{'sql': 'ALTER TABLE items ADD COLUMN note TEXT'},
                     {'sql': 'UPDATE items SET note=? WHERE id=?', 'params': ['changed', integer(1)]}], 'upgrade')]
        result, extra = self.call(history, extra='    show json_encode(sqlite.migrations(db))')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['applied'], [1, 3])
        self.assertEqual(result['current_version'], 3)
        self.assertEqual(self.rows(), [(1, "first ' literal", 'changed')])
        self.assertEqual([row['version'] for row in extra[0]['entries']], [1, 3])
        self.assertTrue(all(len(row['checksum']) == 64 for row in extra[0]['entries']))
        again, _ = self.call(history)
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['applied'], [])
        self.assertEqual(len(self.rows(LEDGER)), 2)

    def test_exact_version_normalization_and_int64_maximum(self):
        original = [migration()]
        self.assertTrue(self.call(original)[0]['ok'])
        same = copy.deepcopy(original)
        same[0]['version'] = integer(1)
        self.assertTrue(self.call(same)[0]['ok'])
        same.append(migration(integer(9223372036854775807), [{'sql': 'INSERT INTO items(body) VALUES(?)', 'params':['last']}]))
        result, _ = self.call(same)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['current_version'], 9223372036854775807)
        self.assertEqual(self.rows(LEDGER)[-1][0], 9223372036854775807)

    def test_edited_deleted_reordered_and_typed_parameter_history_reject_before_changes(self):
        original = [migration(), migration(3, [{'sql':'INSERT INTO items(body) VALUES(?)','params':['third']}])]
        self.assertTrue(self.call(original)[0]['ok'])
        before = self.rows()
        variants = [original[:1], original[1:], []]
        for field in ('name', 'sql', 'params', 'type'):
            history = copy.deepcopy(original)
            if field == 'name': history[0]['name'] = 'edited'
            elif field == 'sql': history[0]['statements'][0]['sql'] += ' '
            elif field == 'params': history[0]['statements'][1]['params'] = ['different']
            else: history[0]['statements'][1]['params'] = [integer(1)]
            variants.append(history)
        reordered = copy.deepcopy(original)
        reordered[0]['statements'].reverse()
        variants.append(reordered)
        for history in variants:
            with self.subTest(history=history):
                result, _ = self.call(history)
                self.assertFalse(result['ok'], result)
                self.assertTrue(result['rolled_back'])
                self.assertEqual(self.rows(), before)
                self.assertEqual(len(self.rows(LEDGER)), 2)

    def test_same_parameter_value_with_changed_exact_type_changes_checksum(self):
        history = [migration(statements=[{'sql':'SELECT ?','params':[1]}])]
        self.assertTrue(self.call(history)[0]['ok'])
        history[0]['statements'][0]['params'] = [integer(1)]
        result, _ = self.call(history)
        self.assertFalse(result['ok'], result)
        self.assertIn('edited', result['error'])
        self.assertEqual(len(self.rows(LEDGER)), 1)

    def test_all_pending_versions_roll_back_on_sql_failure_and_recover(self):
        baseline = [migration()]
        self.assertTrue(self.call(baseline)[0]['ok'])
        history = baseline + [migration(2,[{'sql':'INSERT INTO items(body) VALUES(?)','params':['second']}]),
                              migration(3,[{'sql':'INSERT INTO missing_table VALUES(1)'}])]
        result, _ = self.call(history)
        self.assertFalse(result['ok'], result)
        self.assertEqual(result['migration_version'], 3)
        self.assertEqual(result['statement'], 0)
        self.assertTrue(result['rolled_back'])
        self.assertEqual(self.rows(), [(1,"first ' literal")])
        self.assertEqual(len(self.rows(LEDGER)), 1)
        history[-1]['statements'] = [{'sql':'INSERT INTO items(body) VALUES(?)','params':['third']}]
        result, _ = self.call(history)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['applied'], [2,3])

    def test_first_run_failure_rolls_back_ledger_and_schema_together(self):
        result, _ = self.call([migration(), migration(2,[{'sql':'SELECT * FROM missing_table'}])])
        self.assertFalse(result['ok'])
        self.assertTrue(result['rolled_back'])
        self.assertEqual(self.tables(), set())

    def test_transaction_attach_and_pragma_escape_are_rejected_with_recovery(self):
        attacks = ['COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT escape', "ATTACH DATABASE 'escape.db' AS escaped",
                   'PRAGMA writable_schema=ON', 'PRAGMA foreign_keys=OFF', 'PRAGMA journal_mode=OFF',
                   "SELECT load_extension('nope')"]
        for sql in attacks:
            with self.subTest(sql=sql):
                result, extra = self.call([migration(statements=[{'sql':'CREATE TABLE safe(id INTEGER)'},{'sql':sql}])],
                    extra='    show json_encode(sqlite.execute(db, "SELECT 42"))')
                self.assertFalse(result['ok'], result)
                self.assertTrue(result['rolled_back'])
                self.assertTrue(extra[0]['ok'], extra)
                self.assertEqual(self.tables(), set())
                self.assertFalse((self.root/'escape.db').exists())

    def test_ledger_write_trigger_case_alias_and_rename_attacks_are_denied(self):
        self.assertTrue(self.call([migration()])[0]['ok'])
        attacks = ["DELETE FROM main._SPROUT_MIGRATIONS", "SELECT * FROM _sprout_migrations",
                   'DROP TABLE _sprout_migrations', 'ALTER TABLE items RENAME TO _sprout_migrations_extra',
                   'CREATE TEMP TABLE _SPROUT_MIGRATIONS(x)',
                   'CREATE TRIGGER attacker AFTER INSERT ON items BEGIN DELETE FROM _sprout_migrations; END',
                   'CREATE INDEX attacker ON _sprout_migrations(name)']
        for sql in attacks:
            with self.subTest(sql=sql):
                result, _ = self.call([migration(),migration(2,[{'sql':sql}])])
                self.assertFalse(result['ok'], result)
                self.assertTrue(result['rolled_back'])
                self.assertEqual(len(self.rows(LEDGER)), 1)
                self.assertEqual(self.rows(), [(1,"first ' literal")])
        result, extra = self.call([migration()], extra='    show json_encode(sqlite.execute(db, "DELETE FROM _sprout_migrations"))')
        self.assertTrue(result['ok'])
        self.assertFalse(extra[0]['ok'])
        self.assertEqual(len(self.rows(LEDGER)), 1)

    def test_row_limit_across_pending_statements_rolls_back(self):
        history = [migration(statements=[{'sql':'CREATE TABLE t(x)'},{'sql':'SELECT 1'},{'sql':'SELECT 2'}])]
        result, _ = self.call(history, {'max_rows':1})
        self.assertFalse(result['ok'], result)
        self.assertTrue(result['rolled_back'])
        self.assertEqual(self.tables(), set())

    def test_serialized_output_limit_rolls_back_control_text(self):
        history = [migration(statements=[{'sql':'CREATE TABLE t(x)'},
            {'sql':"SELECT replace(hex(zeroblob(1000)), '0', char(1))"}])]
        result, _ = self.call(history, {'max_bytes':4096})
        self.assertFalse(result['ok'], result)
        self.assertTrue(result['rolled_back'])
        self.assertIn('serialized', result['error'])
        self.assertEqual(self.tables(), set())

    def test_timeout_rolls_back_all_pending_and_handle_recovers(self):
        history = [migration(statements=[{'sql':'CREATE TABLE t(x)'},
            {'sql':'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) INSERT INTO t SELECT x FROM n'}])]
        start = time.monotonic()
        result, extra = self.call(history, {'timeout_ms':40}, extra='    show json_encode(sqlite.execute(db, "SELECT 42"))')
        self.assertFalse(result['ok'], result)
        self.assertTrue(result['rolled_back'])
        self.assertTrue(result['timed_out'])
        self.assertLess(time.monotonic()-start, 5)
        self.assertTrue(extra[0]['ok'])
        self.assertEqual(self.tables(), set())
        self.assertTrue(self.call([migration()])[0]['ok'])

    def test_busy_begin_uses_migration_deadline_and_preserves_history(self):
        self.assertTrue(self.call([migration()])[0]['ok'])
        with closing(sqlite3.connect(self.db)) as other:
            other.execute('BEGIN IMMEDIATE')
            start = time.monotonic()
            result, _ = self.call([migration(),migration(2,[{'sql':'INSERT INTO items(body) VALUES(?)','params':['pending']}])], {'timeout_ms':40})
            self.assertFalse(result['ok'],result)
            self.assertLess(time.monotonic()-start,3)
            other.rollback()
        self.assertEqual(self.rows(),[(1,"first ' literal")])
        self.assertEqual(len(self.rows(LEDGER)),1)

    def test_reserved_namespace_literal_can_be_bound_as_data(self):
        history = [migration(statements=[{'sql':'CREATE TABLE items(id INTEGER PRIMARY KEY, body TEXT)'},
            {'sql':'INSERT INTO items(body) VALUES(?)','params':['_sprout_migrations is literal data']}])]
        result, _ = self.call(history)
        self.assertTrue(result['ok'],result)
        self.assertEqual(self.rows(),[(1,'_sprout_migrations is literal data')])

    def test_empty_history_and_readonly_ledger_read_do_not_create_table(self):
        result, extra = self.call([], extra='    show json_encode(sqlite.migrations(db))')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['applied'], [])
        self.assertEqual(result['current_version'], 0)
        self.assertEqual(extra[0]['entries'], [])
        self.assertFalse(extra[0]['exists'])
        self.assertEqual(self.tables(), set())
        self.assertTrue(self.call([migration()])[0]['ok'])
        result, extra = self.call([migration()], read_only=True, extra='    show json_encode(sqlite.migrations(db))')
        self.assertTrue(result['ok'], result)
        self.assertTrue(extra[0]['ok'])
        self.assertEqual(extra[0]['current_version'], 1)
        result, _ = self.call([migration(), migration(2,[{'sql':'INSERT INTO items(body) VALUES(?)','params':['readonly']}])], read_only=True)
        self.assertFalse(result['ok'], result)
        self.assertTrue(result['rolled_back'])

    def test_corrupt_schema_row_or_ledger_trigger_is_rejected(self):
        self.assertTrue(self.call([migration()])[0]['ok'])
        original = self.rows(LEDGER)[0]
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE _sprout_migrations SET checksum=?',('z'*64,))
        result, _ = self.call([migration()])
        self.assertFalse(result['ok'])
        self.assertIn('corrupt', result['error'])
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE _sprout_migrations SET checksum=?',(original[1],))
            db.execute('CREATE TRIGGER bad AFTER INSERT ON _sprout_migrations BEGIN DELETE FROM items; END')
        result, _ = self.call([migration()])
        self.assertFalse(result['ok'])
        self.assertIn('trigger', result['error'])
        self.assertEqual(self.rows(),[(1,"first ' literal")])
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('DROP TRIGGER bad')
            db.execute('ALTER TABLE _sprout_migrations ADD COLUMN corrupt TEXT')
        result, _ = self.call([migration()])
        self.assertFalse(result['ok'])
        self.assertIn('schema', result['error'])

    def test_invalid_requests_fail_before_any_migration_schema_changes(self):
        invalid = [[migration(0)], [migration(-1)], [migration(1.5)], [migration(),migration()],
                   [migration(3),migration(2)], [{'version':1,'statements':[]}],
                   [dict(migration(), unknown=True)], [{'version':1,'statements':[{'sql':'SELECT ?','params':[{}]}]}],
                   [migration(i+1,[{'sql':'SELECT 1'}]) for i in range(129)],
                   [migration(statements=[{'sql':'SELECT 1'}]*10001)]]
        for history in invalid:
            with self.subTest(history=history):
                source = 'use sqlite\nmake r=json_decode(read_input())\nmake o=sqlite.open("test.db")\nshow sqlite.migrate(o.handle,r)\n'
                result = self.run_program(source, history)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(self.tables(),set())

    def test_step_budget_failure_at_precommit_rolls_back(self):
        source = '''use sqlite
make opened = sqlite.open("test.db")
sqlite.migrate(opened.handle,[{version:1,statements:[{sql:"CREATE TABLE t(x)"}]}])
'''
        # Discover the interpreter's step boundary without fixing the test to an
        # incidental count of AST nodes. The diagnostic proves native work ran
        # and was rolled back at the commit guard, rather than rejected earlier.
        for limit in range(1,100):
            result = self.run_program(source, None, '--max-steps',str(limit))
            if b'migration commit requires remaining' in result.stderr:
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(self.tables(),set())
                ready = self.run_program(source, None, '--max-steps',str(limit+1))
                self.assertEqual(ready.returncode,0,repr(ready.stderr))
                self.assertEqual(self.tables(),{'t',LEDGER})
                break
        else:
            self.fail('Could not reach migration commit step-budget guard')

    def test_invalid_sql_text_returning_and_multi_statement_failure_roll_back(self):
        for sql in ("SELECT CAST(X'ff' AS TEXT)", 'SELECT 1; SELECT 2', 'SELECT ?'):
            with self.subTest(sql=sql):
                result, _ = self.call([migration(statements=[{'sql':'CREATE TABLE t(x)'},{'sql':sql}])])
                self.assertFalse(result['ok'], result)
                self.assertTrue(result['rolled_back'])
                self.assertEqual(self.tables(),set())


if __name__ == '__main__':
    unittest.main()
