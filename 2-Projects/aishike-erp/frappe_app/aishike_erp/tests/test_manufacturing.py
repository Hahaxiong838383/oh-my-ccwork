from __future__ import annotations

import unittest

from aishike_erp.manufacturing import (
    ManufacturingRuleError,
    summarize_test_records,
    validate_flash_attempt,
    validate_test_attempt,
)


class ManufacturingRulesTest(unittest.TestCase):
    def test_assembled_device_can_record_successful_flash(self) -> None:
        validate_flash_attempt(
            lifecycle_state="ASSEMBLED",
            result="PASS",
            firmware_version="FW-1.2.0",
            agent_version="AGENT-0.9.0",
        )

    def test_failed_flash_requires_reason(self) -> None:
        with self.assertRaisesRegex(ManufacturingRuleError, "失败原因"):
            validate_flash_attempt(
                lifecycle_state="ASSEMBLED",
                result="FAIL",
                firmware_version="FW-1.2.0",
                agent_version="AGENT-0.9.0",
            )

    def test_unassembled_device_cannot_flash(self) -> None:
        with self.assertRaisesRegex(ManufacturingRuleError, "已完成组装"):
            validate_flash_attempt(
                lifecycle_state="CREATED",
                result="PASS",
                firmware_version="FW-1.2.0",
                agent_version="AGENT-0.9.0",
            )

    def test_tests_require_flashed_state(self) -> None:
        with self.assertRaisesRegex(ManufacturingRuleError, "完成烧录"):
            validate_test_attempt(
                lifecycle_state="ASSEMBLED",
                test_type="OPTICAL",
                result="PASS",
            )

    def test_failed_test_requires_reason(self) -> None:
        with self.assertRaisesRegex(ManufacturingRuleError, "失败原因"):
            validate_test_attempt(
                lifecycle_state="FLASHED",
                test_type="AI",
                result="FAIL",
            )

    def test_unknown_test_type_is_rejected(self) -> None:
        with self.assertRaisesRegex(ManufacturingRuleError, "不支持的测试类型"):
            validate_test_attempt(
                lifecycle_state="FLASHED",
                test_type="NETWORK",
                result="PASS",
            )

    def test_summary_uses_latest_attempt_and_preserves_counts(self) -> None:
        summary = summarize_test_records(
            [
                {"test_type": "OPTICAL", "result": "FAIL"},
                {"test_type": "OPTICAL", "result": "PASS"},
                {"test_type": "SENSOR", "result": "FAIL"},
                {"test_type": "FUNCTION", "result": "PASS"},
            ]
        )
        self.assertEqual(2, summary["passed"])
        self.assertEqual(1, summary["failed"])
        self.assertEqual(3, summary["pending"])
        self.assertEqual(2, summary["attempts"]["OPTICAL"])
        self.assertEqual("PASS", summary["latest"]["OPTICAL"]["result"])
        self.assertFalse(summary["complete"])

    def test_summary_is_complete_only_when_all_six_latest_results_pass(self) -> None:
        summary = summarize_test_records(
            [
                {"test_type": "OPTICAL", "result": "PASS"},
                {"test_type": "SENSOR", "result": "PASS"},
                {"test_type": "FUNCTION", "result": "PASS"},
                {"test_type": "AI", "result": "PASS"},
                {"test_type": "AGING", "result": "PASS"},
                {"test_type": "OQC", "result": "PASS"},
            ]
        )
        self.assertEqual(6, summary["passed"])
        self.assertTrue(summary["complete"])


if __name__ == "__main__":
    unittest.main()
