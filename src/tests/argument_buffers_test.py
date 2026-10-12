"""Required tagged preparation-array ownership controls; no whole-heap claim."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('SPROUT_ARGUMENT_BUFFER_SOURCE', ROOT)).resolve()
BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else
              os.environ.get('SPROUT_BINARY', ROOT / 'src' / ('sprout.exe' if os.name == 'nt' else 'sprout'))).resolve()
NATIVE_INPUTS = ('binary_values.h', 'distribution_bundle.h', 'distribution_common.h', 'distribution_packages.h',
                 'embed.c', 'embed.h', 'ergonomics_calls.h', 'ergonomics_format.h', 'ergonomics_parser.h',
                 'exact_numeric.h', 'parallel_runtime.h', 'process_native.h', 'runtime_foundation.h', 'sprout.c',
                 'sqlite.inc', 'stdlib.inc', 'vendor/sqlite/sqlite3.c', 'vendor/sqlite/sqlite3.h', 'workflow_runtime.h')
C_EDITS = (
    (b'void *pointer = malloc(bytes);', b'void *pointer = review_buffer_alloc(bytes,review_allocation_tag);', 1),
    (b'free(pointer);', b'review_buffer_free(pointer);', 2),
    (b'realloc(temporary_buffers, next * sizeof(void *))', b'review_registry_reserve(temporary_buffers, next * sizeof(void *))', 1),
    (b'temporary_buffer_alloc((size_t)(n ? n : 1), sizeof(char *), call->line, "couldn\'t allocate constructor inputs.")',
     b'review_owned_alloc((size_t)(n ? n : 1), sizeof(char *), call->line, "couldn\'t allocate constructor inputs.",1)', 1),
    (b'temporary_buffer_alloc((size_t)(n ? n : 1), sizeof(Expr *), call->line, "couldn\'t allocate constructor inputs.")',
     b'review_owned_alloc((size_t)(n ? n : 1), sizeof(Expr *), call->line, "couldn\'t allocate constructor inputs.",2)', 1),
)
HEADER_EDITS = (
    (b'temporary_buffer_alloc((size_t)(n?n:1),sizeof(int),call->line,"couldn\'t allocate task inputs.")',
     b'review_owned_alloc((size_t)(n?n:1),sizeof(int),call->line,"couldn\'t allocate task inputs.",0)', 1),
)


def instrument_bytes(original, edits):
    """No locale conversion: validate UTF-8, edit bytes, prove exact reconstruction."""
    original.decode('utf-8', 'strict')
    result = original
    for old, new, count in edits:
        if not old or not new or result.count(old) != count or new in result:
            raise ValueError('native instrumentation tokens/count changed')
        result = result.replace(old, new)
    result.decode('utf-8', 'strict')
    restored = result
    for old, new, count in reversed(edits):
        if restored.count(new) != count: raise ValueError('instrumentation replacement count drifted')
        restored = restored.replace(new, old)
    if restored != original: raise ValueError('untouched native bytes changed')
    return result


def generate_inputs(source, target):
    inventory = {}
    for relative in NATIVE_INPUTS:
        name = 'src/' + relative
        original = (source / name).read_bytes()
        original.decode('utf-8', 'strict')
        edits = C_EDITS if relative == 'sprout.c' else HEADER_EDITS if relative == 'ergonomics_calls.h' else ()
        output = instrument_bytes(original, edits)
        path = target / 'instrumented' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream: stream.write(output)
        if path.read_bytes() != output: raise ValueError('instrumented file publication mismatch')
        inventory[name] = {'original_sha256': hashlib.sha256(original).hexdigest(),
                           'instrumented_sha256': hashlib.sha256(output).hexdigest(),
                           'replacement_sites': sum(count for _, _, count in edits), 'reconstruction_exact': True}
    return inventory


def bounded_helper():
    # Reuse the separately tested capped reader/writer/direct-owner supervisor.
    saved = sys.argv
    try:
        sys.argv = [__file__]
        spec = importlib.util.spec_from_file_location('argument_buffer_bounded_driver', ROOT / 'src/tests/gc_env_roots_test.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.bounded_process
    finally: sys.argv = saved


class GeneratorControls(unittest.TestCase):
    def test_non_ascii_context_is_byte_identical_after_inverse(self):
        context = '// café — Україна\n'.encode('utf-8')
        original = context + b'malloc(bytes);\n' + context
        output = instrument_bytes(original, ((b'malloc(bytes)', b'tagged(bytes)', 1),))
        self.assertEqual(output.replace(b'tagged(bytes)', b'malloc(bytes)'), original)
        self.assertEqual(output.count(context), 2)

    def test_missing_ambiguous_or_already_instrumented_tokens_fail_closed(self):
        for value in [b'no allocation', b'malloc(x);malloc(x)', b'malloc(x);tagged(x)']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                instrument_bytes(value, ((b'malloc(x)', b'tagged(x)', 1),))

    def test_invalid_utf8_refused(self):
        with self.assertRaises(UnicodeDecodeError): instrument_bytes(b'\xffmalloc(x)', ((b'malloc(x)', b'tagged(x)', 1),))


COMMON = '''task fail_input():
    fail "expected recovery"
task combine(first, second):
    give {first: first, second: second}
task defaulted(first, second = fail_input()):
    give first
task typed(value: number):
    give value
type Payload:
    make first = "left"
    make second = fail_input()
task local_recovery():
    try:
        typed("wrong")
    caught issue:
        give "recovered"
task rethrower():
    try:
        defaulted("left")
    caught issue:
        fail issue
'''


class PreparationBuffers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = os.environ.get('SPROUT_ARGUMENT_BUFFER_CC') or shutil.which('cc') or shutil.which('gcc')
        if not compiler: raise RuntimeError('Required preparation ownership cohort needs SPROUT_ARGUMENT_BUFFER_CC or trusted cc/gcc.')
        cls.build = tempfile.TemporaryDirectory(prefix='sprout-argument-buffer-build-')
        cls.addClassCleanup(cls.build.cleanup)
        cls.directory = Path(cls.build.name)
        cls.capture = staticmethod(bounded_helper())
        cls.inventory = generate_inputs(SOURCE, cls.directory)
        source = ROOT / 'src/tests/argument_buffers_harness.c'
        harness = cls.directory / 'argument_buffers_harness.c'
        harness.write_bytes(source.read_bytes())
        cls.binary = cls.directory / ('review.exe' if os.name == 'nt' else 'review')
        flags = shlex.split(os.environ.get('SPROUT_ARGUMENT_BUFFER_CFLAGS', '-O2 -Wall'))
        argv = [compiler, *flags, '-I', str(cls.directory / 'instrumented/src'), '-o', str(cls.binary), str(harness), '-lm']
        argv += ['-Wl,--stack,67108864', '-lurlmon'] if os.name == 'nt' else ['-pthread', '-ldl']
        result = cls.capture(argv, cwd=cls.directory, timeout=90, env=dict(os.environ))
        (cls.directory / 'compile.stdout').write_bytes(result.stdout)
        (cls.directory / 'compile.stderr').write_bytes(result.stderr)
        (cls.directory / 'generation.json').write_text(json.dumps(cls.inventory, indent=2) + '\n', encoding='utf-8')
        if result.returncode or result.capture_errors or result.cleanup_errors:
            raise AssertionError('Required ownership fixture compile failed: ' + repr((result.returncode, result.capture_errors, result.cleanup_errors)) + '\n' + result.stderr.decode('utf-8', 'replace'))

    def setUp(self):
        self.case = tempfile.TemporaryDirectory(prefix='sprout-argument-buffer-case-')
        self.addCleanup(self.case.cleanup)
        self.work = Path(self.case.name)

    def source(self, text, name='case.sprout'):
        path = self.work / name
        path.write_text(text, encoding='utf-8', newline='\n')
        return path

    def execute(self, text=None, *, command='run', status=0, injection=None, trusted_import=False, data=None, custom=None):
        env = dict(os.environ)  # Preserve requested sanitizer and actual GC-stress profiles.
        for name in ('SPROUT_REVIEW_MALLOC_REFUSE', 'SPROUT_REVIEW_RESERVE_AFTER'): env.pop(name, None)
        env.update(injection or {})
        if trusted_import: env.pop('SPROUT_SANDBOX', None)
        argv = [str(self.binary)]
        if custom is not None: argv += custom
        elif text is not None:
            argv += [command, str(self.source(text))]
            if not trusted_import: argv += ['--sandbox']
            argv += ['--max-steps', '200000', '--timeout-ms', '1000']
        result = self.capture(argv, cwd=self.work, data=data, timeout=5, env=env)
        self.assertEqual(result.capture_errors, (), repr(result.capture_errors))
        self.assertEqual(result.cleanup_errors, (), repr(result.cleanup_errors))
        self.assertEqual(result.returncode, status, result.stderr.decode('utf-8', 'replace'))
        for marker in (b'AddressSanitizer', b'runtime error:', b'DEADLYSIGNAL'): self.assertNotIn(marker, result.stderr)
        markers = [line for line in result.stderr.splitlines() if line.startswith(b'@temporary-buffers ')]
        self.assertEqual(len(markers), 1, result.stderr.decode('utf-8', 'replace'))
        counts = json.loads(markers[0][len(b'@temporary-buffers '):])
        self.assertEqual(counts['depth'], 0)
        self.assertIs(counts['discarded_slots_cleared'], True)
        for kind in ('slots', 'constructor_names', 'constructor_defaults'):
            self.assertEqual(counts[kind]['allocated'], counts[kind]['freed'])
            self.assertEqual((counts[kind]['live'], counts[kind]['live_bytes']), (0, 0))
        return result, counts

    def test_success_named_inputs_and_validation_preserve_outputs(self):
        result, counts = self.execute(COMMON + '''make attempts = 0
repeat 32 times:
    make positional = combine("left", "right")
    make named = combine(second: "right", first: "left")
    make object = Payload(second: "right", first: "left")
    when positional.first != "left" or named.second != "right" or object.second != "right":
        fail "success output changed"
    try:
        Payload(unknown: "wrong")
    caught issue:
        set attempts = attempts + 1
show builtin::json_encode({checks: attempts})
''')
        self.assertEqual(json.loads(result.stdout), {'checks': 32})
        self.assertEqual(counts['slots']['allocated'], 128)
        self.assertEqual(counts['constructor_names']['allocated'], 64)
        self.assertEqual(counts['constructor_defaults']['allocated'], 64)

    def test_caught_argument_default_type_and_constructor_errors_balance(self):
        result, counts = self.execute(COMMON + '''make checks = 0
repeat 32 times:
    try:
        combine("left", fail_input())
    caught issue:
        when issue.message != "expected recovery":
            fail "argument primary changed"
        set checks = checks + 1
    try:
        defaulted("left")
    caught issue:
        when issue.message != "expected recovery":
            fail "default primary changed"
        set checks = checks + 1
    try:
        typed("wrong")
    caught issue:
        when issue.kind != "type":
            fail "type primary changed"
        set checks = checks + 1
    try:
        Payload(first: "left")
    caught issue:
        when issue.message != "expected recovery":
            fail "constructor default primary changed"
        set checks = checks + 1
    try:
        Payload(first: "left", second: fail_input())
    caught issue:
        when issue.message != "expected recovery":
            fail "constructor argument primary changed"
        set checks = checks + 1
show builtin::json_encode({checks: checks})
''')
        self.assertEqual(json.loads(result.stdout), {'checks': 160})
        self.assertEqual(counts['slots']['allocated'], 288)
        self.assertEqual(counts['constructor_names']['allocated'], 64)
        self.assertEqual(counts['constructor_defaults']['allocated'], 64)

    def test_suspended_call_checks_both_values_and_nested_rethrow(self):
        result, counts = self.execute(COMMON + '''make checks = 0
repeat 32 times:
    make values = combine("left", local_recovery())
    when values.first != "left" or values.second != "recovered":
        fail "suspended values changed"
    try:
        rethrower()
    caught issue:
        when issue.message != "expected recovery":
            fail "rethrow primary changed"
        set checks = checks + 1
show builtin::json_encode({checks: checks})
''')
        self.assertEqual(json.loads(result.stdout), {'checks': 32})
        self.assertEqual(counts['slots']['allocated'], 192)

    def test_refusal_order_and_predecessor_cleanup_preserve_exact_primary(self):
        program = COMMON + '''make message = "missing"
try:
    Payload(first: "left", second: "right")
caught issue:
    set message = issue.message
show builtin::json_encode({message: message})
'''
        labels = ('constructor_names', 'constructor_defaults', 'slots')
        for mode, indices in [('SPROUT_REVIEW_RESERVE_AFTER', (0, 1, 2)), ('SPROUT_REVIEW_MALLOC_REFUSE', (1, 2, 3))]:
            for at in indices:
                with self.subTest(mode=mode, at=at):
                    result, counts = self.execute(program, injection={mode: str(at)})
                    expected = "couldn't preserve argument preparation storage." if mode.endswith('AFTER') else (
                        "couldn't allocate task inputs." if at == 3 else "couldn't allocate constructor inputs.")
                    self.assertEqual(json.loads(result.stdout), {'message': expected})
                    self.assertEqual([counts[label]['attempted'] for label in labels], [int(i < at) for i in range(3)])
                    self.assertEqual([counts[label]['allocated'] for label in labels], [int(i < (at if mode.endswith('AFTER') else at-1)) for i in range(3)])
                    self.assertEqual([counts[label]['refused'] for label in labels], [0, 0, 0] if mode.endswith('AFTER') else [int(i == at-1) for i in range(3)])
                    self.assertEqual(counts['registry_calls'], 1)

    def test_non_top_tombstones_preserve_saved_depth_and_clear_used_slots(self):
        _, counts = self.execute(custom=['--tombstone-control'])
        self.assertEqual(counts['slots']['allocated'], 3)

    def test_hard_error_and_failed_test_boundaries_restore_depth(self):
        result, counts = self.execute('''task broken(value = missing_preparation_input):
    give value
try:
    broken()
caught issue:
    show "MUST_NOT_CATCH"
''', status=1)
        self.assertNotIn(b'MUST_NOT_CATCH', result.stdout)
        self.assertIn(b'missing_preparation_input', result.stderr)
        self.assertEqual(counts['slots']['allocated'], 1)
        result, _ = self.execute(COMMON + '''test "later argument":
    combine("left", fail_input())
test "wrong expected kind":
    expect error "math":
        defaulted("left")
test "recovered":
    expect yes
''', command='test', status=1)
        output = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', result.stdout)
        self.assertIn(b'1 passed, 2 failed', output)

    def test_trusted_module_and_repl_recovery_are_exercised(self):
        self.source('task failure():\n    fail "module primary failure"\ntask prepare(value = failure()):\n    give value\nprepare()\n', 'failed_module.sprout')
        result, counts = self.execute('use "failed_module.sprout"\n', status=1, trusted_import=True)
        self.assertIn(b'module primary failure', result.stderr)
        self.assertEqual(counts['slots']['allocated'], 2)
        data = b'1\ntask failure():\n    fail "repl primary"\n\ntask prepare(value = failure()):\n    give value\n\nprepare()\nprepare()\nshow "AFTER_TWO_FAILURES"\nback\n4\n'
        result, counts = self.execute(data=data, custom=[])
        self.assertIn(b'AFTER_TWO_FAILURES', result.stdout)
        self.assertEqual(result.stderr.count(b'repl primary'), 2)
        self.assertEqual(counts['slots']['allocated'], 4)

    def test_normal_native_shared_semantic_corpus(self):
        argv = [str(BINARY), 'test', str(ROOT / 'src/tests/argument_buffers_test.sprout'), '--sandbox', '--max-steps', '200000', '--timeout-ms', '1000']
        result = self.capture(argv, cwd=self.work, timeout=5, env=dict(os.environ))
        self.assertEqual((result.capture_errors, result.cleanup_errors), ((), ()))
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')
        self.assertRegex(re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', result.stdout), rb'(?m)^  6 passed\r?$')


if __name__ == '__main__': unittest.main()
