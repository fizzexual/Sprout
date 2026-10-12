#!/usr/bin/env python3
"""Read-only project/package/native diagnostics. Requires Python 3.11+."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import threading
import time
import tomllib
from urllib.parse import urlsplit

METADATA_BYTES = 4 * 1024 * 1024
PROJECT_BYTES = 64 * 1024 * 1024
NATIVE_BYTES = 256 * 1024 * 1024
MAX_FILES = 1024
MAX_INSPECTED_FILES = 4096
MAX_PACKAGES = 128
MAX_CHECKS = 2048
PROBE_SECONDS = 3.0
PROBE_BYTES = 4096
CAPABILITY_BYTES = 1024
CAPABILITY_DEPTH = 8
CAPABILITY_MEMBERS = 64
CAPABILITY_FEATURES = frozenset(('intrinsic_calls_v1', 'sqlite_adapter_v1', 'native_processes_v1',
                               'http_request_v1', 'workflow_plan_v1', 'workflow_run_v1'))
LOCK_HEADER = '# sprout.lock v1 sha256'
VERSION = re.compile(r'Sprout v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?')


class DiagnosticError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise DiagnosticError(message)


def fold(value):
    return value.translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))


def conflict(left, right):
    left, right = fold(left), fold(right)
    return left == right or left.startswith(right + '/') or right.startswith(left + '/')


def portable(value):
    require(isinstance(value, str) and value and len(value.encode('utf-8')) < 800, 'path must be a bounded nonempty string')
    require(not any(ord(char) < 32 or ord(char) == 127 or char in '\\:<>"|?*' for char in value), 'path contains a nonportable separator or character')
    for part in value.split('/'):
        require(part not in ('', '.', '..') and not part.endswith(('.', ' ')), 'path has an empty, traversal or ambiguous component')
        base = part.split('.')[0].upper()
        require(base not in ('CON', 'PRN', 'AUX', 'NUL') and not re.fullmatch(r'(?:COM|LPT)[1-9]', base), 'path contains a Windows device name')
    return value


def package_name(value):
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,127}', value) is not None, 'invalid package name')
    portable(value)
    return value


def source_kind(source):
    require(source and len(source.encode('utf-8')) < 1024 and not any(char.isspace() or ord(char) < 32 for char in source), 'invalid package source')
    if source.startswith('github:'):
        github(source)
        return 'github'
    if source.startswith(('https://', 'http://')):
        url = urlsplit(source)
        require(url.hostname and not url.username and not url.password and not url.fragment, 'unsupported HTTP source identity')
        return 'http'
    portable(source)
    return 'local'


def github(source):
    match = re.fullmatch(r'github:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_.-]{1,255}))?(?::(.+))?', source)
    require(match is not None, 'invalid GitHub shorthand')
    owner, repo, ref, path = match.groups()
    path = portable(path or repo + '.sprout')
    return owner + '/' + repo, ref or 'main', path


def child_source(source, child):
    portable(child)
    if source.startswith('github:'):
        repo, ref, path = github(source)
        return 'github:' + repo + '@' + ref + ':' + (path.rpartition('/')[0] + '/' if '/' in path else '') + child
    return (source.rpartition('/')[0] + '/' if '/' in source else '') + child


def dependency_matches(locked, declared):
    if locked == declared:
        return True
    if locked.startswith('github:') and declared.startswith('github:'):
        repo, ref, path = github(locked)
        other_repo, other_ref, other_path = github(declared)
        if repo != other_repo or path != other_path or not re.fullmatch(r'[0-9a-fA-F]{40}', ref):
            return False
        return fold(ref) == fold(other_ref) if re.fullmatch(r'[0-9a-fA-F]{40}', other_ref) else True
    return False


def secure_path(value, *, directory=False):
    path = Path(os.path.abspath(value))
    require(len(str(path)) <= 4096, 'filesystem path exceeds inspection limit')
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'symlink/reparse path refused: ' + str(part))
    if directory:
        require(stat.S_ISDIR(path.stat().st_mode), 'expected an existing directory: ' + str(path))
    return path


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


class Reader:
    def __init__(self, root):
        self.root = secure_path(root, directory=True)
        self.cache = {}
        self.total = 0

    def path(self, relative):
        return secure_path(self.root / portable(relative))

    def read(self, path, maximum=PROJECT_BYTES):
        path = secure_path(path)
        before = path.stat()
        require(stat.S_ISREG(before.st_mode), 'expected a regular file: ' + str(path))
        require(before.st_size <= maximum, 'file exceeds inspection byte limit: ' + str(path))
        if path in self.cache:
            data, previous = self.cache[path]
            require(identity(before) == previous, 'file changed during diagnosis: ' + str(path))
            return data
        require(len(self.cache) < MAX_INSPECTED_FILES and self.total + before.st_size <= PROJECT_BYTES, 'project inspection file/byte budget exceeded')
        with path.open('rb') as stream:
            require(identity(os.fstat(stream.fileno())) == identity(before), 'file changed before read: ' + str(path))
            data = stream.read(maximum + 1)
            require(identity(os.fstat(stream.fileno())) == identity(before), 'file changed during read: ' + str(path))
        require(len(data) == before.st_size and len(data) <= maximum and identity(secure_path(path).stat()) == identity(before), 'file changed after read: ' + str(path))
        self.cache[path] = data, identity(before)
        self.total += len(data)
        return data

    def text(self, path):
        data = self.read(path, METADATA_BYTES)
        require(b'\0' not in data, 'NUL bytes in text metadata')
        return data.decode('utf-8', errors='strict')


class Report:
    def __init__(self, root, *, capabilities=False, probe_version=False):
        self.value = dict(schema=1, project_root=str(root), diagnostics_only=True,
            scope='Declared files, locked content and observed environment; not language checking or production certification.',
            checks=[], native=None, packages={}, environment={}, execution=dict(project_code=False, network=False, version_probe=False),
            limits=dict(metadata_bytes=METADATA_BYTES, project_bytes=PROJECT_BYTES, declared_or_locked_files=MAX_FILES,
                        inspected_files=MAX_INSPECTED_FILES, packages=MAX_PACKAGES, native_bytes=NATIVE_BYTES, checks=MAX_CHECKS))
        if capabilities:
            self.value['schema'] = 2
            self.value['scope'] += ' Explicit executable probes have unverified external behavior.'
            self.value['execution'] = dict(doctor_project_code_executed=False, doctor_network_accessed=False,
                version_probe=False, capabilities_probe=False,
                external_probe=dict(requested_commands=['--capabilities-json'] + (['version'] if probe_version else []),
                    launch_attempted=False, process_started=False, behavior='not_attempted',
                    project_code_executed=False, network_accessed=False))
            self.value['required_features'] = []
            self.value['limits'].update(capability_protocol_bytes=CAPABILITY_BYTES, capability_depth=CAPABILITY_DEPTH,
                                       capability_members=CAPABILITY_MEMBERS, probe_capture_bytes=PROBE_BYTES,
                                       probe_execution_seconds=PROBE_SECONDS)

    def add(self, code, severity, message, action='', path=None, **details):
        if len(self.value['checks']) >= MAX_CHECKS - 1:
            if not self.value.get('checks_truncated'):
                self.value['checks'].append(dict(code='inspection.output_limit', severity='error', message='Further findings exceeded the bounded output count.', action='Reduce the inspected project/package set.'))
                self.value['checks_truncated'] = True
            return
        item = dict(code=code, severity=severity, message=str(message)[:1024], action=action[:1024])
        if path is not None: item['path'] = str(path)[:4096]
        if details: item['details'] = details
        self.value['checks'].append(item)

    def finish(self):
        counts = {name: sum(item['severity'] == name for item in self.value['checks']) for name in ('error', 'warning', 'info')}
        self.value['summary'] = counts
        self.value['status'] = 'blocked' if counts['error'] else 'attention' if counts['warning'] else 'diagnostics_clear'
        return self.value


def lines(text):
    return [line.strip().split() for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#')]


def config(reader, report):
    path = reader.path('sprout.toml')
    if not path.exists():
        report.add('project.config_absent', 'info', 'No sprout.toml; the default entry is main.sprout.', 'Use --entry for an explicit single-file project.')
        return {}
    text = reader.text(path)
    # Native declarations use raw double-quoted strings, not TOML escape or
    # single/triple-quoted syntax. Preserve its ~ comments without interpreting
    # strings as source code or quietly giving escaped paths another meaning.
    cleaned = []; quoted = False
    for line in text.splitlines():
        output = []; quoted = False
        for char in line:
            if not quoted and char in '#~': break
            require(char != "'" or quoted, 'single-quoted config syntax is unsupported by the native declaration reader')
            require(not (quoted and char == '\\'), 'escaped config strings are unsupported; use portable / paths')
            if char == '"': quoted = not quoted
            output.append(char)
        require(not quoted and '"""' not in ''.join(output), 'multiline/unterminated config strings are unsupported')
        cleaned.append(''.join(output))
    parsed = tomllib.loads('\n'.join(cleaned))
    allowed = {'project', 'main', 'include', 'assets'}
    for name, value in parsed.items():
        if name not in allowed:
            report.add('project.config_unknown', 'warning', 'Unsupported config field: ' + name, 'Use the documented flat project/main/include/assets declarations.', path)
        else:
            require(isinstance(value, str) if name in ('project', 'main') else isinstance(value, list) and all(isinstance(item, str) for item in value), 'invalid config type for ' + name)
    require(all(not isinstance(value, dict) for value in parsed.values()), 'nested config tables are unsupported by this diagnostic tool')
    return {key: value for key, value in parsed.items() if key in allowed}


