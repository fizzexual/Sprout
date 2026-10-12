"""Compiled metadata controls. Models do not qualify a native/WASM build."""
import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else
              os.environ.get('SPROUT_BINARY', ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout'))).resolve()
FEATURES = {'intrinsic_calls_v1', 'sqlite_adapter_v1', 'native_processes_v1', 'http_request_v1', 'workflow_plan_v1', 'workflow_run_v1'}
MACROS = ('__EMSCRIPTEN__', '_WIN32', '__APPLE__', '__MACH__', '__linux__', '__wasm64__', '__wasm32__',
          '_M_X64', '__x86_64__', '_M_IX86', '__i386__', '_M_ARM64', '__aarch64__', '_M_ARM', '__arm__', 'SPROUT_SQLITE')
C_NEWLINE = b'\r\n' if os.name == 'nt' else b'\n'


def bounded_helper():
    saved = sys.argv
    try:
        sys.argv = [__file__]
        spec = importlib.util.spec_from_file_location('metadata_bounded_driver', ROOT / 'src/tests/gc_env_roots_test.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module.bounded_process
    finally: sys.argv = saved


def query_source(data):
    """Copy helper/guard tokens with CRLF normalization; reject later dispatch."""
    data.decode('utf-8', 'strict')
    data = data.replace(b'\r\n', b'\n')
    start = b'static int compiled_capabilities_json(void) {'
    main = b'int main(int argc, char **argv) {\n#ifdef _WIN32\n  if (!windows_utf8_arguments(&argc, &argv)) return 2;\n#endif\n'
    if data.count(start) != 1 or data.count(main) != 1: raise ValueError('metadata boundary changed')
    helper_at = data.index(start); main_at = data.index(main)
    if helper_at >= main_at: raise ValueError('helper placement changed')
    helper = data[helper_at:main_at]
    guard = b'  if (argc > 1 && !strcmp(argv[1], "--capabilities-json")) {\n    if (argc != 2) { fputs("Usage: sprout --capabilities-json\\n", stderr); return 2; }\n    return compiled_capabilities_json();\n  }\n'
    if not data[main_at+len(main):].startswith(guard): raise ValueError('query is no longer before runtime initialization')
    return helper, guard


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate metadata key')
        result[key] = value
    return result


def decode_metadata(raw):
    if len(raw) > 1024 or b'\0' in raw or not raw.endswith(b'\n'): raise ValueError('metadata bound/termination')
    text = raw.decode('ascii', 'strict')
    if len(text.splitlines()) != 1: raise ValueError('metadata must be one line')
    def invalid_constant(value): raise ValueError('nonfinite metadata constant')
    def finite_number(value):
        result = float(value)
        if not math.isfinite(result): raise ValueError('nonfinite metadata number')
        return result
    data = json.loads(text, object_pairs_hook=strict_object, parse_constant=invalid_constant, parse_float=finite_number)
    if type(data) is not dict or set(data) != {'schema', 'runtime', 'features', 'http_transport', 'host_library'}: raise ValueError('metadata fields')
    if type(data['schema']) is not int or data['schema'] != 1: raise ValueError('metadata schema')
    if type(data['runtime']) is not dict or set(data['runtime']) != {'kind', 'os', 'arch'}: raise ValueError('target fields')
    if type(data['runtime']['kind']) is not str or data['runtime']['kind'] not in ('native', 'wasm'): raise ValueError('target kind')
    if type(data['runtime']['os']) is not str or data['runtime']['os'] not in ('windows', 'darwin', 'linux', 'emscripten', 'unknown'): raise ValueError('target OS family')
    if type(data['runtime']['arch']) is not str or data['runtime']['arch'] not in ('x86_64', 'x86', 'aarch64', 'arm32', 'wasm32', 'wasm64', 'unknown'): raise ValueError('target arch')
    if type(data['features']) is not dict or set(data['features']) != FEATURES or any(type(value) is not bool for value in data['features'].values()): raise ValueError('feature values')
    if data['features']['intrinsic_calls_v1'] is not True or data['features']['workflow_plan_v1'] is not True: raise ValueError('pure compiled flags')
    if type(data['host_library']) is not dict or set(data['host_library']) != {'included', 'abi_version'} or data['host_library']['included'] is not False or data['host_library']['abi_version'] is not None: raise ValueError('interpreter host ABI claim')
    transport = data['http_transport']
    if type(transport) is not dict or set(transport) != {'operation', 'kind', 'requires_external_tool'} or type(transport['operation']) is not str or transport['operation'] != 'http_request_v1': raise ValueError('transport fields')
    native = data['runtime']['kind'] == 'native'
    family, arch = data['runtime']['os'], data['runtime']['arch']
    if native:
        if family == 'emscripten' or arch in ('wasm32', 'wasm64'): raise ValueError('native target mismatch')
    elif family != 'emscripten' or arch not in ('wasm32', 'wasm64', 'unknown'):
        raise ValueError('WASM target mismatch')
    if any(data['features'][name] is not native for name in ('native_processes_v1', 'http_request_v1', 'workflow_run_v1')): raise ValueError('target operation mismatch')
    expected_kind, expected_tool = ('unavailable', None) if not native else ('winhttp', None) if family == 'windows' else ('curl', 'curl')
    if type(transport['kind']) is not str or transport['kind'] != expected_kind: raise ValueError('target transport mismatch')
    if expected_tool is None:
        if transport['requires_external_tool'] is not None: raise ValueError('transport tool must be null')
    elif type(transport['requires_external_tool']) is not str or transport['requires_external_tool'] != expected_tool:
        raise ValueError('transport tool mismatch')
    return data


class MetadataDecoder(unittest.TestCase):
    """Pure schema controls: no compiler, process or test-class setup."""
    @staticmethod
    def record(kind='native', family='linux', arch='x86_64', sqlite=True):
        native = kind == 'native'
        transport, tool = ('unavailable', None) if not native else ('winhttp', None) if family == 'windows' else ('curl', 'curl')
        return {'schema': 1, 'runtime': {'kind': kind, 'os': family, 'arch': arch},
                'features': {'intrinsic_calls_v1': True, 'sqlite_adapter_v1': sqlite,
                             'native_processes_v1': native, 'http_request_v1': native,
                             'workflow_plan_v1': True, 'workflow_run_v1': native},
                'http_transport': {'operation': 'http_request_v1', 'kind': transport, 'requires_external_tool': tool},
                'host_library': {'included': False, 'abi_version': None}}

    @staticmethod
    def encoded(record):
        return json.dumps(record, ensure_ascii=True, separators=(',', ':')).encode('ascii') + b'\n'

    def test_supported_records_include_wasm_sqlite_definedness(self):
        for record in [self.record(), self.record(family='windows'), self.record(family='darwin', arch='aarch64', sqlite=False),
                       self.record(family='unknown', arch='unknown'), self.record('wasm', 'emscripten', 'wasm32', False),
                       self.record('wasm', 'emscripten', 'wasm64', True), self.record('wasm', 'emscripten', 'unknown', True)]:
            for ending in (b'\n', b'\r\n'):
                with self.subTest(record=record, ending=ending):
                    self.assertEqual(decode_metadata(self.encoded(record)[:-1] + ending), record)

    def test_wrong_types_fields_and_cross_target_records_are_rejected(self):
        base = self.record()
        changes = [(['schema'], True), (['runtime'], None), (['features'], []), (['host_library'], False),
                   (['http_transport'], []), (['runtime', 'kind'], 1), (['runtime', 'os'], True),
                   (['runtime', 'arch'], ['x86_64']), (['runtime', 'os'], 'emscripten'),
                   (['runtime', 'arch'], 'wasm32'), (['features', 'sqlite_adapter_v1'], 1),
                   (['features', 'native_processes_v1'], False), (['features', 'http_request_v1'], False),
                   (['features', 'workflow_run_v1'], False), (['features', 'intrinsic_calls_v1'], False),
                   (['features', 'workflow_plan_v1'], False), (['host_library', 'included'], 0),
                   (['host_library', 'abi_version'], 1), (['http_transport', 'kind'], 'garbage'),
                   (['http_transport', 'kind'], 'unavailable'), (['http_transport', 'kind'], 'winhttp'),
                   (['http_transport', 'requires_external_tool'], True), (['http_transport', 'requires_external_tool'], None),
                   (['http_transport', 'requires_external_tool'], float('nan')), (['http_transport', 'requires_external_tool'], float('inf')),
                   (['http_transport', 'operation'], 'http_get')]
        for path, value in changes:
            record = copy.deepcopy(base); parent = record
            for key in path[:-1]: parent = parent[key]
            parent[path[-1]] = value
            with self.subTest(path=path, value=value), self.assertRaises(ValueError): decode_metadata(self.encoded(record))
        for record in [self.record('wasm', 'linux', 'wasm32'), self.record('wasm', 'emscripten', 'x86_64'),
                       self.record(family='windows'), self.record('wasm', 'emscripten', 'wasm32')]:
            record['http_transport']['requires_external_tool'] = 'curl'
            with self.subTest(record=record), self.assertRaises(ValueError): decode_metadata(self.encoded(record))
        wasm = self.record('wasm', 'emscripten', 'wasm32'); wasm['features']['workflow_run_v1'] = True
        with self.assertRaises(ValueError): decode_metadata(self.encoded(wasm))
        for key in ('runtime', 'features', 'http_transport', 'host_library'):
            record = copy.deepcopy(base); record[key]['extra'] = 'unknown'
            with self.subTest(extra=key), self.assertRaises(ValueError): decode_metadata(self.encoded(record))

    def test_framing_duplicates_and_nonfinite_literals_are_rejected(self):
        raw = self.encoded(self.record())
        for invalid in [b'', b'null\n', b'[]\n', raw[:-1], raw + b'{}\n', b' ' * 1025 + raw,
                        raw.replace(b'linux', b'\xff'), raw.replace(b'linux', b'lin\0ux'),
                        raw.replace(b'"schema":1', b'"schema":1,"\\u0073chema":1'),
                        raw.replace(b'"requires_external_tool":"curl"', b'"requires_external_tool":1e999')]:
            with self.subTest(raw=invalid[:100]), self.assertRaises(ValueError): decode_metadata(invalid)


class MetadataModels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get('SPROUT_CAPABILITIES_CC') or shutil.which('cc') or shutil.which('gcc')
        if not compiler: raise RuntimeError('Required metadata models need SPROUT_CAPABILITIES_CC or trusted cc/gcc.')
        cls.capture = staticmethod(bounded_helper())
        cls.temp = tempfile.TemporaryDirectory(prefix='sprout-capability-model-'); cls.addClassCleanup(cls.temp.cleanup)
        cls.directory = Path(cls.temp.name)
        helper, guard = query_source((ROOT / 'src/sprout.c').read_bytes())
        cls.profiles = {
            'windows-full': ({'_WIN32': 1, '_M_X64': 1, 'SPROUT_SQLITE': 1}, 'native', 'windows', 'x86_64', True),
            'darwin-minimal': ({'__APPLE__': 1, '__MACH__': 1, '__aarch64__': 1}, 'native', 'darwin', 'aarch64', False),
            'linux-full': ({'__linux__': 1, '__x86_64__': 1, 'SPROUT_SQLITE': 1}, 'native', 'linux', 'x86_64', True),
            'unknown-minimal': ({}, 'native', 'unknown', 'unknown', False),
            'wasm32': ({'__EMSCRIPTEN__': 1, '__wasm32__': 1}, 'wasm', 'emscripten', 'wasm32', False),
            'wasm64-defined-zero': ({'__EMSCRIPTEN__': 1, '__wasm64__': 1, 'SPROUT_SQLITE': 0}, 'wasm', 'emscripten', 'wasm64', True),
        }
        cls.binaries = {}
        preamble = b'''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static size_t review_write(const void *p,size_t item,size_t count,FILE *stream) {
  if(getenv("SPROUT_REVIEW_WRITE_FAIL"))return count?count-1:0;
  return fwrite(p,item,count,stream);
}
static int review_flush(FILE *stream) {
  if(getenv("SPROUT_REVIEW_FLUSH_FAIL"))return EOF;
  return fflush(stream);
}
#define fwrite review_write
#define fflush review_flush
'''
        for name, (defines, _, _, _, _) in cls.profiles.items():
            # System headers are included first; fake target flags model only the
            # exact helper/guard, never change libc ABI or pretend to be WASM.
            selection = ''.join('#undef ' + macro + '\n' for macro in MACROS)
            selection += ''.join('#define ' + macro + ' ' + str(value) + '\n' for macro, value in defines.items())
            source = cls.directory / (name + '.c')
            source.write_bytes(preamble + selection.encode('ascii') + helper + b'int main(int argc,char **argv) {\n' + guard + b'  fputs("APPLICATION-RAN\\n",stdout);return 0;\n}\n')
            binary = cls.directory / (name + ('.exe' if os.name == 'nt' else '.out'))
            argv = [compiler, *shlex.split(os.environ.get('SPROUT_CAPABILITIES_CFLAGS', '-O2 -Wall')), '-o', str(binary), str(source)]
            built = cls.capture(argv, cwd=cls.directory, timeout=30, env=dict(os.environ))
            if built.returncode or built.capture_errors or built.cleanup_errors:
                raise AssertionError('Metadata model compile failed: ' + repr((built.returncode, built.capture_errors, built.cleanup_errors)) + '\n' + built.stderr.decode('utf-8', 'replace'))
            cls.binaries[name] = binary

    def run_model(self, name, args, env=None):
        result = self.capture([str(self.binaries[name]), *args], cwd=self.directory, timeout=5, env={**os.environ, **(env or {})})
        self.assertEqual((result.capture_errors, result.cleanup_errors), ((), ()))
        return result

    def test_target_and_feature_selections_match_actual_source_branches(self):
        for name, (_, kind, family, arch, sqlite) in self.profiles.items():
            with self.subTest(profile=name):
                result = self.run_model(name, ['--capabilities-json'])
                self.assertEqual((result.returncode, result.stderr), (0, b''))
                data = decode_metadata(result.stdout)
                self.assertEqual(data['runtime'], {'kind': kind, 'os': family, 'arch': arch})
                self.assertEqual(data['features']['sqlite_adapter_v1'], sqlite)
                for field in ('native_processes_v1', 'http_request_v1', 'workflow_run_v1'):
                    self.assertEqual(data['features'][field], kind == 'native')
                expected_transport = ('unavailable', None) if kind == 'wasm' else ('winhttp', None) if family == 'windows' else ('curl', 'curl')
                self.assertEqual((data['http_transport']['kind'], data['http_transport']['requires_external_tool']), expected_transport)

    def test_exact_first_argument_and_extra_rejection(self):
        for args in [['--capabilities-json', 'extra'], ['--capabilities-json', '--'], ['--capabilities-json', '--sandbox']]:
            result = self.run_model('linux-full', args)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, b'', b'Usage: sprout --capabilities-json' + C_NEWLINE))
        for args in [['capabilities'], ['--', '--capabilities-json'], ['run', '--capabilities-json']]:
            result = self.run_model('linux-full', args)
            self.assertEqual(result.returncode, 0); self.assertEqual(result.stdout, b'APPLICATION-RAN' + C_NEWLINE)

    def test_partial_write_or_flush_refusal_never_returns_success(self):
        for name in ('SPROUT_REVIEW_WRITE_FAIL', 'SPROUT_REVIEW_FLUSH_FAIL'):
            result = self.run_model('linux-full', ['--capabilities-json'], {name: '1'})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b'Could not write capabilities JSON.' + C_NEWLINE)


