"""Private finite runner; execution requires caller-pinned reviewed measurement scope."""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
from collections import deque
import ctypes
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import queue
import statistics
import stat
import shutil
import subprocess
import sys
import threading
import time

from measurement_fixtures import PURE_IDS, SDK_IDS, compact, fixtures, schedule, sdk_fixtures, strict_equal


class ContractError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message); self.code = code


class SampleError(ContractError):
    def __init__(self, error, observation):
        super().__init__(getattr(error, 'code', 'worker_exception'), str(error)[:512])
        self.observation = observation


def require(condition, code, message):
    if not condition: raise ContractError(code, message)


def sha(path, maximum=None):
    return bounded_sha(path, INPUT_BOUNDS['source_file_bytes'] if maximum is None else maximum)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_json_key', 'Duplicate decoded JSON key')
            result[key] = value
        return result
    def invalid(_): raise ContractError('nonfinite_json', 'Non-finite JSON is unavailable')
    def finite(text):
        value = float(text)
        require(math.isfinite(value), 'nonfinite_json', 'Non-finite JSON is unavailable')
        return value
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite)
        def scalar(item, depth=0):
            require(depth <= 128, 'json_depth', 'JSON exceeds 128 containers')
            if type(item) is str:
                require(not any(ord(letter) == 0 or 0xD800 <= ord(letter) <= 0xDFFF for letter in item), 'json_text', 'JSON text must contain Unicode scalars without NUL')
            elif type(item) is dict:
                for key, child in item.items(): scalar(key, depth + 1); scalar(child, depth + 1)
            elif type(item) is list:
                for child in item: scalar(child, depth + 1)
        scalar(value)
        return value
    except (UnicodeError, ValueError, RecursionError) as error:
        raise ContractError('invalid_json', 'Result is not strict UTF-8 JSON') from error


class Clock:
    def __init__(self, read=time.perf_counter_ns): self.read, self.previous, self.failure = read, None, None
    def now(self):
        try: raw = self.read()
        except BaseException as error:
            if self.failure is None:
                self.failure = {'previous_ns': str(self.previous) if self.previous is not None else None,
                                'observed_ns': None, 'read_error_type': type(error).__name__}
            raise
        if (type(raw) is not int or raw < 0 or self.previous is not None and raw < self.previous) and self.failure is None:
            self.failure = {'previous_ns': str(self.previous) if self.previous is not None else None,
                            'observed_ns': str(raw) if type(raw) is int else None, 'observed_type': type(raw).__name__}
        require(type(raw) is int and raw >= 0, 'clock_type', 'Clock must return nonnegative integer nanoseconds')
        require(self.previous is None or raw >= self.previous, 'clock_backwards', 'Monotonic clock moved backward')
        self.previous = raw
        return raw


class Budget:
    def __init__(self, clock=None, supervised_ns=90000000000, launch_ceiling=208):
        self.clock = clock or Clock(); self.start = self.clock.now()
        self.deadline = self.start + supervised_ns; self.ceiling = launch_ceiling; self.reserved = 0
    def remaining_ns(self):
        now = self.clock.now()
        require(now < self.deadline, 'overall_deadline', 'Supervised measurement deadline exhausted')
        return self.deadline - now
    def reserve(self):
        self.remaining_ns()
        require(self.reserved < self.ceiling, 'launch_ceiling', 'Native launch reservation ceiling exhausted')
        self.reserved += 1
    def seconds(self, cap): return min(cap, self.remaining_ns() / 1000000000)


PROFILE = 'windows-native-sqlite-normal-v1'
BOUNDS = {'supervised_ns': 90000000000, 'launch_ceiling': 208, 'cleanup_seconds': 2,
          'prepared_host_seconds': 4, 'runtime_ms': 3000, 'steps': 20000000,
          'stdout_bytes': 262144, 'stderr_bytes': 65536, 'fixture_bytes': 1048576, 'report_bytes': 2097152}
SCHEDULE = {'pure': 156, 'sdk': 48, 'planned_native_calls': 204, 'native_launch_ceiling': 208,
            'warmups': 34, 'samples': 5}
INPUT_BOUNDS = {'selection_bytes': 65536, 'metadata_bytes': 1048576, 'source_file_bytes': 33554432,
                'native_compiler_bytes': 67108864, 'host_executable_bytes': 268435456, 'snapshot_bytes': 268435456}


def file_bound(path, maximum):
    require(type(maximum) is int and maximum >= 0, 'input_size', 'Byte limit must be nonnegative integer')
    info = Path(path).stat()
    require(stat.S_ISREG(info.st_mode) and type(info.st_size) is int and 0 <= info.st_size <= maximum,
            'input_size', 'Input must be a bounded regular file')
    return info.st_size


def bounded_file(path, maximum, collect=False, expected_size=None):
    require(expected_size is None or type(expected_size) is int and 0 <= expected_size <= maximum,
            'input_size', 'Credited size must fit the byte limit')
    initial = file_bound(path, maximum)
    require(expected_size is None or initial == expected_size, 'input_changed', 'Input differs from its credited size')
    total, chunks = 0, []
    with Path(path).open('rb') as stream:
        opened = os.fstat(stream.fileno())
        require(stat.S_ISREG(opened.st_mode) and type(opened.st_size) is int and opened.st_size == initial,
                'input_changed', 'Opened input differs from initial regular file')
        digest = hashlib.sha256()
        while total < maximum:
            allowance = min(65536, maximum - total)
            data = stream.read(allowance)
            require(type(data) is bytes and len(data) <= allowance, 'input_size', 'Stream returned more than its bounded read')
            if not data: break
            total += len(data); digest.update(data)
            if collect: chunks.append(data)
        final = os.fstat(stream.fileno())
        require(stat.S_ISREG(final.st_mode) and type(final.st_size) is int and final.st_size == initial == total,
                'input_changed', 'Input size changed or read did not complete within its bound')
    return digest.hexdigest(), b''.join(chunks) if collect else None


