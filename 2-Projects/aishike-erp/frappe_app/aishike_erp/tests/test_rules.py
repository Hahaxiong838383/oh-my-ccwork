from __future__ import annotations

import unittest

from aishike_erp.rules import (
    RuleViolation,
    changed_locked_fields,
    validate_device_state_transition,
    validate_sku_status_transition,
)


class RulesTest(unittest.TestCase):
    def test_draft_sku_can_be_approved(self) -> None:
        validate_sku_status_transition("Draft", "Approved")

    def test_approved_sku_cannot_return_to_draft(self) -> None:
        with self.assertRaisesRegex(RuleViolation, "Approved.*Draft"):
            validate_sku_status_transition("Approved", "Draft")

    def test_approved_sku_can_be_disabled(self) -> None:
        validate_sku_status_transition("Approved", "Disabled")

    def test_device_cannot_skip_from_created_to_stocked(self) -> None:
        with self.assertRaisesRegex(RuleViolation, "CREATED.*STOCKED"):
            validate_device_state_transition("CREATED", "STOCKED")

    def test_device_can_follow_normal_production_path(self) -> None:
        path = [
            "CREATED",
            "ASSEMBLED",
            "FLASHED",
            "QC_PASSED",
            "STOCKED",
            "ALLOCATED",
            "SHIPPED",
            "ACTIVATED",
            "RMA_OPEN",
        ]
        validate_device_state_transition(None, path[0])
        for previous, current in zip(path, path[1:]):
            validate_device_state_transition(previous, current)

    def test_locked_field_changes_are_reported(self) -> None:
        changed = changed_locked_fields(
            {"color": "STAR_WHITE", "bom": "BOM-1"},
            {"color": "DEEP_GRAY", "bom": "BOM-1"},
            ("color", "bom"),
        )
        self.assertEqual(["color"], changed)


if __name__ == "__main__":
    unittest.main()
