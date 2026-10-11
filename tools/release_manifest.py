"""Create and verify local release asset records; never publishes or downloads."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import struct

PLATFORMS = {
    'Linux': 'sprout-linux-x86_64',
    'macOS': 'sprout-macos-arm64',
    'Windows': 'sprout-windows-x86_64.exe',
}
INSTALLER = 'sprout-installer.exe'
TARGETS = {'Linux': 'ELF-x86_64', 'macOS': 'MachO-arm64', 'Windows': 'PE-x86_64'}

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024): value.update(chunk)
    return value.hexdigest()

def require(condition, message):
    if not condition: raise ValueError(message)

def identity(tag, revision):
    require(re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', tag), 'release tag must identify a version')
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'source revision must be a full lowercase Git SHA')

def file_record(path):
    require(path.is_file() and not path.is_symlink(), f'asset must be a regular non-symlink file: {path.name}')
    return dict(name=path.name, bytes=path.stat().st_size, sha256=digest(path))

def native_target(path):
    with path.open('rb') as stream: header = stream.read(1048576)
    if header.startswith(b'\x7fELF') and len(header) >= 20 and header[4:6] == b'\x02\x01' and struct.unpack_from('<H', header, 18)[0] == 62: return 'ELF-x86_64'
    if header.startswith(b'\xcf\xfa\xed\xfe') and len(header) >= 8 and struct.unpack_from('<I', header, 4)[0] == 0x0100000c: return 'MachO-arm64'
    if header.startswith(b'MZ') and len(header) >= 64:
        at = struct.unpack_from('<I', header, 60)[0]
        if at + 6 <= len(header) and header[at:at+4] == b'PE\0\0' and struct.unpack_from('<H', header, at+4)[0] == 0x8664: return 'PE-x86_64'
    raise ValueError('unsupported or mislabeled native executable target')

def installer_payload_digest(path):
    """Read the named PE resource without loading or executing the installer."""
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 160 * 1048576,
            'installer must be a bounded regular file')
    data = path.read_bytes()
    def unpack(fmt, at):
        size = struct.calcsize(fmt)
        require(0 <= at <= len(data) - size, 'truncated installer structure')
        return struct.unpack_from(fmt, data, at)
    require(data[:2] == b'MZ', 'installer must be a PE executable')
    pe, = unpack('<I', 60)
    require(data[pe:pe+4] == b'PE\0\0', 'invalid installer PE signature')
    machine, sections = unpack('<HH', pe + 4)
    optional_size, = unpack('<H', pe + 20)
    optional = pe + 24
    magic, = unpack('<H', optional)
    require(machine == 0x8664 and magic == 0x20b and 1 <= sections <= 96 and optional_size >= 136,
            'installer must be a PE64 x86_64 executable')
    count, = unpack('<I', optional + 108)
    require(count >= 3, 'installer has no resource directory')
    resource_rva, resource_size = unpack('<II', optional + 128)
    require(resource_rva and resource_size >= 16, 'installer has no resources')
    table = optional + optional_size
    ranges = []
    for index in range(sections):
        size, rva, raw_size, offset = unpack('<IIII', table + index * 40 + 8)
        require(offset + raw_size <= len(data), 'truncated installer section')
        ranges.append((rva, raw_size, offset))
    def locate(rva, size):
        matches = [offset + rva - start for start, length, offset in ranges
                   if start <= rva and size <= length - (rva - start)]
        require(len(matches) == 1, 'invalid or ambiguous installer resource address')
        return matches[0]
    base = locate(resource_rva, resource_size)
    def relative(offset, size):
        require(0 <= offset <= resource_size - size, 'resource structure outside directory')
        return base + offset
    def entries(offset):
        at = relative(offset, 16)
        named, ids = unpack('<HH', at + 12)
        require(named + ids <= 4096, 'too many installer resources')
        relative(offset + 16, (named + ids) * 8)
        result = []
        for index in range(named + ids):
            name, child = unpack('<II', at + 16 + index * 8)
            require(bool(name & 0x80000000) == (index < named),
                    'installer resource name does not match its typed directory group')
            if name & 0x80000000:
                text = name & 0x7fffffff
                length, = unpack('<H', relative(text, 2))
                start = relative(text + 2, length * 2)
                try: name = data[start:start + length * 2].decode('utf-16-le', errors='strict')
                except UnicodeError as error: raise ValueError('invalid installer resource name') from error
            result.append((name, child))
        return result
    def directory_child(offset, key):
        children = [child for name, child in entries(offset) if name == key]
        require(len(children) == 1 and children[0] & 0x80000000, 'missing or duplicate installer payload resource')
        return children[0] & 0x7fffffff
    kind = directory_child(0, 10)  # RT_RCDATA
    named = directory_child(kind, 'SPROUT_EXE')
    languages = entries(named)
    require(len(languages) == 1 and not languages[0][1] & 0x80000000,
            'installer payload must have one language resource')
    require(type(languages[0][0]) is int and 0 <= languages[0][0] <= 65535,
            'installer language must be a numeric WORD identifier')
    payload_rva, payload_size, _, _ = unpack('<IIII', relative(languages[0][1], 16))
    require(payload_size > 0, 'empty installer payload')
    start = locate(payload_rva, payload_size)
    return hashlib.sha256(memoryview(data)[start:start + payload_size]).hexdigest()

def verify_installer(installer, asset):
    require(installer_payload_digest(installer) == digest(asset),
            'installer embedded interpreter differs from tested Windows asset')

def write_platform(asset, platform, tag, revision, *, installer=None, compiler='cc'):
    identity(tag, revision)
    asset = Path(asset)
    require(platform in PLATFORMS and asset.name == PLATFORMS[platform], 'asset name does not match platform')
    target = native_target(asset)
    require(target == TARGETS[platform], 'native executable target does not match its asset label')
    require((installer is not None) == (platform == 'Windows'), 'Windows requires an installer; other platforms must omit it')
    version = subprocess.run([str(asset.resolve()), 'version'], check=True, capture_output=True,
                             text=True, encoding='utf-8', timeout=15).stdout.strip()
    require(version == 'Sprout ' + tag, 'binary version must match the release tag')
    assets = [file_record(asset)]
    if installer is not None:
        require(Path(installer).name == INSTALLER, 'unexpected installer filename')
        verify_installer(Path(installer), asset)
        assets.append(file_record(Path(installer)))
    compiler_version = subprocess.run([compiler, '--version'], check=True, capture_output=True,
                                      text=True, encoding='utf-8', errors='replace', timeout=15).stdout.splitlines()[0]
    repository = Path(__file__).resolve().parents[1]
    sqlite = repository / 'src/vendor/sqlite/sqlite3.c'
    record = dict(schema=1, platform=platform, target=target, tag=tag, revision=revision,
                  version=version, created_at=datetime.now(timezone.utc).isoformat(),
                  compiler=compiler_version[:512], assets=assets,
                  sqlite_source_sha256=digest(sqlite), build_profile='O2 native SPROUT_SQLITE',
                  workflow=os.environ.get('GITHUB_WORKFLOW'), run_id=os.environ.get('GITHUB_RUN_ID'))
    output = asset.with_name(asset.name + '.manifest.json')
    output.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    return output

def strict_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate release manifest key')
        value[key] = item
    return value

def assemble(directory, tag, revision):
    identity(tag, revision)
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink(), 'release directory must be a regular directory')
    records, observed = [], set()
    expected = set(PLATFORMS.values()) | {INSTALLER}
    manifests = {name + '.manifest.json' for name in PLATFORMS.values()}
    allowed = expected | manifests
    names = {path.name for path in directory.iterdir()}
    generated = {'release-manifest.json', 'SHA256SUMS'}
    require(allowed <= names and names <= allowed | generated, 'release files are missing or unexpected')
    for name in generated:
        path = directory / name
        require(not path.is_symlink() and (not path.exists() or path.is_file()), 'generated release output is not a regular file')
    for platform, asset in PLATFORMS.items():
        path = directory / (asset + '.manifest.json')
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1048576, 'invalid platform manifest file')
        def invalid_constant(value): raise ValueError('non-finite release metadata')
        try: record = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=strict_object, parse_constant=invalid_constant)
        except RecursionError as error: raise ValueError('release metadata is nested too deeply') from error
        require(isinstance(record, dict) and record.get('schema') == 1 and record.get('platform') == platform, 'invalid platform manifest identity')
        require(record.get('tag') == tag and record.get('revision') == revision and record.get('version') == 'Sprout ' + tag, 'platform version/source mismatch')
        require(record.get('target') == TARGETS[platform], 'platform target mismatch')
        items = record.get('assets')
        require(isinstance(items, list) and len(items) == (2 if platform == 'Windows' else 1), 'invalid platform assets')
        platform_names = {asset, INSTALLER} if platform == 'Windows' else {asset}
        require({item.get('name') for item in items if isinstance(item, dict)} == platform_names, 'invalid platform asset names')
        for item in items:
            name = item['name']
            require(name in expected and name not in observed, 'duplicate or unexpected release asset')
            actual = file_record(directory / name)
            if name != INSTALLER: require(native_target(directory / name) == TARGETS[platform], 'native target changed or does not match platform')
            require(type(item.get('bytes')) is int and item['bytes'] == actual['bytes'], 'asset size mismatch')
            require(isinstance(item.get('sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', item['sha256']) and item['sha256'] == actual['sha256'], 'asset checksum mismatch')
            observed.add(name)
        records.append(record)
    require(observed == expected, 'release asset set is incomplete')
    verify_installer(directory / INSTALLER, directory / PLATFORMS['Windows'])
    require(len({item.get('sqlite_source_sha256') for item in records}) == 1 and re.fullmatch(r'[0-9a-f]{64}', records[0].get('sqlite_source_sha256', '')), 'SQLite source mismatch')
    manifest = directory / 'release-manifest.json'
    manifest.write_text(json.dumps(dict(schema=1, tag=tag, revision=revision,
        platforms=records, records=[file_record(directory / name) for name in sorted(manifests)]), indent=2) + '\n', encoding='utf-8')
    checksums = directory / 'SHA256SUMS'
    checksums.write_text(''.join(f'{digest(directory / name)}  {name}\n' for name in sorted(allowed | {manifest.name})), encoding='ascii')
    return manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    platform = sub.add_parser('platform')
    platform.add_argument('asset'); platform.add_argument('--platform', required=True)
    platform.add_argument('--installer'); platform.add_argument('--compiler', default='cc')
    assemble_parser = sub.add_parser('assemble'); assemble_parser.add_argument('directory')
    for command in (platform, assemble_parser):
        command.add_argument('--tag', required=True); command.add_argument('--revision', required=True)
    args = parser.parse_args()
    try:
        result = write_platform(args.asset, args.platform, args.tag, args.revision, installer=args.installer, compiler=args.compiler) if args.operation == 'platform' else assemble(args.directory, args.tag, args.revision)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f'release validation failed: {error}\n')
    print(result)

if __name__ == '__main__': main()