def bounded_sha(path, maximum, expected_size=None): return bounded_file(path, maximum, expected_size=expected_size)[0]


def bounded_json(path, maximum=1048576): return strict_json(bounded_file(path, maximum, True)[1])


def pinned_json(path, pin, maximum=1048576):
    require(digest_text(pin), 'input_hash', 'Canonical caller pin required')
    digest, raw = bounded_file(path, maximum, True)
    require(digest == pin, 'input_hash', 'Caller-pinned metadata changed')
    return strict_json(raw)


def inventory_file_limit(name):
    if name == 'provenance/compiler.bin' or name.startswith('native/'): return INPUT_BOUNDS['native_compiler_bytes']
    if name.startswith(('fixtures/', 'drivers/')): return BOUNDS['fixture_bytes']
    if name.endswith('.json'): return INPUT_BOUNDS['metadata_bytes']
    return INPUT_BOUNDS['source_file_bytes']


def digest_text(value, length=64):
    return type(value) is str and len(value) == length and all(c in '0123456789abcdef' for c in value)


def inventory_path(root, name):
    require(type(name) is str and 0 < len(name) <= 512 and not name.startswith('/') and
            not any(c in name for c in ('\\', ':', '\x00')) and
            not any(part in ('', '.', '..') for part in name.split('/')), 'inventory_path', 'Snapshot path must be a bounded relative name')
    root = Path(root).resolve(); path = root / name
    require(not path.is_symlink() and path.resolve().is_relative_to(root), 'inventory_path', 'Snapshot path escapes its root')
    return path


def verify_inventory(root, files):
    require(type(files) is dict and 1 <= len(files) <= 128, 'manifest_shape', 'Invalid file inventory')
    selected = []; aggregate = 0
    for name, expected in files.items():
        path = inventory_path(root, name); maximum = inventory_file_limit(name)
        require(digest_text(expected), 'source_hash', 'Frozen digest is not canonical')
        credited = file_bound(path, maximum); aggregate += credited
        require(aggregate <= INPUT_BOUNDS['snapshot_bytes'], 'input_size', 'Aggregate snapshot exceeds fixed byte cap')
        selected.append((path, credited, expected))
    actual = 0
    for path, credited, expected in selected:
        require(credited <= INPUT_BOUNDS['snapshot_bytes'] - actual, 'input_size', 'Inventory read exceeds remaining aggregate')
        digest = bounded_sha(path, credited, expected_size=credited)
        # A completed bounded read is exactly credited bytes; a failed read is at most that reservation.
        actual += credited
        require(actual <= INPUT_BOUNDS['snapshot_bytes'] and digest == expected, 'source_hash', 'Frozen input hash mismatch')
    require(actual == aggregate, 'input_changed', 'Inventory consumed size differs from preflight credit')
    return actual


def validate_spec(spec):
    require(type(spec) is dict and spec.get('schema') == 'sprout.library-workloads.v1' and spec.get('profile') == PROFILE,
            'specification', 'Unsupported workload specification/profile')
    require(strict_equal(spec.get('bounds'), BOUNDS) and strict_equal(spec.get('schedule'), SCHEDULE) and strict_equal(spec.get('input_bounds'), INPUT_BOUNDS) and
            strict_equal(spec.get('pure_ids'), list(PURE_IDS)) and strict_equal(spec.get('sdk_ids'), list(SDK_IDS)) and
            spec.get('pair_order') == ['full/control', 'control/full', 'full/control', 'control/full', 'full/control'],
            'specification', 'Fixed workload budget/schedule changed')


def runtime_path(root):
    return inventory_path(root, bounded_json(Path(root) / 'manifest.json')['native'])


def host_tool_path(root, name):
    selected = bounded_json(Path(root) / 'manifest.json')['host_tools'][name]
    require(type(selected['path']) is str and selected['path'], 'host_tool', 'Selected executable path is missing')
    path = Path(selected['path'])
    return str((path if path.is_absolute() else Path(root) / path).resolve())


def execution_platform_supported(): return os.name == 'nt'


def verify_manifest(root, trusted_digest):
    root = Path(root).resolve()
    manifest = pinned_json(root / 'manifest.json', trusted_digest)
    require(manifest.get('schema') == 'sprout.finite-measurement-snapshot.v2' and manifest.get('profile') == PROFILE,
            'manifest_shape', 'Unsupported snapshot/profile')
    verify_inventory(root, manifest.get('files'))
    validate_spec(bounded_json(inventory_path(root, manifest['specification'])))
    require(strict_equal(manifest.get('bounds'), BOUNDS) and strict_equal(manifest.get('schedule'), SCHEDULE), 'manifest_shape', 'Snapshot limits changed')
    require(digest_text(manifest.get('revision'), 40) and all(digest_text(manifest.get(key)) for key in ('native_sha256', 'build_sha256', 'ci_sha256', 'compiler_sha256')),
            'manifest_shape', 'Snapshot candidate digests missing')
    require(manifest['files'].get(manifest['native']) == manifest['native_sha256'] and
            manifest['files'].get(manifest['compiler']) == manifest['compiler_sha256'], 'manifest_shape', 'Candidate bytes differ from metadata identity')
    require(type(manifest.get('host_tools')) is dict and set(manifest['host_tools']) == {'python', 'node'}, 'host_tool', 'Python/Node selection missing')
    for selected in manifest['host_tools'].values():
        require(type(selected) is dict and set(selected) == {'path', 'sha256'} and type(selected['path']) is str and selected['path'] and digest_text(selected['sha256']),
                'host_tool', 'Executable identity must be explicit')
    require(bounded_json(root / 'schedule.json') == schedule(), 'schedule', 'Frozen schedule differs')
    return manifest