def declared_files(reader, report, settings, entry):
    main = entry or settings.get('main', 'main.sprout')
    names = [('entry', main)] + [('include', value) for value in settings.get('include', [])] + [('asset', value) for value in settings.get('assets', [])]
    require(len(names) <= MAX_FILES, 'too many declared project files')
    modules = {}; paths = []
    main_path = None
    for role, name in names:
        try:
            path = reader.path(name)
            if role == 'entry': main_path = path
            for old in paths:
                require(not conflict(name, old), 'duplicate, aliased or prefix-colliding declared path')
            paths.append(name)
            data = reader.read(path)
            if role != 'asset':
                require(name.endswith('.sprout'), role + ' must identify a .sprout source file')
                require(b'\0' not in data, 'source has NUL bytes')
                data.decode('utf-8', errors='strict')
                basename = name.rsplit('/', 1)[-1][:-7]
                require(basename not in modules, 'duplicate declared module basename: ' + basename)
                modules[basename] = name
        except (OSError, ValueError) as error:
            report.add('project.' + role + '_invalid', 'error', str(error), 'Restore a regular UTF-8 source/declared asset inside the project root; run sprout check separately.', name)
    report.value['project'] = dict(entry=str(main)[:800], includes=len(settings.get('include', [])), assets=len(settings.get('assets', [])), declared_modules=modules)
    return main_path


