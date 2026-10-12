"""Bounded real-native contacts API contracts, using fresh loopback-only state."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from sprout_host import run
from sprout_service import SproutHandler, SproutServer

ROOT = Path(__file__).resolve().parents[2]
PROGRAM = ROOT / 'examples/services/contacts_api.sprout'
COMMAND = os.environ.get('SPROUT_COMMAND')


@unittest.skipUnless(COMMAND, 'set SPROUT_COMMAND to a native SQLite-enabled build')
class ContactsApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-contacts-api-')
        self.root = Path(self.temp.name)
        self.database = self.root / 'contacts-api.sqlite'
        self.old_database = self.root / 'contacts.sqlite'
        self.old_database.write_bytes(b'old example state must remain unchanged')
        self.old_source_hash = hashlib.sha256((ROOT / 'examples/services/contacts.sprout').read_bytes()).hexdigest()
        self.server = self.thread = None
        self.start()

    def start(self):
        self.server = SproutServer(('127.0.0.1', 0), PROGRAM, command=COMMAND,
                                  allow_io=True, workers=8, timeout_ms=4000,
                                  max_body=4096, cwd=self.root)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': .01}, daemon=True)
        self.thread.start()

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            self.assertFalse(self.thread.is_alive(), 'listener did not finish')
            self.server = None

    def tearDown(self):
        try:
            self.stop()
            self.assertEqual(self.old_database.read_bytes(), b'old example state must remain unchanged')
            self.assertEqual(hashlib.sha256((ROOT / 'examples/services/contacts.sprout').read_bytes()).hexdigest(), self.old_source_hash)
        finally:
            self.temp.cleanup()

    def request(self, method='GET', path='/contacts', body=None):
        raw = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        with closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)) as client:
            client.request(method, path, raw, {'Content-Type': 'application/json', 'Connection': 'close'})
            response = client.getresponse()
            payload = response.read(65537)
            self.assertLessEqual(len(payload), 65536)
            self.assertEqual(response.getheader('Cache-Control'), 'no-store')
            return response.status, json.loads(payload)

    def create(self, key='first', name='Zoë', email='zoe@example.test'):
        return self.request('POST', body=dict(request_key=key, name=name, email=email))

    def rows(self):
        with closing(sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True, timeout=.1)) as database:
            self.assertEqual(database.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            return database.execute('SELECT id,request_key,name,email FROM contacts_api ORDER BY id').fetchall()

    def test_creation_replay_and_duplicate_email_do_not_consume_rejected_key(self):
        name = "Robert'); DROP TABLE contacts_api;-- 李雷"
        first = self.create(name=name, email="o'reilly@example.test")
        self.assertEqual(first, (201, {'contact': {'id': '1', 'name': name, 'email': "o'reilly@example.test"}, 'replayed': False}))
        self.assertEqual(self.create(name=name, email="o'reilly@example.test"),
                         (200, dict(first[1], replayed=True)))
        self.assertEqual(self.create('second', 'Ada', "o'reilly@example.test"),
                         (409, {'error': 'email_conflict'}))
        self.assertEqual(self.rows(), [(1, 'first', name, "o'reilly@example.test")])
        self.assertEqual(self.create('second', 'Ada', 'ada@example.test')[0], 201)
        self.assertEqual(len(self.rows()), 2)

    def test_key_payload_conflict_is_exact_and_precedes_other_email_conflicts(self):
        self.assertEqual(self.create()[0], 201)
        self.assertEqual(self.create('other', 'Other', 'other@example.test')[0], 201)
        for name, email in (('Changed', 'zoe@example.test'), ('Zoë ', 'zoe@example.test'),
                            ('Zoë', 'other@example.test'), ('Zoë', 'ZOe@example.test')):
            with self.subTest(name=name, email=email):
                self.assertEqual(self.create('first', name, email), (409, {'error': 'request_key_conflict'}))
        self.assertEqual(self.rows(), [(1, 'first', 'Zoë', 'zoe@example.test'), (2, 'other', 'Other', 'other@example.test')])

    def parallel(self, bodies):
        barrier = threading.Barrier(len(bodies))
        def post(body):
            barrier.wait(timeout=3)
            return self.request('POST', body=body)
        with ThreadPoolExecutor(max_workers=len(bodies)) as executor:
            return list(executor.map(post, bodies))

    def test_concurrent_same_key_and_fresh_schema_have_one_first_creation(self):
        body = dict(request_key='shared', name='Shared 🌱', email='shared@example.test')
        results = self.parallel([body] * 8)
        self.assertEqual(sorted(status for status, _ in results), [200] * 7 + [201])
        self.assertEqual(sum(not value['replayed'] for _, value in results), 1)
        self.assertTrue(all(value['contact'] == results[0][1]['contact'] for _, value in results))
        self.assertEqual(self.rows(), [(1, 'shared', 'Shared 🌱', 'shared@example.test')])
        with closing(sqlite3.connect(self.database)) as database:
            self.assertEqual(database.execute('SELECT version,statement_count FROM _sprout_migrations').fetchall(), [(1, 1)])

    def test_concurrent_changed_payload_same_key_keeps_only_winning_payload(self):
        bodies = [dict(request_key='shared', name='First', email='first@example.test'),
                  dict(request_key='shared', name='Second', email='second@example.test')]
        results = self.parallel(bodies)
        self.assertEqual(sorted(status for status, _ in results), [201, 409])
        winner = next(value['contact'] for status, value in results if status == 201)
        self.assertEqual(next(value for status, value in results if status == 409), {'error': 'request_key_conflict'})
        self.assertEqual(self.rows(), [(1, 'shared', winner['name'], winner['email'])])

    def test_dropped_created_reply_replays_durably_after_listener_restart(self):
        observed = threading.Event()
        respond = SproutHandler.respond
        def drop_created(handler, status, body, headers=None):
            if status == 201:
                observed.set()  # Actual native transaction committed; omit delivery.
                return
            return respond(handler, status, body, headers)
        with patch.object(SproutHandler, 'respond', drop_created):
            with self.assertRaises(http.client.RemoteDisconnected):
                self.create('lost-reply')
            self.assertTrue(observed.wait(timeout=1))
        self.assertEqual(self.rows(), [(1, 'lost-reply', 'Zoë', 'zoe@example.test')])
        self.stop(); self.start()
        self.assertEqual(self.create('lost-reply'), (200, {'contact': {'id': '1', 'name': 'Zoë', 'email': 'zoe@example.test'}, 'replayed': True}))
        self.assertEqual(len(self.rows()), 1)

    def test_keyset_pages_are_bounded_and_cover_sparse_ids_without_duplicates(self):
        self.assertEqual(self.request(), (200, {'contacts': [], 'has_more': False, 'next_after': None}))
        expected = [(2 * n + 1, 'seed-%d' % n, 'Contact %d' % n, 'seed-%d@example.test' % n) for n in range(53)]
        with closing(sqlite3.connect(self.database)) as database:
            database.executemany('INSERT INTO contacts_api VALUES(?,?,?,?)', expected); database.commit()
        self.assertEqual(len(self.request()[1]['contacts']), 25)
        collected = []; after = '0'
        for _ in range(6):
            status, page = self.request(path='/contacts?limit=10&after=' + after)
            self.assertEqual(status, 200); self.assertLessEqual(len(page['contacts']), 10)
            self.assertEqual(set(page), {'contacts', 'has_more', 'next_after'})
            collected.extend(page['contacts'])
            if not page['has_more']:
                self.assertIsNone(page['next_after']); break
            self.assertEqual(page['next_after'], page['contacts'][-1]['id']); after = page['next_after']
        self.assertEqual(collected, [dict(id=str(row[0]), name=row[2], email=row[3]) for row in expected])
        self.assertEqual(self.request(path='/contacts?after=9223372036854775807')[1]['contacts'], [])

    def test_exact_int64_cursor_does_not_round_above_floating_integer_range(self):
        self.assertEqual(self.request()[0], 200)
        rows = [(9007199254740993, 'high', 'High', 'high@example.test'),
                (9223372036854775807, 'maximum', 'Maximum', 'maximum@example.test')]
        with closing(sqlite3.connect(self.database)) as database:
            database.executemany('INSERT INTO contacts_api VALUES(?,?,?,?)', rows); database.commit()
        status, page = self.request(path='/contacts?after=9007199254740992&limit=1')
        self.assertEqual(status, 200); self.assertEqual(page['contacts'][0]['id'], '9007199254740993')
        self.assertTrue(page['has_more']); self.assertEqual(page['next_after'], '9007199254740993')
        status, page = self.request(path='/contacts?after=' + page['next_after'] + '&limit=1')
        self.assertEqual(status, 200); self.assertEqual(page['contacts'][0]['id'], '9223372036854775807')
        self.assertFalse(page['has_more'])

    def test_exhausted_int64_ids_reject_new_key_without_lower_id_or_consumption(self):
        self.assertEqual(self.request()[0], 200)
        maximum = (9223372036854775807, 'maximum', 'Maximum', 'maximum@example.test')
        with closing(sqlite3.connect(self.database)) as database:
            database.execute('INSERT INTO contacts_api VALUES(?,?,?,?)', maximum); database.commit()
        self.assertEqual(self.create('after-max', 'Other', 'other@example.test'),
                         (503, {'error': 'storage_unavailable'}))
        self.assertEqual(self.rows(), [maximum])
        self.assertEqual(self.create('maximum', 'Maximum', 'maximum@example.test'),
                         (200, {'contact': {'id': '9223372036854775807', 'name': 'Maximum', 'email': 'maximum@example.test'}, 'replayed': True}))
        self.assertEqual(self.rows(), [maximum])
        with closing(sqlite3.connect(self.database)) as database:
            self.assertEqual(database.execute('SELECT name,seq FROM sqlite_sequence').fetchall(), [('contacts_api', 9223372036854775807)])

    def test_invalid_fields_routes_and_queries_are_rejected_before_database_creation(self):
        valid = dict(request_key='valid', name='Ada', email='ada@example.test')
        bodies = [None, [], 'text', {}, {'request_key': 'valid', 'name': 'Ada'}, dict(valid, unknown=True), dict(valid, request_key=''),
                  dict(valid, request_key='x' * 65), dict(valid, request_key='🌱'), dict(valid, request_key=True),
                  dict(valid, name=''), dict(valid, name='  '), dict(valid, name='bad\nname'),
                  dict(valid, name='🌱' * 101), dict(valid, name=1), dict(valid, email='@host'),
                  dict(valid, email='local@'), dict(valid, email='two@@host'), dict(valid, email='with space@host'),
                  dict(valid, email='café@host'), dict(valid, email='x' * 253 + '@x'), dict(valid, email=False)]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.request('POST', body=body), (400, {'error': 'invalid_request'}))
                self.assertFalse(self.database.exists())
        for query in ('unknown=1', 'limit=0', 'limit=51', 'limit=01', 'limit=-1', 'limit=1.5',
                      'limit=1&limit=2', 'after=1&after=2', 'after=-1', 'after=00',
                      'after=9223372036854775808', 'after=99999999999999999999', 'after=%27OR%201%3D1'):
            with self.subTest(query=query):
                self.assertEqual(self.request(path='/contacts?' + query), (400, {'error': 'invalid_request'}))
                self.assertFalse(self.database.exists())
        self.assertEqual(self.request(path='/other'), (404, {'error': 'route_not_found'}))
        self.assertEqual(self.request('PUT'), (405, {'error': 'method_not_supported'}))
        self.assertEqual(self.request('POST', '/contacts?limit=1', valid), (400, {'error': 'invalid_request'}))
        self.assertEqual(self.request(body={'not': 'empty'}), (400, {'error': 'invalid_request'}))
        self.assertFalse(self.database.exists())

    def test_direct_protocol_wrong_types_and_unknown_fields_do_not_create_storage(self):
        valid = dict(method='GET', path='/contacts', query={}, body=None)
        for request in (None, [], dict(valid, query=[]), dict(valid, method=1), dict(valid, path=False),
                        dict(valid, unknown=True), dict(method='GET', path='/contacts', body=None),
                        dict(valid, query={'limit': '1'}), dict(valid, query={'after': [True]})):
            with self.subTest(request=request):
                result = run(PROGRAM, request, command=COMMAND, cwd=self.root, sandbox=False,
                             timeout_ms=4000, runtime_timeout_ms=3000, max_steps=100000)
                self.assertEqual(result, {'status': 400, 'headers': {'Cache-Control': 'no-store'}, 'body': {'error': 'invalid_request'}})
                self.assertFalse(self.database.exists())

    def test_field_caps_are_accepted_and_blank_query_values_match_bridge_omission(self):
        key, name, email = 'k' * 64, '🌱' * 100, 'x' * 252 + '@x'
        self.assertEqual(self.create(key, name, email)[0], 201)
        self.assertEqual(self.rows(), [(1, key, name, email)])
        self.assertEqual(self.request(path='/contacts?after=&limit=')[1], self.request()[1])
        with closing(sqlite3.connect(self.database)) as database:
            database.executemany('INSERT INTO contacts_api(request_key,name,email) VALUES(?,?,?)',
                                 [('cap-%d' % n, name, 'x' * 249 + '%03d@x' % n) for n in range(50)])
            database.commit()
        status, page = self.request(path='/contacts?limit=50')
        self.assertEqual(status, 200); self.assertEqual(len(page['contacts']), 50)
        self.assertTrue(page['has_more']); self.assertEqual(page['next_after'], '50')
        status, final = self.request(path='/contacts?limit=50&after=50')
        self.assertEqual(status, 200); self.assertEqual(len(final['contacts']), 1)
        self.assertFalse(final['has_more']); self.assertIsNone(final['next_after'])

    def test_busy_storage_is_bounded_does_not_consume_key_and_recovers(self):
        self.assertEqual(self.request()[0], 200)
        with closing(sqlite3.connect(self.database, timeout=.1)) as holder:
            holder.execute('BEGIN IMMEDIATE')
            started = time.monotonic()
            self.assertEqual(self.create('busy'), (503, {'error': 'storage_unavailable'}))
            self.assertLess(time.monotonic() - started, 3)
            holder.rollback()
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.create('busy')[0], 201)
        self.assertEqual(len(self.rows()), 1)

    def test_out_of_band_schema_drift_is_refused_without_contact_writes(self):
        self.assertEqual(self.create()[0], 201)
        with closing(sqlite3.connect(self.database)) as database:
            database.execute('ALTER TABLE contacts_api ADD COLUMN surprise TEXT'); database.commit()
        self.assertEqual(self.request(), (503, {'error': 'storage_unavailable'}))
        self.assertEqual(self.create('other', 'Other', 'other@example.test'), (503, {'error': 'storage_unavailable'}))
        self.assertEqual(self.rows(), [(1, 'first', 'Zoë', 'zoe@example.test')])

    def test_existing_foreign_or_unversioned_schema_is_not_adopted_or_changed(self):
        for definition in ('CREATE TABLE foreign_data(value TEXT)',
                           'CREATE TABLE contacts_api(id INTEGER PRIMARY KEY,name TEXT)'):
            with self.subTest(definition=definition):
                with closing(sqlite3.connect(self.database)) as database:
                    database.execute(definition); database.commit()
                    previous = database.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').fetchall()
                digest = hashlib.sha256(self.database.read_bytes()).hexdigest()
                self.assertEqual(self.request(), (503, {'error': 'storage_unavailable'}))
                self.assertEqual(self.create(), (503, {'error': 'storage_unavailable'}))
                with closing(sqlite3.connect(self.database)) as database:
                    self.assertEqual(database.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').fetchall(), previous)
                self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), digest)
                self.database.unlink()


if __name__ == '__main__':
    unittest.main()