class PipeReader:
    """One raw stdout owner throughout READY/DONE/result/EOF; no communicate handoff."""
    def __init__(self, stream, maximum, lines=False):
        self.stream, self.maximum, self.lines = stream, maximum, lines
        self.raw = bytearray(); self.received = 0; self.frames = queue.Queue(maxsize=8); self.error = None
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.started = False
    def start(self):
        try: self.thread.start()
        finally: self.started = self.thread.ident is not None
    def latch(self, code, message):
        if self.error is None: self.error = ContractError(code, message)
    def emit(self, frame):
        try: self.frames.put_nowait(frame)
        except queue.Full: self.latch('too_many_frames', 'Output exceeded the finite protocol frame count')
    def read(self):
        pending = bytearray()
        try:
            while True:
                data = self.stream.read(4096)
                if not data: break
                self.received += len(data)
                if len(self.raw) + len(data) > self.maximum:
                    self.raw.extend(data[:self.maximum - len(self.raw)])
                    self.latch('stdout_limit' if self.lines else 'stderr_limit', 'Worker output exceeds its byte cap'); break
                self.raw.extend(data)
                if self.lines:
                    pending.extend(data)
                    while b'\n' in pending:
                        end = pending.index(b'\n') + 1
                        self.emit(bytes(pending[:end])); del pending[:end]
                    if self.error: break
            if pending: self.emit(bytes(pending))
        except OSError as error:
            self.latch('pipe_read', 'Owned stream read failed: ' + str(error)[:256])
        finally:
            self.emit(None)
            try: self.stream.close()
            except OSError as error: self.latch('pipe_close', 'Owned stream close failed: ' + str(error)[:256])
    def line(self, seconds):
        until = time.monotonic() + seconds
        while True:
            if self.error: raise self.error
            remaining = until - time.monotonic()
            require(remaining > 0, 'worker_deadline', 'Worker protocol deadline exhausted')
            try: frame = self.frames.get(timeout=min(remaining, .01))
            except queue.Empty: continue
            if self.error: raise self.error
            require(frame is not None, 'unexpected_eof', 'Worker exited before the required protocol frame')
            require(frame.endswith(b'\n'), 'partial_frame', 'Worker emitted an unterminated frame')
            return frame[:-2] if frame.endswith(b'\r\n') else frame[:-1]

    def eof(self, seconds):
        until = time.monotonic() + seconds
        while True:
            if self.error: raise self.error
            remaining = until - time.monotonic()
            require(remaining > 0, 'worker_deadline', 'Expected EOF exceeded execution budget')
            try: frame = self.frames.get(timeout=min(remaining, .01))
            except queue.Empty: continue
            if self.error: raise self.error
            require(frame is None and self.frames.empty(), 'extra_frame', 'Worker produced data after the final result')
            return


class PipeWriter:
    """Owned persistent stdin writer; a blocked OS write never blocks the supervisor."""
    def __init__(self, stream):
        self.stream = stream; self.jobs = queue.Queue(maxsize=2); self.halt = threading.Event()
        self.close_error = None
        self.thread = threading.Thread(target=self.write, daemon=True); self.started = False
    def start(self):
        try: self.thread.start()
        finally: self.started = self.thread.ident is not None
    def write(self):
        try:
            while not self.halt.is_set():
                try: data, done, errors = self.jobs.get(timeout=.01)
                except queue.Empty: continue
                try:
                    at = 0
                    while at < len(data):
                        count = self.stream.write(data[at:])
                        if not count: raise OSError('Owned pipe did not accept data')
                        at += count
                    self.stream.flush()
                except OSError as error: errors.append(error)
                finally: done.set()
        finally:
            try: self.stream.close()
            except OSError as error: self.close_error = str(error)[:256]
    def send(self, data, seconds):
        require(type(data) is bytes and 0 < len(data) <= 4096, 'stdin_size', 'Host tokens must be bounded bytes')
        done, errors = threading.Event(), []
        try: self.jobs.put_nowait((data, done, errors))
        except queue.Full as error: raise ContractError('stdin_queue', 'Owned writer queue is full') from error
        require(done.wait(seconds), 'stdin_deadline', 'Owned stdin writer did not complete within the execution budget')
        if errors: raise ContractError('stdin', 'Owned worker stdin failed') from errors[0]
    def stop(self): self.halt.set()