def parse_packages(reader):
    manifest = reader.path('sprout.packages'); lock = reader.path('sprout.lock')
    specs = {}
    if manifest.exists():
        for row in lines(reader.text(manifest)):
            require(len(row) == 2 and len(specs) < MAX_PACKAGES, 'invalid or oversized sprout.packages record')
            name, source = row; package_name(name); source_kind(source)
            require(not any(conflict(name, old) for old in specs), 'duplicate or colliding package name')
            specs[name] = source
    records = []
    if lock.exists():
        text = reader.text(lock)
        require(text.splitlines() and text.splitlines()[0] == LOCK_HEADER, 'unsupported/corrupt lock header')
        for row in lines('\n'.join(text.splitlines()[1:])):
            require(len(row) == 4 and len(records) < MAX_FILES, 'invalid or oversized lock record')
            name, source, digest, dest = row; package_name(name); source_kind(source); portable(dest)
            require(re.fullmatch(r'[0-9a-fA-F]{64}', digest), 'invalid locked SHA-256')
            require(dest == 'sprout_packages/' + name + '.sprout' or dest.startswith('sprout_packages/' + name + '/'), 'locked path is outside its package namespace')
            require(not any(conflict(dest, old['path']) or name != old['name'] and conflict(name, old['name']) for old in records), 'duplicate or colliding lock path/name')
            records.append(dict(name=name, source=source, sha256=digest.lower(), path=dest))
    return specs, records, manifest.exists(), lock.exists()


def inspect_packages(reader, report):
    specs, records, has_manifest, has_lock = parse_packages(reader)
    report.value['packages'] = dict(manifest_present=has_manifest, lock_present=has_lock, names=len(specs), files=len(records))
    if specs and not has_lock:
        report.add('packages.lock_missing', 'warning', 'Declared packages have no lockfile.', 'Review sprout install resolution and commit sprout.lock; the doctor does not resolve or install.')
    if has_lock and not has_manifest:
        report.add('packages.manifest_missing', 'error', 'Lockfile has no matching sprout.packages.', 'Restore the reviewed manifest and lock together.')
    by_name = {name: [row for row in records if row['name'] == name] for name in specs}
    for row in records:
        if row['name'] not in specs:
            report.add('packages.undeclared', 'error', 'Locked package is not declared: ' + row['name'], 'Restore matching manifest/lock or explicitly re-add the dependency.')
    for name, source in specs.items():
        rows = by_name[name]
        single = 'sprout_packages/' + name + '.sprout'; tree = 'sprout_packages/' + name + '/sprout.package'
        entries = [row for row in rows if row['path'] in (single, tree)]
        if has_lock:
            require(len(entries) == 1, 'package lacks exactly one single-file or tree manifest lock: ' + name)
            root = entries[0]
            require(root['source'] == source or root['path'] == tree and root['source'] == source + '/sprout.package', 'manifest/lock source drift: ' + name)
            require(root['path'] != single or len(rows) == 1, 'single-file package has extra lock records: ' + name)
        if source_kind(source) != 'local':
            report.add('packages.remote_unverified', 'info', 'Remote content was not requested: ' + name, 'Locked bytes are checked locally; remote availability/authentication is outside this tool.')
            if source.startswith('github:') and not re.fullmatch(r'[0-9a-fA-F]{40}', github(source)[1]):
                report.add('packages.mutable_github_ref', 'warning', 'GitHub source is not commit-pinned: ' + name, 'Review an explicit sprout add and commit its resolved source/lock.')
        elif not has_lock:
            try:
                path = reader.path(source)
                if path.is_dir(): reader.text(secure_path(path/'sprout.package'))
                else:
                    data = reader.read(path)
                    require(b'\0' not in data, 'NUL in local package source'); data.decode('utf-8', errors='strict')
            except (OSError, ValueError) as error:
                report.add('packages.local_source_invalid', 'error', str(error), 'Restore the contained vendor source before resolving packages.', source)
    verified = {}
    for row in records:
        installed = reader.path(row['path'])
        try:
            data = reader.read(installed)
            require(hashlib.sha256(data).hexdigest() == row['sha256'], 'installed locked content drifted')
            if row['path'].endswith('.sprout'): require(b'\0' not in data, 'NUL in package source'); data.decode('utf-8', errors='strict')
            verified[row['path']] = data
        except (OSError, ValueError) as error:
            report.add('packages.installed_invalid', 'error', str(error), 'Restore reviewed installed bytes; sprout install --locked verifies pins before writing.', row['path'])
        if source_kind(row['source']) == 'local':
            try:
                local = reader.path(row['source']); data = reader.read(local)
                require(hashlib.sha256(data).hexdigest() == row['sha256'], 'locked local source drifted')
                if row['path'].endswith('.sprout'):
                    require(b'\0' not in data, 'NUL in locked local package source'); data.decode('utf-8', errors='strict')
                verified.setdefault(row['path'], data)
            except (OSError, ValueError) as error:
                report.add('packages.local_source_invalid', 'error', str(error), 'Restore the original locked vendor bytes or explicitly review/re-add the package.', row['source'])
    graph = {}
    for row in records:
        if row['path'] != 'sprout_packages/' + row['name'] + '/sprout.package': continue
        data = verified.get(row['path'])
        if data is None:
            report.add('packages.tree_unverified', 'warning', 'Tree manifest is unavailable for completeness checks: ' + row['name'], 'Restore the pinned manifest before checking its declared layout.')
            continue
        require(b'\0' not in data and len(data) <= METADATA_BYTES, 'invalid tree package metadata')
        declared = {row['path']}; entry_count = 0; dependencies = []
        for fields in lines(data.decode('utf-8', errors='strict')):
            key = fields[0]
            if key in ('entry', 'file'):
                require(len(fields) == 2, 'invalid tree file declaration')
                file = portable(fields[1]); require(file != 'sprout.package', 'tree cannot list its own manifest')
                if key == 'entry': entry_count += 1; require(file.endswith('.sprout'), 'tree entry must end in .sprout')
                wanted = 'sprout_packages/' + row['name'] + '/' + file
                require(not any(conflict(wanted, old) for old in declared), 'duplicate or colliding tree file declaration')
                declared.add(wanted)
                require(any(item['path'] == wanted and item['source'] == child_source(row['source'], file) for item in records), 'tree file missing or source-inconsistent in lock: ' + wanted)
            elif key == 'dependency':
                require(len(fields) == 3, 'invalid tree dependency declaration')
                name = package_name(fields[1]); source = fields[2]
                if source_kind(source) == 'local': source = child_source(row['source'], source)
                roots = [item for item in records if item['name'] == name and item['path'] in ('sprout_packages/' + name + '.sprout', 'sprout_packages/' + name + '/sprout.package')]
                require(len(roots) == 1 and (dependency_matches(roots[0]['source'], source) or dependency_matches(roots[0]['source'], source + '/sprout.package')), 'tree dependency missing or source-inconsistent: ' + name)
                require(name not in dependencies and len(dependencies) < MAX_PACKAGES, 'duplicate or oversized tree dependency declarations')
                dependencies.append(name)
            else: raise DiagnosticError('unknown sprout.package directive')
        require(entry_count == 1 and declared == {item['path'] for item in records if item['name'] == row['name']}, 'incomplete or inconsistent tree lock')
        graph[row['name']] = dependencies
    depths = {}
    def visit(name, active=()):
        require(name not in active and len(active) <= 32, 'cyclic or excessively deep tree dependency graph')
        if name in depths: return depths[name]
        depth = max((1 + visit(dependency, (*active, name)) for dependency in graph.get(name, [])), default=0)
        require(depth <= 32, 'tree dependency depth exceeds 32')
        depths[name] = depth
        return depth
    for name in graph: visit(name)


