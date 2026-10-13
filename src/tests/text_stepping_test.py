"""Required finite UTF-8 stepping controls, using an explicitly trusted native.

One separately attributed minimal helper build, then normal6/actualGC6/helper16.
No implicit executable, version/metadata probe, retry or original-runtime run.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE_CAP = 16777216
SOURCE_TOTAL = 67108864
EXECUTABLE_CAP = 281018368
HELPER_CANONICAL_SHA = '57d8d89038744efeddb52443103343c21255b85ff8b87f4cc8f15886f12397ce'
OLD_NATIVE = '154415bb5fc64ae0ddcb6a57e2ad4c6a245ee1df1541be1e35a74bbd261e4f05'
NATIVE_INPUTS = ('binary_values.h', 'distribution_bundle.h', 'distribution_common.h', 'distribution_packages.h',
                 'embed.c', 'embed.h', 'ergonomics_calls.h', 'ergonomics_format.h', 'ergonomics_parser.h',
                 'exact_numeric.h', 'parallel_runtime.h', 'process_native.h', 'runtime_foundation.h',
                 'sprout.c', 'sqlite.inc', 'stdlib.inc', 'vendor/sqlite/sqlite3.c', 'vendor/sqlite/sqlite3.h', 'workflow_runtime.h')
EXTRA_INPUTS = ('src/tests/text_stepping_test.py', 'src/tests/text_stepping_test.sprout',
                'src/tests/text_step_harness.c', 'src/tests/gc_env_roots_test.py')
CSI = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
SANITIZER = (b'AddressSanitizer', b'UndefinedBehaviorSanitizer', b'runtime error:', b'DEADLYSIGNAL')
STEP_DEFINITION = b'''static int utf8_step_terminated(const char *p) {
  int nominal = utf8_clen((unsigned char)p[0]);
  int actual = 0;
  while (actual < nominal && p[actual]) actual++;
  return actual;
}'''
STEP_USES = ((b'i += utf8_step_terminated(p + i)) c++;', 1),
             (b'p += utf8_step_terminated(p); ci++;', 1),
             (b'j += utf8_step_terminated(p + j)) n++;', 2),
             (b'for (int j = 0; p[j]; ) { int cl = utf8_step_terminated(p + j);', 1))


def file_identity(path, cap, expected_size=None, text=False):
    """Bound opened regular-file reads to the credited size, before hashing."""
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > cap:
        raise ValueError('Expected bounded regular file: ' + str(path))
    if expected_size is not None and (type(expected_size) is not int or before.st_size != expected_size):
        raise ValueError('Credited file size changed: ' + str(path))
    digest = hashlib.sha256(); chunks = [] if text else None
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != before.st_size:
            raise ValueError('Opened file identity/size changed')
        remaining = opened.st_size
        while remaining:
            block = stream.read(min(65536, remaining))
            if not block: raise ValueError('File shortened while hashing')
            digest.update(block); remaining -= len(block)
            if text: chunks.append(block)
        if os.fstat(stream.fileno()).st_size != opened.st_size:
            raise ValueError('File grew while hashing')
    value = {'path': str(path.resolve()), 'bytes': before.st_size, 'raw_sha256': digest.hexdigest()}
    canonical = None
    if text:
        canonical = b''.join(chunks).decode('utf-8', 'strict').replace('\r\n', '\n').encode('utf-8')
        value['canonical_utf8_lf_sha256'] = hashlib.sha256(canonical).hexdigest()
    return value, canonical


def source_inventory():
    records = {}; total = 0; core = None
    for name in [*('src/' + value for value in NATIVE_INPUTS), *EXTRA_INPUTS]:
        info, canonical = file_identity(ROOT / name, min(SOURCE_CAP, SOURCE_TOTAL - total), text=True)
        total += info['bytes']; records[name] = info
        if name == 'src/sprout.c': core = canonical
    if core.count(STEP_DEFINITION) != 1 or any(core.count(token) != count for token, count in STEP_USES):
        raise ValueError('Checked-out source lacks the reviewed terminator-aware five-site correction')
    if records['src/tests/gc_env_roots_test.py']['canonical_utf8_lf_sha256'] != HELPER_CANONICAL_SHA:
        raise ValueError('Bounded helper source differs from the reviewed supervisor')
    return records


def compiler_selection():
    compiler = os.environ.get('SPROUT_TEXT_STEP_CC') or shutil.which('cc') or shutil.which('gcc')
    if not compiler: raise RuntimeError('Required text stepping controls need a trusted SPROUT_TEXT_STEP_CC or cc/gcc; not skipped.')
    resolved = shutil.which(compiler)
    if not resolved: raise RuntimeError('Trusted text-step compiler was not found')
    raw_flags = os.environ.get('SPROUT_TEXT_STEP_CFLAGS', '-O2 -Wall')
    if len(raw_flags) > 4096: raise ValueError('Trusted compiler flags exceed4096 characters')
    return Path(resolved).resolve(), shlex.split(raw_flags)


def bounded_helper():
    path = ROOT / 'src/tests/gc_env_roots_test.py'
    saved_argv, saved_bytecode = sys.argv, sys.dont_write_bytecode
    name = '_text_step_bounded_helper'; previous = sys.modules.get(name)
    try:
        sys.argv = [str(path)]; sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module
        spec.loader.exec_module(module)
    finally:
        sys.argv, sys.dont_write_bytecode = saved_argv, saved_bytecode
        if previous is None: sys.modules.pop(name, None)
        else: sys.modules[name] = previous
    if Path(module.__file__).resolve() != path.resolve(): raise ValueError('Loaded helper path differs')
    module.CAPTURE_BYTES = 32768
    return module


def unique_json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError('Duplicate decoded JSON key')
            value[key] = item
        return value
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def strict_equal(actual, expected):
    if type(actual) is not type(expected): return False
    if type(expected) is dict:
        return actual.keys() == expected.keys() and all(strict_equal(actual[key], value) for key, value in expected.items())
    if type(expected) is list:
        return len(actual) == len(expected) and all(strict_equal(a, b) for a, b in zip(actual, expected))
    return actual == expected


def verify_shared_output(stdout):
    clean = CSI.sub(b'', stdout)
    if any(int(count) for count in re.findall(rb'\b(\d+)[ \t]+failed\b', clean)):
        raise ValueError('Shared output reports nonzero failures')
    summaries = re.findall(rb'(?m)^\s*(\d+) passed(?:,\s*(\d+) failed)?\s*$', clean)
    if len(summaries) != 1 or int(summaries[0][0]) != 6 or int(summaries[0][1] or b'0') != 0:
        raise ValueError('Expected exactly one complete6-passed/0-failed summary')


def verify_helper_output(stdout):
    if not stdout.endswith(b'\n') or len(stdout.splitlines()) != 1:
        raise ValueError('Helper must emit one complete physical JSON line')
    if not strict_equal(unique_json(stdout), {'ok': True, 'cases': 16, 'groups': 15}):
        raise ValueError('Complete typed helper16 oracle differs')


def diagnostic(error):
    return {'type': type(error).__name__, 'message': str(error)[:512]}


def latch(result, error):
    if result['primary_error'] is None: result['primary_error'] = diagnostic(error)
    result['passed'] = False


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes((json.dumps(value, ensure_ascii=True, indent=2, allow_nan=False) + '\n').encode('utf-8'))
    os.replace(temporary, path)


def persist(result, report):
    try: write_json(report / 'result.json', result)
    except Exception as error:
        result['finalization_errors'].append(diagnostic(error)); latch(result, error)
        try: sys.stderr.write(json.dumps({'primary_error': result['primary_error'], 'finalization_error': result['finalization_errors'][-1]}, ensure_ascii=True)[:2048] + '\n')
        except Exception as sink_error: result['finalization_errors'].append(diagnostic(sink_error))


def validate_completion(label, completed):
    if completed.capture_errors: raise RuntimeError('Capture failed: ' + repr(completed.capture_errors)[:512])
    if completed.cleanup_errors: raise RuntimeError('Owned direct cleanup unconfirmed: ' + repr(completed.cleanup_errors)[:512])
    if completed.returncode != 0: raise RuntimeError(label + ' exited nonzero or crashed')
    if any(marker in completed.stdout + completed.stderr for marker in SANITIZER): raise RuntimeError('Sanitizer diagnostic')
    if label == 'compile': return
    if completed.stderr: raise ValueError('Unexpected payload stderr')
    if label == 'helper16': verify_helper_output(completed.stdout)
    else: verify_shared_output(completed.stdout)


def retain_completion(result, observation, completed, report):
    observation.update({'status_known': True, 'exit': completed.returncode,
                        'capture_errors': list(completed.capture_errors), 'cleanup_errors': list(completed.cleanup_errors),
                        'stdout_bytes': len(completed.stdout), 'stderr_bytes': len(completed.stderr),
                        'stdout_sha256': hashlib.sha256(completed.stdout).hexdigest(),
                        'stderr_sha256': hashlib.sha256(completed.stderr).hexdigest(), 'artifact_errors': []})
    try: validate_completion(observation['label'], completed)
    except BaseException as error: latch(result, error)
    for suffix, data in [('stdout.bin', completed.stdout), ('stderr.bin', completed.stderr)]:
        name = observation['label'] + '.' + suffix
        try: (report / name).write_bytes(data)
        except Exception as error:
            note = {'artifact': name, **diagnostic(error)}
            observation['artifact_errors'].append(note); result['artifact_errors'].append(note); latch(result, error)
    observation['accepted'] = result['primary_error'] is None


def postflight(result, original_sources, selections, fixture_binary):
    try:
        if source_inventory() != original_sources: raise ValueError('Source/include/loaded-helper identities changed')
        for role, before in selections.items():
            current, _ = file_identity(Path(before['path']), EXECUTABLE_CAP, before['bytes'])
            if current != before: raise ValueError(role + ' identity changed')
        if fixture_binary is not None:
            current, _ = file_identity(Path(fixture_binary['path']), EXECUTABLE_CAP, fixture_binary['bytes'])
            if current != fixture_binary: raise ValueError('Compiled fixture identity changed')
    except BaseException as error:
        result['postflight_errors'].append(diagnostic(error)); latch(result, error)


def run_profile(binary, report_dir=None):
    # Explicit trust/admission is before helper import, report creation or dispatch.
    if 'SPROUT_GC_STRESS' in os.environ or 'SPROUT_SANDBOX' in os.environ:
        raise ValueError('Parent GC/sandbox presence is forbidden; the profile owns both modes')
    sources = source_inventory()
    native, _ = file_identity(Path(binary).resolve(), EXECUTABLE_CAP)
    if native['raw_sha256'] == OLD_NATIVE: raise ValueError('The preserved original runtime must not run these unsafe legacy paths')
    compiler, flags = compiler_selection()
    compiler_info, _ = file_identity(compiler, EXECUTABLE_CAP)
    host, _ = file_identity(Path(sys.executable).resolve(), EXECUTABLE_CAP)
    selections = {'native': native, 'compiler': compiler_info, 'host': host}
    if report_dir is None:
        report = Path(tempfile.mkdtemp(prefix='sprout-text-stepping-retained-')).resolve()
    else:
        report = Path(report_dir).resolve(); report.mkdir(parents=True, exist_ok=False)
    result = {'schema': 'sprout.text-stepping.profile.v1', 'passed': False, 'retries': 0,
              'primary_error': None, 'artifact_errors': [], 'postflight_errors': [], 'finalization_errors': [],
              'source_inventory': sources, 'selections': selections, 'compiler_flags': flags,
              'build_profile': 'Separate minimal C inclusion fixture; not the selected full-SQLite native image or capability profile',
              'observations': [], 'fixture_binary': None, 'compiler_invocations_reserved': 0, 'payload_invocations_reserved': 0}
    fixture_binary = None
    try:
        write_json(report / 'once-started.json', {'schema': 1, 'profile': result['schema']})
        persist(result, report)
        if result['primary_error'] is not None: raise RuntimeError('Preflight report publication failed')
        helper = bounded_helper()
        target = report / ('text-step-helper.exe' if os.name == 'nt' else 'text-step-helper')
        argv = [str(compiler), *flags, '-I', str(ROOT / 'src'), '-o', str(target), str(ROOT / 'src/tests/text_step_harness.c'), '-lm']
        argv += ['-Wl,--stack,67108864', '-lurlmon'] if os.name == 'nt' else ['-pthread', '-ldl']
        phases = [('compile', argv, 90, False),
                  ('shared-normal', [native['path'], 'test', str(ROOT / 'src/tests/text_stepping_test.sprout'), '--max-steps', '5000000', '--timeout-ms', '3000'], 5, False),
                  ('shared-actual-gc', [native['path'], 'test', str(ROOT / 'src/tests/text_stepping_test.sprout'), '--max-steps', '5000000', '--timeout-ms', '3000'], 5, True),
                  ('helper16', [str(target)], 5, False)]
        for label, argv, timeout, stress in phases:
            observation = {'label': label, 'argv': argv, 'timeout_seconds': timeout, 'gc_stress_environment': stress,
                           'reserved': True, 'accepted': False, 'exit': None}
            result['observations'].append(observation)
            key = 'compiler_invocations_reserved' if label == 'compile' else 'payload_invocations_reserved'
            result[key] += 1; persist(result, report)
            if result['primary_error'] is not None: break
            env = dict(os.environ); env.pop('SPROUT_GC_STRESS', None); env.pop('SPROUT_SANDBOX', None)
            if stress: env['SPROUT_GC_STRESS'] = '1'
            completed = helper.bounded_process(argv, cwd=ROOT, data=None, timeout=timeout, env=env)
            retain_completion(result, observation, completed, report)
            if label == 'compile' and result['primary_error'] is None:
                fixture_binary, _ = file_identity(target, EXECUTABLE_CAP)
                result['fixture_binary'] = fixture_binary
            persist(result, report)
            if result['primary_error'] is not None: break
    except BaseException as error:
        latch(result, error)
    finally:
        postflight(result, sources, selections, fixture_binary)
        if result['primary_error'] is None and len(result['observations']) == 4 and all(item['accepted'] for item in result['observations']):
            result['passed'] = True
        persist(result, report)
    if result['passed'] and not result['finalization_errors']:
        try: write_json(report / 'passed.json', {'schema': 1, 'compiler_calls': 1, 'payload_calls': 3})
        except Exception as error:
            result['finalization_errors'].append(diagnostic(error)); latch(result, error); persist(result, report)
    print('Text stepping report: ' + str(report))
    if not result['passed']: raise AssertionError('First text-stepping failure retained: ' + repr(result['primary_error']))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', help='Explicitly trusted newly built Sprout native from this reviewed checkout')
    parser.add_argument('--report-dir', help='Fresh exclusive output directory; omitted retains a named temporary report')
    args = parser.parse_args(argv)
    run_profile(args.binary, args.report_dir)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
