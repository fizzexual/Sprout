"""Three portable source/fake controls; six modeled results, zero child launches.

Direct entry has a10s controller timer; helper supervision is not requalified.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
STATE = {'popen_attempts': 0, 'modeled_results': 0}
ORDER = ['test_source_and_early_admission', 'test_one_build_and_complete_three_profiles', 'test_first_failure_before_artifact_and_postflight']


class PortableControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global module, OUTPUT, fake_native, fake_compiler
        STATE.update(popen_attempts=0, modeled_results=0)
        owned = tempfile.TemporaryDirectory(prefix='sprout-text-step-driver-')
        cls.addClassCleanup(owned.cleanup); OUTPUT = Path(owned.name)
        fake_native = OUTPUT / 'not-a-native.bin'; fake_native.write_bytes(b'MODELED NATIVE ONLY\n')
        fake_compiler = OUTPUT / 'not-a-compiler.bin'; fake_compiler.write_bytes(b'MODELED COMPILER ONLY\n')
        def refuse(*args, **kwargs):
            STATE['popen_attempts'] += 1
            raise AssertionError('Actual child creation forbidden')
        guard = patch.object(subprocess, 'Popen', refuse)
        guard.start(); cls.addClassCleanup(guard.stop)
        saved_bytecode = sys.dont_write_bytecode; sys.dont_write_bytecode = True
        cls.addClassCleanup(setattr, sys, 'dont_write_bytecode', saved_bytecode)
        name = '_text_stepping_public_control_subject'; previous = sys.modules.get(name)
        path = ROOT / 'src/tests/text_stepping_test.py'
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module
        def restore_module():
            if previous is None: sys.modules.pop(name, None)
            else: sys.modules[name] = previous
        cls.addClassCleanup(restore_module)
        spec.loader.exec_module(module)

    @classmethod
    def tearDownClass(cls):
        if STATE != {'popen_attempts': 0, 'modeled_results': 6}:
            raise AssertionError('Expected exactly six modeled results and no actual launch: ' + repr(STATE))

    def clean_environment(self):
        return {key: value for key, value in os.environ.items() if key not in {'SPROUT_GC_STRESS', 'SPROUT_SANDBOX'}}

    def test_source_and_early_admission(self):
        before = STATE['modeled_results']
        for key in ['SPROUT_GC_STRESS', 'SPROUT_SANDBOX']:
            for value in ['', '1']:
                with patch.dict(os.environ, {key: value}), patch.object(module, 'source_inventory', side_effect=AssertionError('no source read')) as sources, patch.object(module, 'bounded_helper', side_effect=AssertionError('no helper')) as helper, patch.object(module, 'compiler_selection', side_effect=AssertionError('no compiler')) as compiler:
                    with self.assertRaisesRegex(ValueError, 'Parent GC/sandbox'):
                        module.run_profile('not-an-executable', OUTPUT / ('guard-' + key + str(len(value))))
                    self.assertEqual((sources.call_count, helper.call_count, compiler.call_count), (0, 0, 0))
        self.assertFalse(any(value.name.startswith('guard-') for value in OUTPUT.iterdir()))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as absent:
            module.main([])
        self.assertEqual(absent.exception.code, 2)
        with patch.dict(os.environ, {'SPROUT_TEXT_STEP_CC': ''}), patch.object(module.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'not skipped'):
                module.compiler_selection()
        shared = (ROOT / 'src/tests/text_stepping_test.sprout').read_bytes().decode('utf-8').replace('\r\n', '\n').encode('utf-8')
        self.assertEqual(hashlib.sha256(shared).hexdigest(), 'ab246dd67deae116e4901b88b5b35be384d5f78fbdf2e756114f289aee2bbd8d')
        self.assertEqual(len(re.findall(rb'^test "', shared, re.M)), 6)
        harness = (ROOT / 'src/tests/text_step_harness.c').read_bytes().decode('utf-8').replace('\r\n', '\n').encode('utf-8')
        restored = harness.replace(b'#include "../sprout.c"', b'#include "../candidate/src/sprout.c"')
        self.assertEqual(hashlib.sha256(restored).hexdigest(), 'a1f2acd6b2e18e78d6e38ab40c99e4d8798bdbc02c830cd2e311eb4666649391')
        self.assertEqual(len(re.findall(rb'^\s*\{"[a-zA-Z0-9_]+",', harness, re.M)), 16)
        self.assertEqual(STATE['modeled_results'], before)

    def test_one_build_and_complete_three_profiles(self):
        before = STATE['modeled_results']; calls = []
        outputs = [b'', b'\x1b[32m6 passed\x1b[0m\n', b'6 passed, 0 failed\n', b'{"ok":true,"cases":16,"groups":15}\n']
        def completed(argv, *, cwd, data, timeout, env):
            index = len(calls); self.assertLess(index, 4); self.assertEqual(Path(cwd), ROOT); self.assertIsNone(data)
            self.assertEqual(timeout, 90 if index == 0 else 5)
            self.assertNotIn('SPROUT_SANDBOX', env)
            self.assertEqual(env.get('SPROUT_GC_STRESS'), '1' if index == 2 else None)
            if index == 0:
                self.assertEqual(argv[0], str(fake_compiler)); self.assertIn('-O2', argv); self.assertIn('-Wall', argv)
                self.assertIn(str(ROOT / 'src/tests/text_step_harness.c'), argv)
                Path(argv[argv.index('-o') + 1]).write_bytes(b'MODELED HELPER ONLY\n')
            elif index < 3:
                self.assertEqual(argv[0], str(fake_native)); self.assertEqual(argv[1], 'test')
                self.assertEqual(argv[-4:], ['--max-steps', '5000000', '--timeout-ms', '3000'])
            else:
                self.assertEqual(Path(argv[0]).parent, OUTPUT / 'success')
            calls.append(argv); STATE['modeled_results'] += 1
            return SimpleNamespace(returncode=0, stdout=outputs[index], stderr=b'', capture_errors=(), cleanup_errors=())
        helper = SimpleNamespace(CAPTURE_BYTES=32768, bounded_process=completed)
        with patch.dict(os.environ, self.clean_environment(), clear=True), patch.object(module, 'bounded_helper', return_value=helper), patch.object(module, 'compiler_selection', return_value=(fake_compiler, ['-O2', '-Wall'])), contextlib.redirect_stdout(io.StringIO()):
            result = module.run_profile(fake_native, OUTPUT / 'success')
        self.assertTrue(result['passed']); self.assertEqual(len(calls), 4)
        self.assertEqual(result['compiler_invocations_reserved'], 1); self.assertEqual(result['payload_invocations_reserved'], 3)
        self.assertTrue(all(row['accepted'] for row in result['observations']))
        self.assertEqual(result['postflight_errors'], []); self.assertEqual(result['finalization_errors'], [])
        self.assertEqual(json.loads((OUTPUT / 'success/passed.json').read_text()), {'schema': 1, 'compiler_calls': 1, 'payload_calls': 3})
        self.assertEqual(result['fixture_binary']['raw_sha256'], hashlib.sha256(b'MODELED HELPER ONLY\n').hexdigest())
        self.assertEqual(STATE['modeled_results'], before + 4)

    def test_first_failure_before_artifact_and_postflight(self):
        before = STATE['modeled_results']; calls = []; refused = []; real_write = Path.write_bytes
        def completed(argv, **kwargs):
            index = len(calls); self.assertLess(index, 2)
            if index == 0: Path(argv[argv.index('-o') + 1]).write_bytes(b'MODELED HELPER ONLY\n')
            calls.append(argv); STATE['modeled_results'] += 1
            return SimpleNamespace(returncode=0, stdout=b'' if index == 0 else b'6 passed\n1 failed\n', stderr=b'', capture_errors=(), cleanup_errors=())
        def write(path, data):
            if path.name.startswith('shared-normal.'):
                refused.append(path.name); raise OSError('modeled raw artifact refusal')
            return real_write(path, data)
        def drift(result, *args):
            failure = ValueError('modeled postflight source drift')
            result['postflight_errors'].append(module.diagnostic(failure)); module.latch(result, failure)
        helper = SimpleNamespace(CAPTURE_BYTES=32768, bounded_process=completed)
        with patch.dict(os.environ, self.clean_environment(), clear=True), patch.object(module, 'bounded_helper', return_value=helper), patch.object(module, 'compiler_selection', return_value=(fake_compiler, ['-O2', '-Wall'])), patch.object(module, 'postflight', drift), patch.object(Path, 'write_bytes', write), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(AssertionError, 'First text-stepping failure retained'):
                module.run_profile(fake_native, OUTPUT / 'failure')
        self.assertEqual(len(calls), 2); self.assertEqual(refused, ['shared-normal.stdout.bin', 'shared-normal.stderr.bin'])
        result = json.loads((OUTPUT / 'failure/result.json').read_text())
        self.assertFalse(result['passed']); self.assertFalse((OUTPUT / 'failure/passed.json').exists())
        self.assertEqual(result['primary_error'], {'type': 'ValueError', 'message': 'Shared output reports nonzero failures'})
        self.assertEqual(len(result['artifact_errors']), 2); self.assertEqual(len(result['postflight_errors']), 1)
        self.assertEqual(result['observations'][1]['exit'], 0); self.assertTrue(result['observations'][1]['status_known'])
        self.assertEqual(result['payload_invocations_reserved'], 1)
        self.assertEqual(STATE['modeled_results'], before + 2)


def main():
    timer = threading.Timer(10, lambda: os._exit(124)); timer.daemon = True; timer.start()
    try:
        suite = unittest.TestSuite(PortableControls(name) for name in ORDER)
        result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
        return 0 if result.wasSuccessful() and result.testsRun == 3 else 1
    finally:
        timer.cancel(); timer.join(.5)


if __name__ == '__main__':
    raise SystemExit(main())