def native_identity(path):
    path = secure_path(path); before = path.stat()
    require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= NATIVE_BYTES, 'native executable must be a bounded regular file')
    digest = hashlib.sha256(); size = 0
    with path.open('rb') as stream:
        header = stream.read(1048576); digest.update(header); size += len(header)
        while chunk := stream.read(65536):
            size += len(chunk); require(size <= NATIVE_BYTES, 'native size limit exceeded'); digest.update(chunk)
        stream.seek(max(0, size - 24)); tail = stream.read(24)
        require(identity(os.fstat(stream.fileno())) == identity(before), 'native changed during inspection')
    require(size == before.st_size and identity(secure_path(path).stat()) == identity(before), 'native changed after inspection')
    target = None
    if header[:6] == b'\x7fELF\x02\x01' and len(header) >= 20 and struct.unpack_from('<H', header, 18)[0] == 62: target = 'ELF-x86_64'
    if header[:4] == b'\xcf\xfa\xed\xfe' and len(header) >= 8 and struct.unpack_from('<I', header, 4)[0] == 0x0100000c: target = 'MachO-arm64'
    if header[:2] == b'MZ' and len(header) >= 64:
        at = struct.unpack_from('<I', header, 60)[0]
        if at <= len(header)-6 and header[at:at+4] == b'PE\0\0' and struct.unpack_from('<H', header, at+4)[0] == 0x8664: target = 'PE-x86_64'
    require(target is not None, 'unrecognized or unsupported native executable target')
    return dict(path=str(path), bytes=size, sha256=digest.hexdigest(), target=target,
                bundle=tail[:16] in (b'SPROUT_BUNDLE_01', b'SPROUT_BUNDLE_02'), sqlite_profile='unknown')


