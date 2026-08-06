from __future__ import annotations

import unittest

from aishike_erp.quality_inventory import (
    QualityInventoryRuleError,
    validate_quality_release,
    validate_stock_movement,
)


class QualityInventoryRulesTest(unittest.TestCase):
    def test_complete_flashed_device_can_pass_quality_gate(self) -> None:
        validate_quality_release(
            lifecycle_state="FLASHED",
            decision="PASS",
            tests_complete=True,
        )

    def test_quality_gate_requires_all_latest_tests_to_pass(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "六项测试"):
            validate_quality_release(
                lifecycle_state="FLASHED",
                decision="PASS",
                tests_complete=False,
            )

    def test_quality_gate_rejects_unsupported_decision(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "不支持"):
            validate_quality_release(
                lifecycle_state="FLASHED",
                decision="SKIP",
                tests_complete=True,
            )

    def test_quality_gate_rejects_non_flashed_device(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "已完成烧录"):
            validate_quality_release(
                lifecycle_state="ASSEMBLED",
                decision="REJECT",
                tests_complete=True,
                failure_reason="外观异常",
            )

    def test_quality_rejection_requires_reason(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "驳回"):
            validate_quality_release(
                lifecycle_state="FLASHED",
                decision="REJECT",
                tests_complete=True,
            )

    def test_finished_goods_receipt_requires_quality_passed_state(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "质量门"):
            validate_stock_movement(
                lifecycle_state="FLASHED",
                movement_type="RECEIVE",
                to_warehouse="成品仓 - ASK",
            )

    def test_finished_goods_receipt_accepts_empty_source_warehouse(self) -> None:
        validate_stock_movement(
            lifecycle_state="QC_PASSED",
            movement_type="RECEIVE",
            to_warehouse="成品仓 - ASK",
        )

    def test_finished_goods_receipt_rejects_existing_warehouse(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "已经在库"):
            validate_stock_movement(
                lifecycle_state="QC_PASSED",
                movement_type="RECEIVE",
                current_warehouse="成品仓 - ASK",
                to_warehouse="成品仓 - ASK",
            )

    def test_stock_movement_requires_target_warehouse(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "目标仓库"):
            validate_stock_movement(
                lifecycle_state="QC_PASSED",
                movement_type="RECEIVE",
            )

    def test_transfer_requires_current_warehouse_as_source(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "当前仓库"):
            validate_stock_movement(
                lifecycle_state="STOCKED",
                movement_type="TRANSFER",
                current_warehouse="成品仓 - ASK",
                from_warehouse="备货仓 - ASK",
                to_warehouse="渠道仓 - ASK",
            )

    def test_transfer_rejects_same_source_and_target(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "不能相同"):
            validate_stock_movement(
                lifecycle_state="STOCKED",
                movement_type="TRANSFER",
                current_warehouse="成品仓 - ASK",
                from_warehouse="成品仓 - ASK",
                to_warehouse="成品仓 - ASK",
            )

    def test_transfer_requires_stocked_device(self) -> None:
        with self.assertRaisesRegex(QualityInventoryRuleError, "在库设备"):
            validate_stock_movement(
                lifecycle_state="QC_PASSED",
                movement_type="TRANSFER",
                current_warehouse="成品仓 - ASK",
                from_warehouse="成品仓 - ASK",
                to_warehouse="渠道仓 - ASK",
            )


if __name__ == "__main__":
    unittest.main()
