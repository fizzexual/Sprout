#!/usr/bin/env python3
"""Finite synthetic HTTP/SQLite recovery exercise; never restores active state."""
import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import queue
import threading
import time

from deployment_soak import Service, ServiceCloseError

ROOT = Path(__file__).resolve().parents[1]
MAX_DATABASE_BYTES = 64 * 1024 * 1024
MAX_ROWS = 1000
SOURCES = ('tools/service_recovery.py', 'tools/deployment_soak.py',
           'integrations/python/sprout_host.py', 'integrations/python/sprout_service.py',
           'examples/services/contacts.sprout')


class RecoveryService(Service):
    """Cover partial startup before the reused harness readiness loop exists."""
    def __init__(self, *args, **kwargs):
        try:
            super().__init__(*args, **kwargs)
        except BaseException:
            child = getattr(self, 'process', None)
            if child is not None:
                if child.poll() is None: child.kill()
                child.wait(timeout=5)
                readers = getattr(self, 'readers', [])
                for thread in readers:
                    if thread.ident is not None: thread.join(timeout=3)
                for stream, thread in ((child.stdout, readers[0] if readers else None),
                                       (child.stderr, readers[1] if len(readers) > 1 else None), (child.stdin, None)):
                    if stream is not None and not stream.closed and (thread is None or not thread.is_alive()): stream.close()
            raise


def require(value, message):
    if not value:
        raise AssertionError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path, maximum=MAX_DATABASE_BYTES):
    path = Path(path)
    require(not path.is_symlink() and path.is_file(), 'input must be a regular nonsymlink file')
    with path.open('rb') as source:
        data = source.read(maximum + 1)
    require(len(data) <= maximum, 'input exceeds byte limit')
    return hashlib.sha256(data).hexdigest()


def readonly(path):
    path = Path(path)
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= MAX_DATABASE_BYTES,
            'database must be a bounded regular nonsymlink file')
    path = path.resolve(strict=True)
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.05)


def inventory(path, column='email'):
    require(column in ('email', 'address'), 'unsupported synthetic schema')
    with closing(readonly(path)) as database:
        deadline = time.monotonic() + 2
        database.set_progress_handler(lambda: time.monotonic() >= deadline, 1000)
        require(database.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'database integrity failed')
        require(database.execute('PRAGMA foreign_key_check').fetchall() == [], 'foreign key integrity failed')
        schema = database.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 257').fetchall()
        require(len(schema) <= 256, 'schema exceeds entry limit')
        rows = database.execute('SELECT id,name,' + column + ' FROM contacts ORDER BY id LIMIT ?', (MAX_ROWS + 1,)).fetchall()
        require(len(rows) <= MAX_ROWS, 'database exceeds synthetic row cap')
        return dict(schema=schema, rows=rows, schema_sha256=digest(schema), rows_sha256=digest(rows), count=len(rows))


def backup(source, destination, *, timeout=3):
    """Publish only a completed bounded backup into a new path."""
    require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 10, 'invalid backup timeout')
    source, destination = Path(source), Path(destination)
    # Do not raw-open/close a live source: on POSIX that can interfere with
    # advisory locks owned by another SQLite connection in this process.
    require(not source.is_symlink() and source.is_file() and source.stat().st_size <= MAX_DATABASE_BYTES,
            'backup source must be a bounded regular nonsymlink file')
    require(not destination.exists() and not destination.is_symlink(), 'backup destination already exists')
    temporary = destination.with_name(destination.name + '.partial')
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    deadline = time.monotonic() + timeout
    try:
        with closing(readonly(source)) as original, closing(sqlite3.connect(temporary, timeout=.05)) as copied:
            page_size = original.execute('PRAGMA page_size').fetchone()[0]
            def progress(status, remaining, total):
                require(time.monotonic() < deadline, 'backup deadline expired')
                require(total * page_size <= MAX_DATABASE_BYTES, 'backup exceeds byte limit')
            original.backup(copied, pages=16, progress=progress, sleep=.01)
        require(time.monotonic() < deadline, 'backup deadline expired')
        file_hash(temporary)
        require(not destination.exists() and not destination.is_symlink(), 'backup destination changed')
        # Exclusive publication preserves another caller's destination even if
        # it appears after the check. Both paths are in the same fresh directory.
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def seal_snapshot(path):
    state = inventory(path)
    return dict(format=1, database_sha256=file_hash(path), schema_sha256=state['schema_sha256'],
                rows_sha256=state['rows_sha256'], count=state['count'])


