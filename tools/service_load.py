"""Bounded loopback HTTP/SQLite workload with an independent expected-row oracle."""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import http.client
import json
from pathlib import Path
import platform
import random
import shutil
import sqlite3
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'integrations/python'))
from sprout_service import SproutServer

SOURCE = ROOT / 'examples/services/contacts.sprout'
MAX_RESPONSE_BYTES = 1048576


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def latency(values):
    """Nearest-rank percentiles in milliseconds; no interpolation."""
    ordered = sorted(value * 1000 for value in values)
    if not ordered:
        return {'samples': 0}
    return dict(samples=len(ordered), p50_ms=ordered[(len(ordered) - 1) // 2],
                p95_ms=ordered[(95 * len(ordered) + 99) // 100 - 1], max_ms=ordered[-1])


def rows_oracle(rows, expected):
    require(len(rows) == len(expected), 'row count differs from the expected dataset')
    found = {}
    ids = set()
    for row in rows:
        require(isinstance(row, (tuple, list)) and len(row) == 3, 'invalid contact row shape')
        identifier, name, email = row
        require(type(identifier) is int and identifier > 0 and identifier not in ids, 'invalid/duplicate contact ID')
        require(type(name) is str and type(email) is str and email not in found, 'invalid/duplicate contact value')
        ids.add(identifier)
        found[email] = name
    require(found == expected, 'contact names/emails differ from the independent expected dataset')


def dataset(count, seed):
    rng = random.Random(seed)
    names = ['Ada', "O'Reilly", 'Zoë', '李雷', 'A & B', 'Line\\nLiteral',
             "Robert'); DROP TABLE contacts;--", 'Quote " Contact']
    return [{'name': '%s %06d %08x' % (rng.choice(names), index, rng.getrandbits(32)),
             'email': 'load-%d-%06d@example.test' % (seed, index)} for index in range(count)]


class Load:
    def __init__(self, server, args):
        self.server, self.args = server, args
        self.abort = threading.Event()

    def request(self, method, path, value=None):
        body = None if value is None else json.dumps(value, ensure_ascii=False).encode('utf-8')
        with closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port,
                                              timeout=self.args.client_timeout_seconds)) as client:
            client.request(method, path, body, {'Content-Type': 'application/json', 'Connection': 'close'})
            reply = client.getresponse()
            raw = reply.read(MAX_RESPONSE_BYTES + 1)
            require(len(raw) <= MAX_RESPONSE_BYTES, 'HTTP response exceeds the harness byte cap')
            return reply.status, raw

    def idle(self):
        acquired = 0
        deadline = time.monotonic() + 8
        try:
            for _ in range(self.args.workers):
                require(self.server.capacity.acquire(timeout=max(0, deadline - time.monotonic())),
                        'service handlers did not release capacity before the next phase')
                acquired += 1
        finally:
            for _ in range(acquired):
                self.server.capacity.release()

    def write(self, index, value):
        started = time.perf_counter()
        deadline = time.monotonic() + self.args.contact_deadline_seconds
        rng = random.Random(self.args.seed ^ (index + 1) * 0x9E3779B1)
        result = dict(index=index, statuses=Counter(), transport_errors=Counter(),
                      attempt_seconds=[], capacity_503=0, sqlite_503=0, completed=False,
                      ambiguous_commit_409=False, error=None)
        for attempt in range(self.args.max_attempts):
            if self.abort.is_set():
                result['error'] = 'aborted after another contact failed'
                break
            if time.monotonic() >= deadline:
                result['error'] = 'logical contact deadline exceeded'
                break
            attempt_started = time.perf_counter()
            try:
                status, raw = self.request('POST', '/contacts', value)
                result['statuses'][str(status)] += 1
                if status == 201:
                    require(json.loads(raw) == {'ok': True}, 'invalid successful POST body')
                    result['completed'] = True
                    break
                if status == 409 and result['transport_errors']:
                    # The insert may have committed before a response was lost.
                    # Only the final exact database/HTTP oracle can reconcile it.
                    require(json.loads(raw) == {'error': 'email already exists'}, 'invalid duplicate response')
                    result['ambiguous_commit_409'] = True
                    result['completed'] = True
                    break
                if status != 503:
                    raise AssertionError('unexpected POST status %d: %r' % (status, raw[:300]))
                if raw:
                    require(json.loads(raw).get('error') in ('database unavailable', 'query failed'),
                            'unexpected application 503 response')
                    result['sqlite_503'] += 1
                else:
                    result['capacity_503'] += 1
            except (OSError, http.client.HTTPException) as error:
                result['transport_errors'][type(error).__name__] += 1
            except Exception as error:
                result['error'] = '%s: %s' % (type(error).__name__, error)
                self.abort.set()
                break
            finally:
                result['attempt_seconds'].append(time.perf_counter() - attempt_started)
            delay = min(.25, .01 * 2 ** min(attempt, 5)) * rng.uniform(.5, 1.5)
            self.abort.wait(min(delay, max(0, deadline - time.monotonic())))
        if not result['completed'] and result['error'] is None:
            result['error'] = 'retry limit exhausted'
        if result['error']:
            self.abort.set()
        result['contact_seconds'] = time.perf_counter() - started
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--contacts', type=int, default=200)
    parser.add_argument('--clients', type=int, default=8)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--seed', type=int, default=20261010)
    parser.add_argument('--max-attempts', type=int, default=32)
    parser.add_argument('--contact-deadline-seconds', type=float, default=15)
    parser.add_argument('--client-timeout-seconds', type=float, default=6)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--artifacts', type=Path, default=Path('service-load-artifacts'))
    args = parser.parse_args()
    if not 1 <= args.contacts <= 5000 or not 1 <= args.clients <= 64 or not 1 <= args.workers <= 64:
        parser.error('contacts must be 1..5000; clients and workers must be 1..64')
    if not 1 <= args.max_attempts <= 100 or not 1 <= args.contact_deadline_seconds <= 120 or not 1 <= args.client_timeout_seconds <= 30:
        parser.error('attempts must be 1..100; contact deadline 1..120s; client timeout 1..30s')
    original_binary = args.binary.resolve()
    values = dataset(args.contacts, args.seed)
    expected = {value['email']: value['name'] for value in values}
    expected_sha = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    statuses = Counter()
    transport = Counter()
    attempt_times, contact_times = [], []
    counts = dict(contacts_requested=args.contacts, contacts_completed=0, post_attempts=0,
                  capacity_503=0, sqlite_503=0, ambiguous_commits_reconciled=0,
                  deliberate_sqlite_busy_503=0, deliberate_duplicate_409=0, sqlite_rows_verified=0, http_rows_verified=0,
                  runtime_failure_502=0, recovery_200=0)
    report = dict(timestamp_utc=datetime.now(timezone.utc).isoformat(), binary_path=str(original_binary),
                  binary_sha256=sha(original_binary), harness_sha256=sha(__file__), contacts_source_sha256=sha(SOURCE),
                  sdk_sha256=sha(ROOT / 'integrations/python/sprout_host.py'),
                  service_sha256=sha(ROOT / 'integrations/python/sprout_service.py'),
                  expected_dataset_sha256=expected_sha, platform=platform.platform(),
                  python=platform.python_version(), sqlite_oracle_version=sqlite3.sqlite_version,
                  seed=args.seed, clients=args.clients, server_workers=args.workers, counts=counts,
                  status_counts=statuses, transport_errors=transport, phases=[], errors=[],
                  limits=dict(max_attempts_per_contact=args.max_attempts,
                              logical_contact_deadline_seconds=args.contact_deadline_seconds,
                              client_timeout_seconds=args.client_timeout_seconds, service_host_timeout_ms=5000,
                              service_runtime_timeout_ms=4750, sqlite_statement_timeout_ms=250,
                              response_bytes=MAX_RESPONSE_BYTES, service_body_bytes=65536),
                  interpretation='Bounded local loopback HTTP/SQLite evidence, not a production capacity or latency guarantee. '
                                 'Each request launches a native Sprout process. Stable unique emails plus exact final rows '
                                 'reconcile ambiguous transport retries; the service does not provide exactly-once request delivery.')
    started = time.perf_counter()
    baseline_threads = threading.active_count()
    with tempfile.TemporaryDirectory(prefix='sprout-service-load-') as directory:
        folder = Path(directory)
        program = folder / 'contacts.sprout'
        shutil.copy2(SOURCE, program)
        # Snapshot the executable, so a concurrent rebuild cannot mix binaries.
        binary = folder / ('sprout.exe' if sys.platform == 'win32' else 'sprout')
        shutil.copy2(original_binary, binary)
        require(sha(binary) == report['binary_sha256'], 'binary changed while taking its snapshot')
        server = None
        thread = None
        try:
            server = SproutServer(('127.0.0.1', 0), program, command=str(binary), workers=args.workers, allow_io=True)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
            thread.start()
            load = Load(server, args)
            status, raw = load.request('GET', '/health')
            require(status == 200 and json.loads(raw) == {'ok': True, 'protocol': 1}, 'service health failed')
            status, raw = load.request('GET', '/contacts')
            require(status == 200 and json.loads(raw) == {'contacts': []}, 'copied app did not start with an empty database')
            report['phases'].append('empty contacts database and HTTP health verified')
            load.idle()
            # Deliberately hold a real independent database lock. The stable
            # first email is retried later in the concurrent workload.
            with closing(sqlite3.connect(folder / 'contacts.sqlite', timeout=2)) as holder:
                holder.execute('BEGIN EXCLUSIVE')
                try:
                    busy_started = time.perf_counter()
                    status, raw = load.request('POST', '/contacts', values[0])
                    report['deliberate_sqlite_busy_response_ms'] = (time.perf_counter() - busy_started) * 1000
                    require(status == 503 and json.loads(raw) == {'error': 'database unavailable'},
                            'locked database did not return retryable application 503')
                    counts['deliberate_sqlite_busy_503'] += 1
                finally:
                    holder.rollback()
            load.idle()
            report['phases'].append('independent exclusive SQLite lock returns application 503 before retrying the same email')
            load_started = time.perf_counter()
            failures = []
            with ThreadPoolExecutor(max_workers=args.clients) as pool:
                futures = [pool.submit(load.write, index, value) for index, value in enumerate(values)]
                for future in as_completed(futures):
                    result = future.result()
                    statuses.update(result['statuses'])
                    transport.update(result['transport_errors'])
                    attempt_times.extend(result['attempt_seconds'])
                    contact_times.append(result['contact_seconds'])
                    counts['post_attempts'] += len(result['attempt_seconds'])
                    counts['capacity_503'] += result['capacity_503']
                    counts['sqlite_503'] += result['sqlite_503']
                    counts['contacts_completed'] += int(result['completed'])
                    counts['ambiguous_commits_reconciled'] += int(result['ambiguous_commit_409'])
                    if result['error']:
                        failures.append({'index': result['index'], 'message': result['error']})
                    if counts['contacts_completed'] and counts['contacts_completed'] % 50 == 0:
                        print('Completed %d/%d contacts (%d POST attempts)' %
                              (counts['contacts_completed'], args.contacts, counts['post_attempts']), flush=True)
            report['load_elapsed_seconds'] = time.perf_counter() - load_started
            require(not failures, 'write failures: ' + json.dumps(failures[:8]))
            require(counts['contacts_completed'] == len(expected), 'not every expected contact completed')
            load.idle()
            report['phases'].append('concurrent unique contact writes completed with bounded retries')
            duplicate = dict(values[0], name='A duplicate request must not replace the original')
            status, raw = load.request('POST', '/contacts', duplicate)
            require(status == 409 and json.loads(raw) == {'error': 'email already exists'}, 'duplicate email was not rejected')
            counts['deliberate_duplicate_409'] += 1
            load.idle()
            with closing(sqlite3.connect(folder / 'contacts.sqlite', timeout=2)) as database:
                integrity = database.execute('PRAGMA integrity_check').fetchall()
                require(integrity == [('ok',)], 'SQLite integrity_check failed: ' + repr(integrity))
                rows = database.execute('SELECT id,name,email FROM contacts').fetchall()
                rows_oracle(rows, expected)
                counts['sqlite_rows_verified'] = len(rows)
            report['sqlite_integrity_check'] = 'ok'
            status, raw = load.request('GET', '/contacts')
            require(status == 200, 'HTTP contacts GET failed after concurrent writes')
            rows = json.loads(raw)['contacts']
            rows_oracle(rows, expected)
            counts['http_rows_verified'] = len(rows)
            report['phases'].append('independent sqlite3 integrity and exact rows match HTTP GET and expected dataset')
            load.idle()
            failed = folder / 'failure.sprout'
            secret = 'service-load-private-detail-DO-NOT-PUBLISH'
            failed.write_text('fail ' + json.dumps(secret) + '\n', encoding='utf-8')
            server.program = failed
            try:
                status, raw = load.request('GET', '/contacts')
                require(status == 502 and json.loads(raw) == {'error': 'worker failed', 'code': 'runtime'},
                        'runtime failure did not become the expected generic 502')
                require(secret.encode() not in raw and str(folder).encode() not in raw, 'worker details leaked into HTTP response')
                counts['runtime_failure_502'] += 1
                load.idle()
            finally:
                server.program = program
            status, raw = load.request('GET', '/contacts')
            require(status == 200, 'service did not recover after runtime failure')
            rows_oracle(json.loads(raw)['contacts'], expected)
            counts['recovery_200'] += 1
            load.idle()
            report['phases'].append('worker runtime 502 suppresses internal details; following GET recovers with identical rows')
        except Exception as error:
            report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        finally:
            if server is not None:
                if thread is not None and thread.is_alive():
                    server.shutdown()
                server.server_close()
            if thread is not None:
                thread.join(timeout=3)
                if thread.is_alive():
                    report['errors'].append(dict(type='CleanupError', message='HTTP server thread did not stop'))
        if report['errors']:
            target = args.artifacts.resolve() / ('seed-%d' % args.seed)
            target.mkdir(parents=True, exist_ok=True)
            for path in folder.iterdir():
                if path.is_file() and path != binary:
                    shutil.copy2(path, target / path.name)
            report['failure_artifacts'] = str(target)
    if threading.active_count() != baseline_threads:
        report['errors'].append(dict(type='CleanupError', message='host thread count did not return to baseline'))
    report.update(elapsed_seconds=time.perf_counter() - started, attempt_latency=latency(attempt_times),
                  logical_contact_latency=latency(contact_times), passed=not report['errors'],
                  retryable_post_outcomes=counts['capacity_503'] + counts['sqlite_503'] + sum(transport.values()),
                  original_binary_unchanged=sha(original_binary) == report['binary_sha256'])
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('counts', 'status_counts', 'transport_errors', 'elapsed_seconds',
                                                 'attempt_latency', 'logical_contact_latency', 'passed', 'errors')}, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