class OwnedProcess:
    def __init__(self, argv, cwd, stdout_cap=262144, stderr_cap=65536, tree=False):
        self.argv, self.stdout, self.stderr, self.writer, self.job = argv, None, None, None, None
        self.cleanup_result, self.tree = None, tree
        self.child = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, bufsize=0,
                                      start_new_session=os.name == 'posix',
                                      creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            if tree and os.name == 'nt': self.job = WindowsJob(self.child)
            self.stdout = PipeReader(self.child.stdout, stdout_cap, True)
            self.stderr = PipeReader(self.child.stderr, stderr_cap)
            self.writer = PipeWriter(self.child.stdin)
            self.stdout.start(); self.stderr.start(); self.writer.start()
        except BaseException as error:
            cleanup = self.close()
            error.n007_cleanup = cleanup; error.n007_pid = self.child.pid
            raise
    def send(self, value, seconds):
        require(self.child.poll() is None, 'child_exited', 'Owned worker exited before host acknowledgement')
        self.writer.send(value, seconds)
    def marker(self, expected, seconds):
        require(self.stdout.line(seconds) == expected, 'marker', 'Unexpected worker protocol marker')
        require(self.child.poll() is None, 'not_live', 'Worker must remain alive at the handshake point')
    def finish(self, seconds):
        until = time.monotonic() + seconds
        self.writer.stop()
        self.stdout.eof(max(0, until - time.monotonic()))
        try: self.child.wait(timeout=max(0, until - time.monotonic()))
        except subprocess.TimeoutExpired as error: raise ContractError('worker_deadline', 'Normal exit exceeded execution budget') from error
        require(self.child.returncode == 0, 'exit', 'Worker did not exit successfully')
    def close(self, seconds=2):
        if self.cleanup_result is not None: return self.cleanup_result
        until = time.monotonic() + seconds
        diagnostics = []; terminated = False
        if self.child.poll() is None:
            try:
                if self.job:
                    self.job.terminate(); terminated = True
                elif os.name == 'posix':
                    import signal
                    os.killpg(self.child.pid, signal.SIGKILL); terminated = True
                else:
                    self.child.kill(); terminated = True
            except (OSError, PermissionError) as error:
                diagnostics.append({'operation': 'owned_termination', 'errno': error.errno, 'message': str(error)[:256]})
                try: self.child.kill()
                except OSError as direct: diagnostics.append({'operation': 'direct_termination', 'errno': direct.errno, 'message': str(direct)[:256]})
        reaped = self.child.poll() is not None
        try:
            self.child.wait(timeout=max(0, until - time.monotonic())); reaped = True
        except subprocess.TimeoutExpired:
            diagnostics.append({'operation': 'direct_reap', 'message': 'Owned direct child did not exit within cleanup budget'})
        if self.writer: self.writer.stop()
        readers_done = True
        for reader, stream in ((self.writer, self.child.stdin), (self.stdout, self.child.stdout), (self.stderr, self.child.stderr)):
            if reader and reader.started:
                reader.thread.join(max(0, until - time.monotonic()))
                readers_done = readers_done and not reader.thread.is_alive()
            elif reaped:
                if stream:
                    try: stream.close()
                    except OSError as error: diagnostics.append({'operation': 'unstarted_stream_close', 'errno': error.errno, 'message': str(error)[:256]})
        job_empty = None
        if self.job:
            job_empty = self.job.empty()
            try: self.job.close()
            except OSError as error: diagnostics.append({'operation': 'job_close', 'errno': error.errno, 'message': str(error)[:256]})
        if self.writer and self.writer.close_error:
            diagnostics.append({'operation': 'stdin_close', 'message': self.writer.close_error})
        tree_confirmed = not self.tree or job_empty is True
        self.cleanup_result = {'direct_reaped': reaped, 'exit_code': self.child.returncode, 'readers_joined': readers_done,
                'termination_requested': terminated, 'job_empty': job_empty, 'cleanup_errors': diagnostics,
                'tree_confirmed': tree_confirmed,
                'confirmed': reaped and readers_done and not diagnostics and tree_confirmed}
        return self.cleanup_result


class WindowsJob:
    """Owned Node-driver subtree; created before the driver's GO can launch workers."""
    def __init__(self, child):
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t),
                ('ActiveProcessLimit', wintypes.DWORD), ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]
        class Io(ctypes.Structure): _fields_ = [(name, ctypes.c_uint64) for name in ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]
        class Limits(ctypes.Structure): _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', Io), ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]; self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle: raise ctypes.WinError(ctypes.get_last_error())
        limits = Limits(); limits.BasicLimitInformation.LimitFlags = 0x2000
        try:
            if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.kernel.AssignProcessToJobObject(self.handle, int(child._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.close(); raise
    def terminate(self):
        if not self.kernel.TerminateJobObject(self.handle, 1): raise ctypes.WinError(ctypes.get_last_error())
    def empty(self):
        from ctypes import wintypes
        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_int64) for name in ('TotalUserTime', 'TotalKernelTime', 'ThisPeriodTotalUserTime', 'ThisPeriodTotalKernelTime')] + [(name, wintypes.DWORD) for name in ('TotalPageFaultCount', 'TotalProcesses', 'ActiveProcesses', 'TotalTerminatedProcesses')]
        value = Accounting()
        if not self.kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(value), ctypes.sizeof(value), None): return False
        return value.ActiveProcesses == 0
    def close(self):
        if self.handle:
            handle = self.handle; self.handle = None
            if not self.kernel.CloseHandle(handle): raise ctypes.WinError(ctypes.get_last_error())


def memory(child=None):
    if child is not None: require(child.poll() is None, 'memory_not_live', 'Memory observation requires a live owned worker')
    unavailable = {'available': False, 'provider': None, 'units': 'bytes', 'peak_working_set_bytes': None,
                   'working_set_bytes': None, 'private_commit_current_bytes': None, 'reason': 'Owned Windows provider is unavailable on this platform'}
    if os.name != 'nt': return unavailable
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in
            ('PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
             'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]
    try:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True); kernel.GetCurrentProcess.restype = wintypes.HANDLE
        handle = int(child._handle) if child else kernel.GetCurrentProcess()
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        counters = Counters(); counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb): raise ctypes.WinError(ctypes.get_last_error())
        return {'available': True, 'provider': 'Windows GetProcessMemoryInfo/owned HANDLE', 'units': 'bytes',
                'peak_working_set_bytes': counters.PeakWorkingSetSize, 'working_set_bytes': counters.WorkingSetSize,
                'private_commit_current_bytes': counters.PrivateUsage, 'reason': None}
    except (OSError, AttributeError) as error:
        return dict(unavailable, reason='Owned process memory query unavailable: ' + str(error)[:256])


def check_memory(value):
    require(type(value) is dict and value.get('units') == 'bytes' and type(value.get('available')) is bool, 'memory_shape', 'Memory provider/units missing')
    require(all(key in value for key in ('peak_working_set_bytes', 'working_set_bytes', 'private_commit_current_bytes', 'provider', 'reason')),
            'memory_shape', 'Every metric needs an explicit value or null')
    for key in ('peak_working_set_bytes', 'working_set_bytes', 'private_commit_current_bytes'):
        item = value.get(key)
        require((type(item) is int and item >= 0) if value['available'] else item is None, 'memory_shape', 'Memory values must be available integers or explicit null')
    require((type(value['provider']) is str and value['reason'] is None) if value['available'] else
            value['provider'] is None and type(value['reason']) is str and bool(value['reason']), 'memory_shape', 'Provider or unavailable reason missing')


