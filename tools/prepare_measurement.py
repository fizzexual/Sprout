"""Create a new pinned snapshot from explicit local inputs. Never execute or compile."""
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import json
from pathlib import Path

import measure_workloads as m
from measurement_fixtures import compact, fixtures, prepared_source, sdk_fixtures, schedule

HERE = Path(__file__).resolve().parent
SOURCE_PATHS = ['lib/validate.sprout', 'lib/config.sprout', 'lib/api.sprout', 'lib/workflow_progress.sprout',
                'integrations/python/sprout_host.py', 'integrations/node/index.js', 'examples/services/contacts_preview.sprout']
REQUIRED_JOBS = {'playground image (Docker)', 'numeric and boundary safety (UndefinedBehaviorSanitizer, Linux)',
    'build & test (macos-latest)', 'Paper adapter (Java 25, native worker)', 'memory safety (AddressSanitizer, Linux)',
    'WebAssembly interpreter verification / wasm', 'build & test (ubuntu-latest)', 'build & test (windows-latest)'}
NATIVE_SOURCES = {'src/binary_values.h', 'src/distribution_bundle.h', 'src/distribution_common.h', 'src/distribution_packages.h',
    'src/embed.c', 'src/embed.h', 'src/ergonomics_calls.h', 'src/ergonomics_format.h', 'src/ergonomics_parser.h',
    'src/exact_numeric.h', 'src/parallel_runtime.h', 'src/process_native.h', 'src/runtime_foundation.h', 'src/sprout.c',
    'src/sqlite.inc', 'src/stdlib.inc', 'src/vendor/sqlite/sqlite3.c', 'src/vendor/sqlite/sqlite3.h', 'src/workflow_runtime.h'}
SELECTION_KEYS = {'schema', 'profile', 'revision', 'source_root', 'application_sources',
    'native_path', 'native_sha256', 'build_path', 'build_sha256', 'compiler_path', 'compiler_sha256',
    'ci_path', 'ci_sha256', 'python_path', 'python_sha256', 'node_path', 'node_sha256', 'spec_path', 'spec_sha256'}


def load_selection(path, pin):
    path = Path(path).resolve()
    value = m.pinned_json(path, pin, m.INPUT_BOUNDS['selection_bytes'])
    m.require(type(value) is dict and set(value) == SELECTION_KEYS and value['schema'] == 'sprout.measurement-selection.v2' and value['profile'] == m.PROFILE,
              'selection_shape', 'Unsupported selection schema/profile')
    m.require(m.digest_text(value['revision'], 40), 'selection_shape', 'Canonical source revision missing')
    for key in SELECTION_KEYS - {'application_sources'}:
        m.require(type(value[key]) is str and 0 < len(value[key]) <= 4096, 'selection_shape', 'Selection text is missing or oversized')
        if key.endswith('_sha256'): m.require(m.digest_text(value[key]), 'selection_shape', 'Canonical digest missing')
    app = value['application_sources']
    m.require(type(app) is dict and set(app) == set(SOURCE_PATHS) and all(m.digest_text(item) for item in app.values()),
              'selection_shape', 'All7 explicit application source digests required')
    return value


def selected_path(selection_file, value):
    path = Path(value)
    return (path if path.is_absolute() else Path(selection_file).resolve().parent / path).resolve()


def file_identity(path, expected, maximum):
    m.require(Path(path).is_file() and not Path(path).is_symlink() and Path(path).stat().st_size <= maximum,
              'input_size', 'Selected input must be a bounded regular file')
    m.require(m.bounded_sha(path, maximum) == expected, 'selection_hash', 'Selected local bytes changed')


def inspect_selection(selection_file, pin):
    chosen = load_selection(selection_file, pin)
    paths = {key: selected_path(selection_file, chosen[key]) for key in SELECTION_KEYS if key.endswith('_path')}
    for key, path in paths.items():
        maximum = m.INPUT_BOUNDS['host_executable_bytes'] if key in {'python_path', 'node_path'} else m.INPUT_BOUNDS['native_compiler_bytes'] if key in {'native_path', 'compiler_path'} else m.INPUT_BOUNDS['metadata_bytes']
        file_identity(path, chosen[key[:-5] + '_sha256'], maximum)
    build = m.bounded_json(paths['build_path']); ci = m.bounded_json(paths['ci_path']); spec = m.bounded_json(paths['spec_path'])
    m.validate_spec(spec)
    m.require(build.get('revision') == chosen['revision'] and build.get('binary_sha256') == chosen['native_sha256'] and build.get('compiler_sha256') == chosen['compiler_sha256'] and
              type(build.get('exit')) is int and build['exit'] == 0 and build.get('inputs_still_match') is True, 'build_record', 'Selected build record is inconsistent')
    args = build.get('argv')
    m.require(type(args) is list and len(args) <= 128 and all(type(arg) is str for arg in args) and
              all(flag in args for flag in ('-O2', '-Wall', '-s', '-DSPROUT_SQLITE', '-Wl,--stack,67108864')), 'build_profile', 'Build is outside normal Windows profile')
    native = build.get('input_git_blob_sha256')
    m.require(type(native) is dict and set(native) == NATIVE_SOURCES and all(m.digest_text(item) for item in native.values()), 'build_record', 'All19 declared canonical build inputs required')
    m.require(ci.get('headSha') == chosen['revision'] and ci.get('conclusion') == 'success' and ci.get('status') == 'completed' and
              type(ci.get('attempt')) is int and ci['attempt'] >= 1, 'ci_record', 'CI does not record completed success for selected source')
    jobs = ci.get('jobs')
    m.require(type(jobs) is list and len(jobs) == 8 and all(type(job) is dict for job in jobs) and
              {job.get('name') for job in jobs} == REQUIRED_JOBS and all(job.get('conclusion') == 'success' and job.get('status') == 'completed' for job in jobs),
              'ci_record', 'All8 declared completed successful jobs required')
    source_root = selected_path(selection_file, chosen['source_root'])
    sources = dict(native, **chosen['application_sources'])
    m.require(len(sources) == 26, 'selection_shape', 'Runtime/application source keys overlap')
    for name, expected in sources.items():
        file_identity(m.inventory_path(source_root, name), expected, 33554432)
    return chosen, paths, build, ci, sources, source_root


