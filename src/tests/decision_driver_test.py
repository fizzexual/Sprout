"""Three portable fake-driver regressions; no actual Popen/native/SDK calls.

Run directly from any repository checkout. Five supervisor results are modeled;
the existing helper supervisor itself is not requalified by these tests.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
ROOT = REPO
STATE = {"actual_popen_attempts": 0, "modeled_completions": 0, "old_six_body_invocations": 0}
ORDER = ("parent_presence_and_default_gate", "four_modeled_profile_and_full_oracles", "first_failure_and_framing_source")


def refuse_child(*args, **kwargs):
    STATE["actual_popen_attempts"] += 1
    raise AssertionError("Actual child creation forbidden")


def old_body(*args, **kwargs):
    STATE["old_six_body_invocations"] += 1
    raise AssertionError("The separate six pure groups must not repeat here")


def frame(value, ending=b"\n"):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + ending


def independent_example_expected():
    # Direct complete synthetic expectations, not a private machine JSON file.
    return [
        {"ok": True, "matched": True, "selection": {"kind": "rule", "index": {"$sprout.integer": "1"}, "id": "manual"}, "output": {"bucket": "review"}, "error": None},
        {"ok": True, "matched": True, "selection": {"kind": "rule", "index": {"$sprout.integer": "2"}, "id": "small"}, "output": {"bucket": "small"}, "error": None},
        {"ok": True, "matched": True, "selection": {"kind": "rule", "index": {"$sprout.integer": "3"}, "id": "unknown-age"}, "output": {"bucket": "unclassified"}, "error": None},
        {"ok": True, "matched": False, "selection": {"kind": "fallback", "index": None, "id": None}, "output": {"bucket": "standard"}, "error": None},
    ]


class PortableSetup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global module, OUTPUT, fake_native
        STATE.update(actual_popen_attempts=0, modeled_completions=0, old_six_body_invocations=0)
        owned = tempfile.TemporaryDirectory(prefix="sprout-decision-driver-")
        cls.addClassCleanup(owned.cleanup)
        OUTPUT = Path(owned.name)
        fake_native = OUTPUT / "not-a-native-worker.bin"
        fake_native.write_bytes(b"MODELED RESULT ONLY; NEVER EXECUTE\n")
        guard = patch.object(subprocess, "Popen", side_effect=refuse_child)
        guard.start(); cls.addClassCleanup(guard.stop)
        path = REPO / "src/tests/decision_library_test.py"
        spec = importlib.util.spec_from_file_location("decision_driver_control_subject", path)
        module = importlib.util.module_from_spec(spec)
        previous = sys.modules.get(spec.name)
        sys.modules[spec.name] = module
        def restore_module():
            if previous is None:
                sys.modules.pop(spec.name, None)
            else:
                sys.modules[spec.name] = previous
        cls.addClassCleanup(restore_module)
        spec.loader.exec_module(module)
        for name in unittest.defaultTestLoader.getTestCaseNames(module.SourceOracleTests):
            setattr(module.SourceOracleTests, name, old_body)

    @classmethod
    def tearDownClass(cls):
        if STATE != {"actual_popen_attempts": 0, "modeled_completions": 5, "old_six_body_invocations": 0}:
            raise AssertionError("Expected exactly five modeled results and zero actual/old-body calls: " + repr(STATE))


class PackagingControls(PortableSetup):
    def test_parent_presence_and_default_gate(self):
        before = STATE["modeled_completions"]
        with patch.object(module, "bounded_helper", side_effect=AssertionError("no helper")) as helper, patch.object(module.tempfile, "mkdtemp", side_effect=AssertionError("no temp")) as temp:
            for key in ("SPROUT_GC_STRESS", "SPROUT_SANDBOX"):
                for value in ("", "1"):
                    with patch.dict(os.environ, {key: value}):
                        self.assertEqual(module.main([], run_tests=False), 0)
                        with self.assertRaisesRegex(ValueError, "parent GC/sandbox"):
                            module.native_ci_checks(ROOT / "no-native-here", OUTPUT / (key + str(len(value))))
            self.assertEqual(helper.call_count, 0)
            self.assertEqual(temp.call_count, 0)
        self.assertEqual(STATE["modeled_completions"], before)
        self.assertFalse(any(path.name.startswith("SPROUT_") for path in OUTPUT.iterdir()))
        with self.assertRaisesRegex(ValueError, "Report directory"):
            module.main(["--report-dir", "no-implicit-binary"], run_tests=False)
        self.assertEqual(len(unittest.defaultTestLoader.getTestCaseNames(module.SourceOracleTests)), 6)

    def test_four_modeled_profile_and_full_oracles(self):
        before = STATE["modeled_completions"]
        calls = []
        payloads = [b"\x1b[32m10 passed\x1b[0m\n", b"10 passed, 0 failed\n",
                    frame([row["expected"] for row in module.semantic_cases()], b"\r\n"), frame(module.example_expected())]
        def completed(argv, *, cwd, data, timeout, env):
            index = len(calls)
            self.assertLess(index, 4)
            self.assertEqual(timeout, 5)
            self.assertIsNone(data)
            self.assertEqual(Path(cwd), REPO)
            self.assertEqual(argv[-5:] if index == 2 else argv[-4:], ["--max-steps", "5000000", "--timeout-ms", "3000", "--sandbox"] if index == 2 else ["--max-steps", "5000000", "--timeout-ms", "3000"])
            self.assertEqual(env.get("SPROUT_GC_STRESS"), "1" if index == 1 else None)
            self.assertNotIn("SPROUT_SANDBOX", env)
            calls.append(argv)
            STATE["modeled_completions"] += 1
            return SimpleNamespace(returncode=0, stdout=payloads[index], stderr=b"", capture_errors=(), cleanup_errors=())
        helper = SimpleNamespace(__file__=str(REPO / "src/tests/gc_env_roots_test.py"), bounded_process=completed)
        clean = {key: value for key, value in os.environ.items() if key not in {"SPROUT_GC_STRESS", "SPROUT_SANDBOX"}}
        with patch.dict(os.environ, clean, clear=True), patch.object(module, "bounded_helper", return_value=helper):
            observations = module.native_ci_checks(fake_native, OUTPUT / "four-correct-results")
        self.assertEqual(len(observations), 4)
        self.assertTrue(all(row["accepted"] for row in observations))
        self.assertEqual([argv[1] for argv in calls], ["test", "test", "run", "run"])
        result = json.loads((OUTPUT / "four-correct-results/result.json").read_text())
        self.assertTrue(result["passed"])
        self.assertEqual(result["helper_invocations_reserved"], 4)
        self.assertTrue((OUTPUT / "four-correct-results/passed.json").is_file())
        self.assertEqual(len(json.loads((OUTPUT / "four-correct-results/oracle-vectors.json").read_text())), 42)
        self.assertTrue(module.strict_equal(json.loads((OUTPUT / "four-correct-results/synthetic-example-expected.json").read_text()), independent_example_expected()))
        self.assertEqual(STATE["modeled_completions"], before + 4)

    def test_first_failure_and_framing_source(self):
        before_count = STATE["modeled_completions"]
        calls = []
        def completed(argv, **kwargs):
            calls.append(argv)
            STATE["modeled_completions"] += 1
            return SimpleNamespace(returncode=0, stdout=b"10 passed\n9 passed\n", stderr=b"", capture_errors=(), cleanup_errors=())
        helper = SimpleNamespace(__file__=str(REPO / "src/tests/gc_env_roots_test.py"), bounded_process=completed)
        clean = {key: value for key, value in os.environ.items() if key not in {"SPROUT_GC_STRESS", "SPROUT_SANDBOX"}}
        with patch.dict(os.environ, clean, clear=True), patch.object(module, "bounded_helper", return_value=helper):
            with self.assertRaisesRegex(AssertionError, "First native failure preserved"):
                module.native_ci_checks(fake_native, OUTPUT / "mixed-summary-failure")
        self.assertEqual(len(calls), 1)
        self.assertEqual((OUTPUT / "mixed-summary-failure/shared-normal.stdout.bin").read_bytes(), b"10 passed\n9 passed\n")
        self.assertFalse((OUTPUT / "mixed-summary-failure/passed.json").exists())
        result = json.loads((OUTPUT / "mixed-summary-failure/result.json").read_text())
        self.assertFalse(result["passed"])
        self.assertEqual(result["helper_invocations_reserved"], 1)
        for bad in [b"10 passed, 1 failed\n", b"10 passed\n10 passed\n", b"9 passed\n", b"10 passed\n9 passed\n"]:
            with self.assertRaises(AssertionError):
                module.verify_shared_output(bad)
        original = module.example_expected()
        self.assertTrue(module.strict_equal(module.one_json_line(frame(original)), original))
        for mutation in ("extra", "missing", "changed", "wrong_type"):
            altered = json.loads(json.dumps(original))
            if mutation == "extra":
                altered[0]["extra"] = None
            elif mutation == "missing":
                del altered[0]["output"]
            elif mutation == "changed":
                altered[0]["output"]["bucket"] = "other"
            else:
                altered[0]["ok"] = 1
            self.assertFalse(module.strict_equal(module.one_json_line(frame(altered)), original))
        for malformed in (b'{"ok":true,"\\u006fk":false}\n', b"[NaN]\n", b"[1e999]\n", b"[]\n[]\n", b"[]"):
            with self.assertRaises((ValueError, AssertionError)):
                module.one_json_line(malformed)
        source = (REPO / "src/tests/decision_library_test.py").read_text(encoding="utf-8")
        self.assertNotIn("GOLDEN = PRIVATE", source)
        self.assertEqual(len(module.semantic_cases()), 42)
        self.assertTrue(module.strict_equal(module.example_expected(), independent_example_expected()))
        self.assertEqual(STATE["modeled_completions"], before_count + 1)


def main():
    # Direct CI entry only; no private paths, pins, manifests or root seals.
    def deadline():
        sys.stderr.write("Decision fake-driver controller exceeded10s\n")
        os._exit(124)
    timer = threading.Timer(10, deadline)
    timer.daemon = True; timer.start()
    try:
        suite = unittest.TestSuite(PackagingControls("test_" + name) for name in ORDER)
        result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
        return 0 if result.wasSuccessful() and result.testsRun == 3 else 1
    finally:
        timer.cancel(); timer.join(0.5)


if __name__ == "__main__":
    raise SystemExit(main())