def host_metadata():
    result = {'os': platform.platform(), 'machine': platform.machine(), 'cpu_identifier': platform.processor(),
              'logical_cpus': os.cpu_count(), 'physical_ram_bytes': None, 'physical_ram_provider': None,
              'physical_ram_unavailable_reason': 'Provider is available only in the declared Windows profile'}
    if os.name == 'nt':
        from ctypes import wintypes
        class Status(ctypes.Structure):
            _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [(name, ctypes.c_uint64) for name in
                ('total_physical', 'available_physical', 'total_pagefile', 'available_pagefile', 'total_virtual', 'available_virtual', 'available_extended_virtual')]
        try:
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(Status)]
            value = Status(); value.length = ctypes.sizeof(value)
            if not kernel.GlobalMemoryStatusEx(ctypes.byref(value)): raise ctypes.WinError(ctypes.get_last_error())
            result.update(physical_ram_bytes=value.total_physical, physical_ram_provider='Windows GlobalMemoryStatusEx', physical_ram_unavailable_reason=None)
        except OSError as error: result['physical_ram_unavailable_reason'] = type(error).__name__
    return result


def prepared(root, fixture, mode, budget, process_factory=OwnedProcess):
    budget.reserve()
    clock = budget.clock; started = clock.now()
    source = root / ('drivers/' + fixture['id'] + '-' + mode + '.sprout')
    argv = [str(runtime_path(root)), 'run', str(source), '--max-steps', '20000000', '--timeout-ms', '3000']
    result = {'launch_reservation': budget.reserved, 'source': source.as_posix(), 'source_sha256': None,
              'pid': None, 'spawn_returned': False, 'spawn_start_ns': str(started),
              'timing_scope': 'prepared inclusive phase; startup/oracle/teardown excluded',
              'clock_provider': 'Python perf_counter_ns',
              'clock_resolution_ns': int(math.ceil(time.get_clock_info('perf_counter').resolution * 1000000000))}
    try:
        result['source_sha256'] = sha(source, BOUNDS['fixture_bytes'])
        child = process_factory(argv, root)
    except BaseException as error:
        result.update(pid=getattr(error, 'n007_pid', None), cleanup=getattr(error, 'n007_cleanup', None),
                      primary_error_type=type(error).__name__)
        raise SampleError(error, result) from error
    result.update(pid=child.child.pid, spawn_returned=True)
    until = started + 4000000000
    def remaining():
        now = clock.now(); require(now < until, 'worker_deadline', 'Prepared host deadline exhausted')
        return min((until - now) / 1000000000, budget.seconds(4))
    failure = None
    try:
        budget.remaining_ns()  # Popen is not preemptible; late returns do not qualify.
        child.marker(b'READY', remaining()); result['ready_ns'] = str(clock.now())
        result['memory_ready'] = memory(child.child); check_memory(result['memory_ready'])
        begin = clock.now(); child.send(b'GO\n', remaining()); child.marker(b'DONE', remaining()); end = clock.now()
        result.update(start_ns=str(begin), end_ns=str(end), elapsed_ns=end - begin, batch=fixture['batch'])
        result['memory_done'] = memory(child.child); check_memory(result['memory_done'])
        child.send(b'ACK\n', remaining())
        raw = child.stdout.line(remaining())
        output = strict_json(raw)
        require(strict_equal(output, {'result': fixture['expected'], 'unchanged': True}), 'oracle', 'Prepared result or input integrity differs from the independent oracle')
        result.update(output_sha256=hashlib.sha256(raw).hexdigest(), output_bytes=len(raw), output_raw=raw)
        child.finish(remaining())
    except BaseException as error:
        failure = error
    cleanup = child.close()
    result['cleanup'] = cleanup; result['stdout_raw'] = bytes(child.stdout.raw); result['stderr_raw'] = bytes(child.stderr.raw)
    result['stdout_received_bytes'] = child.stdout.received; result['stderr_received_bytes'] = child.stderr.received
    try:
        if failure: raise failure
        require(cleanup['confirmed'], 'cleanup', 'Owned worker cleanup not confirmed')
        require(not child.stderr.raw and not child.stderr.error, 'stderr', 'Worker stderr was unexpected')
        if child.stdout.error: raise child.stdout.error
        require(cleanup['exit_code'] == 0, 'exit', 'Worker exit was unexpected')
        budget.remaining_ns()
    except BaseException as error:
        result['primary_error_type'] = type(error).__name__
        result['clock_failure'] = clock.failure
        raise SampleError(error, result) from error
    return result


def paired_summary(samples):
    require(len(samples) == 5, 'sample_count', 'Exactly five raw samples are required')
    require(all(type(value) is int and value >= 0 for value in samples), 'sample_type', 'Elapsed samples must be nonnegative integers')
    center = statistics.median(samples)
    return {'raw_ns': list(samples), 'median_ns': center, 'min_ns': min(samples), 'max_ns': max(samples),
            'mad_ns': statistics.median(abs(value - center) for value in samples)}


