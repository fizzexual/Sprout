"""Duration-based local HTTP deployment exercise with frozen source and resource probes."""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import queue
import random
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class DeploymentStopped(RuntimeError):
    """An intentional external stop; never a successful completed workload."""


def check_stop_file(path):
    if path is None:
        return
    try:
        Path(path).lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise DeploymentStopped('stop control path could not be inspected: ' + str(error)) from error
    raise DeploymentStopped('stop file requested cancellation: ' + str(path))


def pause_until(deadline, stop_file):
    while True:
        check_stop_file(stop_file)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(.25, remaining) if stop_file is not None else remaining)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.%d.tmp' % os.getpid())
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    for attempt in range(20):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(.005)


def percentiles(values):
    values = sorted(values)
    if not values:
        return {'samples': 0}
    return dict(samples=len(values), p50=values[(len(values) - 1) // 2],
                p95=values[(95 * len(values) + 99) // 100 - 1], maximum=values[-1])


def resource_gate(summary, limits, workers, descriptor=None):
    """Check recorded observations, without treating them as an uptime guarantee."""
    require(summary['samples'] > 0, 'host resource samples are missing')
    require(summary['clean_shutdown'] and summary['final_threads'] == summary['baseline_threads'],
            'host did not return to its thread baseline')
    require(summary['native_started'] == summary['native_exited'] and not summary['native_active_pids'],
            'host left native workers running')
    require(summary['maximum_native_active'] <= workers, 'native worker concurrency exceeded its limit')
    if descriptor is None:
        descriptor = 'handles' if os.name == 'nt' else 'open_fds' if sys.platform.startswith('linux') else ''
    initial, last, peak = summary['initial'], summary['last'], summary['host_sampled_maximum']
    for metric in ('rss_bytes', 'threads') + ((descriptor,) if descriptor else ()):
        for where, sample in [('initial', initial), ('last', last), ('maximum', peak)]:
            value = sample.get(metric)
            require(type(value) is int and value > 0, '%s host %s metric is missing or invalid' % (where, metric))
    require(last['threads'] == summary['baseline_threads'], 'last host thread sample differs from its baseline')
    require(peak['rss_bytes'] <= limits['rss_peak_bytes'], 'host sampled RSS exceeded its absolute ceiling')
    require(last['rss_bytes'] - initial['rss_bytes'] <= limits['rss_retained_growth_bytes'],
            'host retained RSS growth exceeded its ceiling')
    if descriptor:
        require(peak[descriptor] <= limits[descriptor + '_peak'], 'host sampled ' + descriptor + ' exceeded its ceiling')
        require(last[descriptor] - initial[descriptor] <= limits[descriptor + '_retained_growth'],
                'host retained ' + descriptor + ' growth exceeded its ceiling')


def completion_gate(report):
    require(report.get('workload_completed') is True, 'deployment workload did not complete')
    require(report.get('traffic_duration_seconds', 0) >= report['configuration']['duration_seconds'],
            'deployment traffic duration was shorter than requested')
    require(report.get('frozen_inputs_unchanged') is True, 'frozen deployment inputs were not verified at completion')


def workspace_bytes(workspace):
    total = 0
    for path in Path(workspace).rglob('*'):
        try:
            if path.is_file(): total += path.stat().st_size
        except FileNotFoundError:
            # The sampler atomically replaces its tiny temporary metrics file.
            pass
    return total


def storage_gate(observation, limits):
    require(observation['workspace_bytes'] <= limits['workspace_bytes'], 'deployment workspace exceeded its storage ceiling')
    require(observation['report_bytes'] <= limits['report_bytes'], 'deployment report exceeded its storage ceiling')


@lru_cache(maxsize=1)
def windows_resource_api():
    # ctypes retains pointer types globally; defining Memory for every sample
    # would make the observer itself accumulate memory in the measured host.
    import ctypes
    from ctypes import wintypes
    class Memory(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (key, ctypes.c_size_t) for key in ('PeakWorkingSetSize', 'WorkingSetSize',
            'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
            'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Memory), wintypes.DWORD]
    return ctypes, wintypes, Memory, kernel, psapi


def resource(pid):
    """Best-effort process samples. Missing platform metrics remain null."""
    answer = dict(rss_bytes=None, peak_rss_bytes=None, private_bytes=None,
                  handles=None, open_fds=None, threads=None)
    try:
        if os.name == 'nt':
            ctypes, wintypes, Memory, kernel, psapi = windows_resource_api()
            handle = kernel.GetCurrentProcess() if pid == os.getpid() else kernel.OpenProcess(0x1010, False, pid)
            if not handle:
                return answer
            try:
                memory = Memory(); memory.cb = ctypes.sizeof(memory)
                if psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                    answer.update(rss_bytes=memory.WorkingSetSize, peak_rss_bytes=memory.PeakWorkingSetSize,
                                  private_bytes=memory.PrivateUsage)
                count = wintypes.DWORD()
                if kernel.GetProcessHandleCount(handle, ctypes.byref(count)):
                    answer['handles'] = count.value
            finally:
                if pid != os.getpid():
                    kernel.CloseHandle(handle)
            if pid == os.getpid():
                answer['threads'] = threading.active_count()
        elif sys.platform.startswith('linux'):
            status = Path('/proc/%d/status' % pid).read_text()
            fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
            for source, target in [('VmRSS', 'rss_bytes'), ('VmHWM', 'peak_rss_bytes')]:
                if source in fields:
                    answer[target] = int(fields[source].split()[0]) * 1024
            answer['threads'] = int(fields['Threads'])
            answer['open_fds'] = len(list(Path('/proc/%d/fd' % pid).iterdir()))
        else:
            result = subprocess.run(['ps', '-p', str(pid), '-o', 'rss='], capture_output=True,
                                    text=True, timeout=2)
            if result.returncode == 0 and result.stdout.strip():
                answer['rss_bytes'] = int(result.stdout.strip()) * 1024
            if pid == os.getpid():
                answer['threads'] = threading.active_count()
                if Path('/dev/fd').is_dir():
                    answer['open_fds'] = len(list(Path('/dev/fd').iterdir()))
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        pass
    return answer


class Probes:
    def __init__(self, binary, metrics):
        self.binary, self.metrics = str(binary), Path(metrics)
        self.active = {}; self.lock = threading.Lock(); self.stop = threading.Event()
        self.started = self.exited = self.samples = self.maximum_active = 0
        self.host_max = {}; self.native_max = {}; self.errors = []
        self.first = resource(os.getpid()); self.last = self.first
        self.real_popen = subprocess.Popen
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def clean(self):
        for pid, child in list(self.active.items()):
            if child.poll() is not None:
                del self.active[pid]
                self.exited += 1

    def launch(self, *args, **kwargs):
        child = self.real_popen(*args, **kwargs)
        argv = args[0] if args else kwargs.get('args', [])
        if argv and not isinstance(argv, str) and str(argv[0]) == self.binary:
            with self.lock:
                self.clean()
                self.active[child.pid] = child
                self.started += 1
                self.maximum_active = max(self.maximum_active, len(self.active))
        return child

    def capture(self):
        with self.lock:
            self.clean(); pids = list(self.active)
        self.last = resource(os.getpid()); self.samples += 1
        for metric, value in self.last.items():
            if value is not None:
                self.host_max[metric] = max(value, self.host_max.get(metric, 0))
        for pid in pids:
            for metric, value in resource(pid).items():
                if value is not None:
                    self.native_max[metric] = max(value, self.native_max.get(metric, 0))

    def report(self):
        with self.lock:
            self.clean()
            active = list(self.active)
        return dict(pid=os.getpid(), samples=self.samples, initial=self.first, last=self.last,
                    host_sampled_maximum=self.host_max, native_sampled_maximum=self.native_max,
                    native_started=self.started, native_exited=self.exited, native_active_pids=active,
                    maximum_native_active=self.maximum_active, errors=self.errors)

    def loop(self):
        last_saved = 0
        while not self.stop.is_set():
            try:
                self.capture()
                if time.monotonic() - last_saved >= 1:
                    save(self.metrics, self.report()); last_saved = time.monotonic()
            except Exception as error:
                self.errors.append('%s: %s' % (type(error).__name__, error))
                self.stop.set()
            self.stop.wait(.1)


def host(args):
    sys.path.insert(0, str(Path(args.sdk).resolve()))
    from sprout_service import SproutServer
    probes = Probes(args.binary, args.metrics)
    baseline_threads = threading.active_count()
    with patch('sprout_host.subprocess.Popen', new=probes.launch):
        server = SproutServer(('127.0.0.1', 0), args.program, command=args.binary, workers=args.workers, allow_io=True)
        serving = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
        probes.thread.start(); serving.start()
        print(json.dumps({'port': server.server_port, 'pid': os.getpid()}), flush=True)
        try:
            require(sys.stdin.readline().strip() == 'STOP', 'host control pipe closed without STOP')
        finally:
            server.shutdown(); server.server_close(); serving.join(timeout=3)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                with probes.lock:
                    probes.clean(); active = bool(probes.active)
                if not active and threading.active_count() <= baseline_threads + 1:
                    break
                time.sleep(.02)
            probes.stop.set(); probes.thread.join(timeout=3); probes.capture()
            summary = probes.report()
            summary['final_threads'] = threading.active_count()
            summary['baseline_threads'] = baseline_threads
            summary['clean_shutdown'] = not summary['native_active_pids'] and summary['final_threads'] == baseline_threads
            save(args.metrics, summary)
    return 0 if summary['clean_shutdown'] and not summary['errors'] else 1


class Service:
    def __init__(self, frozen, program, binary, workers, metrics):
        self.metrics = metrics; self.stderr = bytearray(); self.lines = queue.Queue()
        command = [sys.executable, str(frozen / 'tools/deployment_soak.py'), 'host',
                   '--sdk', str(frozen / 'integrations/python'), '--program', str(program),
                   '--binary', str(binary), '--workers', str(workers), '--metrics', str(metrics)]
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, start_new_session=os.name != 'nt',
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        def output():
            for line in self.process.stdout:
                self.lines.put(line)
            self.lines.put(None)
        def error():
            for chunk in iter(lambda: self.process.stderr.read(4096), b''):
                if len(self.stderr) < 65536:
                    self.stderr.extend(chunk[:65536 - len(self.stderr)])
        self.readers = [threading.Thread(target=output, daemon=True), threading.Thread(target=error, daemon=True)]
        for thread in self.readers: thread.start()
        try:
            line = self.lines.get(timeout=10)
            require(line is not None, 'HTTP host exited during startup')
            reply = json.loads(line); self.port = reply['port']
            require(reply['pid'] == self.process.pid and 1 <= self.port <= 65535, 'invalid host startup record')
        except BaseException:
            self.process.kill(); self.process.wait(timeout=5)
            for thread in self.readers: thread.join(timeout=3)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if not stream.closed: stream.close()
            raise

    def request(self, method, path, value=None, *, timeout=6):
        raw = None if value is None else json.dumps(value, ensure_ascii=False).encode('utf-8')
        with closing(http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)) as client:
            client.request(method, path, raw, {'Content-Type': 'application/json', 'Connection': 'close'})
            response = client.getresponse(); body = response.read(1048577)
            require(len(body) <= 1048576, 'HTTP response exceeds the bounded byte cap')
            return response.status, body

    def close(self):
        try:
            self.process.stdin.write(b'STOP\n'); self.process.stdin.close()
            exit_code = self.process.wait(timeout=12)
        except (OSError, subprocess.TimeoutExpired):
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                               capture_output=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                import signal
                os.killpg(self.process.pid, signal.SIGKILL)
            self.process.kill(); self.process.wait(timeout=5)
            raise AssertionError('HTTP host did not shut down within its deadline')
        finally:
            for thread in self.readers: thread.join(timeout=3)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if not stream.closed: stream.close()
        require(exit_code == 0, 'HTTP host exit %d: %s' % (exit_code, self.stderr.decode('utf-8', 'replace')[:1000]))
        summary = json.loads(self.metrics.read_text(encoding='utf-8'))
        require(summary['clean_shutdown'] and summary['native_started'] == summary['native_exited'],
                'HTTP host left native children or threads running')
        require(not self.stderr and not summary['errors'], 'unexpected host/probe errors: ' + self.stderr.decode('utf-8', 'replace')[:1000])
        return summary


def contact(index, seed):
    names = ['Ada', "O'Reilly", 'Zoë', '李雷', 'A & B', "Robert'); DROP TABLE contacts;--"]
    rng = random.Random(seed ^ index)
    return {'name': '%s %08d %08x' % (rng.choice(names), index, rng.getrandbits(32)),
            'email': 'deployment-%d-%08d@example.test' % (seed, index)}


def write_contact(service, value):
    started = time.perf_counter(); deadline = started + 15
    statuses = Counter(); errors = Counter(); attempts = []
    rng = random.Random(value['email'])
    for attempt in range(32):
        remaining = deadline - time.perf_counter()
        if remaining <= 0: break
        when = time.perf_counter()
        try:
            status, raw = service.request('POST', '/contacts', value, timeout=min(6, remaining))
            require(time.perf_counter() <= deadline, 'contact response exceeded its logical deadline: ' + value['email'])
            statuses[str(status)] += 1
            if status == 201:
                require(json.loads(raw) == {'ok': True}, 'invalid successful POST body')
                return dict(statuses=statuses, transport=errors, attempt_ms=attempts + [(time.perf_counter()-when)*1000],
                            logical_ms=(time.perf_counter()-started)*1000, ambiguous=False)
            if status == 409 and errors:
                require(json.loads(raw) == {'error': 'email already exists'}, 'invalid retry duplicate response')
                return dict(statuses=statuses, transport=errors, attempt_ms=attempts + [(time.perf_counter()-when)*1000],
                            logical_ms=(time.perf_counter()-started)*1000, ambiguous=True)
            require(status == 503, 'unexpected POST status %d: %r' % (status, raw[:200]))
            if raw: require(json.loads(raw).get('error') == 'database unavailable', 'unexpected application 503')
        except (OSError, http.client.HTTPException) as error:
            errors[type(error).__name__] += 1
        attempts.append((time.perf_counter() - when) * 1000)
        backoff = min(.25, .01 * 2 ** min(attempt, 5)) * rng.uniform(.5, 1.5)
        time.sleep(min(backoff, max(0, deadline - time.perf_counter())))
    raise AssertionError('contact retry/deadline limit exhausted: ' + value['email'])


def verify(service, folder, expected):
    status, body = service.request('GET', '/contacts')
    require(status == 200, 'verification GET failed with %d' % status)
    http_rows = json.loads(body)['contacts']
    with closing(sqlite3.connect(folder / 'contacts.sqlite', timeout=2)) as database:
        rows = database.execute('SELECT id,name,email FROM contacts').fetchall()
        require(database.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity check failed')
    def check(rows):
        require(len(rows) == len(expected), 'contact count differs from independent expected dataset')
        found = {}; ids = set()
        for identifier, name, email in rows:
            require(type(identifier) is int and identifier > 0 and identifier not in ids, 'invalid/duplicate contact ID')
            require(email not in found, 'duplicate contact email')
            ids.add(identifier); found[email] = name
        require(found == expected, 'contact values differ from the independent expected dataset')
    check(rows)
    check(http_rows)


def main(args):
    stop_file = Path(args.stop_file).absolute() if getattr(args, 'stop_file', None) is not None else None
    args.stop_file = stop_file
    for value, name in [(args.duration_seconds, 'duration'), (args.rate, 'rate'),
                        (args.restart_seconds, 'restart interval'), (args.contention_seconds, 'contention interval')]:
        require(math.isfinite(value) and value > 0, name + ' must be finite and positive')
    require(1 <= args.clients <= 64 and 1 <= args.workers <= 64 and 1 <= args.burst <= args.clients,
            'clients/workers must be1..64 and burst must fit clients')
    require(args.shard_contacts >= args.burst and args.shard_contacts <= 5000, 'shard contacts must be burst..5000')
    for value in (args.max_host_rss_mib, args.max_retained_rss_growth_mib, args.max_host_handles,
                  args.max_retained_handles_growth, args.max_host_fds, args.max_retained_fds_growth,
                  args.max_workspace_mib, args.max_report_mib):
        require(math.isfinite(value) and value > 0, 'resource ceilings must be finite and positive')
    resource_limits = dict(rss_peak_bytes=round(args.max_host_rss_mib * 1048576),
                           rss_retained_growth_bytes=round(args.max_retained_rss_growth_mib * 1048576),
                           handles_peak=args.max_host_handles, handles_retained_growth=args.max_retained_handles_growth,
                           open_fds_peak=args.max_host_fds, open_fds_retained_growth=args.max_retained_fds_growth)
    storage_limits = dict(workspace_bytes=round(args.max_workspace_mib * 1048576),
                          report_bytes=round(args.max_report_mib * 1048576))
    workspace = args.workspace.resolve(); require(not workspace.exists(), 'workspace must be a new directory')
    frozen = workspace / 'frozen'; frozen.mkdir(parents=True)
    source_files = {'bin/' + ('sprout.exe' if os.name == 'nt' else 'sprout'): args.binary.resolve(),
                    'tools/deployment_soak.py': Path(__file__).resolve(),
                    'integrations/python/sprout_host.py': ROOT / 'integrations/python/sprout_host.py',
                    'integrations/python/sprout_service.py': ROOT / 'integrations/python/sprout_service.py',
                    'examples/services/contacts.sprout': ROOT / 'examples/services/contacts.sprout'}
    hashes = {}
    for relative, original in source_files.items():
        before = sha(original); target = frozen / relative; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target); require(sha(target) == before, 'source changed during snapshot: ' + str(original))
        hashes[relative] = before
    binary = frozen / ('bin/sprout.exe' if os.name == 'nt' else 'bin/sprout')
    report = dict(timestamp_utc=datetime.now(timezone.utc).isoformat(), label=args.label, controller_pid=os.getpid(),
                  platform=platform.platform(), python=platform.python_version(), sqlite_oracle_version=sqlite3.sqlite_version,
                  latency_clock=dict(name='perf_counter', implementation=time.get_clock_info('perf_counter').implementation,
                                     resolution_seconds=time.get_clock_info('perf_counter').resolution),
                  workspace=str(workspace), frozen_sha256=hashes, configuration=vars(args).copy(),
                  counts=dict(contacts=0, bursts=0, health_checks=0, oracle_checks=0, contention_503=0,
                              duplicate_409=0, ambiguous_commits=0, hosts_started=0, hosts_cleanly_stopped=0),
                  post_status_counts=Counter(), transport_errors=Counter(), hosts=[], shards=[], errors=[],
                  resource_scope='Service host sampled every 100 ms; native children observed at launch and sampled while alive. '
                                 'Sampled maxima can miss short-lived peaks. Windows threads count Python threads; '
                                 'Windows handles and POSIX open_fds have different meanings. POSIX FD enumeration may include its probe descriptor.',
                  resource_limits=resource_limits, resource_gates='Required host metrics and sampled ceilings checked after every epoch.',
                  storage_limits=storage_limits,
                  workload_completed=False, state='running', passed=None)
    report['configuration'] = {key: str(value) if isinstance(value, Path) else value for key, value in report['configuration'].items()}
    report['interpretation'] = (
        'Bounded local HTTP/SQLite deployment exercise with graceful process restarts, not uptime certification '
        'or proof of crash/high-availability behavior. SQLite shards rotate before the all-rows GET output cap. '
        'Independent expected records and unique email keys reconcile transport retries; not exactly-once delivery.')
    save(workspace / 'manifest.json', report); save(args.report, report)
    started = time.monotonic(); until = started + args.duration_seconds
    statuses = report['post_status_counts']; transports = report['transport_errors']; counts = report['counts']
    attempt_ms = []; logical_ms = []; service = None; shard = -1; expected = {}; folder = None; index = 0
    next_restart = next_health = next_contention = next_save = next_burst = started
    oracle = sqlite3.connect(workspace / 'independent-oracle.sqlite')
    oracle.execute('CREATE TABLE expected(shard INTEGER, email TEXT PRIMARY KEY, name TEXT NOT NULL)')
    baseline_threads = threading.active_count()
    print('Deployment run PID %d; frozen binary %s; report %s' % (os.getpid(), hashes[next(iter(hashes))], args.report), flush=True)
    def persist(enforce_budget=True):
        report.update(elapsed_seconds=time.monotonic()-started, logical_contact_latency_ms=percentiles(logical_ms),
                      post_attempt_latency_ms=percentiles(attempt_ms), active_host_pid=service.process.pid if service else None)
        observation = dict(workspace_bytes=workspace_bytes(workspace), report_bytes=0)
        report['storage_observation'] = observation
        # Recompute after adding the length field until its own digit count settles.
        for _ in range(3): observation['report_bytes'] = len((json.dumps(report, indent=2) + '\n').encode('utf-8'))
        if enforce_budget: storage_gate(observation, storage_limits)
        save(args.report, report); save(workspace / 'progress.json', report)
    def stop_host():
        nonlocal service
        if service:
            stopping, service = service, None
            summary = stopping.close(); summary['epoch_seconds'] = time.monotonic() - host_started
            summary['shard'] = shard; report['hosts'].append(summary)
            counts['hosts_cleanly_stopped'] += 1
            resource_gate(summary, resource_limits, args.workers)
    try:
        check_stop_file(stop_file)
        with ThreadPoolExecutor(max_workers=args.clients) as pool:
            while time.monotonic() < until:
                check_stop_file(stop_file)
                now = time.monotonic()
                rotate = service is None or len(expected) + args.burst > args.shard_contacts
                restart = now >= next_restart
                if rotate or restart:
                    if service:
                        verify(service, folder, expected); counts['oracle_checks'] += 1
                        stop_host()
                    if rotate:
                        if folder:
                            report['shards'].append(dict(shard=shard, verified_contacts=len(expected), integrity='ok'))
                        shard += 1; folder = workspace / ('shard-%04d' % shard); folder.mkdir()
                        shutil.copy2(frozen / 'examples/services/contacts.sprout', folder / 'contacts.sprout')
                        expected = {}
                    host_started = time.monotonic()
                    service = Service(frozen, folder / 'contacts.sprout', binary, args.workers,
                                      workspace / ('host-%04d-metrics.json' % counts['hosts_started']))
                    counts['hosts_started'] += 1
                    status, body = service.request('GET', '/health'); require(status == 200 and json.loads(body)['ok'], 'new host health failed')
                    verify(service, folder, expected); counts['oracle_checks'] += 1
                    next_restart = time.monotonic() + args.restart_seconds
                    print('Started HTTP host PID %d on shard %d with %d retained contacts' %
                          (service.process.pid, shard, len(expected)), flush=True)
                if now >= next_health:
                    status, body = service.request('GET', '/health'); require(status == 200 and json.loads(body)['ok'], 'health probe failed')
                    counts['health_checks'] += 1; next_health = time.monotonic() + 10
                values = [contact(index + offset, args.seed) for offset in range(args.burst)]
                for value in values:
                    expected[value['email']] = value['name']
                    oracle.execute('INSERT INTO expected VALUES(?,?,?)', (shard, value['email'], value['name']))
                oracle.commit(); index += len(values)
                if now >= next_contention:
                    with closing(sqlite3.connect(folder / 'contacts.sqlite', timeout=2)) as holder:
                        holder.execute('BEGIN EXCLUSIVE')
                        try:
                            status, body = service.request('POST', '/contacts', values[0])
                            require(status == 503 and json.loads(body) == {'error': 'database unavailable'}, 'locked SQLite database did not return503')
                            counts['contention_503'] += 1
                        finally:
                            holder.rollback()
                    next_contention = time.monotonic() + args.contention_seconds
                for result in pool.map(lambda value: write_contact(service, value), values):
                    statuses.update(result['statuses']); transports.update(result['transport'])
                    attempt_ms.extend(result['attempt_ms']); logical_ms.append(result['logical_ms'])
                    counts['ambiguous_commits'] += int(result['ambiguous']); counts['contacts'] += 1
                counts['bursts'] += 1
                check_stop_file(stop_file)
                if counts['bursts'] % 15 == 0:
                    verify(service, folder, expected); counts['oracle_checks'] += 1
                    duplicate = dict(values[-1], name='Must not replace the original')
                    status, body = service.request('POST', '/contacts', duplicate)
                    require(status == 409 and json.loads(body) == {'error': 'email already exists'}, 'duplicate email was not409')
                    counts['duplicate_409'] += 1
                if now >= next_save:
                    persist(); next_save = time.monotonic() + 30
                    print('Elapsed %.1f s / contacts %d / hosts %d / errors %d' %
                          (time.monotonic()-started, counts['contacts'], counts['hosts_started'], len(report['errors'])), flush=True)
                next_burst = max(next_burst + len(values) / args.rate, time.monotonic())
                pause_until(min(next_burst, until), stop_file)
            check_stop_file(stop_file)
            report['traffic_duration_seconds'] = time.monotonic() - started
            verify(service, folder, expected); counts['oracle_checks'] += 1
            stop_host()
            report['shards'].append(dict(shard=shard, verified_contacts=len(expected), integrity='ok'))
        require(threading.active_count() == baseline_threads, 'controller thread count grew after shutdown')
        require(oracle.execute('SELECT count(*) FROM expected').fetchone()[0] == counts['contacts'], 'independent scheduled/completed count mismatch')
        require(oracle.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'independent oracle integrity failed')
        require(all(sha(frozen / relative) == value for relative, value in hashes.items()), 'frozen input changed during run')
        report['frozen_inputs_unchanged'] = True
        check_stop_file(stop_file)
        report['workload_completed'] = True
        completion_gate(report)
        persist()
    except BaseException as error:
        report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        if isinstance(error, (DeploymentStopped, KeyboardInterrupt)):
            report['stop_requested'] = True
            report['workload_completed'] = False
        print('Deployment invariant failed: ' + str(error), flush=True)
    finally:
        if report.get('stop_requested') and service:
            try:
                verify(service, folder, expected); counts['oracle_checks'] += 1
                report['partial_dataset_verified'] = True
            except Exception as error:
                report['partial_dataset_verified'] = False
                report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        if service:
            try: stop_host()
            except Exception as error: report['errors'].append(dict(type=type(error).__name__, message=str(error)))
        oracle.close()
        report['state'] = 'interrupted' if report.get('stop_requested') else 'finished'
        report['passed'] = not report['errors']
        # Preserve the failed report even if a budget check triggered the stop.
        persist(enforce_budget=False)
    print(json.dumps({key: report[key] for key in ('state', 'passed', 'elapsed_seconds', 'counts', 'errors')}, indent=2), flush=True)
    return 0 if report['passed'] else 1


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    if len(sys.argv) > 1 and sys.argv[1] == 'host':
        sys.argv.pop(1)
        for name in ('sdk', 'program', 'binary', 'metrics'): parser.add_argument('--' + name, required=True)
        parser.add_argument('--workers', type=int, required=True)
        return host(parser.parse_args())
    parser.add_argument('binary', type=Path)
    parser.add_argument('--duration-seconds', type=float, default=1800)
    parser.add_argument('--rate', type=float, default=4, help='Target new contacts/sec; bursts and restart/check overhead may reduce actual rate.')
    parser.add_argument('--clients', type=int, default=8)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--burst', type=int, default=8)
    parser.add_argument('--restart-seconds', type=float, default=180)
    parser.add_argument('--contention-seconds', type=float, default=60)
    parser.add_argument('--shard-contacts', type=int, default=2000)
    parser.add_argument('--max-host-rss-mib', type=float, default=128)
    parser.add_argument('--max-retained-rss-growth-mib', type=float, default=64)
    parser.add_argument('--max-host-handles', type=int, default=512)
    parser.add_argument('--max-retained-handles-growth', type=int, default=128)
    parser.add_argument('--max-host-fds', type=int, default=128)
    parser.add_argument('--max-retained-fds-growth', type=int, default=32)
    parser.add_argument('--max-workspace-mib', type=float, default=256)
    parser.add_argument('--max-report-mib', type=float, default=4)
    parser.add_argument('--seed', type=int, default=20261011)
    parser.add_argument('--label', default='76ba445-baseline')
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--stop-file', type=Path, help='Creating this path requests an interrupted, unsuccessful run with owned host cleanup.')
    return main(parser.parse_args())


if __name__ == '__main__':
    raise SystemExit(arguments())