def decode_capabilities(raw):
    """Strict schema-1 compiled self-report; no version, permission or ABI inference."""
    require(type(raw) is bytes and 0 < len(raw) <= CAPABILITY_BYTES and raw.endswith(b'\n'), 'capability response byte bound/termination')
    require(b'\0' not in raw and not raw.startswith(b'\xef\xbb\xbf'), 'NUL/BOM in capability response')
    payload = raw[:-1]
    if payload.endswith(b'\r'): payload = payload[:-1]
    require(b'\r' not in payload and b'\n' not in payload, 'capability response must have exactly one line')
    text = payload.decode('utf-8', 'strict')
    depth = 0; quoted = False; escaped = False
    for char in text:
        if quoted:
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == '"': quoted = False
        elif char == '"': quoted = True
        elif char in '[{':
            depth += 1; require(depth <= CAPABILITY_DEPTH, 'capability JSON depth limit exceeded')
        elif char in ']}':
            depth -= 1; require(depth >= 0, 'capability JSON delimiters are malformed')
    require(depth == 0 and not quoted, 'capability JSON is incomplete')
    members = 0
    def unique(pairs):
        nonlocal members
        result = {}
        for key, value in pairs:
            members += 1; require(members <= CAPABILITY_MEMBERS, 'capability JSON member limit exceeded')
            require(key not in result, 'duplicate capability field'); result[key] = value
        return result
    def invalid(value): raise DiagnosticError('nonfinite capability value')
    def finite(value):
        number = float(value); require(math.isfinite(number), 'nonfinite capability value'); return number
    data = json.loads(text, object_pairs_hook=unique, parse_constant=invalid, parse_float=finite)
    require(type(data) is dict and set(data) == {'schema', 'runtime', 'features', 'http_transport', 'host_library'}, 'unsupported capability fields')
    require(type(data['schema']) is int and data['schema'] == 1, 'unsupported capability schema')
    target = data['runtime']; features = data['features']; transport = data['http_transport']; host = data['host_library']
    require(type(target) is dict and set(target) == {'kind', 'os', 'arch'}, 'unsupported capability target fields')
    require(type(target['kind']) is str and target['kind'] in ('native', 'wasm'), 'unsupported capability target kind')
    require(type(target['os']) is str and target['os'] in ('windows', 'darwin', 'linux', 'emscripten', 'unknown'), 'unsupported capability OS family')
    require(type(target['arch']) is str and target['arch'] in ('x86_64', 'x86', 'aarch64', 'arm32', 'wasm32', 'wasm64', 'unknown'), 'unsupported capability architecture')
    require(type(features) is dict and set(features) == CAPABILITY_FEATURES and all(type(value) is bool for value in features.values()), 'unsupported capability feature fields/types')
    require(features['intrinsic_calls_v1'] is True and features['workflow_plan_v1'] is True, 'inconsistent pure capability features')
    require(type(host) is dict and set(host) == {'included', 'abi_version'} and host['included'] is False and host['abi_version'] is None, 'interpreter metadata cannot claim the C host ABI')
    require(type(transport) is dict and set(transport) == {'operation', 'kind', 'requires_external_tool'} and transport['operation'] == 'http_request_v1', 'unsupported capability transport fields')
    native = target['kind'] == 'native'
    require((target['os'] != 'emscripten' and target['arch'] not in ('wasm32', 'wasm64')) if native else
            (target['os'] == 'emscripten' and target['arch'] in ('wasm32', 'wasm64', 'unknown')), 'inconsistent capability target')
    require(all(features[name] is native for name in ('native_processes_v1', 'http_request_v1', 'workflow_run_v1')), 'inconsistent target capability operations')
    kind, tool = ('unavailable', None) if not native else ('winhttp', None) if target['os'] == 'windows' else ('curl', 'curl')
    require(type(transport['kind']) is str and transport['kind'] == kind, 'inconsistent capability transport')
    require(transport['requires_external_tool'] is None if tool is None else
            type(transport['requires_external_tool']) is str and transport['requires_external_tool'] == tool, 'inconsistent capability transport tool')
    return data


def _bounded_capability_command(argv):
    """Internal fixed-caller supervisor; CLI never accepts response-supplied argv."""
    process = None; buffers = [bytearray(), bytearray()]; errors = []; cleanup = []
    failed = threading.Event(); done = [threading.Event(), threading.Event()]; lock = threading.Lock()
    attempted = False; started_process = False; code = None
    def consume(index):
        try:
            stream = process.stdout if index == 0 else process.stderr
            read = getattr(stream, 'read1', stream.read)
            while chunk := read(512):
                with lock:
                    room = PROBE_BYTES - sum(map(len, buffers)); buffers[index].extend(chunk[:max(0, room)])
                    if len(chunk) > room:
                        errors.append('capability probe combined output cap exceeded'); failed.set(); break
        except Exception as error:
            errors.append('capability probe reader: ' + str(error)[:512]); failed.set()
        finally: done[index].set()
    readers = [threading.Thread(target=consume, args=(index,), daemon=True) for index in range(2)]
    try:
        tick = time.monotonic()
        require(math.isfinite(tick) and math.isfinite(PROBE_SECONDS) and PROBE_SECONDS > 0, 'invalid capability probe deadline')
        previous = tick
        attempted = True
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=str(Path(argv[0]).parent), creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        started_process = True
        for reader in readers: reader.start()
        while not failed.is_set():
            current = time.monotonic()
            require(math.isfinite(current) and current >= previous, 'capability probe clock moved backward or is nonfinite')
            previous = current
            remaining = PROBE_SECONDS - (current - tick)
            require(remaining > 0, 'capability probe execution deadline expired')
            if process.poll() is not None and all(event.is_set() for event in done): break
            failed.wait(min(.01, remaining))
    except Exception as error:
        errors.append(type(error).__name__ + ': ' + str(error)[:512])
    finally:
        if process is not None:
            try: live = process.poll() is None
            except Exception as error:
                live = False; cleanup.append('owned exit state unconfirmed: ' + str(error)[:512])
            if live:
                try: process.kill()
                except Exception as error: cleanup.append('owned direct kill: ' + str(error)[:512])
            try: code = process.wait(timeout=1)
            except Exception as error: cleanup.append('owned direct exit unconfirmed: ' + str(error)[:512])
            for reader in readers:
                if reader.ident is not None: reader.join(timeout=.5)
            for reader, stream in zip(readers, (process.stdout, process.stderr)):
                if reader.is_alive(): cleanup.append('capability reader/pipe cleanup unconfirmed')
                elif stream is not None and not stream.closed:
                    try: stream.close()
                    except Exception as error: cleanup.append('capability pipe close: ' + str(error)[:512])
    with lock: stdout, stderr = map(bytes, buffers)
    return dict(stdout=stdout, stderr=stderr, exit_code=code, errors=list(errors), cleanup_errors=list(cleanup),
                stdout_bytes=len(stdout), stderr_bytes=len(stderr), capture_truncated=failed.is_set(),
                pid=process.pid if process is not None else None, launch_attempted=attempted, process_started=started_process,
                argv=list(map(str, argv)))


def capabilities_probe(path):
    return _bounded_capability_command([str(path), '--capabilities-json'])