def reviewed_scope(snapshot, manifest_digest, scope, scope_digest, destination):
    manifest = verify_manifest(snapshot, manifest_digest)
    record = pinned_json(scope, scope_digest, INPUT_BOUNDS['selection_bytes'])
    keys = {'schema', 'profile', 'snapshot_manifest_sha256', 'native_sha256', 'ci_sha256',
            'python_sha256', 'node_sha256', 'output_directory', 'run_id', 'scope_reviewed_and_sealed', 'bounds'}
    require(type(record) is dict and set(record) == keys and record['schema'] == 'sprout.measurement-reviewed-scope.v2' and
            record['profile'] == PROFILE and record['scope_reviewed_and_sealed'] is True and strict_equal(record['bounds'], BOUNDS),
            'reviewed_scope', 'Reviewed scope schema/profile/budget differs')
    require(record['snapshot_manifest_sha256'] == manifest_digest and record['native_sha256'] == manifest['native_sha256'] and
            record['ci_sha256'] == manifest['ci_sha256'] and record['python_sha256'] == manifest['host_tools']['python']['sha256'] and
            record['node_sha256'] == manifest['host_tools']['node']['sha256'], 'reviewed_scope', 'Reviewed identities differ')
    require(type(record['run_id']) is str and 1 <= len(record['run_id']) <= 64 and all(c in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in record['run_id']),
            'reviewed_scope', 'Run identifier must be bounded ASCII text')
    require(type(record['output_directory']) is str and Path(record['output_directory']).is_absolute() and
            Path(record['output_directory']).resolve() == Path(destination).resolve(), 'reviewed_scope', 'Run output differs from pinned scope')
    require(execution_platform_supported(), 'platform', 'Full execution requires the reviewed Windows native profile')
    require(not os.environ.get('SPROUT_GC_STRESS') and not os.environ.get('NODE_OPTIONS'), 'environment', 'Unreviewed runtime options are excluded')
    require(bounded_sha(sys.executable, INPUT_BOUNDS['host_executable_bytes']) == record['python_sha256'] and
            bounded_sha(host_tool_path(snapshot, 'node'), INPUT_BOUNDS['host_executable_bytes']) == record['node_sha256'],
            'host_tool', 'Actual interpreter identities changed')
    return manifest, record


def reserve_once(destination, record, scope_digest):
    destination = Path(destination).resolve()
    require(not destination.exists(), 'already_used', 'Run output must be new; no retry')
    marker = destination.parent / ('.' + destination.name + '.attempt.json')
    with marker.open('xb') as stream:
        stream.write(compact({'schema': 'sprout.measurement-attempt.v1', 'run_id': record['run_id'],
                              'scope_sha256': scope_digest, 'state': 'attempt_reserved', 'output_directory': str(destination)}))
    return marker


def executing_controller(root, manifest):
    import measurement_fixtures as workloads
    import measurement_sdk as sdk_driver
    for module, name in [(sys.modules[__name__], 'measure_workloads.py'), (workloads, 'measurement_fixtures.py'), (sdk_driver, 'measurement_sdk.py')]:
        actual = Path(module.__file__).resolve()
        expected = (root / 'controller' / name).resolve()
        require(actual == expected and sha(actual) == manifest['files']['controller/' + name], 'executing_source',
                'Execute the reviewed frozen controller; copies in the inventory do not authenticate other loaded code')


class PythonSuite:
    def __init__(self, root, budget):
        from measurement_sdk import load_sdk
        self.root, self.budget = root, budget
        self.runtime = runtime_path(root)
        begin = budget.clock.now(); self.sdk = load_sdk(root)
        data = bounded_json(root / 'fixtures/sdk.json', BOUNDS['fixture_bytes'])
        self.data = {key: dict(value, typed_input=self.sdk.decode(compact(value['input']))) for key, value in data.items()}
        self.setup = {'setup_start_ns': str(begin), 'ready_ns': str(budget.clock.now()), 'parent_memory_before': memory(),
                      'child_peak': {'available': False, 'value': None, 'reason': 'Stock Python SDK exposes no owned child handle'}}
    def call(self, identifier):
        from measurement_sdk import one_call, typed_equal
        self.budget.reserve(); data = self.data[identifier]
        limit = max(1, int(self.budget.seconds(4) * 1000))
        program = self.root / ('sdk/' + identifier + '.sprout' if identifier in ('Hmin', 'Hecho16K') else 'git/examples/services/contacts_preview.sprout')
        options = dict(command=str(self.runtime), cwd=self.root, sandbox=data['sandbox'], timeout_ms=limit,
                       runtime_timeout_ms=min(3000, limit), max_steps=20000000, max_input_bytes=1048576,
                       max_output_bytes=262144, max_error_bytes=65536)
        try: result, start, end = one_call(self.sdk.run, program, data['typed_input'], options, self.budget.clock)
        except BaseException as error:
            source_identity, source_identity_error = None, None
            try: source_identity = sha(program)
            except (OSError, ContractError) as identity_error:
                source_identity_error = {'code': getattr(identity_error, 'code', type(identity_error).__name__),
                                         'type': type(identity_error).__name__, 'message': str(identity_error)[:256]}
            raise SampleError(error, {'launch_reservation': self.budget.reserved,
                'start_ns': str(error.n007_start_ns) if hasattr(error, 'n007_start_ns') else None,
                'program_sha256': source_identity, 'program_identity_error': source_identity_error,
                'cleanup_scope': 'SDK failure; no successful result/zero activity credited',
                'stderr_raw': str(getattr(error, 'stderr', '')).encode('utf-8'), 'primary_error_type': type(error).__name__}) from error
        record = {'start_ns': str(start), 'end_ns': str(end), 'elapsed_ns': end - start, 'clock_provider': 'Python perf_counter_ns',
                  'clock_resolution_ns': int(math.ceil(time.get_clock_info('perf_counter').resolution * 1000000000)),
                  'output_raw': self.sdk.encode(result).encode('utf-8'), 'cleanup_scope': 'SDK returned after direct-child/stream completion'}
        if not typed_equal(result, data['expected']): raise SampleError(ContractError('oracle', 'Python exact host types/values differ'), record)
        self.budget.remaining_ns(); return record
    def close(self):
        self.setup['parent_memory_after'] = memory()
        return {'confirmed': True, 'scope': 'No persistent SDK parent process; each successful SDK call completed'}