class NativeMetadata(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.capture = staticmethod(bounded_helper())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sprout-capability-native-'); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def run_native(self, args, env=None, binary=None, trusted_io=False):
        child_env = {**os.environ, **(env or {})}
        if trusted_io: child_env.pop('SPROUT_SANDBOX', None)
        result = self.capture([str(binary or BINARY), *map(str, args)], cwd=self.directory, timeout=5, env=child_env)
        self.assertEqual((result.capture_errors, result.cleanup_errors), ((), ()))
        return result

    def test_real_query_schema_and_explicit_build_profile(self):
        result = self.run_native(['--capabilities-json'])
        self.assertEqual((result.returncode, result.stderr), (0, b''))
        data = decode_metadata(result.stdout)
        self.assertEqual(data['runtime']['kind'], 'native')
        expected = os.environ.get('SPROUT_CAPABILITIES_EXPECT_SQLITE', '1')
        self.assertIn(expected, ('0', '1'), 'explicit build profile must be0/1')
        self.assertEqual(data['features']['sqlite_adapter_v1'], expected == '1')
        for field in ('native_processes_v1', 'http_request_v1', 'workflow_run_v1'): self.assertIs(data['features'][field], True)
        family = 'windows' if os.name == 'nt' else 'darwin' if sys.platform == 'darwin' else 'linux' if sys.platform.startswith('linux') else 'unknown'
        self.assertEqual(data['runtime']['os'], family)

    def test_query_independent_of_runtime_flags_and_project_content(self):
        (self.directory / 'sprout.toml').write_bytes(b'not valid configuration\xff')
        result = self.run_native(['--capabilities-json'], {'SPROUT_SANDBOX': '1', 'SPROUT_GC_STRESS': '1', 'SPROUT_MAX_STEPS': 'invalid', 'SPROUT_TIMEOUT_MS': 'invalid'})
        self.assertEqual((result.returncode, result.stderr), (0, b'')); decode_metadata(result.stdout)
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ['sprout.toml'])
        for args in [['--capabilities-json', 'extra'], ['--capabilities-json', '--sandbox'], ['--capabilities-json', '--']]:
            result = self.run_native(args)
            self.assertEqual(result.returncode, 2); self.assertEqual(result.stdout, b'')
            self.assertEqual(result.stderr, b'Usage: sprout --capabilities-json\r\n' if os.name == 'nt' else b'Usage: sprout --capabilities-json\n')

    def test_normal_program_forwarding_keeps_metadata_flag_literal(self):
        program = self.directory / 'args.sprout'
        program.write_text('show builtin::json_encode(builtin::args())\n', encoding='utf-8')
        result = self.run_native(['run', program, '--', '--capabilities-json'])
        self.assertEqual((result.returncode, result.stderr), (0, b''))
        self.assertEqual(json.loads(result.stdout), ['--capabilities-json'])

    def test_real_bundle_query_skips_payload_and_assets(self):
        marker = self.directory / 'payload-marker.txt'; program = self.directory / 'main.sprout'
        quoted = json.dumps(marker.as_posix(), ensure_ascii=True)
        program.write_text('builtin::file_write(' + quoted + ', "ran")\nshow "BUNDLE-RAN"\nshow builtin::json_encode(builtin::args())\n', encoding='utf-8')
        (self.directory / 'asset.txt').write_text('DECLARED-ASSET', encoding='utf-8')
        (self.directory / 'sprout.toml').write_text('name = "caps-fixture"\nmain = "main.sprout"\nassets = ["asset.txt"]\n', encoding='utf-8')
        bundle = self.directory / ('bundle.exe' if os.name == 'nt' else 'bundle.out')
        result = self.run_native(['bundle', program, '-o', bundle], trusted_io=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        # An invalid extraction root cannot block metadata: the query must not
        # open a footer or attempt extraction. This path is only a local fixture.
        invalid = self.directory / 'not-a-directory'; invalid.write_bytes(b'unchanged')
        result = self.run_native(['--capabilities-json'], {'TMPDIR': str(invalid), 'TMP': str(invalid), 'TEMP': str(invalid)}, bundle)
        self.assertEqual((result.returncode, result.stderr), (0, b'')); decode_metadata(result.stdout)
        self.assertFalse(marker.exists()); self.assertEqual(invalid.read_bytes(), b'unchanged')
        result = self.run_native(['capabilities'], binary=bundle, trusted_io=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(marker.read_bytes(), b'ran')
        self.assertEqual(result.stdout.splitlines(), [b'BUNDLE-RAN', b'["capabilities"]'])


if __name__ == '__main__': unittest.main()