def version_probe(path):
    """Only an explicitly trusted native command; bounded pipes and owned cleanup."""
    process = None; buffers = [bytearray(), bytearray()]; errors = []; cleanup = []; limit = threading.Event(); lock = threading.Lock()
    def consume(index):
        try:
            stream = process.stdout if index == 0 else process.stderr
            while chunk := stream.read(512):
                with lock:
                    room = PROBE_BYTES - sum(map(len, buffers))
                    buffers[index].extend(chunk[:max(0, room)])
                    if len(chunk) > room: limit.set(); break
        except Exception as error: errors.append(type(error).__name__ + ': ' + str(error)); limit.set()
    readers = [threading.Thread(target=consume, args=(index,), daemon=True) for index in range(2)]
    started = time.monotonic(); code = None
    try:
        process = subprocess.Popen([str(path), 'version'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=str(Path(path).parent), creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        for thread in readers: thread.start()
        while process.poll() is None and not limit.is_set():
            remaining = PROBE_SECONDS - (time.monotonic() - started)
            require(remaining > 0, 'version probe deadline expired')
            try: process.wait(timeout=min(.05, remaining))
            except subprocess.TimeoutExpired: pass
        require(not limit.is_set(), 'version probe output/reader limit exceeded')
    except Exception as error: errors.append(type(error).__name__ + ': ' + str(error))
    finally:
        if process is not None:
            if process.poll() is None:
                try: process.kill()
                except OSError as error: cleanup.append('owned kill: ' + str(error))
            try: code = process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired) as error: cleanup.append('owned exit unconfirmed: ' + str(error))
            for thread in readers:
                if thread.ident is not None: thread.join(timeout=.5)
            for index, stream in enumerate((process.stdout, process.stderr)):
                if readers[index].is_alive(): cleanup.append('reader/pipe cleanup unconfirmed')
                elif stream is not None and not stream.closed:
                    try: stream.close()
                    except OSError as error: cleanup.append('pipe close: ' + str(error))
    if limit.is_set() and not errors: errors.append('version probe output/reader limit exceeded')
    return dict(stdout=bytes(buffers[0]), stderr=bytes(buffers[1]), exit_code=code, errors=errors, cleanup_errors=cleanup,
                stdout_bytes=len(buffers[0]), stderr_bytes=len(buffers[1]), capture_truncated=limit.is_set(),
                pid=process.pid if process is not None else None)


def _probe_trace(result):
    value = {key: result[key] for key in result if key not in ('stdout', 'stderr')}
    value['stdout_sha256'] = hashlib.sha256(result['stdout']).hexdigest()
    value['stderr_sha256'] = hashlib.sha256(result['stderr']).hexdigest()
    value['stderr_preview'] = result['stderr'].decode('utf-8', 'backslashreplace')[:512]
    return value


def _external_probe(report, result, name, *, attempted=None):
    if report.value['schema'] != 2: return
    execution = report.value['execution']; external = execution['external_probe']
    launch_attempted = result.get('launch_attempted', attempted is True)
    started = result.get('process_started', result.get('pid') is not None)
    execution[name] = bool(launch_attempted)
    external['launch_attempted'] |= bool(launch_attempted); external['process_started'] |= bool(started)
    if external['launch_attempted']:
        external.update(behavior='unverified', project_code_executed=None, network_accessed=None)


def _same_native(before, after):
    return all(before[key] == after[key] for key in ('path', 'bytes', 'sha256', 'target', 'bundle'))


def _identity_guard(report, native, before, phase):
    try:
        after = native_identity(native)
        require(_same_native(before, after), 'native identity differs from initial inspection')
    except (OSError, ValueError, RecursionError) as error:
        report.add('native.capabilities_identity_drift', 'error', 'Executable identity check failed ' + phase + ': ' + str(error),
                   'Select an unchanged physical trusted interpreter; existing captured output cannot qualify changed bytes.')
        return None
    return after


def _unknown_requirements(report):
    for item in report.value.get('required_features', []): item['availability'] = 'unknown'


def inspect_capabilities(report, native, observed):
    observation = dict(status='unknown', metadata=None); observed['capabilities'] = observation
    require(str(native).encode('utf-8', 'strict') and not any(ord(char) < 32 or ord(char) == 127 for char in str(native)),
            'capability probe path must be valid UTF-8 without control characters')
    before = _identity_guard(report, native, observed, 'before capability launch')
    if before is None: return False
    result = capabilities_probe(observed['path']); observed['capabilities_probe'] = _probe_trace(result)
    _external_probe(report, result, 'capabilities_probe')
    clean = not result['errors'] and not result['cleanup_errors'] and result['exit_code'] == 0 and not result['capture_truncated']
    if not clean:
        report.add('native.capabilities_failed', 'error', 'Trusted capability query failed or cleanup is unconfirmed.',
                   'Inspect bounded capture/cleanup details and choose a trusted qualified runtime; there is no version fallback.',
                   errors=result['errors'], cleanup_errors=result['cleanup_errors'], exit_code=result['exit_code'])
    after = _identity_guard(report, native, observed, 'after capability cleanup')
    if after is not None:
        observed['capabilities_identity'] = dict(before_sha256=before['sha256'], after_sha256=after['sha256'], unchanged=True)
    if not clean or after is None: return False
    try:
        require(not result['stderr'], 'capability query stderr must be empty')
        metadata = decode_capabilities(result['stdout'])
    except (OSError, ValueError, RecursionError) as error:
        report.add('native.capabilities_invalid', 'error', 'Unsupported or malformed capability response: ' + str(error),
                   'Use a trusted runtime with the documented query/schema; unknown responses do not establish absence or availability.')
        return False
    target = metadata['runtime']
    allowed = {'PE-x86_64': ('windows',), 'MachO-arm64': ('darwin',), 'ELF-x86_64': ('linux', 'unknown')}
    arch = 'aarch64' if observed['target'] == 'MachO-arm64' else 'x86_64'
    if target['kind'] != 'native' or target['os'] not in allowed[observed['target']] or target['arch'] != arch:
        report.add('native.capabilities_target_mismatch', 'error', 'Executable format and self-reported target disagree.',
                   'Review the trusted interpreter identity; this doctor does not inspect WASM artifacts or authenticate metadata.')
        return False
    observation.update(status='observed', metadata=metadata)
    report.add('native.capabilities_observed', 'info', 'Compiled capability self-report observed from unchanged executable bytes.',
               'This does not verify permissions, external tools, publisher/build provenance, C host ABI or application compatibility.')
    if observed.get('sqlite_profile') == 'declared_in_matching_manifest' and not metadata['features']['sqlite_adapter_v1']:
        report.add('native.capabilities_manifest_disagreement', 'error', 'Matching manifest declares SQLite, but this self-report says its adapter is unavailable.',
                   'Review the matching manifest/build independently; both observations are retained and no repair is performed.')
    for item in report.value['required_features']:
        available = metadata['features'][item['name']]
        item['availability'] = 'available' if available else 'unavailable'
        report.add('native.feature_available' if available else 'native.feature_unavailable', 'info' if available else 'error',
                   item['name'] + (' is compiled in according to this self-report.' if available else ' is unavailable according to this self-report.'),
                   'Select a build that includes the required feature; availability does not grant permissions or prove tool readiness.',
                   feature=item['name'])
    return True


def inspect_native(report, native, manifest, probe, capability_probe=False):
    if not native:
        require(not manifest and not probe and not capability_probe, '--native is required for a native manifest/probe')
        report.add('native.not_supplied', 'info', 'No native executable inspected.', 'Supply --native for exact file identity; add --probe-version only for a trusted interpreter.')
        return
    observed = native_identity(native); report.value['native'] = observed
    if observed['bundle']:
        report.add('native.bundle', 'error', 'The supplied executable has a Sprout bundle footer.', 'Supply an interpreter, not an executable project; native probing is refused.')
        return
    expected_version = None
    if manifest:
        reader = Reader(secure_path(Path(manifest).parent, directory=True))
        def unique(pairs):
            result = {}
            for key, value in pairs: require(key not in result, 'duplicate native manifest field'); result[key] = value
            return result
        def invalid(value): raise DiagnosticError('nonfinite native manifest data')
        def finite(value):
            number = float(value); require(math.isfinite(number), 'nonfinite native manifest data'); return number
        value = json.loads(reader.text(secure_path(manifest)), object_pairs_hook=unique, parse_constant=invalid, parse_float=finite)
        require(isinstance(value, dict) and type(value.get('schema')) is int and value['schema'] == 1 and value.get('target') == observed['target'], 'native manifest identity/target mismatch')
        require(isinstance(value.get('revision'), str) and re.fullmatch(r'[0-9a-f]{40}', value['revision']) and isinstance(value.get('version'), str) and VERSION.fullmatch(value['version']), 'native manifest revision/version invalid')
        platforms = {'ELF-x86_64': ('Linux', 'sprout-linux-x86_64'), 'MachO-arm64': ('macOS', 'sprout-macos-arm64'), 'PE-x86_64': ('Windows', 'sprout-windows-x86_64.exe')}
        platform, asset = platforms[observed['target']]
        require(value.get('platform') == platform and isinstance(value.get('tag'), str) and value['version'] == 'Sprout ' + value['tag'], 'native manifest platform/tag mismatch')
        items = value.get('assets'); require(isinstance(items, list) and len(items) <= 2, 'invalid native manifest assets')
        matches = [item for item in items if isinstance(item, dict) and item.get('name') == asset and item.get('sha256') == observed['sha256'] and type(item.get('bytes')) is int and item['bytes'] == observed['bytes']]
        require(len(matches) == 1, 'native manifest does not pin these exact bytes')
        profile = value.get('build_profile'); require(profile == 'O2 native SPROUT_SQLITE' and isinstance(value.get('sqlite_source_sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', value['sqlite_source_sha256']), 'unsupported or missing declared native build profile')
        observed.update(declared_build_profile=profile, declared_sqlite_source_sha256=value['sqlite_source_sha256'], source_revision=value['revision'], sqlite_profile='declared_in_matching_manifest')
        expected_version = value['version']
        report.add('native.profile_declared', 'info', 'Matching manifest declares the native SQLite build profile.', 'This checks identity/declaration, not runtime feature execution or publisher authentication.')
    else:
        report.add('native.profile_unknown', 'info', 'SQLite/build profile is unknown without a matching platform record.', 'Provide the trusted release platform manifest; version success does not identify SQLite features.')
    if capability_probe and not inspect_capabilities(report, native, observed): return
    if probe:
        if capability_probe and _identity_guard(report, native, observed, 'before requested version launch') is None:
            observed['capabilities'].update(status='unknown', metadata=None); _unknown_requirements(report); return
        report.value['execution']['version_probe'] = True
        result = version_probe(observed['path'])
        observed['version_probe'] = {key: value for key, value in result.items() if key not in ('stdout', 'stderr')}
        if capability_probe:
            _external_probe(report, result, 'version_probe', attempted=True)
            if _identity_guard(report, native, observed, 'after requested version cleanup') is None:
                observed['capabilities'].update(status='unknown', metadata=None); _unknown_requirements(report)
                return
        require(not result['errors'] and not result['cleanup_errors'] and result['exit_code'] == 0, 'trusted version probe failed: ' + '; '.join(result['errors'] + result['cleanup_errors']))
        output = result['stdout'].decode('utf-8', errors='strict').strip()
        require(VERSION.fullmatch(output) is not None and not result['stderr'], 'version probe did not produce one clean Sprout version line')
        require(expected_version is None or output == expected_version, 'probed version differs from manifest')
        require(native_identity(native)['sha256'] == observed['sha256'], 'native changed during version probe')
        observed['version'] = output


def diagnose(project, *, entry=None, native=None, native_manifest=None, probe_version=False, mode='project', state_dir=None, allow_io=False,
             probe_capabilities=False, required_features=()):
    report = Report(Path(os.path.abspath(project)), capabilities=probe_capabilities, probe_version=probe_version)
    try:
        require(type(required_features) in (tuple, list) and len(required_features) <= len(CAPABILITY_FEATURES), 'required features must be a bounded list/tuple')
        require(all(type(name) is str and name in CAPABILITY_FEATURES for name in required_features) and
                len(set(required_features)) == len(required_features), 'unknown or duplicate required feature')
        require(not required_features or probe_capabilities, 'required features need explicit --probe-capabilities')
        if probe_capabilities:
            report.value['required_features'] = [dict(name=name, availability='unknown') for name in required_features]
        reader = Reader(project)
        try: settings = config(reader, report)
        except (OSError, ValueError, RecursionError) as error:
            report.add('project.config_invalid', 'error', str(error), 'Use bounded valid UTF-8 documented flat config; no project execution occurred.'); settings = {}
        main = declared_files(reader, report, settings, entry)
        try: inspect_packages(reader, report)
        except (OSError, ValueError, RecursionError) as error:
            report.add('packages.metadata_invalid', 'error', str(error), 'Restore matching valid sprout.packages/sprout.lock/package manifests; no repair was performed.')
        if mode != 'project' or state_dir is not None:
            require(mode in ('worker', 'service'), '--state-dir requires --mode worker or service')
            state = secure_path(state_dir if state_dir is not None else main.parent if main is not None else reader.root, directory=True)
            readable = os.access(state, os.R_OK | (os.X_OK if os.name != 'nt' else 0))
            writable = os.access(state, os.W_OK | (os.X_OK if os.name != 'nt' else 0))
            report.value['environment'] = dict(mode=mode, sandbox=not allow_io, state_dir=str(state), readable_observed=readable, writable_observed=writable, write_probe_performed=False)
            require(readable, 'state directory is not observably readable/searchable')
            if not writable: report.add('environment.state_write_unconfirmed', 'warning', 'State directory is not observably writable.', 'Use an existing writable directory for I/O state; ACLs/locks/quotas are not tested by this observation.', state)
            report.add('environment.permissions', 'info', 'Planned worker sandbox is ' + ('disabled' if allow_io else 'enabled') + '.', 'I/O workers such as SQLite contacts need explicit --allow-io; pure workers may remain sandboxed.')
        report.value['inspected'] = dict(files=len(reader.cache), bytes=reader.total)
        try: inspect_native(report, native, native_manifest, probe_version, probe_capabilities)
        except (OSError, ValueError, RecursionError) as error:
            report.add('native.invalid', 'error', str(error), 'Select a regular trusted interpreter and matching platform record; inspect any probe cleanup diagnostics.')
    except (OSError, ValueError, RecursionError) as error:
        report.add('inspection.incomplete', 'error', str(error), 'Correct the path/permissions or reduce inputs to documented inspection limits.')
    return report.finish()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('--entry')
    parser.add_argument('--native', type=Path)
    parser.add_argument('--native-manifest', type=Path)
    parser.add_argument('--probe-version', action='store_true', help='Execute version only for the explicitly supplied trusted interpreter')
    parser.add_argument('--probe-capabilities', action='store_true', help='Execute --capabilities-json only for the supplied trusted interpreter; legacy code may execute a program')
    parser.add_argument('--require-feature', action='append', choices=sorted(CAPABILITY_FEATURES), default=[], help='Require an explicit compiled feature self-report; needs --probe-capabilities')
    parser.add_argument('--mode', choices=('project', 'worker', 'service'), default='project')
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--allow-io', action='store_true', help='Diagnose intended I/O permission; grants nothing')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    if (args.probe_version or args.probe_capabilities or args.native_manifest) and not args.native: parser.error('--native is required')
    if args.require_feature and not args.probe_capabilities: parser.error('--require-feature needs explicit --probe-capabilities')
    if len(set(args.require_feature)) != len(args.require_feature): parser.error('duplicate --require-feature')
    if (args.state_dir or args.allow_io) and args.mode == 'project': parser.error('state/permission options require --mode worker or service')
    report = diagnose(args.project, entry=args.entry, native=args.native, native_manifest=args.native_manifest,
                      probe_version=args.probe_version, mode=args.mode, state_dir=args.state_dir, allow_io=args.allow_io,
                      probe_capabilities=args.probe_capabilities, required_features=args.require_feature)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    else:
        print('Sprout project doctor: ' + report['status'] + ' (diagnostics only)')
        for item in report['checks']:
            if item['severity'] != 'info':
                print('%s %s: %s' % (item['severity'].upper(), item['code'], item['message']))
                if item['action']: print('  ' + item['action'])
        if report['schema'] == 2:
            if report['execution']['external_probe']['launch_attempted']:
                print('External executable probe attempted; its code/network effects are unverified.')
            else: print('No external executable probe attempted.')
            print('The doctor performed no repairs, dependency downloads or write-readiness probes.')
        else: print('No repairs, project execution, dependency downloads or write-readiness probes performed.')
    return 1 if report['summary']['error'] else 0


if __name__ == '__main__': raise SystemExit(main())
