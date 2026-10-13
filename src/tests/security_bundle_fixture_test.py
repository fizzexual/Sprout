"""Pure modeled pathname retention control; never launches any executable."""
import ast
import errno
import hashlib
import os
import pathlib
import struct
import tempfile
import textwrap
import types
import unittest
from unittest import mock

SOURCE = pathlib.Path(__file__).with_name('security_boundary_test.py')
OBSERVATIONS = {}

# Exact pre-correction helper from security_boundary_test.py. The legacy control
# models retention of the first pathname; it does not reproduce its OS cause.
LEGACY_SOURCE = '''
    def crafted_bundle(self, files, entry=b'app.sprout', *, count=None, trailing=b''):
        files = [(path.encode() if isinstance(path, str) else path, content) for path, content in files]
        archive = struct.pack('<Q', len(entry)) + entry + struct.pack('<Q', len(files) if count is None else count)
        for path, content in files:
            archive += struct.pack('<QQ', len(path), len(content)) + hashlib.sha256(content).digest() + path + content
        archive += trailing
        bundle = self.project / ('fixture.exe' if os.name == 'nt' else 'fixture')
        bundle.write_bytes(BINARY.read_bytes() + archive + b'SPROUT_BUNDLE_02' + struct.pack('<Q', len(archive)))
        bundle.chmod(0o755)
        return bundle
'''


def selected_helper(binary):
    """Compile only the known preparation method, never import the suite."""
    tree = ast.parse(SOURCE.read_bytes().decode('utf-8'))
    owner = next(node for node in tree.body
                 if isinstance(node, ast.ClassDef) and node.name == 'SecurityBoundary')
    method = next(node for node in owner.body
                  if isinstance(node, ast.FunctionDef) and node.name == 'crafted_bundle')
    unit = ast.Module(body=[method], type_ignores=[])
    namespace = {'hashlib': hashlib, 'struct': struct, 'pathlib': pathlib,
                 'tempfile': tempfile, 'os': os, 'BINARY': binary}
    exec(compile(ast.fix_missing_locations(unit), str(SOURCE), 'exec'), namespace)
    return namespace['crafted_bundle'], namespace


def expected_bytes(prefix, count):
    entry, content = b'app.sprout', b'show 1\n'
    archive = (len(entry).to_bytes(8, 'little') + entry + count.to_bytes(8, 'little')
               + len(entry).to_bytes(8, 'little') + len(content).to_bytes(8, 'little')
               + hashlib.sha256(content).digest() + entry + content)
    return prefix + archive + b'SPROUT_BUNDLE_02' + len(archive).to_bytes(8, 'little')


class CraftedBundleFixtureTests(unittest.TestCase):
    def test_busy_previous_path_does_not_block_distinct_exact_artifacts(self):
        # The fixed CI case counts are retained; the prefix is inert data, not a
        # Sprout executable. No subprocess API is imported or called here.
        prefix = b'SPROUT_PATH_MODEL_ONLY_NOT_AN_EXECUTABLE\x00\xff'
        counts = (2**64 - 1, 2)
        with tempfile.TemporaryDirectory(prefix='sprout-bundle-path-model-') as temporary:
            root = pathlib.Path(temporary)
            binary = root / 'inert-prefix'
            binary.write_bytes(prefix)
            current, namespace = selected_helper(binary)
            exec(compile(textwrap.dedent(LEGACY_SOURCE), '<fixed-legacy-helper>', 'exec'), namespace)
            legacy = namespace['crafted_bundle']
            original_open = pathlib.Path.open
            held = set()
            writes = []

            def busy_open(path, mode='r', *args, **kwargs):
                if any(flag in mode for flag in ('w', 'x', 'a', '+')):
                    writes.append((path, mode))
                    if path.resolve() in held:
                        raise OSError(errno.ETXTBSY, 'modeled held executable pathname', str(path))
                return original_open(path, mode, *args, **kwargs)

            old_project, new_project = root / 'legacy-project', root / 'new-project'
            old_project.mkdir()
            new_project.mkdir()
            files = [(b'app.sprout', b'show 1\n')]
            with mock.patch.object(pathlib.Path, 'open', busy_open):
                old_first = legacy(types.SimpleNamespace(project=old_project), files, count=counts[0])
                held.add(old_first.resolve())
                with self.assertRaises(OSError) as refused:
                    legacy(types.SimpleNamespace(project=old_project), files, count=counts[1])
                self.assertEqual(refused.exception.errno, errno.ETXTBSY)
                self.assertEqual(old_first.read_bytes(), expected_bytes(prefix, counts[0]))
                first = current(types.SimpleNamespace(project=new_project), files, count=counts[0])
                held.add(first.resolve())
                second = current(types.SimpleNamespace(project=new_project), files, count=counts[1])
                self.assertNotEqual(first, second)
                self.assertNotEqual(first.parent, second.parent)
                self.assertEqual(first.parent.parent, new_project)
                self.assertEqual(second.parent.parent, new_project)
                self.assertEqual(first.name, 'fixture.exe' if os.name == 'nt' else 'fixture')
                self.assertEqual(second.name, first.name)
                for path, count in ((first, counts[0]), (second, counts[1])):
                    self.assertEqual(path.read_bytes(), expected_bytes(prefix, count))
                new_modes = [mode for path, mode in writes if path.is_relative_to(new_project)]
                self.assertEqual(new_modes, ['xb', 'xb'])
            # Exclusive publication also refuses an existing artifact without
            # truncating it when the retention model is absent.
            with self.assertRaises(FileExistsError):
                with original_open(first, 'xb'):
                    self.fail('Existing fixture was overwritten')
            self.assertEqual(first.read_bytes(), expected_bytes(prefix, counts[0]))
            OBSERVATIONS.update({
                'modeled_legacy_errno': refused.exception.errno,
                'fixed_paths_distinct': True,
                'fixed_parent_directories_distinct': True,
                'publication_modes': new_modes,
                'retained_payloads': [{'count': count, 'bytes': len(path.read_bytes()),
                                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                                      for path, count in ((first, counts[0]), (second, counts[1]))],
                'legacy_first_payload_preserved': True,
                'exclusive_existing_target_refused': True,
                'actual_runtime_bundle_launches': 0,
                'actual_native_sdk_compiler_calls': 0,
                'scope': 'Synthetic inert-prefix bytes and a busy-path open model only; no OS retention cause established.',
            })


if __name__ == '__main__':
    unittest.main()
