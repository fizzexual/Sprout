"""Adversarial local release-gate fixtures, with no network or publication."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import struct
import unittest

spec = importlib.util.spec_from_file_location('release_manifest', Path(__file__).resolve().parents[2] / 'tools/release_manifest.py')
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
TAG = 'v0.2.0-dev'; REVISION = 'a' * 40

def installer_fixture(payload):
    data = bytearray(0x400 + len(payload))
    data[:2] = b'MZ'; struct.pack_into('<I', data, 60, 64)
    data[64:68] = b'PE\0\0'; struct.pack_into('<HH', data, 68, 0x8664, 1)
    struct.pack_into('<H', data, 84, 240)
    optional = 88; struct.pack_into('<H', data, optional, 0x20b)
    struct.pack_into('<I', data, optional + 108, 16)
    struct.pack_into('<II', data, optional + 128, 0x1000, 0x200)
    section = optional + 240
    struct.pack_into('<IIII', data, section + 8, 0x200 + len(payload), 0x1000,
                     0x200 + len(payload), 0x200)
    base = 0x200
    for offset, key, child, named in [(0, 10, 0x80000020, False),
                                      (0x20, 0x80000080, 0x80000040, True),
                                      (0x40, 1033, 0x60, False)]:
        struct.pack_into('<HH', data, base + offset + 12, int(named), int(not named))
        struct.pack_into('<II', data, base + offset + 16, key, child)
    struct.pack_into('<IIII', data, base + 0x60, 0x1200, len(payload), 0, 0)
    name = 'SPROUT_EXE'.encode('utf-16-le')
    struct.pack_into('<H', data, base + 0x80, len(name)//2)
    data[base + 0x82:base + 0x82 + len(name)] = name
    data[0x400:] = payload
    return data

class ReleaseGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-release-gate-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        elf = bytearray(64); elf[:6] = b'\x7fELF\x02\x01'; struct.pack_into('<H',elf,18,62)
        macho = b'\xcf\xfa\xed\xfe' + struct.pack('<I',0x0100000c)
        pe = bytearray(128); pe[:2] = b'MZ'; struct.pack_into('<I',pe,60,64); pe[64:68] = b'PE\0\0'; struct.pack_into('<H',pe,68,0x8664)
        for platform, content in [('Linux',elf),('macOS',macho),('Windows',pe)]: (self.root / release.PLATFORMS[platform]).write_bytes(content)
        (self.root / release.INSTALLER).write_bytes(installer_fixture(pe))
        for platform, asset in release.PLATFORMS.items():
            names = [asset, release.INSTALLER] if platform == 'Windows' else [asset]
            record = dict(schema=1, platform=platform, target=release.TARGETS[platform], tag=TAG, revision=REVISION, version='Sprout ' + TAG,
                          sqlite_source_sha256='b' * 64, assets=[release.file_record(self.root / name) for name in names])
            (self.root / (asset + '.manifest.json')).write_text(json.dumps(record))
    def alter(self, modify):
        path = self.root / (release.PLATFORMS['Linux'] + '.manifest.json')
        value = json.loads(path.read_text()); modify(value); path.write_text(json.dumps(value))
    def test_complete_set_pins_every_asset_and_record(self):
        release.assemble(self.root, TAG, REVISION)
        checksums = (self.root / 'SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(checksums), 8)
        for line in checksums:
            digest, name = line.split('  '); self.assertEqual(digest, hashlib.sha256((self.root / name).read_bytes()).hexdigest())
    def test_tampered_binary_does_not_create_publish_manifest(self):
        (self.root / release.PLATFORMS['Linux']).write_bytes(b'tampered')
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
        self.assertFalse((self.root / 'release-manifest.json').exists())
    def test_missing_and_unexpected_assets_fail_closed(self):
        (self.root / release.INSTALLER).unlink()
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
        (self.root / release.INSTALLER).write_bytes(('asset:' + release.INSTALLER).encode())
        (self.root / 'unreviewed.exe').write_bytes(b'unexpected')
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
    def test_version_source_and_sqlite_mismatch_fail_closed(self):
        for field, value in [('tag', 'v0.1.15'), ('revision', 'c'*40), ('version', 'Sprout v0.1.15'), ('sqlite_source_sha256', 'c'*64)]:
            with self.subTest(field=field):
                original = json.loads((self.root / (release.PLATFORMS['Linux'] + '.manifest.json')).read_text())
                self.alter(lambda record: record.update({field: value}))
                with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
                self.alter(lambda record: record.update(original))
    def test_manifest_cannot_name_outside_files_or_hide_duplicate_keys(self):
        self.alter(lambda record: record['assets'][0].update(name='../outside'))
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
        path = self.root / (release.PLATFORMS['Linux'] + '.manifest.json')
        path.write_text('{"schema":1,"schema":1}')
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
    def test_boolean_size_is_not_an_integer_size(self):
        self.alter(lambda record: record['assets'][0].update(bytes=True))
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
    def test_version_identity_rejects_short_or_unversioned_inputs(self):
        for tag, revision in [('latest', REVISION), ('v0.2.0-dev', 'abc123'), ('v../../x', REVISION)]:
            with self.assertRaises(ValueError): release.identity(tag, revision)
    def test_native_target_and_nonfinite_metadata_fail_closed(self):
        self.alter(lambda record: record.update(target='PE-x86'))
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
        self.alter(lambda record: record.update(target=release.TARGETS['Linux'], bad=float('nan')))
        with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
    def test_revalidation_replaces_its_own_outputs(self):
        release.assemble(self.root,TAG,REVISION)
        (self.root/'SHA256SUMS').write_text('damaged generated output')
        release.assemble(self.root,TAG,REVISION)
        self.assertEqual(len((self.root/'SHA256SUMS').read_text().splitlines()),8)
    def test_installer_payload_must_match_even_with_updated_record(self):
        path = self.root / release.INSTALLER
        for content in [b'not an installer', installer_fixture(b'stale interpreter')]:
            with self.subTest(content=content[:20]):
                path.write_bytes(content)
                record_path = self.root / (release.PLATFORMS['Windows'] + '.manifest.json')
                record = json.loads(record_path.read_text())
                record['assets'][1] = release.file_record(path)
                record_path.write_text(json.dumps(record))
                with self.assertRaises(ValueError): release.assemble(self.root, TAG, REVISION)
                self.assertFalse((self.root / 'release-manifest.json').exists())
    def test_malformed_resource_addresses_fail_closed(self):
        payload = (self.root / release.PLATFORMS['Windows']).read_bytes()
        for offset, value in [(88 + 128, 0xfffffff0), (0x200 + 20, 0x800001f8),
                               (0x200 + 0x60, 0x7fffffff), (0x200 + 0x64, 0xffffffff)]:
            with self.subTest(offset=offset):
                fixture = installer_fixture(payload)
                struct.pack_into('<I', fixture, offset, value)
                (self.root / release.INSTALLER).write_bytes(fixture)
                with self.assertRaises(ValueError): release.installer_payload_digest(self.root / release.INSTALLER)
    def test_resource_groups_and_language_ids_match_windows_lookup(self):
        payload = (self.root / release.PLATFORMS['Windows']).read_bytes()
        for offset, fmt, value in [(0x200 + 12, '<HH', (1, 0)),
                                   (0x200 + 0x20 + 12, '<HH', (0, 1)),
                                   (0x200 + 0x40 + 16, '<I', (65536,)),
                                   (0x200 + 0x40 + 12, '<HH', (1, 0))]:
            with self.subTest(offset=offset):
                fixture = installer_fixture(payload)
                struct.pack_into(fmt, fixture, offset, *value)
                (self.root / release.INSTALLER).write_bytes(fixture)
                with self.assertRaises(ValueError): release.installer_payload_digest(self.root / release.INSTALLER)

if __name__ == '__main__': unittest.main()