class NodeSuite:
    def __init__(self, root, budget):
        self.root, self.budget = root, budget; self.closed = None; begin = budget.clock.now()
        executable = host_tool_path(root, 'node')
        require(executable is not None, 'node', 'Selected Node executable unavailable')
        self.child = OwnedProcess([executable, str(root / 'controller/measurement_sdk.cjs'), str(root)], root, tree=True)
        try:
            self.child.marker(b'READY', budget.seconds(4))
            self.setup = {'setup_start_ns': str(begin), 'ready_ns': str(budget.clock.now()), 'executable': executable,
                          'executable_sha256': sha(executable, INPUT_BOUNDS['host_executable_bytes']), 'parent_memory_before': memory(self.child.child),
                          'child_peak': {'available': False, 'value': None, 'reason': 'Stock Node SDK exposes no owned native child handle'}}
            self.data = bounded_json(root / 'fixtures/sdk.json', BOUNDS['fixture_bytes'])
        except BaseException as error:
            cleanup = self.child.close()
            raise SampleError(error, {'native_launch_reservation': None, 'parent_pid': self.child.child.pid,
                'parent_setup_start_ns': str(begin), 'cleanup': cleanup, 'clock_failure': budget.clock.failure,
                'stdout_raw': bytes(self.child.stdout.raw), 'stderr_raw': bytes(self.child.stderr.raw)}) from error
    def call(self, identifier):
        self.budget.reserve()
        record = {'launch_reservation': self.budget.reserved, 'parent_pid': self.child.child.pid}
        try:
            self.child.send(compact({'id': identifier, 'limit_ms': max(1, int(self.budget.seconds(4) * 1000))}) + b'\n', self.budget.seconds(4))
            raw = self.child.stdout.line(self.budget.seconds(4)); record['output_raw'] = raw
            value = strict_json(raw)
            require(type(value) is dict and value.get('ok') is True and value.get('id') == identifier,
                    'sdk', 'Node SDK call failed or selected an unexpected fixture')
            def ns(key):
                text = value.get(key)
                require(type(text) is str and 1 <= len(text) <= 30 and text.isascii() and text.isdigit() and (text == '0' or text[0] != '0'),
                        'clock_type', 'Node raw clock fields require canonical decimal integer text')
                return int(text)
            start, end, elapsed = ns('start_ns'), ns('end_ns'), ns('elapsed_ns')
            record.update(start_ns=str(start), end_ns=str(end), elapsed_ns=elapsed)
            require(end >= start and elapsed == end - start, 'clock_backwards', 'Node raw timing is inconsistent')
            require(strict_equal(value['result'], self.data[identifier]['expected']), 'oracle', 'Node exact wire types/values differ')
            self.budget.remaining_ns()
            record.update(clock_provider=value['clock_provider'], clock_resolution_ns=None,
                clock_resolution_reason='Node hrtime representation is ns; platform resolution is not guessed',
                cleanup_scope=value['cleanup_scope'])
            return record
        except BaseException as error:
            raise SampleError(error, record) from error
    def close(self):
        if self.closed is not None: return self.closed
        try:
            self.setup['parent_memory_after'] = memory(self.child.child) if self.child.child.poll() is None else None
            self.child.send(b'STOP\n', self.budget.seconds(4)); self.child.finish(self.budget.seconds(4))
        except BaseException as error:
            failure = {'code': getattr(error, 'code', type(error).__name__), 'message': str(error)[:256]}
        else: failure = None
        finally:
            cleanup = self.child.close()
        self.closed = dict(cleanup, stdout_raw=bytes(self.child.stdout.raw), stderr_raw=bytes(self.child.stderr.raw),
                           stdout_received_bytes=self.child.stdout.received, stderr_received_bytes=self.child.stderr.received)
        if failure: self.closed.update(confirmed=False, primary_error=failure)
        if cleanup['exit_code'] != 0 or self.child.stderr.raw or self.child.stderr.error:
            self.closed['confirmed'] = False
        return self.closed


