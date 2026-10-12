"""Bounded recovery primitives; no live application, public service or soak."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tools'))
import service_recovery as RECOVERY


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'original.sqlite'
        with closing(sqlite3.connect(self.source)) as database:
            database.execute('CREATE TABLE contacts(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE)')
            database.execute('INSERT INTO contacts VALUES(1,?,?)', ('Zoë', 'recovery@example.test'))
            database.commit()

    def test_completed_backup_and_restore_preserve_exact_snapshot_identity(self):
        snapshot = RECOVERY.backup(self.source, self.root/'snapshot.sqlite')
        manifest = RECOVERY.seal_snapshot(snapshot)
        restored = self.root/'restored.sqlite'
        result = RECOVERY.restore(snapshot, manifest, restored)
        self.assertEqual(result['rows'], [(1, 'Zoë', 'recovery@example.test')])
        self.assertEqual(RECOVERY.file_hash(restored), manifest['database_sha256'])
        self.assertEqual(result['schema_sha256'], manifest['schema_sha256'])
        self.assertEqual(list(self.root.glob('*.partial')), [])

    def test_busy_backup_deadline_does_not_publish_partial_or_change_source(self):
        prior = self.source.read_bytes()
        with closing(sqlite3.connect(self.source, timeout=.01)) as holder:
            holder.execute('BEGIN EXCLUSIVE')
            started = time.monotonic()
            with self.assertRaisesRegex(AssertionError, 'backup deadline'):
                RECOVERY.backup(self.source, self.root/'busy.sqlite', timeout=.08)
            self.assertLess(time.monotonic() - started, .7)
            holder.rollback()
        self.assertFalse((self.root/'busy.sqlite').exists())
        self.assertFalse((self.root/'busy.sqlite.partial').exists())
        self.assertEqual(self.source.read_bytes(), prior)

    def test_existing_destination_and_partial_are_never_overwritten(self):
        for suffix in ('', '.partial'):
            target = self.root/('snapshot.sqlite' + suffix)
            target.write_bytes(b'owned by caller')
            with self.assertRaises((AssertionError, FileExistsError)):
                RECOVERY.backup(self.source, self.root/'snapshot.sqlite')
            self.assertEqual(target.read_bytes(), b'owned by caller')
            target.unlink()

    def test_missing_corrupt_and_mismatched_snapshots_fail_without_target(self):
        snapshot = RECOVERY.backup(self.source, self.root/'snapshot.sqlite')
        manifest = RECOVERY.seal_snapshot(snapshot)
        for key, value in [('count', True), ('count', 2), ('format', True), ('schema_sha256', '0'*64),
                           ('rows_sha256', '0'*64), ('database_sha256', '0'*64)]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                RECOVERY.restore(snapshot, dict(manifest, **{key:value}), self.root/'refused.sqlite')
            self.assertFalse((self.root/'refused.sqlite').exists())
        snapshot.write_bytes(b'corrupted fixture')
        with self.assertRaisesRegex(AssertionError, 'byte identity'):
            RECOVERY.restore(snapshot, manifest, self.root/'refused.sqlite')
        with self.assertRaises(AssertionError):
            RECOVERY.restore(self.root/'missing.sqlite', manifest, self.root/'refused.sqlite')

    def test_wrong_empty_state_is_rejected_without_creating_a_database(self):
        with self.assertRaises(AssertionError): RECOVERY.inventory(self.root/'missing.sqlite')
        self.assertFalse((self.root/'missing.sqlite').exists())
        empty = self.root/'empty.sqlite'
        with closing(sqlite3.connect(empty)) as database:
            database.execute('CREATE TABLE contacts(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE)')
            database.commit()
        expected = RECOVERY.seal_snapshot(self.source)
        with self.assertRaisesRegex(AssertionError, 'identity'):
            RECOVERY.verify_snapshot(empty, expected)

    def test_failed_freeze_emits_failed_report_without_touching_existing_state(self):
        report = self.root/'failure.json'
        with patch.object(RECOVERY, 'freeze', side_effect=AssertionError('fixture inputs changed')):
            result = RECOVERY.run_exercise(self.root/'unused', self.root/'new-workspace', report, 'fixture')
        self.assertFalse(result['passed'])
        self.assertEqual(result['errors'][0]['message'], 'fixture inputs changed')
        self.assertEqual(json.loads(report.read_text())['passed'], False)
        prior = report.read_bytes()
        with self.assertRaisesRegex(AssertionError, 'workspace must be new'):
            RECOVERY.run_exercise(self.root/'unused', self.root/'new-workspace', report, 'fixture')
        self.assertEqual(report.read_bytes(), prior)

    def test_freeze_rejects_mutation_of_declared_inputs(self):
        fixture = self.root/'source-fixture'; fixture.mkdir()
        for name in RECOVERY.SOURCES:
            target = fixture/name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('not executed', encoding='utf-8')
        binary = fixture/'dummy-native'; binary.write_bytes(b'not executed')
        workspace = self.root/'frozen-fixture'; workspace.mkdir()
        real_copy = RECOVERY.shutil.copy2
        def changing_copy(source, destination):
            result = real_copy(source, destination)
            if Path(source).name == 'sprout_host.py': Path(source).write_text('fixture mutation', encoding='utf-8')
            return result
        with patch.object(RECOVERY, 'ROOT', fixture), patch.object(RECOVERY.shutil, 'copy2', changing_copy), \
             self.assertRaisesRegex(AssertionError, 'inputs changed'):
            RECOVERY.freeze(binary, workspace)

    def test_partial_host_startup_reaps_owned_stub_and_closes_pipes(self):
        children = []
        def incomplete(service, *args, **kwargs):
            service.process = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(service.process)
            service.readers = [threading.Thread(target=lambda: None), threading.Thread(target=lambda: None)]
            raise RuntimeError('fixture reader startup failure')
        try:
            with patch.object(RECOVERY.Service, '__init__', incomplete), \
                 self.assertRaisesRegex(RuntimeError, 'fixture reader startup failure'):
                RECOVERY.RecoveryService()
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(all(stream.closed for stream in (children[0].stdin, children[0].stdout, children[0].stderr)))
        finally:
            for child in children:
                if child.poll() is None: child.kill()
                child.wait(timeout=2)
                for stream in (child.stdin, child.stdout, child.stderr):
                    if not stream.closed: stream.close()

    def test_literal_dangling_links_are_refused_without_changing_link_or_target(self):
        probe = self.root/'symlink-privilege-probe'
        try:
            probe.symlink_to(self.root/'missing-probe-target')
        except OSError as error:
            if getattr(error, 'winerror', None) == 1314: self.skipTest('Windows symlink privilege unavailable')
            raise
        probe.unlink()
        for option in ('workspace', 'report'):
            with self.subTest(option=option):
                target = self.root/(option + '-target')
                link = self.root/(option + '-link')
                link.symlink_to(target, target_is_directory=option == 'workspace')
                workspace = link if option == 'workspace' else self.root/'unused-workspace'
                report = link if option == 'report' else self.root/'unused-report.json'
                with patch.object(RECOVERY, 'freeze') as freeze, self.assertRaisesRegex(AssertionError, option + ' must be new'):
                    RECOVERY.run_exercise(self.root/'unused-binary', workspace, report, 'fixture')
                freeze.assert_not_called()
                self.assertTrue(link.is_symlink()); self.assertEqual(link.readlink(), target)
                self.assertFalse(target.exists())
                if option == 'report': self.assertFalse(workspace.exists())


if __name__ == '__main__': unittest.main()
