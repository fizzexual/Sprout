"""Local adversarial fixtures for distribution and the native JSON boundary.

This is a regression suite, not a security certification. It never contacts a
third-party service; its HTTP fixture listens only on the loopback interface.
"""
import hashlib
import http.server
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import threading
import unittest

BINARY = pathlib.Path(sys.argv.pop(1) if len(sys.argv) > 1 else
                      pathlib.Path(__file__).parents[1] / ('sprout.exe' if os.name == 'nt' else 'sprout')).resolve()


class SecurityBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-boundary-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()

    def put(self, name, content):
        path = self.project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode() if isinstance(content, str) else content)
        return path

    def run_sprout(self, *args, input=None):
        return self.checked(subprocess.run([str(BINARY), *map(str, args)], cwd=self.project,
                              input=input, capture_output=True, timeout=20))

    def checked(self, result):
        for marker in (b'runtime error:', b'ERROR: AddressSanitizer', b'UndefinedBehaviorSanitizer', b'DEADLYSIGNAL'):
            self.assertNotIn(marker, result.stdout + result.stderr,
                             'Sanitizer failure must not masquerade as expected rejection')
        self.assertGreaterEqual(result.returncode, 0, 'Process crashed or was killed by a signal')
        if os.name == 'nt':
            self.assertLess(result.returncode, 0x80000000, 'Windows process failed with NTSTATUS')
        return result

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, repr(result.stdout + result.stderr))

    def add_single(self):
        self.put('vendor/one.sprout', 'public task answer():\n    give 7\n')
        self.assert_ok(self.run_sprout('add', 'vendor/one.sprout', 'one'))

    def serve(self, files):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                content = files.get(self.path)
                if content is None:
                    self.send_error(404)
                else:
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return 'http://127.0.0.1:%s' % server.server_port

    def test_hidden_nul_suffix_in_lock_is_rejected(self):
        self.add_single()
        lock = self.project / 'sprout.lock'
        lock.write_bytes(lock.read_bytes() + b'\0hidden invalid record\n')
        before = lock.read_bytes()
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)
        self.assertEqual(lock.read_bytes(), before)

    def test_hidden_nul_suffix_in_manifest_is_rejected(self):
        self.add_single()
        manifest = self.project / 'sprout.packages'
        manifest.write_bytes(manifest.read_bytes() + b'\0hidden invalid record\n')
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)

    def test_oversized_metadata_is_rejected(self):
        self.add_single()
        lock = self.project / 'sprout.lock'
        with lock.open('ab') as stream:
            stream.write(b'#' + b' ' * (4 << 20))
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)

    def test_add_validates_existing_manifest_before_writing_package(self):
        self.add_single()
        self.put('sprout.packages', 'malformed record with extra fields\n')
        self.put('vendor/two.sprout', 'show 2\n')
        self.assertNotEqual(self.run_sprout('add', 'vendor/two.sprout', 'two').returncode, 0)
        self.assertFalse((self.project / 'sprout_packages/two.sprout').exists())

    def test_case_colliding_remote_files_do_not_overwrite_entry(self):
        base = self.serve({
            '/sprout.package': b'entry main.sprout\nfile MAIN.sprout\n',
            '/main.sprout': b'public task answer():\n    give 7\n',
            '/MAIN.sprout': b'public task answer():\n    give 99\n',
        })
        self.assertNotEqual(self.run_sprout('add', base + '/sprout.package', 'tree').returncode, 0)
        self.assertFalse((self.project / 'sprout_packages/tree').exists())

    def test_case_colliding_names_preserve_existing_package(self):
        self.add_single()
        installed = self.project / 'sprout_packages/one.sprout'
        before = installed.read_bytes()
        self.put('vendor/changed.sprout', 'show 99\n')
        self.assertNotEqual(self.run_sprout('add', 'vendor/changed.sprout', 'ONE').returncode, 0)
        self.assertEqual(installed.read_bytes(), before)

    def test_package_file_and_directory_conflict_is_rejected_before_writes(self):
        self.put('vendor/tree/sprout.package', 'entry main.sprout\nfile asset\nfile asset/item\n')
        self.put('vendor/tree/main.sprout', 'show 1\n')
        base = self.serve({'/sprout.package': (self.project/'vendor/tree/sprout.package').read_bytes(),
                           '/main.sprout': b'show 1\n', '/asset': b'file', '/asset/item': b'child'})
        self.assertNotEqual(self.run_sprout('add', base + '/sprout.package', 'tree').returncode, 0)
        self.assertFalse((self.project / 'sprout_packages/tree').exists())

    def test_dependency_lock_must_match_declared_source(self):
        self.put('vendor/tree/sprout.package', 'entry main.sprout\ndependency dep deps/dep.sprout\n')
        self.put('vendor/tree/main.sprout', 'show 1\n')
        self.put('vendor/tree/deps/dep.sprout', 'show 7\n')
        self.assert_ok(self.run_sprout('add', 'vendor/tree', 'tree'))
        for name in ('sprout.lock', 'sprout.packages'):
            path = self.project / name
            path.write_text(path.read_text().replace('vendor/tree/deps/dep.sprout', 'vendor/other.sprout'))
        self.assertNotEqual(self.run_sprout('install', '--locked').returncode, 0)

    def test_github_dependency_keeps_pinned_commit_without_network_resolution(self):
        # Installed-file fixtures let the offline verification path exercise
        # immutable GitHub source metadata without contacting GitHub.
        self.put('vendor/tree/sprout.package', 'entry main.sprout\ndependency dep deps/dep.sprout\n')
        self.put('vendor/tree/main.sprout', 'show 1\n')
        self.put('vendor/tree/deps/dep.sprout', 'show 7\n')
        self.assert_ok(self.run_sprout('add', 'vendor/tree', 'tree'))
        original_lock = (self.project/'sprout.lock').read_text()
        original_manifest = (self.project/'sprout.packages').read_text()
        locked = 'github:owner/repo@' + 'abcd'*10 + ':dep.sprout'
        for declared, accepted in (( 'github:owner/repo@main:dep.sprout', True),
                                   ( 'github:owner/repo@'+'ABCD'*10+':dep.sprout', True),
                                   ( 'github:owner/other@main:dep.sprout', False),
                                   ( 'github:owner/repo@main:other.sprout', False),
                                   ( 'github:owner/repo@'+'0'*40+':dep.sprout', False)):
            with self.subTest(declared=declared):
                package = ('entry main.sprout\ndependency dep ' + declared + '\n').encode()
                self.put('sprout_packages/tree/sprout.package', package)
                lines = []
                for line in original_lock.splitlines():
                    if not line or line.startswith('#'):
                        lines.append(line)
                        continue
                    fields = line.split()
                    if fields[0] == 'dep':
                        fields[1] = locked
                    if fields[3] == 'sprout_packages/tree/sprout.package':
                        fields[2] = hashlib.sha256(package).hexdigest()
                    lines.append('\t'.join(fields))
                self.put('sprout.lock', '\n'.join(lines)+'\n')
                self.put('sprout.packages', original_manifest.replace('vendor/tree/deps/dep.sprout', locked))
                result = self.run_sprout('install', '--locked')
                if accepted:
                    self.assert_ok(result)
                else:
                    self.assertNotEqual(result.returncode, 0)

    def test_local_package_source_cannot_follow_external_symlink(self):
        self.put('outside/data.sprout', 'show 88\n')
        self.put('vendor/tree/sprout.package', 'entry nested/data.sprout\n')
        link = self.project/'vendor/tree/nested'
        target = self.project/'outside'
        if os.name == 'nt':
            quoted = lambda path: "'" + str(path).replace("'", "''") + "'"
            result = subprocess.run(['powershell', '-NoProfile', '-Command',
                'New-Item -ItemType Junction -Path ' + quoted(link) + ' -Target ' + quoted(target) + ' | Out-Null'],
                capture_output=True, timeout=10)
            if result.returncode:
                self.skipTest('Junction creation is unavailable: ' + result.stderr.decode(errors='replace'))
        else:
            link.symlink_to(target, target_is_directory=True)
        self.assertNotEqual(self.run_sprout('add', 'vendor/tree', 'tree').returncode, 0)
        self.assertFalse((self.project/'sprout_packages/tree').exists())

    def crafted_bundle(self, files, entry=b'app.sprout', *, count=None, trailing=b''):
        files = [(path.encode() if isinstance(path, str) else path, content) for path, content in files]
        archive = struct.pack('<Q', len(entry)) + entry + struct.pack('<Q', len(files) if count is None else count)
        for path, content in files:
            archive += struct.pack('<QQ', len(path), len(content)) + hashlib.sha256(content).digest() + path + content
        archive += trailing
        # Retain each crafted executable; an earlier pathname may still be held.
        fixture_dir = pathlib.Path(tempfile.mkdtemp(prefix='crafted-bundle-', dir=self.project))
        bundle = fixture_dir / ('fixture.exe' if os.name == 'nt' else 'fixture')
        with bundle.open('xb') as stream:
            stream.write(BINARY.read_bytes() + archive + b'SPROUT_BUNDLE_02' + struct.pack('<Q', len(archive)))
        bundle.chmod(0o755)
        return bundle

    def run_bundle(self, bundle):
        return self.checked(subprocess.run([str(bundle)], cwd=self.project, capture_output=True, timeout=20))

    def test_crafted_valid_bundle_runs(self):
        result = self.run_bundle(self.crafted_bundle([(b'app.sprout', b'show 123\n')]))
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), b'123')

    def test_bundle_rejects_portability_aliases_and_prefix_conflicts(self):
        for paths in ((b'A.sprout', b'a.sprout'), (b'asset', b'asset/item')):
            with self.subTest(paths=paths):
                files = sorted([(b'app.sprout', b'show 1\n'), *( (p, b'') for p in paths)])
                self.assertNotEqual(self.run_bundle(self.crafted_bundle(files)).returncode, 0)

    def test_bundle_rejects_traversal_devices_nul_and_invalid_portable_characters(self):
        for path in (b'../escape', b'/absolute', b'C:/drive', b'back\\slash', b'a//b', b'a/./b',
                     b'CON.txt', b'LPT1', b'trailing.', b'trailing ', b'zero\0byte', b'a:b',
                     b'less<than', b'pipe|name', b'question?name'):
            with self.subTest(path=path):
                files = sorted([(b'app.sprout', b'show 1\n'), (path, b'outside')])
                self.assertNotEqual(self.run_bundle(self.crafted_bundle(files)).returncode, 0)
        self.assertFalse((self.root/'escape').exists())

    def test_bundle_rejects_truncation_count_overflow_and_trailing_data(self):
        for count, trailing in ((2**64-1, b''), (2, b''), (1, b'extra')):
            with self.subTest(count=count, trailing=trailing):
                self.assertNotEqual(self.run_bundle(self.crafted_bundle([(b'app.sprout', b'show 1\n')],
                    count=count, trailing=trailing)).returncode, 0)

    def boundary(self, payload):
        self.put('app.sprout', 'show json_encode(json_decode(read_input()))\n')
        return self.run_sprout('run', 'app.sprout', input=payload)

    def test_reserved_singleton_tags_require_text(self):
        for key in ('$sprout.integer', '$sprout.decimal', '$sprout.bytes'):
            for value in (None, False, 23, [], {}):
                with self.subTest(key=key, value=value):
                    self.assertNotEqual(self.boundary(json.dumps({key: value}).encode()).returncode, 0)

    def test_reserved_tags_reject_out_of_range_and_invalid_encodings(self):
        for key, value in (('$sprout.integer', '9223372036854775808'),
                           ('$sprout.integer', '-9223372036854775809'),
                           ('$sprout.integer', '9'*10000), ('$sprout.decimal', '0.0000000000000000001'),
                           ('$sprout.decimal', '1e1'), ('$sprout.bytes', '0'), ('$sprout.bytes', 'gg')):
            with self.subTest(key=key, value=value[:40]):
                self.assertNotEqual(self.boundary(json.dumps({key: value}).encode()).returncode, 0)

    def test_invalid_utf8_never_survives_json_boundary(self):
        for text in (b'\xff', b'\xc0\xaf', b'\xed\xa0\x80', b'\xf4\x90\x80\x80', b'\xe2\x82'):
            with self.subTest(text=text):
                result = self.boundary(b'{"text":"' + text + b'"}')
                self.assert_ok(result)
                self.assertEqual(result.stdout.strip(), b'null')

    def test_duplicate_decoded_keys_are_rejected(self):
        for payload in (b'{"x":1,"x":2}', b'{"x":1,"\\u0078":2}',
                        b'{"$sprout.integer":"1","$sprout.integer":"2"}'):
            with self.subTest(payload=payload):
                result = self.boundary(payload)
                self.assert_ok(result)
                self.assertEqual(result.stdout.strip(), b'null')

    def test_json_writer_rejects_invalid_utf8_values_and_map_keys(self):
        for program in ('show json_encode(char(255))\n',
                        'make data = {}\nset data[char(255)] = 1\nshow json_encode(data)\n'):
            with self.subTest(program=program):
                self.put('app.sprout', program)
                result = self.run_sprout('run', 'app.sprout')
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b'\xff', result.stdout)

    def test_json_writer_rejects_invalid_reserved_singleton_tags(self):
        for key, value in (('$sprout.integer', '23'), ('$sprout.decimal', 'nothing'),
                           ('$sprout.bytes', '[]'), ('$sprout.integer', '"9223372036854775808"'),
                           ('$sprout.bytes', '"gg"')):
            with self.subTest(key=key, value=value):
                self.put('app.sprout', 'make data = {}\nset data[' + json.dumps(key) + '] = ' + value + '\nshow json_encode(data)\n')
                self.assertNotEqual(self.run_sprout('run', 'app.sprout').returncode, 0)
        result = self.boundary(b'{"$sprout.integer":23,"ordinary":true}')
        self.assert_ok(result)
        self.assertEqual(json.loads(result.stdout), {'$sprout.integer': 23, 'ordinary': True})

    def test_legacy_json_keeps_last_key_and_valid_utf8_is_preserved(self):
        self.put('app.sprout', 'show json_encode(json("{\\"x\\":1,\\"x\\":2}"))\n')
        result = self.run_sprout('run', 'app.sprout')
        self.assert_ok(result)
        self.assertEqual(json.loads(result.stdout), {'x': 2})
        payload = {'text': 'π 🌱', 'escaped': '\n\t\r'}
        result = self.boundary(json.dumps(payload, ensure_ascii=False).encode())
        self.assert_ok(result)
        self.assertEqual(json.loads(result.stdout), payload)

    def test_float_outside_int64_can_be_json_encoded_without_invalid_cast(self):
        for payload in (b'1e100', b'-1e100', b'9.223372036854776e18', b'-9.223372036854776e18'):
            with self.subTest(payload=payload):
                result = self.boundary(payload)
                self.assert_ok(result)
                self.assertEqual(json.loads(result.stdout), json.loads(payload))

    def test_float_outside_int64_never_becomes_an_index_count_or_random_bound(self):
        statements = ('show range(huge)', 'show remove([1], huge)', 'insert([1], huge, 2)',
                      'show slice([1], huge, huge)', 'show [1][huge]', 'show "x"[huge]',
                      'show bytes([1])[huge]', 'show [1][huge:huge]', 'show [1] * huge',
                      'show random(huge)', 'show random(0, huge)',
                      'repeat huge times:\n    skip', 'show 0 to huge')
        for statement in statements:
            with self.subTest(statement=statement):
                self.put('app.sprout', 'make huge = json("1e100")\n' + statement + '\n')
                result = self.run_sprout('run', 'app.sprout', '--max-steps', '1000')
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b'runtime error:', result.stderr)

    def test_safe_float_int64_boundaries_do_not_wrap_ranges_or_random_span(self):
        self.put('app.sprout', '''make lo = json("-9.223372036854775808e18")
make hi = json("9.223372036854774784e18")
show range(lo, lo)
show range(hi, hi)
show slice([1], lo, 1)
''')
        result = self.run_sprout('run', 'app.sprout')
        self.assert_ok(result)
        self.assertEqual(result.stdout.splitlines(), [b'[]', b'[]', b'[1]'])
        self.put('app.sprout', 'show random(json("-9.223372036854775808e18"), json("9.223372036854774784e18"))\n')
        result = self.run_sprout('run', 'app.sprout')
        self.assert_ok(result)
        number = float(result.stdout)
        self.assertGreaterEqual(number, -9223372036854775808)
        self.assertLessEqual(number, 9223372036854774784)
        self.assertNotIn(b'runtime error:', result.stderr)

    def test_exact_limits_and_binary_data_round_trip(self):
        for key, text in (('$sprout.integer', '-9223372036854775808'),
                          ('$sprout.integer', '9223372036854775807'),
                          ('$sprout.decimal', '-9.223372036854775808'),
                          ('$sprout.bytes', '0001ff0080')):
            with self.subTest(key=key):
                payload = {key: text}
                result = self.boundary(json.dumps(payload).encode())
                self.assert_ok(result)
                self.assertEqual(json.loads(result.stdout), payload)

    def test_exact_overflow_is_catchable_without_undefined_arithmetic(self):
        program = '''test "exact adversarial boundaries":
    expect error "math":
        show integer("-9223372036854775808") / integer("-1")
    expect error "math":
        show integer("9223372036854775807") * integer("9223372036854775807")
    expect error "math":
        show decimal("9.223372036854775807") + integer("9223372036854775807")
    expect error "math":
        show decimal_div(integer("9223372036854775807"), decimal("0.000000000000000001"), 18)
    expect integer("-9223372036854775808") % integer("-1") == 0
'''
        self.put('exact.sprout', program)
        self.assert_ok(self.run_sprout('test', 'exact.sprout'))


if __name__ == '__main__':
    unittest.main()