def verify_snapshot(path, manifest):
    require(type(manifest.get('format')) is int and manifest['format'] == 1, 'unsupported snapshot manifest')
    require(type(manifest.get('count')) is int and 0 <= manifest['count'] <= MAX_ROWS, 'invalid snapshot count')
    require(file_hash(path) == manifest.get('database_sha256'), 'snapshot byte identity mismatch')
    state = inventory(path)
    for key in ('schema_sha256', 'rows_sha256', 'count'):
        require(state[key] == manifest.get(key), 'snapshot ' + key + ' mismatch')
    return state


def restore(snapshot, manifest, destination):
    verify_snapshot(snapshot, manifest)
    backup(snapshot, destination)
    try:
        return verify_snapshot(destination, manifest)
    except BaseException:
        # Only the newly created destination is owned here. Existing/active data
        # is never overwritten or removed by this operation.
        Path(destination).unlink(missing_ok=True)
        raise


def freeze(binary, workspace):
    originals = {name: ROOT / name for name in SOURCES}
    originals['native/sprout' + ('.exe' if os.name == 'nt' else '')] = Path(binary).resolve(strict=True)
    hashes = {name: file_hash(path) for name, path in originals.items()}
    frozen = workspace / 'frozen'; frozen.mkdir()
    for name, path in originals.items():
        target = frozen / name; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        require(file_hash(target) == hashes[name], 'frozen copy changed: ' + name)
    require(all(file_hash(path) == hashes[name] for name, path in originals.items()), 'inputs changed while freezing')
    return frozen, originals, hashes