def collect_input(source, maximum, remaining):
    m.require(type(remaining) is int and remaining >= 0, 'snapshot_size', 'Snapshot remaining byte credit must be nonnegative')
    credited = m.file_bound(source, min(maximum, remaining))
    return m.bounded_file(source, credited, True, expected_size=credited)


def freeze(destination, selection_file, pin):
    chosen, paths, build, ci, sources, source_root = inspect_selection(selection_file, pin)
    destination = Path(destination).resolve(); destination.mkdir(parents=True, exist_ok=False)
    inventory = {}; total = 0
    def save(name, raw, maximum=33554432):
        nonlocal total
        m.require(type(raw) is bytes and len(raw) <= maximum and total + len(raw) <= 268435456, 'snapshot_size', 'Snapshot input exceeds its byte cap')
        target = m.inventory_path(destination, name); target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream: stream.write(raw)
        inventory[name] = hashlib.sha256(raw).hexdigest(); total += len(raw)
    def copy(name, source, expected, maximum=67108864):
        digest, raw = collect_input(source, maximum, 268435456 - total)
        m.require(digest == expected, 'source_hash', 'Copied input differs from pinned identity')
        save(name, raw, maximum)
    for name, expected in sorted(sources.items()): copy('git/' + name, m.inventory_path(source_root, name), expected, 33554432)
    copy('native/runtime.exe', paths['native_path'], chosen['native_sha256'])
    copy('provenance/compiler.bin', paths['compiler_path'], chosen['compiler_sha256'])
    for kind in ('build', 'ci'): copy('provenance/' + kind + '.json', paths[kind + '_path'], chosen[kind + '_sha256'], 1048576)
    copy('spec.json', paths['spec_path'], chosen['spec_sha256'], 65536)
    copy('provenance/selection.json', selection_file, pin, 65536)
    save('provenance/prepare_measurement.py', collect_input(Path(__file__), 33554432, 268435456 - total)[1])
    for key, fixture in fixtures().items():
        save('fixtures/' + key + '.json', compact(fixture), 1048576)
        for mode in ('full', 'control'): save('drivers/' + key + '-' + mode + '.sprout', prepared_source(fixture, mode).encode('utf-8'), 1048576)
    save('fixtures/sdk.json', compact(sdk_fixtures()), 1048576)
    save('sdk/Hmin.sprout', b'make request = builtin::json_decode(builtin::read_input())\nshow builtin::json_encode({ok: yes})\n')
    save('sdk/Hecho16K.sprout', b'show builtin::json_encode(builtin::json_decode(builtin::read_input()))\n')
    save('schedule.json', compact(schedule()))
    for name in ('measure_workloads.py', 'measurement_fixtures.py', 'measurement_sdk.py', 'measurement_sdk.cjs'):
        save('controller/' + name, collect_input(HERE / name, 33554432, 268435456 - total)[1])
    manifest = {'schema': 'sprout.finite-measurement-snapshot.v2', 'profile': m.PROFILE, 'revision': chosen['revision'],
        'native': 'native/runtime.exe', 'native_sha256': chosen['native_sha256'], 'compiler': 'provenance/compiler.bin',
        'compiler_sha256': chosen['compiler_sha256'], 'build_sha256': chosen['build_sha256'], 'ci_sha256': chosen['ci_sha256'],
        'ci_attempt': ci['attempt'], 'specification': 'spec.json', 'specification_sha256': chosen['spec_sha256'],
        'host_tools': {kind: {'path': str(paths[kind + '_path']), 'sha256': chosen[kind + '_sha256']} for kind in ('python', 'node')},
        'files': inventory, 'bounds': m.BOUNDS, 'schedule': m.SCHEDULE,
        'trust': 'Consistency with externally caller-pinned records, not authenticity from self-claimed metadata',
        'measurement_scope_reviewed_and_sealed': False}
    with (destination / 'manifest.json').open('xb') as stream: stream.write(compact(manifest))
    return m.sha(destination / 'manifest.json', m.INPUT_BOUNDS['metadata_bytes'])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selection', type=Path, required=True); parser.add_argument('--selection-sha256', required=True)
    parser.add_argument('--prepare', action='store_true'); parser.add_argument('--destination', type=Path)
    args = parser.parse_args(argv)
    if not args.prepare:
        m.require(args.destination is None, 'mode', 'Destination requires explicit --prepare')
        inspect_selection(args.selection, args.selection_sha256)
        print('Selection consistency verified; check-only: no launches/writes.'); return 0
    m.require(args.destination is not None, 'mode', 'Explicit preparation requires a new destination')
    print(freeze(args.destination, args.selection, args.selection_sha256)); return 0


if __name__ == '__main__': raise SystemExit(main())
