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

class ReleaseGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-release-gate-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        elf = bytearray(64); elf[:6] = b'\x7fELF\x02\x01'; struct.pack_into('<H',elf,18,62)
        macho = b'\xcf\xfa\xed\xfe' + struct.pack('<I',0x0100000c)
        pe = bytearray(128); pe[:2] = b'MZ'; struct.pack_into('<I',pe,60,64); pe[64:68] = b'PE\0\0'; struct.pack_into('<H',pe,68,0x8664)
        for platform, content in [('Linux',elf),('macOS',macho),('Windows',pe)]: (self.root / release.PLATFORMS[platform]).write_bytes(content)
        (self.root / release.INSTALLER).write_bytes(('asset:' + release.INSTALLER).encode())
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

if __name__ == '__main__': unittest.main()