def run_exercise(binary, workspace, report_path, label):
    workspace, report_path = Path(workspace), Path(report_path)
    require(not workspace.exists() and not workspace.is_symlink(), 'workspace must be new')
    require(not report_path.exists() and not report_path.is_symlink(), 'report must be new')
    workspace, report_path = workspace.resolve(), report_path.resolve()
    require(not workspace.exists() and not workspace.is_symlink(), 'workspace must be new')
    require(not report_path.exists() and not report_path.is_symlink(), 'report must be new')
    workspace.mkdir()
    report = dict(format=1, label=label, passed=False, scope='finite synthetic recovery; not crash, supervisor or sustained-run qualification',
                  phases=[], hosts=[], errors=[], started_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    active = None; frozen = originals = hashes = None; interrupted = None
    started = time.monotonic(); deadline = started + 120
    def remaining():
        value = deadline - time.monotonic()
        require(value > 0, 'recovery exercise deadline expired')
        return min(2, value)
    def start(state, source):
        nonlocal active
        remaining()
        program = state / 'contacts.sprout'; program.write_text(source, encoding='utf-8')
        report['phases'].append(dict(phase='start', state=state.name, program_sha256=file_hash(program)))
        active = RecoveryService(frozen, program, frozen_binary, 2, workspace / ('host-%02d.json' % len(report['hosts'])))
        return active
    def stop():
        nonlocal active
        old, active = active, None
        try:
            summary = old.close()
        except ServiceCloseError as error:
            if error.summary is not None: report['hosts'].append(dict(error.summary, close_error=str(error), exit_code=error.exit_code))
            raise
        report['hosts'].append(summary)
    def request(method, value=None, expected=200):
        status, raw = active.request(method, '/contacts', value, timeout=remaining())
        require(status == expected, 'unexpected HTTP status %d, expected %d' % (status, expected))
        return json.loads(raw)
    def check_rows(expected):
        require(request('GET')['contacts'] == [list(row) for row in expected], 'HTTP exact rows mismatch')
    try:
        frozen, originals, hashes = freeze(binary, workspace)
        report['inputs'] = hashes
        frozen_binary = next(path for name, path in ((name, frozen/name) for name in hashes) if name.startswith('native/'))
        source = (frozen / 'examples/services/contacts.sprout').read_text(encoding='utf-8')
        state = workspace / 'original'; state.mkdir()
        start(state, source)
        expected = []
        for index, name in enumerate(('Ada', "O'Reilly", 'Zoë', '李雷'), 1):
            email = 'recovery-%d@example.test' % index
            require(request('POST', dict(name=name, email=email), 201) == {'ok': True}, 'POST outcome mismatch')
            expected.append((index, name, email))
        check_rows(expected); stop()
        # Accepted mutation crosses listener shutdown, then becomes part of
        # the cold backup. This is a small drain fixture, not crash recovery.
        draining_source = source.replace('make options = {timeout_ms: 250}',
            'when request.method == "POST" and request.body.email == "drain@example.test":\n'
            '    file_write("drain-entered.txt", "yes")\n    wait(0.25)\nmake options = {timeout_ms: 250}')
        require(draining_source != source, 'drain fixture did not change source')
        draining_host = start(state, draining_source)
        replies = queue.Queue()
        def mutation():
            try:
                replies.put(draining_host.request('POST', '/contacts',
                    dict(name='Drained mutation', email='drain@example.test'), timeout=2))
            except Exception as error:
                replies.put(error)
        client = threading.Thread(target=mutation)
        client.start()
        try:
            marker_deadline = time.monotonic() + 2
            while not (state/'drain-entered.txt').exists() and time.monotonic() < marker_deadline:
                remaining(); time.sleep(.01)
            require((state/'drain-entered.txt').exists(), 'drain mutation was never accepted')
            stop()
        finally:
            client.join(timeout=3)
        require(not client.is_alive(), 'drain client did not finish')
        reply = replies.get(timeout=1)
        require(not isinstance(reply, Exception) and reply[0] == 201 and json.loads(reply[1]) == {'ok': True},
                'accepted mutation did not finish while draining')
        expected.append((5, 'Drained mutation', 'drain@example.test'))
        require(inventory(state/'contacts.sqlite')['rows'] == expected, 'drained mutation was not durable')
        report['phases'].append(dict(phase='drained_original', exact_contacts=len(expected)))
        snapshot = workspace / 'snapshot.sqlite'
        backup(state/'contacts.sqlite', snapshot)
        manifest = seal_snapshot(snapshot)
        (workspace/'snapshot-manifest.json').write_bytes(canonical(manifest) + b'\n')
        report['snapshot'] = manifest
        restored = workspace / 'candidate'; restored.mkdir()
        restore(snapshot, manifest, restored/'contacts.sqlite')
        require(inventory(restored/'contacts.sqlite')['rows'] == expected, 'restored independent data oracle failed')
        start(restored, source); check_rows(expected); stop()
        report['phases'].append(dict(phase='restored_native_verified', exact_contacts=len(expected)))
        # Deliberate incompatible candidate, confined to a private restored copy.
        with closing(sqlite3.connect(restored/'contacts.sqlite', timeout=.05)) as database:
            database.execute('ALTER TABLE contacts RENAME COLUMN email TO address'); database.commit()
        candidate = source.replace('email TEXT NOT NULL UNIQUE', 'address TEXT NOT NULL UNIQUE').replace(
            'SELECT id, name, email FROM', 'SELECT id, name, address FROM').replace('contacts(name,email)', 'contacts(name,address)')
        require(candidate != source, 'incompatible upgrade fixture did not change source')
        start(restored, candidate); check_rows(expected)
        require(request('POST', dict(name='Private candidate write', email='candidate@example.test'), 201) == {'ok': True}, 'candidate mutation failed')
        stop()
        start(restored, source)
        require(request('GET', expected=503) == {'error': 'query failed'}, 'code-only rollback did not reject incompatible schema')
        stop()
        report['phases'].append(dict(phase='code_only_rollback_rejected', status=503))
        rollback = workspace / 'rollback'; rollback.mkdir()
        restore(snapshot, manifest, rollback/'contacts.sqlite')
        start(rollback, source); check_rows(expected)
        require(request('POST', dict(name='Ada', email='recovery-1@example.test'), 409) == {'error': 'email already exists'}, 'restored uniqueness failed')
        stop()
        require(inventory(rollback/'contacts.sqlite')['rows_sha256'] == manifest['rows_sha256'], 'rollback data changed')
        report['phases'].append(dict(phase='snapshot_rollback_verified', exact_contacts=len(expected),
                                    note='Private candidate-only writes are deliberately outside the pre-upgrade restore point.'))
        require(all(file_hash(path) == hashes[name] and file_hash(frozen/name) == hashes[name]
                    for name, path in originals.items()), 'immutable inputs changed')
        report['inputs_unchanged'] = True
        remaining(); report['passed'] = True
    except BaseException as error:
        report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        if not isinstance(error, Exception): interrupted = error
    finally:
        if active is not None:
            try: stop()
            except Exception as error: report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        if hashes is not None:
            try:
                report['inputs_unchanged'] = all(file_hash(path) == hashes[name] and file_hash(frozen/name) == hashes[name]
                    for name, path in originals.items())
                require(report['inputs_unchanged'], 'immutable inputs changed')
            except Exception as error:
                report['inputs_unchanged'] = False
                report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        elapsed = time.monotonic() - started
        report['elapsed_seconds'] = elapsed if math.isfinite(elapsed) and elapsed >= 0 else None
        if report['elapsed_seconds'] is None: report['errors'].append(dict(type='ClockError', message='nonfinite or backward elapsed clock'))
        if report['errors']: report['passed'] = False
        with report_path.open('xb') as output:
            output.write(canonical(report) + b'\n')
    if interrupted is not None: raise interrupted
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--label', required=True)
    args = parser.parse_args()
    report = run_exercise(args.binary, args.workspace, args.report, args.label)
    print(json.dumps(dict(passed=report['passed'], phases=len(report['phases']), errors=report['errors'])))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
