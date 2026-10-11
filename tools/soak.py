"""Bounded process/workflow lifecycle soak with an independent SQLite effect ledger."""
from __future__ import annotations
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'integrations/python'))
import sprout_host

# This fixture owns its side-effect transaction. Sprout does not deduplicate it.
WORKER = r'''
import json, os, pathlib, sqlite3, sys, time
root, job, mode, key, base, offset, dependencies = sys.argv[1:]
root = pathlib.Path(root); base = int(base); offset = int(offset)
dependencies = json.loads(dependencies)
if mode == 'controller':
    deadline = time.monotonic() + 3
    while not (root / 'cancel.ready').exists():
        if time.monotonic() > deadline: raise SystemExit(80)
        time.sleep(.002)
conn = sqlite3.connect(root / 'ledger.sqlite', timeout=2)
try:
    conn.execute('BEGIN IMMEDIATE')
    for dependency in dependencies:
        if not conn.execute("SELECT 1 FROM events WHERE job=? AND phase='finish' AND outcome='ok'", (dependency,)).fetchone():
            raise RuntimeError('dependency has no successful finish: ' + dependency)
    attempt = conn.execute("SELECT count(*) FROM events WHERE job=? AND phase='start'", (job,)).fetchone()[0] + 1
    conn.execute("INSERT INTO events(job,phase,outcome,pid) VALUES(?,'start','',?)", (job, os.getpid()))
    if mode in ('failure', 'controller'):
        conn.execute("INSERT INTO events(job,phase,outcome) VALUES(?,'finish','fail')", (job,))
        conn.commit()
        raise SystemExit(9)
    def value(name):
        row = conn.execute('SELECT value FROM effects WHERE job=?', (name,)).fetchone()
        if not row: raise RuntimeError('dependency effect is missing: ' + name)
        return row[0]
    if job == 'seed': result = base
    elif job == 'left': result = value('seed') * 3 + offset
    elif job == 'right': result = value('seed') * 5 - offset
    elif job == 'retry': result = value('seed') + 11
    elif job == 'join': result = sum(value(name) for name in ('left', 'right', 'retry'))
    else: result = base * 13 + 17
    previous = conn.execute('SELECT job,value FROM effects WHERE operation_key=?', (key,)).fetchone()
    if previous and previous != (job, result): raise RuntimeError('operation key changed meaning')
    inserted = conn.execute('INSERT OR IGNORE INTO effects(operation_key,job,value) VALUES(?,?,?)', (key, job, result)).rowcount
    if inserted: conn.execute('INSERT INTO applied(operation_key,value) VALUES(?,?)', (key, result))
    hold = mode == 'cancel' or (mode == 'crash' and attempt == 1)
    failing = mode == 'retry' and attempt == 1
    if not hold:
        conn.execute("INSERT INTO events(job,phase,outcome) VALUES(?,'finish',?)", (job, 'fail' if failing else 'ok'))
    conn.commit()
finally:
    conn.close()
if hold:
    marker = 'cancel.ready' if mode == 'cancel' else 'crash.ready'
    (root / marker).write_text(str(result), encoding='ascii')
    deadline = time.monotonic() + 3
    while not (root / 'crash.release').exists() or mode == 'cancel':
        if time.monotonic() > deadline: raise SystemExit(81)
        time.sleep(.002)
    # An orphaned POSIX crash fixture can finish after release. It performs no
    # further side effects; the host test owns this bounded fixture cleanup.
    raise SystemExit(0)
print(result)
raise SystemExit(7 if failing else 0)
'''


def literal(value):
    if value is True: return 'yes'
    if value is False: return 'no'
    if value is None: return 'nothing'
    if isinstance(value, str): return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list): return '[' + ', '.join(map(literal, value)) + ']'
    if isinstance(value, dict): return '{' + ', '.join(literal(k) + ': ' + literal(v) for k, v in value.items()) + '}'
    return str(value)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition: raise AssertionError(message)