def raw_artifacts(observation, directory, index):
    record = dict(observation)
    for name in ('stdout_raw', 'stderr_raw', 'output_raw'):
        raw = record.pop(name, None)
        if raw is not None:
            require(type(raw) is bytes and len(raw) <= 262144, 'artifact_size', 'Raw observation exceeds its declared cap')
            path = directory / f'{index:03}-{name}.bin'
            with path.open('xb') as stream: stream.write(raw)
            record[name[:-4] + '_artifact'] = {'name': path.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    return record


def summary(rows):
    result = {}
    for identifier in PURE_IDS:
        full = [row['elapsed_ns'] for row in rows if row['kind'] == 'prepared' and row['id'] == identifier and not row['warmup'] and row['mode'] == 'full']
        control = [row['elapsed_ns'] for row in rows if row['kind'] == 'prepared' and row['id'] == identifier and not row['warmup'] and row['mode'] == 'control']
        differences = [a - b for a, b in zip(full, control)]
        result[identifier] = {'full': paired_summary(full), 'control': paired_summary(control), 'paired_differences_ns': differences,
            'difference_labels': ['not_separable_from_noise' if item <= 0 else 'paired_observation_not_exclusive_cpu' for item in differences]}
    for sdk in ('python', 'node'):
        for identifier in SDK_IDS:
            result[sdk + ':' + identifier] = paired_summary([row['elapsed_ns'] for row in rows if row['kind'] == 'sdk' and
                row['sdk'] == sdk and row['id'] == identifier and not row['warmup']])
    return result


def execute_plan(root, digest, destination, budget=None, pure_runner=prepared, suite_factories=None, identity=verify_manifest):
    """Internal dependency injection supports deterministic tests; CLI has no verification bypass."""
    root, destination = Path(root).resolve(), Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    manifest = identity(root, digest); budget = budget or Budget()
    simulated = pure_runner is not prepared or suite_factories is not None or identity is not verify_manifest
    report = {'schema': 'sprout.finite-measurement.v1', 'complete': False,
              'execution_mode': 'test_simulation' if simulated else 'measurement', 'measurements_performed': not simulated,
              'measurement_scope': 'Finite synthetic observations, no ranking/SLA/soak qualification',
              'manifest_sha256': digest, 'planned_calls': 204, 'launch_ceiling': 208, 'launch_reservations': 0,
              'supervised_deadline_ns': str(budget.deadline), 'deadline_boundary': 'Identity preflight precedes the budget. Popen/OS APIs may block; cleanup has separate2s allowance. No inclusive wall90s promise.',
              'rows': [], 'sdk_setup': {}, 'error': None, 'utc_started': datetime.now(timezone.utc).isoformat(),
              'python': {'executable': sys.executable, 'sha256': sha(sys.executable, INPUT_BOUNDS['host_executable_bytes']), 'version': sys.version, 'bits': ctypes.sizeof(ctypes.c_void_p) * 8},
              'host': host_metadata(),
              'native': {'sha256': manifest['native_sha256'], 'revision': manifest['revision'], 'build_sha256': manifest['build_sha256']}}
    suites = {}; factories = suite_factories or {'python': PythonSuite, 'node': NodeSuite}
    try:
        data = fixtures()
        for index, row in enumerate(schedule()):
            budget.remaining_ns()
            try:
                if row['kind'] == 'prepared': record = pure_runner(root, data[row['id']], row['mode'], budget)
                else:
                    if row['sdk'] not in suites: suites[row['sdk']] = factories[row['sdk']](root, budget)
                    record = suites[row['sdk']].call(row['id'])
                require(type(record.get('elapsed_ns')) is int and record['elapsed_ns'] >= 0, 'elapsed', 'Invalid elapsed observation')
                if record.get('clock_resolution_ns'):
                    record['insufficient_timing_scale'] = record['elapsed_ns'] < 10 * record['clock_resolution_ns']
                report['rows'].append(dict(row, **raw_artifacts(record, destination, index)))
            except SampleError as error:
                report['failed_observation'] = dict(row, **raw_artifacts(error.observation, destination, index)); raise
            except BaseException as error:
                observation = {'launch_reservations_at_failure': budget.reserved,
                    'primary_error_type': type(error).__name__, 'pid': getattr(error, 'n007_pid', None),
                    'cleanup': getattr(error, 'n007_cleanup', None), 'source_manifest_sha256': digest}
                report['failed_observation'] = dict(row, **observation); raise
        for name in list(suites):
            suite = suites[name]; cleanup = suite.close()
            report['sdk_setup'][name] = dict(suite.setup, cleanup=raw_artifacts(cleanup, destination, 204 + ('python', 'node').index(name)))
            require(cleanup['confirmed'], 'cleanup', 'SDK parent cleanup incomplete')
            del suites[name]
        identity(root, digest)
        budget.remaining_ns()
        require(budget.reserved == 204 and len(report['rows']) == 204, 'sample_count', 'Finite exercise has missing calls or observations')
        report['summary'] = summary(report['rows']); report['complete'] = True
    except BaseException as error:
        report['error'] = {'code': getattr(error, 'code', type(error).__name__), 'message': str(error)[:512]}
        report['clock_failure'] = budget.clock.failure
    finally:
        cleanup_errors = []
        for name, suite in suites.items():
            try:
                closed = suite.close()
                if name not in report['sdk_setup']:
                    report['sdk_setup'][name] = dict(suite.setup, cleanup=raw_artifacts(closed, destination, 204 + ('python', 'node').index(name)))
                if not closed.get('confirmed'): cleanup_errors.append({'sdk': name, 'code': 'unconfirmed'})
            except BaseException as error: cleanup_errors.append({'sdk': name, 'code': type(error).__name__, 'message': str(error)[:256]})
        if cleanup_errors:
            report['complete'] = False; report['cleanup_errors'] = cleanup_errors
        report['launch_reservations'] = budget.reserved
        report['utc_finished'] = datetime.now(timezone.utc).isoformat()
        report['utc_end_before_start'] = report['utc_finished'] < report['utc_started']
        raw = compact(report)
        if len(raw) > 2097152:
            report = {'schema': report['schema'], 'complete': False, 'measurements_performed': report['measurements_performed'],
                'execution_mode': report['execution_mode'], 'manifest_sha256': digest, 'launch_reservations': budget.reserved,
                'error': {'code': 'report_size', 'message': 'Metadata exceeded2MiB; raw artifacts remain, no complete report credited'},
                'oversize_report_bytes': len(raw), 'oversize_report_sha256': hashlib.sha256(raw).hexdigest()}
            with (destination / 'oversize-report-prefix.bin').open('xb') as stream: stream.write(raw[:2097152])
            raw = compact(report)
        with (destination / 'report.json').open('xb') as stream: stream.write(raw)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description='Inspect a pinned snapshot by default; explicit one finite Windows run only.')
    parser.add_argument('--snapshot', type=Path, required=True); parser.add_argument('--manifest-sha256', required=True)
    mode = parser.add_mutually_exclusive_group(); mode.add_argument('--check-only', action='store_true'); mode.add_argument('--run-once', action='store_true')
    parser.add_argument('--scope-record', type=Path); parser.add_argument('--scope-sha256'); parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    if not args.run_once:
        require(not args.scope_record and not args.scope_sha256 and not args.report, 'mode', 'Run arguments require explicit --run-once')
        manifest = verify_manifest(args.snapshot, args.manifest_sha256)
        print('Snapshot identity verified; check-only: zero workload launches, writes or run-marker consumption.')
        return 0
    require(args.scope_record and args.scope_sha256 and args.report, 'reviewed_scope', 'Explicit run requires pinned scope and output')
    manifest, record = reviewed_scope(args.snapshot, args.manifest_sha256, args.scope_record, args.scope_sha256, args.report)
    executing_controller(args.snapshot.resolve(), manifest)
    reserve_once(args.report, record, args.scope_sha256)
    result = execute_plan(args.snapshot, args.manifest_sha256, args.report)
    require(result['complete'], 'incomplete', 'Finite run incomplete; preserve report, no automatic retry')
    return 0


if __name__ == '__main__': raise SystemExit(main())
