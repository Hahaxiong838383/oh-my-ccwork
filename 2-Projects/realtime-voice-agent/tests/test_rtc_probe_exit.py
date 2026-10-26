"""Subprocess contracts for disposable RTC probes, without SDK/provider calls."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


class ProbeExitTests(unittest.TestCase):
    def child(self, body, *, enabled=True, existing=None, prelude=""):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            if existing is not None:
                receipt.write_text(existing)
            env = dict(os.environ, PYTHONPATH=str(SCRIPTS), RECEIPT=str(receipt))
            env.pop("P003_DISPOSABLE_RTC_PROBE", None)
            if enabled:
                env["P003_DISPOSABLE_RTC_PROBE"] = "1"
            code = (
                "import asyncio, atexit, os\nfrom pathlib import Path\n"
                "from rtc_probe_exit import ProbeCompletion, run_disposable_probe\n"
                + prelude + "\nasync def main():\n"
                + textwrap.indent(textwrap.dedent(body), "    ")
                + "\nrun_disposable_probe(main, Path(os.environ['RECEIPT']))\n"
            )
            result = subprocess.run([sys.executable, "-c", code], env=env,
                                    text=True, capture_output=True, timeout=5)
            return result, receipt.read_text() if receipt.exists() else None

    def test_success_flushes_cleanup_evidence_and_avoids_late_native_finalization(self):
        result, receipt = self.child('''
            await asyncio.sleep(0)
            print('cleanup_finished')
            return ProbeCompletion(1, 1, 2, 2, 1, 1)
        ''', prelude="atexit.register(lambda: os._exit(77))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cleanup_finished", result.stdout)
        evidence = json.loads(receipt)
        self.assertTrue(evidence["checks_passed"])
        self.assertEqual(evidence["cleanup"]["streams_closed"], 2)
        self.assertTrue(evidence["python_finalization_bypassed"])

    def test_assertion_failure_is_nonzero_even_with_late_finalization_failure(self):
        result, receipt = self.child("raise AssertionError('private sentinel')",
                                     prelude="atexit.register(lambda: os._exit(77))")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(receipt)["error_type"], "AssertionError")
        self.assertNotIn("private sentinel", receipt)

    def test_incomplete_or_missing_cleanup_cannot_report_success(self):
        for value in ["None", "ProbeCompletion(1, 0, 2, 2, 1, 1)",
                      "ProbeCompletion(1, 1, 2, 1, 1, 1)",
                      "ProbeCompletion(1, 1, 2, 2, 1, 0)",
                      "ProbeCompletion(-1, -1, 0, 0, 1, 1)"]:
            with self.subTest(value=value):
                result, receipt = self.child("return " + value)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(json.loads(receipt)["checks_passed"])

    def test_explicit_probe_scope_is_required_before_main_runs(self):
        result, receipt = self.child("raise AssertionError('main must not run')", enabled=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(receipt)

    def test_existing_receipt_is_not_overwritten_or_reused(self):
        result, receipt = self.child("return ProbeCompletion(1, 1, 0, 0, 1, 1)", existing="prior")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(receipt, "prior")

    def test_system_exit_zero_from_incomplete_main_is_still_failure(self):
        result, receipt = self.child("raise SystemExit(0)")
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(receipt)["checks_passed"])


if __name__ == "__main__":
    unittest.main()