def process_running(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            # ERROR_INVALID_PARAMETER means this PID no longer exists.
            require(ctypes.get_last_error() == 87, 'could not inspect native worker lifecycle')
            return False
        try: return kernel.WaitForSingleObject(handle, 0) == 258
        finally: kernel.CloseHandle(handle)
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    # An orphaned crash fixture may briefly be a zombie in a container whose
    # PID 1 does not reap promptly. It cannot continue executing side effects.
    if sys.platform.startswith('linux'):
        try:
            state = Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()[0]
            if state == 'Z': return False
        except FileNotFoundError: return False
    return True


def wait_stopped(pid):
    deadline = time.monotonic() + 3
    while process_running(pid):
        require(time.monotonic() < deadline, 'native fixture continued running after cancellation/release')
        time.sleep(.005)


class Cycle:
    def __init__(self, folder, binary, number, rng, counts):
        self.folder, self.binary, self.number, self.counts = folder, binary, number, counts
        folder.mkdir(); (folder / 'worker.py').write_text(WORKER, encoding='utf-8')
        self.base, self.offset = rng.randint(-10000, 10000), rng.randint(-1000, 1000)
        self.key = '%d-%016x' % (number, rng.getrandbits(64))
        with closing(sqlite3.connect(folder / 'ledger.sqlite')) as conn:
            conn.executescript('CREATE TABLE effects(operation_key TEXT PRIMARY KEY,job TEXT UNIQUE,value INTEGER);'
                               'CREATE TABLE applied(operation_key TEXT,value INTEGER);'
                               'CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT,phase TEXT,outcome TEXT,pid INTEGER);')
            conn.commit()

    def argv(self, job, mode='normal', after=()):
        return [sys.executable, '-X', 'utf8', str(self.folder / 'worker.py'), str(self.folder), job, mode,
                self.key + ':' + job, str(self.base), str(self.offset), json.dumps(list(after))]

    def query(self, sql, parameters=()):
        with closing(sqlite3.connect(self.folder / 'ledger.sqlite')) as conn:
            return conn.execute(sql, parameters).fetchall()

    def source(self, name, jobs, **options):
        checkpoint = self.folder / (name + '.checkpoint.json')
        options = dict(checkpoint=str(checkpoint), workers=3, fail_fast=False, **options)
        path = self.folder / (name + '.sprout')
        path.write_text('show json_encode(workflow_run(' + literal(jobs) + ', ' + literal(options) + '))\n', encoding='utf-8')
        return path, checkpoint

    def invoke(self, path):
        self.counts['sprout_cli_starts'] += 1
        result = subprocess.run([str(self.binary), '--max-steps', '100000', '--timeout-ms', '15000', 'run', str(path)],
                                cwd=self.folder, capture_output=True, timeout=18)
        require(result.returncode == 0, 'runtime failed: ' + result.stderr.decode(errors='replace'))
        require(len(result.stdout) <= 1048576 and len(result.stderr) <= 65536, 'host result exceeded harness byte budget')
        return json.loads(result.stdout)

    def event_count(self):
        return self.query('SELECT count(*) FROM events')[0][0]

    def dag(self):
        definitions = [('seed', (), 'normal'), ('left', ('seed',), 'normal'),
                       ('right', ('seed',), 'normal'), ('retry', ('seed',), 'retry'),
                       ('join', ('left', 'right', 'retry'), 'normal')]
        jobs = [dict(id=name, argv=self.argv(name, mode, after), after=list(after), idempotent=True,
                     retries=1 if name == 'retry' else 0, timeout_ms=2000) for name, after, mode in definitions]
        path, checkpoint = self.source('dag', jobs)
        result = self.invoke(path)
        require(result['ok'] and not result['resumed'], 'fresh DAG did not complete')
        require([row['id'] for row in result['jobs']] == [row[0] for row in definitions], 'job result order changed')
        require([row['attempts'] for row in result['jobs']] == [1, 1, 1, 2, 1], 'retry attempt count changed')
        require(all(row['status'] == 'done' for row in result['jobs']), 'successful DAG has unfinished jobs')
        # Closed-form oracle differs from the fixture's dependency-by-dependency computation.
        require(int(result['jobs'][-1]['result']['stdout']) == self.base * 9 + 11, 'DAG arithmetic oracle mismatch')
        for name, after, _ in definitions:
            first_start = self.query("SELECT min(sequence) FROM events WHERE job=? AND phase='start'", (name,))[0][0]
            for dependency in after:
                finish = self.query("SELECT max(sequence) FROM events WHERE job=? AND phase='finish' AND outcome='ok'", (dependency,))[0][0]
                require(finish is not None and finish < first_start, 'dependency launched before successful completion')
        before, digest = self.event_count(), sha(checkpoint)
        resumed = self.invoke(path)
        require(resumed['ok'] and resumed['resumed'] and resumed['jobs'] == result['jobs'], 'completed resume changed results')
        require(self.event_count() == before and sha(checkpoint) == digest, 'completed resume executed work or changed checkpoint')
        self.counts['dag_jobs_completed'] += 5
        self.counts['intentional_retry_failures'] += 1
        self.counts['completed_dag_resumes'] += 1

    def terminal_failure(self):
        jobs = [dict(id='failure', argv=self.argv('failure', 'failure'), timeout_ms=2000),
                dict(id='blocked', argv=self.argv('blocked', after=('failure',)), after=['failure'], timeout_ms=2000)]
        path, checkpoint = self.source('failure', jobs)
        result = self.invoke(path)
        require(not result['ok'] and [row['status'] for row in result['jobs']] == ['failed', 'pending'], 'terminal failure did not block dependency')
        require([row['attempts'] for row in result['jobs']] == [1, 0], 'unstarted dependency consumed an attempt')
        before, digest = self.event_count(), sha(checkpoint)
        require(not self.invoke(path)['ok'], 'terminal failed job was silently retried')
        require(self.event_count() == before and sha(checkpoint) == digest, 'terminal resume executed a side effect')
        self.counts['terminal_failures'] += 1
        self.counts['blocked_jobs_not_launched'] += 1

    def crash(self):
        jobs = [dict(id='crash', argv=self.argv('crash', 'crash'), idempotent=True, timeout_ms=2000)]
        path, checkpoint = self.source('crash', jobs)
        self.counts['sprout_cli_starts'] += 1
        child = subprocess.Popen([str(self.binary), '--max-steps', '100000', '--timeout-ms', '15000', 'run', str(path)],
                                 cwd=self.folder, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 3
            while not (self.folder / 'crash.ready').exists():
                require(child.poll() is None, 'crash worker exited before handshake')
                require(time.monotonic() < deadline, 'crash handshake timed out')
                time.sleep(.002)
            require(json.loads(checkpoint.read_text())['jobs'][0]['status'] == 'running', 'crash window was not checkpointed')
            child.kill(); child.communicate(timeout=3)
        finally:
            (self.folder / 'crash.release').touch()
            if child.poll() is None: child.kill(); child.communicate(timeout=3)
            child.stdout.close(); child.stderr.close()
        pid = self.query("SELECT pid FROM events WHERE job='crash' AND phase='start' ORDER BY sequence LIMIT 1")[0][0]
        wait_stopped(pid)
        result = self.invoke(path)
        require(result['ok'] and result['resumed'] and result['jobs'][0]['attempts'] == 2, 'idempotent crash recovery did not complete')
        require(self.query("SELECT count(*) FROM applied WHERE operation_key=?", (self.key + ':crash',))[0][0] == 1, 'crash recovery applied an operation twice')
        self.counts['crash_recoveries'] += 1
        self.counts['crash_fixture_workers_stopped'] += 1

    def native_cancel(self):
        commands = [dict(argv=self.argv('cancel', 'cancel'), timeout_ms=2000),
                    dict(argv=self.argv('controller', 'controller'), timeout_ms=2000)]
        path = self.folder / 'cancel.sprout'
        path.write_text('show json_encode(parallel(' + literal(commands) + ', {workers: 2, fail_fast: yes, max_output: 65536}))\n', encoding='utf-8')
        result = self.invoke(path)
        require(len(result) == 2 and result[0]['cancelled'] and result[1]['exit'] == 9, 'native fail-fast cancellation changed')
        pid = self.query("SELECT pid FROM events WHERE job='cancel' AND phase='start' ORDER BY sequence LIMIT 1")[0][0]
        wait_stopped(pid)
        self.counts['native_cancel_workers_stopped'] += 1
        path.write_text('show json_encode(parallel([' + literal(dict(argv=self.argv('cancel'), timeout_ms=2000)) + '], {workers: 1}))\n', encoding='utf-8')
        require(self.invoke(path)[0]['ok'], 'native work did not recover after cancellation')
        require(self.query('SELECT count(*) FROM applied WHERE operation_key=?', (self.key + ':cancel',))[0][0] == 1, 'cancel recovery applied an operation twice')
        self.counts['native_cancellations'] += 1
        self.counts['native_cancel_recoveries'] += 1

    def sdk_cancel(self):
        path = self.folder / 'sdk.sprout'
        path.write_text('make x = 0\nrepeat while yes:\n    set x = x + 1\n', encoding='utf-8')
        event = threading.Event(); timer = threading.Timer(.06, event.set)
        observed = []; real_popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            if args and args[0] and str(args[0][0]) == str(self.binary): observed.append(process)
            return process
        started = time.perf_counter(); timer.start()
        try:
            with patch('sprout_host.subprocess.Popen', side_effect=launch):
                try:
                    sprout_host.run(path, None, command=self.binary, cancel=event, timeout_ms=2000,
                                    runtime_timeout_ms=1500, max_steps=1000000000, max_output_bytes=65536)
                except sprout_host.SproutError as error:
                    require(error.code == 'canceled', 'SDK cancellation produced ' + error.code)
                else: raise AssertionError('SDK ignored cancellation')
        finally:
            timer.cancel(); timer.join(timeout=1)
        elapsed = time.perf_counter() - started
        path.write_text('make request = json_decode(read_input())\nshow json_encode(request["value"] * 7 + 3)\n', encoding='utf-8')
        with patch('sprout_host.subprocess.Popen', side_effect=launch):
            response = sprout_host.run(path, {'value': self.base}, command=self.binary, timeout_ms=2000,
                                      runtime_timeout_ms=1500, max_steps=100000, max_output_bytes=65536)
        require(response == self.base * 7 + 3, 'SDK recovery arithmetic oracle mismatch')
        require(len(observed) == 2, 'SDK request canceled before an interpreter was launched')
        for child in observed:
            require(child.poll() is not None, 'SDK returned with a live interpreter')
            require(all(stream.closed for stream in (child.stdin, child.stdout, child.stderr)), 'SDK left a pipe open')
        self.counts['sdk_interpreters_started'] += len(observed)
        self.counts['sdk_cancellations'] += 1
        self.counts['sdk_cancel_recoveries'] += 1
        return elapsed

    def validate_ledger(self):
        expected = {'seed': self.base, 'left': self.base * 3 + self.offset, 'right': self.base * 5 - self.offset,
                    'retry': self.base + 11, 'join': self.base * 9 + 11,
                    'crash': self.base * 13 + 17, 'cancel': self.base * 13 + 17}
        require(dict(self.query('SELECT job,value FROM effects')) == expected, 'independent effect ledger oracle mismatch')
        require(self.query('SELECT operation_key FROM applied GROUP BY operation_key HAVING count(*) != 1') == [], 'duplicate applied operation key')
        attempts = dict(self.query("SELECT job,count(*) FROM events WHERE phase='start' GROUP BY job"))
        require(attempts == dict(seed=1, left=1, right=1, retry=2, join=1, failure=1, crash=2, cancel=2, controller=1), 'fixture launch-count oracle mismatch')
        self.counts['native_fixture_executions'] += sum(attempts.values())
        self.counts['unique_effects_verified'] += len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--cycles', type=int, default=50)
    parser.add_argument('--seed', type=int, default=20261010)
    parser.add_argument('--duration-seconds', type=float, help='Stop between complete cycles after this wall duration, or at --cycles.')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--artifacts', type=Path, default=Path('soak-artifacts'))
    args = parser.parse_args()
    if not 1 <= args.cycles <= 10000 or (args.duration_seconds is not None and args.duration_seconds <= 0):
        parser.error('cycles must be 1..10000 and duration must be positive')
    original_binary = args.binary.resolve(); rng = random.Random(args.seed)
    counts = {key: 0 for key in ('sprout_cli_starts', 'native_fixture_executions', 'sdk_interpreters_started',
              'dag_jobs_completed', 'intentional_retry_failures', 'completed_dag_resumes', 'terminal_failures',
              'blocked_jobs_not_launched', 'crash_recoveries', 'crash_fixture_workers_stopped',
              'native_cancellations', 'native_cancel_workers_stopped', 'native_cancel_recoveries',
              'sdk_cancellations', 'sdk_cancel_recoveries', 'unique_effects_verified')}
    report = dict(timestamp_utc=datetime.now(timezone.utc).isoformat(), binary_path=str(original_binary),
                  binary_sha256=sha(original_binary),
                  harness_sha256=sha(__file__), sdk_sha256=sha(ROOT / 'integrations/python/sprout_host.py'),
                  fixture_sha256=hashlib.sha256(WORKER.encode()).hexdigest(), platform=platform.platform(),
                  python=platform.python_version(), seed=args.seed, requested_cycles=args.cycles,
                  requested_duration_seconds=args.duration_seconds, completed_cycles=0, counts=counts, errors=[],
                  limits=dict(native_job_timeout_ms=2000, runtime_deadline_ms=15000, runtime_steps=100000,
                              outer_process_seconds=18, sdk_host_ms=2000, sdk_runtime_ms=1500,
                              sdk_output_bytes=65536, fixture_gate_seconds=3),
                  interpretation='Bounded lifecycle evidence, not production certification or an exactly-once engine guarantee. '
                                 'Operation keys and transactions belong to the fixture. Parent-crash fixtures own a bounded '
                                 'release gate for POSIX workers; automatic parent-death descendant cleanup is not established.')
    cycle_times = []; cancel_times = []; baseline_threads = threading.active_count(); started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='sprout-soak-') as directory:
        # All cycles execute one immutable copy, even if the original is rebuilt.
        binary = Path(directory) / ('sprout.exe' if os.name == 'nt' else 'sprout')
        shutil.copy2(original_binary, binary)
        require(sha(binary) == report['binary_sha256'], 'binary changed while taking its snapshot')
        for index in range(args.cycles):
            cycle_started = time.perf_counter(); folder = Path(directory) / ('cycle-%04d' % index)
            try:
                cycle = Cycle(folder, binary, index, rng, counts)
                cycle.dag(); cycle.terminal_failure(); cycle.crash(); cycle.native_cancel()
                cancel_times.append(cycle.sdk_cancel()); cycle.validate_ledger()
                require(threading.active_count() == baseline_threads, 'host thread count grew after a complete cycle')
                report['completed_cycles'] += 1; cycle_times.append(time.perf_counter() - cycle_started)
            except Exception as error:
                target = args.artifacts.resolve() / ('seed-%d-cycle-%04d' % (args.seed, index))
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(folder, target, dirs_exist_ok=True)
                report['errors'].append(dict(cycle=index, type=type(error).__name__, message=str(error), artifacts=str(target)))
                break
            if (index + 1) % 10 == 0: print('Completed %d cycles / %d native fixture executions' % (index + 1, counts['native_fixture_executions']), flush=True)
            if args.duration_seconds is not None and time.perf_counter() - started >= args.duration_seconds: break
        report['binary_snapshot_unchanged'] = sha(binary) == report['binary_sha256']
        if not report['binary_snapshot_unchanged']:
            report['errors'].append(dict(type='ProvenanceError', message='immutable interpreter snapshot changed during the run'))
    report.update(elapsed_seconds=time.perf_counter() - started, cycle_seconds=cycle_times,
                  sdk_cancellation_seconds=cancel_times, passed=not report['errors'],
                  original_binary_unchanged=sha(original_binary) == report['binary_sha256'])
    if cycle_times: report['median_cycle_seconds'] = statistics.median(cycle_times)
    if cancel_times: report['maximum_sdk_cancellation_seconds'] = max(cancel_times)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('completed_cycles', 'elapsed_seconds', 'counts', 'passed', 'errors')}, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
