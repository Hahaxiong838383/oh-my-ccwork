import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from self_monitor import monitor_signature, nonnegative_int, summarize_audits, summarize_omp_update, summarize_tasks, transition_event


class SelfMonitorTest(unittest.TestCase):
    def test_nonnegative_int_is_fail_safe(self):
        self.assertEqual(nonnegative_int("3"), 3)
        self.assertEqual(nonnegative_int(-2), 0)
        self.assertEqual(nonnegative_int("invalid"), 0)

    def test_audit_summary_counts_recent_decisions(self):
        with tempfile.TemporaryDirectory() as directory:
            records = [
                {"createdAt": "2026-08-01T00:00:00Z", "decision": "allowed", "secretExposure": 0},
                {"createdAt": "2026-08-01T01:00:00Z", "decision": "blocked", "secretExposure": 0},
                {"createdAt": "2026-07-20T01:00:00Z", "decision": "allowed", "secretExposure": 0},
            ]
            for index, record in enumerate(records):
                with open(os.path.join(directory, f"{index}.json"), "w", encoding="utf-8") as file:
                    json.dump(record, file)
            summary = summarize_audits(directory, now_epoch=1785556800, window_seconds=86400)
            self.assertEqual(summary["scannedFiles"], 3)
            self.assertEqual(summary["records24h"], 2)
            self.assertEqual(summary["allowed24h"], 1)
            self.assertEqual(summary["blocked24h"], 1)

    def test_stale_task_is_detected(self):
        tasks = [{"id": "one", "status": "running", "updatedAt": "2026-08-01T00:00:00Z"}]
        summary = summarize_tasks(tasks, now_epoch=1785560401, stale_seconds=900)
        self.assertEqual(summary["activeCount"], 1)
        self.assertEqual(summary["staleTaskIds"], ["one"])

    def test_omp_state_requires_fresh_healthy_outcome(self):
        healthy = summarize_omp_update({"outcome": "cooling", "checkedAt": "2026-08-01T00:00:00Z"}, now_epoch=1785558600)
        failed = summarize_omp_update({"outcome": "check_failed", "checkedAt": "2026-08-01T00:00:00Z"}, now_epoch=1785558600)
        self.assertTrue(healthy["ok"])
        self.assertFalse(failed["ok"])

    def test_signature_and_transition_are_deduplicated(self):
        report = {"components": [{"id": "brain", "ok": False}, {"id": "runner", "ok": True}]}
        signature = monitor_signature(report)
        current = {"ok": False, "signature": signature}
        self.assertEqual(transition_event({}, current), "fault")
        self.assertIsNone(transition_event({"ok": False, "signature": signature}, current))
        self.assertEqual(transition_event({"ok": False, "signature": signature}, {"ok": True, "signature": monitor_signature({"components": []})}), "recovery")


if __name__ == "__main__":
    unittest.main()
